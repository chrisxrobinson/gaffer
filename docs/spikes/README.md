# Design spikes

Each spike answered one question before a decision was taken. These pages are their findings, the evidence the ADRs cite; the table in [decisions/README.md](../decisions/README.md) gives each question and its answer in one line.

The spikes' code, scripts and raw output (captures, screenshots, result files) were build artefacts and are not in the repo, so a page's "Run" section describes how the spike was run at the time; it can't be rerun from here. Two spikes live on as tests: S1's checks are `packages/pi-gaffer/test/s1.test.ts`, and S5's command check is `deploy/compose/tests/commands.mjs`.

| Spike | Date | Question |
|---|---|---|
| [S1](s1-extension-hooks.md) | 2026-09-27 | Pi 0.87.1 as a domain agent through an extension alone |
| [S2](s2-pi-1x-upgrade.md) | 2026-10-17 | Gaffer on Pi 1.3.0 |
| [S3](s3-mcp-lockdown.md) | 2026-10-17 | MCP, codemode, tool search and llama.cpp kept off |
| [S4](s4-codemode-guards.md) | 2026-10-17 | Codemode's nested tool calls against Gaffer's guards and budget |
| [S5](s5-tui-branding.md) | 2026-10-17 | Branding the TUI and leaving only Gaffer's commands |
| [S6](s6-prompt-cache.md) | 2026-10-17 | Rewriting `fpl_context` against prompt caching |
| [S7](s7-rpc-events.md) | 2026-10-17 | `pi --mode rpc` as the Gaffer App's source |
| [S8](s8-durable-gaffer.md) | 2026-10-17 | A Gaffer-shaped run on pi-durable |
| [S9](s9-web-terminal.md) | 2026-10-17 | Pi 1.3 fullscreen through ttyd and tmux |
| [S10](s10-real-model-1x.md) | 2026-10-18 | M1.1-1's configuration with a real model; Haiku 5.5 |
