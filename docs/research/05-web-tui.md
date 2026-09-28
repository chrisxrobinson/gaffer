# R5 — Web-based TUI for Gaffer

Researched 2026-09-27 against live sources. The Pi source is the `pi-mono` clone at commit `2b0a123` (2026-09-26). `github.com/badlogic/pi-mono` now 301-redirects to **`github.com/earendil-works/pi`**. Pi is `@earendil-works/pi-coding-agent` **0.87.1** on npm. The old `@mariozechner/*` scope stopped at 0.73.1.

**Goal:** give Gaffer, a Pi-based agent running in a container, a browser UI that looks and behaves like the Pi terminal CLI.

---

## 1. What Pi actually exposes

| Surface | What it is | Status |
|---|---|---|
| **Interactive TUI** | `pi`. Built on `@earendil-works/pi-tui`: differential rendering, markdown with tables, and `tuiMode: "regular"` (terminal scrollback) or `"fullscreen"` (alt-screen, mouse, scrollbar). | Stable, primary UX |
| **Print / JSON mode** | `pi --mode json "prompt"`: one-shot. Emits a session header, then JSONL session events, then exits. | Stable |
| **RPC mode** | `pi --mode rpc`: a long-lived subprocess. **JSONL over stdin/stdout**, strict LF framing. There are 4 record families: stdin *commands* (optional `id`), stdout `response` (the `id` is echoed back), stdout *session events* (no id), and a bidirectional *extension UI* subprotocol. | Stable, documented, typed (`src/modes/rpc/rpc-types.ts`), plus a `RpcClient` in TS |
| **SDK** | `createAgentSession()` runs in-process in Node or Bun. `session.subscribe(event => …)` delivers the same events, but with cumulative partials. | Stable |
| **pi-server / pi-client / pi-protocol** | Remote sessions. Length-prefixed **CBOR** frames (protocol v8), Chord services, and multi-presentation "attachments" per durable Session. Ships only a Unix-socket transport. | **Experimental.** "Peer authentication … not implemented", "no compatibility guarantees". Per the CHANGELOG, the server/client commands are "now source-only". |
| **pi-web-ui** | `@earendil-works/pi-web-ui`: mini-lit/Tailwind **chat** components (ChatPanel, artifacts, attachments). It runs `pi-agent-core`'s `Agent` **in the browser**, with API keys kept in IndexedDB. | **No longer in the monorepo.** Last published 0.75.3 in May 2026. It is not a terminal lookalike and does not drive the coding-agent CLI. **Do not build on it.** |

### RPC protocol in detail (the basis for Option B)

- **Commands** (from `rpc-types.ts`):
  - Prompting: `prompt` (`streamingBehavior: "steer"|"followUp"` is required while streaming), `steer`, `follow_up`, `abort`, `clear_queue`, `new_session`.
  - State and models: `get_state`, `get_messages`, `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`, …
  - Compaction: `compact`.
  - Shell: **`bash`** (runs an arbitrary shell command and streams `bash_execution_update`), `abort_bash`.
  - Sessions: `get_session_stats`, **`export_html` (optional `outputPath`)**, **`switch_session` (arbitrary `sessionPath`)**, `fork`, `clone`, `get_entries` (`since`), `get_tree`, `get_last_assistant_text`, `set_session_name`, `get_commands`.
- **Events** (shared with JSON mode):
  - Run lifecycle: `agent_start`, `agent_end`, `agent_settled`, `turn_start`, `turn_end`.
  - Messages: `message_start`, `message_update`, `message_end`. `message_update` is **delta-only**: `text_delta`, `thinking_delta`, `toolcall_start`/`toolcall_delta`/`toolcall_end`, plus cumulative `usage`.
  - Tools: `tool_execution_start`, `tool_execution_update` (`partialResult`), `tool_execution_end`.
  - Other: `queue_update`, compaction and retry events, `extension_error`.
- **Extension UI:**
  - Blocking dialogs: `select`, `confirm`, `input`, `editor`, answered with `extension_ui_response`.
  - Fire-and-forget: `notify`, `setStatus`, `setWidget` (string lines only), `setTitle`, `set_editor_text`.
  - Not available: `ctx.ui.custom()` returns `undefined`, `setFooter`/`setHeader` are no-ops, and there is no theme API.
- **Prompts** can be `/extension-command`, `/skill:name`, or `/template`. They are expanded or executed server-side, so slash commands work over RPC.
- **Session files are JSONL.** `--session-id <id>` "opens the exact project session ID or creates it", which gives deterministic resume after a process restart.

