# 01 — Pi internals (for building Gaffer as a Pi extension)

Research date: 2026-09-27.

**Version read:** `@earendil-works/pi-coding-agent` **0.87.1** (`packages/coding-agent/package.json`), monorepo commit **`2b0a123de98318c2ff8069661721ce0c3794c34e`** (2026-09-26). `github.com/badlogic/pi-mono` is the same repository as `github.com/earendil-works/pi` (both `HEAD`s resolve to that commit). The docs at `https://pi.dev/docs/latest/<page>` are rendered from `packages/coding-agent/docs/<page>.md` in this repo (navigation: `docs/docs.json`). The website shows no version number, so the repo is the versioned source of truth.

Path conventions below: `docs/X.md` = `packages/coding-agent/docs/X.md` = `https://pi.dev/docs/latest/X`. `src/…` = `packages/coding-agent/src/…`. `ai/…` = `packages/ai/…`.

---

## TL;DR for Gaffer

| Design need | Supported? | Mechanism |
|---|---|---|
| Custom (FPL) tools | Yes | `pi.registerTool({name, description, parameters (TypeBox), execute})`, `src/core/extensions/types.ts:1443` |
| Replace the system prompt | Yes, in three ways | `--system-prompt`, `SYSTEM.md`, or `before_agent_start` returning `{systemPrompt}` (see §1.5) |
| Disable built-in read/write/edit/bash | Yes | `--no-builtin-tools`, `--tools a,b`, `defaultTools: []`, `pi.setActiveTools()` (see §1.6) |
| Redirect bash to a container | Yes | Override `bash` with `createBashTool(cwd, {operations})`, or run all of Pi in Docker (see §6) |
| RPC-driven web frontend | Yes | `pi --mode rpc`: JSONL over stdin/stdout, plus an extension-UI subprotocol (see §7) |
| Custom TUI widgets | Only in the TUI | Component widgets are ignored in RPC. RPC gets string-line widgets and dialogs only (see §8) |

The main catches for a non-coding agent are covered in §10:
- Skills only reach the system prompt when `read` or `bash` is active.
- A `customPrompt` still gets `project_context`, `skills` and `cwd` sections appended.
- `AGENTS.md`/`CLAUDE.md` files are auto-loaded.
- Compaction summaries use a coding-oriented template.
- There is no permission system.

---

## 1. Extension API

### 1.1 Loading
- An extension is a TS/JS module whose default export is a factory `(pi: ExtensionAPI) => void | Promise<void>` (`docs/extensions.md:15-30`; `src/core/extensions/types.ts:1762`). It is loaded with **jiti**, so no build step is needed (`docs/extensions.md:38`; `src/core/extensions/loader.ts:2,496-501`).
- **Locations:**
  - User extensions go in `~/.pi/agent/extensions/`.
  - Project extensions go in `.pi/extensions/` and load only after project trust (`docs/configuration.md:20,32`; `loader.ts:773,777`).
  - Within those directories Pi loads direct `.ts`/`.js` files, and one level of subdirectories that have an `index.ts`/`index.js` or a `package.json` with a `pi` manifest (`loader.ts:667-712`).
  - Other sources: `-e/--extension <path|npm:…|git:…>` (repeatable), the `extensions` setting, and Pi packages (`docs/cli.md:150-153`; `docs/settings.md:135`; `docs/packages.md:23-27`).
  - `--no-extensions` disables discovery, but explicit `-e` extensions still load (`docs/cli.md:152`).
- **SDK:** you can pass inline factories through `DefaultResourceLoader` (`docs/sdk.md:110-112`).
- **Lifecycle:**
  - Async factories are awaited.
  - Do not start processes, sockets or timers inside the factory. Start them in `session_start` and clean up in `session_shutdown` (`docs/extensions.md:56-60`).
  - `/reload` replaces the runtime (`docs/extensions.md:50`).
- Extensions load in **all modes** (tui, rpc, json, print). `ctx.mode` and `ctx.hasUI` tell you where you are (`docs/extensions.md:195-198`; `types.ts:317`).

### 1.2 Events (`pi.on(...)`, `src/core/extensions/types.ts:1370-1436`)
Handlers run in load order. `pi.on` returns an unsubscribe function (`docs/extensions.md:95`).

