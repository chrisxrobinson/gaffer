# 11 — A structured agent UI for Gaffer ("UI 2: Gaffer App")

Research date: 2026-10-17. Draft by R11 for the Phase 1.1 lead.

**Versions read:**
- Pi `@earendil-works/pi-coding-agent` **1.3.0** (tag `v1.3.0`, commit `71023aec`, 2026-10-15), compared with Gaffer's pin **0.87.1** (`f07218c4`).
- `pi-durable` 1.3.0 (same tag).
- `earendil-works/pi-durable-cloudflare` at `dcb56ce` (2026-10-15).
- AG-UI 1.0 (`@ag-ui/core` 1.0.3, 2026-10-16), A2UI v0.9.1 / v1.0 RC, MCP Apps spec `2026-01-26` (`@modelcontextprotocol/ext-apps` 2.0.3).

Path conventions: `docs/X.md` and `src/…` mean `packages/coding-agent/…` at `v1.3.0` unless marked otherwise. "S7" is the spike in `spikes/s7-rpc-events/` (README, `events.jsonl`, `summary.json`).

---

## TL;DR

| Question | Answer | Evidence |
|---|---|---|
| Can UI 2 be rendered from structured data, without scraping text? | **Yes.** Everything it needs is already on the RPC wire or in Gaffer's custom entries. | S7: `tool_execution_end.result.details.recommendation`, `fpl_snapshot` `details`, `entry_appended` for `gaffer.validation`, `gaffer.budget`, `gaffer.recommendation` |
| Transport, agent side | **`pi --mode rpc`, one process per open session**, spawned by a small Gaffer bridge. Not the in-process SDK. Not pi-durable. | §2, §5 |
| Transport, browser side | **SSE for events + `fetch` POST for commands**, with a small Gaffer-specific protocol (not raw RPC, not AG-UI). | §5.2 |
| Frontend stack | **No build step.** Static ES modules, **Preact 10.29.8 + htm 3.1.1** vendored (2 packages, no transitive dependencies), CSS from the mockup's tokens, self-hosted fonts. | §5.3 |
| New npm dependencies | **2** (browser). The bridge uses only `node:` built-ins and the Pi package already in the harness. | §5.3 |
| Open protocols (AG-UI, A2UI, MCP Apps) | **Don't adopt for UI 2.** Gaffer's schema is fixed, so generative UI adds nothing. Shape the bridge's events like AG-UI so an adapter stays cheap. | §2.5 |
| Shell path into the harness | **None.** There is no PTY in UI 2. The browser can only send Gaffer commands, and the bridge maps them onto an 8-command RPC allowlist. Sessions are resolved by id on the server, and Pi is spawned with `--session <path>` (never `switch_session`). `/…` and `!…` text is refused. `user_bash` stays blocked. | §5.4; S7 "Dangerous commands" |
| Biggest new risk | **Two Pi processes on one session file.** Pi does not lock session files. The TUI (`--continue`) and UI 2 sharing `/sessions` need a Gaffer-level per-session lock. | §5.6 |
| Reasoning display | It is secondary. Show a one-line, muted, collapsed summary per model call **only when one exists** (about a third of calls, ~200 characters). Progress comes from tool steps, never from thinking. | §6 |

---

## 1. What UI 2 has to show

The brief's layout follows the Claude desktop Code tab:
- **Session sidebar:** grouped by team and GW; new, resume and rename.
- **Structured start:** a team ID field, the GW detected automatically, an action picker (Recommend / What-if / Explain a pick / Chip planner / Scorecard / Preferences), and per-action options (risk, chips to save, players to keep).
- **Streaming run:** short reasoning, plus collapsible tool steps (snapshot, sandbox run, validation and retry).
- **Result, rendered from `gaffer.recommendation/1`:**
  - the transfers table, captain and vice, and the XI on a pitch with bench order;
  - chip advice, the 4-GW plan, confidence and rationale;
  - JSON and CSV export;
  - a constrained follow-up box.

Phase 1.1 is local and single-user. Phase 3 (multi-user, ADR 0005 option B) must stay reachable. The lead prefers one backend and one session store for both UIs.

A typical run is 4–5 model calls in a p50 of 75 s. That is short. Most of the time goes to the sandbox golden path (the `bash` step), and the user's real question is "what should I do". The design should spend its effort on the result and on a clear 4-step progress line, not on a rich trace explorer.

---

## 2. Transports

### 2.1 Pi RPC mode at 1.3.0

**Shape.** JSONL over stdio with strict LF framing (`docs/rpc.md`). There are four record families: stdin commands (optional `id`), stdout `response`, stdout session events, and the bidirectional extension-UI subprotocol. `RpcClient` is exported (`src/index.ts:424`).

**Commands (33; the same set as 0.87.1).** Grouped by what they can reach (`src/modes/rpc/rpc-types.ts:20-74`, `rpc-mode.ts:394-716`):

| Reach | Commands | Bridge |
|---|---|---|
| **Host shell** | `bash` (goes through `user_bash` handlers, `rpc-mode.ts:561-584`), `abort_bash` | Reject |
| **Arbitrary file write** | `export_html {outputPath}` (S7 wrote 330 KB to a chosen path). `switch_session {nonexistent path}` (S7: the next run created the file). | Reject |
| **Other sessions or files** | `switch_session` loads any valid session JSONL from any path. Its header `cwd` becomes the runtime cwd (`src/core/agent-session-runtime.ts:203-215`, `session-manager.ts:1766-1786`). S7 injected history from a crafted file. `new_session {parentSession}` records any string. `fork`/`clone` create files. | Reject (resolve sessions in the bridge; spawn instead) |
| **Spend / model** | `prompt`, `steer`, `follow_up`, `compact`, `set_model`, `cycle_model`, `set_thinking_level`, `cycle_thinking_level` | `prompt` and `steer` constrained; the rest rejected |
| **Behaviour settings** | `set_steering_mode`, `set_follow_up_mode`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `clear_queue` | Reject |
| **Read-only** | `get_state`, `get_messages`, `get_entries {since}`, `get_session_stats`, `get_tree`, `get_fork_messages`, `get_last_assistant_text`, `get_available_models`, `get_available_thinking_levels`, `get_commands` (exposes extension source paths) | Allow the first four |
| **Session metadata** | `set_session_name` | Allow (rename), length-capped |
| **Extension commands** | Any `prompt` starting with `/` that matches a registered command runs it immediately, even mid-run (`src/core/agent-session.ts:2065-2073`). Built-in TUI commands (`/export`, `/share`, `/login`) and `!cmd` are **not** handled over RPC; they reach the model as text (S7). | Only the bridge-generated `/run {json}` |

