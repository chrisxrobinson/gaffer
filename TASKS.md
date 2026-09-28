# Gaffer — Research & Architecture Checklist

## Research (one subagent per area → docs/research/)
- [x] R1 Pi internals & philosophy → docs/research/01-pi-internals.md
- [x] R2 Agent harness patterns → docs/research/02-harness-patterns.md
- [x] R3 FPL data sources → docs/research/03-fpl-data-sources.md
- [x] R4 FPL analytics → docs/research/04-fpl-analytics.md
- [x] R5 Web-based TUI → docs/research/05-web-tui.md
- [x] R6 Deployment → docs/research/06-deployment.md
- [x] Verify subagent evidence (spot-check key claims against live sources)

## Spikes (spikes/, noted in decision log)
- [x] S1 Pi extension hooks — PASS (spikes/s1-extension-hooks/README.md)

## Design deliverables
- [x] docs/ARCHITECTURE.md (component + sequence Mermaid diagrams, design areas 1–10)
- [x] docs/REQUIREMENTS.md (FR/NFR IDs + acceptance criteria)
- [x] docs/decisions/ ADRs 0001–0008
- [x] docs/ROADMAP.md (MVP local Docker → cloud → multi-user; exit criteria)
- [x] docs/REPO_LAYOUT.md (tree + extensions/packages/skills list)
- [x] Consistency pass across all docs (links, versions, budgets, horizon; 3 Mermaid diagrams render via mermaid-cli)

## Discovered
- [x] R2 evidence spot-checked: arXiv 2607.18064 (autoresearch metric gaming), Cognition quote, managed-agents session/credential/provision passages — all confirmed live
- [x] Gotcha from S1: SDK hosts must call session.bindExtensions() or session_start never fires → document in ARCHITECTURE + pass explicit tool allowlist
- [→ Open] Unverified: does Pi pass a tool's `strict` JSON-schema flag to providers? (R2) — design must not depend on it; validate in tool execute()
- [→ Open] Unverified: cost calculation with real provider (faux reports 0)
- [x] R3 evidence verified live 2026-09-27: chips (2×4, split GW19/20), GW5 current/finished, GW6 deadline 2026-10-10T10:00Z, my-team 403, team/set-piece-notes 200, max_extra_free_transfers=4, price_change_* fields (+ price_change_hourly_rate not in note), cache-control max-age=300
- [x] (designed: ADR 0002, FR-DAT-08; validation is ROADMAP M2) Free transfers & selling prices are NOT public → derive from entry/{id}/history + transfers (rules engine; regression-test against a real account)
- [x] (captured as NFR-SEC-06) FPL T&Cs page unreadable (JS-rendered); PL site terms forbid commercial use/database creation → flag as project risk (non-commercial, per-user fetch only)
- [x] R5 evidence verified: RPC `bash` command exists (dist/modes/rpc/rpc-types.d.ts:89), `user_bash` extension event (types.d.ts:1016), xterm 6.0.0, pi-web-ui last 0.75.3 (2026-05-27), ttyd 1.7.7 (2024-03-30, stale)
- [x] Design: MVP web TUI = ttyd→tmux→pi (exact CLI look); multi-user = RPC bridge with command allowlist (block `bash`, `switch_session` paths, `export_html` paths)
- [x] Design: block `!` user shell via `user_bash` handler; Shift+Enter keymap in xterm 6.0
- [x] R1 evidence verified (plus S1): skills section only emitted when `read` or `bash` active (dist/core/system-prompt.js:99); calculateCost from model.cost incl. tiers (pi-ai models.js:533); PI_TELEMETRY env overrides install telemetry setting
- [x] Design (S1 check 8 verified): don't use full `systemPrompt` replacement (drops skills section) — modify `systemPromptOptions` sections in before_agent_start instead; run with --no-context-files; set PI_TELEMETRY=0
- [x] Design: replace coding-shaped compaction summary via session_before_compact
- [x] R6 evidence verified live: Fargate per-task isolated VM + only CAP_SYS_PTRACE addable (no gVisor needed/possible), ALB idle timeout default 60s (1–4000), Fargate $0.000011244/vCPU-s
- [x] Design: sandbox = separate container/task (never sidecar on AWS), no network, read-only FPL snapshot mount; exec via small HTTP exec service with explicit minimal env (not docker.sock in prod; S1 used docker exec for local proof only)
- [→ Open] Spike later (Roadmap phase 2): measure Fargate RunTask cold start; warm pool of 1
- [x] NEW FINDING (verified 2026-09-27): FPL CDN serves entry/{id}/transfers|history with `age` up to ~9 days despite no-cache headers; adding a unique query param (`?_=<ts>`) returns origin-fresh (`age: 0`, MISS). → data layer must cache-bust per-user endpoints; keep bootstrap-static on CDN (5-min TTL) except inside deadline window
- [x] R4 evidence verified: open-fpl-solver (Apache-2.0, pushed 2026-09-15, old repo redirects), arXiv 2508.09992 OpenFPL, football-data.co.uk fixtures.csv live with odds columns
- [x] Conflict found & fixed: open-fpl-solver needs Python ≥3.14 → sandbox image python:3.14-slim (ADR 0001)
- [→ Open] Source conflict (non-architectural): GW19 / first-half chip expiry — API deadline 2027-01-01T18:30Z vs PL article "Sat 2 Jan 13:30 GMT". Rules engine reads API; re-check in December
- [x] (FR-DAT-10) Gaffer must record ep_next itself pre-deadline (vaastav historical xP unusable as benchmark)
- [→ Open] football-data.co.uk terms unconfirmed

## Open (carried into Phase 1 — see ROADMAP)
- [ ] Unverified: does Pi pass a tool's `strict` JSON-schema flag to providers? Design doesn't depend on it (validator in execute())
- [ ] Unverified: real-provider cost accuracy (NFR-COST-03, M1 exit)
- [ ] Measure Fargate sandbox cold start (NFR-LAT-02, Phase 2 exit)
- [ ] Validate FT/selling-price derivation on ≥3 real accounts (FR-DAT-08, M2)
- [ ] Re-check GW19 chip-expiry time (API vs PL article), early Dec 2026
- [ ] Terms: FPL T&Cs (JS page unread), football-data.co.uk, vaastav licence (NOASSERTION) — review before Phase 3
- [ ] "Game is being updated" 503 response shape never observed — capture a fixture during the next GW update window
