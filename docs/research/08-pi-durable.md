# 08 — Pi Durable (and whether Gaffer should move onto it)

Research date: 2026-10-17.

**Version read:** `@earendil-works/pi-durable` **1.3.0** (2026-10-15), monorepo tag `v1.3.0` (`71023aec`). Path conventions: `durable/…` = `packages/durable/…`, `env/…` = `packages/env/…`, `coding-agent/…` = `packages/coding-agent/…`, all cited `@v1.3.0` unless marked otherwise. Removed code is cited by commit. The Cloudflare sample is `earendil-works/pi-durable-cloudflare` @ `dcb56ce` (2026-10-15). The spike is [S8](../../spikes/s8-durable-gaffer/README.md).

---

## TL;DR for Gaffer

| Question | Answer | Evidence |
|---|---|---|
| What is it? | A second, separate agent harness built on pi-ai. It shares no code path with `pi-coding-agent`, and no published `pi-coding-agent` version depends on it. | `npm view @earendil-works/pi-coding-agent@{0.87.1…1.3.0} dependencies`; blog 2026-10-01 |
| Does crash recovery work? | Yes. A SIGKILL mid-tool or mid-stream resumes on reopen. A `replay: "safe"` tool reruns silently; an unsafe one gives the model an "interrupted" result. | S8 scenarios 2–4 |
| Is it close to `pi-coding-agent`? | No. The agent loop, tools, sections and tool hooks are there. Skills, prompt templates, Pi packages, themes, TUI, slash commands, `--mode rpc`, `models.json`/`auth.json` and the session JSONL format are all missing. | §4 |
| Is the extension API compatible? | No. The concepts map, the code does not: tool signature, result shape, events vs hooks, and commands all differ. | §4.2 |
| Can both UIs watch one live run? | Only inside one process. A second process that opens the same store sees 0 updates. Two processes owning one store run the same sandbox command twice. | S8 scenarios 5, 6; `durable/README.md:682` |
| Is there scheduling? | No scheduler. A task can `sleep(until)` with a checkpointed deadline, and that only fires while a process is alive. The Cloudflare sample builds a `schedule` tool on that plus DO alarms. | `durable/src/harness/scheduler.ts:1811`; sample `src/schedule.ts:216-222`, `src/session.ts:246` |
| How mature is it? | Labelled experimental. 14 breaking changes across 6 releases in 14 days (1.0.0 → 1.3.0). Well tested: 62 test files, ~976 cases. | `durable/README.md:3`; CHANGELOG |
| Recommendation | **(a) now plus (d).** Stay on `pi-coding-agent` 1.x, build three cheap seams, and defer Durable with stated triggers (§8). | §7 |

---

## 1. What Pi Durable is

- **Origin.** The npm name dates from 2026-09-19:
  - 0.0.1 was a placeholder.
  - 0.86.0–0.99.2 were lockstep releases of an early record-store layer. At Gaffer's pin its README reads "This package contains the Pico runtime… durable record contracts and detached in-memory storage" (`durable/README.md` @v0.87.1).
  - The harness itself is 1.0.0 (2026-10-01). Its CHANGELOG entry says "Initial release of `@earendil-works/pi-durable`, a durable agent harness".
- **Positioning** (blog, 2026-10-01): it does not replace the coding agent. It is a place to explore designs without disrupting Pi, and lessons "flow back" into the coding agent once proven. The post names no external users. Earendil uses it internally, and the demos are the vacation planner and a small coding agent.
- **Size.**
  - Source: 24,989 lines under `durable/src`.
  - Specification: `durable/docs/spec.md` is 5,352 lines.
  - Tests: 62 test files, ~976 `it/test` cases, 33,576 lines, plus a storage and env conformance suite (`durable/src/testing`).
- **Dependencies.** `chord`, `pi-ai`, `pi-codemode` (all 1.3.0), `typebox`, `diff`, and Photon (WebAssembly images). The root import costs "about 23 MB of peak RSS unbundled" (`durable/README.md:709`).

---

## 2. The model