**Events** (`docs/json.md`, shared with JSON mode):
- **Run:** `agent_start`, `turn_start`, `turn_end`, `agent_end`, `agent_settled {aborted}`.
- **Messages:** `message_start`/`message_end` for every role (`system`, `user`, `assistant`, `toolResult`, `custom`).
- **Streaming:** `message_update {usage, assistantMessageEvent}` with `text_*`, `thinking_*` and `toolcall_*` start/delta/end. These are delta-only on the wire.
- **Tools:** `tool_execution_start/update/end {durationMs}`.
- **Other:** `queue_update`, `entry_appended` (from `pi.appendEntry`), `session_info_changed`, `thinking_level_changed`, `compaction_*`, `auto_retry_*`, `summarization_retry_*`. RPC-only: `bash_execution_update` and `extension_error`.

**Thinking** streams as `thinking_start` / `thinking_delta` / `thinking_end {content}`, exactly like text (S7: 104 deltas). Pi's Anthropic adapter only asks for `display: "summarized"` (the default) or `"omitted"` (`packages/ai/src/api/anthropic-messages.ts:192,1287,1294`). A redacted block arrives as the text `[Reasoning redacted]` with `redacted: true` (`:749-754`). The lead reports live Gaffer sessions carry summaries of about 200 characters on about a third of calls (§6).

**Extension UI over RPC** (`docs/rpc-extension-ui.md`; `rpc-mode.ts:136-311`; S7):

| `ctx.ui` call | Over RPC |
|---|---|
| `notify(msg, type)` | `extension_ui_request {method:"notify", message, notifyType}`, fire-and-forget |
| `setStatus(key, text)` | `{method:"setStatus", statusKey, statusText}` |
| `setWidget(key, string[])` | `{method:"setWidget", widgetKey, widgetLines, widgetPlacement}` |
| `setWidget(key, factory)` | **Dropped silently** (`rpc-mode.ts:195-208`; S7: no record) |
| `setTitle` / `setEditorText` | Forwarded |
| `select` / `confirm` / `input` / `editor` | Request, then a matching `extension_ui_response`; the `timeout` is honoured agent-side |
| `custom()` | Returns `undefined` (S7) |
| `setFooter`, `setHeader`, `setWorkingMessage`, themes | No-ops |
| Tool `renderResult` / `renderCall` | Never used over RPC. They do feed `export_html` (`agent-session.ts:4318-4329`). |

`ctx.mode === "rpc"` and `ctx.hasUI === true`. `session_start` re-runs after each session switch, so status and title calls repeat.

**Reconnect.** These commands return committed state only (S7):
- `get_state`: `isStreaming`, `sessionId`, `sessionFile`, `sessionName`, counts.
- `get_messages`: the active branch's messages with `details`.
- `get_entries {since}`: all entries, **including Gaffer's custom entries**, with a durable id cursor.
- `get_session_stats`: tokens, cost, context.

Nothing returns the in-flight partial message or a running tool's partial output. Mid-run reattach therefore needs a bridge-side event buffer. If the process dies, respawn with `--session <path>` (or `--session-id`) and rebuild from `get_entries`.

**0.87.1 → 1.3.0 on the wire** (CHANGELOG; diff of `rpc-types.ts`/`rpc-mode.ts`). All changes are additive. The command set is unchanged.

| Version | Change |
|---|---|
| 0.99.0 | `data.disposition` (`started`/`queued`/`handled`) on `prompt`/`steer`/`follow_up` responses (CHANGELOG:394) |
| 0.99.0 | `outputSchema` + `structuredContent`. Built-in `bash` now returns `structuredContent {output, truncated, exit_code, wall_time_seconds}` (S7). |
| 0.99.0 | Built-in extensions `codemode`, `tool_search`, `mcp`, `llama` load by default in the CLI. Over RPC, `get_commands` lists `/mcp` and `/llama` (S7 phase C). Gaffer's launcher (`harness/gaffer-pi`) does not pass `--no-extensions`, so on 1.3.0 it must disable them (`-builtin:<name>` in `extensions`, `docs/sdk.md:112`). |
| 1.1.0 | `tool_execution_end.durationMs`, `agent_settled.aborted` (CHANGELOG:125,130) |
| 1.2.0 | The experimental `pi-server`/`pi-client`/`pi-protocol` stack was removed and is no longer released (CHANGELOG:109). ADR 0005's "watch list" item is gone. |

### 2.2 Pi SDK in-process behind an HTTP server

`createAgentSession()` plus `session.subscribe()` delivers the same events, with **cumulative** partials (`docs/sdk.md`). `AgentSessionRuntime` adds `newSession`/`switchSession`/`fork`, but subscriptions must be rebound after each replacement.

Gaffer's tests already host it this way (`packages/pi-gaffer/test/harness.ts`): `DefaultResourceLoader` with inline factories, `noExtensions`, and `bindExtensions` with a hand-made UI context.

| For | Against |
|---|---|
| One process; no JSONL; direct access to `SessionManager` (session lists, entries) | The bridge must re-create the CLI's configuration in code (flags, loader, tools) apart from `harness/gaffer-pi`, so there are two configurations to keep equal |
| Cumulative partials make mid-run reattach easy | Gaffer's extensions assume one session per process: module-level `sharedSandboxSession()` and env-driven `config.ts`. Several sessions in the bridge process would share them. |
| — | No crash isolation. Gaffer notes "an exception in a renderer ends the Pi process" (`extensions/gaffer-recommend/index.ts`). In-process, that takes the bridge and every session down. |
| — | It does not lead to Phase 3: ADR 0005 already wants process-per-session for tenancy |

**Verdict:** use RPC. The SDK stays the right tool for tests and evals.

### 2.3 pi-durable `watch()` / `watchEvents()` (UI transport only; R8 covers durable)

From `packages/durable/README.md` "Watching a Conversation" and "Agent Events (Experimental)", and `test/examples/05-watches.ts` and `21-late-join.ts` @v1.3.0:
- Every UI-visible thing is committed before it is shown. `viewState()`/`watch()` give the view plus Chord ops per commit.
- `watchEvents()` gives a `snapshot` (entries, run, in-flight generation, tools, compactions, inbox, usage) followed by coding-agent-style delta events.
- Late joiners get the current state, with no replay. A consumer more than 100 batches behind gets a fresh snapshot. Partials are committed every 100 ms by default.

These are exactly the reconnect semantics a browser wants. But durable is a **different harness**. Gaffer's `pi.registerTool`/`pi.on` extensions would have to be ported to durable's `defineExtension`/`defineTool`. The README says "Experimental. The API changes without notice between releases."

