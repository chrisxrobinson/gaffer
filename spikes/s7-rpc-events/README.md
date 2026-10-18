# S7: RPC events for a Gaffer-shaped run (Pi 1.3.0)

Run on 2026-10-17 with `@earendil-works/pi-coding-agent@1.3.0` and `@earendil-works/pi-ai@1.3.0`, Node 26.10.0, faux model only (no API spend).

## Question

What does `pi --mode rpc` 1.3.0 emit for a Gaffer-shaped run, and is it enough to render UI 2 (the structured Gaffer App) without scraping text? What do the dangerous RPC commands do, so the bridge's allowlist is justified?

## Method

- `faux-model.ts`: an extension that registers `fauxProvider` (`pi.registerProvider`) with one scripted "brain" that answers from the transcript. Every reply has a thinking block, most have text, and the golden path has tool calls: `fpl_snapshot` → `bash` (golden path) → `submit_recommendation` (rejected) → `submit_recommendation` (valid, `terminate: true`). Any other user text gets thinking + a text answer.
- `stub-gaffer.ts`: the *shapes* of Gaffer's extensions, with no sandbox and no FPL.
  - `fpl_snapshot`: `onUpdate` progress with `details: {stage}`, then `{content:[text], details: SnapshotDetails-like}`, and `pi.appendEntry("gaffer.snapshot")`.
  - `bash`: Pi's own `createBashToolDefinition` with fake streaming `operations`, as `gaffer-sandbox` does with sandboxd.
  - `submit_recommendation`: throws on attempt 1 (with a `gaffer.validation` entry), and on attempt 2 returns `details: {recommendation}` (a real `gaffer.recommendation/1` document from the 2026-10-16 eval run, `fixtures/recommendation.json`) with `terminate: true` and a `renderResult`.
  - `/team` (appendEntry + `notify` + `setStatus`), `/pick` (a `select` dialog, `ctx.ui.custom()`, a component widget and a string widget), `/run {json}` (a proposed structured start: appends `gaffer.run` and starts the run with `pi.sendUserMessage`), a `user_bash` block like `gaffer-core`, `setTitle`/`setStatus`/`setWidget`, a `gaffer.budget` entry per turn, and one budget-style steer message (`pi.sendMessage(..., {deliverAs: "steer"})`).
- `run-spike.ts`: spawns the CLI (`node_modules/.../dist/bundle/cli.js --mode rpc`) and speaks raw JSONL on stdio (LF framing; not `readline`). It records every record in both directions to `events.jsonl` and writes `summary.json`. It runs three phases:
  - **A**: Gaffer-like flags (`--no-extensions -e faux-model.ts -e stub-gaffer.ts --tools read,write,edit,bash,fpl_snapshot,submit_recommendation --no-context-files --no-skills --no-prompt-templates --offline`). It drives `/team`, `/pick`, a recommend run (mid-run: `get_state`, a `prompt` without `streamingBehavior`, a `steer`), the reconnect reads, a follow-up, `/run`, an abort, the prompts `!echo …`, `/export <path>` and `/share`, and then the dangerous commands.
  - **B**: the same, with the `user_bash` handler off, to see what RPC `bash` does without it.
  - **C**: built-in extensions left on, to see what `get_commands` lists.

Re-run (about 6 s):

```bash
cd spikes/s7-rpc-events
npm ci                       # exact pins: pi-coding-agent 1.3.0, pi-ai 1.3.0, typebox 1.3.27
S7_WORK=$(mktemp -d) node run-spike.ts > /dev/null   # rewrites events.jsonl and summary.json
```

`events.jsonl` has one line per record: `{t: ms since start, phase, dir: "in"|"out"|"stderr", rec}`. Local paths are replaced by `$W` (scratch dir), `$REPO` and `$USER`.

## Result

### Every record type seen (643 records)

| Family | Types (count over all phases) |
|---|---|
| Run lifecycle | `agent_start` 8, `turn_start` 18, `turn_end` 18, `agent_end` 8, `agent_settled` 8 (`aborted: true` once, after `abort`) |
| Messages | `message_start` 44 / `message_end` 44 (roles: `system` 2, `user` 9, `assistant` 18, `toolResult` 13, `custom:gaffer.steer` 2), `message_update` 273 |
| `message_update.assistantMessageEvent` | `thinking_start` 17, `thinking_delta` 104, `thinking_end` 17, `text_start` 11, `text_delta` 46, `text_end` 11, `toolcall_start` 13, `toolcall_delta` 41, `toolcall_end` 13 |
| Tools | `tool_execution_start` 13, `tool_execution_update` 38 (`fpl_snapshot` 20, `bash` 18), `tool_execution_end` 13 (with `durationMs`) |
| Queue | `queue_update` 2 (the steer queued, then delivered) |
| Session entries | `entry_appended` 33: `gaffer.team` 1, `gaffer.run` 1, `gaffer.snapshot` 4, `gaffer.budget` 18, `gaffer.validation` 6, `gaffer.recommendation` 3 |
| Extension UI | `extension_ui_request`: `setStatus` 28, `setTitle` 9, `setWidget` 5, `notify` 4, `select` 1 (answered with `extension_ui_response`) |
| RPC-only | `bash_execution_update` 3 (phase B only), `response` (one per command) |

