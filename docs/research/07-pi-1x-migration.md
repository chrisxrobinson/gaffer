# 07 — Pi 1.x migration (0.87.1 → 1.3.0)

Research dates: 2026-10-17 and 2026-10-18.

**Versions read:** `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core` and `pi-tui` at:
- **v0.87.1**: Gaffer's pin, commit `f07218c4`
- **v1.3.0**: the latest release, 2026-10-15, commit `71023aec`

Both come from the Pi monorepo (`github.com/earendil-works/pi`). The generated model catalogue (`pi-ai/dist/providers/data/anthropic.json`) isn't in the repo, so it was read from the installed npm tarball of 1.3.0.

Path conventions:
- `src/…` = `packages/coding-agent/src/…`
- `ai/…` = `packages/ai/src/…`
- every citation is `@v1.3.0` unless another tag is named
- `CL x.y.z` = `packages/coding-agent/CHANGELOG.md` at that release; `CL-ai`, `CL-agent` and `CL-tui` are the other packages' changelogs

Where docs, changelog and source disagreed, the source at the tag was trusted.

Companion documents:
- `docs/MIGRATION-PI-1X.md`: the full inventory, one row per Pi item Gaffer touches, and the upgrade order
- spike S2 (`docs/spikes/s2-pi-1x-upgrade.md`): the upgrade run
- the lead's spike S6 (`docs/spikes/s6-prompt-cache.md`): the prompt-cache path, measured with a real model

---

## TL;DR for Gaffer

| Question | Answer |
|---|---|
| Does Gaffer run unchanged on 1.3.0? | **Yes, apart from one test** that hard-coded `pi: "0.87.1"` (`packages/pi-gaffer/test/recommend.test.ts:74`). After that fix, S2 got: 237/237 tests (227 + 10); the same 17 pre-existing type errors as on 0.87.1; a clean image build; every check in the adapted `verify.sh`; and a faux eval at 30/30 valid with p50 51.7 s, which is 0.87.1's result too |
| Any extension point removed? | **No.** Every Gaffer hook, tool option and SDK call keeps its shape. The changes are additive: new optional fields and new events |
| What changes Gaffer's behaviour? | (1) `harness/models.json` now **shadows** Pi's own Sonnet 5.5 entry, which has the mid-conversation flags and the right cache price. (2) The TUI now loads four built-in extensions (**MCP, codemode, tool-search, llama.cpp**), while SDK hosts (tests, evals) don't |
| What should change anyway? | Count `type: "usage"` session entries (cache warming) in the budget and in `/usage`. Fix the Sonnet 5.5 cache-read price to $0.10 (S6) |
| New features worth adopting | Mid-conversation system messages (through the catalogue entry), and `-builtin:<name>` to switch the built-ins off. Everything else is rejected or optional (§3) |
| Core assumption at risk? | None. MCP and codemode can be switched off in settings; `/share` still has no way out of the image; `user_bash` stays blocked. **Lead's note:** research 09's spike S3 found that Gaffer's current launch line alone (`--tools …`) still *spawns* any MCP server configured in `mcp.json`, with the API key in its environment; the lock is `--no-mcp` plus the `-builtin:` settings ([ADR 0012](../decisions/0012-builtins-locked-off.md)) |

---

## 1. Release by release (only what touches Gaffer)

"—" means nothing in that release touches Gaffer.