For a 75 s run, a per-run event buffer in the bridge gives the same "snapshot then deltas" property at almost no cost. **Not adopted as a UI transport.** Revisit only if R8 recommends durable for other reasons.

### 2.4 The removed pi-server / pi-client / pi-protocol

They were removed in 1.2.0 (CHANGELOG:109) and stopped at 1.1.0 on npm. ADR 0005 and research 05 C3 should drop them.

### 2.5 Open agent→UI protocols

| | AG-UI | A2UI | MCP Apps | AI SDK UI message stream |
|---|---|---|---|---|
| What it is | An event protocol from agent to app: run/step lifecycle, text, tool calls, reasoning, state snapshots/deltas (JSON Patch), activity, subagents, custom/raw | Agent-generated **declarative UI** (JSON components from a client-side catalog) | MCP servers return **interactive HTML** (`ui://` resources) that hosts render in sandboxed iframes, talking JSON-RPC over `postMessage` | Vercel `ai` package's SSE stream of typed parts (text, reasoning, tool, `data-*`) |
| Maturity (2026-10-17) | Spec **1.0**. `@ag-ui/core` 1.0.0 was published 2026-09-17; 1.0.3 on 2026-10-16. Repo: 16.6k stars, daily releases (`release/2026-10-17`). Several sections still Draft. | **v0.9.1** in production, **v1.0 release candidate**, README banner "Early stage public preview". `@a2ui/lit` 0.14.0 (2026-10-17). | Spec **`2026-01-26` Stable** (`specification/2026-01-26`, plus a `draft`). `ext-apps` 2.0.0 (2026-09-08), 2.0.3 (2026-09-25). Hosts: Claude, Claude Desktop, VS Code Copilot, M365 Copilot, Goose and others. | Versioned header `x-vercel-ai-ui-message-stream: v1` |
| Dependency weight | `@ag-ui/client` 1.0.3 adds **14 packages** (rxjs, zod, protobuf, uuid…, npm dry run). Or implement the spec directly. | `@a2ui/lit` pulls lit, zod, signals, `@a2ui/web_core` | `ext-apps` (1 dependency) or `@mcp-ui/client` (React) | `ai` plus a React or Vue binding |
| Fit for Gaffer's fixed schema | It would carry Gaffer's data as `CUSTOM` or `ACTIVITY_*` events: a wrapper, not a renderer. Its run model is POST-then-stream. A broken stream is a "truncated run", and reattaching to an in-flight run is out of scope (`spec/1.0/basic/transports`). | **Poor.** It exists for UI the agent invents. Gaffer's UI is fixed, and asking the model to emit UI JSON adds tokens and failure modes after a validated result. | **The wrong direction for UI 2.** It is the way to put a Gaffer view *inside* someone else's MCP host. It is interesting later for distribution, not for this app. | Ties the client to `ai`'s hooks |
| Auth / multi-user | None by design: "Authentication and authorization are properties of the binding and the application" | Leaves trust to the client catalog ("trust ladders") | The host sandbox and host-controlled capabilities | Left to the app |

**Verdict:** adopt none for UI 2. Gaffer does not need agent-generated UI, and none of these protocols handles mid-run reconnect better than a bridge buffer. Name the bridge's events after AG-UI's families (`run.*`, `step.*`, `text.*`, `reasoning.*`, `tool.*`, `activity`, `custom`) so an AG-UI endpoint could be added later as a mechanical adapter, if a third-party client ever needs one. I found no newer agent→UI standard from Aug–Oct 2026 beyond AG-UI 1.0 and A2UI 0.9/1.0 RC (see Unconfirmed).

---

## 3. Reference UIs and research

### 3.1 Claude desktop app, Code tab

Source: `code.claude.com/docs/en/desktop`, fetched 2026-10-17 (undated; it cites Desktop v1.2581.0+ for panes). These are interaction patterns worth copying.

- **Sessions in a sidebar.** Each session is independent.
  - Filter by status, project or environment, and group by project.
  - Rename by clicking the title.
  - Archive from the row.
  - Cmd/Ctrl-click opens a second session side by side.
  - New session with Cmd+N; cycle with Ctrl+Tab.
- **Structured start.** Before the first message the prompt area sets environment, folder, model and permission mode. This is the same idea as Gaffer's team / action / options form.
- **Transcript view modes.**
  - **Normal**: "tool calls collapsed into summaries", full text.
  - **Thinking**: Normal plus thinking. It "appears in the menu only after Claude has produced thinking".
  - **Verbose**: every step.
- **Steering.** The stop button interrupts. A correction typed mid-run is read "as soon as the current action completes", which is a steer.
- **Completion notification.** There is an OS notification when a session finishes and you are not viewing it.
- **Side chat (`/btw`).** It reads the main thread but adds nothing back. This is a model for "Explain a pick" that should not pollute the plan session.
- **Reconnect.** After a disconnect the session shows "Loading recent output…" from a 16 MiB buffer and flags any gap ("Some output produced while you were disconnected may be missing here").
- **One writer per conversation.** The docs warn against running a second process on a live conversation, because both write to it. This is directly relevant to §5.6.

### 3.2 pi-durable-cloudflare React client

Cloned at `dcb56ce`, 2026-10-15.

- **Size.** The client is 2,156 lines of TS/TSX plus 483 CSS, plus a 480-line shared `protocol.ts`. Runtime dependencies are `@earendil-works/{chord,pi-ai,pi-durable}` 1.2.0, `partysocket` 1.3.0 and `react`/`react-dom` 19. The lockfile has 343 packages, with Vite, Wrangler and Vitest.
- **Protocol.** An **app-specific protocol**: 5 client commands (`presence.typing`, `conversation.open/create/fork`, `prompt.submit`) and 8 server event types (`session.snapshot`, `conversation.events`, `conversation.inbox`, `command.result`…).
  - Both directions are validated (`parseServerEventEnvelope`).
  - There are size caps (`MAX_PROMPT_CHARACTERS` 100,000).
  - Close codes 1002 and 1009 are terminal.
  - It does **not** forward the harness's own API to the browser. This is the pattern Gaffer should copy.
- **Reconnect.**
  - `PartySocket` reconnects automatically.
  - The server sends `session.snapshot` on connect, and the client re-opens its conversation.
  - A `CommandOutbox` keeps mutating commands, keyed by client `requestId`, until acknowledged, and replays them after reconnect (`src/client/usePiSession.ts`, `command-outbox.ts`).
  - The server attaches with `watchEvents()` and sends its `snapshot` first (`src/session.ts:502-535`).