| Concept | What it is | Source |
|---|---|---|
| Harness | One open storage plus the scheduler. All changes go through one line of atomic commits, and nothing is shown before it is stored. | `durable/README.md:82` |
| Conversation | A transcript of immutable entries (`pi.user`, `pi.assistant`, `pi.tool-result`, `pi.system`, `pi.reset`, `pi.compaction`, or your own kinds). It is `ownerless` or owned by a task (a subagent). | `:83-84`, `:536-575` |
| Task and checkpoint | A durable state machine: phases, a checkpoint saved at every step, an abort handler, and `memo`. Built-in tasks are `pi.generation`, `pi.tool` and `pi.compaction`. Tasks can own child tasks and wait on them (`allSettled` or `failFast`). | `:87`, `:581-606`; examples 12, 13, 24 |
| Tool recovery | Intent is committed before `execute()`. On reopen the call reruns only if both the stored and the current policy say `safe`; otherwise the result is "Tool X was interrupted and may have partially run", with the output committed so far. | `durable/src/harness/tool.ts:174-191` |
| Generation recovery | A committed partial becomes an `aborted` assistant entry, which is never sent to the model, and the request is sent again. | `durable/src/harness/generation.ts:378-386`; S8 scenario 4 |
| Terminating tool | `control: { terminate: true }`. It ends the run only when **every** call in the round asks for it. | `generation.ts:646-649`; `README.md:181` |
| Documents | Typed JSON committed atomically with entries (`defineDoc`). Scope is `session`, `conversation` or `task`. History is `latest` or `rewindable` (`snapshotAsOf`). A fork starts with `initial`, `current` or `asOf`. Built-in documents are `pi.agent`, `pi.live`, `pi.inbox`, `pi.usage` and `pi.provider`. | `README.md:624-646`; `durable/src/types.ts:56-60`; examples 01, 11 |
| Forks | `conversation.fork(entryId)` at **any** entry, a tool result included. The fork sees the parent's entries without copying them and gets a fresh provider session ID. | `README.md:525-532`; example 02; S8 scenario 1 |
| Storage | Memory; SQLite on Node (WAL, `synchronous = NORMAL`); JSONL on Node (keeps the whole history in memory); Durable Object SQLite (`openDurableObjectSqliteStorage`). It has a conformance suite. **One process owns a storage; there is no cross-process locking.** | `README.md:656-682` |
| `watch()` / `viewState()` | The structural view of a conversation (entries plus built-in documents), then the exact Chord operations of each commit. It holds at most 100 pending frames, then sends a full reset. A late joiner starts from the current view; nothing is replayed. | `README.md:378-406` |
| `watchEvents()` (marked *Experimental*) | Coding-agent-style events derived from commits: `run_start/end`, `turn_*`, `message_start/update/end` (text, thinking and toolcall deltas), `tool_execution_start/update/end`, `inbox_update`, `usage_changed`, `compaction_*`, `auto_retry_*`. | `README.md:488-502`; `durable/src/harness/events.ts:29-99` |
| Progress commits | Partials and tool output are committed at most every 100 ms, which is also the most a crash can lose. | `README.md:406` |
| Inbox | `whenBusy: "steer"`, `"followUp"` (the default) or `"reject"`. A display-only write is appended at once. `requestId` makes a submission exactly-once. | `README.md:408-441`, `:117-124` |
| Compaction | Manual `compact()`, a blocking threshold, a background threshold, and a retry on context overflow. A `beforeCompact` hook can decline or supply the summary. Spend is counted in `pi.usage`. | `README.md:454-486`; example 25 |
| Usage | Per conversation, per `provider/model` and per tool, **failed and aborted attempts included**; `harness.usage()` sums them. | `README.md:648-654`; S8 scenario 4 |
| Hooks | Generation: `beforeRequest`, `afterResponse`, `onYield`, `afterTools`. Tool: `beforeTool` (block or rewrite), `afterTool`. Compaction: `beforeCompact`. **No hook can abort or steer a run.** | `durable/src/harness/types.ts:757-806` |
| Scheduling | No scheduler or cron. `TaskRuntime.sleep(until)` compares against the Harness clock, and a checkpointed `until` survives restarts, but only a live process wakes it. | `durable/docs/spec.md:1782`, `:1868`; `scheduler.ts:1811-1822` |
| Execution environments | `env(target)` builds an `ExecutionEnv` (about 25 `FileSystem` methods plus `Shell.exec`) per call, per conversation. Ships `NodeExecutionEnv`. Example 29 shows a sandbox per conversation looked up from a document. | `durable/src/env/index.ts:209-374`; `README.md:331-364` |
| `pi-env` (separate package, since 1.0.4 on 2026-10-05) | A Rust daemon that speaks a framed protocol on stdin/stdout, usually deployed and started over SSH, plus a `RemoteExecutionEnv` client (957 lines) that passes the env conformance suite. | `env/README.md`; `env/src/remote-env.ts` |

