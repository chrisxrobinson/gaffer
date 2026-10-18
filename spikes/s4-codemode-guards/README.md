# S4: codemode nested calls vs Gaffer's guard, events and budget (Pi 1.3.0)

Spike for Phase 1.1 research note 09 (codemode and MCP). Date: 2026-10-17. Pi `@earendil-works/pi-coding-agent@1.3.0`, installed exactly in this directory. Faux model and a local fake classifier only: no network, no paid calls. Codemode is enabled here on purpose, and only here.

## Question

Do tool calls made inside a codemode script pass through extension `tool_call` guards, the `tool_execution_*`/`tool_result` events, the session JSONL and Gaffer's cost accounting? What can a script reach directly? What does the codemode description cost in prompt tokens for Gaffer's seven tools, with `codemode.mode` `on` vs `only`?

## Method

`run.ts` is one SDK host built like `packages/pi-gaffer/test/harness.ts` (`noExtensions`, `bindExtensions`, `tools: GAFFER_TOOLS + codemode`), with:

- **Gaffer's real policy and budget code**, imported read-only from the repo: `checkToolCall()` from `src/guard.ts` as the `tool_call` handler, and `sessionCost()` from `src/budget.ts` in a `turn_end` handler. The handler compares it with the sum of `usage.cost.total` over *all* messages, which is what Pi's footer counts.
- **A gaffer-sandbox stand-in.** `bash/read/write/edit` are re-registered with `create*ToolDefinition(cwd, { operations })`, and the operations only record what they were asked to do. A call that reaches `exec` is a call that would have run in the sandbox.
- **Stubs of `fpl_snapshot`, `submit_recommendation` and `set_preferences`** with their real descriptions and schemas. The `Submission`, `Risk` and `Chip` schemas are imported from `src/schema/recommendation.ts`.
- **A fake classifier provider** (`fakecls/fake-jev`, local, charges $0.50 per call) to see where codemode puts `models.classify()` usage.
- `createCodemodeExtension()` (with `models`).

The faux model makes two `codemode` calls:
1. A probe script. It checks `typeof process/require/fetch/setTimeout/WebAssembly/XMLHttpRequest`, the global names, `import("node:fs")` and `new Function("return this")().process`. Then it makes three calls: an allowed `tools.bash`, a `tools.bash` whose `curl …/api/my-team/1/` URL is assembled at run time (so the outer call's arguments don't contain it), and a `tools.write` to `/data/x.json`. It also tries `tools.codemode`, `models.getAvailableOfType("classifier")` and `models.classify()`.
2. A script with the literal `/api/my-team/` in its source.

Three more sessions record the provider request (declared tools and system prompt) with codemode inactive, `on` and `only`.

## Result

**Guards, events, JSONL** (`results.json`):

| Call | `tool_call` handler ran? | `parentToolCallId` | Guard verdict | Reached the "sandbox" operations? | Inside the script |
|---|---|---|---|---|---|
| `codemode` (probe script) | yes | – | allowed | – | – |
| nested `bash` `python3 -c 'print(2+2)'` | yes, id `<codemode id>/1` | the codemode call | allowed | **yes**, through the re-registered `bash` override | resolved to `{ output, … }` |
| nested `bash` `curl …/api/my-team/1/` | yes, `/2` | the codemode call | **blocked** | no | **rejected** with the guard's reason |
| nested `write /data/x.json` | yes, `/3` | the codemode call | **blocked** | no | **rejected** with the guard's reason |
| `codemode` with the literal `/api/my-team/` | yes | – | **blocked** (the guard stringifies the whole input, so script source counts) | – | the script never ran |

- `tool_execution_start`/`tool_execution_end` fired for every nested call, with `parentToolCallId`. `tool_result` fired only for calls that executed, as for direct calls.
- The session JSONL has **no message per nested call**. The codemode `toolResult` message carries a `nestedCalls` record instead: id, name, arguments, status, duration and error (`core/nested-tool-calls.ts @v1.3.0`, limits of 256 calls and 32 KiB of arguments).
- The nested call ran the tool that Gaffer's extension registered under that name, so it went to the sandbox and not to the host. Nested calls resolve against `ctx.tools`, the session's registered tools (`agent-session.ts:1563-1573`).
- `tools.codemode` does not exist inside a script (`exposure: "model-only"`), so scripts cannot nest scripts.

