# Spike S1 — Can a Pi extension turn Pi into a domain agent without touching core?

**Date:** 2026-09-27 · **Pi:** `@earendil-works/pi-coding-agent@0.87.1` (npm, modified 2026-09-22) · **Result: YES (all 8 checks pass)**

Run: `docker run -d --rm --name gaffer-spike-sandbox --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --memory 512m --pids-limit 128 python:3.12-slim sleep 600 && npm i && node run-spike.ts`

Uses Pi's own `fauxProvider` (from `@earendil-works/pi-ai`, `dist/providers/faux.d.ts`) to script model turns, so no API key or tokens are needed.

| # | Assumption | Mechanism | Observed |
|---|---|---|---|
| 1 | Extension can add domain tools | `pi.registerTool(defineTool({...}))` | `fpl_fetch` executed → ok |
| 2 | Built-in coding tools can be removed | `pi.setActiveTools([...])` in `session_start` | Active = `bash, read, fpl_fetch, submit_recommendation`; model's `edit` call → "Tool edit not found" |
| 3 | Whole system prompt can be replaced | `before_agent_start` → `{ systemPrompt }` | Model received `"You are Gaffer, an FPL advisor."` as system message. Note `session.systemPrompt` still reports the structured default: Pi records sections separately (documented in extensions page) |
| 4 | Tool calls can be policed | `tool_call` → `{ block: true, reason }` | `fpl_fetch my-team/...` → error result with our reason |
| 5 | `bash` can run in a separate container ("hands" away from "brain") | `createBashToolDefinition(cwd, { operations: { exec } })` re-registered as `bash`, exec = `docker exec` | Output was container hostname + `4` from python in a `--network none --read-only --cap-drop ALL` container |
| 6 | Agent can end on a structured, schema-validated answer without an extra LLM turn | tool result `terminate: true` | 5 model calls consumed, 1 scripted response left unused |
| 8 | Coding persona can be removed **without losing skills**, and per-user context can be injected as a named section | `before_agent_start`: set `event.systemPromptOptions.customPrompt`, `contextFiles = []`, `sections.user_preferences = …` (source: `dist/core/system-prompt.js:74-110`) | Model's system message sections = `preamble` (Gaffer), `skills` (the test `chip-strategy` skill), `cwd`, `user_preferences`. No coding `tools`/`rules`/`docs` sections. By contrast, the full `systemPrompt` replacement (check 3, `SPIKE_FULL_REPLACE=1`) sends only the Gaffer text and **drops the skills list** |
| 7 | Durable non-context data can go into the session log | `pi.appendEntry("gaffer.recommendation", data)` | `custom` entry with `customType: gaffer.recommendation` in session JSONL |

**Gotcha found:** when embedding via the SDK, `session_start` only fires after `await session.bindExtensions(...)` (see `dist/core/agent-session.js` / `agent-session-runtime.js`). CLI/RPC modes do this themselves. Without it, `setActiveTools` in `session_start` silently doesn't run and the coding tools stay active. Gaffer should also pass `--tools`/`tools:` as a belt-and-braces allowlist (`dist/cli/args.js`: `--tools`, `--no-builtin-tools`).

**Also observed:** each assistant `message` entry in the session JSONL carries `usage` (input/output/cacheRead/cacheWrite/totalTokens and a `cost` breakdown). The faux provider reports cost 0, so cost calculation with a real provider is still unverified here (see R1 note).

**Design consequence:** Gaffer uses `customPrompt` + named `sections`, not a full `systemPrompt` replacement. Tool descriptions still reach the model through the tool schemas.