---

## 3. The experimental durable apps, and why they went

- **Durable coding agent.** Commit `5609b0d6c` (2026-10-01, 1,344 lines). It was "pi's model runtime, settings, system prompt, theme, and interactive components over a durable Harness with SQLite storage". Its README listed what it lacked: "Not here: sessions list and resume picker, forks and tree navigation, extensions, prompt templates, images, `/login`" (`coding-agent/src/experimental/durable/README.md` @`7472cda0d^`). It took a `proper-lockfile` lock per session directory, because the storage has none (`sessions.ts` @`7472cda0d^`).
- **Vacation planner.** Commit `395315f48` (2026-10-01, 1,378 lines), "a copy of the experimental durable coding agent with the coding tools and pi's coding prompt replaced". Only `vacation.ts` (142 lines) is domain code: a `replay: "safe"` search tool and a background research subagent that reports back as a follow-up input. The other ~1,240 lines are the TUI, runtime and session shell. It still used the pre-1.2.0 result shape (`content:`).
- **Removal.** Commit `7472cda0d` (2026-10-12, released in 1.2.0) deleted `src/experimental`, `pi-client`, `pi-protocol` and `pi-server`.
  - The commit message only lists what it removes.
  - The CHANGELOG says: "Removed the unreleased experimental server, client, and plugin stack… none of it was part of the published package" (`coding-agent/CHANGELOG.md:109`).
  - The same day, `0104fef1e` replaced Chord's facet and service runtime, on which that stack was built, with the "chord2 host runtime".
  - **Inference (not stated):** the stack was removed because its Chord substrate was replaced.
- **Replacement.** Nothing replaced the durable TUI, the server or the remote protocol. Chord 1.3.0 now offers generic remote objects over `webSocketLink`, but no Pi package wires a conversation to it. The only published reference transport is the Cloudflare sample's own WebSocket protocol.

---

## 4. Distance from `pi-coding-agent`

### 4.1 Feature by feature

