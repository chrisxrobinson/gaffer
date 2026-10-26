# Spike S8 — A Gaffer-shaped run on pi-durable 1.3.0

**Date:** 2026-10-17 · **Packages:** `@earendil-works/pi-durable@1.3.0`, `pi-ai@1.3.0`, `chord@1.3.0` (npm, 2026-10-15); baseline `pi-coding-agent@0.87.1` (Gaffer's pin) · **Model:** pi-ai `fauxProvider`, no API spend · **Result: the agent core is as small as on Pi (68 lines), and crash recovery works as documented. But watching only works inside one process, two processes on one store run work twice, and everything around the agent core (UI, commands, skills, session readers) is missing.**

## Question

How much code does a Gaffer-shaped run need on pi-durable 1.3.0? Does it survive a crash mid-run, and which tool calls run again, with and without `replay: "safe"`? Can a second client watch the run? Can a what-if be a fork at the snapshot step?

## Method

- `gaffer-durable.ts` is the "product code". It has:
  - a `preamble` section and dynamic `fpl_context` and `user_preferences` sections, read from typed documents
  - `fpl_snapshot` (`replay: "safe"`), which writes a `SnapshotDoc`
  - `bash`, which streams from a stub `sandboxExec()` shaped like sandboxd's `POST /exec`, with replay set per run
  - a `hook(ToolTask, { beforeTool })` guard that blocks FPL account endpoints and writes to `/data`
  - a terminating `submit_recommendation`, which writes a typed `RecommendationDoc` and returns `control: { terminate: true }`
  - a session-scoped `PrefsDoc`
  - SQLite storage on disk (`openNodeSqliteStorage`)
- `scripted-model.ts` is a faux model that picks its next step from the transcript it receives. A restarted process therefore gets the same answers. The script is snapshot → golden-path `bash` → forbidden `curl` (which gets blocked) → `submit_recommendation`. In a what-if, it runs `bash … --keep 154` and then submits with Palmer as captain.
- `run-spike.ts` runs six scenarios:
  1. A complete run with three clients: `watchEvents` attached before the run, `watch()`, and a late `watchEvents` joining during the golden-path bash. A fork at the `fpl_snapshot` result then gets a what-if.
  2. A child process is SIGKILLed during the golden-path bash (3 of 8 output lines done), with `replay: "unsafe"` (the default). A second process reopens the storage.
  3. The same, with `replay: "safe"`.
  4. The process is SIGKILLed while the model is streaming its second answer.
  5. A second process opens the same SQLite file and calls `watch()` while another process runs.
  6. Two processes own the same storage at once, like an overlapping container restart.
- `effects.log` gets a synchronous line at every tool start and end, with the pid. It shows exactly which executions ran and which ran again.
- `baseline/baseline-pi.ts` is the comparison on Gaffer's pin, pi-coding-agent 0.87.1. It SIGKILLs in the middle of a tool, then reopens with `SessionManager.continueRecent` (what `pi --continue` does).

## Result

**Lines of code.** Counts exclude blank and comment lines.

| | Lines |
|---|---|
| `gaffer-durable.ts`: product code | 111 |
| … of which the extension (4 sections, 3 tools, the guard hook) | 68 |
| … of which host setup (storage, registry, model, root) | 11 |
| `scripted-model.ts` (test double) | 39 |
| `run-spike.ts` (scenarios) | 203 |

For comparison, S1's equivalent extension on Pi 0.87.1 was also 68 lines. The agent core costs the same on either runtime.

**Scenarios** (all from `spike-output.txt`):

| # | Scenario | What happened | Tool calls that ran again |
|---|---|---|---|
| 1 | Complete run | `done` in 2.5 s with 4 model calls. Transcript: `user, system, assistant(fpl_snapshot), result, system(fpl_context only), assistant(bash), result, assistant(bash), result ERROR "Tool call blocked: FPL account endpoints…", assistant(submit_recommendation), result`. **No model call after the terminating tool.** `settled.answer` is the entry of the tool-calling assistant message, not a text answer. | — |
| 1 | System prompt | First `pi.system` entry: `preamble`, `fpl_context` ("No snapshot yet"), `user_preferences`. After the snapshot, a second `pi.system` entry carries **only** the changed `fpl_context`. | — |
| 1 | Client 1 (`watchEvents`, attached before the run) | Saw `run_start`/`run_end`, 4 turns, 3 `tool_execution_start` and **4** `tool_execution_end` (the blocked call ends without a start), and 8 `tool_execution_update`. It got 9 `thinking_delta` for the long thinking block, but **0 `text_delta` and 0 `toolcall_delta`**: short blocks shorter than the 100 ms commit interval arrive whole in `message_end`. | — |
| 1 | Client 2 (`watch()`) | 40 frames, 79 Chord ops. | — |
| 1 | Client 3 (late join) | Its snapshot showed `bash: running`, then 6 output updates and the rest of the run. | — |
| 1 | What-if fork at the `fpl_snapshot` result | The fork started with `SnapshotDoc` (`fork: "asOf"`) and **no** recommendation. It inherited entries 8–15 without copying them, ran `bash --keep 154` and submitted with Palmer as captain. The parent's recommendation (captain Haaland) was unchanged. | — |
| 2 | SIGKILL in bash, `replay: "unsafe"` | The reopened process gave the model an **error result**: the 3 committed output lines plus "Tool bash was interrupted and may have partially run". The model called bash again with a **new call ID** (one extra model call), then finished. | bash, as a new call chosen by the model |
| 3 | SIGKILL in bash, `replay: "safe"` | The reopened process **reran the same call ID** without asking the model. The transcript shows one clean bash result. | bash, the same call (automatic) |
| 4 | SIGKILL mid model stream | The committed partial became a `pi.assistant(aborted)` entry, which is never sent to the model, and the request was sent again. The killed attempt's tokens stay in `pi.usage` (output tokens 898, against 135–190 in the other runs). | the model request only |
| 2–4 | `fpl_snapshot` | It finished before the crash and never ran again. | none |
| 5 | Second process `watch()` on the same file | It opened without error. While the other process added 6 entries it got **0 frames**; a fresh read afterwards found them. **`watch()` and `watchEvents()` see only commits made in their own process.** | — |
| 6 | Two processes own one storage | Process B treated A's running bash as interrupted, and the model started a second bash while A's was still running, so **the sandbox command ran twice at the same time**. Process A then failed with `SessionFailed: … Task 18 is already terminal` and exited 1. There is no lock: the README says "One process owns a storage at a time; there is no cross-process locking". | bash ran twice, at the same time |
| B | Baseline: pi-coding-agent 0.87.1, SIGKILL mid-tool | The JSONL held `user` and `assistant(toolUse)`, and no tool result or partial output. After `continueRecent` nothing ran by itself (0 model calls in 1.5 s). The user had to type again, and the model then re-ran the tool as a new call. | the tool, only after the user prompts again |

**API friction found:**
- Every call takes a Chord `Context` (`BACKGROUND_CONTEXT`).
- A tool result is `output`, not `content`; termination is `control.terminate`. Both changed in 1.2.0, and `terminate`'s type changes again after 1.3.0.
- **Hooks cannot abort or steer a run.** `GenerationHooks` only replaces messages, observes, or continues on yield. `gaffer-budget`'s `ctx.abort()` and `sendMessage({deliverAs: "steer"})` therefore move into host code (watch `pi.usage`, `conversation.abort()`, `submit({whenBusy: "steer"})`).
- A non-replay-safe tool that commits a document and then dies before its result is committed leaves the document written while the model sees "interrupted". `submit_recommendation` would need an idempotency key (`api.memo`) to avoid a second recommendation or ledger row.
- The spike was not type-checked (Node strips the types at run time).

## Impact on the design

- **Crash safety works**, but for Gaffer it saves little. Today a restart loses the in-flight tool and needs one more user prompt (baseline). Durable resumes by itself, at the price of one extra model call (unsafe) or one silent rerun (safe). For a 75 s, ~$0.06 run, that is a small gain.
- **Typed documents and forks at any entry work as advertised.** The what-if fork is the cleanest fit found.
- **"Both UIs watch one live conversation" is not something durable provides across processes.** A host process must own the Harness and push `watchEvents` batches over its own transport, as the Cloudflare sample does over WebSockets. It also needs a single-owner lock (scenario 6).
- Spike code is throwaway; nothing here is merged.

## Re-run

```bash
cd spikes/s8-durable-gaffer
npm ci                       # pi-durable 1.3.0, pi-ai 1.3.0, chord 1.3.0, typebox 1.3.27 (exact pins)
TMPDIR=$(mktemp -d) node run-spike.ts | tee spike-output.txt
cd baseline && npm ci && TMPDIR=$(mktemp -d) node baseline-pi.ts | tee baseline-output.txt
```

Node 26.10.0 runs the `.ts` files directly (type stripping). The run makes no network or model calls. Each scenario writes its SQLite file and `effects.log` to a fresh directory under `$TMPDIR` and prints the path.
