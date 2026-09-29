# Gaffer — Requirements

**Status:** Draft 1 · **Date:** 2026-09-27 · See [ARCHITECTURE.md](ARCHITECTURE.md) for design and [ROADMAP.md](ROADMAP.md) for when each requirement lands. The **Phase** column refers to the roadmap: 1 = local MVP, 2 = cloud single-user, 3 = multi-user.

**Priorities:** **M** = must, **S** = should, **C** = could.

## Functional requirements

### Input and preferences
| ID | Requirement | Pri | Phase | Acceptance criterion |
|---|---|---|---|---|
| FR-INP-01 | The user can set an FPL team ID for the session (`/team <id>` or in natural language) | M | 1 | `/team 1` followed by "recommend" produces a recommendation whose `snapshot` refers to entry 1. A non-existent ID (`999999999`) gives a clear "team not found" message within 10 s and no recommendation. |
| FR-INP-02 | The user can state optional preferences: risk mode, chips to save, players to keep or avoid, max hits per GW | M | 1 | Setting `save_chips: [wildcard]` and `keep: [X]` means the next recommendation plays no wildcard, keeps X in the squad, and lists both in `preferences`. |
| FR-INP-03 | Preferences persist across sessions for the same team | M | 1 | After a restart of the Gaffer container, a new session for the same team shows the saved preferences in `/prefs` without the user restating them. |
| FR-INP-04 | The user can override the free-transfer count and declare pending transfers, which aren't publicly visible | M | 1 | `/team 1 --ft 3` produces `assumptions.free_transfers = 3, ft_source = "user"`, and the validator uses 3. |

### Data
| ID | Requirement | Pri | Phase | Acceptance criterion |
|---|---|---|---|---|
| FR-DAT-01 | Fetch squad, bank, chips used and remaining (per half), GW status and deadline at request time | M | 1 | For a test entry, the snapshot's squad, bank and chips-used match `entry/{id}/event/{gw}/picks/` and `entry/{id}/history/` fetched by hand at the same minute. |
| FR-DAT-02 | Per-user endpoints are never served from a stale cache | M | 1 | Every per-user request in a `gaffer.snapshot` entry has a cache-busting parameter and a recorded CDN `age` ≤ 60 s. A test with a mocked CDN returning `age: 700000` fails the check. |
| FR-DAT-03 | Shared endpoints are cached with FPL-cycle TTLs, shortened inside T−6h of a deadline | M | 1 | Unit test on the TTL function with frozen clocks: bootstrap 30 min outside the window and 5 min inside; fixtures 6 h / 30 min; element-summary 12 h / 1 h. |
| FR-DAT-04 | Retries use exponential backoff with full jitter; requests are rate-limited | M | 1 | With a mock server returning 429, 503 and 503, then 200: 4 attempts, delays within [0, 0.5·2ⁿ] s capped at 8 s, and no more than 2 requests/second overall. |
| FR-DAT-05 | During "game updating" or downtime, serve the last good snapshot marked stale, and refuse to finalise transfers inside T−1h if per-user data is stale | M | 1 | A mock that returns HTML or 503 produces `snapshot.stale = true`, a warning, and `confidence.overall ≠ high`. If it happens at T−30min, no `transfers` are submitted and the user is told why. |
| FR-DAT-06 | Responses are schema- and invariant-validated; failures are hard errors | M | 1 | Fixtures with a missing `elements[].now_cost`, 14 picks, or two `is_next` events each give a tool error naming the check. No recommendation is produced. |
| FR-DAT-07 | Every fetched dataset is stored as an immutable, content-hashed snapshot for backtesting | M | 1 | Two runs with identical upstream data share a hash. The snapshot directory is read-only to the sandbox (a write attempt fails). |
| FR-DAT-08 | Derive free transfers and selling prices from public data | M | 1 | They match the true values (read from the FPL app by the account owner) for ≥3 reference accounts, across at least one WC or FH week and one banked-FT week. |
| FR-DAT-09 | Fetch next-round bookmaker odds (football-data.co.uk) with fallback when unavailable | S | 1 | With the odds source mocked down, the recommendation still completes, and `warnings` contains "odds unavailable — team strength from Dixon-Coles". |
| FR-DAT-10 | Record the official `ep_next` for all players before each deadline | M | 1 | For each GW after launch, a snapshot exists with a `fetched_at` earlier than the deadline and containing `ep_next`. |

