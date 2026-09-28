# Gaffer — Roadmap

**Date:** 2026-09-27. Each phase lists its scope and **exit criteria**. Exit criteria refer to [REQUIREMENTS](REQUIREMENTS.md) IDs and must all pass before the next phase starts. Timing follows the FPL calendar: the GW6 deadline is 2026-10-10, first-half chips expire at the GW19 deadline (around 2027-01-01), and blanks and doubles historically fall in GW29–37.

## Phase 0 — Research & architecture ✅ (this run)
- **Scope:** research notes 01–06, spike S1, ADRs 0001–0008, ARCHITECTURE, REQUIREMENTS, ROADMAP, REPO_LAYOUT.
- **Exit:** the documents are consistent, and no core assumption has been falsified (S1 passed 8 of 8).

## Phase 1 — Local MVP (single user, Docker Compose)
Runs on one machine with `docker compose up`, then `http://127.0.0.1:7681`. It has five milestones, each of which ships something usable.

### M1 — Skeleton: Pi → Gaffer, sandbox, data (target: before GW7 deadline)
- **Scope:**
  - repo scaffold ([REPO_LAYOUT](REPO_LAYOUT.md))
  - `pi-gaffer` package with `gaffer-core` (prompt sections, allowlist, `user_bash` block, `/team`), `gaffer-sandbox` (tool overrides → `sandboxd`, compose provider) and `gaffer-budget`
  - `sandboxd` and the hardened sandbox image
  - `gaffer-data` with `fpl_snapshot`: fetch, cache-bust, TTL, retry, validation and snapshot writing
  - ttyd + tmux in the harness image
  - S1 checks turned into automated tests
- **Exit:**
  - FR-INP-01, FR-DAT-01…07, FR-UI-01…03, FR-ACC-01, FR-BUD-01
  - NFR-SEC-01, NFR-SEC-02, NFR-SEC-04, NFR-PRIV-02, NFR-MNT-01
  - **NFR-COST-03** (real-provider cost accuracy, which S1 couldn't check with the faux provider)
  - The model can answer "what's my squad and bank?" correctly.

### M2 — Rules engine and derivation (target: before GW8)
- **Scope:**
  - `gaffer_lib.rules` and `derive`
  - golden-file tests from `event/{gw}/live` `explain[]`
  - the FT and selling-price derivation, validated against ≥3 real accounts
  - `gaffer_lib validate`
- **Exit:** FR-RUL-01…07, FR-DAT-08, FR-INP-04.

### M3 — Baseline model and optimiser (target: before GW10)
- **Scope:**
  - `strength` (odds de-vig + Dixon-Coles), `minutes`, `xp`
  - `plan` wrapping open-fpl-solver (horizon 6, 4 shown), plus chip scenarios
  - `gaffer_lib run` golden path
  - `backtest` with B0, B1, B2 and G0 over 2023/24–2025/26
- **Exit:** FR-DAT-09, FR-DAT-10, FR-EVL-01 (G0 beats all baselines), NFR-LAT-03, NFR-REL-02.

### M4 — Recommendation end-to-end (target: before GW11)
- **Scope:**
  - `gaffer-recommend`: `submit_recommendation` with recompute and retries, `set_preferences`, renderer, `/export`, `/prefs`
  - the six skills
  - prompt templates
  - the schema and its JSON Schema export
- **Exit:**
  - FR-INP-02, FR-INP-03, FR-REC-01…10, FR-OUT-01…03
  - NFR-SEC-03 (injection eval case)
  - NFR-OBS-01, NFR-OBS-02

### M5 — Evaluation and admin (target: before GW13, well ahead of GW19 chip expiry)
- **Scope:**
  - the 30-case LLM eval suite
  - `gaffer-eval` live tracking after `data_checked`
  - `/scorecard`, `gaffer admin` static report, `/usage`
  - soft-cap steering
- **Exit:**
  - FR-EVL-02…04, FR-ADM-01, FR-BUD-02
  - NFR-COST-01, NFR-COST-02, NFR-LAT-01, NFR-PORT-01 (the suite passes on a second provider), NFR-REL-01, NFR-MNT-02
- **Phase 1 exit:**
  - All of the above.
  - Gaffer has produced recommendations for at least 3 consecutive live GWs, with outcomes logged. This is the first real test of the theory.

## Phase 2 — Cloud deployment (single user, AWS; also documented for a generic host)
- **Scope:**
  - Terraform/CDK for: an ECS Fargate service (harness), a separate Fargate sandbox task definition with no egress and no IAM role, an ALB with OIDC (Cognito) and an idle timeout of 3600 s, EFS for `/sessions` and `/data` with nightly S3 copies, and Secrets Manager
  - the `SandboxProvider=ecs` implementation with a warm pool of 1
  - the admin page served behind the ALB
  - `gaffer-eval` as a scheduled task
  - the same Compose file documented for Hetzner with Caddy and oauth2-proxy
  - the offline autoresearch loop (ARCHITECTURE §6.5) against a frozen scorer, as an optional track
- **Exit:**
  - NFR-LAT-02 (Fargate cold start measured; a warm pool if it's over 15 s)
  - FR-ADM-02
  - NFR-SEC-04 (OIDC required)
  - NFR-PORT-02
  - Restore test: sessions and ledgers recovered from S3 into a fresh stack.
  - A month of GW recommendations running from the cloud, with cost per recommendation still within NFR-COST-01.

## Phase 3 — Multi-user
- **Scope** (the seams from ARCHITECTURE §8):
  - the `gaffer-web` RPC bridge: OIDC, tenant mapping, one `pi --mode rpc` per session, a command allowlist
  - a terminal-styled HTML frontend with tables and CSV/JSON export
  - per-tenant paths
  - per-user sandboxes from a pool (or E2B/AgentCore if cold starts demand it)
  - per-tenant budgets and rate limits
  - a Postgres query index tailing the JSONL
  - optional OTel export
  - a legal and terms review before inviting anyone outside personal use (NFR-SEC-06)
- **Exit:**
  - FR-UI-04, NFR-SEC-05
  - A load test: 20 concurrent users, each running one recommendation, with p95 ≤ 180 s and no cross-tenant access (pen-test checklist).
  - Per-user cost reporting that matches provider billing to within 2%.

## Standing risks and checkpoints
| Risk | Check | When |
|---|---|---|
| Pi API churn (0.x versions) | Pin the version; S1 tests gate upgrades | Every Pi release |
| FPL API change or blocking | Schema validation fails loudly; fallback to stale snapshot | Continuous |
| GW19 chip-expiry conflict (API vs PL article) | Re-verify on the FPL site | Early December 2026 |
| FT derivation wrong for edge cases | Reference accounts re-checked | After each WC/FH use in a reference account |
| Terms of use (PL / football-data) | Legal review | Before phase 3 |