| Release (date) | coding-agent | ai | agent | tui |
|---|---|---|---|---|
| 0.99.0 (09-29) | **Built-in extensions**: codemode, tool search and MCP, named `builtin:<name>`; `--no-extensions` disables them too. New tool APIs: `exposure`, `namespace`, `annotations`, `outputSchema`, `prepareLoadout()`, `ctx.executeTool()`. The `system` theme becomes the default (Gaffer sets its own). `[Themes]` leaves the startup banner. **The session file is created at the first user message.** `bash` gets structured results. `provider_stream_event`. Virtual models. `defaultTools` takes `+x`/`-x` | **Claude Sonnet 5.5 in the catalogue** (adaptive thinking, mid-conversation effort, 1M context). `AssistantMessage.thinkingLevel`. Image and classifier model types (additive for chat models) | `thinkingLevel` recorded on assistant messages | `queryTerminalColors()` replaces two methods (Gaffer doesn't import pi-tui) |
| 0.99.1 (09-29) | — | — | — | — |
| 0.99.2 (09-30) | MCP servers are listed in an `mcp_servers` section, only when servers exist. Anthropic `strict: "prefer"` tools with `minimum`/`maximum` are sent non-strict | The same strict fix; Anthropic workload-identity env vars | — | — |
| 1.0.0 (10-01) | **Fullscreen is the default** (`tuiMode`). `--provider` without `--model` is an error. `quietStartup: "header"` | — | Experimental harness removed (Gaffer doesn't import pi-agent-core) | `getScreenLines()` |
| 1.0.1 (10-03) | `pi.registerToolRenderer()`. Anthropic tools added mid-conversation are defined inline. **`npm-shrinkwrap.json` removed** from the npm package | Anthropic `inline-tools-2026-09-15` beta for models with native mid-conversation tool changes; `@anthropic-ai/sdk` 0.129 | — | `setImageTranscoder()` |
| 1.0.2 (10-04) | — | `samplingParamsByThinkingLevel` (OpenAI-compatible APIs only) | — | — |
| 1.0.3 (10-05) | Azure provider renamed (Gaffer doesn't use it). **Fullscreen transcript top/bottom move from `Home`/`End` to `Ctrl+Home`/`Ctrl+End`** | — | — | The same key change |
| 1.0.4 (10-05) | `--tools` accepts `*` patterns and **keeps MCP tools unless an entry starts with `mcp__`**; new `--no-mcp` | — | — | — |
| 1.1.0 (10-07) | `--tools +x,-x`. `durationMs` on `tool_execution_end` and in the tool render context. `agent_settled.aborted`. OSC 7501 program status | `AssistantMessage.durationMs` and `ToolResultMessage.durationMs`. Haiku 5.5. The faux cache estimate changes (totals unchanged). Custom stream functions must return `AssistantMessageEventStream` (Gaffer has none) | `durationMs` on tool results and events | Custom `Terminal`s must implement `setProgramStatus()` (Gaffer has none) |
| 1.2.0 (10-12) | **`BeforeAgentStartEvent` becomes a union on `messageType`** and also fires for idle `sendMessage(…, {triggerTurn: true})` runs. The session counts as busy while a run starts, and `sendUserMessage()` then needs `deliverAs`. **The theme `$schema` moves to `https://pi.dev/schemas/theme.schema.json`, and themes are schema-validated at startup.** `reachesTools`; namespace `aliases`. `serializeConversation()` omits thinking. The experimental server/client stack is removed, with `pi-client`, `pi-protocol` and `pi-server` | Anthropic strict-tool retry | — | Editor/Input cursor markers (matter only when rendering outside a TUI) |
| 1.3.0 (10-15) | `sessionShareDestination` (`/share` via Radius or gist). **Resumed sessions keep their active tools** unless tools are named explicitly. Thinking from another model is dropped after a model switch. Malformed tool-call JSON now fails validation. **Internal Pi dependencies pinned to exact versions** | `AssistantMessageFrame*` removed (experimental); `argumentsError` on malformed tool calls | — | — |

0.86.0 and 0.87.0 are already in Gaffer's 0.87.1 pin. They brought mid-conversation system messages, cache warming, fail-closed `user_bash`, the `TurnEndEvent` boundary fields and `ContextEditEntry`. They aren't 1.x changes, so they appear below only where they matter (§2, §4.3, §4.4).

---

## 2. Breaking changes, and what each one hits in Gaffer

| # | Change | Hits Gaffer at | Effect | Fix | Citation |
|---|---|---|---|---|---|
| B1 | Stored `pi` version | `packages/pi-gaffer/test/recommend.test.ts:74` | The test fails: `"pi": "1.3.0"`, expected `"0.87.1"` | Compare with `VERSION` from `@earendil-works/pi-coding-agent` (S2 commit `fb269b3`) | `src/config.ts:582` |
| B2 | Sonnet 5.5 is in the catalogue (0.99.0), and a `models.json` entry with the same id **replaces** the catalogue entry | `harness/models.json:1-21`, `harness/Dockerfile:69-70` | No error. Gaffer keeps 0.87.1's request shape: no mid-conversation system messages, no inline tool changes and no mid-conversation effort; `supportsTemperature` is unset; cache reads are priced at $0.20, not $0.10 | Delete the file and the `COPY`. If an override is ever needed, use `modelOverrides`, which merges. On 0.87.1, add `supportsMidConvoSystemMessages: true` and `cacheRead: 0.1` (S6) | `src/core/provider-composer.ts:331-336` (replace), `:553-575` (`modelOverrides` merged last); catalogue `anthropic.json` @1.3.0; CL-ai 0.99.0 |
| B3 | The CLI loads the built-in extensions by default (0.99.0) | `harness/gaffer-pi:8-13`, `harness/Dockerfile:80-81` | The Gaffer TUI gains `/mcp` and `/llama` (S2's capture shows `/mcp`), a `llama.cpp` provider, and `codemode`/`tool_search` registered but inactive. Tests and evals don't load these, so they are untested surface | In `settings.json`: `"extensions": ["-builtin:mcp","-builtin:codemode","-builtin:tool-search","-builtin:llama.cpp"]`. S2 checked that `/mcp` disappears and all 5 Gaffer extensions still load | `src/main.ts:578`; `src/extensions/index.ts:7-14`; `src/core/resource-loader.ts:577-583`; S2 `tui-builtins-disabled-1.3.0.txt` |
| B4 | No `npm-shrinkwrap.json` (1.0.1); internal Pi packages pinned exactly (1.3.0) | `harness/Dockerfile:29` | `npm install -g` resolves third-party transitive deps fresh on each build (118 packages in S2); only Pi's own packages are exact | Install from a committed lockfile (`npm ci`), or record the exception to NFR-MNT-01 | CL 1.0.1 Removed; CL 1.3.0 Fixed #10865 |
| B5 | `BeforeAgentStartEvent` is a union on `messageType` (1.2.0) | `extensions/gaffer-core/index.ts:32-48` | None, at runtime or in types: Gaffer reads only `systemPromptOptions`, which is on the shared base. The handler now also runs for idle `triggerTurn` custom runs. Gaffer starts none; if it did, its prompt would apply, which is what it wants | None. **Correction to the brief:** `gaffer-budget` doesn't handle `before_agent_start` | `src/core/extensions/types.ts:932-957` |
| B6 | `sendUserMessage()` needs `deliverAs` while busy (1.2.0) | Not used. `gaffer-budget/index.ts:67` calls `sendMessage(…, {deliverAs: "steer"})` | None | None | `types.ts:1731-1745` |
| B7 | Fullscreen keys changed (1.0.3) | `README.md:71`, `docs/ARCHITECTURE.md:400`, the comment at `harness/gaffer-pi:5` | `Home`/`End` now move the editor cursor; `Ctrl+Home`/`Ctrl+End` jump in the transcript | Update the docs. Check by hand that `Ctrl+Home` gets through xterm.js → tmux | CL 1.0.3; CL-tui 1.0.3 |
| B8 | Theme `$schema` URL and startup validation (1.2.0) | `packages/pi-gaffer/themes/gaffer.json:2` | None: validation passes, and `$schema` may be any string | Point it at `https://pi.dev/schemas/theme.schema.json` | `src/modes/interactive/theme/theme-schema.ts:54`; CL 1.2.0 |
| B9 | `--provider` without `--model` is an error (1.0.0) | `harness/gaffer-pi:10-11` | Only if an operator sets `GAFFER_PROVIDER` and clears `GAFFER_MODEL` | Pass `--provider` only together with `--model` | CL 1.0.0 #10236 |
| B10 | The session file is created at the first user message, not the first reply (0.99.0) | Comments at `extensions/gaffer-core/index.ts:132` and `test/harness.ts:176` | A run that dies before any reply now leaves a file with a user message and no cost. `src/usage.ts` reports it as a run with outcome "answer" | Update the comments | CL 0.99.0 #10000; `src/core/session-manager.ts:1158-1176` |

Checked and **unchanged** (rows and citations in MIGRATION-PI-1X.md §4–§6):
- System prompt: `systemPromptOptions.customPrompt`, `contextFiles` and `sections` keep their semantics; only `hiddenTools` was added (`src/core/system-prompt.ts:9-49`).
- Extension context: `ctx.abort()`, and `ctx.ui.notify` (the `ExtensionUIContext` members are identical).
- `pi.*` calls: `sendMessage` with `deliverAs`, `pi.setActiveTools`, `pi.getAllTools` (additive), `pi.appendEntry`, `registerCommand`.
- Tool definitions: `defineTool`'s `executionMode`, `promptSnippet`, `renderResult` (now with an optional 4th `context` argument) and `terminate`. The options of `createBash/Read/Write/EditToolDefinition` and their `*Operations` interfaces are byte-identical.
- Events: `tool_execution_end` (gains `durationMs` and `parentToolCallId`), `TurnEndEvent`, `InputEvent`, `user_bash` (fail-closed since 0.86.0).
- Exports: `VERSION`.
- SDK: the `DefaultResourceLoader` options, `createAgentSession`, `SessionManager.create`, `SettingsManager.create`, `ModelRuntime.create`, `bindExtensions({uiContext, mode})` and the `fauxProvider` API.
- Environment: `PI_CODING_AGENT_DIR`, `PI_TELEMETRY`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`.
- Install and settings: `pi install`, and the `settings.json` `theme` key.
- Session files: JSONL version 3, and the `SessionEntry` union (identical at both tags).

---

## 3. New features: adopt or reject

| Feature (release) | Verdict | Why Gaffer can't do without it / why not |
|---|---|---|
| Mid-conversation system messages, through Pi's Sonnet 5.5 entry (mechanism since 0.86.0; catalogue entry 0.99.0) | **Adopt** | Without them, every follow-up prompt rewrites the whole cached prefix, because `fpl_context` changes on every prompt. S6 measured follow-ups 75% cheaper with them |
| `-builtin:<name>` in `settings.json` (0.99.0) | **Adopt** | It's the only way to keep MCP, codemode and llama.cpp out of the shipped TUI while still loading Gaffer's package extensions (`--no-extensions` drops those too) |
| `--no-mcp` (1.0.4) | Optional | Redundant with `-builtin:mcp`; one extra flag in `harness/gaffer-pi` as belt and braces |
| `sessionShareDestination: "gist"` (1.3.0) | Adopt (one line) | Stops `/share` from ever uploading to Radius, even if a user signs in to Radius from the TUI. Without `gh`, the gist path fails |
| `durationMs` on assistant messages and tool results (1.1.0) | Optional | It would give `/usage` and `gaffer admin` exact model and tool latency instead of timestamp deltas. Not required: the current derivation works |
| Codemode / `ctx.executeTool()` (0.99.0) | Reject (R9 spikes it) | A recommendation run is 4–5 calls on a fixed golden path. Codemode would run model-written JavaScript (QuickJS) in the harness process, next to the key. Its nested calls also slip past `gaffer-recommend`'s attempt counter unless that filters on `parentToolCallId` |
| `tool_search` / `deferred` exposure (0.99.0) | Reject | Seven tools; nothing to defer |
| MCP (0.99.0) | Reject | Gaffer has no MCP data source, and stdio servers would run in the harness container, next to the key |
| `exposure` / `namespace` / `reachesTools` / `annotations` / `prepareLoadout` / `outputSchema` (0.99.0–1.2.0) | Reject | These serve tools that orchestrate other tools; Gaffer's tools are plain |
| `pi.registerToolRenderer()` (1.0.1) | Reject | Gaffer's tools have their own `renderResult`, and there are no unregistered tools to draw |
| Virtual models (0.99.0) | Reject | One model by design (ADR 0008) |
| `provider_stream_event` (0.99.0) | Reject (debugging only) | Nothing in it that Gaffer needs at run time |
| Cache warming `idle` (0.86.0) | Reject | In a single-user TUI, idle refreshes pay for prompts that may never come. Keep the default `streaming` and count its `usage` entries, or set `off` |
| `quietStartup: "header"` (1.0.0) | Defer to R5 (TUI branding) | Cosmetic |
| Published config schemas (1.2.0) | Adopt (cosmetic) | Editor validation for `themes/gaffer.json`, and for `settings.json` if Gaffer ever ships one |
| Haiku 5.5 (1.1.0), GPT-6.1 Sol (0.99.1) | Reject for now | NFR-PORT-01 model swaps are eval work, not upgrade work |
| Program status, OSC 7501 (1.1.0) | Reject | ttyd/xterm.js isn't known to speak OSC 7501 (unverified), and it gives the user nothing |

---

## 4. Answers to the specific questions

### 4.1 Tool exposure and Gaffer's allowlist and guard
At 1.3.0, four rules decide what the model can reach:

1. **Registration.** The allowlist (`--tools` on the CLI, `tools` in the SDK) decides what is registered at all. An unmatched tool isn't registered (`_isAllowedTool`, `src/core/agent-session.ts:1542-1546`). The only exception: MCP tools (`mcp__*`) stay registered when the list has no `mcp__` entry.
2. **Activation.** Only `direct` and `model-only` tools can be active, which is what "declared to the model" means (`_isDeclarable`, `:3626-3629`). An MCP tool that is kept but not named can become active only if it isn't `direct` *and* `tool_search` is registered (`_isActivatable`, `:1548-1557`).
3. **`pi.setActiveTools()`** ignores unknown and `hidden` tools (`types.ts:1771-1778`). So Gaffer's `session_start` call (`extensions/gaffer-core/index.ts:26-30`) can only narrow the set.
4. **Calls through `ctx.executeTool()`** can reach the active `direct` tools plus every registered `codemode`/`deferred` tool (`_getCallableTools`, `agent-session.ts:1563-1572`). In Gaffer nothing calls `executeTool`, and `codemode` isn't registered, because `--tools` doesn't name it.

So with Gaffer's launch line the model sees exactly the seven tools. A configured MCP server couldn't put a tool in front of the model either: its tools would register, but `tool_search` is absent.

**Nested calls go through the guard.** `ctx.executeTool()` runs the call through the agent's tool pipeline, using the session's own `beforeToolCall`/`afterToolCall` (`agent-session.ts:728-764`). `_beforeToolCall` sends extensions a `tool_call` event that carries `parentToolCallId` (`:659-682`). So Gaffer's guard (`src/guard.ts:66-80`) blocks a nested call exactly as it blocks a model call. More on nested calls:
- They also emit `tool_result` and `tool_execution_start/update/end`, each with `parentToolCallId` (`src/core/nested-tool-calls.ts:1-9`; `types.ts:1099-1124`).
- They get the id `<parent>/<n>` and aren't written to the transcript. The parent's tool result carries a bounded `nestedCalls` record instead (`types.ts:376-394`; limits at `nested-tool-calls.ts:26-31`).
- Their usage is added to the parent result's usage (CL 0.99.0 Fixed).

**If codemode is ever adopted**, the guard still holds. Two Gaffer readers would miss or miscount nested calls, though:
- `gaffer-recommend`'s `tool_execution_end` counter (`extensions/gaffer-recommend/index.ts:116-126`);
- `src/usage.ts`, which reads only the transcript's tool calls.

None of the other new APIs changes any of this:

| API | What it does | Citation |
|---|---|---|
| `namespace` | Groups tools for codemode and tool-search listings | `types.ts:534-549` |
| `reachesTools` | Lets an MCP extension wait for its servers before a call | `types.ts:613-621` |
| `registerToolRenderer()` | Changes only how a call is drawn | `types.ts:674-682, 1724` |
| `prepareLoadout()` | Can rewrite descriptions, or hide the declarations of *active* tools; hidden tools stay active and callable | `types.ts:552-575, 632-638`; `agent-session.ts:1772-1790` |

None of them can activate a tool the allowlist didn't register.

### 4.2 Claude 5.5 reasoning: display, events, storage
- **Request.** Pi sends `thinking: {type: "adaptive", display}`, where `display` is `options.thinkingDisplay ?? "summarized"` (`ai/api/anthropic-messages.ts:192, 1279-1294`; S6).
  - The type allows only `"summarized" | "omitted"`, so the `"updates"` progress-note mode is **never requested**.
  - With the catalogue entry (`supportsMidConvoEffort`), Pi also sends `block_binding: {prefix_mismatch_behavior: "drop_block"}`, and the effort as `role: "system"` `output_config` markers (`:1279-1288, 1556-1577`).
  - A `before_provider_request` hook (`types.ts:902, 1632`) could rewrite the payload, but Gaffer would then own an undocumented request shape.
- **Stream events.** Summarized thinking streams as `thinking_start`, `thinking_delta` and `thinking_end` (`ai/types.ts:811-813`). In `--mode json` and RPC they arrive inside `message_update.assistantMessageEvent` (`docs/json.md:82-93`). There is no new block type.
- **Storage.** Assistant `content` holds `{type: "thinking", thinking, thinkingSignature?, redacted?}` (`ai/types.ts:420-428`), unchanged from 0.87.1. Since 0.99.0 the assistant message also records `thinkingLevel`.
- **TUI.** `assistant-message.ts` renders thinking blocks with a show/hide toggle on each block (`src/modes/interactive/components/assistant-message.ts:24, 99-125`). The `hideThinkingBlock` setting (`src/core/settings-manager.ts:954`) and `ctx.ui.setHiddenThinkingLabel` control it.
- **Gaffer's two UIs** can show summarized reasoning from the same events and blocks, on either version. S6 gives real numbers: 69 of 201 live Sonnet 5.5 calls carried a non-empty thinking block, about 200 characters each.

### 4.3 Session storage, naming, location, lazy creation, compaction
`docs/session-format.md` differs between the tags by three additive paragraphs:
- assistant messages record `thinkingLevel`;
- `model_change` may name a virtual model;
- a `pi.virtual-model-state` custom entry exists.

`CURRENT_SESSION_VERSION` is 3 at both tags (`src/core/session-manager.ts:41`), and the `SessionEntry` union is identical (`:183-194`). The session-manager diff contains three things:
- the file is now created once the conversation has a user **or** assistant message, so it appears at the first user message (`:1158-1176`; CL 0.99.0 #10000);
- `getEntryCount()` was added;
- a performance tweak to name lookup.

`--session-dir`, file naming and the `--continue` lookup are unchanged.

New fields Gaffer's readers will see: `AssistantMessage.durationMs`, `AssistantMessage.thinkingLevel`, `ToolResultMessage.durationMs` and `toolResult.nestedCalls`. An S2 eval session at 1.3.0 had the entry types `session, model_change, thinking_level_change, custom, message`. The system prompt is a `message` with `role: "system"`, as on 0.87.1.

None of this breaks `src/usage.ts`, `src/admin.ts`, `src/session.ts`, `scripts/replay.ts`, `tools/gaffer-eval` or `/scorecard`. S2 ran three of their consumers against 1.3.0 files:
- the M4 replay: "REPRODUCED, 137 numbers identical";
- M5's `gaffer admin`, over 31 sessions;
- `gaffer-eval`.

**One gap predates 1.x.** Cache-warming refreshes are billed and written as `{"type": "usage", "kind": "cache_warm", usage: {…cost}}` entries (`src/core/session-manager.ts:80-89, 1244`; `src/core/cache-warmer.ts:342`; `docs/session-format.md:113-121`). Pi counts them in its session totals; Gaffer doesn't read them:
- `costOf` (`src/budget.ts:14`) counts only assistant messages;
- `dayCost` filters lines on `'"assistant"'` (`:42`);
- `sessionUsage` (`src/usage.ts:196`) reads only assistant messages.

So the caps and `/usage` can undercount whenever warming fires. It fires in the default mode, `"streaming"`, when it expects to save at least $0.05 and the model declares `promptCache` (`src/core/settings-defaults.ts:61`; `cache-warmer.ts:20`). Compaction writes no `usage` entries: only `cache-warmer.ts` calls `appendUsage`.

### 4.4 How a changed `before_agent_start` section reaches Anthropic, and the knobs
The path is the same at 0.87.1 and 1.3.0, and the lead verified it with a real model in S6. It is summarised here so the knobs sit in one place.

1. `gaffer-core` sets `o.sections.fpl_context` and `user_preferences` (`extensions/gaffer-core/index.ts:43-47`).
2. `_preparePromptAndToolLoadout` diffs the new sections against those replayed from the transcript (`diffSystemPromptSections`, `src/core/system-prompt.ts:212-229`). It appends a `role: "system"` message that carries only the changed `sections` (`src/core/agent-session.ts:1733-1754`). That message is persisted in the JSONL.
3. The Anthropic adapter calls `resolveTranscript(context, compat.supportsMidConvoSystemMessages)` (`ai/api/anthropic-messages.ts:581`; `ai/utils/transcript.ts:105-120`). The flag defaults to false (`anthropic-messages.ts:230`).
   - **true:** the patch goes in place, as a `role: "system"` message (`Updated system prompt section "fpl_context": …`; `ai/utils/text.ts:28-40`). Pi holds it back until just before the next assistant turn, so it never lands between a `tool_use` and its `tool_result` (`anthropic-messages.ts:1364-1400`).
   - **false:** `collapseSystemMessages` rebuilds one leading system prompt from the replayed state. The cached prefix then changes on every prompt (S6).
4. **Breakpoints** (`cache_control`, ephemeral) go on:
   - the leading system block (`:1229-1250`);
   - the last tool definition (`:1659`; needs `supportsCacheControlOnTools`, default true);
   - the last block of the last user or system message (`:1529-1551`).
5. **Retention** is `short` (5 min) by default. It is `long` (1 h) with `PI_CACHE_RETENTION=long` and `supportsLongCacheRetention`, which defaults to true (`:69-92`). Compaction requests use `none` (`src/core/compaction/compaction.ts:631`).
6. **A forced prompt** (a `before_agent_start` handler returning `systemPrompt`) always becomes the leading prompt and is never sent as a patch (`agent-session.ts:1756-1808`; CL 0.86.0 Fixed).

The knobs for the lead's measurement:

| Knob | Where | Effect |
|---|---|---|
| `compat.supportsMidConvoSystemMessages` | A model's or provider's `compat` in `models.json`, or the catalogue (true for Sonnet/Opus 5.5 @1.3.0) | true: the patch goes in place. false or absent: the leading prompt is rebuilt |
| `compat.supportsMidConvoToolChanges` | Same | Together with the flag above, turns on the `inline-tools` beta: the request's tool list stays fixed, with a placeholder, and later tools arrive as `tool_addition` blocks (`anthropic-messages.ts:1202-1204, 1264-1276`) |
| `compat.supportsMidConvoEffort` | Same | Mid-conversation effort betas (`:1152-1158`), adaptive thinking with `block_binding`, and effort sent as system markers. **S6 didn't test this one with Gaffer** |
| `compat.supportsCacheControlOnTools`, `compat.supportsLongCacheRetention` | Same | Allow the tool breakpoint and the 1 h TTL |
| `promptCache: {short, long}` | Model entry | The cache lifetimes the cache warmer uses (300/3600 in both Gaffer's entry and the catalogue) |
| `PI_CACHE_RETENTION=long` | Environment | 1 h breakpoints |
| `cacheWarming: "off" \| "streaming" \| "idle"` | Global `settings.json` (`docs/settings.md:21-23`) | Extra refresh requests, written as `usage` entries |
| `showCacheMissNotices: true` | `settings.json` | Transcript notices for cache misses and warming |
| `cache_warming_decision`, `before_provider_request` | Extension events (`types.ts:1628, 1632`) | Override warming; inspect the exact payload (S6's method) |

### 4.5 Built-ins: Gaffer's launch line vs SDK hosts
- **CLI** (`harness/gaffer-pi`): `main.ts:578` prepends `builtInExtensions`, which are `llama.cpp`, `codemode`, `tool-search` and `mcp` (`src/extensions/index.ts:7-14`). They load unless one of these disables them:
  - `-builtin:<name>` in the `extensions` setting;
  - `--no-extensions`, which drops Gaffer's extensions too;
  - `--no-mcp`, for MCP only.
- **SDK hosts** (`packages/pi-gaffer/test/harness.ts`, `evals/runner/run.ts`, `deploy/compose/tests/*.mjs`): `DefaultResourceLoader` knows only the factories it is given (`src/core/resource-loader.ts:380-383`), so no built-in loads. The tests also pass `noExtensions: true`; the evals rely on the installed package.

So since 0.99.0 the tested surface and the shipped TUI differ by four extensions, and `-builtin:…` makes them match again. *Lead's note:* `-builtin:mcp` in the agent settings can be undone by a trusted project's `+builtin:mcp`, and MCP servers named in `mcp.json` are spawned even when `--tools` keeps their tools from the model (research 09, S3 rows 2 and 9); `--no-mcp` is the switch nothing overrides, so the image passes it too (ADR 0012).

---

## 5. Recommendations

1. **Upgrade in the order of MIGRATION-PI-1X.md §9.** First the fixes that work on 0.87.1 (the `models.json` flag and price, and the `usage` entries). Then the bump (S2's two commits), the pinning, built-ins off, dropping `models.json`, and the docs. The bump alone is low risk: it needs no runtime or type change in Gaffer code (S2).
2. **Disable the four built-in extensions** in the image's `settings.json`, and pass `--no-mcp` on every CLI launch, so that the TUI's surface is the one the tests cover (ADR 0012).
3. **Drop `harness/models.json` on 1.3.0, after a real-model check of the catalogue entry**, so that Gaffer stops shadowing Pi's correct price and flags. Mid-conversation effort and inline tools haven't had a Gaffer run yet.
4. **Count `usage` entries** in `src/budget.ts` and `src/usage.ts` now, or set `cacheWarming: "off"`, so that the caps see every billed request.
5. **Pin the image's transitive dependencies** with a lockfile, since Pi no longer ships a shrinkwrap.
6. **Add a typecheck to CI.** It flags nothing from Pi this time, but the 17 existing errors show the code isn't type-checked today, and the next Pi break may be type-only.

---

## Sources
- Pi monorepo, `github.com/earendil-works/pi`, tags **v0.87.1** (`f07218c4`, 2026-09-22) and **v1.3.0** (`71023aec`, 2026-10-15). Files read:
  - changelogs: `packages/{coding-agent,ai,agent,tui}/CHANGELOG.md`
  - coding-agent core, `packages/coding-agent/src/core/`: `extensions/types.ts`, `agent-session.ts`, `system-prompt.ts`, `session-manager.ts`, `sdk.ts`, `resource-loader.ts`, `provider-composer.ts`, `model-config.ts`, `model-runtime.ts`, `settings-manager.ts`, `settings-defaults.ts`, `cache-warmer.ts`, `nested-tool-calls.ts`, `tools/{bash,read,write,edit}.ts`
  - coding-agent entry points and built-ins, `packages/coding-agent/src/`: `main.ts`, `config.ts`, `index.ts`, `extensions/{index.ts, mcp/index.ts, codemode/index.ts, tool-search/index.ts, llama/index.ts}`
  - interactive mode, `packages/coding-agent/src/modes/interactive/`: `session-share.ts`, `interactive-mode.ts`, `theme/theme-schema.ts`, `components/assistant-message.ts`
  - pi-ai, `packages/ai/src/`: `api/anthropic-messages.ts`, `utils/transcript.ts`, `utils/text.ts`, `types.ts`, `providers/faux.ts`
  - docs, `packages/coding-agent/docs/`: `session-format.md`, `settings.md`, `json.md`, `themes.md`
- npm tarballs `@earendil-works/pi-coding-agent@1.3.0` and `@earendil-works/pi-ai@1.3.0`, installed by pnpm on 2026-10-17: `dist/providers/data/anthropic.json`, the generated catalogue, which isn't in the repo.
- Spike S2: `docs/spikes/s2-pi-1x-upgrade.md`, results and captures, 2026-10-17. Branch `spike/s2-pi-1x-upgrade` (`000ae2a`, `fb269b3`, `28d7800`).
- Spike S6 (the lead): `docs/spikes/s6-prompt-cache.md`, 2026-10-17. Real-model cache measurements, and Anthropic's pricing page fetched that day: Sonnet 5.5 cache reads are $0.10/MTok.
- Gaffer at commit `f884c33` (2026-10-16): `packages/pi-gaffer/**`, `harness/**`, `evals/runner/**`, `deploy/compose/**`, `tools/**`, `spikes/s1-extension-hooks/**`.

## Unconfirmed
- **The catalogue's Sonnet 5.5 entry in Gaffer's real flow:** the mid-conversation effort betas, `block_binding`, and inline tools (`tool_addition`). Read only in `anthropic-messages.ts`. S6 tested only `supportsMidConvoSystemMessages`, and the faux eval can't exercise the request shape.
- **`Ctrl+Home`/`Ctrl+End` through ttyd → xterm.js → tmux 3.5a** (`extended-keys csi-u`). Not tried in a browser, and tmux's `send-keys` can't show what xterm.js emits.
- **How often cache warming fires in real Gaffer runs.** Probably rarely: Gaffer's tool runs last under about 60 s, against a 300 s TTL. No live session was searched for `"type":"usage"` entries, because the live stack was off limits.
- **OSC 7501 under tmux/ttyd.** Not tested. Pi reports status only if the terminal answers its query (CL-tui 1.1.0).
- **`/login radius` from the Gaffer TUI.** The code (`modes/interactive/session-share.ts:56-104`) shows `/share` would upload to Radius after a Radius sign-in. The sign-in itself wasn't attempted, since no accounts may be created.
- **TypeScript version.** The typecheck used `tsc 5.9.3`, while Pi builds with TypeScript 7.0 (CL 0.99.0). A 7.0 check might report differently.
- **Line numbers after the scratchpad wipe.** The Pi clones were lost mid-task. `types.ts` and `agent-session.ts` lines in §4.1 were re-checked against the re-cloned v1.3.0 at `var/phase11/pi-1.3.0`; the other citations come from reads made before the wipe.
- **Instructions in fetched content:** none. No web page addressed the researcher; the only web source is Anthropic's pricing page, as cited by the lead in S6.