- **Rendering.**
  - Tool calls are generic cards with a status (`waiting`/`running`/`completed`/`failed`/`missing`).
  - Arguments, details and nested calls are behind `<details>`, as raw JSON (`Transcript.tsx:120-176`).
  - **Thinking is accumulated but never shown**: `assistantText` keeps text blocks only (`session-state.ts:657-666`).
  - An Activity side panel draws the task graph.
- **No auth.** It "intentionally has no authentication or rate limiting" (README).

### 3.3 AgentGUI (arXiv 2607.26300) and related HCI work

AgentGUI is by Zhao, Sohn, Zheng and Moor (v1 2026-07-28, v2 2026-08-04). It is a local web GUI (FastAPI + React over WebSockets, a Docker sandbox per "desk") for observing and steering several long-running agents (Hermes; experimental Claude Agent SDK).

- **Per-session tabs.** An activity feed separates **reasoning, generation, and tool requests/responses** with distinct visual cues. There is a wall-clock **timeline** of time per task, a console with token telemetry and a code-execution-only terminal view, and file previews.
- **Steering.** A user message interrupts the current turn. Edits to the task definition apply after the turn. An "automated drift prevention" manager audits the transcript against verifiable criteria and resumes the agent with an audit report.
- **Results.** In a within-subject study (N=8) against the Hermes dashboard, participants answered trace questions 38% faster (≈90 s vs 145 s, p=0.023) with higher accuracy (80%→93%) and lower workload. One audit raised task completion for 0.8B–9B models by up to 34 points (50 runs per size).
- **Limitations.** It is aimed at long, multi-agent runs. The study is small. It states no formal design guidelines.

Related work, 2026:
- Grunde-McLaughlin et al., "Overseeing Agents Without Constant Oversight" (arXiv 2602.16844, 2026-02-18). Plain action logs are cumbersome. A better interface cut the time to find errors and raised confidence, but **not accuracy**. The core difficulty is enough detail without overload.
- Chen et al., "Comparing Human Oversight Strategies for Computer-Use Agents" (arXiv 2604.04918, v2 2026-09-12; N=48). Users intervened too early or too late. Planning up front limited unplanned actions but missed unlisted safeguards. The authors' conclusion: match authority, timing and attention to the decisions that matter, rather than give more control.

**What applies to a 75-second, 5-call FPL run:**
1. **Separate the streams visually**, as AgentGUI does: narration text, reasoning (muted), tool steps (cards), result (primary).
2. **A timeline beats a log.** One bar of the run's steps with durations answers "where did the 75 s go". `durationMs` is on every `tool_execution_end`.
3. **Summary by default, detail on demand** (Code tab modes; Grunde-McLaughlin). Two modes are enough: *Summary* (steps + result) and *Details* (reasoning lines, tool arguments, output tails).
4. **Verification evidence over traces.** For Gaffer the evidence is already structured: `validation {passed, recomputed, numbers_checked, max_model_number_drift, gap_to_best, attempts}`. Show it as a badge on the result. That does more for trust than any trace.
5. **Oversight goes at the start, not mid-run** (Chen et al.). The structured start form *is* the plan. A 75 s run gives little room for well-timed steering. Offer **Stop** and a **queued follow-up**; allow a steer, but don't lead with it.
6. **Notify on completion** when the tab is hidden (Code tab): 75 s is long enough to switch away.
7. **Reconnect shows current state first**, then deltas, and says when something may be missing.
8. AgentGUI's drift-prevention auditor has a Gaffer analogue already: the `submit_recommendation` gate. No second LLM is needed.

---

## 4. Spike S7 and the draft event → UI mapping

S7 (`spikes/s7-rpc-events/README.md`) ran Pi 1.3.0 RPC with a faux model and a Gaffer-shaped stub, recording 643 records. Its key results:
- Thinking, text and tool-call deltas stream as typed events.
- `fpl_snapshot` `details` and `submit_recommendation` `details.recommendation` arrive whole in `tool_execution_end`.
- `pi.appendEntry` arrives as `entry_appended` in order.
- `notify`, `setStatus`, `setTitle` and string `setWidget` are forwarded; component widgets and `custom()` are not.
- A `/run {json}` extension command can append a structured record and start the run (verified).
- `steer` gives `queue_update` and is delivered after the tool round. `abort` gives `agent_settled {aborted: true}`.
- `bash` is blocked by Gaffer's existing `user_bash` handler. Without it, it ran a host shell.
- `export_html` and `switch_session` wrote and read arbitrary paths.

**Draft mapping** (B = bridge event to the browser; *gap* = needs a Gaffer change, §5.5):

