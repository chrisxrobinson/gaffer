# Gaffer UI specification

**Status:** Draft 1 · **Date:** 2026-10-17 · **Phase:** 1.1 · **Decisions:** [ADR 0013](../decisions/0013-gaffer-terminal.md) (Gaffer Terminal), [ADR 0014](../decisions/0014-gaffer-app.md) (Gaffer App and its transport) · **Research:** [10 TUI, themes and branding](../research/10-tui-themes-branding.md), [11 structured agent UI](../research/11-structured-agent-ui.md)

Gaffer has two UIs over one agent and one session store:
- **UI 1, Gaffer Terminal:** today's browser terminal (ttyd → tmux → `pi`), rebranded. For people who like a prompt.
- **UI 2, Gaffer App:** a structured web app laid out like a desktop agent client: sessions on the left, a structured start instead of a blank prompt, a streaming run with collapsible steps, and the recommendation drawn from its JSON.

Both must feel like an FPL assistant with its own identity, not a coding agent with a football prompt.

**Mockups** (static, clickable, sample data, no build step):
- [`mockups/index.html`](mockups/index.html): the Gaffer App. Screens: Start, Run, Result, States, Scorecard, Preferences. The bar at the top switches visual direction (A or B), theme (system, light, dark) and screen. The recommendation is rendered by script from a sample `gaffer.recommendation/1` object, the way the real app will render it.
- [`mockups/terminal.html`](mockups/terminal.html): the Gaffer Terminal at 100 columns, dark and light palettes. Screens: start-up, the command list, a run streaming, the recommendation, a blocked command.

