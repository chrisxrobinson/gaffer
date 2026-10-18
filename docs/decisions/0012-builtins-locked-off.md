# ADR 0012 — Codemode, MCP, tool search and llama.cpp: off, locked by flag and setting

**Status:** Accepted · **Date:** 2026-10-17 · **Amends:** [ADR 0002](0002-data-access.md) (context) · **Evidence:** [research 09](../research/09-codemode-and-mcp.md), [spike S3](../../spikes/s3-mcp-lockdown/README.md), [spike S4](../../spikes/s4-codemode-guards/README.md) · **Requirements:** NFR-SEC-01, -02, -08

## Context
Pi 0.99.0 added four **built-in extensions** that load in the CLI by default: MCP (servers from `mcp.json` or `pi.registerMcpServer()`, plus `/mcp`), codemode (a `codemode` tool that runs model-written JavaScript in a QuickJS-in-wasm worker thread of the Pi process), tool search (`tool_search`, which declares deferred tools), and a llama.cpp provider (plus `/llama`). Gaffer's 0.87.1 pin had none of them. The brief requires every new built-in to be off unless an ADR turns it on, and the security posture to stay the same or get stronger.

Research 09 and its spikes found:
- **Gaffer's current launch line is not enough on 1.x** (S3 row 2). With `--tools read,write,edit,bash,fpl_snapshot,submit_recommendation,set_preferences`, the model is offered none of the new tools, but **every MCP server named in the agent's `mcp.json`, or registered by an extension, is still spawned in the harness container, with the whole environment including `ANTHROPIC_API_KEY`** (`packages/mcp/src/transports/stdio.ts:94 @v1.3.0` spreads `process.env`; Pi never sets `inheritEnv: false`). An `mcp_servers` section is added to the system prompt, and `/mcp`, `/llama` and the llama.cpp provider are registered. Since 1.0.4, `--tools` keeps MCP tools unless an entry starts with `mcp__`; `--exclude-tools 'mcp__*'` filters tools but still spawns servers.
- Gaffer's image has no `mcp.json` today, so nothing spawns. But `/login` → Radius offers to write a Radius MCP server into the global `mcp.json` (`interactive-mode.ts:6392-6432`), and any future config slip would put third-party code next to the key.
- **`--no-mcp` can't be overridden**: it wins over a trusted project's `+builtin:mcp` and over `-e builtin:mcp` (S3 rows 6, 7, 13, 14; `main.ts:788`). It doesn't unload the other three.
- **`-builtin:<name>` in the agent `settings.json` unloads all four** (S3 row 8), and `pi install` keeps the key. A trusted project's `.pi/settings.json` can re-enable MCP with `+builtin:mcp` (row 9); Gaffer's cwd is an empty root-owned `/work`, but `--no-mcp` closes that path anyway.
- `--no-extensions` also unloads Gaffer's own installed package (row 16), so it is not usable as the lock.
- **SDK hosts load no built-ins** (`test/harness.ts`, `evals/runner/run.ts`), so tests and evals already run the locked configuration; the CLI must match them.
- **Codemode's nested calls do pass Gaffer's `tool_call` guard** (with `parentToolCallId`) and Gaffer's sandbox overrides (S4). But codemode runs generated code **in the harness**, next to the key and with network access: its JavaScript can't reach `process`, `fetch` or the filesystem, but `models.classify()` and `models.generateImages()` give it an outbound channel to other providers with the session's credentials. Its classifier spend lands on the tool result, which `gaffer-budget` doesn't count, and a `submit_recommendation` called from a script would not end the run. Active codemode adds about 600–670 prompt tokens per request, to save at most one or two of a median six model calls that a deterministic chain in Gaffer's own code could save without it.
- **Classifiers** (Jev, GPT-6 Luna, Cloudflare Clef, llama.cpp) cost little but none runs on Gaffer's Anthropic key, so each adds a provider, a secret and a data flow. The eval suite's injection cases pass with no classifier, and FPL's `status` and `chance_of_playing_*` fields already triage availability.
- **No FPL MCP server is worth using** (51 repositories surveyed on 2026-10-17; the best-known needs an FPL login, others can make transfers). ADR 0002's reasons stand: context cost, an extra process, and the read-only rule.

## Options considered
1. **Rely on `--tools`.** Keeps tools away from the model, but not MCP servers away from the key (S3 row 2). Rejected.
2. **`--no-extensions` plus `-e /opt/pi-gaffer`.** Works (row 17), but turns off every discovered extension, changes how Gaffer's package loads, and needs every launch line to know the package path. Rejected in favour of option 3.
3. **`--no-mcp` on every CLI launch, `-builtin:` entries for all four in the agent settings, and the existing `--tools` allowlist and `setActiveTools`.** **Chosen** (S3 row 15).
4. **Turn codemode on (`on` or `only`) for tool chaining.** Rejected for the reasons above; `only` would also hide `submit_recommendation`'s strict schema behind a JavaScript string and break its `terminate`.

## Decision
- **All four built-ins are off.** Nothing in Gaffer turns one on without a new ADR.
- **The lock has three layers**, all shipped in the same change as the Pi 1.x upgrade (ADR 0009, roadmap M1.1-1):
  1. `harness/gaffer-pi` and every other CLI launch (`deploy/compose/tests/{injection,real-run}.sh`) pass **`--no-mcp`**. Why Gaffer can't do without it: it is the only switch that nothing (project settings, `-e`, `/login`) can override.
  2. `harness/Dockerfile` writes **`"extensions": ["-builtin:mcp", "-builtin:codemode", "-builtin:tool-search", "-builtin:llama.cpp"]`** into `/opt/pi-agent/settings.json` after `pi install`. Why: it is the only way to unload codemode, tool search, llama.cpp and their commands while keeping `pi install`.
  3. The **`--tools` allowlist and `setActiveTools`** stay. Why: in S3 row 1 the MCP extension re-activated codemode after `setActiveTools`; the allowlist is what held.
- **Tests** (NFR-SEC-08): an SDK assertion that no `codemode`, `tool_search` or `mcp__*` tool is registered; a container test that puts a marker-writing server in the agent's `mcp.json` and in `/work/.pi/mcp.json` and checks it never starts and no `mcp_servers` section is sent.
- **Classifiers: no.** If prompt-injection screening is ever wanted, the first step is deterministic news hygiene in `fpl_snapshot`; a model screen would come next, from `gaffer-data` via `ctx.modelRegistry.classify()` on Gaffer's own key (Haiku 5.5), with its cost counted (NFR-COST-05).
- **ADR 0002 stands.** Its context gains one line: since 0.99.0 MCP is built into Pi, and Gaffer locks it off.

## Consequences
- The security posture is restored to 0.87.1's and made explicit: no third-party process and no generated code run in the harness, and the key stays reachable only by Pi and Gaffer's own extensions.
- The shipped CLI matches what tests and evals already exercise (SDK hosts with no built-ins).
- `/mcp`, `/llama` and the llama.cpp provider disappear from the TUI, which also serves ADR 0013's command surface.
- Pi upgrades must re-check the lock: a new built-in extension would load by default. ADR 0009's changelog review lists built-in extensions first, and the NFR-SEC-08 test fails on any tool or server that isn't Gaffer's.
- **For the theory:** Pi's own direction (built-in MCP, codemode on the "more trusted" harness side) runs against Gaffer's managed-agents split (ADR 0001). Pi still lets a package switch all of it off with supported flags and settings, so Gaffer stays a Pi package. The cost is that "minimal" Pi is now something Gaffer has to configure rather than get by default.