| Source (RPC event / command) | Key fields | UI 2 shows | Notes |
|---|---|---|---|
| *(bridge)* scan of `/sessions` | header id, `session_info` name, `gaffer.team.team_name`, `gaffer.run`/`gaffer.snapshot` GW, last `gaffer.recommendation` | Sidebar rows grouped team → GW: name, GW, "validated rec" badge, updated time, live dot | Reuse `src/session.ts`/`usage.ts` scanners. Pi has no list command. |
| *(bridge)* read-only Gaffer libs | `store.ts` cache (GW, deadline), `prefs.ts`, `usage.ts` (`dayTotals`), `outcomes.ts` (`scorecard`) | Start screen: detected GW and deadline countdown, saved prefs, today's spend left; the Scorecard view | No model call. `/prefs`, `/usage` and `/scorecard` only `notify` strings today. |
| `prompt "/run {json}"` → `response {disposition:"handled"}` | — | Start form submitted; input locked | Bridge-generated only. Wait for `agent_start`. |
| `entry_appended gaffer.run` | action, team hash, GW, options | Run header card: "Recommend · GW10 · S7 XI · balanced, save WC" | *gap*: new in gaffer-core (S7 stub proves the mechanism) |
| `agent_start` | — | Run state "running", elapsed timer, 4-step progress line (Data → Model & solver → Submit → Validated) | |
| `turn_start` | — | New "model call n" row under the run (collapsed) | n ≈ 4–5 |
| `message_update thinking_start/delta/end` | `contentIndex`, `delta`, `content` | A muted one-line reasoning summary in the current call row; full text on expand. Nothing at all when absent. | §6 |
| `message_update text_start/delta/end` | `delta`, `content` | Short narration in the call row ("Fetching your team…") | Not the result |
| `message_update toolcall_start` / `toolcall_end` | `id`, `toolName` / full `toolCall` | A tool step card in state "pending" with its label; arguments become available | Labels from a static table (`label` is not on the wire). Ignore `toolcall_delta`. |
| `message_update.usage` | cumulative tokens, cost | Footer: tokens and $ for this run | |
| `tool_execution_start` | `toolCallId`, `toolName`, `args` | Step → "running", spinner, timer | |
| `tool_execution_update fpl_snapshot` | `partialResult.details.stage` | Sub-label ("fixtures… odds… derive") | *gap*: real `fpl_snapshot` sends no `onUpdate` (optional) |
| `tool_execution_update bash` | cumulative output (≤50 KB, 100 ms) | Collapsible live tail (last ~20 lines) | Bridge trims to a tail |
| `tool_execution_end fpl_snapshot` | `result.details: SnapshotDetails` | **Snapshot card**: team, GW, deadline countdown, bank, FT (with source), chips, odds coverage, stale banner, warnings; step done with `durationMs` | Already emitted |
| `tool_execution_end bash` | `durationMs`, `isError`, `structuredContent.exit_code` (≥0.99.0) | Step done or failed; labelled "Model & solver" when `args.command` matches the snapshot's `details.run_command` | *gap* (small): an explicit step tag is more robust (§5.5) |
| `tool_execution_end read/write/edit` | `args.path` | Folded minor steps ("read plan.json") | Details mode only |
| `tool_execution_start submit_recommendation` | — | Progress → "Submit"; step "validating…" | |
| `entry_appended gaffer.validation {passed:false}` | `attempt`, `stage`, `errors[{code,message}]` | "Validation failed (1 of 3): BENCH — …"; retry badge on the step | Already emitted (both execute and schema stages) |
| `tool_execution_end submit_recommendation {isError:true}` | text only, `details: {}` | Step marked failed; the reason comes from the validation entry above | |
| `entry_appended gaffer.validation {passed:true}`, `gaffer.recommendation` | `rec_id` / full rec | Progress → "Validated" | |
| `tool_execution_end submit_recommendation` `details.recommendation` | `gaffer.recommendation/1` | **Result view**: transfers table (out/in, prices, xP gain, rationale, confidence), hits; captain/vice; XI on a pitch with bench order; chip advice with scenarios; 4-GW plan; summary; confidence and drivers; warnings; validation badge; JSON/CSV export (client-side) | Already emitted; the same object as the entry |
| `tool_execution_end submit_recommendation` `details.failed` | `attempts`, `errors` | Failure card: "No valid plan after 3 attempts", errors, no plan | Already emitted |
| `entry_appended gaffer.budget` | `session_cost`, `day_cost`, `soft`/`hard`/`daily`, `turn`/`max_turns`, `capped` | Budget meter; a cap banner when `capped` | Already emitted per turn |
| `message_start role:"custom" customType:"gaffer.steer"` | content | An inline system note: "Budget soft cap: Gaffer was asked to wrap up" | |
| `extension_ui_request notify` | `message`, `notifyType` | Toast. `error` also becomes a run banner (budget stop, give-up). | |
| `extension_ui_request setStatus` / `setWidget` (lines) / `setTitle` | key, text/lines | Footer status chips; small side panel; `document.title` | Gaffer uses few today |
| `extension_ui_request select/confirm/input/editor` | `id`, title, options, timeout | Modal. The bridge answers only pending ids. | Gaffer uses none |
| `queue_update` | `steering[]`, `followUp[]` | Queued-message chips under the input | |
| `auto_retry_start/end` | `attempt`, `delayMs`, `errorMessage` | "Provider busy, retrying in 2 s (1 of 3)" | |
| `compaction_start/end` | `reason` | "Summarising earlier conversation…" | Rare at Gaffer's sizes |
| `extension_error` | `extensionPath`, `event`, `error` | Error banner; details collapsed | |
| `agent_end` | `willRetry` | — (drop its `messages` payload) | Duplicate data |
| `agent_settled` | `aborted` | Run "done" or "stopped"; input unlocked; OS notification if the tab is hidden | |
| `response {success:false}` | `error` | Inline error under the input | |
| Reconnect: `get_state` + `get_entries` (+ the bridge's run buffer) | — | Rebuild the sidebar row, run card, steps and result; mark a gap if the buffer was lost | |
| UI → `steer` | text (no leading `/`) | The follow-up box while running ("Tell Gaffer now") | Secondary to Stop |
| UI → `prompt` (idle) | text (no leading `/` or `!`) or `/run {"action":"explain",…}` | The constrained follow-up box | |
| UI → `abort` | — | Stop button | |
| UI → `set_session_name` | ≤80 chars | Rename in the sidebar | |
| UI → new or resume | — | Bridge spawns `pi --mode rpc --session <resolved path>` (or a fresh session) | Never `switch_session` |

---

## 5. Recommendation

### 5.1 Agent side: Pi RPC, one process per open session

A `gaffer-web` bridge (Node, `node:` built-ins only) runs in the harness container. It is spawned like ttyd and binds the same way (the egress-interface IP, published on host `127.0.0.1`). For each session the user opens, it spawns the same launcher the TUI uses, in RPC mode. Concretely, `harness/gaffer-pi` gains a mode switch: identical `--session-dir /sessions --no-context-files --tools …` flags, `--mode rpc` instead of `--tui-mode fullscreen`, `--session <path>` instead of `--continue`.

Why:
- **One configuration for both UIs.**
- **Process isolation** (a renderer crash, sandbox session singletons).
- **The Phase 3 shape already**: ADR 0005 B, with `--session-dir /sessions/<tenant>`.
- **A documented, stable wire**: additive changes only from 0.87.1 to 1.3.0.

Use the exported `RpcClient` (typed, strict LF framing, zero new dependencies). S7's 60-line raw JSONL reader is the fallback.

The first record appeared about 0.3 s after spawn (S7, stub extensions). Kill idle processes about 10 minutes after `agent_settled`.

### 5.2 Browser side: SSE + POST, a Gaffer-specific protocol

- **Events:** `GET /api/sessions/:id/events` returns `text/event-stream`. Each record has `id: <seq>`.
  - The bridge keeps a ring buffer for the current run (S7: ≈460 KB for 8 runs, unreduced).
  - On reconnect with `Last-Event-ID` it replays the missing records. Without it, it sends a `snapshot` built from `get_state` + `get_entries`, then the run buffer.
  - It sends a keep-alive comment every 15 s (for ALB idle timeouts in Phases 2–3).
- **Commands:** `POST /api/sessions/:id/commands` with one of `run`, `follow_up`, `steer`, `stop`, `rename`. `POST /api/sessions` creates a session. Each mutating command carries a client `requestId` so a retry after reconnect is idempotent (the pi-durable-cloudflare outbox pattern).
- **Reads:** `GET /api/sessions`, `/api/gw`, `/api/prefs`, `/api/scorecard`, `/api/usage` use Gaffer's own `src/` modules read-only.
- **Reduction:** the bridge drops `system` messages, `agent_end.messages` and `turn_end.toolResults` duplicates, and trims `bash` partials to a tail. It forwards `message_update` deltas, tool events, `entry_appended` for `gaffer.*`, extension-UI fire-and-forget records, `queue_update` and `agent_settled`.

**Why SSE over WebSocket:**
- Browsers have `EventSource` with automatic reconnect and `Last-Event-ID`.
- Node needs no library to serve it. Node has a WebSocket *client* but no server, so WebSocket would mean `ws` or hand-rolled upgrades.
- Commands are rare (start, steer, stop), so full duplex buys nothing.

### 5.3 Frontend stack: no build, two vendored packages

| Option | Packages | Build step | Notes |
|---|---|---|---|
| **Preact 10.29.8 + htm 3.1.1** (recommended) | **2** (npm dry run, 2026-10-17) | None. Vendor the two ESM files into `web/vendor/`. | Escapes text by default; keyed diffing for a streaming transcript; ~10 KB |
| Lit 3.3.3 | 6 | None | Fine too; web components; more ceremony for app state |
| Vanilla JS + template strings | 0 | None | `innerHTML` with model-written rationales is an XSS foot-gun. Hand-written escaping everywhere. |
| React 19.3 + Vite 8.3.4 | 19, incl. 3 native binaries (rolldown, lightningcss, fsevents) | Yes | The pi-durable-cloudflare route. Too heavy for a local single-page app. |

"Why Gaffer can't do without it" (Preact + htm): the page renders model-written text (rationales, summaries, follow-up answers) next to a live stream. Escape-by-default rendering plus keyed updates is the smallest safe way to do both. Preact 11.0 (2026-09-30) is 17 days old, so stay on the last 10.x until it settles.

What to leave out:
- **No markdown library** at first. The result is rendered from JSON. Follow-up answers show as escaped paragraphs. Revisit only if answers look bad, and then add `marked` + DOMPurify together.
- **No CSS framework.** Reuse the mockup's CSS custom properties (`docs/ui/mockups/index.html` already defines both directions and dark mode).
- **No Google Fonts at runtime.** Self-host the WOFF2 files (the fonts are OFL) so the local app makes no third-party requests.

**Serving the mockups.** `docs/ui/mockups/index.html` is a single self-contained file. The bridge serves `/mockups/` statically, or `python3 -m http.server -d docs/ui/mockups` works with nothing installed. Add a **replay mode** to the bridge (`--replay spikes/s7-rpc-events/events.jsonl`) that plays a recorded run at real speed. UI work then needs no model, no sandbox and no spend. S7's log is the first fixture.

**Size estimate** (judgement): bridge ≈300–400 lines (static 40, session list 40, process manager 80, allowlist/translator 60, SSE + buffer + reduction 80, library reads 40). Frontend ≈1.5–2.5k lines (the Cloudflare client is 2.6k with CSS, for a general chat).

### 5.4 How UI 2 avoids every shell path into the harness

1. **No PTY in UI 2.** No xterm.js, no ttyd, no node-pty behind this page.
2. **The browser never speaks RPC.** It sends Gaffer commands with typed fields. The bridge validates them (lengths, enums, integer ids, a TypeBox or JSON Schema check) and **composes** the RPC command itself.
3. **RPC allowlist** (refines ADR 0005; see §7):
   - `prompt`: only the bridge-generated `/run {json}`, or user text that doesn't start with `/` or `!`.
   - `steer`: text only. Per `docs/rpc-commands.md`, steers can't run extension commands.
   - `abort`, `get_state`, `get_messages`, `get_entries`, `get_session_stats`.
   - `set_session_name` (capped).
   - `extension_ui_response`, only for ids this process asked for.
   - **Everything else is never sent.** That includes `bash`, `abort_bash`, `export_html`, `switch_session`, `new_session` (spawn instead), `fork`, `clone`, `compact`, `set_model`/`cycle_model`, the thinking, queue and retry setters, and `get_commands` (leaks paths).
4. **Sessions by id, resolved on the server.** Ids match `^[0-9a-f-]{36}$` and are looked up in the bridge's own scan of its session dir. Pi is spawned with `--session <that path>`. No client path reaches Pi, so the S7 `switch_session` findings (arbitrary read, file creation, session-dir drift) cannot happen.
5. **Extension commands.** Only `/run` is reachable, and only with bridge-built JSON. `/team`, `/prefs`, `/export-rec`, `/usage` and `/scorecard` are replaced by structured endpoints. On 1.3.0, the built-in `/mcp` and `/llama` must also be disabled in Pi itself (`-builtin:*`), not only by the allowlist.
6. **Defence in depth that already exists**, proven in S7:
   - Gaffer's `user_bash` handler also blocks RPC `bash`.
   - `--tools` is an allowlist.
   - Built-in TUI commands (`/export`, `/share`, `/login`) and `!cmd` are not interpreted over RPC.
   - The model's tools run in the no-network sandbox.
   - The bridge binds where the sandbox has no route (as ttyd does).

### 5.5 What UI 2 needs that the agent does not emit today

None of this needs a Pi change. All of it is Gaffer extension or bridge code.

| Need | Today | Proposal |
|---|---|---|
| A structured "run started: action, team, GW, options" record | Free text only | `gaffer-core` registers `/run {json}`. It validates the JSON, appends `gaffer.run {action, team_id_hash, gw, options, source:"app"}`, and starts the run with `pi.sendUserMessage(<prompt rendered from a template>)`. Verified at 1.3.0 in S7. **Not verified at 0.87.1.** It also cuts prompt-injection surface: the model sees Gaffer's template, not raw form text. |
| Step labels | Only `toolName` (the `label` is TUI-only) | A static table in the UI (`fpl_snapshot` → "Fetch FPL data", `submit_recommendation` → "Validate & save"…). For `bash`, a `tool_result` handler in `gaffer-sandbox` tags `gaffer_lib run` calls with `details.step = "golden_path"` (or the UI matches `details.run_command`). |
| Golden-path progress | Implicit | Derive it from the four milestones above. It needs only the tag in the row above. |
| Validation-retry event | **Exists**: `gaffer.validation` entries (`attempt`, `stage`, `errors`) | — |
| Snapshot summary | **Exists**: `fpl_snapshot` `details: SnapshotDetails` | Optional: `onUpdate` stages while fetching |
| Deadline / countdown | **Exists** in `details.gw.deadline` (after a snapshot) | Before a run, the start screen needs the current GW and deadline: the bridge reads `store.ts`'s cached bootstrap (or calls `http.ts` once), read-only |
| Budget state | **Exists**: `gaffer.budget` per turn, plus `usage` on `message_update` | The start screen's "today's spend left" comes from `usage.ts` in the bridge |
| Preferences, scorecard, usage as data | `notify` strings only | The bridge calls `prefs.ts`/`outcomes.ts`/`usage.ts` directly. Writes go through the same `writePrefs`/`savePreferences` code (or a bridge-rendered `/prefs …`). |
| Session list | No RPC command | The bridge scans `/sessions` (Gaffer already does, for `/usage` and admin) |
| Mid-run reattach | Not available from Pi | The bridge's per-run event buffer |

### 5.6 One backend, one session store, and the missing lock

Both UIs run Pi from the same package, with the same flags, over the same `/sessions` and `/data`. So a session started in one can be opened in the other: the TUI with `/resume` or `--session`, UI 2 by spawning `--session`. Gaffer's records are custom entries in the JSONL, so either UI can render them.

**However, Pi does not lock session files.** `session-manager.ts` appends with `appendFileSync` and takes no lock. `proper-lockfile` is used only for settings, auth, trust and MCP OAuth. Two live processes on one session would interleave entries.
- The TUI's `--continue` (`harness/gaffer-pi`) picks the most recent session after a restart, which could be one UI 2 has open.
- The Code-tab docs warn about exactly this.

Proposal (untested, a candidate spike):
- A Gaffer extension takes `<session>.lock` (O_EXCL; pid + UI) on `session_start` and releases it on `session_shutdown`.
- The bridge checks the lock before spawning. If the session is live in the TUI, it opens it read-only from the JSONL with a "open in the terminal" banner.
- The TUI side, on finding a live lock, notifies and starts a fresh session.

### 5.7 Phase 3 reachability

Unchanged browser protocol. The bridge maps the auth identity (ALB OIDC header, as in ADR 0005 Phase 2) to a tenant and spawns `--session-dir /sessions/<tenant>` with that tenant's sandbox. Sessions are only ever resolved inside the tenant's dir. Per-user rate and cost limits sit in the bridge in front of `gaffer-budget`.

---

## 6. Reasoning display, given summarized thinking

The lead's observation fixes the design: thinking is a short summary (~200 characters) on about a third of calls, and absent otherwise. A redacted block shows as `[Reasoning redacted]`.

- **Thinking is secondary.** Reasoning belongs to a model-call row (§4). While `thinking_*` streams, the row shows a subtle "thinking…" shimmer. On `thinking_end` it shows one muted line, the first ~120 characters, with the full summary on expand.
- **Show nothing when there is none.** No "Thinking" placeholder and no empty disclosure; like the Code tab, the control appears only once there is thinking. Treat `redacted: true` as absent.
- **Progress never depends on thinking.** The 4-step line and the tool step cards carry progress, so a run with no thinking looks just as alive.
- **The user's "why" comes from the schema, not the thinking.** It comes from `transfers[].rationale`, `chip.rationale`, `summary` and `confidence.drivers`, which are validated, persisted and short. Thinking is a "how it worked" aside for the Details mode.
- **Persisted and replayable.** Thinking is in the assistant message content in the JSONL, so a resumed session shows the same lines.
- **No setting needed** for `omitted`. If Gaffer ever sets `thinkingDisplay: "omitted"`, the UI degrades to steps only, which is already designed.

---

## 7. Contradictions with the brief or Gaffer's docs

1. **ADR 0005's RPC allowlist needs two additions and one removal:**
   - Add `get_entries`: `get_messages` lacks Gaffer's custom entries (`gaffer.validation`, `gaffer.budget`, `gaffer.run`).
   - Add `set_session_name`: needed for rename.
   - Drop `new_session` in a process-per-session bridge: spawn instead. S7 showed that after a `switch_session`, `new_session` followed the switched file's directory.
   - Constrain `prompt` text: no leading `/` except the bridge's `/run`, no leading `!`.
2. **ADR 0005 and research 05 still mention `pi-server`/`pi-client`/`pi-protocol`.** They were removed in 1.2.0 (CHANGELOG:109).
3. **ADR 0005 says "Over RPC, custom TUI components are not forwarded; only dialogs and notifications are".** More precisely: `setStatus`, `setTitle` and string-line `setWidget` are also forwarded; component widgets are dropped silently; `custom()` returns `undefined` (S7).
4. **ADR 0005 and research 05 C1 say "RPC can `switch_session`, so one session can be opened in either UI".** That works, but `switch_session` with a client-supplied path is exactly the hole the allowlist closes. Open sessions by spawning with a resolved path. The real cross-UI issue is the **missing session lock** (§5.6), which neither document mentions.
5. **On 1.3.0, built-in extensions add `/mcp` and `/llama` commands** visible over RPC. `harness/gaffer-pi` does not pass `--no-extensions` (the package is installed with `pi install`), so the upgrade must disable built-ins explicitly.

---

## Rejected, with reasons

| Option | Why not |
|---|---|
| Pi SDK in-process for UI 2 | Two configurations to keep equal; Gaffer's one-session-per-process singletons; no crash isolation; not the Phase 3 shape |
| pi-durable as the UI transport | A different harness (extension port) that is experimental. A bridge run buffer gives the same reconnect property for 75 s runs. |
| AG-UI (now) | No consumer needs it. It adds 14 packages client-side or a spec implementation. No in-flight reattach. Keep the event names compatible instead. |
| A2UI | For agent-invented UI. Gaffer's UI is fixed by a validated schema. Pre-1.0 "early stage public preview". |
| MCP Apps for UI 2 | It embeds an app in someone else's MCP host. Wrong direction; maybe later for distribution. |
| WebSocket | Needs a server library or hand-rolled upgrades for no benefit at this command rate |
| React + Vite | 19 packages (3 native) and a build step for a single local page |
| xterm.js in UI 2 | It would bring back a terminal and its shell-shaped risks; UI 1 already covers the terminal |
| Markdown library | Not needed while results render from JSON |

---

## Sources

- Pi monorepo @ `v1.3.0` (`71023aec`, 2026-10-15), read 2026-10-17:
  - `packages/coding-agent/docs/{rpc,rpc-commands,rpc-extension-ui,json,sdk,cli,security,environment-variables,extensions}.md`
  - `src/modes/rpc/{rpc-types,rpc-mode,rpc-client,jsonl}.ts`
  - `src/core/agent-session.ts:2058-2130,4318-4329`
  - `src/core/agent-session-runtime.ts:196-224`
  - `src/core/session-manager.ts:1766-1786`
  - `src/core/tools/bash.ts:75-94,255-330`
  - `src/extensions/index.ts`, `src/extensions/mcp/index.ts:1260`, `src/extensions/llama/index.ts:183`
  - `src/core/extensions/loader.ts:64-124`
  - `packages/ai/src/providers/faux.ts`, `packages/ai/src/compat.ts`
  - `packages/ai/src/api/anthropic-messages.ts:192,749-754,1287,1294`
  - `packages/coding-agent/CHANGELOG.md` (0.99.0–1.3.0)
- Pi @ `v0.87.1` (`f07218c4`): `rpc-types.ts`, `rpc-mode.ts` and the five docs above, diffed against 1.3.0 on 2026-10-17
- `packages/durable/README.md`, `test/examples/05-watches.ts`, `21-late-join.ts` @ `v1.3.0`
- earendil-works/pi-durable-cloudflare @ `dcb56ce` (2026-10-15): `README.md`, `package.json`, `src/protocol.ts`, `src/session.ts`, `src/client/*`, cloned 2026-10-17
- Spike S7: `spikes/s7-rpc-events/` (README, `events.jsonl`, `summary.json`), run 2026-10-17
- AG-UI, all fetched 2026-10-17:
  - https://github.com/ag-ui-protocol/ag-ui (GitHub API: 16,649 stars, pushed and released `release/2026-10-17`)
  - https://docs.ag-ui.com/concepts/events
  - https://docs.ag-ui.com/spec/1.0/changelog.md
  - https://docs.ag-ui.com/spec/1.0/basic/transports/index.md
  - https://docs.ag-ui.com/llms.txt
  - https://docs.ag-ui.com/development/updates (only a 2025-04-09 entry)
  - npm `@ag-ui/core` (1.0.0 2026-09-17; 1.0.3 2026-10-16) and `@ag-ui/client` 1.0.3 dependencies
- Secondary: https://nerdleveltech.com/ar/ag-ui-1-0-migration-tested (claims a 2026-09-30 1.0 announcement; undated in the result)
- A2UI: https://github.com/google/A2UI README (fetched 2026-10-17); https://a2ui.org/specification/v1.0-a2ui/ (via search, "last updated June 8, 2026"); npm `@a2ui/lit` 0.14.0 (2026-10-17), `@a2ui/web_core` 0.14.0
- MCP Apps:
  - https://modelcontextprotocol.io/docs/extensions/apps (fetched 2026-10-17)
  - GitHub API `modelcontextprotocol/ext-apps` (`specification/2026-01-26`, `draft`; releases v2.0.0 2026-09-08 … v2.0.3 2026-09-25)
  - npm `@modelcontextprotocol/ext-apps` 2.0.3, `@mcp-ui/client` 7.1.1 (2026-05-09)
- AI SDK stream protocol: https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol (search result only, 2026-10-17)
- Claude Code desktop docs: https://code.claude.com/docs/en/desktop (fetched 2026-10-17; undated)
- Zhao, Sohn, Zheng, Moor, "AgentGUI: An Interface for Observing and Steering Long-Running AI Agents", arXiv 2607.26300 (v1 2026-07-28, v2 2026-08-04): https://arxiv.org/abs/2607.26300, https://arxiv.org/html/2607.26300v2
- Grunde-McLaughlin et al., "Overseeing Agents Without Constant Oversight: Challenges and Opportunities", arXiv 2602.16844 (2026-02-18)
- Chen et al., "Comparing Human Oversight Strategies for Computer-Use Agents", arXiv 2604.04918 (v1 2026-04-06, v2 2026-09-12)
- npm registry, 2026-10-17:
  - `preact` (10.29.8 2026-08-01; 11.0.0 2026-09-30; 11.0.1 2026-10-08), `htm` 3.1.1 (2022-10-11), `lit` 3.3.3 (2026-05-14)
  - `npm i --dry-run` counts for Preact+htm (2), Lit (6), React 19.3.0 + react-dom + Vite 8.3.4 + @vitejs/plugin-react 6.1.2 (19), `@ag-ui/client` 1.0.3 (14)
- Gaffer @ `f884c33`: `docs/decisions/0004-session-storage.md`, `0005-web-tui.md`, `docs/research/05-web-tui.md`, `harness/gaffer-pi`, `harness/entrypoint.sh`, `packages/pi-gaffer/extensions/*/index.ts`, `src/schema/recommendation.ts`, `src/snapshot.ts:101-140`, `src/session.ts`, `test/harness.ts`, `evals/results/2026-10-16-anthropic_claude-sonnet-5-5.jsonl` (fixture source), `docs/ui/mockups/index.html`

## Unconfirmed

- **Real-model RPC output.** S7 used the faux model only. The summarized-thinking length and frequency come from the lead's note. I verified only that the adapter requests `summarized`/`omitted` (`anthropic-messages.ts`).
- **The `/run` → `pi.sendUserMessage` path at 0.87.1.** It was verified at 1.3.0 only. Gaffer is pinned to 0.87.1, and the lead notes that 1.2.0 changed `sendUserMessage`'s `deliverAs` rules; the 1.3.0 type still shows `deliverAs` as optional. Where I looked: `src/core/extensions/types.ts:448-451,1741-1744` @v1.3.0.
- **`structuredContent` on `bash`** is 0.99.0+. At 0.87.1 the exit code is only in the text, and `details` holds `{truncation, fullOutputPath}`. Not run at 0.87.1.
- **Abort with a tool that honours `signal`.** The S7 stub ignores it, so abort waited for the tool to finish. Real Gaffer tools pass `signal`; not tested.
- **The session-lock design (§5.6)** is a proposal from reading `session-manager.ts`; it is untested. I did not test two Pi processes writing one session.
- **AG-UI 1.0's announcement date.** npm says 1.0.0 was published 2026-09-17. One secondary blog says the announcement was 2026-09-30. The official "What's New" page has no 1.0 entry.
- **A2UI status.** The GitHub README (v0.9.1 production, v1.0 RC) disagrees with a2ui.org's version table (v0.8 stable). I trusted the README.
- **Whether MCP Apps was folded into the MCP `2026-07-28` core spec.** This is from secondary sources only. The ext-apps repo still carries `specification/2026-01-26` plus `draft`.
- **Newer Aug–Oct 2026 agent→UI standards.** Searches found none beyond AG-UI 1.0 and A2UI 0.9/1.0 RC. The AI SDK stream protocol page was not opened.
- **Claude desktop Code tab.** Patterns come from the public docs only, not from using the app.
- **AgentGUI details** come from the HTML v2 via a summarising fetch, not a full read of the PDF. HANSEL (arXiv 2606.18671) was seen only in a search result.
- **Bridge and frontend line counts, and the ~0.3 s spawn time** (stub extensions; the real Gaffer extensions load more code), are estimates.
- **Content addressed to the reader.** No fetched page or README contained instructions aimed at me.
