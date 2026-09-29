# 03 — FPL data sources (2026/27)

Research date: 2026-09-27 (Sunday, after GW5; GW6 deadline is 2026-10-10 10:00 UTC, after the international break).
Method: every official endpoint below was requested with `curl` on this date; the shapes, sizes and headers are what came back. Third-party claims come from live web fetches or searches and are marked as such.

---

## TL;DR

- **The official API works without auth and without Cloudflare.** It is served through Fastly/Varnish plus Google (`via: 1.1 google, 1.1 varnish`, `server: openresty`, `x-served-by: cache-lhr-…`). There was no challenge page and no User-Agent check (an empty UA and `python-requests` UA both got 200). A burst of 40 sequential `element-summary` calls all returned 200.
- **`bootstrap-static/` is the backbone.** It is 1.78 MB and carries players, teams, events, chips, scoring and rules. It already includes xG/xA/xGI/xGC, `ep_this`/`ep_next` (official xP), set-piece order, injury news, and **new this season: official price-change progress and projection fields**.
- **Chips are the same as 2025/26:** two sets (WC, FH, BB, TC), one set for GW1–19 and one for GW20–38. `max_extra_free_transfers: 4`, so up to 5 FTs can be banked.
- **Public per-manager data is enough for advice.** `entry/{id}/`, `history/`, `picks/` and `transfers/` give bank, squad value, chips used and transfer history. Free transfers available is **not** exposed publicly and has to be derived. `my-team/{id}/` returns 403 without auth (confirmed).
- **Recommendation:** use a thin custom Pi tool (our own typed HTTP client with caching) over the official API. Don't depend on a third-party library or MCP server; the Python `fpl` library is stale (last release 2023).

---

## Part A — Official FPL API

Base: `https://fantasy.premierleague.com/api/`. Every tested endpoint needs a trailing slash.

### A.1 Endpoint reference

| Endpoint | Auth | Status / size (2026-09-27) | Cache headers observed | Key fields | Use in Gaffer |
|---|---|---|---|---|---|
| `bootstrap-static/` | No | 200, 1,778,808 B | `cache-control: max-age=300, stale-while-revalidate=3600, stale-if-error=3600`; `edge-control: max-age=300`; `age: 235`; no ETag / Last-Modified | top-level: `chips, events, game_settings, game_config, phases, teams, total_players, element_stats, element_types, elements` (667 elements, 20 teams) | Everything static-ish: players, prices, news, xStats, ep, GW calendar, chip rules, scoring |
| `fixtures/` | No | 200, 231,760 B | `max-age=0, no-cache, no-store, must-revalidate` (CDN `age: 231` anyway) | `id, event, kickoff_time, team_h/a, team_h/a_difficulty (FDR), team_h/a_score, started, finished, finished_provisional, minutes, stats[]` | Fixture list + FDR + per-fixture goal/assist/bonus/BPS |
| `fixtures/?event=6` | No | 200, 3,092 B (10 fixtures) | same | same | Fixtures for one GW |
| `element-summary/{id}/` | No | 200, ~17.6 KB | same | `fixtures` (upcoming, with `difficulty`, `is_home`), `history` (per-match: minutes, xG, xA, xGC, DefCon, bps, value, selected, transfers), `history_past` (per season) | Player deep-dive, form, minutes risk |
| `event/{gw}/live/` | No | 200, 474,264 B for GW5; `{"elements":[]}` for GW6 (not started) | same | `elements[].stats` (full stat line + `total_points`, `in_dreamteam`), `elements[].explain[]` (points breakdown per fixture) | Live/final GW points |
| `event-status/` | No | 200, 224 B | same | `status[] {bonus_added, date, event, points: "r"}`, `leagues: "Updated"` | Detect whether bonus/points are final and leagues updated |
| `dream-team/{gw}/` and `dream-team/` | No | 200, 496 B | same | `top_player {id, points}`, `team[] {element, points, position}` | Minor |
| `team/set-piece-notes/` | No | 200, 2,320 B | same | `last_updated`, `teams[] {id, notes[] {external_link, info_message, source_link}}`. Today every team says "Check back for additional notes soon" | Set-piece commentary (currently empty). **Path is `team/set-piece-notes/`; `set-piece-notes/` returns 404.** |
| `entry/{id}/` | No | 200, ~17 KB | same (`age` of days: served stale from CDN) | `current_event, last_deadline_bank, last_deadline_value, last_deadline_total_transfers, summary_overall_points/rank, summary_event_points/rank, started_event, favourite_team, leagues{classic,h2h,cup,cup_matches,event}, years_active, player_first_name/last_name, player_region_*` | Manager overview. Contains personal name/region: don't persist beyond need |
| `entry/{id}/history/` | No | 200, ~2.2 KB | same | `current[] {event, points, total_points, rank, overall_rank, percentile_rank, bank, value, event_transfers, event_transfers_cost, points_on_bench}`, `past[] {season_name, total_points, rank}`, `chips[] {name, time, event}` | Bank per GW, hits, **chips used**, FT derivation |
| `entry/{id}/event/{gw}/picks/` | No | 200, ~1.9 KB; **404 for a GW whose deadline hasn't passed** | same | `active_chip, automatic_subs[], entry_history{…bank, value…}, picks[] {element, position, multiplier, is_captain, is_vice_captain, element_type}` | Squad as of last deadline. Pending transfers for the next GW are invisible |
| `entry/{id}/transfers/` | No | 200, ~5.7 KB | same | array of `{element_in, element_in_cost, element_out, element_out_cost, entry, event, time}` | Transfer history → purchase prices → **selling prices** |
| `leagues-classic/{id}/standings/?page_standings=N` | No | 200, ~10.8 KB | same | `league{…}, standings{has_next, page, results[] {entry, entry_name, player_name, rank, last_rank, total, event_total}}, new_entries, last_updated_data` | Mini-league context (rival EO) |
| `regions/` | No | 200, 21.7 KB | `max-age=300` | region list | Minor |
| `stats/most-valuable-teams/` | No | 200, 1.2 KB | no-cache | top team values | Minor |
| `me/` | No (returns empty) | 200, `{"player":null,"watched":[]}` | private | — | Not useful without login |
| `my-team/{id}/` | **Yes** | **403** `{"detail":"Authentication credentials were not provided."}` | private | (would give FT count, selling prices, chip status) | **Out of scope: Gaffer never logs in** |

