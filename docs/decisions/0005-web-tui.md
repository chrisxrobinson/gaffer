# ADR 0005 — Web TUI: ttyd→tmux→Pi for MVP; RPC bridge for multi-user

**Status:** Accepted · **Date:** 2026-09-27

## Context
The brief asks for a browser UI that "looks and behaves like the Pi CLI". Pi offers an interactive TUI, print and JSON modes, a JSONL **RPC** mode over stdio (with an exported `RpcClient`), and an in-process SDK. Pi's `pi-web-ui` package is a chat UI that runs the agent in the browser. It is no longer in the monorepo (last release 0.75.3, 2026-05). The newer `pi-server`/`pi-client` packages are experimental and have no auth. Over RPC, custom TUI components are not forwarded; only dialogs and notifications are ([research 05](../research/05-web-tui.md), [research 01 §7–8](../research/01-pi-internals.md)).

## Options considered
| | A. xterm.js ↔ ttyd ↔ PTY running the real Pi TUI | B. Web frontend over `pi --mode rpc` | C. `pi-server` / `pi-web-ui` |
|---|---|---|---|
| Looks like the CLI | Exactly, because it *is* the CLI (theme, widgets, slash commands) | It has to be re-created in HTML | Chat UI, not CLI-like |
| Effort | Configuration only | A bridge service plus a frontend (roughly 1.5–3k LOC) | Unknown or experimental |
| Security | A PTY into the harness container. Pi's `!cmd` and RPC's `bash` are shell paths that must be closed | The bridge allowlists RPC commands, so there is no shell path | No auth |
| Multi-user | One process per connection (ttyd spawns per WS). Auth is basic or header-based | Clean: one RPC process per user session behind real auth | — |
| Streaming | Native terminal rendering | `message_update` deltas and `tool_execution_*` events | — |
| Reconnect | `tmux new -A -s gaffer` re-attaches to a live TUI | `get_state`/`get_messages` plus respawn with `--session-id` | — |
| Structured output | Rendered as TUI tables by `renderResult`; `/export` writes JSON | Real HTML tables and CSV/JSON download | — |
| Mobile | Poor | Good | — |

## Decision
- **MVP (single user, local): Option A.**
  - Inside the `gaffer` container: `ttyd -i 127.0.0.1 -W -m 1 -t titleFixed=Gaffer tmux new -A -s gaffer pi …`. The port is published on `127.0.0.1` only.
  - The Gaffer extension's `user_bash` handler blocks every `!` and `!!` user shell command.
  - Pi starts with `--tools read,write,edit,bash,fpl_snapshot,submit_recommendation,set_preferences`, and all four built-ins are routed to the sandbox ([ADR 0001](0001-sandbox.md)).
  - tmux is only there so a run survives a browser disconnect. Its escape routes to a shell are removed with a config that sets `set -g prefix None` and `unbind-key -a`, plus `set -g status off`. Even if a shell were reached, the harness container holds only the LLM key and the data volume. Because the port is localhost-only and single-user, the residual risk is accepted.
  - xterm.js 6.0 has no stable Kitty keyboard protocol, so ttyd gets a keymap for Shift+Enter.
- **Cloud single-user (phase 2):** the same, behind ALB OIDC auth (Cognito or another IdP). ttyd uses `-H X-Amzn-Oidc-Identity` as its auth-proxy header, and the ALB idle timeout is set to 3600 s.
- **Multi-user (phase 3): Option B.**
  - A `gaffer-web` bridge authenticates users and spawns one `pi --mode rpc --session-dir /sessions/<tenant>` per session, each with its own sandbox.
  - It **allowlists** RPC commands: `prompt`, `steer`, `abort`, `get_state`, `get_messages`, `get_session_stats` and `new_session`. It rejects `bash`, arbitrary `switch_session` paths and `export_html` paths.
  - The frontend is terminal-styled HTML (monospace, Pi theme colours) with real tables for the recommendation JSON.
- **Seam built now:** every Gaffer tool returns structured `details` alongside its text. So the RPC frontend can render recommendations from `tool_execution_end` events without scraping ANSI.

## Consequences
- The MVP needs no web code. The multi-user phase needs a small new service (the bridge), and it is justified by auth and tenancy only.
- ttyd 1.7.7 dates from 2024-03 and is stable but not active. Its successor would be node-pty plus `@xterm/addon-attach`, served by the same bridge in phase 3.