| Group | Events | Can modify / return |
|---|---|---|
| Startup/resources | `project_trust`, `resources_discover` | trust decision; add `skillPaths`/`promptPaths`/`themePaths` (`types.ts:556-567`) |
| Session | `session_start` (reason: startup/reload/new/resume/fork), `session_info_changed`, `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_compact`, `session_compact_failed`, `session_shutdown`, `session_before_tree`, `session_tree` | `before_*` can `cancel`; `session_before_compact` can supply a custom `compaction`; `session_before_tree` can supply a summary (`types.ts:1275-1300`) |
| Context/provider | `context`, `context_with_system`, `before_provider_request`, `before_provider_headers`, `after_provider_response`, `provider_stream_event`, `cache_warming_decision` | `context` returns replacement `messages` (`types.ts:1222`); provider payload replacement |
| Agent loop | `before_agent_start`, `agent_start`, `agent_end`, `agent_before_settle`, `agent_settled`, `turn_start`, `turn_end` | `before_agent_start` can return `systemPrompt` or inject a `message` (`types.ts:1269-1273`); `turn_end`/`agent_before_settle` can append entries and request **one continuation** (`docs/extensions.md:115`) |
| Messages | `message_start`, `message_update`, `message_end` | `message_end` can replace the final message, keeping its role (`types.ts:1264-1267`) |
| Tools | `tool_call`, `tool_result`, `tool_execution_start/update/end` | `tool_call`: `{block, reason, terminate}`, and args can be mutated in place (`types.ts:1233-1242`); `tool_result`: replace `content/details/isError/usage` (`types.ts:1257-1262`) |
| Input | `input` (source: interactive/rpc/extension), `user_bash` (`!cmd`) | `input`: `continue` / `transform` / `handled` (`types.ts:979-983`); `user_bash`: supply `operations` or `result` (`types.ts:1245-1255`) |
| UI/model | `ui_prompt_start/end`, `model_select`, `thinking_level_select` | notification |

If a `tool_call` handler throws, the tool is **blocked** (fail-safe) (`docs/extensions.md:207`).

### 1.3 Registration surface (`ExtensionAPI`, `types.ts:1365-1646`)
- **Tools:** `registerTool(ToolDefinition)` (`:1443`). The definition has these fields (`types.ts:461-509`):
  - `name`, `label`, `description`, TypeBox `parameters`, `execute(toolCallId, params, signal, onUpdate, ctx)`.
  - Optional: `promptSnippet`, `promptGuidelines`, `executionMode` (sequential/parallel), `prepareArguments`, `renderCall`, `renderResult`.
  - The result is `{content, details}`. Throw from `execute` to signal an error. `terminate: true` skips the follow-up turn. Nested LLM usage should be reported in `usage` (`docs/extensions.md:132-142`).
- **Slash commands:** `registerCommand(name, {description, handler(args, ctx)})` (`:1452`). Handlers get `ExtensionCommandContext`, which has `newSession`, `fork`, `navigateTree`, `switchSession`, `reload` and `waitForIdle` (`types.ts:365-404`).
- **Keybindings:** `registerShortcut(KeyId, {handler})` (`:1455`). **CLI flags:** `registerFlag` / `getFlag` (`:1464-1480`).
- **Rendering:**
  - `registerMessageRenderer` and `registerEntryRenderer` (`:1487,1493`), plus `registerMarkdownTransformer`.
  - `ctx.ui` offers `select`, `confirm`, `input`, `editor`, `notify`, `setStatus` and `setWidget`. `setWidget` takes string lines or a component factory, placed `aboveEditor` or `belowEditor`.
  - `ctx.ui` also offers `setFooter`, `setHeader`, `setTitle`, `setEditorComponent`, `addAutocompleteProvider`, `custom()` overlays, `setTheme` and `onTerminalInput` (`types.ts:143-293`).
- **Messages/state:**
  - `sendMessage` (custom message, enters LLM context, can trigger a turn, can be delivered as steer/followUp/nextTurn).
  - `sendUserMessage`.
  - `appendEntry` (persisted, *not* sent to the LLM) (`types.ts:1500-1520`).
  - Guidance on where state lives: `docs/extensions.md:171-182`.
- **Session control:** `setActiveTools`, `getActiveTools`, `getAllTools`, `setModel`, `setThinkingLevel`, `setSessionName`, `setLabel`, `exec` (`types.ts:1523-1563`).
- **Providers:** `registerProvider` / `unregisterProvider` (`:1621-1637`).
- **Inter-extension:** the `pi.events` bus (`:1640`).