Other results: `event/{gw}/fixtures/`, `bootstrap-dynamic/`, `event/{gw}/status/` and `set-piece-notes/` all returned 404. `entry/999999999/` gives 404 `{"detail":"No Entry matches the given query."}`.

### A.2 Events / gameweek state (from `bootstrap-static.events[]`)

Fields: `id, name, deadline_time, deadline_time_epoch, release_time, average_entry_score, highest_score, highest_scoring_entry, finished, data_checked, is_previous, is_current, is_next, can_enter, can_manage, released, ranked_count, chip_plays[] {chip_name, num_played}, most_selected, most_captained, most_vice_captained, most_transferred_in, top_element, top_element_info, transfers_made, cup_leagues_created, h2h_ko_matches_created, overrides`.

Observed today: GW5 `is_current: true, finished: true, data_checked: true, deadline_time: 2026-09-18T17:30:00Z`. GW6 `is_next: true, deadline_time: 2026-10-10T10:00:00Z`. During the international break, `is_current` stays on the last played GW.

### A.3 Chips: raw `bootstrap-static.chips` (verbatim, 2026-09-27)

```json
[
 {"id":1,"name":"wildcard","number":1,"start_event":2,"stop_event":19,"chip_type":"transfer","overrides":{"rules":{},"scoring":{},"element_types":[],"pick_multiplier":null}},
 {"id":2,"name":"wildcard","number":1,"start_event":20,"stop_event":38,"chip_type":"transfer","overrides":{...same empty...}},
 {"id":3,"name":"freehit","number":1,"start_event":2,"stop_event":19,"chip_type":"transfer","overrides":{...}},
 {"id":4,"name":"bboost","number":1,"start_event":1,"stop_event":19,"chip_type":"team","overrides":{...}},
 {"id":5,"name":"3xc","number":1,"start_event":1,"stop_event":19,"chip_type":"team","overrides":{...}},
 {"id":6,"name":"freehit","number":1,"start_event":20,"stop_event":38,"chip_type":"transfer","overrides":{...}},
 {"id":7,"name":"bboost","number":1,"start_event":20,"stop_event":38,"chip_type":"team","overrides":{...}},
 {"id":8,"name":"3xc","number":1,"start_event":20,"stop_event":38,"chip_type":"team","overrides":{...}}
]
```

