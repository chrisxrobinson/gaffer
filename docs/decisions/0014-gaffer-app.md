# ADR 0014 — Gaffer App: a local web app over `pi --mode rpc`, sharing one session store with the terminal

**Status:** Accepted · **Date:** 2026-10-18 · **Supersedes:** the Phase 3 part of [ADR 0005](0005-web-tui.md) (RPC bridge) · **Evidence:** [research 11](../research/11-structured-agent-ui.md), [spike S7](../spikes/s7-rpc-events.md), [research 08](../research/08-pi-durable.md) (S8: one owner per store), [docs/ui](../ui/README.md) · **Requirements:** FR-UI-08…13, NFR-SEC-05, -07, NFR-REL-03, NFR-LAT-04, NFR-A11Y-01

## Context
The brief asks for a second UI, the **Gaffer App**: a structured web app laid out like a desktop agent client (sessions on the left; a structured start; a streaming run with collapsible steps; the recommendation drawn from its JSON). It asked four questions: do both UIs share one backend and session store; is the App local and single-user in Phase 1.1 with the auth and tenancy seams named; how does it avoid any shell path into the harness; and what does it need that the agent doesn't emit.

ADR 0005 planned a Phase 3 `gaffer-web` bridge over `pi --mode rpc` and named `pi-server`/`pi-client`/`pi-protocol`, which Pi removed in 1.2.0. Research 11 and spike S7 (Pi 1.3.0, a Gaffer-shaped stub extension, a scripted model) found:
- **RPC already carries everything the App needs as data.** The recommendation arrives whole in `tool_execution_end.result.details.recommendation` and again as the `gaffer.recommendation` entry; the snapshot summary is `fpl_snapshot`'s `details`; validation attempts are `gaffer.validation` entries with structured errors; spend is the `gaffer.budget` entries plus `usage` on every message update; thinking, text and tool calls stream as typed start, delta and end events. Gaffer emits all of it today.
- **The RPC wire is stable:** the same 33 commands at 0.87.1 and 1.3.0, with additive fields only (`disposition`, `structuredContent`, `durationMs`, `agent_settled.aborted`).
- **Extension UI over RPC:** `notify`, `setStatus`, `setTitle` and string widgets are forwarded; component widgets are dropped silently; `custom()` returns `undefined`; `renderResult` is never used. The App must render from data, which is the brief's rule anyway.
- **Reconnect** needs the bridge's help: `get_state`, `get_messages`, `get_entries {since}` and `get_session_stats` return committed state only, nothing returns the in-flight partial message, and there is no list-sessions command.
- **The dangerous commands do what ADR 0005 feared, and more.** RPC `bash` runs a host shell unless a `user_bash` handler claims it (Gaffer's does). `export_html {outputPath}` writes anywhere. `switch_session` loads any JSONL file, whose history then becomes the model's context, and whose header `cwd` becomes the runtime cwd; a non-existent path is created on the next run.
- **A structured start works with no Pi change:** an extension command `/run {json}` can record a `gaffer.run` entry and start the run with `pi.sendUserMessage`.
- **Pi does not lock session files** (`appendFileSync`; `proper-lockfile` guards only settings, auth, trust and MCP OAuth). S8 showed what two owners of one store do: run the same sandbox command twice and fail.
- **The local sandbox is shared.** The Compose `SandboxProvider` uses one long-lived sandbox container for every Pi process, and releasing a session clears `/work` (`packages/pi-gaffer/src/sandbox.ts:17-26`). Two Pi processes running at once would overwrite each other's `/work/plan.json`, or clear it mid-run.
- **Open protocols** (AG-UI 1.0, A2UI v0.9/v1.0 RC, MCP Apps 2026-01-26) are built for agents that generate arbitrary UI. Gaffer's result has a fixed, validated schema; none of them fits better than a small Gaffer protocol, and AG-UI can't reattach to a run in flight.
- **Pi Durable** offers multi-client `watch()` only inside one process (ADR 0011), so it doesn't remove the need for a host and a transport.

## Options considered
| Option | Shared sessions with the terminal | New dependencies | Shell path | Verdict |
|---|---|---|---|---|
| A. SDK in-process host (`createAgentSession` per session inside the bridge) | Yes (same JSONL) | none | none | Every session in one process: a crash or a leak takes them all down; the bridge reimplements what RPC mode already does |
| B. **`pi --mode rpc`, one process per open session, behind a small bridge** | Yes | 2 browser-side files | closed by an allowlist | **Chosen** |
| C. Pi Durable backend (ADR 0011 option b) | No (second store) | durable + chord | n/a | Rejected in ADR 0011 |
| D. AG-UI or A2UI between bridge and page | Yes | 14+ packages | as B | Adds a protocol designed for a different problem |

## Decision
**Topology.** A new process, `gaffer-web`, runs in the **harness container** beside ttyd, using the same image, volumes, secrets and sandbox network. It is plain Node with `node:` built-ins and Pi's exported `RpcClient` (about 300–400 lines). It listens on port 7682, bound like ttyd to the egress-interface IP and published on the host's `127.0.0.1` only. For each session opened for writing it spawns `harness/gaffer-pi --mode rpc --session <path>`, the same launcher, flags and locks as the terminal (`--no-mcp`, the `--tools` allowlist, the settings of ADR 0012 and 0013), so one configuration serves both UIs. A Pi process is stopped when its session has been idle for 15 minutes.

**One store, two locks** (NFR-REL-03), implemented in `gaffer-core` so every Pi process (terminal or App) obeys them:
- **Session lock:** a Pi process takes `<session>.lock` (O_EXCL, holding pid, host and a heartbeat) on `session_start` and releases it on `session_shutdown` or switch. If the lock is held, the process refuses prompts in that session with a notice ("open in the Gaffer App"), and the App renders that session read-only from its JSONL. The terminal's `--continue` picks the newest session it can lock.
- **Run lock (Phase 1.1 only):** one run at a time per harness, taken at the start of a run and released when it settles, because the local sandbox and its `/work` are shared. The Compose provider clears `/work` only while holding it. Per-session sandboxes arrive with `SandboxProvider=ecs` (Phase 2), which removes this lock.

**Browser transport.** Server-sent events for the event stream, each with a sequence id; the bridge buffers the current run's events per session so a reconnect replays from `Last-Event-ID` and then resumes live (FR-UI-03). Commands are `fetch` POSTs carrying a request id, answered once. WebSockets would add a dependency (`ws`) for no gain.

**Command allowlist** (NFR-SEC-05, NFR-SEC-07). The page never sends Pi commands; it calls the bridge's own small API, and the bridge sends Pi only:
- `prompt`, but only a bridge-built `/run {json}` (the structured start) or follow-up text that doesn't start with `/` or `!`, capped at 280 characters
- `steer`, `abort`
- `get_state`, `get_messages`, `get_entries`, `get_session_stats`
- `set_session_name`, length-capped
- `extension_ui_response`, only for request ids that process issued

Never sent: `bash`, `export_html`, `switch_session`, `new_session`, `fork`, `clone`, `compact`, `set_model`, `set_thinking_level`, `get_commands` and everything else. Sessions are addressed by id and resolved to a path on the server, so no client-supplied path reaches Pi. `user_bash` stays blocked as a second line. The App has no terminal of any kind. Requests must carry the App's own `Origin`; the bridge rejects others (DNS rebinding and cross-site requests).

**Frontend.** No build step: Preact 10 and htm 3, vendored as two ES module files, plus the App's own modules and CSS reusing [`docs/ui`](../ui/README.md)'s tokens. Model-written text (rationales, summaries) is rendered as text through Preact, never as HTML. No markdown library and no CSS framework yet. Fonts are self-hosted: the App makes no third-party request (NFR-PRIV-02). A `--replay events.jsonl` dev mode serves a recorded run (S7's log is the first fixture), so UI work needs no model, no sandbox and no spend.

**What Gaffer adds for the App** (no Pi change):
1. `/run {json}` command and a `gaffer.run` entry (action, team, GW, options), so a run's purpose is data, not prompt text. It expands to the same templates the terminal uses (`/gw`, `/whatif`, `/explain`, and a new chip-planner template).
2. Step labels: a static `toolName` → label table in the App, and a `tool_result` handler that tags the golden-path `bash` call's `details` (`{step: "plan", plans, solver, scenarios}`) so the plan step has a summary without parsing stdout.
3. Golden-path progress lines on stdout ("main solve 31 s of 43 s"), which Pi already streams as `tool_execution_update`.
4. Bridge-side read-only calls into Gaffer's `src/` for what the App shows before or outside a run: GW and deadline (the snapshot store), team name check (`FplClient`), preferences, today's spend, the scorecard, and the session list (scanned from `/sessions` headers and `gaffer.team`/`gaffer.run` entries).
5. The two locks above.

**Seams named, not built:** OIDC identity from the proxy header (as ttyd's `-H` in Phase 2) mapped to a tenant; per-tenant session and data paths; per-tenant budgets; per-session sandboxes; Postgres as a query index over the JSONL (ADR 0004).

## Consequences
- A session started in either UI opens in the other (FR-UI-12); only one can write at a time, and the other says so.
- The App reuses Gaffer's extension, prompt, skills, gate and caps exactly as the terminal does; evals cover both because both send the same templates.
- Phase 1.1 runs one recommendation at a time per harness. For a single user this is invisible; the App shows "a run is in progress in the terminal" if not.
- ADR 0005's bridge moves from Phase 3 to Phase 1.1 as a single-user local app; Phase 3 adds auth and tenancy to it rather than building it. Its allowlist gains `get_entries` and `set_session_name`, drops `new_session` (a process per session spawns instead), and constrains `prompt`.
- The harness container runs two processes (ttyd and `gaffer-web`); the entrypoint restarts `gaffer-web` if it exits.
- **For the theory:** the App needed no Pi change and no new runtime. Pi's RPC mode and Gaffer's structured `details` (a Phase 0 seam) carried it. The gaps were around Pi rather than in it: no session lock and a shared local sandbox, both closed inside Gaffer's package.
