# ADR 0002 — FPL data access: our own Pi tool in the harness, not MCP or a third-party library

**Status:** Accepted · **Date:** 2026-09-27

## Context
The official FPL API is public, needs no auth for the data Gaffer uses, and is behind Fastly/Varnish rather than Cloudflare. It showed no rate-limit headers when tested on 2026-09-27 ([research 03](../research/03-fpl-data-sources.md)). `my-team/{id}` needs a login and is out of scope: Gaffer never logs in. Two findings shape the design:
1. Per-user endpoints (`entry/{id}/`, `history/`, `transfers/`, `event/{gw}/picks/`) come back from the CDN up to **about 9 days stale** despite their `no-cache` headers (re-verified 2026-09-28: ages of 3.6–10 days on all four for entry 1). A unique query parameter returns fresh origin data (verified; see the research 03 addendum).
2. Free transfers and selling prices are **not public**, so they have to be derived. Pending transfers for the next GW are not visible at all.

Pi's author deliberately leaves out MCP, because every server costs thousands of tokens of tool descriptions up front ([research 01 §9](../research/01-pi-internals.md)).

## Options considered
| Option | Verdict |
|---|---|
| Existing MCP server (several community ones, all young; lewis-king's adds login) | Rejected. It costs context, adds a process, and one option breaks the read-only rule. |
| Python `fpl` library imported in the sandbox | Rejected. Last release 2023-08, and the sandbox has no network by design ([ADR 0001](0001-sandbox.md)). |
| Model writes `curl`/`requests` code itself | Rejected. It would need sandbox egress, and retries, cache-busting and validation would be done differently every run. |
| **Our own `fpl_snapshot` Pi tool in the harness** | **Chosen.** |

## Decision
There is **one** data tool, `fpl_snapshot(team_id?, element_summaries?: number[], include?: ["odds"], force_fresh?)`, registered by the `gaffer-data` extension (`team_id` defaults to the one set with `/team`; `include: ["odds"]` adds the odds source, FR-DAT-09, built in M3; a historical `gw?` parameter is only needed by the evaluator and is not built). It runs in the harness, which already has network access to reach the LLM. What it does:
- It fetches `bootstrap-static`, `fixtures`, `entry/{id}`, `entry/{id}/history`, `entry/{id}/transfers`, and `entry/{id}/event/{last_gw}/picks`. It adds `element-summary/{pid}` only for requested players, with at most 8 requests in parallel.
- It fetches `event/{gw}/live` for the last six finished, data-checked GWs and stores each as `live-<gw>.json`, trimmed to the per-player stats (the `explain` breakdown is dropped). The minutes model needs each player's recent starts and minutes, which `bootstrap-static` only has as season totals; `element-summary` for every player would be about 670 requests, and this is at most six, each fetched once because a checked GW never changes. A GW whose stats can't be fetched is a warning, not an error.
- **Freshness policy** (TTLs follow FPL's update cycle):

  | Resource | TTL outside the deadline window | Inside the window (T−6h → deadline) | Notes |
  |---|---|---|---|
  | `bootstrap-static` | 30 min, plus a forced refresh after `price_change_deadlines[i]` has passed | 5 min (the CDN's max-age) | ~1.8 MB, so kept on the CDN |
  | `fixtures` | 6 h | 30 min | FDR and kickoff changes |
  | `entry/*` (per user) | **Always fetched fresh, cache-busted with `?_=<ts>`** | same | small; once per request |
  | `element-summary/{id}` | 12 h | 1 h | history only changes after matches |
  | `event/{gw}/live` | frozen once `data_checked` (only checked GWs are fetched in M3); 1 min while live | — | recent minutes for the model; live values for the evaluator (M5) |
  | football-data.co.uk `fixtures.csv` | 6 h | 30 min | next-round odds; only with `include: ["odds"]` |
  | football-data.co.uk season results | current season 24 h, previous season 30 days | same | only with `include: ["odds"]` |
- **Resilience:** exponential backoff with full jitter (base 0.5 s, cap 8 s, 4 tries) on 429, 5xx, network errors and non-JSON bodies. Non-JSON or 503 counts as **"game updating"**: the tool returns the last good snapshot marked `stale: true, reason: "fpl_updating"`, and the recommendation must show that caveat. A token bucket limits the process to 2 requests/second, and requests carry a descriptive User-Agent.
- **Validation:** responses are checked against TypeBox schemas for the fields Gaffer relies on. They also go through invariant checks: 15 picks, 20 teams, exactly one `is_next` event, and chip definitions that parse. A schema failure is a hard tool error. We never analyse data we don't understand.
- **Output:**
  - It writes an immutable, content-hashed snapshot to `/data/snapshots/<season>/<gw>/<utc-ts>-<hash>/…json`, which the sandbox sees read-only.
  - It also computes the **derived state**: free transfers, selling prices and chips remaining. This uses `gaffer_lib` rules code run in the sandbox, so there is only one implementation of the rules.
  - It returns a compact summary (under 1.5k tokens) plus the snapshot path. It never returns raw JSON to the model.
- **Snapshots double as the backtest store.** Nothing is deleted during a season. Historical seasons come from `vaastav/Fantasy-Premier-League`; the M3 backtest reads them from a gitignored directory filled by `tools/fetch_history.py` (pinned commit). A sync into `/data/history/` for the running stack is not built.
- **The official `ep_next` is recorded before each deadline (FR-DAT-10).** Every snapshot's `bootstrap-static` carries `ep_next` for all players. The store's index remembers, per GW, the latest snapshot taken before that GW's deadline (`ep_next:<season>:<gw>`), which is what the evaluator will read. A snapshot only exists when something calls `fpl_snapshot`: nothing in phase 1 takes one in a week when the user doesn't open Gaffer. That trigger is an open question (BUILD.md, M3).
- **Supplementary sources:** there is exactly one in the MVP, **football-data.co.uk** (free CSVs, no key). It is fetched by the same tool with `include: ["odds"]` and written into the snapshot as `odds.json`:
  - `fixtures.csv`: bookmaker 1X2 and over/under 2.5 prices for the next round, needed for odds-implied team goal expectations ([ADR 0003](0003-analytics-split.md)). It only lists matches a few days ahead: on 2026-10-01, in an international break, it had no Premier League row.
  - `mmz4281/<season>/E0.csv` for the previous and the current season: results (and match xG, which the file has from 2026/27). The Dixon-Coles model is fitted on these. *Changed in M3:* the original text had Dixon-Coles "fitted on FPL results and xG" alone, but the FPL API serves the current season only (50 matches at GW6), which is too little to separate 20 teams; the previous season's results come from the same host, so the allowlist still grows by one host only.
  - Only Premier League rows and the columns Gaffer reads are stored (the price columns, scores, xG); nothing else from the files is kept, and nothing is republished.
  - The client is GET-only, to `https://football-data.co.uk` only (the `www.` name redirects there; redirects are refused so no other host is contacted), on the allowlisted paths, behind the same 2 req/s limiter, with at most 3 tries and a descriptive User-Agent.
  - **If it is unavailable** the snapshot still completes: a cached `fixtures.csv` under 48 h old is used with a warning; otherwise `odds.json` says `available: false` with the reason, the Dixon-Coles model is fitted on whatever results are available (cached football-data results, plus this season's results from FPL's `fixtures`), and the plan carries the warning "odds unavailable — team strength from Dixon-Coles" (FR-DAT-09).
  - Its terms are unconfirmed (see REQUIREMENTS NFR-SEC-06).

  The official API already carries xG/xA/xGI, `ep_next`, set-piece order, news, DefCon stats and the new official price-change projection fields. Understat and paid projection CSVs are upgrade-path inputs.

## Consequences
- Being honest about unknowns: pending transfers and exact FT counts may be wrong. The FT count is **derived** and shown with an "assumed" flag, and the user can override it (`/team 123 --ft 2 --pending "Salah>Palmer"`).
- Cache-busting bypasses FPL's CDN. We limit it to per-user endpoints, fetched once per request, to stay a polite client.
- **Terms risk.** The PL site's terms forbid commercial use and "creating a database" from its material. Gaffer is personal and non-commercial. Snapshots are private working data and are never republished. Any commercial launch needs legal review first ([REQUIREMENTS NFR-SEC-06](../REQUIREMENTS.md)).
