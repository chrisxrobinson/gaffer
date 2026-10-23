# Gaffer — Roadmap

**Date:** 2026-09-27, updated 2026-10-18 (Phase 1.1 added; Phases 2 and 3 revised) 2026-10-23 (Phase 1.1 deployed) and 2026-10-23 again (Phase 2 re-planned on a small host; AWS moved to Phase 3). Each phase lists its scope and **exit criteria**. Exit criteria refer to [REQUIREMENTS](REQUIREMENTS.md) IDs and must all pass before the next phase starts. Timing follows the FPL calendar, checked live on 2026-10-17: GW8's deadline is 2026-10-23 17:30Z, GW9's 2026-10-31 11:00Z, GW10's 2026-11-06 18:30Z, then an international break to GW11 (2026-11-21 11:00Z), GW12 2026-11-27, GW13 2026-12-01 18:30Z (FPL's live value, checked 2026-10-23; earlier drafts said 12-02); first-half chips expire at the GW19 deadline (2027-01-01 18:30Z); blanks and doubles historically fall in GW29–37.

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
  - `gaffer-recommend`: `submit_recommendation` with recompute and retries, `set_preferences`, renderer, `/export-rec`, `/prefs`
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

**Status on 2026-10-17:** M1–M5 are built and merged. The Phase 1 exit is **not yet met**: the ledger holds five real GW7 recommendations and no scored outcome. GW7 is scored once FPL checks it (about 2026-10-21); recommendations are still needed for GW8 and GW9, so the earliest close is GW9's data check, about 2026-11-04. Phase 1.1 runs alongside and must not interrupt it.

**Decision, 2026-10-23:** Phase 2 starts before the Phase 1 exit is met (your call). Phase 1's live use continues on the Mac until the M2-1 cutover, and Phase 2 must not interrupt it; ADR 0019's scheduler takes over scoring once the host is live.

**Status on 2026-10-23:** the Phase 1 exit is still **not met**. **GW7 is scored**: `gaffer-eval` wrote its five real recommendations to `outcomes.jsonl`. **GW8** has one real recommendation, made before the deadline, and is scored once FPL checks GW8 (about 2026-10-28). **GW9** still needs a recommendation before 2026-10-31 11:00Z. The earliest close is GW9's data check, about 2026-11-04, if `gaffer-eval` is run after each check ([BUILD.md](../BUILD.md#phase-1-exit-three-consecutive-live-gws-scored)).

## Phase 1.1 — Pi 1.x and Gaffer's own UIs (single user, local)
A short phase between the local MVP and the cloud. It brings Gaffer onto Pi 1.3.0 with every new built-in locked off, makes the browser terminal Gaffer's own, and adds the Gaffer App, a structured web app over the same agent and session store. Design: [ADRs 0009–0014](decisions/README.md), [docs/ui](ui/README.md), [MIGRATION-PI-1X](MIGRATION-PI-1X.md), research 07–12.

