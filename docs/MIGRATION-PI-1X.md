# Migrating Gaffer from Pi 0.87.1 to Pi 1.3.0

**Status:** Phase 1.1 plan, 2026-10-18 · **Decisions:** [ADR 0009](decisions/0009-pi-version-policy.md) (version policy), [ADR 0010](decisions/0010-context-as-section-patches.md) (model entry, prices, `usage` entries), [ADR 0012](decisions/0012-builtins-locked-off.md) (built-ins locked off), [ADR 0013](decisions/0013-gaffer-terminal.md) (command surface) · **Evidence:** [spike S2](../spikes/s2-pi-1x-upgrade/README.md), [research 07](research/07-pi-1x-migration.md), [spike S6](../spikes/s6-prompt-cache/README.md), [spike S3](../spikes/s3-mcp-lockdown/README.md), [spike S10](../spikes/s10-real-model-1x/README.md) · **Roadmap:** M1.1-0 and M1.1-1

**Bottom line.** Gaffer runs on Pi 1.3.0 with no change to extension or `src/` code. Spike S2 bumped the versions and fixed one test that hard-coded `"0.87.1"`, with these results:
- 237/237 tests pass;
- the TypeScript error set is identical to 0.87.1's;
- the image builds, and the adapted `verify.sh` passes;
- the faux eval passes: 30/30 valid, p50 51.7 s, the same as 0.87.1.

Six things still need a decision or a small change. Two of them change behaviour or money:
- `harness/models.json` now **replaces** Pi's own Sonnet 5.5 entry.
- The built-in MCP, codemode, tool-search and llama.cpp extensions now load in the TUI.

The other four:
- the image install is no longer pinned past the top-level package;
- cache-warming spend is invisible to Gaffer's budget;
- the docs name the old Home/End keys;
- the theme `$schema` URL is stale.

Citations: `file:line @v1.3.0` is the Pi source at tag v1.3.0 (`packages/coding-agent/src/…` unless another package is named); `CL x.y.z` is `packages/coding-agent/CHANGELOG.md` at that release. A `~` marks a line range read from a listing rather than checked line by line. Gaffer paths are relative to the repository root, at commit `f884c33`.

Status values: **unchanged** (same API and the behaviour Gaffer relies on), **changed** (still works, but the semantics or surroundings moved), **removed**.

## 1. Packages, image and install