How to read it: 8 chips, 4 types × 2 halves. First half is GW1–19 (WC and FH from GW2), second half is GW20–38. There is no Assistant Manager / `manager` chip this season. The 2024/25 `manager` chip is gone, and `scoring.mng_*` keys remain but are all 0. The official PL article ([chips 2026/27](https://www.premierleague.com/en/news/4679879/whats-happening-with-fpl-chips-in-202627)) adds rules the JSON doesn't encode:
- one chip per GW
- first-half chips expire at the GW19 deadline (Sat 2 Jan, 13:30 GMT)
- FH can't be played in GW1
- if FH is used in GW19, the second FH can't be used in GW20

**Chips remaining for a public entry:** compute `chips` (definition) minus `entry/{id}/history/.chips[]`, matching by `name` plus whether `event` falls within `[start_event, stop_event]`. Example (entry 1): `[{"name":"bboost","event":2},{"name":"wildcard","event":3},{"name":"freehit","event":5}]`.

### A.4 Rules / settings (`game_settings`, `game_config.rules`)

- `squad_squadsize: 15`, `squad_squadplay: 11`, `squad_team_limit: 3`, `squad_total_spend: 1000` (£100.0m; `ui_currency_multiplier: 10`).
- `transfers_sell_on_fee: 0.5` (50% of profit, rounded down to £0.1m). `element_sell_at_purchase_price: false`.
- `max_extra_free_transfers: 4` (so a maximum of 5 FTs). `transfers_cap: 20`.
- `game_config.settings.price_change_deadlines: ["2026-09-27T23:00:00Z", "2026-09-28T23:00:00Z", "2026-09-29T23:00:00Z"]` and `game_config.status.price_change_last_updated`. **Both are new**, and they tell you when the next price update runs.
- `game_config.scoring`: goals GKP 10 / DEF 6 / MID 5 / FWD 4; CS 4/4/1/0; `defensive_contribution {DEF:2, MID:2, FWD:2, GKP:0}` (DefCon points retained from 2025/26); assists 3; saves 1; etc. **Read scoring from here rather than hard-coding it.**

### A.5 Free transfers, bank, chips: what's public without login

| Need | Public source | Notes |
|---|---|---|
| Bank | `entry/{id}/.last_deadline_bank`, `history.current[-1].bank`, `picks.entry_history.bank` (tenths of £m) | Value as of the last deadline |
| Squad value | `last_deadline_value` / `value` | Market value, **not** selling value |
| Free transfers available | **Not exposed.** Only `my-team` (auth) has it | Derive: start at 1 after GW1, +1 each GW, capped at 5; subtract `event_transfers` minus the paid ones (`event_transfers_cost/4`). WC/FH weeks keep the FT count with no +1 (confirmed 2026-09-29 against open-fpl-solver's FT constraint and the PL's five-FT article). In WC/FH weeks `history.current[].event_transfers` is **0**, although `transfers/` lists every move, FH ones included (checked on 50 entries). `gaffer_lib.derive` implements this; owner-checked reference accounts are FR-DAT-08 |
| Selling prices | Not exposed publicly | Derive from `transfers/` purchase price + `now_cost` + 50% sell-on fee. Players held since GW1 without transfers: purchase price = `now_cost - cost_change_start` |
| Chips used / remaining | `history.chips[]` + `bootstrap.chips` | See A.3 |
| Pending (unconfirmed) transfers for next GW | Not visible | Ask the user |

### A.6 Player fields of note (`elements[]`, 100+ keys)

- Availability: `status` (a/d/i/s/u/n), `news`, `news_added`, `chance_of_playing_this_round`, `chance_of_playing_next_round`.
- Expected stats: `expected_goals`, `expected_assists`, `expected_goal_involvements`, `expected_goals_conceded` plus `_per_90` versions (Opta-derived, strings).
- DefCon: `defensive_contribution`, `_per_90`, `tackles`, `recoveries`, `clearances_blocks_interceptions`.
- Official xP: `ep_this`, `ep_next` (strings, e.g. Groß `"11.2"`).
- Set pieces: `penalties_order`, `corners_and_indirect_freekicks_order`, `direct_freekicks_order`, plus `*_text`. 61 players had a penalty order today.
- **New for 2026/27: official price-change predictor data** (matches the new "Price Change Predictor" feature, [PL article](https://www.premierleague.com/en/news/4680462/whats-new-in-202627-fantasy-price-change-predictor)):
  - `price_change_percent` (progress toward rise or fall, e.g. `"85.5"` / `"-44.8"`)
  - `price_change_hourly_rate`
  - `price_change_projections[] {offset, projected_percent, likelihood}` (likelihood roughly −4…+4)
  - `price_change_locked_until`
  - `price_change_calibrating`
  - The PL page says you need to log in to *view* it on the site, but the raw fields are in the public `bootstrap-static`.
- **New:** `scout_risks[] {property, notes, gameweek, url}`. For example, `loan_ineligible` flags a GW where a loanee can't face his parent club (8 players today). `scout_news_link` gives a club news URL.
- Other: `opta_code`, `region`, `team_join_date`, `birth_date`, `squad_number`, `has_temporary_code`, `known_name`.

### A.7 Rate limits, caching, availability

- **No documented public rate limit.** 40 rapid sequential calls all returned 200, with no `RateLimit-*` or `Retry-After` headers. Community reports say bursts of hundreds of requests can get IP-throttled. A "60 req/min per IP" figure found in search belongs to a third-party wrapper (fpl-trends-api), not to FPL.
- **CDN:** Fastly/Varnish plus Google, not Cloudflare. `bootstrap-static` is cached for 5 minutes. Other endpoints send `no-cache` but are clearly edge-cached anyway (`age` up to ~9 days on `entry/1/transfers/`), so manager data may be stale. No ETag / Last-Modified, so conditional requests aren't possible.
- **User-Agent:** not required today. Send a descriptive UA anyway.
- **"The game is being updated":** during the post-deadline window and at score finalisation, the site is known to return a 503 / HTML maintenance response instead of JSON (not observed today). The client must treat non-JSON or 503 as "updating", back off, and serve cached data. **Changed in 2026/27:** GW scores now finalise at 09:00 UK the morning after the last match, not one hour after the final whistle ([changes article](https://www.premierleague.com/en/news/4679873/all-you-need-to-know-about-changes-to-fpl-for-202627)), so `data_checked` flips later.
- Daily price changes run at about 01:00 UK (`price_change_deadlines` at 23:00Z = 00:00 BST, from the fields above).

### A.8 Terms of use

- `fantasy.premierleague.com/robots.txt` has no robots file; the SPA HTML is served instead.
- The FPL terms page (`/help/terms`) is JS-rendered and couldn't be read by fetch (see Unconfirmed).
- The Premier League site Terms of Use (fetched) prohibit commercial use and "creating a database … that includes material downloaded … from the Website or App". They have no explicit scraping/bot clause.
- **Implication:** personal/non-commercial advisory use of the read-only API is the long-standing community norm and tolerated in practice. Redistributing or commercialising a stored copy of the data would conflict with the database clause. Keep caches ephemeral, don't re-publish datasets, and get legal review before any commercial launch.

---

## Part B — Access method: libraries and MCP servers

Metadata pulled live from PyPI, npm and the GitHub API on 2026-09-27.

| Package / server | Lang | Latest version | Last release / push | Licence | Status |
|---|---|---|---|---|---|
| `fpl` (amosbastian/fpl) | Py (async) | 0.6.35 | PyPI 2023-08-14; repo push 2024-07-26 | MIT | **Stale**: predates DefCon, two chip sets and the price-predictor fields |
| `fpl-api` (C-Roensholt) | Py | 0.0.4 | 2024-02-07 | MIT | Stale, tiny |
| `pyfpl` | Py | 0.0.3 | 2021-05-30 | MIT | Dead |
| `fpl-mcp` (rishijatia/fantasy-pl-mcp) | Py MCP | 0.1.7 | 2026-08-03 | MIT | Active; ~80★; most used |
| `fpl-mcp-server` (nguyenanhducs) | Py MCP | 1.0.3 | repo push 2026-02-20 | MIT (repo) | 19 tools; slowing |
| `fantasypl/mcp` | Go MCP | — | push 2026-09-23 | MIT | New, 0★, single binary |
| `lewis-king/fpl-mcp-server` | MCP | — | push 2026-08-09 | MIT | Includes login/team control (we don't want that) |
| `david-macleod/fpl-mcp` | MCP | — | push 2026-09-23 | none | No licence, so can't reuse |
| `pradhann/FPL-MCP` | MCP | — | push 2025-08-17 | none | 2025/26 only |
| `fpl-mcp` (owen-lacey) | npm MCP | 1.0.2 | 2025-12-01 | ISC | Low activity |
| `fpl-api` (jeppe-smith) | TS | 5.0.1 | 2026-09-07 | MIT | **Maintained, typed**, 17★ |
| `fantasy-premier-league-api` (FarazPatankar) | TS | 0.6.0 | 2026-08-22 | MIT | Active, 1★ |
| `fpl-fetch` (pmc-a) | TS | 2.9.0 | 2026-01-21 (push 2026-09-21) | MIT | Active, 0★ |
| `fpl-ts` | TS | 1.0.0 | 2021-01-14 | MIT | Dead |

**Recommendation: build a Pi custom tool (our own thin client), not an MCP server or third-party library.**

1. The surface is small: about 8 GET endpoints, no auth. A typed client with caching is a day's work. The TS `fpl-api` types are worth consulting as a reference, but we should own the schema.
2. Fields change every season (DefCon 2025/26; price-predictor, `scout_risks` and `price_change_deadlines` in 2026/27). Community libraries lag: `fpl` has had no release since 2023. We need to update our own schema the day a field appears.
3. We need specific behaviour that generic MCPs don't give us:
   - a shared cache (bootstrap at a 5-minute TTL, manager data at a short TTL)
   - handling of the "game is being updated" state
   - a polite rate limit
   - derived fields (FTs, selling prices, chips remaining)
4. MCP servers add a process boundary and a supply-chain risk. Several also implement **login** (lewis-king), which conflicts with Gaffer's read-only promise. rishijatia's `fpl-mcp` is fine for a quick prototype or benchmark, not for production.
5. A library imported in the sandbox is a reasonable fallback if Pi tools are Python-only, but the stale Python options make "our own module" the better choice either way.

---

## Part C — Supplementary sources

| Source | Data | Access | Key / cost | Freshness | Reliability | Licence / terms | Verdict |
|---|---|---|---|---|---|---|---|
| **FPL `bootstrap-static` / `element-summary`** | xG, xA, xGI, xGC (+ per-90, per match), DefCon, ep_next | JSON API | Free, no key | Live; post-match | High (official, Opta-fed) | PL ToU (non-commercial) | **Primary for xStats**. No need for Understat for basics |
| **Understat** | xG, xA, npxG, xGChain, xGBuildup, shots, key passes; team xG/xGA/PPDA per match | Undocumented JSON: `GET https://understat.com/getLeagueData/EPL/2026` (needs `X-Requested-With: XMLHttpRequest`, returns `{teams, players, dates}`); page HTML no longer embeds `JSON.parse` blobs the old way | Free | Updated after matches (2026 season has 5 games in) | Medium (unofficial, format changed before) | No API terms; scraping unofficial | Optional secondary (npxG, xGChain) |
| **FBref** | Basic stats only | HTML | Free | — | **Blocked**: 403 with `cf-mitigated: challenge` (Cloudflare) | Sports-Reference terms forbid scraping | **Don't use.** Lost Opta advanced data (xG/xA) on 20 Jan 2026 per [The IX](https://www.theixsports.com/the-ix-soccer/fbrefs-loss-advanced-stats-womens-soccer-data-accessibility/) |
| **StatsBomb open data** | Event data | GitHub JSON | Free, attribution required | Static | High | StatsBomb open-data licence | Only PL 2003/04 and 2015/16, so irrelevant for live advice |
| **FPL set-piece data** | penalty/corner/FK order in `elements`; notes in `team/set-piece-notes/` | JSON | Free | Updated ad hoc (notes empty today) | Medium-high | PL ToU | Use the `*_order` fields |
| **FPL injury fields** | `status, news, news_added, chance_of_playing_*`, `scout_risks`, `scout_news_link` | JSON | Free | Updated through the day by FPL Scout | High | PL ToU | **Primary** |
| Premier Injuries | Injury table | HTML (403 to curl, bot-protected); paid data services | Commercial | Daily | High | Commercial, no free API | Skip |
| premierleague.com injury news | Club-by-club articles | HTML | Free | Pre-GW | High | PL ToU | Optional link-out |
| Fantasy Football Scout | Team news, predicted line-ups, price predictions | HTML; paid membership | Paid for full | Daily | High | No API; scraping against ToS (assumed) | Link-out only |
| Fantasy Football Hub | Predicted line-ups, AI projections | HTML/app; paid (50% promo for 2026/27 per search) | Paid | Daily | Medium-high | No public API | Link-out only |
| RotoWire EPL line-ups | Predicted line-ups | HTML (200) | Free page | Pre-match | Medium | ToS forbid scraping (assumed) | Link-out only |
| FPL Review | Projections, planner, solver | Web app; Patreon (~€3.90/mo per search) | Paid | Weekly+ | High (community benchmark) | No public API | Link-out; user may paste exports |
| fplform | Predicted points per GW; CSV export | HTML + CSV export | Free | Weekly | Medium | "All rights reserved" | Possible with user-initiated export; confirm terms |
| **Official price predictor** | `price_change_percent`, `price_change_projections` | JSON (bootstrap) | Free | Every 15 min per PL | High (official) | PL ToU | **Primary; new 2026/27** |
| LiveFPL | Price predictions | HTML (200) | Free | Hourly | High historically | No API | Cross-check only |
| FPLStatistics | Price predictions | Timed out (000) | — | — | Unknown / down? | — | Skip |
| **vaastav/Fantasy-Premier-League** | Historical GW CSVs 2016-17 → 2026-27 (incl. `xP{gw}.csv` snapshots of ep) | GitHub raw CSV | Free | **2026-27 has only `gw1.csv`, `merged_gw.csv`, `xP1.csv`; last commit 2026-08-28 "Add 26/27 gw1 data"**. 2025-26 complete (50 files in `gws/`) | High for past seasons | LICENSE file is MIT text (GitHub reports NOASSERTION); README asks for citation | Use for backtesting past seasons; not for current season |
| **The Odds API** | h2h, totals (EPL); player props mainly US sports | REST, key required (401 `MISSING_KEY` without) | Free 500 credits/month; $30/mo for 20k | Live | High | Their ToS | Optional: team win / CS / goals probability from totals + h2h. 500 credits is enough for about one EPL h2h+totals pull per day |
| Official xP (`ep_this`, `ep_next`) | Next-GW expected points | JSON | Free | Refreshed with data updates | Basic model | PL ToU | Baseline projection; Gaffer should blend with fixtures and minutes |

---

## What changed vs previous seasons

| Area | 2024/25 | 2025/26 | 2026/27 (observed) |
|---|---|---|---|
| Chips | 2 WC + FH + BB + TC + Assistant Manager | Two sets of 4 chips split at GW19/20 | **Same as 2025/26**; no AM chip (`mng_*` scoring all 0) |
| DefCon points | No | Introduced | Retained (`defensive_contribution` scoring 2 pts DEF/MID/FWD) |
| FT banking | Up to 5 | Up to 5 | Up to 5 (`max_extra_free_transfers: 4`) |
| Price predictor | Third-party only | Third-party only | **Official**: `price_change_*` fields in bootstrap + `price_change_deadlines` |
| Player risk flags | — | — | **New** `scout_risks[]` (e.g. loan ineligibility by GW), `scout_news_link` |
| Score lockdown | ~1h after last match | ~1h after last match | **09:00 UK the next day**: `data_checked` flips later |
| Bonus | Final after match | — | Projected bonus shown live after 20 min; BPS tweaked to reduce overlap with DefCon |
| AFCON extra FTs | — | Yes (Dec) | None this season |
| FBref xG | Available | Removed 20 Jan 2026 | Unavailable; FBref now Cloudflare-blocked to curl |
| Set-piece notes endpoint | `team/set-piece-notes/` | same | same (currently placeholder text) |

---

### Addendum (orchestrator verification, 2026-09-27)
Re-tested A.7's edge-caching finding. `GET /api/entry/1/transfers/` → `age: 788439` (~9.1 days), `x-cache: MISS, HIT`; the same URL with `?_=1790543866` → `age: 0`, `x-cache: MISS, MISS`. `entry/1/history/` behaves the same (`age: 544353` vs `0`). **So a unique query parameter bypasses the CDN and returns fresh origin data.** Gaffer must use this for per-user endpoints, which are small and fetched once per request. It must not do it for `bootstrap-static` (1.8 MB), except for one forced refresh inside the deadline window.

## Sources

Live API calls (all 2026-09-27 ~21:10 UTC, via curl):
- https://fantasy.premierleague.com/api/bootstrap-static/
- https://fantasy.premierleague.com/api/fixtures/ and `?event=6`
- https://fantasy.premierleague.com/api/element-summary/124/
- https://fantasy.premierleague.com/api/event/5/live/, /event/6/live/
- https://fantasy.premierleague.com/api/event-status/
- https://fantasy.premierleague.com/api/dream-team/5/
- https://fantasy.premierleague.com/api/team/set-piece-notes/ (and 404 at /api/set-piece-notes/)
- https://fantasy.premierleague.com/api/entry/1/, /history/, /event/5/picks/, /event/6/picks/ (404), /transfers/
- https://fantasy.premierleague.com/api/my-team/1/ (403), /api/me/
- https://fantasy.premierleague.com/api/leagues-classic/314/standings/
- https://fantasy.premierleague.com/robots.txt (SPA HTML, no robots)

Web pages:
- https://www.premierleague.com/en/news/4679873/all-you-need-to-know-about-changes-to-fpl-for-202627
- https://www.premierleague.com/en/news/4679879/whats-happening-with-fpl-chips-in-202627
- https://www.premierleague.com/en/news/4680462/whats-new-in-202627-fantasy-price-change-predictor
- https://www.premierleague.com/en/terms-and-conditions
- https://www.theixsports.com/the-ix-soccer/fbrefs-loss-advanced-stats-womens-soccer-data-accessibility/
- https://understat.com/getLeagueData/EPL/2026
- https://the-odds-api.com/ and https://the-odds-api.com/liveapi/guides/v4/
- https://www.fplform.com/
- https://www.patreon.com/fplreview (via search snippet)
- https://allaboutfpl.com/2026/08/complete-detailed-review-of-fantasy-football-hub/ (via search snippet)
- https://www.fantasyfootballscout.co.uk/2026/07/21/fpl-2026-27-price-change-predictions (search snippet)
- https://github.com/statsbomb/open-data (competitions.json)
- PyPI JSON API: fpl, fpl-api, pyfpl, fpl-mcp, fpl-mcp-server
- npm registry: fpl-api, fpl-ts, fantasy-premier-league-api, fpl-mcp, fpl-fetch
- GitHub API: amosbastian/fpl, vaastav/Fantasy-Premier-League (contents/data, commits, license), rishijatia/fantasy-pl-mcp, nguyenanhducs/fpl-mcp-server, fantasypl/mcp, lewis-king/fpl-mcp-server, david-macleod/fpl-mcp, pradhann/FPL-MCP, owen-lacey/fpl-mcp, jeppe-smith/fpl-api, FarazPatankar/fantasy-premier-league-api, pmc-a/fpl-fetch

## Unconfirmed

- **FPL Terms & Conditions text** (`fantasy.premierleague.com/help/terms`): JS-rendered, and WebFetch returned only the title. Not verified whether it contains an explicit automated-access clause. Only the PL-wide ToU was read. Next step: open it in a real browser.
- **"The game is being updated" behaviour** (exact status code/body): not observed today (no update window during the test). The description comes from community knowledge and search results, not from a live response. Re-test around the GW6 deadline (2026-10-10 10:00 UTC) and at the 09:00 UK finalisation.
- **Rate-limit thresholds:** 40 sequential requests were fine. No 429 was observed and there are no documented limits. The throttling threshold is unknown; I didn't stress-test it on purpose.
- **Free-transfer derivation rules** (WC/FH preserving banked FTs, behaviour at the GW19/20 chip boundary): not confirmed against the official rules page for 2026/27 (the `/help/rules` SPA wasn't fetched). Validate against a real account.
- **`price_change_projections.likelihood` scale** (observed −3…+4) and the mapping to "Very Likely to Rise" etc.: inferred, not documented.
- **Understat terms / stability:** endpoint works, but there's no published API or licence.
- **FPL Review, Fantasy Football Hub, Fantasy Football Scout, RotoWire pricing and ToS:** from search snippets or homepage titles only. Full pricing and ToS pages weren't read.
- **FPLStatistics:** both .co.uk and .com timed out; unclear whether the site is down or blocking.
- **Premier Injuries:** 403 to curl; terms not read.
- **The Odds API EPL player props** (anytime goalscorer): the homepage says props are for "selected US sports". EPL prop availability is unverified without a key.
- **vaastav repo licence:** the LICENSE file contains MIT text but GitHub classifies it as NOASSERTION. Whether 2026-27 data will keep being updated is unknown (it's currently stuck at GW1).
