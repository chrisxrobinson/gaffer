# ADR 0006 — Deployment topology: Compose, mapped 1:1 to ECS Fargate

**Status:** Accepted · **Date:** 2026-09-27

## Context
Three requirements drive this. It has to be cloud-agnostic and Docker-first. It has to follow the managed-agents separation of brain, hands and session. And it has to go from single user to multi-user without a rewrite ([research 06](../research/06-deployment.md)). The verified AWS facts that matter:
- Fargate runs each task in its own isolated VM.
- Only `CAP_SYS_PTRACE` can be added, so gVisor can't run there, and it isn't needed.
- Containers within one task share network and storage.
- The ALB idle timeout defaults to 60 s and can be set up to 4000 s.
- Fargate x86 costs $0.000011244 per vCPU-second, with a 1-minute minimum.

## Options considered
1. **One container for everything** (Pi's plain-Docker recipe). Rejected because of the credentials-with-code problem ([ADR 0001](0001-sandbox.md)).
2. **Kubernetes from day one.** Overkill for one user, and it adds a control plane to run.
3. **Compose with two services and two networks, mapped to ECS Fargate services and tasks.** **Chosen.**
4. **Serverless** (Lambda sandbox). The 15-minute cap and cold starts are acceptable, but it has no PTY for the web TUI and doesn't match the Compose shape. Kept as a sandbox fallback only.

## Decision
**Services** (each justified in one line):

| Service | Why it must exist | Local (Compose) | AWS | Generic host |
|---|---|---|---|---|
| `gaffer` (harness + ttyd) | Runs the Pi loop, holds the LLM key, owns data fetching and the session log | 1 container, networks `egress` + `sandbox_net`, volumes `sessions`, `data` | ECS Fargate service (0.5 vCPU / 1 GB) behind an ALB with OIDC, EFS for `/sessions` and `/data`, key from Secrets Manager | Same container on Hetzner/Fly with Caddy + oauth2-proxy in front |
| `sandbox` (`sandboxd`) | Runs generated code away from credentials and with no network | 1 container, network `sandbox_net` (`internal: true`), `/data` read-only, tmpfs `/work` | **Separate** Fargate task per session (2 vCPU / 4 GB), no public IP, security group allowing ingress from the harness only and no egress, no task IAM role; warm pool of 1 | Same container; runtime `runsc` on Linux |

No other services in the MVP:
- no Redis, since caching is files on `/data`
- no database, per [ADR 0004](0004-session-storage.md)
- no OTel collector, since admin reads JSONL ([ARCHITECTURE §9](../ARCHITECTURE.md))
- no separate fetcher, since the harness already has egress

**Config and secrets:**
- Everything is configured through environment variables: `GAFFER_MODEL`, `GAFFER_BUDGET_*`, `GAFFER_ID_SALT`, `SANDBOX_URL`.
- Secrets (`ANTHROPIC_API_KEY` or another provider key, and `GAFFER_ID_SALT`) come from a Compose `secrets:` file locally and from Secrets Manager on ECS. They are injected **only** into `gaffer`.
- `sandboxd` builds its own minimal environment for every command, so a misconfiguration can't pass the key through.
- `PI_TELEMETRY=0` is set on the harness.

**Scaling path:**
- Phase 1 (local): the MVP as above.
- Phase 2 (cloud, single user): Fargate plus ALB/OIDC, with the harness at 1 task.
- Phase 3 (multi-user):
  - the `gaffer-web` RPC bridge ([ADR 0005](0005-web-tui.md))
  - harness tasks scaled horizontally, with sessions pinned to a task by sticky routing (or the bridge spawning Pi per session)
  - sandbox tasks per session from a warm pool, or E2B/AgentCore if Fargate `RunTask` cold start (10–60 s, unmeasured) is too slow
  - Postgres (RDS) as a *query index* over the JSONL, plus per-tenant budgets

## Consequences
- The local MVP needs no Docker socket and no privileged containers.
- On AWS the harness launches sandbox tasks through `ecs:RunTask`. That role belongs to the harness only, scoped to one task definition. An abstract `SandboxProvider` interface (`provision`, `exec`, `release`) sits in the `gaffer-sandbox` extension, with `compose` and `ecs` implementations.
- **Open measurement:** Fargate cold start for the sandbox task (ROADMAP phase 2 exit criterion).