| Item | Where Gaffer uses it | Status at 1.3.0 | Change Gaffer needs | Citation |
|---|---|---|---|---|
| `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui` dev deps | `packages/pi-gaffer/package.json:31-33`, `evals/package.json:11-12` | changed (version) | Bump to `1.3.0` and run `pnpm install`. Lockfile: −8/+10 packages, adds `pi-codemode`, `pi-mcp` and `quickjs-wasi`; `@anthropic-ai/sdk` 0.124→0.129; `openai` 6→7 | S2 commit `000ae2a` |
| `pnpm-workspace.yaml` `allowBuilds` | `pnpm-workspace.yaml:6-9` | unchanged | None: S2's install needed no new build approvals | S2 install log |
| `npm install -g @earendil-works/pi-coding-agent@0.87.1` | `harness/Dockerfile:29` | **changed** | Bump. Since 1.0.1 the npm package has **no `npm-shrinkwrap.json`**, so `npm install -g` resolves third-party transitive deps fresh on every build; NFR-MNT-01's "pinned" now covers only the top-level package. Pi's own packages are exact since 1.3.0. Pin with a committed lockfile (e.g. `harness/pi/package.json` + `package-lock.json`, `npm ci`), or record the exception | CL 1.0.1 Removed; CL 1.3.0 Fixed #10865; S2 build log ("added 118 packages") |
| Symlinks `/opt/node_modules/@earendil-works/{pi-coding-agent,pi-ai}`, `/opt/node_modules/typebox` | `harness/Dockerfile:61-66` | unchanged | None: both targets exist in the s2 image | S2 image `ls` |
| Pi package manifest (`keywords: pi-package`, `pi.extensions/skills/prompts/themes`) | `packages/pi-gaffer/package.json:7-19` | unchanged | None | S2 TUI startup lists 5 extensions, 6 skills, 3 prompts |
| `pi install /opt/pi-gaffer` (writes `packages: ["../pi-gaffer"]`) | `harness/Dockerfile:80` | unchanged | None | S2 build log |
| `settings.json` `theme: "gaffer"` | `harness/Dockerfile:81` | unchanged | None: the Gaffer palette is applied (`#9ccc65` and `#f2c14e` in the TUI capture) | S2 `tui-startup-1.3.0.txt` |
| `settings.json` `extensions` | not used | new capability | **Add** `"extensions": ["-builtin:mcp", "-builtin:codemode", "-builtin:tool-search", "-builtin:llama.cpp"]` in the same Dockerfile step (§3). S2 checked that `/mcp` disappears and Gaffer's 5 extensions still load | CL 0.99.0 ("Built-in section in `pi config`… stored as `-builtin:<name>`"); `core/resource-loader.ts:577-583`; S2 `tui-builtins-disabled-1.3.0.txt` |
| `settings.json` `cacheWarming` | not set (default `"streaming"`) | unchanged since 0.86.0 | Decide: set `"off"`, or count `usage` entries in the budget (§6) | `core/settings-defaults.ts:61`; `docs/settings.md:21-23` |
| `harness/models.json` (`claude-sonnet-5-5` under `providers.anthropic.models`) and `COPY … /opt/pi-agent/models.json` | `harness/models.json:1-21`, `harness/Dockerfile:69-70` | **changed** | **Delete both** on 1.3.0. The catalogue has had `claude-sonnet-5-5` since 0.99.0. A `models` entry with the same id **replaces** the catalogue entry, with no merge: only `api` and `baseUrl` fall back to the defaults, and `compat` comes from `models.json` alone. Gaffer's entry therefore drops `supportsMidConvoSystemMessages`, `supportsMidConvoToolChanges`, `supportsMidConvoEffort`, `supportsTemperature: false` and `inputLimits`, and prices cache reads at $0.20 instead of $0.10. If an override is ever needed, use `modelOverrides`, which merges | `core/provider-composer.ts:331-336` (replace), `:210-248` (`modelFromJson`), `:553-575` (`modelOverrides` applied last, merged); `pi-ai` `dist/providers/data/anthropic.json` @1.3.0; CL-ai 0.99.0; S6 |
| `models.json` schema | `harness/models.json` | changed (additive) | None. `$schema` is now allowed | `core/model-config.ts:84-87`; CL 1.2.0 |
| Theme file `$schema` | `packages/pi-gaffer/themes/gaffer.json:2` | changed (URL) | Set it to `https://pi.dev/schemas/theme.schema.json`. Cosmetic: Pi accepts any string, and startup validation passes with no warning | CL 1.2.0 Breaking; `modes/interactive/theme/theme-schema.ts:54`; S2 TUI capture |
| Theme colour roles (the test reads Pi's `dist/modes/interactive/theme/dark.json`) | `packages/pi-gaffer/test/theme.test.ts:6-13` | unchanged | None: the test passes with the same role set | S2 tests |

## 2. Environment variables

| Item | Where | Status | Change | Citation |
|---|---|---|---|---|
| `PI_CODING_AGENT_DIR` | `harness/Dockerfile:31`, `evals/runner/run.ts:43` | unchanged | None | `config.ts:584`; `pi --help` |
| `PI_TELEMETRY=0` | `harness/Dockerfile:32` | unchanged | None | `core/telemetry.ts:10` |
| `PI_OFFLINE=1` | `harness/Dockerfile:33` | unchanged | None. Both versions warn "fd/ripgrep not found, offline" at startup | `pi --help` @1.3.0; S2 `tui-startup-0.87.1.txt` vs `-1.3.0.txt` |
| `PI_SKIP_VERSION_CHECK=1` | `harness/Dockerfile:34` | unchanged | None | `utils/version-check.ts:98` |
| `ANTHROPIC_API_KEY` (from the Compose secret) | `harness/entrypoint.sh:6-8`, `evals/runner/cli.ts:60` | unchanged | None | `pi --help` |
| `PI_CACHE_RETENTION` | not used | unchanged | Knob only: `long` asks for 1 h breakpoints | `ai/src/api/anthropic-messages.ts:69-92` |
| `PI_CODING_AGENT_SESSION_DIR` | not used (Gaffer passes `--session-dir`) | unchanged | None | `pi --help` |

## 3. CLI (the launch line `harness/gaffer-pi:8-13`)

| Item | Where | Status | Change | Citation |
|---|---|---|---|---|
| `--session-dir /sessions` | `harness/gaffer-pi:8` | unchanged | None | `pi --help` @1.3.0 |
| `--no-context-files` | `harness/gaffer-pi:8` | unchanged | None | `pi --help` |
| `--continue` | `harness/gaffer-pi:8` | changed (1.3.0) | None. A resumed session now restores the transcript's active tools, but only when tools aren't chosen explicitly. Gaffer's `--tools a,b,…` names tools, so it still wins | CL 1.3.0 Fixed #10785; `core/sdk.ts:472`; `core/agent-session.ts:526, 1815-1825` |
| `--tui-mode fullscreen` | `harness/gaffer-pi:8` | changed (now the default) | Keep it explicit (fullscreen has been the default since 1.0.0). **Keys changed in 1.0.3:** transcript top and bottom moved from `Home`/`End` to `Ctrl+Home`/`Ctrl+End`. Fix `README.md:71`, `docs/ARCHITECTURE.md:400` and the comment at `harness/gaffer-pi:5`. Check by hand that xterm.js → tmux passes `Ctrl+Home` | CL 1.0.0; CL 1.0.3; CL-tui 1.0.3 |
| `--tools read,write,edit,bash,fpl_snapshot,submit_recommendation,set_preferences` | `harness/gaffer-pi:9` | changed (1.0.4, 1.1.0) | None. Entries may now be `*` patterns, and `+x`/`-x` adjust the defaults; a plain list still replaces them. A list with no `mcp__` entry keeps MCP tools *registered* but not *activatable*: a `direct` MCP tool never activates, and a deferred one only through `tool_search`, which the list excludes | CL 1.0.4; CL 1.1.0; `core/agent-session.ts:500-507, 1538-1556, 3596-3612` |
| `--provider` / `--model` / `--thinking` | `harness/gaffer-pi:10-12` | changed (1.0.0) | `--provider` without `--model` is now an error. Pass `--provider` only when `GAFFER_MODEL` is set | CL 1.0.0 Fixed #10236 |
| `--no-mcp` | not used | new (1.0.4) | **Add** to `harness/gaffer-pi` and every CLI launch (`deploy/compose/tests/{injection,real-run}.sh`): the only MCP switch a trusted project or `-e builtin:mcp` can't undo (ADR 0012, S3 rows 6–14) | CL 1.0.4; `main.ts:788` |
| `--no-extensions` | not used (it would drop Gaffer's package extensions too) | changed (0.99.0) | Don't use it. Disable built-ins by name instead | CL 0.99.0 Changed; `pi --help` |
| `pi --version` / `--help` / `--list-models` | operator use | unchanged | None | S2 `pi-help-1.3.0.txt` |

**Built-in extensions now load in the TUI.** The CLI prepends `builtInExtensions` (`main.ts:578`), which are `llama.cpp`, `codemode`, `tool-search` and `mcp` (`extensions/index.ts:7-14`). They don't appear in the startup list (`core/extensions/types.ts:2058-2074`). They add:
- the `/mcp` and `/llama` commands (`extensions/mcp/index.ts:1260`, `extensions/llama/index.ts:183`; S2's capture shows `/mcp`);
- a `llama.cpp` provider (`extensions/llama/index.ts:44`);
- `codemode` (`model-only`, `defaultActive: false`; `extensions/codemode/index.ts:34-46`);
- `tool_search` (`defaultActive: false`; `extensions/tool-search/index.ts:14`).

Nothing reaches the model today:
- `--tools` keeps `codemode` and `tool_search` from being registered;
- no `mcp.json` exists, so no MCP server connects; **but** if one ever exists (for example after `/login` → Radius, which offers to write one), its servers are spawned in the harness with `ANTHROPIC_API_KEY` in their environment even though `--tools` hides their tools (S3 row 2; `packages/mcp/src/transports/stdio.ts:94`), and `--no-mcp` is the only switch that prevents it whatever the settings say (ADR 0012);
- `/mcp` in the TUI can't *add* a server. Only `pi mcp add` (a shell) or a config file can (`extensions/mcp/index.ts:1260-1300`; `extensions/mcp/cli.ts:195`).

SDK hosts get none of the built-ins, because `DefaultResourceLoader` only knows the factories it is given (`core/resource-loader.ts:380-383`). That covers `test/harness.ts`, `evals/runner/run.ts` and `deploy/compose/tests/*.mjs`, so the TUI's surface is untested.

**Recommendation:** disable all four in `settings.json` (§1). The alternative is a compose test that asserts which commands are registered.

## 4. Extension API

| Item | Where Gaffer uses it | Status | Change | Citation |
|---|---|---|---|---|
| Factory `export default function (pi: ExtensionAPI)` | all 5 `extensions/*/index.ts` | unchanged | None | `core/extensions/types.ts` `ExtensionFactory` |
| `pi.on("session_start")` | `extensions/gaffer-core/index.ts:26` | unchanged | None | `types.ts:1602` |
| `pi.getAllTools()` | `gaffer-core/index.ts:28` | changed (additive) | None. `ToolInfo` gains `exposure`, `namespace`, `annotations` and `reachesTools` | `types.ts:1769, 2122-2128` |
| `pi.setActiveTools(names)` | `gaffer-core/index.ts:29`, `test/s1.test.ts:105` | changed (documented) | None. Unknown and `hidden` tools are ignored; `codemode`/`deferred` tools stay callable from codemode either way | `types.ts:1771-1778` |
| `pi.on("before_agent_start")` | `gaffer-core/index.ts:32-48` | **changed (1.2.0)** | None. The event is now a union on `messageType`: `"user"` carries `prompt`/`images`, and `"custom"` carries `message`. Gaffer touches only `systemPromptOptions`, which is on the shared base. The event now also fires for runs started by `pi.sendMessage(…, {triggerTurn: true})` while idle; Gaffer's prompt and sections then apply to those runs too, which is what Gaffer wants. **Correction to the brief:** `gaffer-budget` doesn't use `before_agent_start` | CL 1.2.0 Breaking; `types.ts:932-957` |
| `systemPromptOptions.customPrompt` / `.contextFiles = []` / `.sections` | `gaffer-core/index.ts:33-47` | unchanged | None. Same semantics: `customPrompt` replaces the preamble, tools, rules and docs, while skills, cwd and custom sections are still appended. Only new field: `hiddenTools` | `core/system-prompt.ts:9-49, 128-193` (the only diff vs 0.87.1 is `hiddenTools`) |
| How a changed section reaches Anthropic | `gaffer-core/index.ts:43-47` (`fpl_context` changes on every prompt) | unchanged since 0.86.0 | Depends on `compat.supportsMidConvoSystemMessages` (see S6 and note 07 §4.4) | `core/system-prompt.ts:212-229`; `core/agent-session.ts:1733-1754`; `ai/src/api/anthropic-messages.ts:230, 581, 1356-1400`; `ai/src/utils/transcript.ts:105-120` |
| `pi.on("user_bash")` returning `{result: {output, exitCode, cancelled, truncated}}` | `gaffer-core/index.ts:51-54` | unchanged (fail-closed since 0.86.0, already in the pin) | None | CL 0.86.0 Breaking; `types.ts:1466-1480` |
| `pi.registerCommand(name, {description, handler})` | `gaffer-core/index.ts:56, 85, 108, 125, 144`; `test/model-fixtures.ts:71` | unchanged | None. The new built-in commands (`/mcp`, `/llama`) don't clash with Gaffer's | `types.ts:1680` |
| `ctx.ui.notify(msg, type)` | 25 calls across `gaffer-core`, `gaffer-budget` and `gaffer-recommend` | unchanged | None | `types.ts:149-…` (same member set as 0.87.1) |
| `ctx.sessionManager.getBranch/getEntries/getSessionDir/getSessionFile` | `gaffer-core:36, 111, 130-133`; `gaffer-budget:26-27, 49, 59-61`; `gaffer-data:41`; `gaffer-recommend:51, 99`; `src/team-prefs.ts:21, 27` | unchanged | None | `core/session-manager.ts:245-260` (`ReadonlySessionManager`) |
| `ctx.model` | `gaffer-recommend/index.ts:90` | unchanged | None | `types.ts:339` |
| `ctx.abort()` | `gaffer-budget/index.ts:70`, `gaffer-recommend/index.ts:124` | unchanged | None. An abort while a run is starting now takes effect once the run starts | `types.ts:354`; CL 1.2.0 |
| `pi.appendEntry(customType, data)` | `gaffer-budget:36`, `gaffer-core:78`, `gaffer-data:72`, `gaffer-recommend:97, 98, 103, 121` | unchanged | None | `types.ts:1747` |
| `pi.sendMessage({customType, content, display}, {deliverAs: "steer"})` | `gaffer-budget/index.ts:67` | unchanged | None. Same signature. The 1.2.0 "busy while a run starts" change doesn't affect a steer sent from `turn_end`. Gaffer doesn't use `sendUserMessage`, which now needs `deliverAs` while busy | `types.ts:1731-1745`; CL 1.2.0 |
| `pi.on("agent_start")` | `gaffer-budget:40`, `gaffer-recommend:61` | unchanged | None | `types.ts:1642` |
| `pi.on("input")`, `event.source`, `{action}` | `gaffer-budget/index.ts:46-54` | unchanged | None | `types.ts:1171-1187` |
| `pi.on("turn_end")`, `event.message.content` | `gaffer-budget/index.ts:13-17, 56` | unchanged since 0.87.0 | None | `types.ts:1065-1072` |
| `defineTool({name, label, description, promptSnippet, parameters, execute})` + `pi.registerTool` | `gaffer-data/index.ts:18-76`; `gaffer-recommend/index.ts:71-112, 128-149`; `test/s1.test.ts:106` | changed (additive) | None. New optional fields: `exposure` (default `direct`), `namespace`, `reachesTools`, `annotations`, `defaultActive`, `prepareLoadout` and `outputSchema`. `execute`'s `ctx` is now an `ExtensionToolContext`, which adds `tools` and `executeTool` | `types.ts:579-678` (ToolDefinition), `:365-394` (ExtensionToolContext) |
| `executionMode: "sequential"` | `gaffer-recommend/index.ts:82` | unchanged | None | `types.ts:647` |
| `renderResult(result, options, theme)` returning `{invalidate, render}` | `gaffer-recommend/index.ts:108-110` | changed (additive) | None. A 4th argument, `context`, now carries `durationMs` and `outputPad` | `types.ts:662-668`; CL 1.1.0 |
| Tool result `{content, details, terminate: true}` | `gaffer-recommend/index.ts:100, 106`; `test/s1.test.ts:113` | unchanged | None (S1-6 passes) | `agent/src/types.ts:73, 103` |
| A thrown error becomes a failed tool result | `gaffer-recommend/index.ts:104` | unchanged | None | S2 tests |
| `pi.on("tool_call")` → `{block, reason}` | `gaffer-data/index.ts:79`; `src/guard.ts:66-80` | changed (additive) | None. It now also fires for nested `ctx.executeTool()` calls, with `parentToolCallId`, and can block them | `types.ts:1195-1202, 1454-1463`; `core/agent-session.ts:659-681, 728-764` |
| `pi.on("tool_execution_end")` (`toolName`, `toolCallId`, `isError`, `result`) | `gaffer-recommend/index.ts:116-126` | changed (additive) | None today. The event gains `durationMs` and `parentToolCallId`. If codemode is ever enabled, ignore events with `parentToolCallId` here, or nested failures count as submission attempts | `types.ts:1115-1124` |
| `createBashToolDefinition(cwd, {operations, exposeSessionEnvironment: false})`, `createRead/Write/EditToolDefinition(cwd, {operations})` | `gaffer-sandbox/index.ts:24-27`; `src/sandbox.ts` | unchanged | None. The options and all four `*Operations` interfaces are byte-identical. `bash` now also declares an `outputSchema` and returns `structuredContent` (for codemode callers); Gaffer's operations are unaffected | `core/tools/bash.ts:214-225, 259, 391-408, 427`; `read.ts:86`; `write.ts:44`; `edit.ts:143` |
| `pi.on("session_shutdown")` | `gaffer-sandbox/index.ts:29` | unchanged | None | `types.ts:1618` |
| `VERSION` export | `gaffer-recommend/index.ts:10, 91` | unchanged API, new value | Recommendations now record `pi: "1.3.0"`. **Test fix:** `test/recommend.test.ts:74` hard-coded `"0.87.1"`; S2 compares with `VERSION` instead | `src/index.ts:13`; `config.ts:582`; S2 commit `fb269b3` |
| `Theme.fg/bold` | `gaffer-recommend/index.ts:23-30` | unchanged (`style/colors/appearance` added) | None | CL 0.99.0 |
| `ExtensionContext` type | `src/team-prefs.ts:2`; `gaffer-budget:6`; `gaffer-recommend:10` | unchanged | None | `types.ts:325` |
| `TurnEndEvent` type | `gaffer-budget/index.ts:6, 13` | unchanged since 0.87.0 | None | `types.ts:1065` |

## 5. SDK hosts (tests, eval runner, compose checks)

| Item | Where | Status | Change | Citation |
|---|---|---|---|---|
| `createAgentSession({cwd, agentDir, model, modelRuntime?, thinkingLevel?, resourceLoader, sessionManager, settingsManager, tools: string[]})` | `test/harness.ts:157`; `evals/runner/run.ts:110-113`; `deploy/compose/tests/live-snapshot.mjs:50`, `recommend.mjs:43`; `spikes/s1-extension-hooks/run-spike.ts` | unchanged | None | `core/sdk.ts:48-103, 191` |
| `new DefaultResourceLoader({cwd, agentDir, settingsManager, extensionFactories, noExtensions, noContextFiles, additionalSkillPaths, additionalPromptTemplatePaths})` + `reload()` | `test/harness.ts:145-155`; `evals/runner/run.ts:96-99`; compose `*.mjs:40-47` | unchanged | None. New option `disabledBuiltinExtensions`. No built-ins load unless passed in | `core/resource-loader.ts:282-292, 376-395` |
| `SessionManager.create(cwd, dir)` | `test/harness.ts:156`; `run.ts:112`; compose `*.mjs` | unchanged | None | `core/session-manager.ts:1755` |
| `SettingsManager.create(cwd, agentDir)` | `test/harness.ts:135`; `run.ts:89` | unchanged | None | `core/settings-manager.ts:310` |
| `ModelRuntime.create({modelsPath, authPath})`, `.getModel(provider, id)` | `evals/runner/run.ts:106-107` | unchanged | None. With `harness/models.json` deleted, `modelsPath` names a missing file, which loads as empty | `core/model-runtime.ts:110-113, 217`; `core/model-config.ts:124-131` |
| `session.bindExtensions({uiContext, mode: "tui"})` | `test/harness.ts:164`; `run.ts:117`; compose `*.mjs` | unchanged | None | `core/agent-session.ts:302-309, 3288` |
| UI-context stub list (`select … setToolsExpanded`) | `test/harness.ts:162`; `run.ts:116` | unchanged | None. `ExtensionUIContext` has the same members at both tags | diff of `types.ts:149-…` @0.87.1 vs @1.3.0 |
| `session.prompt/abort/dispose/subscribe/getActiveToolNames`, `session.sessionManager.getSessionFile()` | tests, `run.ts`, compose `*.mjs` | unchanged | None | S2: 237/237 tests |
| `fauxProvider({provider, models: [{id, cost}]})`, `.provider`, `.getModel()`, `.setResponses()`, `.state.callCount`, `.getPendingResponseCount()` | `test/harness.ts:127-131`; `test/s1.test.ts:124-125`; `run.ts:90, 173`; compose `*.mjs` | unchanged | None. The faux cache-usage estimate changed in 1.1.0; its totals are the same | `ai/src/providers/faux.ts:104, 137-155, 704`; CL-ai 1.1.0 |
| `fauxAssistantMessage/fauxToolCall/fauxText`, step functions reading `ctx.messages[0].sections` | `test/*.ts`; `evals/runner/policy.ts:35-41`; `test/s1.test.ts:55` | unchanged | None (S1-3/8 passes) | S2 tests |
| `pi-ai` imported via `${PI}/node_modules/@earendil-works/pi-ai/dist/index.js` | `deploy/compose/tests/live-snapshot.mjs:13`, `recommend.mjs:15` | unchanged | None (the path exists in the s2 image) | S2 image `ls` |
| `pi.registerProvider(faux.provider)` | `test/harness.ts:137`; `run.ts:91`; compose `*.mjs` | unchanged | None | S2 tests |

## 6. Session files and their readers

Readers: `src/usage.ts` (`/usage`, `gaffer admin`, the eval runner), `src/budget.ts` (caps), `src/session.ts`, `src/replay.ts` + `scripts/replay.ts`, `tools/gaffer-eval`, `/scorecard`, `evals/runner/run.ts`.

| Item | Where | Status | Change | Citation |
|---|---|---|---|---|
| Header `{"type": "session", id, …}`, version 3 | `src/usage.ts:166, 307` | unchanged | None | `core/session-manager.ts:41` (`CURRENT_SESSION_VERSION = 3` at both tags) |
| `message` entries: `message.role` (`user`/`assistant`/`toolResult`); `usage.{input, output, cacheRead, cacheWrite, cost.total}`; `provider`; `model`; `stopReason`; `errorMessage`; `content[].type == "toolCall"` with `id`/`name`/`arguments`; `toolCallId`; `isError`; `message.timestamp` (ms); entry `timestamp` (ISO) | `src/usage.ts:187-246`; `src/budget.ts:14, 41-47`; `evals/runner/run.ts:186-189` | changed (additive) | None. New optional fields: `AssistantMessage.durationMs` (1.1.0, from request start to the final message), `ToolResultMessage.durationMs` (1.1.0), `AssistantMessage.thinkingLevel` (0.99.0) and `toolResult.nestedCalls` (0.99.0). All four appear in S2's 1.3.0 sessions. Optional: `usage.ts` could take latency from `durationMs` instead of entry − message timestamps | `ai/src/types.ts:~600-640`; CL-ai 1.1.0, 0.99.0; `docs/session-format.md:95` |
| `custom` entries `{customType, data}` (`gaffer.*`) | `src/session.ts:46-52`; `src/replay.ts:28-34`; `src/usage.ts:247-287`; `src/budget.ts:56-58`; `run.ts:181` | unchanged | None. Pi adds its own custom types (`pi.bug-report`, `pi.virtual-model-state`); Gaffer filters on its own `customType` | `docs/session-format.md:172-175` |
| `usage` entries (`type: "usage"`, `kind: "cache_warm"`, …) | **not read** by `src/budget.ts:14` (`costOf`), `:42` (the `'"assistant"'` line filter) or `src/usage.ts:196` | unchanged since 0.86.0 (already in the pin) | **Fix, independent of the upgrade.** Cache-warming refreshes are billed and written as `usage` entries. Pi counts them in its session totals but Gaffer ignores them, so the caps and `/usage` undercount. Either count `type === "usage"` cost in `costOf`, `dayCost` and `sessionUsage` (under a "(cache warming)" row), or set `cacheWarming: "off"` | `core/session-manager.ts:80-89, 1244`; `core/cache-warmer.ts:20, 342`; `docs/session-format.md:113-121` |
| `SessionEntry` union (`context_edit`, `compaction`, `branch_summary`, `label`, `session_info`, `model_change`, `thinking_level_change`, `custom_message`, `usage`) | readers switch on `type`, non-exhaustively | unchanged since 0.87.0 | None | `core/session-manager.ts:183-194` (identical at both tags) |
| System prompt persisted as a `message` with `role: "system"`, `sections`, `toolsAdded` | readers ignore `role: "system"` | unchanged since 0.86.0 | None | S2 session sample |
| Lazy file creation | comment at `gaffer-core/index.ts:132`; `test/harness.ts:176` | changed (0.99.0) | None needed. The file is now written at the first **user** message, not the first assistant reply. A run that dies before the reply therefore leaves a file with a `user` message and no cost, which `usage.ts` handles (a run with outcome "answer"). Update the comments | CL 0.99.0 Fixed #10000; `core/session-manager.ts:1158-1176` |
| Location `--session-dir /sessions`, file naming, `--continue` lookup | `harness/gaffer-pi:8`; readers scan `/sessions` recursively | unchanged | None | `docs/session-format.md` diff is 3 additive paragraphs |
| Compaction entries | readers ignore them | unchanged | None. Compaction's own model calls aren't written as `usage` entries: only `cache-warmer.ts` calls `appendUsage`, and compaction sends `cacheRetention: "none"` (`core/compaction/compaction.ts:631`) | grep of `appendUsage` @1.3.0 |
| Thinking blocks `{type: "thinking", thinking, thinkingSignature, redacted?}` in assistant `content` | the TUI and `/export` render them; Gaffer's readers ignore them | unchanged | None. Since 1.3.0, thinking from a previous model is dropped from requests after a model switch | `ai/src/types.ts:420-428`; CL 1.3.0 |

## 7. Model and provider

| Item | Where | Status | Change | Citation |
|---|---|---|---|---|
| `anthropic/claude-sonnet-5-5` in Pi's catalogue | `harness/models.json`; `deploy/compose/docker-compose.yml:18` | **changed** (in the catalogue since 0.99.0) | Use the catalogue entry: delete `models.json`. The entry has `cost.cacheRead 0.1`; `compat {supportsMidConvoEffort, supportsMidConvoSystemMessages, supportsMidConvoToolChanges, forceAdaptiveThinking, supportsTemperature: false, supportsStrictTools}`; `promptCache {short: 300, long: 3600}`; `thinkingLevelMap {off: null, minimal: null, low…max}`; and `inputLimits` | `pi-ai` `dist/providers/data/anthropic.json` @1.3.0 |
| What the catalogue entry turns on (for the real-model check) | — | new for Gaffer | `supportsMidConvoEffort` adds two betas (mid-conversation output config, thinking binding controls), sends `thinking: {type: "adaptive", display: "summarized", block_binding: {prefix_mismatch_behavior: "drop_block"}}`, and sends `output_config.effort` as `role: "system"` marker messages. `supportsMidConvoSystemMessages` + `supportsMidConvoToolChanges` add the `inline-tools` beta: the tool list stays fixed, with a placeholder, and later tools arrive as `tool_addition` blocks. **S6 tested only `supportsMidConvoSystemMessages`**; the effort and inline-tools paths have had no real-model run with Gaffer | `ai/src/api/anthropic-messages.ts:~1152-1158, 1202-1213, 1264-1276, 1279-1290, 1556-1577` |
| Thinking display | both UIs | unchanged | None possible without owning a request hook. Pi requests `"summarized"` by default and allows only `"summarized"` or `"omitted"` | `ai/src/api/anthropic-messages.ts:192, 1287, 1294` (S6) |
| Cache warming (default `cacheWarming: "streaming"`; runs only when the expected saving is ≥ $0.05 and the model declares `promptCache`) | not configured | unchanged since 0.86.0 | See the `usage` entries row in §6 | `core/settings-defaults.ts:61`; `core/cache-warmer.ts:20` |

## 8. Built-in commands that matter to Gaffer's threat model

| Item | Status at 1.3.0 | Change |
|---|---|---|
| `!cmd` / `!!cmd` | Blocked by `gaffer-core`'s `user_bash` handler (fail-closed) | None |
| `/share` | Changed (1.3.0): with `sessionShareDestination: "auto"` it uploads to Radius when `radius` credentials exist, and otherwise runs `gh gist create`. The image has no `gh` and no Radius login, so it fails as on 0.87.1 (`modes/interactive/session-share.ts:56-104`). A user who ran `/login radius` in the TUI could then share their own session, which holds their raw team id in `gaffer.team` | Set `sessionShareDestination: "gist"` so `/share` never reaches Radius (`session-share.ts:68`), and block the command itself (ADR 0013) |
| `/bug` | In the pin since 0.86.0; refuses uploads in offline mode since 0.87.0 | None (`PI_OFFLINE=1`) |
| `/mcp`, `/llama` | New (built-in extensions) | Disable with `-builtin:mcp` and `-builtin:llama.cpp` |
| `/export` | Built in (unchanged) | None (Gaffer's command is `/export-rec`) |

## 9. Upgrade order

Each step leaves Gaffer working and has its own gate. Steps 0a and 0b don't need the upgrade and ship on 0.87.1 first (roadmap M1.1-0). Steps 1–5 are roadmap M1.1-1 and deploy in one window after the GW8 deadline; steps 1 and 3 must never be deployed apart, because step 1 alone loads the built-ins in the TUI.

| Step | Change | Gate |
|---|---|---|
| **0a** (on 0.87.1) | `harness/models.json`: add `"supportsMidConvoSystemMessages": true` and set `cacheRead` to `0.1`. Correct ADR 0008's price | `pnpm test`; S6 variant B on 0.87.1; `pnpm eval --model faux`; 2–3 real-model cases including a follow-up prompt |
| **0b** (on 0.87.1) | Count `type: "usage"` entries in `src/budget.ts` (`costOf`, `dayCost`) and `src/usage.ts`, with a unit test on a `cache_warm` entry | `pnpm test` (the `admin`, `extensions` and `scorecard` tests); `deploy/compose/tests/m5.mjs` |
| **1** | Bump `packages/pi-gaffer/package.json:31-33`, `evals/package.json:11-12`, `pnpm-lock.yaml` and `harness/Dockerfile:29`. Fix `test/recommend.test.ts:74` to use `VERSION` (S2's commits `000ae2a` and `fb269b3`). Keep `harness/models.json` in this step, so the request shape doesn't change yet | `pnpm test`: 237/237, including `test/s1.test.ts` 8/8. Typecheck: no new errors (S2: 17 before, the same 17 after). Image build; `pi --version` = 1.3.0; TUI startup with no warnings. `deploy/compose/tests/verify.sh` with `-p` and the port parameterised (S2's `verify-s2.sh`). `pnpm eval --model faux`: 30/30 valid |
| **2** | Pin the image's transitive deps (lockfile + `npm ci`), now that the shrinkwrap is gone | Build the image twice from clean and compare `npm ls`; step 1's gates |
| **3** | `settings.json`: `extensions: ["-builtin:mcp", "-builtin:codemode", "-builtin:tool-search", "-builtin:llama.cpp"]`, `sessionShareDestination: "gist"`, `externalEditor: "/bin/false"`, `enableSkillCommands: false`, `doubleEscapeAction: "none"` (in `harness/Dockerfile:80-81`); `keybindings.json` from ADR 0013; **`--no-mcp`** in `harness/gaffer-pi` and the compose test scripts. **Ships in the same deploy as step 1** (ADR 0012) | S3's checks as tests (NFR-SEC-08): no MCP process starts with a marker server in the agent's and the project's `mcp.json`; no `codemode`, `tool_search` or `mcp__*` tool registered; `/mcp` and `/llama` absent from RPC `get_commands`; verify.sh |
| **4** | Delete `harness/models.json` and `harness/Dockerfile:69-70`. Update `README.md:83`, ADR 0008 and `BUILD.md`: Sonnet 5.5 now comes from Pi's catalogue | `pnpm test`; the faux eval. **Real model:** 3–5 cases with a follow-up prompt, checking cost per session, cache reads on the follow-up, that the effort beta is accepted, and the `/usage` figures. A TUI run checking that reasoning shows. *Pre-checked in spike S10:* the catalogue entry's request shape (`drop_block`, effort markers, mid-conversation sections) is accepted by the API and follow-ups read the cache |
| **5** | Docs and cosmetics: the `$schema` at `themes/gaffer.json:2`; `Ctrl+Home`/`Ctrl+End` in `README.md:71`, `docs/ARCHITECTURE.md:400` and `harness/gaffer-pi:5`; the lazy-file comments; `docs/REPO_LAYOUT.md:9`. `spikes/s1-extension-hooks/package.json` stays at `^0.87.1` (historical) | Manual: the TUI in a browser, `Ctrl+Home`/`Ctrl+End`, PageUp |
| **6** (optional) | Take latency in `src/usage.ts` from `AssistantMessage.durationMs` / `ToolResultMessage.durationMs` | `pnpm test` (the usage and admin tests); compare one session's figures before and after |

## Every Gaffer source line that must change for 1.3.0

**Required for the upgrade itself (S2):**
- `packages/pi-gaffer/package.json:31-33`: `0.87.1` → `1.3.0` (pi-ai, pi-coding-agent, pi-tui)
- `evals/package.json:11-12`: `0.87.1` → `1.3.0`
- `pnpm-lock.yaml`: regenerated
- `harness/Dockerfile:1, 29`: `pi-coding-agent@1.3.0`, and the comment
- `packages/pi-gaffer/test/recommend.test.ts:74`: `pi: "0.87.1"` → `pi: VERSION`, plus the import at line 9

**Needed for correct behaviour on 1.3.0 (not visible to the tests):**
- `harness/models.json` (the whole file) and `harness/Dockerfile:69-70`: delete them, or rewrite as `modelOverrides`
- `harness/Dockerfile:80-81`: also write `extensions: [-builtin:… ×4]`, and optionally `cacheWarming` and `sessionShareDestination`
- `harness/gaffer-pi:10`: pass `--provider` only together with `--model`

**Pre-existing gaps the review turned up (true on 0.87.1 too):**
- `packages/pi-gaffer/src/budget.ts:14, 42` and `src/usage.ts:196-231`: count `type: "usage"` entries
- `harness/models.json:11`: `cacheRead: 0.2` → `0.1`, if the file is kept on 0.87.1

**Docs and cosmetics:**
- `packages/pi-gaffer/themes/gaffer.json:2`: `$schema` → `https://pi.dev/schemas/theme.schema.json`
- `README.md:71`, `docs/ARCHITECTURE.md:400`, `harness/gaffer-pi:5`: Home/End → Ctrl+Home/Ctrl+End
- `README.md:83, 109`, `docs/REPO_LAYOUT.md:9`, `docs/decisions/0008-model-and-budget.md:6, 11`, `BUILD.md:18, 42`: version and catalogue wording
- `packages/pi-gaffer/extensions/gaffer-core/index.ts:132` and `test/harness.ts:176`: comments on lazy file creation (the file now appears at the first user message, not the first reply)