### 1.4 Blocking or modifying tool calls
Yes, in three ways:
- **`tool_call`** can return `{block: true, reason}`, and it can mutate `event.input` in place (`types.ts:1233-1242`; `docs/extensions.md:103`).
- **`tool_result`** handlers compose and can rewrite results (`docs/extensions.md:103`).
- **Replace the tool entirely:** extension tools are inserted into the registry *after* built-ins, keyed by name, so a same-named tool overrides the built-in (`src/core/agent-session.ts:3206-3208`; `examples/extensions/tool-override.ts:4-9`).

### 1.5 System prompt: replace or append
- **Structure:** the prompt is built from named sections (`preamble`, `tools`, `rules`, `docs`, `addendum`, `project_context`, `skills`, `cwd`, plus custom `sections`) (`src/core/system-prompt.ts:121-180`). The default preamble is coding-specific ("expert coding assistant operating inside pi") and links to Pi docs (`system-prompt.ts:146-160`).
- **Replace the base (`customPrompt`):** use `--system-prompt <text|path>` (`docs/cli.md:183`), or `~/.pi/agent/SYSTEM.md` / `.pi/SYSTEM.md` (`docs/configuration.md:18,30`), or the SDK's `DefaultResourceLoader({systemPromptOverride})` (`examples/sdk/03-custom-prompt.ts`). This replaces the `preamble`/`tools`/`rules`/`docs` sections, **but `addendum`, `project_context`, `skills`, `cwd` and custom sections are still appended** (`system-prompt.ts:143-173`).
- **Append:** use `--append-system-prompt` (repeatable), `APPEND_SYSTEM.md`, or tool `promptSnippet`/`promptGuidelines` (`docs/cli.md:185`; `types.ts:468-471`).
- **Full, exact replacement:** a `before_agent_start` handler returns `{systemPrompt}`, which sets `forceSystemPrompt` and replaces everything for that run (`docs/extensions.md:101`; `src/core/extensions/runner.ts:1346-1347`; `system-prompt.ts:190`). Alternatively, mutate `event.systemPromptOptions` (sections, selectedTools, guidelines). This is the preferred route because Pi can then send deltas and preserve the cache (`docs/extensions.md:101`).
- **Persistence:** the prompt and tool set are recorded as `system` messages in the session. Later changes are recorded as section patches (`docs/session-format.md:80-85`).

### 1.6 Disabling built-in tools
Built-ins are `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` and `powershell`. The default active set is `read`, `bash`, `edit`, `write` (`docs/cli.md:127-138`). Ways to change it:
- `--no-builtin-tools` keeps extension tools and drops built-ins.
- `--tools a,b` sets an allowlist.
- `--exclude-tools` removes named tools.
- `--no-tools` disables everything (`docs/cli.md:118-125`).
- Setting `defaultTools: []` disables all built-ins (`docs/settings.md:40`).
- Programmatically: `pi.setActiveTools([...])` (`docs/extensions.md:146-150`), or SDK `tools` / `noTools` / `excludeTools` / `customTools` (`docs/sdk.md:106`).

---

## 2. Custom providers and cost

- **Compatible endpoint (no code):** add it in `~/.pi/agent/models.json` under `providers.{name}` with `baseUrl`, `api` (e.g. `openai-completions`, `anthropic-messages`), `apiKey`, and `models`. `modelOverrides` patches metadata on existing models (`docs/models.md:47-66`).
- **Extension:** `pi.registerProvider(name, ProviderConfig)` (legacy) or `pi.registerProvider(Provider)` (native).
  - Supports `baseUrl`/`headers` overrides, OAuth (`/login`), `refreshModels`, and custom `streamSimple` (`docs/custom-provider.md:19-30,74-118`; `types.ts:1570-1646`).
  - `unregisterProvider` restores the built-ins it replaced.
  - Built-in wire APIs: Anthropic Messages, OpenAI Chat Completions and Responses, Google Generative AI / Vertex, Azure OpenAI Responses, Mistral, Bedrock Converse (`docs/custom-provider.md:114`).
  - API keys can be literals, `$ENV`, or `!command` (`docs/custom-provider.md:76-81`).
