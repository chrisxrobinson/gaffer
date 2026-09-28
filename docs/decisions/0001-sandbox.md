# ADR 0001 — Sandbox: separate no-network container reached through a small exec service

**Status:** Accepted · **Date:** 2026-09-27

## Context
Gaffer's model writes and runs Python analysis. Code written by an LLM has to be treated as untrusted, particularly since some of its inputs are scraped text such as FPL `news` strings. Anthropic's managed-agents design keeps credentials out of the environment where generated code runs: the "brain" (harness) and the "hands" (sandbox) are separated, and the sandbox is created on demand through `provision()` ([research 02](../research/02-harness-patterns.md), [research 06](../research/06-deployment.md)). Pi itself has no sandbox. Its security page says it runs with the permissions of the user who started it ([research 01 §6](../research/01-pi-internals.md)). Pi's built-in tools accept a replaceable `operations` backend, and Spike S1 proved that `bash` can be re-registered to run in another container ([spikes/s1-extension-hooks](../../spikes/s1-extension-hooks/README.md), check 5).

## Options considered
1. **Run the whole Pi process in one container** (Pi's "plain Docker" recipe). The simplest option, but the LLM key sits inside the same boundary that runs generated code. Rejected: this is exactly the setup the managed-agents post describes as the prompt-injection hole.
2. **Pi on the host plus Gondolin micro-VM tools.** The VM inherits the host environment, so provider keys can leak into it (Pi's containerization doc says so). It also needs QEMU and has no AWS mapping. Rejected.
3. **Separate sandbox container reached with `docker exec`.** This is what S1 used. It works, but the harness would need the Docker socket, which gives root on the host. Local proof only.
4. **Separate sandbox container running a small HTTP exec service (`sandboxd`) on an internal-only network.** The harness overrides `bash`, `read`, `write` and `edit` to call it. **Chosen.**
5. **Hosted sandboxes (E2B, Modal, AgentCore Code Interpreter).** These are good fallbacks for multi-user cold-start problems, but they add a vendor and a key for the MVP. Deferred.

## Decision
- **Image:** `gaffer-sandbox` on `python:3.14-slim` (open-fpl-solver requires Python ≥3.14, see research 04 §5), with these pinned packages: `numpy`, `pandas`, `highspy` (HiGHS MILP), `open-fpl-solver` (Apache-2.0, pinned commit), `pydantic`, and **`gaffer_lib`**, our tested library ([ADR 0003](0003-analytics-split.md)), installed into site-packages. No PuLP or CBC: HiGHS is faster and pip-installable, and Pyodide ships `highspy` if we ever need a WASM fallback. `scipy` is included for the team-strength fit.
- **Process:** `sandboxd` is about 100 lines of standard-library Python. It offers `POST /exec {command, cwd, timeout_s}` and streams stdout/stderr back, plus `GET/PUT /files` for `read`/`write`/`edit`. It runs commands under a **fixed minimal environment** (`PATH`, `HOME=/work`, `PYTHONDONTWRITEBYTECODE=1`), never the harness's. It is justified as the only way to reach the sandbox without the Docker socket, and it maps directly to a Fargate task.
- **Hardening:** read-only root filesystem; writable `/work` tmpfs (256 MB); `/data` mounted **read-only** with the FPL snapshots and historical seasons; `--cap-drop ALL`; `no-new-privileges`; default seccomp profile; non-root UID; `--pids-limit 128`; 2 GB memory; 2 vCPU; 120 s timeout per command; `runsc` (gVisor) runtime when the host is Linux.
- **Network:** **none outbound.** The sandbox only joins a Compose network with `internal: true` that it shares with the harness. Every data fetch goes through the harness's `fpl_snapshot` tool ([ADR 0002](0002-data-access.md)). That makes runs reproducible, because the analysis only sees snapshots, and removes the exfiltration path.
- **Lifetime:** one sandbox per Pi session, provisioned lazily on the first tool call that needs it. It is discarded when the session ends or after 15 minutes idle. `/work` is ephemeral, and anything worth keeping goes into the session log.

## Consequences
- The model can't `pip install` or `curl` anything. Missing libraries mean a new image, which is deliberate.
- Skills files live in the harness, but `read` is routed to the sandbox. The `read` override must serve paths under the Gaffer package's `skills/` directory locally (a read-only allowlist); every other path goes to the sandbox.
- On AWS the sandbox must be **its own Fargate task**, not a sidecar, because containers in one task share network and storage ([research 06 §3](../research/06-deployment.md)). Fargate already runs each task in its own VM, and gVisor isn't needed or available there.
- The local Compose version needs no Docker socket, so the harness container is also unprivileged.