### Rules engine
| ID | Requirement | Pri | Phase | Acceptance criterion |
|---|---|---|---|---|
| FR-RUL-01 | Compute player points under the current scoring (read from `game_config.scoring`, DefCon thresholds as constants) | M | 1 | Reproduces `total_points` from `event/{gw}/live` `explain[]` for **100%** of player-GWs in all finished 2025/26 and 2026/27 GWs. |
| FR-RUL-02 | Squad legality: 15 = 2/5/5/3, ≤3 per club, spend ≤ budget using selling prices | M | 1 | Table-driven tests plus a Hypothesis property: every squad the validator accepts satisfies all constraints, and every single-constraint violation is rejected with the right code. |
| FR-RUL-03 | XI formation and auto-sub simulation | M | 1 | Tests for every formation edge case (GK absent, a DEF auto-sub that would break 3-DEF, bench order). They match ≥20 real `automatic_subs` records from 2026/27 (the API serves picks for the current season only, so 2025/26 records can't be fetched). |
| FR-RUL-04 | FT accrual (+1 per GW, cap 5), hits (−4 each), WC/FH preserve FTs | M | 1 | A transition table test covers 0–5 FTs × 0–6 transfers × {none, WC, FH}. |
| FR-RUL-05 | Chips 2026/27: 8 chips across halves, windows as in the API, one per GW, first-half expiry at the GW19 deadline, no FH in GW20 after FH in GW19 | M | 1 | Tests over the API's `chips` array. The recommendation never proposes an unavailable, expired or second chip in one GW. |
| FR-RUL-06 | Detect blank and double GWs from fixtures | M | 1 | A synthetic fixtures file with team A ×2 and team B ×0 in GW n is flagged DGW/BGW for exactly those teams. |
| FR-RUL-07 | Rules parameters are read from the API where exposed, so a season rule change needs no code change | S | 1 | Changing `max_extra_free_transfers` to 3 in a fixture caps FTs at 4 with no code change. |

### Recommendation
| ID | Requirement | Pri | Phase | Acceptance criterion |
|---|---|---|---|---|
| FR-REC-01 | Recommend this GW's transfers with expected-points gain versus hit cost | M | 1 | Every transfer has `xp_gain_4gw` and `xp_gain_6gw_decayed` recomputed by the validator; `net_xp_gain_4gw = Σgain − hit_cost`. |
| FR-REC-02 | Recommend captain and vice | M | 1 | Both are in the XI, captain ≠ vice, and each has `xp` and `p_start`. |
| FR-REC-03 | Recommend starting XI and bench order | M | 1 | The XI is a valid formation; the bench has 4 players with the GK first, ordered by the simulator's expected auto-sub value. |
| FR-REC-04 | Chip advice for this GW with scenario evidence | M | 1 | `chip.play` is null or an available chip; `chip.scenarios` has ≥1 entry per available chip type over the next 6 GWs, or explains why not. |
| FR-REC-05 | 4-GW rolling plan | M | 1 | `plan` has exactly 4 consecutive GWs starting at the next deadline GW, each passing the validator given the prior GW's state. |
| FR-REC-06 | A rationale and a confidence for each decision; confidence is computed by rules, not asserted | M | 1 | Rationale ≤ 60 words per item. A test fixture with a stale snapshot gives `confidence.overall = low` even if the model submits "high". |
| FR-REC-07 | Every number in the output is recomputed by deterministic code at submit | M | 1 | A submission with a deliberately wrong `xp_gain` is corrected, and `validation.max_model_number_drift` reports the gap. |
| FR-REC-08 | Invalid recommendations are rejected and returned to the model; at most 2 retries | M | 1 | A mocked model submitting 4 players from one club gets an error naming the club rule. After 3 failures the user sees a clear failure message, not an illegal plan. |
| FR-REC-09 | Objective is to maximise season points (max-EV) by default; risk modes only change tie-breaks among near-equal plans | M | 1 | With `risk = balanced`, the chosen plan's decayed xP is within 0.5 of the solver optimum. |
| FR-REC-10 | Structured news → minutes adjustments, quoted and logged | S | 1 | When the model applies an `xmins_override`, the session records the player, the value, and the quoted `news` text. |

### Output and interface
| ID | Requirement | Pri | Phase | Acceptance criterion |
|---|---|---|---|---|
| FR-OUT-01 | Machine-readable output validated against `gaffer.recommendation/1` JSON Schema | M | 1 | Every `gaffer.recommendation` entry validates against `schemas/recommendation-1.json` in CI (ajv) over the eval suite. |
| FR-OUT-02 | Human-readable rendering in the TUI | M | 1 | Screenshot test: the rendered result shows transfers, XI and bench, captain and vice, chip, the 4-GW table and warnings, at 100 columns without wrapping mid-table. |
| FR-OUT-03 | `/export` writes the latest recommendation JSON to a file and prints the path | M | 1 | The file exists, validates against the schema, and is identical to the session entry. |
| FR-UI-01 | Browser UI that looks and behaves like the Pi CLI | M | 1 | Opening `http://127.0.0.1:7681` shows the Pi TUI with the Gaffer theme; slash commands, history, Ctrl+C abort and Shift+Enter newline all work. |
| FR-UI-02 | Streaming output | M | 1 | The first streamed token appears ≤ 5 s after submit (p95 over 20 runs). |
| FR-UI-03 | Reconnect without losing a run | M | 1 | Closing the tab mid-run and reopening within 5 min shows the run still progressing or completed. |
| FR-UI-04 | Web UI for multiple users with real tables and CSV/JSON download | S | 3 | Two users logged in at once see only their own sessions; the recommendation table downloads as valid CSV. |
| FR-ACC-01 | Gaffer never logs into or changes a user's FPL account | M | 1 | Static check: no FPL credentials in config or schema. A request to `my-team/`, `me/` or any non-GET is blocked by the `tool_call` guard (test). The sandbox has no network (test: `curl` from the sandbox fails). |

### Evaluation and admin
| ID | Requirement | Pri | Phase | Acceptance criterion |
|---|---|---|---|---|
| FR-EVL-01 | Offline backtest of the deterministic pipeline against baselines B0 (no transfers), B1 (official-xP greedy), B2 (template) | M | 1 | `gaffer_lib backtest --seasons 2023-24,2024-25,2025-26` outputs season points per policy. G0 beats B0, B1 and B2 on the 3-season mean. |
| FR-EVL-02 | LLM-in-the-loop eval suite of ≥30 fixed cases, graded in code | M | 1 | `pnpm eval` runs all cases headless and writes results JSONL with validator pass rate, points against G0, cost and latency. |
| FR-EVL-03 | Live tracking of recommendations against actual points each GW | M | 1 | Within 24 h of `data_checked`, `outcomes.jsonl` has a row for every recommendation for that GW with recommended-points, actual-points, B0 and B1. |
| FR-EVL-04 | `/scorecard` shows season-to-date Gaffer vs actual vs baselines | S | 1 | It shows cumulative totals matching `outcomes.jsonl`. |
| FR-ADM-01 | Admin report: sessions, tokens and cost per session, model and tool, latency, errors, data-source health | M | 1 | `gaffer admin` generates `admin.html` from `/sessions` and `/data` only. Its totals match a hand count over 3 sessions to within $0.01. |
| FR-ADM-02 | Admin report served behind auth | S | 2 | An unauthenticated request to `/admin` returns 401 or a redirect to OIDC. |
| FR-BUD-01 | Hard cost caps per session and per day | M | 1 | With `GAFFER_BUDGET_HARD=0.05`, a run is aborted when it crosses the cap, a `gaffer.budget` entry records the abort, and the user sees a message. |
| FR-BUD-02 | Soft-cap steering | S | 1 | Crossing `GAFFER_BUDGET_SOFT` injects one steer message asking the model to submit. |

## Non-functional requirements

| ID | Category | Requirement | Acceptance criterion |
|---|---|---|---|
| NFR-COST-01 | Cost | Median cost per recommendation ≤ **$0.50** with the default model | Median `usage.cost.total` per recommendation over the eval suite ≤ $0.50. |
| NFR-COST-02 | Cost | Hard caps: $1.50 per session, $5 per day by default (configurable) | FR-BUD-01 test. |
| NFR-COST-03 | Cost | Cost figures are accurate | For 5 real runs, Gaffer's summed cost is within 2% of the provider's billing/usage console for the same requests. |
| NFR-LAT-01 | Latency | Prompt → rendered recommendation p50 ≤ 90 s, p95 ≤ 180 s (warm sandbox) | Measured over the eval suite from session timestamps. |
| NFR-LAT-02 | Latency | Sandbox provision ≤ 5 s locally; Fargate cold start measured and ≤ 30 s, or a warm pool is used | Phase 2 exit measurement. |
| NFR-LAT-03 | Latency | Golden path (`gaffer_lib run`) ≤ 60 s including chip scenarios | Benchmark in CI on a 2-vCPU runner. |
| NFR-SEC-01 | Security | Generated code runs only in the sandbox: no network, non-root, read-only root, cap-drop ALL, resource limits | Integration tests from inside the sandbox: `curl`, write to `/`, `id -u = 0` and fork bomb all fail or are contained. |
| NFR-SEC-02 | Security | Secrets never enter the sandbox | Test: `env` and `/proc/*/environ` inside the sandbox contain no key-like values, and the LLM key is absent under grep. |
| NFR-SEC-03 | Security | Prompt injection via data doesn't lead to unintended actions | An eval case with instructions injected into a player's `news` shows no tool call deviating from the workflow, and the output recommendation is valid. |
| NFR-SEC-04 | Security | Web TUI is not reachable without auth; no shell escapes | Phase 1: port bound to 127.0.0.1 (compose test). `!ls` is blocked. tmux prefix keys do nothing. Phase 2: ALB OIDC required. |
| NFR-SEC-05 | Security | Multi-user RPC bridge exposes only allowlisted commands | Phase 3: fuzz test sending `bash`, `switch_session` and `export_html` gets rejections. |
| NFR-SEC-06 | Compliance | Respect data-source terms: personal, non-commercial use; no republication of datasets; legal review before any commercial use | Checklist item in release review. Snapshots are not exposed via any endpoint. |
| NFR-PRIV-01 | Privacy | Team IDs are HMAC-hashed in ledgers and user files; manager names are not persisted outside session transcripts | grep of `/data/ledger` and `/data/users` finds no raw team IDs or names. |
| NFR-PRIV-02 | Privacy | No third-party telemetry | `PI_TELEMETRY=0` is set. An egress capture during a run shows only the LLM provider, FPL and football-data hosts. |
| NFR-OBS-01 | Observability | Every run is fully reconstructable from the session log and snapshot | Given a `rec_id`, a script replays `gaffer_lib validate` and reproduces the numbers exactly. |
| NFR-OBS-02 | Observability | Data-source health recorded per request | `gaffer.snapshot` entries include per-endpoint status, latency, retries and CDN age. |
| NFR-PORT-01 | Portability | Model/provider swap is configuration only | Switching `GAFFER_MODEL` to another Pi-supported model (e.g. an OpenAI or local model via `models.json`) runs the eval suite with no code change. |
| NFR-PORT-02 | Portability | Runs on any Docker host and maps to ECS Fargate | `docker compose up` works on macOS and Linux. The phase 2 deployment uses the same images. |
| NFR-REL-01 | Reliability | Graceful behaviour when a data source, the sandbox, the solver or the LLM fails (ARCHITECTURE §10) | Fault-injection tests for each: the user gets an explanatory message; no crash, no illegal plan. |
| NFR-REL-02 | Reliability | Solver time-out returns the best incumbent | With a 1 s limit, the result includes `gap` and confidence ≤ medium. |
| NFR-MNT-01 | Maintainability | Pi core is not forked or patched | The build uses the npm-published `@earendil-works/pi-coding-agent` at a pinned version; no `patches/` directory. |
| NFR-MNT-02 | Maintainability | Pi upgrades are gated by tests | Renovate PR for Pi triggers the S1 checks (as tests), the unit tests and the eval suite. |
| NFR-MNT-03 | Maintainability | Each Gaffer tool, extension and service has a one-line necessity justification in docs | Review checklist over ARCHITECTURE §1.2 and ADR 0006. |