**Reach of a script.** `process`, `require`, `fetch`, `setTimeout`, `WebAssembly` and `XMLHttpRequest` are all `undefined`. `import("node:fs")` fails ("could not load module"). `Function("return this")()` gives the VM's global, which has no `process`. Globals: `atob, btoa, console, decodeURI*, encodeURI*, escape, eval, exit, globalThis, image, isFinite, isNaN, load, models, parseFloat, parseInt, performance, queueMicrotask, searchTools, describeTool, describeNamespace, store, text, tools, unescape`. **But `models` is a live capability.** `models.getAvailableOfType("classifier")` listed the fake classifier, with no `headers` (they are stripped, `extensions/codemode/execute.ts:93-98`), and `models.classify()` ran it, using the session's credentials. In a real harness that is an outbound request, carrying script-chosen data, to any classifier or image provider the harness has a key for.

**Budget** (`turn_end`, three turns):

| | `gaffer-budget` `sessionCost()` | sum of all messages' `usage` (Pi's footer) |
|---|---|---|
| after the classify call | **$0.00** | $0.50 |

Pi adds a script's `models.*` usage to the **codemode `toolResult` message's `usage`** (`execute.ts:568-571`; for nested tools, `agent-session.ts:1108-1117`). `src/budget.ts:15` counts only `role: "assistant"` messages, so **Gaffer's caps would not see classifier or image spend at all**. `src/usage.ts:232-236` (per-tool stats) would also count one `codemode` call and none of its nested `bash` calls.

**Prompt cost for Gaffer's seven tools** (the JSON of `name + description + input_schema` for each declared tool, plus the system prompt):

| `codemode` | Declared | Tool decl. chars | System prompt chars | Total chars | ≈ tokens (chars/3.5) | ≈ tokens (chars/4) | Δ vs off |
|---|---|---|---|---|---|---|---|
| inactive (Gaffer today) | 7 tools | 11,583 | 3,103 | 14,686 | 4,196 | 3,672 | – |
| active, `mode: on` | 7 + `codemode` | 13,733 | 3,290 | 17,023 | 4,864 | 4,256 | **+668 / +584** |
| active, `mode: only` | `codemode` only | 11,935 | 2,132 | 14,067 | 4,019 | 3,517 | −177 / −155 |

- With `on`, the codemode description is 1,422 chars and lists no tools (all seven are `direct`). Each declared tool also gains a line such as "Codemode: `tools.bash(args)` resolves to `{ output, truncated, … }`" (`bash-description-on.txt`).
- With `only`, the 11,460-char codemode description holds all seven declarations, inside the 3,000-token `inlineBudget`.
- Both descriptions tell the model to "Read …/pi-coding-agent/docs/codemode.md first" before using `models`. That is a harness path, and Gaffer's sandboxed `read` cannot reach it.

## Impact on the design

- **Policy holds if codemode is ever enabled.** Every nested call runs Gaffer's `tool_call` guard and Gaffer's own tool overrides, so the read-only rule and the sandbox routing would survive codemode.
- **The surrounding accounting and run semantics do not hold:**
  - classifier and image spend is invisible to `gaffer-budget` and `/usage`;
  - nested calls are missing from `/usage` per-tool stats and from anything that reads only `toolResult` messages (`scripts/replay.ts`, `gaffer admin`);
  - a script that calls `tools.submit_recommendation` gets the result as a value, but the run does not end. `terminate` is honoured only for model-issued calls (`packages/agent/src/agent-loop.ts:272,691 @v1.3.0`), which breaks gaffer-recommend's "terminating tool" contract. This was read from source, not run here.
- **The `models` global turns generated JS in the harness into an egress channel with Gaffer's credentials.** That is the opposite of NFR-SEC-01. See note 09 §3.
- **`on` costs about 600–670 prompt tokens per request and buys Gaffer nothing it uses. `only` hides `submit_recommendation`'s strict schema behind a JS string.**
- **Verdict: keep codemode off** (S3's lock). If codemode is ever wanted, `sessionCost()` must also sum `toolResult` usage, the tests must cover nested `submit_recommendation`, and the codemode extension should be created with `models: false`.

## Re-run

```sh
cd spikes/s4-codemode-guards
npm ci
env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u OPENROUTER_API_KEY PI_OFFLINE=1 node run.ts > run.log
```

Outputs: `results.json`, `run.log`, `codemode-description-{on,only}.txt`, `bash-description-on.txt`.
