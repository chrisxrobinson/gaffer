# 09 — Codemode, MCP and the other built-ins (Pi 1.3.0)

Research date: 2026-10-17.

**Version read:** `@earendil-works/pi-coding-agent` **1.3.0** (2026-10-15, commit `71023aec`), with `pi-codemode` 1.3.0 and `pi-mcp` 1.3.0. Gaffer is pinned to 0.87.1, which had none of this: codemode, `tool_search`, MCP and llama.cpp arrived as built-in extensions in **0.99.0** (2026-09-29). Citations are `packages/<pkg>/<path>:LINE @v1.3.0`; `src/…` means `packages/coding-agent/src/…`. Spikes: [`spikes/s3-mcp-lockdown`](../spikes/s3-mcp-lockdown.md) and [`spikes/s4-codemode-guards`](../spikes/s4-codemode-guards.md), both run against Pi 1.3.0 with the faux model only.

---

## TL;DR for Gaffer

| Question | Answer | Evidence |
|---|---|---|
| Does codemode beat Gaffer's pattern? | Not in a way Gaffer needs. Gaffer already does "code mode" in the right place: Python in the no-network sandbox. Codemode's only possible gain is chaining harness tools in one model turn, at most 1–2 of a median 6 model calls. A deterministic chain in Gaffer's own code gets the same gain. Active codemode costs about +600–670 prompt tokens per request. | §1, S4 |
| Do nested calls pass Gaffer's guard? | **Yes.** `tool_call` (with `parentToolCallId`), `tool_execution_*` and Gaffer's own tool overrides all apply. **But** `gaffer-budget` doesn't see `models.*` spend, `/usage` doesn't see nested calls, and a nested `submit_recommendation` would not end the run. | §2, S4 |
| Does codemode change the threat model? | **Yes.** Generated JavaScript runs in the harness, in a QuickJS-in-wasm worker thread of the process that holds the key. Through `models.*` it can send data to classifier and image providers with Gaffer's credentials. That is the thing ADR 0001 / NFR-SEC-01 rule out. | §3, S4 |
| `codemode.mode`? | There is no `off` value (`on` \| `only`). Gaffer should leave the tool unregistered and the built-in unloaded. **Verdict: off.** | §4 |
| Classifiers for injection or news triage? | **No.** Cost is negligible (well under 0.5% of a run), but none of them uses Gaffer's Anthropic key, so each adds a provider, a secret and a data flow. Gaffer's injection defence is capability-based and passed 2/2, and FPL's `status`/`chance_of_playing_*` fields already triage availability. | §5 |
| MCP (ADR 0002)? | **ADR 0002 stands.** The survey found 51 GitHub repositories and none is maintained enough to adopt. The best-known ones need an FPL login, or can make transfers. | §6 |
| Can it all be locked off? | **Yes, but Gaffer's current launch line is not enough on 1.x.** On 1.3.0, `--tools <allowlist>` keeps MCP tools away from the model, but **every configured MCP server is still spawned in the harness, with `ANTHROPIC_API_KEY` in its environment**. The `mcp_servers` prompt section is also injected. Lock: `--no-mcp` plus `-builtin:*` in the agent `settings.json`, plus the existing `--tools`. | §7, S3 |

Recommended lock (spelled out in §7.4):

```sh
# harness/gaffer-pi
pi --session-dir /sessions --no-context-files --no-mcp --continue --tui-mode fullscreen \
   --tools read,write,edit,bash,fpl_snapshot,submit_recommendation,set_preferences
```
```json
// /opt/pi-agent/settings.json (written in harness/Dockerfile after `pi install`)
{ "extensions": ["-builtin:mcp", "-builtin:codemode", "-builtin:tool-search", "-builtin:llama.cpp"], "theme": "gaffer" }
```

---

## 1. Where codemode could beat Gaffer's pattern

### 1.1 What codemode is

`codemode` is a tool whose input is raw JavaScript. Pi runs it as an async function body in a fresh QuickJS VM compiled to WebAssembly, in a Node worker thread (`packages/codemode/README.md`; `src/extensions/codemode/tool.ts:118-120`). The script calls other tools as `await tools.<name>(args)`, and only its output reaches the model. It can also call `models.classify()` and `models.generateImages()` with the session's credentials (`src/extensions/codemode/execute.ts:664-772`).