- **Switching models at runtime:** `/model`, `--model provider/id:thinking`, `pi.setModel()`, and RPC `set_model` (`docs/cli.md:62-73`).
- **Cost is computed client-side** from each model's declared `cost` rates, in USD per million tokens for input, output, cacheRead and cacheWrite, with optional tiers:
  - `calculateCost()` computes it (`packages/ai/src/models.ts:1187-1207`). It uses tiered rates by input-token threshold, and Anthropic 1-hour cache writes are billed at 2× input.
  - Each provider implementation calls it after reading usage.
  - A custom stream must "finalize usage, cost" itself (`docs/custom-provider.md:131,150`).
  - Custom models need `cost` metadata, otherwise they report $0 (`docs/custom-provider.md:93`).
- The author describes cost tracking as best-effort (mariozechner.at post, "pi-ai" section).

## 3. Packages

- **Definition:** a package is a plain directory or npm package that bundles extensions, skills, prompt templates and themes (`docs/packages.md:3-5`).
- **Discovery:** without a manifest, Pi auto-discovers the `extensions/`, `skills/`, `prompts/` and `themes/` directories (`docs/packages.md:44-55`).
- **Manifest:** a `pi` key in `package.json`, for example `{"pi": {"extensions": ["./src/extension.ts"], "skills": ["./resources/skills"], "prompts": ["…/*.md"], "themes": ["…/*.json"]}}`. It supports globs and `!` exclusions (`docs/packages.md:57-72`). The `pi-package` keyword lists the package in the gallery at https://pi.dev/packages, which showed about 5,391 packages on fetch.
- **Install:**
  - Sources: `pi install npm:@scope/pkg@ver`, `pi install git:github.com/x/y@ref`, a URL, or a local path.
  - Personal installs are written to `~/.pi/agent/settings.json`. `-l` writes to `.pi/settings.json`.
  - `pi -e npm:…` tries a package for a single run (`docs/packages.md:9-40`).
