# Architecture Decision Records

| ADR | Title | Status |
|---|---|---|
| [0001](0001-sandbox.md) | Sandbox: separate no-network container reached through a small exec service | Accepted |
| [0002](0002-data-access.md) | FPL data access: our own Pi tool in the harness, not MCP or a third-party library | Accepted (context amended by 0012) |
| [0003](0003-analytics-split.md) | Analytics split: tested Python library + skills + free-form sandbox code | Accepted |
| [0004](0004-session-storage.md) | Session and recommendation storage: Pi's JSONL session files are the system of record | Accepted |
| [0005](0005-web-tui.md) | Web TUI: ttyd→tmux→Pi for MVP; RPC bridge for multi-user | Superseded in part by 0013, 0014 |
| [0006](0006-deployment.md) | Deployment topology: Compose, mapped 1:1 to ECS Fargate | Accepted |
| [0007](0007-no-subagents.md) | Single agent, no orchestrator/worker split | Accepted (reaffirmed 2026-10-17) |
| [0008](0008-model-and-budget.md) | Default model, provider swap and hard budget caps | Accepted (amended by 0010) |
| [0009](0009-pi-version-policy.md) | Pi version: move to 1.3.0 in Phase 1.1, then one minor at a time, landed after a deadline | Accepted |
| [0010](0010-context-as-section-patches.md) | Per-prompt FPL context as mid-conversation system messages; prices from the live price list | Accepted |
| [0011](0011-durable-deferred.md) | Pi Durable: stay on pi-coding-agent, build two seams, revisit on stated triggers | Accepted |
| [0012](0012-builtins-locked-off.md) | Codemode, MCP, tool search and llama.cpp: off, locked by flag and setting | Accepted |
| [0013](0013-gaffer-terminal.md) | Gaffer Terminal: Gaffer's identity and command surface on the Pi TUI | Accepted |
| [0014](0014-gaffer-app.md) | Gaffer App: a local web app over `pi --mode rpc`, sharing one session store with the terminal | Accepted |

Format: context, options considered, decision, consequences. Evidence links point to `docs/research/` and `spikes/`.

## Spikes

| Spike | Question | Result | Used by |
|---|---|---|---|
| [S1](../../spikes/s1-extension-hooks/README.md) (2026-09-27) | Can Pi 0.87.1 be turned into a domain agent purely through an extension, using custom tools, tool removal, prompt replacement that keeps skills, tool-call blocking, `bash` in a separate no-network container, a terminating structured answer, and custom session entries? | **Yes, 8/8 checks pass.** Gotchas: SDK hosts must call `bindExtensions()`, and a full `systemPrompt` replacement drops skills, so `customPrompt` + sections must be used instead | ADR 0001, 0003, 0004; ARCHITECTURE §1 |
| [S2](../../spikes/s2-pi-1x-upgrade/README.md) (2026-10-17) | Does Gaffer run unchanged on Pi 1.3.0, and if not, what is the minimal change? | **Almost unchanged:** one test hard-coded the version; 237/237 tests, S1 8/8, faux eval 30/30 with identical points and latency. The real changes are configuration (`models.json` replaces the catalogue entry; built-ins load in the TUI; transitive deps unpinned) | ADR 0009, MIGRATION-PI-1X |
| [S3](../../spikes/s3-mcp-lockdown/README.md) (2026-10-17) | Can MCP, codemode, tool search and llama.cpp be kept off whatever `mcp.json` files exist? | **Yes, with `--no-mcp` + `-builtin:` settings + `--tools`.** Gaffer's current launch line alone spawns every configured MCP server, with the API key in its environment | ADR 0012 |
| [S4](../../spikes/s4-codemode-guards/README.md) (2026-10-17) | Do codemode's nested tool calls pass Gaffer's guards, events and budget? | **Guard and events yes; budget no** (`models.*` spend lands on the tool result); a nested `submit_recommendation` would not end the run. Codemode adds ~600 tokens per request | ADR 0012 |
| [S5](../../spikes/s5-tui-branding/README.md) (2026-10-17) | Can an extension brand the TUI and leave only Gaffer's commands, without patching Pi? | **Yes.** Header, footer strip and title by supported APIs; commands hidden by a supported autocomplete provider and refused through an undocumented editor seam (regression test) | ADR 0013 |
| [S6](../../spikes/s6-prompt-cache/README.md) (2026-10-17) | Does rewriting `fpl_context` on every prompt defeat caching; do mid-conversation system messages fix it? | **Yes and yes:** follow-ups re-write the whole prefix; `supportsMidConvoSystemMessages` cuts follow-up cost 75% on 0.87.1 and 1.3.0. Real model, $0.1637 | ADR 0010 |
| [S7](../../spikes/s7-rpc-events/README.md) (2026-10-17) | Is `pi --mode rpc` enough to render the Gaffer App without scraping text? | **Yes.** Everything arrives as structured events and tool `details`; `export_html` and `switch_session` reach arbitrary paths, so the bridge allowlists commands | ADR 0014 |
| [S8](../../spikes/s8-durable-gaffer/README.md) (2026-10-17) | How much code does a Gaffer-shaped run need on pi-durable, and does it survive a crash? | **68 lines for the core; resume works;** `watch()` is single-process and two owners double-run work; skills, templates, packages, TUI and RPC are missing | ADR 0011 |
| [S9](../../spikes/s9-web-terminal/README.md) (2026-10-17) | Does Pi 1.3 fullscreen work through ttyd + tmux, and is a node-pty server worth it? | **Works; copy is silently broken** (OSC 52) and is fixed in ~10 lines; keep ttyd | ADR 0013 |