The tool is registered *inactive* (`src/extensions/codemode/index.ts:44`). It is turned on by `--tools`, `defaultTools` or `setActiveTools()`, or automatically by the MCP extension when a server has `codemode` exposure (`src/extensions/mcp/index.ts:501-525`).

### 1.2 Gaffer's actual runs

From the 2026-10-16 real-model eval (`evals/results/2026-10-16-anthropic_claude-sonnet-5-5.jsonl`, 30 cases):

| Metric | Value |
|---|---|
| Model calls per run | min 4, **median 6**, max 7 (the brief said 4–5) |
| Cost per run | median **$0.066** |
| Latency | median **75 s** |
| Most common tool sequence (9/30) | `fpl_snapshot > read > bash > read > bash > bash > bash > submit_recommendation` |

The `read` after the snapshot is the golden-path skill. The `bash` calls are the golden path and Python inspection in the sandbox.

### 1.3 The three places codemode might help

| Codemode benefit | Gaffer today | Gain from codemode |
|---|---|---|
| **Batching** independent calls | `fpl_snapshot` already fetches element summaries inside the tool, 8 at a time (ADR 0002). Pi can also run several model-issued tool calls from one assistant message in parallel. | None. |
| **Filtering large payloads** before they reach the context | `fpl_snapshot` returns a summary under 1.5k tokens and never raw JSON. Detail is read by Python in the sandbox, which prints only what the model needs. That *is* code execution with filtering, on the right side of the boundary (ADR 0001). | None. It would be a second code-execution environment, in the wrong container. |
| **Chaining dependent calls** in one model turn | snapshot → skill → golden-path `bash` → inspect → submit. Each step is a model turn. | At most 1–2 of 6 calls, for example snapshot + golden path in one script. At the medians, one call is about $0.011 and 12 s (a crude average). The submission still needs the model to reason over the plan, so it stays a turn. The same saving is available deterministically: a harness tool or a `gaffer_lib` command that runs the snapshot and the golden path together, reviewed and tested, not model-written JS. |
| **Running classifiers** | none | See §5: not wanted. |

Anthropic's own guidance on comparable features points the same way (2025-11-24). Programmatic tool calling is "not worth using" for single simple calls, small responses, or when the model must reason over every intermediate result. Tool search is not worth it under 10 tools or with compact definitions. Gaffer has 7 tools, compact results, and a final step that needs reasoning. Anthropic's code-execution post (2025-11-04) reports a 98.7% saving (150k → 2k tokens), but for workflows that pass large documents between MCP tools. It also warns that generated code "requires a secure execution environment".

### 1.4 Prompt-token cost, measured (S4)

Gaffer's 7 tools, with real descriptions and schemas. The declared tools are measured as JSON (`name + description + input_schema`), plus the system prompt:

| | Total chars | ≈ tokens (÷3.5) | ≈ tokens (÷4, Pi's own estimate) | Δ |
|---|---|---|---|---|
| codemode inactive (today) | 14,686 | 4,196 | 3,672 | – |
| codemode active, `mode: on` | 17,023 | 4,864 | 4,256 | **+668 / +584** |
| codemode active, `mode: only` | 14,067 | 4,019 | 3,517 | −177 / −155 |

- **With `on`**, the codemode description is 1,422 chars. Each declared tool also gains a "Codemode: `tools.x(args)` resolves to …" line (`src/extensions/codemode/tool.ts:320-356`).
- Per run, with Gaffer's prompt cache (`harness/models.json`: write $2.5/MTok, read $0.2/MTok, 6 calls), `on` adds about **$0.0023 (≈3.5% of the median run)**. Uncached it is about $0.008. That is for a tool Gaffer would not use.
- **With `only`**, the prompt is slightly smaller, but all seven tools disappear behind one JavaScript string:
  - `submit_recommendation`'s provider-side strict schema is lost (`compat.supportsStrictTools` in `harness/models.json`);
  - its `terminate` stops working (§2);
  - every call becomes a script.
- Both modes' descriptions tell the model to read `…/pi-coding-agent/docs/codemode.md`, a harness path that Gaffer's sandboxed `read` cannot reach.

### 1.5 Reliability

Codemode is three weeks old. Its changelog from 1.0.1 to 1.3.0 fixes crashes and other serious bugs:
- out-of-memory crashes from output loops (#10283);
- built-in patches crashing the host (#10444);
- quadratic output joining that blocked for minutes (#10678);
- a broken bridge under `node --watch` (#10725);
- surviving workers piling up after timeouts (#10748).

Gaffer is 30/30 valid without it.

## 2. Do nested calls pass Gaffer's guard, events and budget? (S4)

Nested calls go through `ctx.executeTool()` and then `AgentSession._executeNestedToolCall()`. That function runs `runToolCall()` with the session's `beforeToolCall`/`afterToolCall` hooks, passing the parent id (`src/core/agent-session.ts:731-768`, `src/core/nested-tool-calls.ts:176-250`). S4 ran Gaffer's real `checkToolCall()` and confirmed:

| Check | Result |
|---|---|
| `tool_call` handler runs for every nested call | **Yes**, with `toolCallId = <parent>/<n>` and `parentToolCallId` |
| Blocked nested call (`curl …/api/my-team/1/` built at run time, `write /data/x.json`) | **Blocked**; the promise rejects inside the script with the guard's reason |
| Script source containing `/api/my-team/` literally | The outer `codemode` call is blocked: the guard stringifies the whole input |
| Allowed nested `bash` | Ran through Gaffer's re-registered `bash` (its `operations`), i.e. the sandbox, not the host |
| `tool_execution_start/end` | Fired for every nested call, with `parentToolCallId` |
| `tool_result` | Fired for executed calls only (same as direct calls) |
| Session JSONL | No message per nested call. A bounded `nestedCalls` record (id, name, arguments, status, error; ≤256 calls, ≤32 KiB of arguments) sits on the parent `toolResult` |
| Script calling `tools.codemode` | Fails: `exposure: "model-only"` |
| **Budget**: a $0.50 `models.classify()` | Pi puts it on the codemode `toolResult` message's `usage` (`execute.ts:568-571`; nested tool usage: `agent-session.ts:1108-1117`). **Gaffer's `sessionCost()` stayed $0.00**: `src/budget.ts:15` sums `role: "assistant"` only. Pi's footer said $0.50 |
| `/usage` per-tool stats | `src/usage.ts:232-236` counts `toolResult` messages, so nested calls are invisible (one `codemode` row) |
| Nested `submit_recommendation` | **Would not end the run.** `terminate` is honoured only for model-issued calls (`packages/agent/src/agent-loop.ts:272,691`). The codemode result carries no `terminate` (from source, not run) |

So **policy holds, but accounting and run semantics don't.** If codemode were ever enabled, Gaffer would have to:
- sum `toolResult` usage in `sessionCost()`/`dayCost()`;
- read `nestedCalls` in `/usage`, `gaffer admin` and `scripts/replay.ts`;
- forbid or handle a nested `submit_recommendation`.

## 3. Threat model (ADR 0001, NFR-SEC-01/02)

**Where scripts run.** `CodemodeSandbox` starts one Node `worker_thread` per execution inside the Pi process (`packages/codemode/src/runtime/host.ts:29-33`). Inside it is a fresh QuickJS wasm instance. Its only imports are a WASI shim (clock, random, discarded stdout/stderr) and one host-call entry point (`packages/codemode/README.md`, "How it works"; `runtime/vm.ts:102-177`). In Gaffer this is the **harness container, the same process as `ANTHROPIC_API_KEY`, with network egress**. Limits:
- at most 2 workers per process (`execute.ts:58`);
- a 256 MB heap (`execute.ts:56`);
- **no deadline by default**: `timeoutMs` is `Infinity` unless the script asks for one (`execute.ts:510`).

**What a script can reach directly (S4 probe): nothing.**
- `process`, `require`, `fetch`, `setTimeout`, `WebAssembly` and `XMLHttpRequest` are `undefined`.
- `import()` fails, and `Function("return this")()` has no `process`.
- NFR-SEC-02 holds *by construction*. But it rests on one in-process language-VM boundary (QuickJS → wasm → V8), not on a container boundary. A VM escape lands next to the key and the network.

**What a script can reach indirectly:**
- **Every callable tool**: the 7, through the same guard and overrides as the model.
- **`models.*` with the session's credentials.** `classify()` and `generateImages()` send script-chosen data to whichever classifier or image provider has a key in the harness. `toModelInfo()` drops `headers`, and calls resolve by provider and id only, so the key itself is not readable (`execute.ts:93-98, 679-711`). But the request is an **outbound network channel from generated code**, and its spend is invisible to `gaffer-budget` (§2).
  - Today the harness has only the Anthropic key, which has no classifier or image models.
  - But `deploy/compose/docker-compose.yml` passes `OPENAI_API_KEY` through when it is set on the host. That alone makes `openai/gpt-6-luna` available as a classifier (`docs/models.md`).
- **Temp files in the harness.** Truncated output and images are written with `writeOutputFile()` (`execute.ts:340-390`). This is minor: the model cannot read them through Gaffer's sandboxed `read`.

**Conclusion.** Codemode is generated code in the harness. ADR 0001 and NFR-SEC-01 say generated code runs only in the no-network sandbox. Earendil's post describes the harness side as the more trusted side and places codemode there, which is exactly the inversion Gaffer's architecture avoids. Keeping codemode off is a security requirement, not a taste.

## 4. `codemode.mode`: off, on or only?

- The setting has only two values, `"on" | "only"`, default `"on"` (`src/core/settings-schema.ts:148-150`, `src/core/settings-defaults.ts:57-60`). "Off" means the `codemode` tool is not active, or not registered at all.
- `on` costs about 600–670 tokens per request (§1.4) and opens §3's channel.
- `only` breaks the strict schema and the terminating `submit_recommendation` (§1.4, §2).

**Verdict: off.** Leave `codemode.mode` unset, keep `codemode` out of the `--tools` allowlist (so it is never registered, S3 rows 2–5), and unload the built-in with `-builtin:codemode` (S3 row 8). Why Gaffer can't do without it: it can. Nothing in Gaffer's 30/30 eval needs it.

## 5. Classifiers for injection screening (NFR-SEC-03) or news triage

**Available at 1.3.0** (catalogue in `pi-ai` 1.3.0, `dist/providers/data/*.json`; prices in $/MTok input, output free):

| Model | Provider id | Auth | Price |
|---|---|---|---|
| Jev (`jev-latest`) | `typesafe` | `TYPESAFE_API_KEY` | $0 in catalogue ("reports tokens at no cost", so even Pi's footer shows $0) |
| Jev 1.13 / 1.14, `~typesafe/jev-latest` | `openrouter` | `OPENROUTER_API_KEY` | $0.042 |
| Jev | `cloudflare-workers-ai` `typesafe/jev`, `vercel-ai-gateway` `typesafe-ai/jev` | Cloudflare / Vercel keys | $0 / $0.042 |
| Jev 1.13 | `opencode` | `OPENCODE_API_KEY` | $0.042 (a free variant exists) |
| GPT-6 Luna (Decisions API) | `openai` `gpt-6-luna` | `OPENAI_API_KEY` (not ChatGPT OAuth) | $0.10 ($0.20 above 272k); accepts images |
| Cloudflare Clef / Clef Flash | `cloudflare-workers-ai` | `CLOUDFLARE_API_KEY` + account id | $0.24 / $0.09 (via OpenRouter $0.042 / $0.021) |
| ~20 more decision models on OpenRouter/Vercel | various | as above | $0–0.15 |
| any llama.cpp model | `llama.cpp` | `LLAMA_BASE_URL` | local |
| *comparison:* Claude Haiku 5.5 (chat) | `anthropic` | **Gaffer's existing key** | $0.10 in / $0.50 out (≤100k prompt) |

**How they are called.**
- From an extension: `ctx.modelRegistry.classify(model, { state, questions }, { signal })` (`src/core/model-registry.ts:173-178`), no codemode needed.
- From codemode: `models.classify()`.
- One call answers several questions about one `state`. The docs advise one call per item.

**Cost for Gaffer.** About 15 news strings (only the user's squad reaches the model) at about 40 tokens each, plus about 150 tokens of question text per call, is 15 calls and about 3k tokens:
- about **$0.0001** on OpenRouter Jev;
- about $0.0003 on GPT-6 Luna;
- about $0.0003 for one batched Haiku 5.5 call (~1.2k in, ~300 out).

All of these are under 0.5% of a $0.066 run. **Latency was not measured** (no paid calls). The docs say only that Decisions API requests over about 5 s time out at the gateway, which concerns very large inputs.

**Value for Gaffer.**
- NFR-SEC-03 is met by *capability* limits, not detection:
  - news reaches the model only inside the `fpl_snapshot` summary, never as raw JSON;
  - the guard blocks account endpoints in any argument;
  - the sandbox has no network;
  - `submit_recommendation` recomputes and validates everything.

  The eval's two injection cases (`h2526-gw20-injection`, `l6-d-injection`) passed with no classifier.
- A classifier is a probabilistic second opinion. It would need a new secret and a new third-party data flow (none of the classifier providers uses the Anthropic key). Called from codemode, its spend would also be invisible to the budget (§2).
- For triage, FPL already publishes structured availability: `status` (a/d/i/s/u/n) and `chance_of_playing_next_round`/`this_round` on every element.

**Recommendation: don't adopt.** If injection screening is ever wanted:
1. First, deterministic hygiene in `fpl_snapshot`: length-cap news strings, strip control characters and URLs, and present news as quoted data.
2. Only then a classifier, called from `gaffer-data` with `ctx.modelRegistry.classify()` (never codemode). Its usage would be written to a `gaffer.*` entry that `sessionCost()` sums.
3. Prefer Haiku 5.5 on the existing key over adding a TypeSafe, OpenAI or Cloudflare key.

Why Gaffer can't do without it: it can.

## 6. MCP: revisiting ADR 0002

ADR 0002 rejected MCP for three reasons: context cost, an extra process, and read-only risk. Its context also cited "Pi's author deliberately leaves out MCP". That premise is now **stale**. MCP is built in since 0.99.0 (2026-09-29), and Earendil's "You said no MCP" (2026-09-29) explains the change: better composition through codemode, and deferred and codemode-only exposure. Re-checking the three reasons on 1.3.0:

| ADR 0002 reason | On Pi 1.3.0 |
|---|---|
| Context cost | Mitigated only through `codemode` or `deferred` exposure, which needs `codemode` or `tool_search` (§3–4: rejected). `direct` exposure declares every tool up front. Even unreachable servers add an `mcp_servers` prompt section (S3 row 2). |
| Extra process | Unchanged for stdio servers: a child process in the harness, **inheriting the whole environment including the key** (`packages/mcp/src/transports/stdio.ts:94`; Pi never sets `inheritEnv: false`, `src/extensions/mcp/runtime.ts:111-121`). HTTP servers swap the process for a third-party network service. |
| Read-only rule | Unchanged. The guard sees a call's arguments, not what the server does with them. |

**FPL MCP servers today** (live 2026-10-17: GitHub search API "fpl mcp" → 51 repositories, "fantasy premier league mcp" → 24; PyPI; npm; the official registry `registry.modelcontextprotocol.io`):

| Server | Lang | Last push | ★ | Licence | Package | Login / risk | Tools |
|---|---|---|---|---|---|---|---|
| rishijatia/fantasy-pl-mcp | Python | 2026-08-03 | 80 | MIT | PyPI `fpl-mcp` 0.1.7 (2026-08-03) | FPL credentials for team and league tools (`update_fpl_credentials`, several "requires authentication") | ~20 + resources and prompts |
| dohyung1/x402-fpl-api ("FPL Intelligence") | Python | 2026-03-23 | 11 | MIT | PyPI `fpl-intelligence` 0.22.0 (2026-03-23) | no login; the name refers to x402 pay-per-call (not verified) | 12 |
| lewis-king/fpl-mcp-server | Python | 2026-08-09 | 3 | MIT | – | out-of-band browser login (Playwright); **`make_transfers` (irreversible)** | many |
| dexhamter/fpl-mcp | Python | 2026-08-20 | 3 | MIT | – | Bearer JWT copied from the browser (`FPL_API_TOKEN`) or a cookie | 33 |
| fantasypl/mcp | Go | 2026-10-08 | 0 | MIT | – | none mentioned | 16 (captain_pick, optimal_transfers, …) |
| GilbertKamau/fpl_mcp | Python | 2026-10-12 | 0 | MIT | npm `fpl-mcp-server` 0.2.0; registry 0.2.1 | public endpoints only; needs Postgres + a LightGBM model | ~10 |
| sbanthia92/fpl-context-mcp | – | 2026-10-08 | 0 | MIT | registry 0.8.0 | stats over SQL + BBC/Guardian news search | – |
| com.fplcat/fpl-cat, com.fplcopilot/fpl-copilot | hosted | 2026-10-08 / 09-30 | – | – | registry only, remote | third-party hosted service, no source | – |

All of these are young, single-author projects with few stars. None is from the Premier League. The best-known ones need an FPL login, or can change the team. None replaces what `fpl_snapshot` does:
- cache-busting the stale per-user endpoints;
- deriving free transfers and selling prices with `gaffer_lib`;
- TypeBox and invariant validation;
- immutable snapshots;
- the odds source.

**ADR 0002 stands.** Amend its context: MCP is now built in and locked off (§7).

## 7. Locking down MCP and the other built-ins (S3)

### 7.1 The built-ins and their switches

The CLI loads four built-in extensions (`src/extensions/index.ts:7-14`):
- `llama.cpp` registers a provider and `/llama`;
- `codemode` and `tool-search` register inactive tools;
- `mcp` registers `/mcp`, connects servers, and adds the `mcp_servers` prompt section.

They are added **only by the CLI's `main.ts`**: `const extensionFactories = [...builtInExtensions, …]` (`src/main.ts:578`). SDK hosts get them only if they pass the factories themselves (`createMcpExtension()`, `createCodemodeExtension()`, `createToolSearchExtension()`; `src/index.ts:410-414`).

| Switch | Effect | Can it be overridden? |
|---|---|---|
| `--no-mcp` | Adds `mcp` to `disabledBuiltinExtensions`, applied after all merging (`src/main.ts:788`, `src/core/resource-loader.ts:578-583`) | **No**: wins over project `+builtin:mcp` and `-e builtin:mcp` (S3 rows 13, 14). Doesn't touch llama.cpp. |
| `extensions: ["-builtin:<name>"]` in user settings (`pi config` Built-in section) | Disables any of the four (`src/core/package-manager.ts:976-991`) | Yes, by a **trusted project's** `.pi/settings.json` `+builtin:<name>` (S3 row 9) |
| `--no-extensions` | Disables discovery and **all** built-ins; explicit `-e` still loads | Also drops the installed `pi-gaffer` package's extensions (S3 row 16); needs `-e /opt/pi-gaffer` (row 17) |
| `--tools <allowlist>` | `codemode`/`tool_search` are not registered unless listed. MCP tools stay registered but can't be declared without `tool_search` (`src/core/agent-session.ts:1542-1557`) | Doesn't stop MCP servers spawning (rows 2–5) |
| `noExtensions: true` (SDK `DefaultResourceLoader`) | Irrelevant to built-ins in SDK hosts (they never get them) | – |

### 7.2 The 1.0.4 `--tools` change is a regression for Gaffer

Since 1.0.4, "`--tools` keeps MCP tools unless an entry starts with `mcp__`" (CHANGELOG 1.0.4; `src/core/agent-session.ts:503-507`). S3 ran the CLI with a user `mcp.json`, a project `.pi/mcp.json`, a parent `.pi/mcp.json` and an extension-registered server, under Gaffer's exact allowlist (row 2). It found:
- **Every user-level and extension-registered server was spawned**, with `ANTHROPIC_API_KEY` in its environment.
- No MCP, codemode or `tool_search` tool was offered, and every scripted call failed with "Tool … not found".
- The `mcp_servers` system-prompt section was injected, telling the model about servers it cannot reach.
- `/mcp` and `/llama` were registered, and so was the llama.cpp provider.

An `mcp__none` allowlist entry (row 4) or `--exclude-tools 'mcp__*'` (row 5) changes only tool registration; the servers still spawn. At 0.87.1 none of this existed, so **the current launch line becomes unsafe the moment Gaffer moves to 1.x** without the lock.

### 7.3 Other paths checked

- **Project and parent `mcp.json`.** Only `<cwd>/.pi/mcp.json` is read, and only for trusted projects (`src/extensions/mcp/config.ts:145-156`). The parent server never spawned. The harness cwd `/work` is empty and root-owned.
- **`pi.registerMcpServer()`.** Any loaded extension can call it, so a third-party package could (S3 `ext`). With `--no-mcp`, `-builtin:mcp` or `--no-extensions` the registration produces only an extension error and nothing spawns. Gaffer installs only its own package.
- **`/mcp` in the TUI.** The manager can sign in, reconnect, enable or disable servers and change exposure (it writes `mcp.json`), but it cannot add one (`src/extensions/mcp/index.ts:277,1260-1340`).
- **`/login` → Radius.** After a Radius sign-in, `/login` **offers to add the Radius MCP server to the global `mcp.json`** (`src/modes/interactive/interactive-mode.ts:6392-6432`). That is a TUI path to a new server. It is harmless only because `--no-mcp` ignores `mcp.json`.
- **`pi mcp add` and `pi config`.** These are CLI subcommands (`src/extensions/mcp/cli.ts`, `src/package-manager-cli.ts`). Gaffer has no user shell (`user_bash` blocked), and the TUI has no `/config` (`src/core/slash-commands.ts:20-43`).
- **MCP OAuth.** It opens a browser with `openBrowser()` and a loopback callback server in the harness (`src/extensions/mcp/index.ts:302`, `oauth.ts`). It is gone with `--no-mcp`.
- **Can sandbox code write MCP config?** No.
  - The global file is `$PI_CODING_AGENT_DIR/mcp.json` = `/opt/pi-agent/mcp.json`, in the harness image. It is owned by the `gaffer` user, so the Pi process *can* write it (as `/login` does).
  - The project file would be `/work/.pi/mcp.json` in the harness, which is root-owned.
  - The sandbox shares only the `data` volume (read-only in the sandbox), and its `/work` is its own tmpfs (`deploy/compose/docker-compose.yml`). Gaffer's `write`/`edit` go to the sandbox, codemode's included (S4).
- **llama.cpp.** It is inert without `LLAMA_BASE_URL` or a stored credential, and model discovery needs network (blocked by `PI_OFFLINE=1`; `src/extensions/llama/provider.ts:31-37, 255`). But `/llama` and `/login llama.cpp` let a TUI user point the harness at any URL, so it should be unloaded too.

### 7.4 Recommended lock (S3 row 15)

1. **`harness/gaffer-pi`**: `--no-mcp` added:
   `pi --session-dir /sessions --no-context-files --no-mcp --continue --tui-mode fullscreen --tools read,write,edit,bash,fpl_snapshot,submit_recommendation,set_preferences`.
   Do the same in `deploy/compose/tests/{injection,real-run}.sh`.
   Why Gaffer can't do without it: it is the only switch a project setting or `-e` cannot undo, and without it any `mcp.json` runs code next to the key.
2. **`harness/Dockerfile`**: after `pi install /opt/pi-gaffer`, write `"extensions": ["-builtin:mcp", "-builtin:codemode", "-builtin:tool-search", "-builtin:llama.cpp"]` into `/opt/pi-agent/settings.json` (alongside `theme`). `pi install` keeps the key (S3 row 15 wrote the settings first).
   Why Gaffer can't do without it: it is the only way to unload `llama.cpp`, `/llama`, codemode and `tool_search` without giving up `pi install`.
3. **Keep** the `--tools` allowlist and gaffer-core's `setActiveTools()`. In S3 row 1 (no allowlist), the MCP extension re-activated codemode after gaffer-core's `setActiveTools()`, so the allowlist is the line that matters.
4. **SDK hosts** (`test/harness.ts`, `evals/runner/run.ts`): no change needed (S3 S1, S2). Add an assertion that `getAllTools()` contains no `codemode`, `tool_search` or `mcp__*` tool, to catch a future Pi that adds built-ins to the SDK.
5. **Tests.** A container test that drops a marker-writing stdio server into `/opt/pi-agent/mcp.json`, starts `gaffer-pi` headless, and asserts no marker appears and no `/mcp` or `/llama` command exists.

## Contradictions with the brief or Gaffer docs

- **No `codemode.mode: off`.** The setting accepts only `on` and `only` (`src/core/settings-schema.ts:148-150`).
- **Model calls per run.** The 2026-10-16 eval has a median of **6** model calls (4–7), not 4–5. Cost ($0.066) and p50 (75 s) match.
- **ADR 0002 and research 01 §9** say Pi leaves out MCP. That has been untrue since 0.99.0 (2026-09-29).
- **`--tools` is not "MCP off" on 1.x.** It is MCP *undeclared*, with servers still running (§7.2).
- **Prompt-cache price.** Gaffer's `harness/models.json` prices `claude-sonnet-5-5` `cacheRead` at $0.2/MTok; the 1.3.0 catalogue says $0.1. Out of scope here; flagged for the cost note.
- **Earendil's trust model.** Its post treats the harness side as the more trusted environment, which is the side where codemode runs. Gaffer's ADR 0001 puts all generated code on the untrusted side.

## Sources

- Pi monorepo at **v1.3.0** (`71023aec`, 2026-10-15):
  - `packages/codemode/{README.md,CHANGELOG.md,src/runtime/{host,vm,worker}.ts}`
  - `packages/mcp/{README.md,CHANGELOG.md,src/transports/stdio.ts}`
  - `packages/coding-agent/src/extensions/{index.ts,codemode/{index,tool,execute}.ts,mcp/{index,config,runtime,cli}.ts,tool-search/{index,tool}.ts,llama/{index,provider}.ts}`
  - `packages/coding-agent/src/core/{agent-session,nested-tool-calls,mcp-servers,resource-loader,package-manager,project-trust,trust-manager,settings-schema,settings-defaults,model-registry,slash-commands,sdk}.ts`
  - `packages/coding-agent/src/{main.ts,cli/args.ts,modes/interactive/interactive-mode.ts}`
  - `packages/agent/src/agent-loop.ts`
  - `packages/coding-agent/docs/{codemode,mcp,cli,settings,security,containerization,extensions,models,llama-cpp,packages}.md`
  - `packages/coding-agent/CHANGELOG.md` (0.99.0–1.3.0, 2026-09-29 to 2026-10-15)
- `@earendil-works/pi-ai@1.3.0` catalogue, `dist/providers/data/*.json` (installed 2026-10-17).
- Earendil Engineering, "You said no MCP", https://earendil.com/posts/you-said-no-mcp/ (2026-09-29; read via WebFetch 2026-10-17).
- Anthropic, "Code execution with MCP", https://www.anthropic.com/engineering/code-execution-with-mcp (2025-11-04).
- Anthropic, "Introducing advanced tool use", https://www.anthropic.com/engineering/advanced-tool-use (2025-11-24).
- GitHub search API `search/repositories?q=fpl+mcp` and `fantasy+premier+league+mcp`, plus repository READMEs and metadata (2026-10-17).
- PyPI JSON API (`fpl-mcp`, `fpl-intelligence`); npm registry (`fpl-mcp-server`); `registry.modelcontextprotocol.io/v0/servers?search=fpl` (2026-10-17).
- Gaffer: `evals/results/2026-10-16-anthropic_claude-sonnet-5-5.jsonl` (2026-10-16); `harness/{Dockerfile,gaffer-pi,entrypoint.sh,models.json}`; `deploy/compose/docker-compose.yml`; `packages/pi-gaffer/{src/guard.ts,src/budget.ts,src/usage.ts,extensions/*}`; `docs/decisions/0001,0002`; `docs/REQUIREMENTS.md` (undated, read 2026-10-17).
- Spikes S3 and S4 (run 2026-10-17, Pi 1.3.0, faux model).

## Unconfirmed

- **Classifier latency.** No paid calls were allowed. Only the docs' remark about Decisions API gateway timeouts on very large inputs was found.
- **Token counts.** They are estimates from characters (÷3.5 and ÷4) of the JSON declarations and system prompt. The Anthropic API's own rendering and counting of tool definitions was not measured.
- **A nested `submit_recommendation` not ending the run.** Read from `agent-loop.ts` and `execute.ts`, not run. How the TUI renders a nested submission was not checked either.
- **TUI mode.** S3 ran print mode (`-p`) and SDK hosts. `--no-mcp` and the settings lock go through the same resource-loader path in every mode (`main.ts:788`), but the fullscreen TUI under ttyd was not started. The trust prompt for a project `.pi/mcp.json` in the TUI was not seen.
- **QuickJS/wasm escape history.** Not researched. The threat-model verdict does not depend on it.
- **x402 payment model** of `dohyung1/x402-fpl-api`, and tool counts for some servers. From READMEs only; their code was not run.
- **The Earendil post.** Summarised via WebFetch, which may lose nuance.
- **Fetched READMEs.** No content in them addressed this researcher or gave instructions.