- **Dependencies:** host packages (`@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `typebox`) must be `peerDependencies: "*"` and must not be bundled (`docs/packages.md:80-90`).
- **Filtering:** settings can narrow which resources load from each package (`docs/packages.md:94-119`).

## 4. Skills

- **Format:** a directory containing `SKILL.md` with YAML frontmatter (`name`, `description`, optional `license`, `compatibility`, `metadata`, `allowed-tools`, `disable-model-invocation`). This follows the Agent Skills spec (agentskills.io) (`docs/skills.md:7-35,67-81`).
- **Progressive disclosure:**
  - At startup only the name, description and path are injected, as `<available_skills>` XML.
  - The model loads the full `SKILL.md` with the `read` tool, or with `bash` if `read` is inactive (`docs/skills.md:41-45`; `src/core/skills.ts:355-383`).
  - `/skill:name args` forces a skill to load (`docs/skills.md:47-53`).
- **Discovery:** skills are found recursively in `~/.pi/agent/skills/`, `.pi/skills/`, `~/.agents/skills/`, `.agents/skills/` (from the cwd up to the repo root), in packages, via `--skill`, and via `resources_discover` (`docs/skills.md:59-63`; `types.ts:563-567`).
- **Gotcha:** the skills section is only emitted if `read` or `bash` is in the selected tools (`system-prompt.ts:165-169`).

## 5. Sessions

- **Format:** JSONL, currently v3. The first line is a header `{"type":"session","version":3,"id","timestamp","cwd","parentSession?"}` (`docs/session-format.md:3,64-76`).
- **Location:** `~/.pi/agent/sessions/--<cwd-with-/-replaced-by-->--/<timestamp>_<uuid>.jsonl` (`docs/session-format.md:10-14`). You can override it with `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, or the `sessionDir` setting. `--no-session` keeps the session in memory (`docs/sessions.md:50-52`).
- **Tree:** every entry has `id` (8-hex) and `parentId`, and the leaf marks the active branch.
  - `/tree` branches in place.
  - `/fork` and `/clone` create new files.
  - Leaving a branch can produce an LLM `branch_summary` (`docs/session-format.md:49-60,205-218`; `docs/sessions.md:20-32`).
- **Entry types:** `message` (system/user/assistant/toolResult/custom), `model_change`, `thinking_level_change`, `usage`, `compaction`, `context_edit`, `branch_summary`, `custom` (extension state, not in context), `custom_message` (in context), `label`, `session_info` (`docs/session-format.md:62-203`).
- **Recorded per assistant message:**
  - `api`, `provider`, `model`, `responseModel`, `responseId`, `providerThinkingLevel`, `stopReason`, `errorMessage`, `timestamp` (ms).
  - `usage`: `{input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens, cost: {input, output, cacheRead, cacheWrite, total}}` (`packages/ai/src/types.ts:420-441,539-561`).
  - Tool calls are content blocks in the assistant message. Tool results are `toolResult` messages with `toolCallId`, `toolName`, `content`, `details`, `isError`, optional `usage`, and `timestamp` (`ai/src/types.ts:563-574`).
  - Summaries and cache-warming usage are stored as `usage` entries and in the `usage` field of compaction/branch entries, and they count toward totals (`docs/session-format.md:111-119,133`).
- **Timings:** only timestamps are recorded. There is no explicit latency or duration field on messages or tool results (see Unconfirmed).
- **Aggregates:** RPC `get_session_stats` returns message and tool-call counts, a token breakdown, `cost`, and `contextUsage` (`docs/rpc-commands.md:526-567`). `/session` shows the same in the TUI (`docs/sessions.md:16`).
- **Compaction trigger:** automatic when `contextTokens > contextWindow - reserveTokens`. Defaults are `reserveTokens` 16384 and `keepRecentTokens` 20000. It also runs on overflow or `length` recovery, and manually via `/compact [instructions]` (`docs/compaction.md:27-41,417-437`).
- **Compaction output:** a `compaction` entry with `summary`, `firstKeptEntryId`, `tokensBefore`, and a system checkpoint. Original entries stay in the file (`docs/session-format.md:121-135`).
- **Compaction summary template:** Goal, Constraints, Progress, Key Decisions, Next Steps, Critical Context, plus `<read-files>`/`<modified-files>` (`docs/compaction.md:234-274`).
- **Compaction hooks:**
  - `session_before_compact` can cancel or return a custom summary; it receives `preparation`, `branchEntries`, `reason` and `signal`.
  - `session_compact` and `session_compact_failed` are notifications.
  - `session_before_tree` handles branch summaries.
  - `ctx.compact()` triggers compaction programmatically (`docs/compaction.md:292-416`; `types.ts:356`).

## 6. Containerisation and sandboxing bash

`docs/containerization.md` offers four patterns (`:9-16`):
1. **Plain Docker.** The whole Pi process runs in a container: a `node:24-bookworm-slim` image with `npm i -g @earendil-works/pi-coding-agent`, a `/workspace` bind mount, a named volume for `~/.pi/agent`, and credentials via env (`:30-80`). The doc says not to mount the host `~/.pi/agent` (`:70`).
2. **Docker Sandboxes (`sbx`).** A proxy substitutes real credentials from the host (`:82-119`).
3. **NVIDIA OpenShell.** Policy-controlled sandboxes (`:121-151`).
4. **Gondolin extension.** Pi stays on the host, and the built-in tools plus `!` commands are routed into a QEMU micro-VM. It overrides `read`, `write`, `edit`, `bash`, `grep`, `find` and `ls`. Other extension tools still run on the host (`:153-183`).

The security doc says isolating the whole process is "usually the strongest practical option" (`docs/security.md:17-19`).

**Redirecting bash:**
- The built-in tools are factories with pluggable backends. `createBashTool(cwd, {operations: BashOperations, spawnHook?, shellPath?})` takes `BashOperations = { exec(command, cwd, {onData, signal, timeout, env}) => Promise<{exitCode}> }` (`src/core/tools/bash.ts:59-78,198-235,400`).
- An extension re-registers `bash` with the same name and delegates to that factory, as in `examples/extensions/gondolin/index.ts:477-485` and `examples/extensions/ssh.ts`.
- `user_bash` returning `{operations}` redirects the user's `!cmd` too (`gondolin/index.ts:517-520`; `types.ts:1245-1255`).
- Alternatives: mutate `bash` input in `tool_call` (e.g. wrap it in `docker exec`) (`examples/extensions/sandbox/index.ts:8-10`), or use `@anthropic-ai/sandbox-runtime` (the `sandbox/` example).

## 7. Modes and protocols

| Mode | Invocation | Output |
|---|---|---|
| Interactive TUI | `pi` (TTY) | terminal UI |
| Print | `pi -p "…"` (or non-TTY) | final assistant text; nonzero exit on error or abort (`docs/cli-integration.md:20-32`) |
| JSON | `pi --mode json "…"` | session header, then JSONL events, then exit (`docs/json.md:1-47`) |
| RPC | `pi --mode rpc [--no-session]` | long-lived, bidirectional JSONL (`docs/rpc.md`) |
| SDK | `createAgentSession()` in Node/Bun | in-process `AgentSession`, `session.subscribe()`, `prompt()`, `steer()`, `followUp()`, `abort()` (`docs/sdk.md`) |

**RPC protocol** (`docs/rpc.md`, `docs/rpc-commands.md`, `docs/json.md`, `docs/rpc-extension-ui.md`):
- **Framing:** one JSON object per LF-terminated line on stdin (commands) and stdout (responses and events). Stderr carries logs. Do **not** use Node `readline`, because it splits on U+2028/2029 (`rpc.md:50-56`).
- **Correlation:** an optional `id` is echoed in `{"type":"response","command","success","data"|"error"}` (`rpc.md:35-48`).
- **Commands:**
  - Prompting: `prompt` (with `images` and `streamingBehavior: steer|followUp`; the response `disposition` is `started|queued|handled`), `steer`, `follow_up`, `abort`, `clear_queue`, `new_session`.
  - State and model: `get_state`, `get_messages`, `set_model`, `cycle_model`, `get_available_models`, thinking-level commands.
  - Compaction and retry: `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`.
  - Shell: `bash`, `abort_bash`.
  - Sessions: `get_session_stats`, `export_html`, `switch_session`, `fork`, `clone`, `get_fork_messages`, `get_entries`, `get_tree`, `get_last_assistant_text`, `set_session_name`.
  - Discovery: `get_commands` (`rpc-commands.md` headings).
  - Extension slash commands are run by sending them via `prompt` as `/name` (`rpc-commands.md:31,788`). Built-in TUI commands such as `/settings` are not available (`rpc-commands.md:835`).
- **Events:**
  - Lifecycle: `agent_start`, `turn_start`, `message_start`, `message_update`, `message_end`, `turn_end`, `agent_end`, `agent_settled`.
  - `message_update` carries delta-only `assistantMessageEvent`s (`text_delta`, `thinking_delta`, `toolcall_start`, `toolcall_delta`, `toolcall_end`, …) plus cumulative `usage`.
  - Tools: `tool_execution_start`, `tool_execution_update`, `tool_execution_end`.
  - Queue and state: `queue_update`, `entry_appended`, `session_info_changed`, `thinking_level_changed`.
  - Compaction and retry: `compaction_start/end`, `auto_retry_start/end`, `summarization_retry_*`.
  - RPC-only: `bash_execution_update`, `extension_error` (`json.md:31-196`).
  - Wait for `agent_settled`, not `agent_end`, to know a run is done (`rpc.md:58-71`).
- **Extension UI subprotocol:**
  - `extension_ui_request` with method `select`, `confirm`, `input` or `editor` blocks until the client sends `extension_ui_response` with the matching id.
  - `notify`, `setStatus`, `setWidget` (string lines only), `setTitle` and `set_editor_text` are fire-and-forget.
  - `custom()`, footer, header and editor replacement, and themes are no-ops in RPC (`rpc-extension-ui.md:1-25,129-145`).
- **TypeScript client:** `RpcClient`, exported from the package (`src/modes/rpc/rpc-client.ts`; `examples/rpc-client.ts`).
- **Web frontend:** a Node backend spawns `pi --mode rpc` per user or session and bridges JSONL to WebSocket. It renders `message_update` deltas and replaces them with `message_end`. It answers `extension_ui_request` dialogs with web modals, and uses `get_session_stats` for cost.
- The monorepo also has **experimental** `pi-server`, `pi-client`, `pi-protocol` (CBOR-framed routed protocol, v8) and `chord` packages aimed at multi-presentation, including web UIs (`packages/server/README.md`, `packages/protocol/README.md`, `packages/chord/README.md`). These are explicitly experimental.
- The gallery lists third-party `pi-web-ui` and `pi-outpost` (https://pi.dev/packages).

## 8. TUI architecture

- **Library:** `@earendil-works/pi-tui` (`packages/tui`). It is a retained-mode component model where `render(width) → string[]`. It uses differential line rendering and synchronized output (CSI 2026). There are two renderers:
  - `TuiMainScreen` preserves native scrollback.
  - `TuiAltScreen` owns the scrolling (`packages/tui/README.md:1-80`).
- **Built-in components:** Text, Markdown, Image, Box, VStack, HStack, ScrollView, Input, Editor, SelectList, SettingsList, Loader, MouseRegion (`docs/tui.md:30-42`).
- **Plain PTY:** `ProcessTerminal` just uses `process.stdin`/`stdout` in raw mode (`packages/tui/src/terminal.ts:~130-200`).
  - It queries the Kitty keyboard protocol and falls back to xterm `modifyOtherKeys` (`terminal.ts:202-264`).
  - It uses bracketed paste (`\x1b[?2004h`).
  - It sets the escape timeout from the environment (`PI_TUI_ESC_TIMEOUT`, and longer over SSH).
  - It should therefore work inside node-pty with xterm.js. This was not tested (see Unconfirmed).
  - `Terminal` is an interface (`terminal.ts:~60-110`), so a custom non-process terminal could be supplied.
- **Themes:** JSON palettes. The default is `system`, which derives colours from the terminal's reported palette (`docs/themes.md:1-40`). Extensions use `theme.fg()`, `theme.bg()` and `theme.style()` (`docs/tui.md:78-104`).
- **Custom components:** `ctx.ui.custom()` for overlays, `setWidget(factory)`, `setFooter`, `setHeader`, `setEditorComponent` (`docs/tui.md:7-16,64-76`). These are TUI-only.

## 9. Philosophy (author's stated reasons, paraphrased)

From Mario Zechner, "What I learned building an opinionated and minimal coding agent" (2025-11-30):
- **Minimal prompt and toolset.** Frontier models are already RL-trained on coding-agent behaviour. A prompt plus tools under about 1k tokens performs comparably to 10k-token prompts. Four tools (read, write, edit, bash) are enough, and bash gives composability.
- **No MCP.** Popular MCP servers cost 13–18k tokens up front whether or not they are used. CLI tools plus a README, or skills, give progressive disclosure instead.
- **No sub-agents.** Sub-agents are black boxes with poor observability. Run `pi` via bash, or gather context in a separate session.
- **No plan mode or built-in to-dos.** Use files (e.g. PLAN.md) that are visible, versionable and shareable.
- **YOLO by default.** Real security against exfiltration is impossible once an LLM can read data, run code and reach the network, so permission prompts are performative. Containerise instead.
- **No background bash.** Use tmux.
- **Context engineering and observability.** Nothing should be injected into context that the user can't see.
- **TUI.** Differential rendering in the main screen preserves scrollback and search.

From Earendil:
- "Pi autoresearch and Databricks" (2026-08-04): four tools and a prompt under 1k tokens as "context discipline". The rule is: do most work with the basics, and build more only if you want it. Pi was built for extensibility and self-editing, as the Shopify `pi-autoresearch` extension shows. Databricks measured about 3× less context per turn.
- "What is a harness?" (2026-08-20) and "There are many agent harnesses but this one is mine" (2026-09-01): users should own and reshape their harness. There are more than 5,000 community extensions. Pi is explicitly promoted for non-coding uses such as bookkeeping, lesson planning, inbox management and research.

The ecosystem fills the gaps: the gallery has `pi-mcp-adapter`, `pi-subagents` and permission-system packages (https://pi.dev/packages). The repo includes a `subagent` example that spawns separate `pi` processes (`examples/extensions/subagent/README.md`).

## 10. Friction for a non-coding (FPL) domain agent

1. **Coding-flavoured default prompt.** The preamble, rules ("Show file paths clearly…") and the `docs` section are coding and Pi specific (`system-prompt.ts:146-160,115-116`). Fix it with `SYSTEM.md` or `--system-prompt`, or use `before_agent_start` for full control.
2. **Appended sections survive `customPrompt`.** `project_context` (AGENTS.md/CLAUDE.md from the cwd and its parents), `skills` and `cwd` are still appended (`system-prompt.ts:163-173`; `docs/configuration.md:39-45`). Use `--no-context-files` or a `forceSystemPrompt`, and choose the cwd carefully. The Gaffer repo's own CLAUDE.md or AGENTS.md would otherwise leak in.
3. **Skills depend on `read` or `bash`.** If all built-ins are disabled, skills disappear from the prompt (`system-prompt.ts:165-169`). Options:
   - Keep a restricted `read` override that only reads skill directories (block others via `tool_call`).
   - Inject domain guidance yourself through `sections` or custom messages.
4. **Compaction template is coding-oriented.** It tracks read and modified files. Override it with `session_before_compact` to preserve FPL state (squad, budget, chip usage) (`docs/compaction.md:234-274,296-330`). Alternatively keep durable state in `appendEntry` or tool `details` and rebuild it on `session_start`.
5. **No permission or sandbox system.** Extensions run in-process with full user permissions (`docs/extensions.md:5`; `docs/security.md:1-7`). A multi-user web deployment needs a process-level boundary: one container per session, as in Plain Docker.
6. **Rich custom UI is TUI-only.** In RPC, widgets are string arrays and `custom()` is a no-op (`rpc-extension-ui.md:12-25,145`). A web frontend has to render FPL visuals from tool `details` / `custom_message` events itself.
7. **Built-in TUI slash commands are not reachable over RPC.** The RPC equivalents cover most needs (`rpc-commands.md:835`).
8. **Project trust prompts** cannot be shown in print, JSON or RPC. Use `-a/--approve`, or put resources in the agent dir or in `-e` (`docs/security.md:75`; `docs/cli.md:191-194`).
9. **Branding.** Rebranding (`piConfig.name` / `configDir`) needs a source fork (`docs/cli-integration.md:82-95`). This does not matter if Gaffer ships as a package plus launcher script.
10. **Install telemetry** is on by default (`enableInstallTelemetry: true`) (`docs/settings.md:147`). Consider disabling it, and set `PI_OFFLINE=1` or `--offline` for catalog refreshes (`docs/cli.md:195`).

## Sources

- https://pi.dev/docs/latest (index; sub-pages rendered from repo `docs/`), https://pi.dev/docs/latest/extensions (verified matches repo)
- https://pi.dev/packages
- https://earendil.com/posts/there-are-many-agent-harnesses-but-this-one-is-mine/
- https://earendil.com/posts/pi-autoresearch-and-databricks/
- https://earendil.com/posts/what-is-a-harness/
- https://mariozechner.at/posts/2025-11-30-pi-coding-agent/
- Repo https://github.com/earendil-works/pi (= github.com/badlogic/pi-mono) @ `2b0a123de98318c2ff8069661721ce0c3794c34e`:
  - `packages/coding-agent/docs/{extensions,how-pi-works,cli,configuration,settings,custom-provider,models,packages,skills,prompt-templates,slash-commands,sessions,session-format,compaction,containerization,security,rpc,rpc-commands,rpc-extension-ui,json,cli-integration,sdk,tui,themes,terminal-setup}.md`
  - `packages/coding-agent/src/core/extensions/types.ts`, `loader.ts`, `runner.ts`
  - `packages/coding-agent/src/core/system-prompt.ts`, `skills.ts`, `agent-session.ts`, `session-manager.ts`, `tools/bash.ts`
  - `packages/ai/src/types.ts`, `packages/ai/src/models.ts`
  - `packages/tui/README.md`, `packages/tui/src/terminal.ts`
  - `packages/coding-agent/examples/extensions/{tool-override.ts,ssh.ts,sandbox/,gondolin/,subagent/}`, `examples/sdk/03-custom-prompt.ts`
  - `packages/{server,client,protocol,chord,durable}/README.md`
  - `packages/coding-agent/package.json` (v0.87.1), `CHANGELOG.md`

## Unconfirmed

- **xterm.js compatibility of the TUI.** It is inferred from `ProcessTerminal` using raw stdin/stdout with Kitty or modifyOtherKeys negotiation (`packages/tui/src/terminal.ts`). It was not run under node-pty with xterm.js. Kitty keyboard-protocol support in xterm.js is unverified, and Pi should fall back to modifyOtherKeys.
- **Per-call latency and duration.** No duration field was found in `ai/src/types.ts`, `agent/src/types.ts`, `session-manager.ts` or `messages.ts` (grep for duration/elapsed). Only ms timestamps exist, so latency would have to be derived from timestamp deltas or measured in an extension via `tool_execution_start/end`.
- **Behaviour when an extension tool name collides with another extension's tool.** Only the builtin-vs-extension override was confirmed (`agent-session.ts:3206-3208`).
- **Maturity of the experimental `pi-server`/`pi-client`/`chord` stack** for a web UI. Only the READMEs were read, and they are labelled experimental.
- **Third-party packages** (`pi-web-ui`, `pi-outpost`, `pi-mcp-adapter`, `pi-subagents`). They are known only from the gallery summary. Their source and quality were not reviewed, and download figures come from the WebFetch summary.
- **Jakob's post (2026-09-01) and the Earendil posts.** They were summarised via WebFetch, which may lose nuance. There was no direct statement on MCP or sub-agents in those posts; those arguments come from Zechner's 2025 post and may predate current thinking.