---

## 2. Options

### A. xterm.js ↔ WebSocket ↔ PTY running the real `pi` TUI

Tooling (versions checked 2026-09-27):

| Tool | Current | Notes |
|---|---|---|
| **ttyd** | **1.7.7** (2024-03-30). Last commit 2026-08-12 ("add viewport meta tag for mobile browsers"). | C/libwebsockets with an xterm.js frontend. **Spawns one process per WebSocket connection** (`spawn_process` on connect in `src/protocol.c`). Auth: `-c user:pass` (basic auth), `-H <header>` (trusts an auth-proxy header). Other flags: `-W` (**read-only by default**), `-O` check-origin, `-m` max clients, `-o` once, `-i` Unix socket, `-u/-g` uid/gid, `-S/-C/-K/-A` TLS and mTLS, `-b` base path. `-a` lets the URL inject argv, so leave it **off**. Also supports ZMODEM/trzsz file transfer. |
| gotty (sorenisanerd fork) | v1.8.0 (2026-05-24) | Go. Similar model; read-only by default. |
| wetty | v3.3.3 (2026-09-27) | Node. Oriented around SSH/login. Heavier. |
| node-pty + @xterm/xterm | node-pty 1.1.0; @xterm/xterm **6.0.0** (2025-12-22), beta 6.1.0-beta.304 | DIY bridge with full control over auth, multiplexing, and replay. |

**Fidelity:** exact, because it is literally Pi.