Contents: [1 Principles](#1-principles) · [2 Branding](#2-branding) · [3 Gaffer Terminal](#3-gaffer-terminal-ui-1) · [4 Gaffer App: information architecture](#4-gaffer-app-information-architecture) · [5 Screens](#5-screens) · [6 States](#6-states) · [7 Events to UI](#7-events-to-ui) · [8 What the agent must emit](#8-what-the-agent-must-emit) · [9 Accessibility and devices](#9-accessibility-and-devices)

---

## 1. Principles
- **The recommendation is the product.** Every screen leads to it or explains it. A transfer, the captain and the XI must be readable in two seconds on a phone.
- **Render data, never scrape text.** The App draws the recommendation, the snapshot and the steps from structured payloads (`gaffer.recommendation/1`, tool `details`, custom entries). Text from the model is shown as text, never parsed.
- **Show the work, folded.** Reasoning and tool steps stream visibly, then fold to one line each. Nothing that took time or cost money is hidden; nothing that isn't the answer stays open.
- **Say what is uncertain.** Confidence, derived free transfers, stale data and "not evaluated" scenarios are shown where the decision is, in words, not only as colour.
- **FPL's own units.** £m to one decimal, points and xP to one decimal, GW numbers, deadlines in the user's local time with UTC on hover, chip names as FPL names them. Tabular numerals everywhere digits line up.
- **No coding-agent furniture.** No file trees, diffs, cwd, model pickers, token counters in the main view. Cost appears as money against Gaffer's caps.

## 2. Branding
**Name and voice.** "Gaffer": the manager. The voice is a calm assistant manager: short, specific, numbers first, never hype. Errors say what happened and what to do next.

**Mark.** [`brand/gaffer-mark.svg`](brand/gaffer-mark.svg). The centre circle, open at the top right, is the G; the halfway line from the centre spot to the edge is its bar. It is built from pitch markings, so it needs no football clip-art. Two colours: the ring in ink, the line and spot in pitch green. One colour (`currentColor`) at 16 px.

**Wordmark.** "GAFFER" in Barlow Condensed 700, uppercase, tracking +6%. The ASCII wordmark ([`brand/wordmark.txt`](brand/wordmark.txt)) is the same idea in half-block characters, three rows, 40 columns, so it fits a 100-column terminal next to a three-line tagline:

```
 ▄▀▀▀▀     ▄▀▀▀ ▄▀▀▄ █▀▀▀ █▀▀▀ █▀▀▀ █▀▀▄
█  ●━━━    █ ▀█ █▀▀█ █▀▀  █▀▀  █▀▀  █▀▀▄
 ▀▄▄▄▄▀    ▀▄▄▀ ▀  ▀ ▀    ▀    ▀▀▀▀ ▀  ▀
```
The G's bar (`▀█`) runs from the middle to the right edge, like the mark's halfway line; in colour the `●━━━` is pitch green. It uses only box-drawing and block characters that xterm.js and every font Gaffer's terminal uses draw at one cell.

**Two directions.** Both are in the mockup; switch with the bar at the top.

| | A · Tactics board **(recommended)** | B · Scoreboard |
|---|---|---|
| Idea | The manager's whiteboard: white board, navy ink, magnets on a green pitch, the captain's armband | The stadium scoreboard: graphite, amber LED figures |
| Ground | Light: white. Dark: deep navy slate | Light: daylight grey. Dark: graphite near-black |
| Accent | Pitch green for the brand and gains; armband yellow for the captain only | Amber for every headline figure |
| Type | Barlow Condensed (display), IBM Plex Sans (body), IBM Plex Mono (figures) | Saira Condensed, Saira, Doto (dot-matrix headline figures) |
| Pitch | Green stripes, white counters with club codes, names on ink labels | Line drawing on graphite, amber outline chips |
| Phone | Strong in both modes | Dot-matrix figures get thin below 20 px; light mode is a compromise |

**Why A.** It reads at a glance in both light and dark, which the brief makes first-class; B is a dark-first look whose light mode is weaker and whose signature figures only work large. A maps cleanly onto a terminal palette (navy, green, yellow), so UI 1 and UI 2 share one identity. B's scoreboard figures are worth keeping as an idea for one place: the deadline countdown.

**Colour tokens.** [`brand/tokens.json`](brand/tokens.json) holds direction A's light and dark tokens and the xterm.js palette for the terminal. Semantic colours (good, warn, bad) are separate from the brand green, and every state that uses colour also uses a word or an icon. Ink on ground is at least 12:1 in both modes; green used for text is at least 4.5:1.

**Not used** (from the brief): purple or blue gradient heroes, cream or off-white grounds, emoji icons, italic accent words in headings, numbered "01 / 02 / 03" labels, glass cards, pill buttons everywhere, football clip-art.

## 3. Gaffer Terminal (UI 1)
The same Pi TUI, made Gaffer's by one more extension and settings, with no Pi patch (ADR 0013). Mockup: [`mockups/terminal.html`](mockups/terminal.html).

| Element | Today | Gaffer Terminal | Mechanism (research 10) |
|---|---|---|---|
| Start-up header | Pi logo, version, key hints, loaded resources | Gaffer mark and wordmark, tagline (season, model, "advice only"), two hint lines | `ctx.ui.setHeader()`; `quietStartup` |
| Footer | cwd `/work`, token and cache counters, model | Status strip: team, GW and live deadline countdown, FT (and whether derived), bank, today's spend vs cap, session spend | `ctx.ui.setFooter()`, refreshed on a 1 s timer and on `turn_end`/`tool_execution_end` |
| Theme | `gaffer` (dark only) | `gaffer` and `gaffer-light` with the brand tokens; the terminal palette passed to xterm.js so "follow the terminal" means Gaffer's palette | theme JSON + ttyd `-t theme=…` |
| Commands | Pi's built-ins plus Gaffer's | Gaffer's (`/team /prefs /gw /whatif /explain /export-rec /usage /scorecard`) plus `/new`, `/resume`, `/copy` and Gaffer's own `/help`; everything else hidden and refused | an allowlist in an autocomplete provider and a `CustomEditor` submit wrapper; supported settings and keybindings close the same actions (ADR 0013) |
| Tab title | "Gaffer" (ttyd) | "Gaffer · GW8 · 6d" and a working marker while a run is active | `ctx.ui.setTitle()` |
| Rendering | Gaffer's recommendation renderer; Pi's tool blocks | Unchanged content; brand colours; tool labels in Gaffer's words | `renderResult`, `registerToolRenderer` |

What must not get worse: summarized thinking in the transcript, each tool as a block, the recommendation at 100 columns (FR-OUT-02), scrolling (fullscreen), Shift+Enter, Ctrl+C, reconnect.

## 4. Gaffer App: information architecture
```
Gaffer App
├── Session rail (left; a drawer on phones)
│   ├── New session
│   ├── Search
│   └── Team (name, id) ──► GW ──► session (title, state dot, one meta line)
├── Status strip (top): team · GW deadline countdown · FT · bank · today's spend
└── Main pane
    ├── Start         team ID · GW (auto) · action picker · options · Go
    ├── Run           brief · thinking · steps (collapsible) · stop
    ├── Result        headline · summary · transfers · XI pitch + bench · captaincy · chips · 4-GW plan · warnings · ask · export
    ├── Scorecard     season to date: Gaffer vs you vs B0/B1
    └── Preferences   risk · chips to save · keep · avoid · max hits
```

**Sessions are grouped by team, then GW,** newest first, because that is how a manager thinks about them ("my GW8 plan"). A session's title is the action and its subject ("Recommend GW8", "What-if: keep Watkins"); renaming is a double-click (or long-press) on the title. Each row has a state dot (running, done, failed, idle) and one meta line: time and outcome ("scored 71, you 64" once GW is scored; "no recommendation" after three failed submissions; cost otherwise). A team's raw ID is shown to its owner; files and ledgers keep only its hash (NFR-PRIV-01).

**Sessions are shared with the terminal.** A session started in either UI appears in both, because both read the same session store (ADR 0014). A session open for writing in one UI is read-only in the other until released, and the App says so.

## 5. Screens
### 5.1 Start
- **Team ID:** digits only, checked against FPL as you type (the team's name appears, or "not found" within 10 s, FR-INP-01). Remembered on this device; the server keeps its hash.
- **GW:** detected from FPL (`is_next`), with the deadline in local time and the time left. Not editable: Gaffer only plans the next deadline.
- **Action picker:** six tiles. *Recommend this GW*, *What-if*, *Explain a pick*, *Chip planner*, *Scorecard*, *Preferences*.
- **Options for the chosen action:**
  - *Recommend:* risk (safe, balanced, aggressive), most hits this GW, chips to save, players to keep (from the squad), the free-transfer count (derived; editable, FR-INP-04) and transfers already made. "Save as my preferences" writes them through the same path as `set_preferences`.
  - *What-if:* a transfer (out from the squad, in by name, which GW), a chip in a GW, or keeping a player. Structured, so the run is a forced-move solve, not free text.
  - *Explain a pick:* a player, and whether to explain against the latest recommendation or the squad.
  - *Chip planner:* the chips left with their expiry, and the range of weeks.
  - *Scorecard*, *Preferences:* open their screens; no run, no model call.
- **Go** names the action ("Recommend GW8") and states the expected time and cost.

Each action becomes one prompt built by the App from a template (the same `/gw`, `/whatif`, `/explain` templates the terminal uses, plus a new chip-planner template), so both UIs exercise the same workflow and evals cover both.

### 5.2 Run
- **Brief:** the action and its options as the App sent them, as a card at the top.
- **Thinking:** summarized reasoning in muted text, streamed, folded to one line once the next step starts.
- **Steps:** one collapsible row per tool call, in Gaffer's words, with status, duration and a one-line summary taken from the tool's `details` (snapshot: freshness, players, bank, FT; plan: plans found, solver status, scenarios; check: valid, or the rule that failed). Expanded, a row shows the step's detail (the snapshot summary, the golden path's printed summary, the validation errors). Raw Python is available but folded twice.
- **Validation and retry** are steps like any other; a rejection shows the rule and that the model will retry ("attempt 1 of 3").
- **Stop** aborts the run (`abort`). The meta line shows elapsed time and cost so far.

### 5.3 Result
Rendered from `gaffer.recommendation/1`, in this order:
1. **Headline:** GW, team, deadline, data freshness, FT (derived or yours), bank after; expected points this GW, net xP over 4 GWs, overall confidence.
2. **Summary** (≤ 120 words, from the model).
3. **Transfers:** out → in with clubs, price and selling price, xP gain over 4 GWs, decayed 6-GW gain, confidence, rationale. A gain / hit cost / net ledger under the table.
4. **Starting XI on a pitch:** formation rows from forwards (top) to goalkeeper; counters with club code, name and this GW's xP (captain doubled); C and V marks; IN marks for new signings. **Bench** in auto-sub order with the goalkeeper first.
5. **Captaincy:** captain and vice with xP and P(start); team news applied (each `xmins_override` with its quoted source).
6. **Chips:** the advice and rationale, and one row per chip scenario: GW and Δ decayed xP, or why it wasn't evaluated. The first-half expiry date is always shown until GW19.
7. **4-GW plan:** a small bar chart of expected points per GW and a table: moves (or "roll"), chip, captain, FT available, xP.
8. **Check before the deadline:** warnings and the confidence drivers.
9. **Ask about this plan:** a follow-up box, 280 characters, with three suggested questions. It is for questions about this recommendation only; changing the team or preferences means a new run. (Why it exists: S6 and live use show that follow-ups are the normal pattern, and with ADR 0010 they cost about $0.003 each.)
10. **Footer:** rec id, model, `gaffer_lib` and Pi versions, attempts and the solver comparison; **Export JSON** (the stored entry, byte for byte), **Export CSV** (one row per transfer, captain, vice and plan GW), **Open in terminal**.

### 5.4 Scorecard and Preferences
- **Scorecard:** season totals (Gaffer's plan, your points, B0 hold) and a per-GW bar group including B1, from `outcomes.jsonl`; GWs waiting to be scored are listed with when they will be (FR-EVL-04).
- **Preferences:** the same fields as the Recommend options, saved per team; "Clear all".

## 6. States
Every state below is drawn in the mockup's **States** screen.

| State | Where | What the user sees |
|---|---|---|
| Empty | Main pane, no sessions | The mark, "No sessions yet", the next deadline, **Start** |
| Running | Rail dot and Run screen | Amber dot; brief; steps with a spinner on the live one; elapsed and cost |
| Streaming thinking | Run | Muted text growing, a cursor at the end; folds when the next step starts |
| Tool running | Run | The step row open, spinner, the requests it has made so far (snapshot) or the golden path's progress |
| Budget soft cap | Run, banner | "This run has cost $0.76. Gaffer has asked the model to wrap up." (FR-BUD-02) |
| Budget hard cap | Run, banner | "Run stopped at $1.52, over the $1.50 session cap. No plan was saved." (FR-BUD-01) |
| Daily cap reached | Start, banner; Go disabled | "Today's spend is $5.02 of $5.00. New runs can start after midnight UTC." |
| FPL updating / down | Run and Result, banner | Snapshot age, confidence capped at medium, and inside T−1h "won't finalise transfers on old data" (FR-DAT-05) |
| Odds source down | Result, info line | "Team strength from Dixon-Coles" (FR-DAT-09) |
| Deadline passed | Start and Result, banner | The plan now targets the next GW; the old one waits to be scored |
| Error: no valid plan | Run, banner | The last rule that failed; **Try again**, **View the run** (FR-REC-08) |
| Reconnecting | Any, banner | "The run continues on the server"; the transcript fills in from where it left off (FR-UI-03) |
| Open elsewhere | Run/Result, info line | "Also open in the browser terminal. Only one can send a prompt at a time." |

## 7. Events to UI
The App's agent side is `pi --mode rpc`, one process per open session, behind the `gaffer-web` bridge (ADR 0014). The bridge forwards Pi's events to the page over server-sent events with sequence ids, adds a few events of its own (marked *bridge*), and keeps the current run's events so a reconnect replays from where the page left off. The page builds its state with one reducer from these events, so it doesn't depend on the transport (ADR 0011's seam). Source: spike S7, research 11 §4.

| Source event (RPC unless marked) | Key fields | What the App shows |
|---|---|---|
| *bridge* session list (scan of `/sessions`) | session id, name, `gaffer.team` name, `gaffer.run` GW and action, last `gaffer.recommendation`, lock holder | Rail rows grouped team → GW: title, state dot, meta line; "open in the terminal" when the other UI holds the lock |
| *bridge* pre-run data (Gaffer's `src/`) | next GW and deadline (snapshot store), team name check, saved preferences, today's spend, scorecard rows | Start screen: GW box and countdown, team ✓, options pre-filled, cost line; Scorecard; Preferences |
| `prompt "/run {json}"` → response `handled` | — | Go pressed: form locks; the run view opens when `agent_start` arrives (not on the response) |
| `entry_appended gaffer.run` | action, team, GW, options | The brief card at the top of the run |
| `agent_start` | — | Run state *running*; elapsed timer; rail dot amber |
| `turn_start` | — | A new model-call group (folded) |
| `message_update` thinking start / delta / end | `contentIndex`, `delta` | Muted "Thinking" text growing in place; folded to one line when the next step starts; nothing when there is no thinking |
| `message_update` text start / delta / end | `delta` | Short narration between steps ("Fetching your team…") |
| `message_update` toolcall start / end | `toolName`, arguments | A step row in *pending*, labelled from the App's `toolName` → label table |
| `message_update.usage` | cumulative tokens and cost | Cost so far in the run's meta line |
| `tool_execution_start` | `toolCallId`, `toolName`, `args` | Step *running*: spinner and timer |
| `tool_execution_update` (bash) | cumulative output | The plan step's progress line from the golden path's stdout ("main solve 31 s of 43 s"); a folded live tail |
| `tool_execution_end` fpl_snapshot | `details: SnapshotDetails`, `durationMs` | Step done: "Fetched your team and FPL data · fresh · 15 players · bank £0.6m · 2 FT (derived)"; expanded, the snapshot card; stale banner if `stale` |
| `tool_execution_end` bash (golden path) | `details.step = "plan"` (Gaffer's tag), `structuredContent.exit_code`, `durationMs` | Step done: "Projected points and solved a 6-GW plan · 3 plans · chip scenarios 3 of 4"; failed on a non-zero exit |
| `tool_execution_end` read / write / edit / other bash | `args.path`, `isError` | Minor steps, folded under the model call ("Read playbook: gaffer-workflow") |
| `entry_appended gaffer.validation` (`passed: false`) | `attempt`, `stage`, `errors[]` | The check step fails with the rule's code and message, "attempt 1 of 3" |
| `tool_execution_end` submit_recommendation (`isError`) | text only | Step marked failed; the reason is taken from the validation entry above |
| `tool_execution_end` submit_recommendation `details.recommendation` | `gaffer.recommendation/1` | The Result screen (§5.3), drawn from this object only |
| `tool_execution_end` submit_recommendation `details.failed` | `attempts`, `errors` | "No recommendation" banner with the last rule (States: error) |
| `entry_appended gaffer.budget` | session and day cost, caps, `capped` | Status-strip spend meter; soft-cap and hard-cap banners |
| `message_start` custom `gaffer.steer` | content | Inline note: "Budget soft cap: Gaffer was asked to wrap up" |
| `extension_ui_request` notify | message, type | A toast; `error` also becomes a run banner |
| `extension_ui_request` setStatus / setTitle / string setWidget | key, text | Status chips; document title (Gaffer uses few) |
| `extension_ui_request` select / confirm / input | id, options | A modal; the bridge answers only ids it was asked (Gaffer uses none) |
| `queue_update` | steering, follow-up | Queued follow-up shown as pending under the box |
| `auto_retry_start` / `auto_retry_end` | attempt, delay, error | "Model busy, retrying in 2 s (1 of 3)" |
| `compaction_start` / `compaction_end` | reason | "Summarising earlier conversation…" (rare) |
| `extension_error` | extension, error | Error banner, details folded |
| `agent_settled` | `aborted` | Run *done* or *stopped*; input unlocks; a system notification if the tab is hidden |
| *bridge* `lock` | holder (terminal or App) | "Also open in the browser terminal. Only one can send a prompt at a time." |
| *bridge* `reconnecting` / replay | last sequence id | Reconnecting banner, then the transcript fills from the buffer; a "some output may be missing" marker if the buffer was lost |
| page → bridge: Go | action and options | `prompt "/run {json}"` |
| page → bridge: Ask | ≤ 280 characters, not starting with `/` or `!` | `prompt` (idle) or `steer` (running) |
| page → bridge: Stop | — | `abort` |
| page → bridge: Rename | ≤ 80 characters | `set_session_name` |
| page → bridge: open, new | session id | The bridge spawns `gaffer-pi --mode rpc --session <path>`; never `switch_session` |

The terminal (UI 1) needs no event table: it is Pi's TUI, and Gaffer's additions are the header, footer and command surface (§3).

## 8. What the agent must emit
Everything the Result needs is emitted today: the recommendation is the `submit_recommendation` tool's `details` and a `gaffer.recommendation` entry; validation, budget and snapshot state are custom entries. The App needs five small additions, all inside Gaffer's package (ADR 0014):

| Addition | Why the App needs it | Where |
|---|---|---|
| `/run {json}` command and a `gaffer.run` entry (action, team, GW, options) | The run's purpose as data: the brief card, the rail's grouping and titles | `gaffer-core` |
| Plan-step tag: a `tool_result` handler that adds `{step: "plan", plans, solver, scenarios}` to the golden-path `bash` result's `details` | A one-line plan summary without parsing stdout | `gaffer-sandbox` or `gaffer-recommend` |
| Golden-path progress lines on stdout | Progress during the longest step (up to 50 s) | `gaffer_lib run` |
| Session lock and run lock | One writer per session; one run at a time while the local sandbox is shared | `gaffer-core` |
| Read-only bridge API over Gaffer's `src/` (snapshot store, FPL team check, preferences, usage, outcomes, session scan) | The Start, Scorecard and Preferences screens and the rail, with no model call | `gaffer-web` |

Not needed: a tool label on the wire (the App keeps its own label table), `display: "updates"` thinking (Pi doesn't request it; summarized thinking is shown), or any change to Pi.

## 9. Accessibility and devices
- Keyboard: every control reachable in order; visible focus; Esc stops a run (same as the terminal); `/` focuses the follow-up box on the Result.
- Screen readers: the pitch has a text equivalent (the XI as a list by position); steps are `details`/`summary`; status banners use `role="status"` or `alert` by severity.
- Colour is never the only signal: confidence and step state carry words or icons.
- Phone (375 px): the rail becomes a drawer, the status strip wraps to two lines, the pitch keeps four rows with smaller counters, tables scroll inside their cards, and the page never scrolls sideways.
- Reduced motion: no spinner rotation, no streamed replay animation.
