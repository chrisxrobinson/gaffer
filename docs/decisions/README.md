# Architecture Decision Records

| ADR | Title | Status |
|---|---|---|
| [0001](0001-sandbox.md) | Sandbox: separate no-network container reached through a small exec service | Accepted |
| [0002](0002-data-access.md) | FPL data access: our own Pi tool in the harness, not MCP or a third-party library | Accepted |
| [0003](0003-analytics-split.md) | Analytics split: tested Python library + skills + free-form sandbox code | Accepted |
| [0004](0004-session-storage.md) | Session and recommendation storage: Pi's JSONL session files are the system of record | Accepted |
| [0005](0005-web-tui.md) | Web TUI: ttyd→tmux→Pi for MVP; RPC bridge for multi-user | Accepted |
| [0006](0006-deployment.md) | Deployment topology: Compose, mapped 1:1 to ECS Fargate | Accepted |
| [0007](0007-no-subagents.md) | Single agent, no orchestrator/worker split | Accepted |
| [0008](0008-model-and-budget.md) | Default model, provider swap and hard budget caps | Accepted |

Format: context, options considered, decision, consequences. Evidence links point to `docs/research/` and `spikes/`.

## Spikes

| Spike | Question | Result | Used by |
|---|---|---|---|
| [S1](../../spikes/s1-extension-hooks/README.md) (2026-09-27) | Can Pi 0.87.1 be turned into a domain agent purely through an extension, using custom tools, tool removal, prompt replacement that keeps skills, tool-call blocking, `bash` in a separate no-network container, a terminating structured answer, and custom session entries? | **Yes, 8/8 checks pass.** Gotchas: SDK hosts must call `bindExtensions()`, and a full `systemPrompt` replacement drops skills, so `customPrompt` + sections must be used instead | ADR 0001, 0003, 0004; ARCHITECTURE §1 |
