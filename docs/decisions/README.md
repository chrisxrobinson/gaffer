# Architecture Decision Records

| ADR | Title | Status |
|---|---|---|
| [0001](0001-sandbox.md) | Sandbox: separate no-network container reached through a small exec service | Accepted |
| [0002](0002-data-access.md) | FPL data access: our own Pi tool in the harness, not MCP or a third-party library | Accepted (context amended by 0012) |
| [0003](0003-analytics-split.md) | Analytics split: tested Python library + skills + free-form sandbox code | Accepted |
| [0004](0004-session-storage.md) | Session and recommendation storage: Pi's JSONL session files are the system of record | Accepted (amended by 0018) |
| [0005](0005-web-tui.md) | Web TUI: ttyd→tmux→Pi for MVP; RPC bridge for multi-user | Superseded in part by 0013, 0014, 0016 |
| [0006](0006-deployment.md) | Deployment topology: Compose, mapped 1:1 to ECS Fargate | Superseded in part by 0015–0017, 0020 (AWS kept as the Phase 3 mapping) |
| [0007](0007-no-subagents.md) | Single agent, no orchestrator/worker split | Accepted (reaffirmed 2026-10-17) |
| [0008](0008-model-and-budget.md) | Default model, provider swap and hard budget caps | Accepted (amended by 0010) |
| [0009](0009-pi-version-policy.md) | Pi version: move to 1.3.0 in Phase 1.1, then one minor at a time, landed after a deadline | Accepted |
| [0010](0010-context-as-section-patches.md) | Per-prompt FPL context as mid-conversation system messages; prices from the live price list | Accepted |
| [0011](0011-durable-deferred.md) | Pi Durable: stay on pi-coding-agent, build two seams, revisit on stated triggers | Accepted |
| [0012](0012-builtins-locked-off.md) | Codemode, MCP, tool search and llama.cpp: off, locked by flag and setting | Accepted |
| [0013](0013-gaffer-terminal.md) | Gaffer Terminal: Gaffer's identity and command surface on the Pi TUI | Accepted (egress line implemented by 0017) |
| [0014](0014-gaffer-app.md) | Gaffer App: a local web app over `pi --mode rpc`, sharing one session store with the terminal | Accepted |
| [0015](0015-host.md) | Phase 2 host: one Hetzner Cloud server running the same Compose file | Proposed |
| [0016](0016-front-door-identity.md) | Front door and identity: Tailscale Serve on the host, identity checked again in the harness | Proposed |
| [0017](0017-egress-allowlist.md) | Egress allowlist: the harness on internal networks, a Squid proxy as its only exit | Proposed |
| [0018](0018-data-secrets-backups.md) | Data, secrets and backups on the host; moving the live data off the Mac | Proposed |
| [0019](0019-scheduler.md) | Scheduler: host systemd timers calling job scripts kept in the repo | Proposed |
| [0020](0020-build-deploy-observe.md) | Build, deploy, patch and observe: built on the host, rolled back by tag, watched by a dead-man's switch | Proposed |

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
| [S10](../../spikes/s10-real-model-1x/README.md) (2026-10-18) | Does the M1.1-1 configuration (Pi 1.3.0, Pi's catalogue entry for Sonnet 5.5) hold up with a real model; does Haiku 5.5 qualify as the default? | **Yes; no.** Six Sonnet cases: first-attempt valid, points identical to 0.87.1. Haiku 5.5: 30/30 valid at $0.0086, but p50 101 s, 9/30 first-attempt, five cases worse than G0. Real model, $0.79 | ADR 0008, 0009, 0010 |
| [S11](../../spikes/s11-egress-proxy/README.md) (2026-10-23) | Can the harness be limited to the LLM provider, FPL and football-data with containers only, and does Node 24 route `fetch` through a proxy? | **Yes:** internal-only harness + Squid allowlist; everything else (example.com, IP literals, other ports, unlisted hosts) refused, no DNS or route out. Node needs `NODE_USE_ENV_PROXY=1`; the allowlist must name the apex `football-data.co.uk` | ADR 0017 |
| [S12](../../spikes/s12-identity-header/README.md) (2026-10-23) | Behind a door that sets an identity header, what do ttyd `-H` and today's `gaffer-web` do? | ttyd checks only that the header exists (any value passes) but hands the value to its command as `TTYD_USER`; the door replaces client copies; `gaffer-web` refuses non-loopback hosts (421) | ADR 0016 |
| [S13](../../spikes/s13-internal-publish/README.md) (2026-10-23) | Can a container on internal-only networks publish a port? | **No:** so a `door` container publishes the UIs and the harness stays internal-only | ADR 0016, 0017 |
| [S14](../../spikes/s14-restic-backup/README.md) (2026-10-23) | Does restic back up and restore Gaffer's volumes and secrets byte-identical, with nothing readable in the repository? | **Yes:** 207 MiB in, 5.5 MiB stored, identical sha256s; wrong password refused; no plaintext. Docker Desktop needs files staged in a volume | ADR 0018 |