| `pi-coding-agent` feature Gaffer uses | In Durable 1.3.0? | Notes |
|---|---|---|
| Agent loop, tools, parallel or sequential, terminate | **Yes** | `defineTool`, `executionMode`, `control.terminate` |
| System prompt sections, mid-conversation system messages | **Yes** | `section()`. Only changed sections are re-sent as positional `pi.system` entries (S8: the second entry carries only `fpl_context`). |
| `tool_call` guard | **Yes** | `hook(ToolTask, { beforeTool })` returns `{ block }` |
| Built-in read/write/edit/bash | **Yes**, behind `ExecutionEnv` | `@earendil-works/pi-durable/tools`; the env interface is far larger than Pi's `*Operations` |
| Skills | **Missing** | The removed experimental agent borrowed `loadSkills` from coding-agent internals |
| Prompt templates (`/gw`, `/whatif`, `/explain`) | **Missing** | |
| Pi packages, `pi install`, extension loading from disk | **Missing** | Extensions are objects the host installs in a registry; reload means re-installing under the same name |
| Themes, TUI, fullscreen | **Missing** | No published TUI. Coding-agent 1.3.0 does export `AssistantMessageComponent`, `ToolExecutionComponent`, `CustomEditor` and `initTheme`, so one could be built. |
| Slash commands (`/team`, `/prefs`, …) | **Missing** | Host code |
| `--mode rpc`, `--mode json` | **Missing** | `watchEvents()` is an in-process API; example 19 prints JSON lines from one process |
| `models.json`, `auth.json`, `/login` | **Missing** | The host builds `createModels()` and `setProvider(...)`, with keys from the environment |
| Cost per message | **Yes**, and more | pi-ai `usage.cost` on every assistant message; per-conversation `pi.usage`, aborted attempts included |
| Session JSONL (Gaffer's system of record) | **Different format** | SQLite tables (`conversations`, `entries`, `tasks`, `documents`, `document_revisions`, …) or Durable's own JSONL commit log (`durable/src/storage/jsonl/storage.ts`, `FORMAT_VERSION = 1`) |
| Session tree, `/fork`, `/clone` | **Partly** | Forks at any entry exist; there is no tree UI. Pi's `/fork` forks only "from a previous user message" (`coding-agent/src/core/slash-commands.ts:34`). |

### 4.2 API: `defineExtension` / `hook` / `section` vs `ExtensionAPI`

| Gaffer today (Pi 0.87.1 / 1.x) | Durable 1.3.0 |
|---|---|
| `pi.registerTool(defineTool({ execute(toolCallId, params, signal, onUpdate, ctx) }))` → `{ content, details, terminate }` | `defineTool({ execute(args, api, context) })` → `{ output, details, structuredOutput?, control: { terminate } }` |
| `pi.on("before_agent_start")` → `systemPromptOptions.customPrompt/sections` | `section(key, render)` per section, rendered before **each request**, not once per run |
| `pi.on("tool_call")` → `{ block, reason }` | `hook(ToolTask, { beforeTool })` → `{ block }` |
| `pi.on("tool_execution_end")`, `turn_end`, `agent_start`, `input` | `afterTool`, `afterTools`, `afterResponse`. There is no `input` gate (the host decides before `submit()`) and no `agent_start`. |
| `ctx.abort()`, `pi.sendMessage(…, { deliverAs: "steer" })` from a handler | **Not available to hooks.** The host or a tool calls `conversation.abort()` or `submit({ whenBusy: "steer" })`. |
| `pi.appendEntry(customType, data)` | `api.commit(tx => tx.appendEntry(...))`, or a typed document |
| `pi.registerCommand`, `ctx.ui.notify`, `renderResult` | None: host and UI code. Tools put UI data in `details`. |
| `setActiveTools`, `--tools` | `configure({ tools, modelTools })`, `settings.extensions` |
| `pi.on("user_bash")` block | Not applicable: there is no user shell unless the host builds one |

**Porting Gaffer's five extensions** (505 lines today):

- **Tool bodies and the guard port easily.** The domain logic sits in `src/` behind plain dependencies.
- **Command handlers, `ui.notify`, `renderResult` and `gaffer-budget`'s abort and steer move out of the extensions into host code.**
- **Rough count:** 60–80% of the 505 lines change. About 650 more lines of `src/` read Pi's session API or JSONL directly and would need rewriting: `usage.ts` 378, `budget.ts` 67, `replay.ts` 71, `session.ts` 66, `team-prefs.ts` 43, plus `admin.ts`'s use of them.
- **The `sandbox.ts` operations (241 lines)** would become either an `ExecutionEnv` over sandboxd's five routes, or same-name custom tools (S8 did `bash` in about 10 lines). For scale, pi-env's `RemoteExecutionEnv` is 957 lines.

---

## 5. Maturity and API churn

| Release | Date | Breaking changes (CHANGELOG "Breaking Changes" bullets) |
|---|---|---|
| 1.0.0 | 2026-10-01 | (initial) |
| 1.0.1 / 1.0.2 | 10-03 / 10-04 | 0 |
| 1.0.3 | 10-05 | **4**: `FileSystem` needs `openBinaryReader`, `openDirReader` and `watch`; `BinaryReader.scanLines`; `Shell.exec` takes argv and `onOutput` gets stream info |
| 1.0.4 | 10-05 | **2**: `NodeExecutionEnv.watch` errors; a stricter env conformance suite |
| 1.1.0 | 10-07 | **2**: storages must honour `order`; `runtime.context()` takes an options object |
| 1.2.0 | 10-12 | **6**: tool task input and result become tagged unions; `content` → `output`; nonzero `bash` exit is an error result, not a throw; any storage error fails the Session (`StorageRejected` removed); throwing listeners are reported; display-only writes append at once |
| 1.3.0 | 10-15 | 0 |
| main (unreleased) | — | `ToolControl.terminate` typed `boolean` (listed under "Changed"); `models`/`settings` may be functions |

- **Total: 14 breaking changes in 14 days**, several of which would touch Gaffer-shaped code (`content` → `output`, the env interface).
- **README wording:** "**Experimental.** The API changes without notice between releases" (`durable/README.md:3`). "Agent Events (Experimental)" (`:488`). The blog: "Pi Durable is experimental, and the API might still change." Chord, the state layer underneath, also broke heavily in 1.3.0 (references, variants, protocol version 4; `chord/CHANGELOG.md`).
- **Users:** Earendil internally, and the Cloudflare sample by one Earendil engineer, which still pins 1.2.0. npm shows ~338k downloads in the week of 2026-10-06…12, but no published Pi package depends on Durable, so where they come from is unknown.

---

## 6. Gaffer's needs, tested

| Plausible fit | Verdict | Evidence |
|---|---|---|
| **Crash-safe recommendation runs** | **Works; small gain for Gaffer.** Today (0.87.1 baseline) a SIGKILL mid-tool leaves `user` and `assistant(toolUse)` in the JSONL, with no result and no partial output. After `pi --continue` nothing runs by itself, and the user must prompt again; Pi then synthesises a "No result provided" error for the dangling call (`packages/ai/src/api/transform-messages.ts:172-178,231` @v0.87.1). Durable resumes alone: with `unsafe`, one extra model call; with `safe`, a silent rerun of the same call ID; mid-stream, it re-sends the request. For a 75 s, ~$0.06 run, Durable saves one user prompt and a partial rerun. | S8 scenarios 2–4, baseline |
| **What-if as a fork** | **Works, and is the best fit.** A fork at the `fpl_snapshot` result kept `SnapshotDoc` (`asOf`), started with no recommendation, produced its own, and left the parent's unchanged. Pi already has `/fork` (from a user message) and `/clone`, and `/whatif` runs in-session today, so this is better but not new. | S8 scenario 1 |
| **Recommendation and preferences as typed documents** | **Works.** The conversation-scoped `RecommendationDoc` is atomic with the tool's commit. Preferences need Session scope, which means one storage holds all of a user's conversations, a different shape from today's per-session files. A non-replay-safe tool that commits a document and then dies leaves it written while the model sees "interrupted", so `submit_recommendation` would need an idempotency memo. The ledger and `gaffer-eval` would read SQLite instead of JSONL. | S8 code; `tool.ts:186-191` |
| **`gaffer-eval` as a scheduled task** | **Poor fit.** There is no scheduler, only `sleep(until)` inside a live process, and the sample adds DO alarms to wake it. `gaffer-eval` is an idempotent one-shot that waits for `data_checked` (ARCHITECTURE §6.4). Cron or an EventBridge/Fargate schedule is simpler and survives anything. | §2; sample `src/session.ts:246`, `:626-645` |
| **Both UIs on one live conversation via `watch()`** | **Not across processes.** A reader process got 0 frames while another process added 6 entries. Two owners ran the same sandbox command twice, and one died with `SessionFailed: Task 18 is already terminal`. Durable needs **one host process** that owns the Harness, a lock, and a transport (the sample sends `watchEvents` batches over WebSockets). UI 1 (ttyd → tmux → TUI) has no Durable TUI to attach. | S8 scenarios 5, 6 |
| **The no-network Python sandbox as an execution environment** | **Possible, not cheap.** Either write an `ExecutionEnv` against sandboxd's HTTP API (`/exec`, `/files`, `/access`, `/reset`, `/healthz`; about 25 `FileSystem` methods plus `Shell`), or register same-name custom tools as S8 did. `pi-env`'s daemon would replace sandboxd and its hardening (per-command `RLIMIT_NPROC`, `killpg`, minimal env, timeouts; ADR 0001), and it needs SSH or a stdio bridge into a no-network container. Not worth it. | `env/README.md`; `sandbox/sandboxd.py:6` |
| **Phase 2 topology: ECS (ADR 0006) vs Cloudflare Durable Objects** | **ECS stays right.** A DO is a JavaScript isolate with a 128 MB memory limit (named in Durable's own 1.3.0 CHANGELOG entry about `toBase64`), so it cannot run Python or HiGHS. Gaffer's sandbox would become a Cloudflare Container: GA 2026-04-13; up to `standard-3` (2 vCPU, 8 GiB) and `standard-4`; `enableInternet: false`, with outbound denied by default (`@cloudflare/containers` 0.3.7 README). Gaffer's own hardening (gVisor, seccomp, cap-drop) would give way to Cloudflare's isolation. UI 1's PTY cannot live in a DO, and Gaffer would have to move entirely onto Durable (option c). On ECS, Durable SQLite on EFS hits SQLite's rule that WAL does not work over a network filesystem, and needs a single-writer lock. | S8; Cloudflare docs; sqlite.org/wal.html |

### 6.1 The Cloudflare sample (`pi-durable-cloudflare` @`dcb56ce`)

- **Shape:**
  - A Worker routes `/api/sessions/:id` WebSocket upgrades to **one Durable Object per session**; conversations and forks live inside it.
  - The DO opens `openDurableObjectSqliteStorage(ctx.storage)` in `blockConcurrencyWhile` (`src/session.ts:166-170`).
  - It holds hibernatable WebSockets. Each socket's attachment stores the username and the selected conversation.
- **Streams:**
  - Per socket: `watchEvents()` for the selected conversation (`src/session.ts:511`), sent as `conversation.events` batches after a snapshot.
  - Shared: `session.snapshot` (the conversation list), `session.activity` (the task graph), `conversation.inbox`, `presence.typing`, `command.result`.
  - Commands carry a `requestId` and are resent by a client outbox (`src/client/command-outbox.ts`).
- **Recovery and scheduling:**
  - A 60 s recovery alarm resumes work after eviction (`RECOVERY_ALARM_DELAY_MS`, `src/session.ts:50`).
  - A `schedule` tool creates `DeliverScheduledInstruction` tasks that `runtime.sleep(runAt)` (`src/schedule.ts:216-222`). The DO alarm is reconciled from `harness.inspect()`.
  - `documentRetentionMs: 0`, because timers would keep the DO from hibernating (`src/chat.ts:56`).
- **Auth and tenancy:** none. The blog says "The demo intentionally has no authentication", and `src/index.ts:28` says "Demo-only surface: authenticate and rate limit before exposing". The session UUID in the URL is the only boundary.
- **Size:**

  | Part | Lines |
  |---|---|
  | Server `src/*.ts` (`session.ts` 685, `protocol.ts` 480, `schedule.ts` 307, `tools.ts` 267, `search.ts` 202) | 2,066 |
  | React client (`.ts`/`.tsx`) | 2,155 |
  | CSS | 483 |
  | Tests | 2,882 |

  Pins: `pi-durable`, `pi-ai` and `chord` 1.2.0. Model: OpenAI `gpt-6-luna`.

---

## 7. Options

| Option | Effort | Risk | Minimalism | "Pi package, Pi core unchanged" thesis |
|---|---|---|---|---|
| **(a)** Stay on `pi-coding-agent` 1.x; design seams only | ~0.5–1 day on top of R7's migration | Low | Best | Intact |
| **(b)** Durable as the backend of UI 2 only | ~1,500–2,500 new lines (host, WebSocket protocol, lock, port of tools and guard, env or custom tools, a second set of usage readers), ~2–3 weeks | High: two runtimes, **two session stores** (a session cannot move between UIs, against the brief's "I lean yes"), two agents to keep equal under evals, experimental API | Poor | Split: UI 1 is a Pi package, UI 2 is a Durable app |
| **(c)** Move Gaffer entirely onto Durable | ~3,500–5,000 lines new or rewritten: extensions ~400, host and transport ~1,200, TUI for UI 1 ~1,200 (the removed experimental shell was ~1,230), env or tools ~300–600, JSONL readers ~650, skills, templates and commands ~300. ~4–6 weeks. | Very high: 14 breaking changes in 14 days; no TUI, skills or packages; every eval re-baselined | Poor | **Ends it.** Gaffer becomes a Durable application, NFR-MNT-01's premise ("uses the npm-published pi-coding-agent") no longer applies, and the Phase 1 evidence is about a different harness |
| **(d)** Defer to Phase 3 with triggers | 0 now | Low | Good | Intact |

**Recommendation: (a) now, with (d)'s triggers written into the ADR.**
- Gaffer's run is short, single-user and cheap. The crash cost today is one extra user prompt, which S8's baseline measured.
- Durable's biggest selling point for Gaffer, many clients on one live conversation, needs a host process and a transport that Gaffer must build either way. Durable adds nothing there that `pi --mode rpc` behind one host doesn't (R11's question).
- The features Gaffer actually relies on (skills, templates, TUI, commands, `models.json`, JSONL readers) are all missing.
- The API is explicitly unstable.

**Seams for (a).** Each comes with why Gaffer can't do without it:
1. **One owner per session.** UI 2's host must take a lock before spawning or attaching Pi for a session file. Why: two owners of one store double-run work (S8 scenario 6). The same risk applies to two `pi` processes on one JSONL.
2. **An event reducer that is independent of the transport.** Build UI 2's state from `message_*`, `tool_execution_*` and `turn_*` events plus tool `details`. Why: Pi RPC events and Durable's `watchEvents` use the same names (`events.ts:61-99`), so the UI can switch backends later without being rewritten.
3. **Make an interrupted run visible.** On `session_start` (reason `resume`), if the branch ends in an assistant message with unresolved tool calls, notify the user: "Your last run was interrupted; run /gw again". This is ~15 lines and is **optional**. Why: it is the cheap 80% of Durable's crash safety for a 75 s run. Adopt it only if Phase 2 shows restarts mid-run.

   Also keep `src/` free of Pi types, which is true today for ~3,000 of its 4,100 lines, so a later port only rewrites the thin extensions.

---

## 8. Triggers to revisit Durable

Revisit when **any** of these holds:

- **T1 (stability):** Durable drops "Experimental" from its README, and two consecutive minor releases ship with no Breaking Changes section.
- **T2 (transport):** Pi ships a supported cross-process attach for conversations, with auth (a Durable server, a Chord-based conversation service, or `pi-coding-agent` itself moving onto Durable).
- **T3 (need):**
  - Phase 2 logs show ≥5% of recommendation runs interrupted by task replacement or restarts; or
  - Phase 3 needs agent work that outlives a user turn (deadline-day monitoring, background subagents); or
  - per-user persistent agents need Cloudflare-style hibernation economics.

Check point: the existing "Pi API churn" checkpoint at each Pi release (ROADMAP "Standing risks"), and the start of Phase 3 planning.

---

## Sources

- `packages/durable` @v1.3.0 (2026-10-15):
  - `README.md` (768 lines), `docs/spec.md`, `CHANGELOG.md`
  - `src/harness/{types,tool,generation,events,scheduler}.ts`, `src/env/index.ts`, `src/storage/{sqlite,jsonl}/*`, `src/documents.ts`, `src/types.ts`
  - `test/examples/00–31` (all read; 2,879 lines)
- `packages/durable` @v0.87.1 (2026-09-22): `README.md`, `CHANGELOG.md` (the Pico record layer only)
- `packages/env` @v1.3.0: `README.md`, `CHANGELOG.md`, `package.json`, `src/` (line counts)
- `packages/chord` @v1.3.0: `README.md`, `CHANGELOG.md`
- `packages/coding-agent` @v1.3.0: `CHANGELOG.md:107-110`, `package.json`, `src/index.ts` (exports), `src/core/slash-commands.ts`
- Git history of `earendil-works/pi`:
  - `5609b0d6c` (2026-10-01): durable TUI agent
  - `48dd1e2f0` (2026-10-01): client/server ported to Durable
  - `395315f48` (2026-10-01): vacation planner
  - `7472cda0d` (2026-10-12): removal
  - `0104fef1e` (2026-10-12): chord2 runtime
  - files read with `git show 7472cda0d^:packages/coding-agent/src/experimental/{durable,vacation}/*`
- `packages/ai/src/api/transform-messages.ts` @v0.87.1 (the synthesised result for a dangling tool call)
- Blog, Earendil Engineering, "Pi Durable", https://earendil.com/posts/pi-durable/ (2026-10-01, fetched 2026-10-17)
- Blog, Earendil Engineering, "Pi Durable on Cloudflare", https://earendil.com/posts/pi-durable-on-cloudflare/ (2026-10-16, fetched 2026-10-17)
- https://github.com/earendil-works/pi-durable-cloudflare @`dcb56ce` (2026-10-15), cloned and read: `src/*.ts`, `src/client/*`, `wrangler.jsonc`, `package.json`
- npm registry (2026-10-17):
  - `npm view @earendil-works/pi-durable time`, and the same for `pi-env`
  - `npm view @earendil-works/pi-coding-agent@<v> dependencies`
  - downloads API, `pi-durable` last week: 337,997 (2026-10-06…12)
  - `@cloudflare/containers` 0.3.7 README (`enableInternet`); `@cloudflare/sandbox` 1.0.1
- Cloudflare changelog, "Containers and Sandboxes are now generally available", https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/ (2026-04-13)
- Cloudflare Containers limits, https://developers.cloudflare.com/containers/platform-details/limits/ (undated, fetched 2026-10-17)
- Cloudflare Durable Objects limits, https://developers.cloudflare.com/durable-objects/platform/limits/ (undated, fetched 2026-10-17)
- SQLite, "Write-Ahead Logging", https://sqlite.org/wal.html (undated): WAL needs shared memory and does not work over a network filesystem
- Spike S8, `spikes/s8-durable-gaffer/` (2026-10-17): `spike-output.txt`, `baseline/baseline-output.txt`

## Unconfirmed

- **Why the experimental stack was removed.** The commit and CHANGELOG say only what was removed. The link to the Chord runtime replacement the same day is my inference.
- **Who drives Durable's npm downloads.** No published `@earendil-works` package depends on it, and I did not search GitHub dependents. The blog names no external adopters.
- **The DO memory limit.** The 128 MB figure comes from Durable's own 1.3.0 CHANGELOG; the Cloudflare DO limits page I fetched did not state a memory figure.
- **Cloudflare Containers egress.** Default-deny with `enableInternet: false` comes from the `@cloudflare/containers` README, not a test. Cloudflare's isolation model was not compared with gVisor and seccomp.
- **Effort estimates** in §4.2 and §7 are line counts by analogy (the removed experimental shell, the Cloudflare sample, pi-env), not builds.
- **Pi 0.87.1 and a stream killed mid-model-call.** The baseline killed only mid-tool. Whether the killed call's spend is lost from the JSONL, and therefore from Gaffer's budget, was not tested. Durable does record it (S8 scenario 4).
- **The spike was not type-checked** (Node strips types). It ran clean on Node 26.10.0.
- **SQLite on EFS** was not tested; it is from SQLite's documentation.
- **The "No result provided" synthesis on Pi 0.87.1** is from source (`transform-messages.ts`). The baseline's faux model logged only the last message it received, so the inserted result was not seen directly.
- **Fork tool-call IDs.** The fork test used pi-ai's faux provider, which makes up tool-call IDs. Whether real providers accept a fork whose inherited context ends in a tool result followed by a new user message was not tested with a real model.