Caveats:
- **Shift+Enter / Alt+Enter.** Pi wants the Kitty keyboard protocol or xterm modifyOtherKeys (`docs/terminal-setup.md`, `docs/tmux.md`). xterm.js added Kitty keyboard support (PR #5600, merged 2026-01) only behind `vtExtensions.kittyKeyboard`, which appears in the **6.1 beta typings, not in 6.0.0 stable**. On stable you should expect to remap newline or queue keys through Pi keybindings.
- **tmux** needs `extended-keys on` and `extended-keys-format csi-u` (tmux ≥ 3.5).
- **xterm.js 6.0 notes:** the canvas renderer was removed (use DOM or `@xterm/addon-webgl` 0.19.0), synchronized output (DEC 2026) was added, OSC 52 clipboard is supported, and the Alt-key mapping was removed.
- **Relevant addons** (all 2025-12-22 stable):
  - `addon-attach` 0.12.0: raw WebSocket ↔ terminal.
  - `addon-fit` 0.11.0.
  - `addon-webgl` 0.19.0.
  - `addon-serialize` 0.14.0: snapshot the buffer for reconnect.
  - `addon-clipboard` 0.2.0: OSC 52, needed for Pi `/copy`.
  - `addon-web-links` 0.12.0, `addon-search` 0.16.0, `addon-unicode11` 0.9.0, `addon-image` 0.9.0 (sixel/iTerm).
  - `@xterm/headless` 6.0.0: server-side buffer for replay.

### B. Custom web frontend over Pi RPC (or the SDK), styled like the CLI

The browser talks to a Gaffer **bridge** over WebSocket. The bridge talks to `pi --mode rpc` over stdio JSONL, or to an in-process `AgentSession` through the SDK. The browser never touches a shell.

Rendering choices:
- **B1: HTML/CSS styled as a terminal.** Monospace font, the Pi theme palette, a prompt editor at the bottom, and a footer with model, tokens and cost. Use real DOM for markdown, **real `<table>` elements** for recommendations, collapsible tool calls, and `aria-live` for streaming. Best for mobile and accessibility.
- **B2: xterm.js as a pure renderer.** The bridge turns events into ANSI. It could reuse `pi-tui`'s `Markdown` component server-side, since `pi-tui` depends only on `marked` and `get-east-asian-width` but imports `node:*` modules, so it can't run in the browser without shims. This gives a closer look, but you rebuild the editor and keybindings and lose DOM tables and selection. It combines the costs of A and B, so it isn't recommended.

**Existing RPC web UIs** (community, early-stage; useful as references, not dependencies):
- `TheBlueChips/pi-agent-webui`: one `pi --mode rpc` per browser tab, relays "every pi RPC command and event … 1:1", and "No authentication is included".
- `hero-jianghaojie/pi-web-agent`: RPC over SSE plus POST.
- `ouyangjian28/pi-agent-ui`: a process per session, with desktop and mobile layouts.
- `VVander/pi-remote-web-ui`: one **SDK** `AgentSession` in the server, shared by all tabs, `state_sync` on reconnect, and SSH-tunnel-only access.
- `shixin-guo/picot` and `MarshallEriksen-Neura/pi-agent-desktop`: desktop apps that wrap RPC.

### C. Hybrids

- **C1 (recommended path).** Ship A for MVP and dev/admin, and B1 for end users. Both drive the same Gaffer extension, tools and session files. Because RPC can `switch_session` and the TUI can `--session`, one session can be opened in either UI.
- **C2: PTY for the chat plus a structured side channel.** A Gaffer extension writes recommendation JSON (tool `details`) to a small HTTP endpoint or file. The page shows xterm.js on the left and HTML tables with an export button on the right. This is cheap and adds tables and export to A.
- **C3 (future): pi-server.** Durable sessions with multiple presentation attachments are the "right" long-term substrate for multi-device resume. Today it is experimental, has no auth, and is Unix-socket only. Keep it on the watch list.

Other "agent in a browser terminal" projects, all ttyd/xterm.js + tmux around Claude Code: `snazzybean/claudux` (Docker: node + tmux + ttyd), `randyh0329/cloud_cli` (ttyd + tmux behind Cloudflare Access), `lhymes/claude-web-terminal` (Tailscale + ttyd + tmux), `receptron/mulmoterminal`, `my-claude-utils/clsh`, and `mtmux/mtmux`. The pattern is well trodden for **single-user** setups. None of these try to be multi-tenant.

---

## 3. Comparison

| Criterion | A: PTY + real TUI (ttyd/tmux) | B1: RPC bridge + terminal-styled HTML | C2: PTY + side channel |
|---|---|---|---|
| **Look and behaviour vs CLI** | Identical, including slash commands, keybindings, themes, `/tree`, and extension `custom()` UI | Close lookalike. You reimplement the editor, footer and slash-command palette (`get_commands`). No `ctx.ui.custom()`, no themes, `setWidget` is string-only. | Identical, plus a table pane |
| **Security: user-side blast radius** | **Shell-equivalent.** The TUI has `!cmd` / `!!cmd`, the `bash` tool is on by default, and there is `/login`, `/share` (uploads the session externally), and `/export` to any path. Anyone on the page can run anything the container user can: read env and API keys, reach network egress, write mounts. | **Only what the bridge allows.** The bridge whitelists commands: `prompt`, `steer`, `follow_up`, `abort`, `get_*`, `export_html` without `outputPath`. It **drops `bash`**, arbitrary `switch_session` paths, and `set_model` outside policy. The model's tools still run in the container, so model-side (prompt-injection) risk is the same as A. | Same as A |
| **How to restrict** | Run Pi with `--tools` as an allowlist (drop `bash` if Gaffer doesn't need it). Block `!` with a Gaffer extension `user_bash` handler, since returning a result stops propagation and a handler failure blocks. Remove `/share` and `/login` through settings or extension. Container hardening: non-root, `--read-only`, `cap-drop ALL`, `no-new-privileges`, no secrets in env (use a credential proxy per Pi's Docker Sandboxes pattern), egress allowlist. ttyd: `-W` (needed), `-O`, `-m 1`, bind to a Unix socket or localhost, behind an auth proxy with `-H X-Auth-User`. Never use `-a`. | Same container hardening plus the command whitelist. Authenticate the WebSocket (session cookie or JWT), check origin, and rate-limit prompts and cost per user. Answer extension UI dialogs only from the owning user. | Same as A |
| **Multi-user** | Poor. ttyd spawns a process per connection, and every user of one ttyd shares one container user. For isolation you need one container (or uid + tmux server) per user, plus a router mapping auth identity to that user's ttyd socket. | Good. The bridge maps user → one `pi --mode rpc` process (or one SDK `AgentSession`) per active session, ideally in a **per-user sandbox or container**. The SDK in-process approach is cheaper, but all users share one filesystem and process, which is weak isolation for `bash`/`write` tools. | Poor (as A) |
| **Token and tool streaming** | Whatever the TUI draws. Full fidelity, unstructured. | Structured: `text_delta` / `thinking_delta` / `toolcall_delta`, `tool_execution_update.partialResult`, and `usage` per update. You can build progress UIs per tool. | TUI, plus structured results after each tool finishes |
| **Reconnect / resume** | Use `ttyd … tmux new -A -s gaffer pi` (or dtach/abduco). A browser reconnect reattaches with the screen intact. If the process dies, `pi --session-id <id>` or `-c` resumes from JSONL. Scrollback lives in tmux, which is awkward on mobile. | The bridge keeps the Pi process alive independently of the socket and assigns sequence numbers to events. On reconnect, the client rehydrates via `get_state` + `get_messages` (or `get_entries since`) and replays buffered deltas. If the process dies, respawn with `--session-id`. Multiple tabs or devices can subscribe to one process. | Same as A |
| **Mobile** | Weak. Soft keyboards lack Esc/Ctrl/Shift+Enter, selection and scroll fight tmux, and the layout is fixed-width. ttyd only added a viewport meta tag in 2026-08 (unreleased). | Good. Responsive HTML, a native textarea, tap targets, and tables that scroll horizontally. | Weak (chat) / OK (tables) |
| **Accessibility** | Limited. xterm.js has `screenReaderMode`, but differential redraws and spinners are noisy, and there is no semantic structure. | Good. Semantic HTML, `aria-live="polite"` for streaming, real tables with headers, keyboard focus order. | Mixed |
| **Structured recommendations (tables)** | Markdown tables rendered by the pi-tui `Markdown` component (width-aware wrapping). Readable but not sortable, and they wrap badly on narrow screens. | Gaffer tools return `content` for the model and **`details` JSON** for UIs. The UI renders `tool_execution_end.result.details` as a sortable `<table>`. | TUI markdown plus an HTML table from `details` |
| **Export** | `/export` (HTML/JSONL) writes **inside the container**, so the user needs another channel (ttyd ZMODEM/trzsz, or C2). `/copy` works via OSC 52 with `addon-clipboard`. `/share` uploads externally, so disable it. | `export_html` (server path; the bridge serves it for download). CSV/JSON/XLSX export is generated client-side from `details`. `get_messages` gives a full transcript. | HTML/CSV from the side channel |
| **Effort** | **~0.5–1 day**: Dockerfile + ttyd + tmux + auth proxy + hardening | **~1.5–3 weeks** for a solid B1: bridge, auth, reconnect, editor, markdown, tool cards, tables, export. Reference repos shorten this. | ~2–4 days on top of A |
| **Maintenance** | Tracks Pi automatically | The RPC event schema has changed recently (delta-only `message_update`, `disposition`, `agent_settled`), so pin the Pi version and test | Low–medium |

---

## 4. Recommendation

### MVP (single user, local Docker)

Use **Option A**: `ttyd` → `tmux new -A -s gaffer` → `pi` (Gaffer extension loaded), inside the Gaffer container.
- Bind ttyd to localhost or a Unix socket with `-W -O -m 1`, and put basic auth (`-c`) or a local auth proxy (`-H`) in front.
- Run Pi as a non-root user, with provider keys through a credential proxy or at minimum a scoped key.
- Use `--tools` as an allowlist, and add a Gaffer extension `user_bash` handler that refuses `!` commands.
- Configure tmux extended keys as in `docs/tmux.md`.
- Use `tuiMode: "fullscreen"` if mouse-wheel scrolling in xterm.js matters more than native scrollback. Try both.

From day one, design **every Gaffer recommendation tool to return structured `details` JSON** alongside a markdown table in `content`. That costs nothing now and is what makes B painless later. If tables or export are needed in the MVP, add **C2** (a side pane fed by that JSON).

### Multi-user

Use **Option B1** (hybrid C1: keep A as an admin/dev console).
- A Gaffer web bridge authenticates users and runs **one `pi --mode rpc` process per user session inside a per-user sandbox or container**. RPC gives a clean process boundary. Don't use the SDK in-process for multi-user unless tools cannot touch the filesystem or shell.
- The bridge **whitelists RPC commands**: no `bash`, no arbitrary paths. It persists the session JSONL per user, fans events out to all of a user's tabs, and supports resume via `get_state`/`get_messages` plus `--session-id` respawn.
- The frontend is terminal-styled HTML: monospace, Pi palette, bottom editor, and a status footer showing model, tokens and cost from `usage`. It renders `details` as real tables with CSV/JSON export and `export_html` download.
- Re-evaluate **pi-server** (durable Sessions, multi-attachment) once it gains auth and a WebSocket transport and leaves experimental status.

---

## Sources

- Pi RPC docs: https://pi.dev/docs/latest/rpc (live, 2026-09-27) and the repo at `packages/coding-agent/docs/rpc.md`
- Pi RPC commands: `packages/coding-agent/docs/rpc-commands.md`; types in `packages/coding-agent/src/modes/rpc/rpc-types.ts` (earendil-works/pi @ `2b0a123`)
- Pi JSON event stream: `packages/coding-agent/docs/json.md`
- Pi RPC extension UI: `packages/coding-agent/docs/rpc-extension-ui.md`
- Pi SDK: `packages/coding-agent/docs/sdk.md`
- Pi security and containerization: `packages/coding-agent/docs/security.md`, `docs/containerization.md`
- Pi tmux / terminal setup: `docs/tmux.md`, `docs/terminal-setup.md`
- Pi CLI flags (`--tools`, `--session-id`): `docs/cli.md`
- Slash commands: `docs/slash-commands.md`
- Settings (`tuiMode`): `docs/settings.md`
- Extensions (`user_bash`): `docs/extensions.md`
- Pi CHANGELOG (RPC changes, "source-only" server/client): `packages/coding-agent/CHANGELOG.md`
- pi-server / pi-client / pi-protocol READMEs: `packages/{server,client,protocol}/README.md`
- pi-tui deps and markdown tables: `packages/tui/package.json`, `packages/tui/src/components/markdown.ts`
- Repo move: `https://api.github.com/repos/badlogic/pi-mono` → 301; `https://api.github.com/repos/earendil-works/pi`
- pi-web-ui: `npm view @earendil-works/pi-web-ui` (0.75.3), tarball README
- xterm.js releases: https://github.com/xtermjs/xterm.js/releases; npm `@xterm/*` versions and times (`npm view`)
- xterm.js Kitty keyboard: https://github.com/xtermjs/xterm.js/pull/5600; `@xterm/xterm@6.1.0-beta.304` typings (`kittyKeyboard?: boolean`); 6.0.0 typings (`screenReaderMode?: boolean`)
- ttyd: https://github.com/tsl0922/ttyd (README options; `src/protocol.c` `spawn_process`); latest release API (1.7.7, 2024-03-30); latest commit 2026-08-12
- gotty: https://github.com/sorenisanerd/gotty (v1.8.0); wetty: https://github.com/butlerx/wetty (v3.3.3)
- node-pty: npm 1.1.0
- Community Pi web UIs: https://github.com/TheBlueChips/pi-agent-webui, https://github.com/VVander/pi-remote-web-ui, https://github.com/hero-jianghaojie/pi-web-agent, https://github.com/ouyangjian28/pi-agent-ui, https://github.com/shixin-guo/picot, https://github.com/MarshallEriksen-Neura/pi-agent-desktop
- Browser-terminal agent projects: https://github.com/snazzybean/claudux, https://github.com/randyh0329/cloud_cli, https://github.com/lhymes/claude-web-terminal, https://github.com/receptron/mulmoterminal, https://github.com/my-claude-utils/clsh, https://github.com/mtmux/mtmux

## Unconfirmed

- **Shift+Enter in xterm.js 6.0.0 stable with Pi.** Not tested. Inferred from Pi needing Kitty or modifyOtherKeys and from `kittyKeyboard` existing only in the 6.1 beta typings. I did not check whether xterm.js 6.0 supports modifyOtherKeys. Where I looked: xterm typings, PR #5600, Pi `terminal-setup.md`.
- **Whether `/share` and `/login` can be disabled cleanly** by setting or extension. I did not find a documented per-command disable. Where I looked: `slash-commands.md`, `settings.md`. Needs spike S1.
- **Whether a `user_bash` handler also covers RPC `bash`.** The CHANGELOG says "Fixed direct RPC bash commands bypassing extension `user_bash` handlers", which implies yes. Not tested.
- **pi-web-ui's removal date and reason.** It is absent from the monorepo at `2b0a123`, and the last npm publish was 2026-05-18. No changelog entry was found (shallow clone, no history).
- **Community projects' maturity** (stars, last commits) came from WebFetch summaries and was not audited. Most describe themselves as early WIP.
- **Effort estimates** are judgement, not measured.
- **The "ANSI OSC52 clipboard support" line** in xterm 6.0.0 notes came via a WebFetch summary. I did not check whether it lives in core or in `addon-clipboard`. The xterm.js release-page summary gave 6.0.0's date as 2024-12-22, which conflicts with npm and the GitHub API (both **2025-12-22**). I trusted npm.
- **No spike was run.** Nothing was written to `spikes/`, and `pi --mode rpc` was not executed locally because it needs provider credentials.