**Rules for every milestone** (ADR 0009):
- Each milestone leaves a working Gaffer and lands in the 48 hours after a GW deadline, never in the 48 hours before one. The previous harness image stays tagged for rollback until the next milestone lands.
  - **Waived on 2026-10-23, for one deploy:** M1.1-1 to M1.1-4 went live together at 15:40Z, 1 h 49 min before the GW8 deadline, with the M1.1-0 images tagged `:pre-phase-1.1` for rollback ([BUILD.md](../BUILD.md#gaffer--phase-11-close-and-deploy)).
- Security can only stay the same or get stronger: no user shell; the sandbox has no network and no secrets; the LLM key stays in the harness; team IDs are hashed at rest; every new built-in is off unless an ADR turns it on.
- Each milestone's exit includes the regression set: `pnpm test` (with the S1 checks), the sandboxd and `gaffer_lib` suites, `verify.sh`, `pnpm eval --model faux` (30/30 valid, points equal to G0).

### M1.1-0 — Config fixes on Pi 0.87.1 (land by 2026-10-21, before the GW8 deadline)
Ships what doesn't need the upgrade and pays off immediately in live use.
- **Scope:**
  - `harness/models.json`: `supportsMidConvoSystemMessages: true` and `cacheRead: 0.1` for Sonnet 5.5 (ADR 0010)
  - count Pi's `usage` entries in `src/budget.ts` and `src/usage.ts` (NFR-COST-05)
  - a follow-up-prompt eval case (NFR-COST-04)
  - ttyd `--check-origin` (ADR 0005 said so; the entrypoint omits it)
- **Exit:** NFR-COST-04, NFR-COST-05; three real-model cases including one follow-up (the follow-up's cache-read share ≥ 80%); the regression set.

### M1.1-1 — Pi 1.3.0, locked down (deploy 2026-10-23 17:30Z – 10-25 17:30Z, between the GW8 and GW9 deadlines)
- **Deployed 2026-10-23** with M1.1-1 to M1.1-4 together; the dated window was waived ([BUILD.md](../BUILD.md#gaffer--phase-11-close-and-deploy)).
- **Scope:**
  - MIGRATION-PI-1X steps 1–5: versions, `test/recommend.test.ts`, the harness image's Pi install from a committed lockfile (`npm ci`), drop the `models.json` override for Sonnet 5.5, docs and keys (`Ctrl+Home`/`Ctrl+End`)
  - ADR 0012's lock in the same change: `--no-mcp` on every CLI launch, `-builtin:` entries for MCP, codemode, tool search and llama.cpp in `settings.json`, the `--tools` allowlist kept
  - the security-relevant settings from ADR 0013: `sessionShareDestination: "gist"`, `externalEditor: "/bin/false"`, `enableSkillCommands: false`, `doubleEscapeAction: "none"`, and the keybindings that reach model, thinking, editor, suspend, tree, fork and session delete unbound
  - the upgrade gate as CI tests: S3's lock checks (NFR-SEC-08), the default model's price and compat check (NFR-MNT-05)
  - *(done in planning, spike S10: Claude Haiku 5.5 qualified against the full suite and not adopted, ADR 0008; the catalogue entry pre-checked on six Sonnet 5.5 cases)*
- **Exit:** NFR-MNT-01 (whole Pi tree pinned), NFR-MNT-04, NFR-MNT-05, NFR-SEC-08; the regression set on 1.3.0; ≥ 5 real-model Sonnet 5.5 cases including a follow-up, with cost per recommendation within NFR-COST-01 and no rise against M1.1-0; a TUI check in the browser (reasoning shown, recommendation at 100 columns, FR-OUT-02).

### M1.1-2 — Gaffer Terminal (deploy after the GW9 deadline, 2026-10-31 11:00Z – 11-02, before GW10)
- **Deployed 2026-10-23** with M1.1-1 to M1.1-4 together; the dated window was waived ([BUILD.md](../BUILD.md#gaffer--phase-11-close-and-deploy)).
- **Scope** (ADR 0013, docs/ui §3):
  - header with the mark and ASCII wordmark; two-line footer (status strip with live countdown; spend and model); title
  - `gaffer-dark` and `gaffer-light` themes and the matching ttyd palette
  - the command allowlist: autocomplete provider plus the editor submit wrapper, a Gaffer `/help`, and S5's script as a regression test
  - web terminal: OSC 52 copy handler, viewport tag, tmux `set-clipboard on`
- **Exit:** FR-UI-05, FR-UI-06, FR-UI-07, NFR-SEC-09; FR-UI-01…03 and FR-OUT-02 unchanged (browser screenshots at 100 columns).

### M1.1-3 — Gaffer App: recommend (international break, 2026-11-07 – 11-19; GW11 deadline 2026-11-21)
The break is the longest gap between deadlines this autumn, so the largest change lands here.
- **Deployed 2026-10-23** with M1.1-1 to M1.1-4 together; the dated window was waived ([BUILD.md](../BUILD.md#gaffer--phase-11-close-and-deploy)).
- **Scope** (ADR 0014, docs/ui §4–8):
  - `gaffer-web` in the harness container: RPC process per open session, the command allowlist, SSE with replay, the Origin check, `--replay` dev mode
  - in Gaffer's package: the session lock and the run lock; `/run {json}` and `gaffer.run`; the plan-step tag; golden-path progress lines
  - the App: rail (sessions by team and GW, new, resume), Start with the *Recommend* action and its options, the Run view, the Result view from JSON, JSON and CSV export, shared sessions with the terminal
  - Preact and htm vendored; fonts self-hosted
- **Exit:** FR-UI-08 (*Recommend*), FR-UI-09, FR-UI-10, FR-UI-11, FR-UI-12; NFR-SEC-05, NFR-SEC-07, NFR-REL-03, NFR-LAT-04; NFR-PRIV-02 re-run with the App open (no third-party request).

### M1.1-4 — Gaffer App: complete (by the GW13 deadline, 2026-12-02)
- **Deployed 2026-10-23** with M1.1-1 to M1.1-4 together; the dated window was waived ([BUILD.md](../BUILD.md#gaffer--phase-11-close-and-deploy)).
- **Scope:** the *What-if*, *Explain a pick*, *Chip planner* (with a new template), *Scorecard* and *Preferences* actions; the follow-up box; every state in docs/ui §6; rename; the phone layout; accessibility.
- **Exit:** FR-UI-08 (all actions), FR-UI-13, NFR-A11Y-01, NFR-COST-04 measured through the App.

### Phase 1.1 exit
- All milestone exits above.
  - **Status 2026-10-23: met on the live stack.** The regression set passed after the deploy (`verify.sh` run 2 exit 0; faux eval 31/31, points equal to G0, p50 52.9 s, p95 59.6 s), and so did NFR-PRIV-02 with the App open. The two real-model runs M1.1-4 left (the *Chip planner* in the App, `/chips` in the terminal) are done. Six requirement and ADR wording decisions are still open with you (NFR-LAT-04, FR-UI-10, FR-UI-08, FR-UI-13, ADR 0014 item 4, NFR-MNT-04), as is NFR-COST-03's Console check.
- Live use was never interrupted: a working Gaffer was available before every deadline from GW8 to GW13, and every milestone landed in its window.
  - **Status 2026-10-23:** GW8 was covered. M1.1-0 ran until 15:40Z, Phase 1.1 from then on, and your GW8 recommendation was made at 15:44Z. GW9 to GW13 are still ahead. The window part is **not met, by your decision**: the windows were waived and the four milestones landed together, before a deadline.
- The *Chip planner* is available before the GW16 deadline (2026-12-19), so first-half chips can be planned before they expire at GW19.
  - **Status 2026-10-23: met.** It has been live since 2026-10-23, in the App and as `/chips`, and was run with the real model in both.
- The Phase 1 exit (three consecutive live GWs scored) is met, whichever finishes first.
  - **Status 2026-10-23: not met.** GW7 is scored, GW8 is waiting for FPL's check and GW9 needs a recommendation (see Phase 1 above).

## Phase 2 — Hosted single user (one small host, behind sign-in)
**Re-planned 2026-10-23** ([ADR 0015](decisions/0015-host.md)–[0020](decisions/0020-build-deploy-observe.md), research [13](research/13-hosting.md)–[16](research/16-operations.md), spikes S11–S14). AWS was dropped for cost (about $140 a month before an egress firewall) and moved to Phase 3 as a documented mapping. Gaffer runs the **same Compose file** on one Hetzner Cloud server (CAX21 if Hetzner can supply it, CPX22 otherwise; €14–23 a month with offsite backups), reached only through **Tailscale Serve** (no domain, nothing open to the internet), with the harness's egress allowlisted and its identity checked again inside the harness. Prices and stock are in research 13: on 2026-10-23 every Cost-Optimized (CX/CAX) plan showed "not available".

The rules for every Phase 1.1 milestone carry over (ADR 0009 windows, security only stays the same or gets stronger, the regression set), plus: nothing reachable from the internet except through the front door; SSH on the tailnet only; the harness's egress allowlisted; backups encrypted before they leave the host. Accounts, payments and the server's order are yours.

### M2-0 — The production setup, built and tested locally (any time; no live impact)
- **Scope:** the `door` service and the identity checks in `gaffer-web` (`GAFFER_PUBLIC_ORIGIN`, `GAFFER_ALLOWED_LOGIN`, `/admin`) and `gaffer-pi` (`TTYD_USER`) (ADR 0016); the `egress` service, internal-only networks and Node ≥ 24.22 (ADR 0017); `tools/gaffer-snapshot`, the job scripts and systemd units (ADR 0019); the restic backup and restore scripts (ADR 0018); `deploy/server/setup.sh`, `deploy.sh`, `rollback.sh` and `verify-prod.sh` (ADR 0020); all proven on a separate local Compose project.
- **Exit:** NFR-SEC-10, NFR-SEC-11, FR-ADM-02, NFR-REL-04 (local restore), FR-DAT-10's trigger and FR-EVL-03's job (on a scratch data directory), NFR-SEC-01/02/07/08 unchanged; the regression set (`verify.sh`, faux eval 31/31 with points equal to G0, latency no worse than the Phase 1.1 close). If you have created the free tailnet by then: Serve's Host/Origin behaviour, two HTTPS ports, and a whole run's WebSocket and SSE checked through it.

### M2-1 — The host and the cutover (cutover inside a window: after the GW10 deadline, 2026-11-06 18:30Z, through the international break, never after 2026-11-19 11:00Z)
- **Scope:** you order the server and create the tailnet, Storage Box and healthchecks.io accounts; the server is set up and hardened; the stack is deployed with a throwaway salt and gated; then the live data moves from the Mac with its salt unchanged and checked (ADR 0018), and the host becomes the live Gaffer; the Mac's stack is kept, stopped, as the rollback.
- **Exit:** NFR-SEC-04 (Phase 2 criterion), NFR-SEC-10 with real sign-ins from your laptop and phone, NFR-SEC-11 and NFR-PRIV-02 on the host, NFR-LAT-05, NFR-REL-04 (a real offsite backup and a restore on the host), the data move's checks, one real Recommend and follow-up through the hosted App, and the regression set on the host.

### M2-2 — Operating it, and the Phase 2 exit (after at least four GWs live on the host)
- **Scope:** the record of every GW since the cutover (recommendations, automatic scoring, cost and latency, restarts); recovery drills (restore into a fresh project, rollback, patch and reboot) inside windows; the real monthly cost against ADR 0015's; ADR 0006's AWS mapping brought up to date (NFR-PORT-02); ADR 0011's T3 measured.
- **Exit:** NFR-PORT-02, NFR-REL-04 (drill), FR-EVL-03 met by the scheduler for every GW since the cutover, and the Phase 2 exit below.

### Phase 2 exit
- All milestone exits above.
- At least four consecutive live GWs recommended from the host and **scored automatically** (FR-EVL-03 by ADR 0019's timer), with cost per recommendation within NFR-COST-01.
- Hosting cost within ADR 0015's estimate plus 20%.
- A restore from the offsite backup into a fresh stack, with sessions and ledgers identical.
- Both UIs reachable only through the tailnet with your identity; nothing on the host open to the internet.
- ADR 0011's T3 measured: the share of runs interrupted by restarts.
- The Phase 1 exit closed, if the ledger shows it (it should, once the scheduler scores GW8 onwards).

## Phase 3 — Multi-user (and, if needed, a big cloud)
- **Scope** (the seams from ARCHITECTURE §8):
  - **moved here from Phase 2 (2026-10-23):** the AWS deployment of ADR 0006 and research 06 — ECS Fargate (harness service, a sandbox task per session with no egress and no IAM role, warm pool), an ALB with OIDC (Cognito) and an idle timeout of 3600 s in front of both UIs, EFS with S3 copies, Secrets Manager, `gaffer-eval` as a scheduled task, the `SandboxProvider=ecs` implementation (which retires Phase 1.1's run lock), FR-ADM-02 behind the ALB, NFR-LAT-02's Fargate cold start; images built in CI and pulled by digest from a registry (ADR 0020 option 2). Only if multi-user or scale needs it: the single host may be enough
  - **changed by Phase 1.1:** the `gaffer-web` bridge and the Gaffer App already exist (single-user, ADR 0014). Phase 3 adds OIDC → tenant mapping, per-tenant session and data paths, and sticky routing of each session's Pi process across N harness tasks; the browser terminal stays operator-only, and other users get the App
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
| Pi API churn (Pi minors break things; eleven releases from 0.87.1 to 1.3.0 in 24 days) | ADR 0009: exact pins incl. the transitive tree, gated upgrades landed after a deadline, rollback image | Every Pi minor |
| New Pi built-ins load by default (MCP, codemode, tool search, llama.cpp in 0.99.0) | ADR 0012's lock and NFR-SEC-08 tests; the changelog review lists built-ins first | Every Pi release |
| The command-refusal seam is undocumented (`CustomEditor.onSubmit`) | S5's script as a regression test; the security controls don't depend on it (ADR 0013) | Every Pi release |
| Pi Durable becomes the better base | ADR 0011's triggers T1–T3 | Every Pi release; Phase 3 planning |
| Model prices change under a fixed catalogue (Sonnet 5.5 cache reads halved on 2026-10-07) | NFR-MNT-05 check; prices from the provider's list and release notes (ADR 0010) | Each upgrade; monthly |
| FPL API change or blocking | Schema validation fails loudly; fallback to stale snapshot | Continuous |
| GW19 chip-expiry conflict (API vs PL article) | Re-verify on the FPL site | Early December 2026 |
| FT derivation wrong for edge cases | Reference accounts re-checked | After each WC/FH use in a reference account |
| Terms of use (PL / football-data) | Legal review | Before phase 3 |
| Hetzner can't supply the planned server (every CX/CAX plan "not available" on 2026-10-23) | ADR 0015's order of preference (CAX21, then CPX22, then CAX11); images built on the host for its arch | At order time (M2-1) |
| One host is a single point of failure | Encrypted offsite backups and a drilled restore onto any Docker host, the Mac included (ADR 0018) | Nightly; drilled in M2-0, M2-1, M2-2 |
| The front door depends on Tailscale's coordination service | Losing it loses remote access only; the stack and the scheduler keep running; a console login on the server is the way in | If Tailscale's terms or free plan change |
| The egress allowlist drifts from the hosts Gaffer calls | A test compares them (ADR 0017); a missing host fails loudly, never leaks | Every change to a data source or provider |