Not seen, but documented in `docs/json.md` @v1.3.0: `compaction_*`, `auto_retry_*`, `summarization_retry_*`, `session_info_changed`, `thinking_level_changed`, `extension_error`.

### What each Gaffer shape becomes on the wire

- **Thinking** streams as `message_update` → `thinking_start` / `thinking_delta` (`contentIndex`, `delta`) / `thinking_end` (`content` = the whole block). Faux supports thinking blocks (`fauxThinking`). With a real Anthropic model, Pi asks for `display: "summarized"` (`packages/ai/src/api/anthropic-messages.ts:192,1287,1294` @v1.3.0), so expect short summaries on some calls only. A redacted block arrives as `[Reasoning redacted]` with `redacted: true` (`:749-754`).
- **Text** streams the same way (`text_*`). Each `message_update` also carries cumulative `usage` for the response.
- **Tool calls** stream as `toolcall_start` (`id`, `toolName`) / `toolcall_delta` (argument JSON text) / `toolcall_end` (the full `toolCall`). Then come `tool_execution_start` (`args`), `tool_execution_update` (`partialResult`), and `tool_execution_end` (`result.content`, `result.details`, `isError`, `durationMs`).
  - `fpl_snapshot`: `onUpdate` partials arrive as they are sent (`partialResult.details.stage`), and the final `result.details` is the whole snapshot summary.
  - `bash`: the first `partialResult` is `{content: []}`, then each one is the **cumulative** (tail-truncated, 50 KB / 2000 lines) output, throttled at 100 ms. `tool_execution_end.result` also has `structuredContent: {output, truncated, exit_code, wall_time_seconds}` (bash's `outputSchema`, new in 0.99.0) and no `details`.
  - `submit_recommendation` rejected: `isError: true`, `result.details: {}`. The reason is only in the text, **but** the `gaffer.validation` entry (`entry_appended`) carries `{attempt, passed: false, stage, errors: [{code, message}]}`.
  - `submit_recommendation` valid: `result.details.recommendation` is the full `gaffer.recommendation/1` document, and the run ends (no further model turn).
  - The tool `label` ("FPL snapshot") is **not** on the wire; only `toolName`.
- **`pi.appendEntry`** → `entry_appended {entry: {type: "custom", customType, data, id, parentId, timestamp}}`, in order with the other events. This is the cleanest structured channel for Gaffer's own records.
- **Custom messages** (`pi.sendMessage`, the budget steer) appear as `message_start`/`message_end` with `role: "custom"` and `customType`.
- **Extension UI over RPC**:
  - `notify`, `setStatus`, `setTitle` and `setWidget` with **string lines** are forwarded (fire-and-forget).
  - `setWidget` with a **component factory is dropped silently** (no record).
  - `ctx.ui.custom()` returns `undefined`; `ctx.mode === "rpc"`, `ctx.hasUI === true`.
  - `select` is a request/response round trip (`timeout` honoured).
  - `renderResult` is never used over RPC (it does feed `export_html`).
  - `session_start` re-runs on every session switch, so `setTitle` repeated (9 times).
- **Slash commands**: `prompt "/team 1234567"` runs the extension command and answers `disposition: "handled"` after the handler completes. `/run {json}` → `entry_appended gaffer.run` → `response handled` → `agent_start`: an extension command can start a run, so the bridge must wait for `agent_start`/`agent_settled`, not trust the disposition.
- **Busy session**: a `prompt` without `streamingBehavior` mid-run fails ("Agent is already processing…"). `steer` → `{disposition: "queued"}` → `queue_update {steering: [...]}`. After the tool round it is delivered as a `user` message and `queue_update` empties.
- **Abort**: `abort` waits for the running tool to finish (the stub ignores `signal`), then the run ends with `agent_settled {aborted: true}`.
- **Size**: the 8 KB recommendation appears 6 times per run on the wire (`entry_appended`, `tool_execution_end`, `message_start`, `message_end` of the tool result, `turn_end.toolResults`, `agent_end.messages`). `agent_end.messages` and `message_start` of the `system` message also carry the **whole system prompt** (`sections`). A bridge should forward a reduced stream.

### Reconnect (what a fresh client can rebuild from)

| Command | Returns | Good for |
|---|---|---|
| `get_state` | `isStreaming`, `sessionId`, `sessionFile`, `sessionName`, `model`, `thinkingLevel`, `messageCount`, `pendingMessageCount` | Is a run active? Which session? |
| `get_messages` | Committed `AgentMessage[]` of the active branch, including `system`, `custom` and `toolResult` messages with `details` | The transcript and every tool result's `details` |
| `get_entries [since]` | All entries in append order, **including `custom` entries** (`gaffer.snapshot`, `gaffer.validation`, `gaffer.recommendation`, `gaffer.budget`), with stable ids usable as a cursor | Gaffer's structured records; incremental catch-up |
| `get_session_stats` | Message and tool counts, tokens, cost, context usage | Footer and budget |
| `get_last_assistant_text` | `{}` (null) after a terminating submit: the last assistant message has no text | Not useful for Gaffer |

None of these returns the **in-flight** partial message (streaming thinking or text) or a running tool's partial output. A browser that reconnects mid-run must get those from a bridge-side buffer of the run's events.

### Dangerous commands

| Input | What happened | Verdict |
|---|---|---|
| `bash` (phase A, `user_bash` handler on) | Blocked by the handler: `{output: "Shell commands are disabled…", exitCode: 1}`. RPC `bash` goes through `emitUserBash` (`src/modes/rpc/rpc-mode.ts:561-584` @v1.3.0) | Gaffer's existing handler also covers RPC |
| `bash` (phase B, no handler) | **Ran a host shell** as the Pi process user: `S7-RPC-BASH-RAN`, `$USER`, `$W`; streamed `bash_execution_update` deltas; the output was stored as a `bashExecution` message that goes to the model on the next prompt | Must be rejected by the bridge; keep the handler as a second line |
| `export_html {outputPath}` | Wrote a 330 KB HTML file at the arbitrary path `$W/escape/exported.html` | Arbitrary file write: reject |
| `switch_session {sessionPath: <crafted file outside --session-dir>}` | Loaded it: `sessionFile` became that path, and its injected history became the context (1 message). Pi takes the file header's `cwd` as the new runtime cwd (`agent-session-runtime.ts:210-215`) | Arbitrary read and context injection: reject client paths |
| `switch_session {sessionPath: <non-session file>}` | `Session file is not a valid pi session` | Probes file existence and type |
| `switch_session {sessionPath: <nonexistent path>}` | Succeeded; the next run **created that file** (22 JSONL lines). The following `new_session` then put its session in that directory (`$W/escape/…`) | Arbitrary file creation, and the session dir drifts |
| `new_session {parentSession: "/etc/passwd"}` | Accepted; the value is only recorded as the parent | Strip `parentSession` |
| `set_model {anthropic/…}` | `Model not found` (faux-only registry); with real credentials it would switch model and spend | Not exposed |
| `prompt "!echo …"` | Sent to the **model as plain text**; no shell (`!` is TUI-only) | Safe |
| `prompt "/export <path>"`, `prompt "/share"` | Sent to the model as plain text; no file, no upload (built-in slash commands are TUI-only; RPC runs only extension commands, templates and skills; `agent-session.ts:2065-2100`) | Safe, but the bridge should not pass free `/…` text |
| `get_commands` | Phase A: `run, team, pick`. Phase C (built-ins on): plus **`llama`, `mcp`**. `/mcp` over RPC answered "No MCP servers configured. Add them to …/mcp.json" | Run with `--no-extensions` (0.99.0+ also drops built-ins), as Gaffer already does |

## Impact on the design

1. **RPC is enough to render UI 2 without scraping text.**
   - The recommendation comes from `tool_execution_end.result.details.recommendation` (or the `gaffer.recommendation` `entry_appended`).
   - The snapshot summary comes from `fpl_snapshot`'s `details`.
   - Validation retries come from `gaffer.validation` entries; budget from `gaffer.budget` entries plus `message_update.usage`.
   - Thinking, text and tool steps stream as typed deltas.
   - Every one of these already exists in Gaffer at 0.87.1. The RPC wire changed only additively from 0.87.1 to 1.3.0: `disposition` (0.99.0), `durationMs` and `agent_settled.aborted` (1.1.0), and `structuredContent` (0.99.0).
2. **Gaps that UI 2 must fill (none needs a Pi change):**
   - There is no structured "run started for team/GW/action" record. Fix: a `/run {json}` extension command that appends `gaffer.run` and calls `pi.sendUserMessage` (verified here).
   - Step labels are not on the wire. Fix: a static `toolName` → label table in the UI, plus matching the `bash` command against `details.run_command` to label the golden-path step.
   - No mid-run snapshot of the in-flight partial message. Fix: a bridge-side event buffer per run with sequence numbers.
   - There is no "list sessions" command. Fix: the bridge reads `/sessions` itself (Gaffer's `scanSessions`).
   - The tool `label` and `renderResult` are TUI-only.
3. **The bridge must allowlist** `prompt` (only `/run {json}` and free text with no leading `/` or `!`), `steer`, `abort`, `get_state`, `get_messages`, `get_entries`, `get_session_stats`, `set_session_name` (rename) and `new_session` (with no `parentSession`). It must answer `extension_ui_response` only for its own pending requests. It must never forward `bash`, `export_html`, `switch_session`, `fork`/`clone`, `compact`, `set_model`/`cycle_model`, or the queue, retry and thinking setters from the browser. It should resume a session by **spawning** Pi with a bridge-resolved `--session <path>` under the tenant's own dir, never by passing a client path to `switch_session`.
4. **Keep `user_bash` blocked and `--no-extensions`.** Both are proven second lines behind the allowlist.

Throwaway code: delete `node_modules/` after reading. `events.jsonl` (≈460 KB) and `summary.json` are the evidence.
