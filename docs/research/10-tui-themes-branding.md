# 10 — TUI, themes and branding (Gaffer Terminal on Pi 1.3.0)

Research date: 2026-10-17/18.

**Versions read:** `@earendil-works/pi-coding-agent` **1.3.0** (tag `v1.3.0`, commit `71023aec`, 2026-10-15), compared with **0.87.1** (`f07218c4`, Gaffer's pin). Pi `main` is 16 commits past 1.3.0 with nothing on the TUI, themes or commands. ttyd **1.7.7** (2024-03-30), tmux **3.5a** (Debian trixie).

Path conventions: `src/…` = `packages/coding-agent/src/…`, `tui/…` = `packages/tui/src/…`, `docs/X.md` = `packages/coding-agent/docs/X.md` = `https://pi.dev/docs/latest/X`. `IM` = `src/modes/interactive/interactive-mode.ts`. All line numbers are `@v1.3.0` unless marked.

**Spikes:** S5 `docs/spikes/s5-tui-branding.md` (branding extension, real `pi` 1.3.0 in a 100×40 tmux pane, `--network none`), S9 `docs/spikes/s9-web-terminal.md` (the same through ttyd 1.7.7 + tmux in a browser). Both READMEs have the commands to re-run.

---

## TL;DR for Gaffer

| Need | Possible from an extension? | How | Evidence |
|---|---|---|---|
| Gaffer wordmark instead of Pi's header | Yes | `ctx.ui.setHeader()` + `quietStartup: true` | S5 `gaffer-start.txt` |
| Live strip: team · GW · deadline countdown · FTs · bank · budget | Yes | `ctx.ui.setFooter()` component + own 1 s timer → `tui.requestRender()` | S5: countdown moved 2 s in 2 s |
| Tab title | Yes, but use ttyd `titleFixed` | `ctx.ui.setTitle()`; Pi overwrites it after `session_start` | S5 `titles.txt`; S9 |
| Brand theme, light and dark | Yes | Two theme files and `theme: "gaffer-light/gaffer-dark"`; pin the browser terminal's palette | S5 theme runs; S9 |
| Only Gaffer's slash commands | **Hidden: yes (supported). Blocked: yes, but through undocumented behaviour** | `addAutocompleteProvider` filter + a `CustomEditor` whose `onSubmit` wraps Pi's handler | S5: all 29 blocked |
| Shortcuts to the same actions gone | Yes (supported) | `keybindings.json` `[]` + `doubleEscapeAction: "none"` | S5 `gaffer-key-*.txt` |
| Reasoning, tool and recommendation rendering unchanged | Yes | Dark theme keeps today's colours; renderers untouched | S9 100-column screenshot |
| Fullscreen through ttyd 1.7.7 + tmux | Yes, except copy-to-clipboard and phones | — | S9 |

**Stop-and-ask:** Pi 1.3.0 has **no supported way to remove or disable a built-in slash command**, including `/share`, `/login` and `/bug`. A `disabledCommands` setting was proposed upstream on 2026-08-18 (issue #8325, PR #8326) and auto-closed unmerged. The block S5 proves works, but it depends on Pi copying its submit handler onto a custom editor, which is not a documented contract. `/share` and `/bug` are also blocked by the environment today (no `gh`, no Radius token, `PI_OFFLINE=1`), but the only hard guarantee against publishing is an egress allowlist on the harness. See §6.

---

## 1. Themes (question 1)

### 1.1 How the theme is chosen at 1.3.0
- **The setting wins.** The controller resolves `settings.theme` first and uses `system` only when there is no setting (`src/modes/interactive/theme/theme-controller.ts:173-176`; `docs/themes.md:38`). So `theme: "gaffer"` is not overridden by the system theme.
- **Silent fallback.** If the named theme fails to load or validate, Pi falls back to `system` (`theme/theme.ts:682-719`). With a setting present it also shows "Failed to load theme … Fell back to the system theme" (`theme-controller.ts:178-185`).
- **Stricter validation since 1.2.0.** Theme files are now checked at startup with `additionalProperties: false` on the document and on `colors` (`theme/theme-schema.ts:44-90`; CHANGELOG 1.2.0). Gaffer's current `themes/gaffer.json` passes unchanged (S5: `theme=gaffer`, no error). Its `$schema` should move to `https://pi.dev/schemas/theme.schema.json` (cosmetic).
- **Light/dark pair.** A setting with one `/` is a pair, `"<light>/<dark>"` (`theme.ts:578-610`; `docs/themes.md:44-54`). Pi decides dark or light from the background the terminal reports (OSC 11), then the terminal's scheme notification, then `COLORFGBG`, then dark (`theme.ts:615-641`; `docs/themes.md:48`). It switches when the terminal reports a change (`theme-controller.ts:225-247`).
- **`appearance`** (`"dark"` | `"light"`, optional) says which background a theme is designed for; when omitted it is guessed from the theme's colours (`theme-schema.ts:60-64`; `theme.ts:242`). It drives `theme.appearance` for extensions and the guess for terminal-default colours (`""`).
- **Colour syntax** (0.99.0+): `#rgb`, `#rrggbb`, `oklch(L C H)`, `okhsl(H S L)`, a 0–255 palette index, `""` (terminal default), or a `vars` reference (`theme.ts:79-93`; `docs/themes.md:84-94`). S5's light theme is written in `oklch()` and rendered as truecolor.
- **`system`** (default since 0.99.0, 2026-09-29): builds every token from the terminal's reported foreground, background and ANSI palette in OKHSL with contrast rules (`theme/system-theme.ts:1-20`; blog 2026-10-09). Its accent is Pi's violet family (`system-theme.ts:56,99-104`). In S5 it rendered Pi's violet wordmark, not Gaffer's green.

### 1.2 What S5 showed
| Setting | Dark terminal | Light terminal |
|---|---|---|
| none (`system`) | Pi violet accent | Pi violet accent, light variant |
| `gaffer` (today's file) | Today's look | **Unreadable regions**: text `#e8e8e3` on a light background |
| `gaffer-light/gaffer-dark` | `gaffer-dark` (today's colours) | `gaffer-light` |

Inside tmux, Pi's OSC 11 query is answered by tmux from the window style or the attached client's terminal. In S9, ttyd's `-t theme={"background":"#121a15",…}` reached Pi as a dark background and the pair chose `gaffer-dark`.

### 1.3 Recommendation
Ship a **fixed brand theme as a pair** (`gaffer-dark` = today's `gaffer.json` with `appearance: "dark"`; `gaffer-light` new), set `theme: "gaffer-light/gaffer-dark"`, and **pin the browser terminal's palette** with ttyd `-t theme=…` (background, foreground, cursor, selection) to Gaffer's dark colours. Do not follow the terminal: `system` gives Pi's identity, and the browser terminal's palette is ours anyway.
- *Why Gaffer can't do without it:* the brand needs fixed colours, and a single dark theme becomes unreadable the day the terminal palette is light. The light file costs one JSON file.

---

## 2. What an extension can replace (question 2)

All methods below are on `ctx.ui` (`src/core/extensions/types.ts:149-300`), implemented in `IM:2633-2700`. **Every one also exists at 0.87.1** (`types.ts:151-281 @v0.87.1`), so branding does not need the upgrade. The docs only list them (`docs/tui.md:10-16`); header and footer are documented only by `examples/extensions/custom-header.ts` and `custom-footer.ts`. All extension UI is cleared on every session switch, `/new` and reload (`IM:2452-2489`), so Gaffer re-applies it in `session_start` (S5 did, `reason=new`).

| Element | API | Behaviour at 1.3.0 | S5/S9 |
|---|---|---|---|
| Startup header | `setHeader((tui, theme) => Component)` | Replaces the built-in header in place (`IM:2551-2590`). With `quietStartup: true` Pi never builds its logo header (`IM:1005-1082`, `IM:1423-1426`), so nothing flashes before `session_start`. `"header"` keeps Pi's header and is no use to Gaffer. | Wordmark at 100 cols; one-word fallback at 38 cols |
| Footer / status line | `setFooter((tui, theme, footerData) => Component)` | Replaces Pi's footer completely (`IM:2524-2546`): cwd, token counts, cost, context %, model all go. `footerData` gives the git branch, extension statuses and provider count (`src/core/footer-data-provider.ts:385-388`); usage comes from `ctx.getContextUsage()` and session entries. Live updates need the component's own timer and `tui.requestRender()`; return `dispose()` to stop it. | Ticking countdown |
| Widgets | `setWidget(key, string[] \| factory, { placement: "aboveEditor" \| "belowEditor" })` | String widgets are capped at 10 lines; factories are not (`IM:2398-2440,2488`). | Not used |
| Status entries | `setStatus(key, text)` | Shown in Pi's footer; with a custom footer read them via `footerData.getExtensionStatuses()`. | — |
| Working line | `setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator({frames, intervalMs})`, `setHiddenThinkingLabel` | Brand the spinner and the "thinking" label. | Set, not seen (no model run) |
| Editor | `setEditorComponent(factory)`; extend `CustomEditor` | Pi copies `onSubmit`, `onChange`, `onEscape`, `onCtrlD`, the paste and shortcut handlers and every app action onto the custom editor (`IM:2873-2945`). Option `embedWorkingStatus` puts the spinner in the editor border (`components/custom-editor.ts:5-79`). | Used for the command block |
| Autocomplete | `addAutocompleteProvider(current => provider)` | Wrappers stack on the built-in provider (`IM:835-852`); can drop items and suppress `@file`/path completion. | Used |
| Overlays / screens | `custom(factory, { overlay, overlayOptions, onHandle })`; `select`, `confirm`, `input`, `editor`, `notify` | Focus-taking component until `done()`. | — |
| Raw input | `onTerminalInput(data => ({consume, data}))` | Runs before focus dispatch (`tui/tui.ts:1063-1078`). | Not tested |
| Terminal title | `setTitle(text)` → OSC 0 (`tui/terminal.ts:571-574`) | **Pi overwrites it** with `π - <cwd>` after extensions bind and on session switch or rename (`IM:1132-1139,2115,2473,3492`). Re-apply on the next tick. | `Gaffer · GW8` |
| Program status (OSC 7501) | none | Not extension-controlled. `app=pi` is fixed by Pi's own `package.json` (`src/config.ts:577-580`; `program-status-reporter.ts:95-101`). Sent only if the terminal answers Pi's query or `PI_PROGRAM_STATUS=1` (`tui/terminal.ts:286-298,576-579`; `docs/terminal-setup.md:233`). tmux and xterm.js don't answer. | Never emitted (S9) |
| Theme at run time | `setTheme`, `getTheme`, `theme.style()/colors/appearance` | `appearance` and `colors` are 0.99+. | — |

**What an extension cannot change:** the built-in command list; startup warnings such as `fd not found … Offline mode enabled` (printed even with `quietStartup: true`, `IM:3819-3829`; also at 0.87.1); Pi's own texts ("No models available. Use /login …", the `[Extension issues]` panel); the `/hotkeys` and `/settings` screens; `app=pi` in OSC 7501. In RPC mode `setHeader`, `setFooter`, `setEditorComponent` and `addAutocompleteProvider` are no-ops (`docs/rpc-extension-ui.md:18`), so a later "Gaffer App" over RPC brands itself.

---

## 3. Built-in slash commands at 1.3.0 (question 3)

### 3.1 How they are dispatched
- The 24 listed built-ins are a hard-coded array (`src/core/slash-commands.ts:19-44`), identical to 0.87.1 except `/share`'s description (Radius added). Three more are matched but unlisted: `/debug`, `/arminsayshi`, `/dementedelves` (`IM:3322-3336`).
- The editor's submit handler matches them by exact text **before** anything reaches the session (`IM:3202-3345`). `session.prompt()` then runs extension commands before emitting `input` (`src/core/agent-session.ts:2068-2082`). So an `input` handler never sees a built-in or an extension command. S5 confirmed: only plain text reached `input`.
- An extension command with a built-in's name is skipped in autocomplete and the built-in wins (`IM:710-722,811-813`). S5 confirmed.
- `/mcp` and `/llama` are commands of **built-in extensions** (`src/extensions/index.ts`), which a settings entry can disable: `extensions: ["-builtin:mcp", "-builtin:llama.cpp"]` (`src/core/package-manager.ts:976-990`).
- No setting, flag or API hides or disables a built-in command (`docs/settings.md`, `docs/slash-commands.md`, `types.ts`). Upstream issue #8325 / PR #8326 ("Add `disabledCommands` setting", 2026-08-18) were auto-closed and not merged.

### 3.2 The full table

Columns: **Shell** = spawns a process in the harness; **Net** = network call; **FS** = reads or writes the harness filesystem outside `/work`; **Cred** = handles credentials; **Pub** = publishes session data; **LLM** = a model call outside Gaffer's run budget.

| Command | What it does at 1.3.0 | Reaches | Gaffer | Mechanism |
|---|---|---|---|---|
| `/settings` | 33-item settings menu: theme, TUI mode, autocompact, transport, **share destination**, **install telemetry**, project trust… Writes `settings.json` (`components/settings-selector.ts:487-871`). | FS, Net (telemetry) | **Block** | wrapper + hidden |
| `/model [p/m]` | Model selector or direct switch; Ctrl+S saves the default. With the harness key, any Anthropic model (S5 baseline listed 17). Overrides ADR 0008. | — | **Block** | wrapper; unbind Ctrl+L, Ctrl+P, Shift+Ctrl+P |
| `/thinking [level]` | Sets the thinking level (cost). | — | **Block** | wrapper; unbind Shift+Tab |
| `/scoped-models` | Writes `enabledModels`. | FS | **Block** | wrapper |
| `/tree` | Session tree; switching branches can generate a branch summary. | LLM | **Block** | wrapper; `doubleEscapeAction: "none"` |
| `/export [path]` | Writes the session as HTML or JSONL to **any path the `gaffer` user can write** (`IM:6538-6553`): `/sessions`, `/data`, `/opt/pi-agent`. | FS | **Block** (Gaffer has `/export-rec`) | wrapper |
| `/import <path>` | Reads any JSONL path and replaces the session (`IM:6585-6627`). | FS | **Block** | wrapper |
| `/share` | Uploads the branch to **Radius** (artifact, organisation visibility) when a Radius token exists, else a secret **GitHub gist** via `gh` (`session-share.ts:57-160`). Not gated by `PI_OFFLINE`. `sessionShareDestination`: `auto`/`gist`/`radius`, no "off". | Net, Cred, Pub, Shell (`gh`) | **Block — must be impossible** | wrapper + `sessionShareDestination: "gist"` (no `gh` in image) + block `/login` + egress allowlist |
| `/bug [text]` | Consent dialog, then **anonymous** multipart upload of diagnostics (settings, extensions, model config, optional transcript) to the Radius gateway `/v1/bug-reports`; optional model-written summary; or a zip in cwd (`bug-report.ts:49-104`; `core/bug-report-upload.ts:12-37`). Upload is refused when `PI_OFFLINE` is set (`bug-report.ts:56-59`); the summary still runs. | Net, Pub, LLM, FS | **Block** | wrapper + `PI_OFFLINE=1` (already set) |
| `/copy` | Copies the last assistant message (native clipboard, else OSC 52 in a headless container, `utils/clipboard.ts:118-140`). | — | **Keep** (fix OSC 52, §4) | allowlist |
| `/name [name]` | Sets the session name (also the title). | — | **Block** | wrapper |
| `/session` | Session file path, IDs, tokens and cost per model. | — | **Block** (Gaffer has `/usage`) | wrapper |
| `/changelog` | Pi's changelog. | — | **Block** (Pi branding) | wrapper |
| `/hotkeys` | Pi's shortcut table; lists unbound actions with empty keys and "`!` Run bash command" (S5). | — | **Block**; add a Gaffer `/help` | wrapper |
| `/fork` | New session file from an earlier message. | FS (sessions) | **Block** | wrapper |
| `/clone` | Duplicates the session file. | FS (sessions) | **Block** | wrapper |
| `/trust` | Saves a project trust decision in the agent dir. | FS | **Block** | wrapper |
| `/login [provider]` | Account (OAuth) sign-in, API key entry, or **Radius sign-in, which also writes a Radius MCP server into the global `mcp.json` and reloads** (CHANGELOG 1.0.0). Writes `auth.json`. | Net, Cred, FS | **Block** | wrapper |
| `/logout` | Removes stored credentials. | Cred, FS | **Block** | wrapper |
| `/new` | New session. | — | **Keep** | allowlist |
| `/compact [instr]` | Manual compaction (a model call). Auto-compaction still runs with Gaffer's FPL summary. | LLM | **Block** | wrapper |
| `/resume` | Session selector. In it, **Ctrl+D / Ctrl+Backspace delete session files** (`trash`, else `unlink`) and Ctrl+R renames (`components/session-selector.ts:583-600,652-680`). Sessions are Gaffer's system of record. | FS (delete) | **Block** in MVP; keep only with `app.session.delete`, `app.session.deleteNoninvasive` and `app.session.rename` unbound; block in multi-user | wrapper / keybindings |
| `/reload` | Reloads keybindings, extensions, skills, prompts, themes, context files. | FS (reads) | **Block** | wrapper |
| `/quit` | Exits Pi. Through tmux + ttyd the page disconnects; reconnecting starts Pi again with `--continue`. | — | **Block** (pointless in a browser) | wrapper |
| `/debug` (hidden) | Writes the full screen and all messages to the agent dir's debug log (`IM:6959-6990`). Also on the hard-coded Shift+Ctrl+D (`tui/tui.ts:1083-1087`), which xterm.js can't send distinctly. | FS | **Block** | wrapper |
| `/arminsayshi`, `/dementedelves` (hidden) | Easter eggs (a 3D animation, an Earendil announcement with an image). | — | **Block** | wrapper |
| `/mcp` (built-in ext.) | MCP manager: OAuth sign-in, reconnect, enable or disable servers. | Net, Cred, FS | **Block** | `-builtin:mcp` (see S3) + wrapper |
| `/llama` (built-in ext.) | llama.cpp router models, downloads. | Net | **Block** | `-builtin:llama.cpp` + wrapper |
| `/skill:<name>` | Runs a skill as a command. | — | **Block** | `enableSkillCommands: false` + wrapper |
| `!cmd`, `!!cmd` | User shell. | Shell | Blocked today | existing `user_bash` handler |
| Gaffer: `/team /prefs /export-rec /usage /scorecard /gw /explain /whatif` (+ `/help`) | — | — | **Keep** | allowlist |

### 3.3 Shortcuts that reach the same actions
All action IDs are in `src/core/keybindings.ts:26-117`; `keybindings.json` with `[]` unbinds one (`docs/keybindings.md:19-27`). S5 confirmed each unbound key did nothing.

| Key (default) | Action | Gaffer |
|---|---|---|
| Ctrl+L | `app.model.select` | `[]` |
| Ctrl+P, Shift+Ctrl+P | `app.model.cycleForward/Backward` | `[]` |
| Shift+Tab | `app.thinking.cycle` | `[]` |
| Ctrl+G | `app.editor.external`: spawns `externalEditor` / `$VISUAL` / `$EDITOR` / `nano` in the harness (`core/settings-manager.ts:961-971`; `external-editor.ts:14-32`). nano's Execute Command would be a shell. The base image has no editor (checked), so latent. | `[]` + `externalEditor: "/bin/false"` |
| Ctrl+Z | `app.suspend`: stops Pi inside tmux, the tab freezes. | `[]` |
| Esc Esc (empty editor) | `doubleEscapeAction` (default `tree`, `IM:3082-3096`) | `doubleEscapeAction: "none"` |
| none by default | `app.session.new/tree/fork/resume` | `[]` (belt and braces) |
| In `/resume`: Ctrl+D, Ctrl+Backspace, Ctrl+R | delete / delete / rename session | `[]` if `/resume` is kept |
| Ctrl+V | paste image from the harness clipboard (none) | leave |
| Ctrl+X, Ctrl+O, Ctrl+T | copy, expand tools, show thinking | keep |

### 3.4 The block mechanism (proven in S5)
1. **Hide** (supported): `ctx.ui.addAutocompleteProvider(wrap)` drops every item not on Gaffer's allowlist and returns `null` for `@file` and Tab path completion (which would otherwise list the harness filesystem).
2. **Block** (works, undocumented): `ctx.ui.setEditorComponent(() => new GafferEditor(…))`, where `GafferEditor extends CustomEditor` and, in its constructor, defines `onSubmit` as an accessor. Pi assigns its own submit handler with `newEditor.onSubmit = this.defaultEditor.onSubmit` (`IM:2889`); the setter wraps it. Every submission calls `this.onSubmit` (`tui/components/editor.ts:1364-1378`; Alt+Enter when idle, `IM:4514-4517`). The wrapper refuses any `/name` that is not on the allowlist, clears the editor and notifies. Use an **allowlist** so built-ins added in later Pi versions are refused by default.
3. **Config** (supported): `settings.json` (`quietStartup: true`, `doubleEscapeAction: "none"`, `enableSkillCommands: false`, `sessionShareDestination: "gist"`, `externalEditor: "/bin/false"`, `extensions: ["-builtin:mcp", "-builtin:llama.cpp", "-builtin:codemode", "-builtin:tool-search"]`) and `keybindings.json` as in §3.3. `/settings` and `/reload` are blocked, so a user cannot undo them.
4. **Environment** (the real guarantee): no `gh`, no `xdg-open`, no editor in the image; `PI_OFFLINE=1`; no Radius or OAuth credentials; an egress allowlist for the harness (LLM API + FPL only) would make `/share`, `/bug` and `/login` fail even if reached.

Fallback if Pi changes the editor wiring: `ctx.ui.onTerminalInput` (documented) runs before focus and can consume Enter when `ctx.ui.getEditorText()` starts with a refused command. It depends on key encodings (CSI-u Enter, Alt+Enter, autocomplete) and is untested. Keep `spikes/s5-tui-branding/run-s5.sh` as a regression test on each Pi upgrade.

---

## 4. Web terminal (question 4)

### 4.1 Pi 1.3.0 through ttyd 1.7.7 + tmux 3.5a (S9, 100 columns)
| Feature | Result | Note |
|---|---|---|
| Fullscreen render | Works | Wordmark, strip, theme, 15-row table at 100 cols |
| UTF-8 | Works **only with `LANG=C.UTF-8`** in ttyd's environment | Without it tmux draws `█` and `£` as `_` (S9 screenshot). The harness sets `LANG`. |
| Mouse wheel | Works | SGR wheel events pass through tmux (`mouse off`) to Pi |
| Selection | Pi owns it (drag → "Copied!") | xterm.js native selection is not used |
| OSC 52 copy | **Broken in today's config** | tmux's default `set-clipboard external` drops Pi's OSC 52; with `on` it reaches xterm.js, but **ttyd 1.7.7 has no OSC 52 handler** (no clipboard addon in its bundle). "Copied!" is false. `/copy` is affected the same way. |
| Shift+Enter | Works | `ttyd-keys.js` sends `ESC[13;2u` |
| Ctrl+C | Works | Sends `\x03` (the pane's automation swallows a literal Ctrl+C) |
| Title | Static only | With tmux `set-titles on`, ttyd 1.7.7 shows `<title> \| <command> (<container id>)` (`html/src/components/terminal/xterm/index.ts:170-172 @1.7.7`). Keep `titleFixed=Gaffer`. |
| OSC 8 links | Not clickable | The click goes to Pi as a mouse event; Pi runs `xdg-open` in the container (`tui-renderer.ts:35`; `utils/open-browser.ts:10-23`), which is absent |
| OSC 7501 | Never sent | No terminal answers the query |
| Kitty keyboard, images | Not available | ttyd bundles xterm.js 5.x (`@xterm/xterm ^5.4.0` at the 1.7.7 tag) |
| 375 px phone | Poor | ttyd 1.7.7 has no viewport meta tag: 980 px layout, tiny text. With the tag: 38 columns, strip cut after "D…" |
| Cross-site WebSocket | Blocked by the browser in S9 | The harness runs ttyd **without `--check-origin`** (`harness/entrypoint.sh`); research 05 recommended `-O` |

### 4.2 ttyd's state
- Latest release **1.7.7, 2024-03-30**. `main` is 24 commits ahead (last 2026-08-12): xterm 5.5.0 and `@xterm/addon-clipboard` (2024-11-26), the viewport tag (2026-08-12). No release since.
- xterm.js is **6.0.0** (2025-12-22); `6.1.0-beta.315` is the beta. Kitty keyboard is still beta-only.
- Maintained alternatives: `sorenisanerd/gotty` **v1.10.0 (2026-10-10)**, xterm 6.0; `butlerx/wetty` **v4.0.1 (2026-10-14)**, SSH/login oriented.

### 4.3 Is node-pty + `@xterm/xterm` 6 worth it?
Not yet. Estimate ~250 LOC (server 120–150: static page, WebSocket upgrade with auth-header and Origin checks, one client, spawn only `tmux new -A -s gaffer gaffer-pi`, resize; page 80–100: xterm + fit + clipboard + webgl, Shift+Enter, reconnect) and deps `node-pty` 1.1.0 (native addon), `ws` 8.22.0, `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, `@xterm/addon-clipboard` 0.2.0, optional `@xterm/addon-webgl` 0.19.0. It fixes clipboard, viewport and title, but the same fixes on ttyd cost ~10 lines in the page Gaffer already injects plus two flags. Revisit for the multi-user bridge (ADR 0005 phase 3) or if a ttyd CVE appears; evaluate gotty 1.10 first.

---

## 5. Recommendations
1. **Brand from one extension** (or inside `gaffer-core`): `setHeader` wordmark, `setFooter` two-line strip (line 1 team · GW · deadline countdown · FTs · bank; line 2 budget used today/session, context %, model), re-applied in every `session_start`. *Why:* the stated goal; all supported APIs.
2. **Allowlist the commands**: autocomplete filter + `CustomEditor` `onSubmit` wrapper; keep `/new`, `/copy`, Gaffer's commands and templates, and a new Gaffer `/help`. *Why:* there is no supported switch; an allowlist survives new built-ins.
3. **Ship `settings.json` and `keybindings.json` in the image** as in §3.4. *Why:* closes the shortcut paths with supported config.
4. **Theme pair + pinned ttyd palette** (§1.3). *Why:* brand colours, never unreadable.
5. **ttyd page fixes**: OSC 52 → `navigator.clipboard.writeText` handler and a viewport meta tag in the injected script; tmux `set -g set-clipboard on` and `terminal-features …:clipboard`; ttyd `--check-origin`; keep `titleFixed=Gaffer`. *Why:* copy is silently broken today; origin check is defence in depth.
6. **Install `ripgrep` and `fd-find`** in the harness, or accept two yellow warnings under the wordmark at every start. *Why:* cosmetic only; skip if image size matters more.
7. **Regression test**: port `run-s5.sh` into the harness checks: start Pi in tmux, submit each built-in, assert it is refused. *Why:* the block rests on undocumented behaviour.
8. **Egress allowlist for the harness** (LLM API, FPL, football-data). *Why:* the only hard guarantee that `/share`, `/bug` or `/login` can never publish or authenticate, whatever the UI does.
9. Optionally file an upstream issue for a supported `disabledCommands` setting or extension API.

## 6. Core-assumption check (for the lead)
- **No supported way to make `/share`, `/bug` or `/login` impossible from Pi.** Today they are refused by a tested but undocumented hook, plus the environment: no `gh`, `PI_OFFLINE=1` (refuses `/bug` uploads), no Radius token. `/share` to Radius needs only a Radius OAuth token, which `/login` can create. That is why `/login` must be blocked too and why an egress allowlist is the real guarantee. This does not force abandoning pi-coding-agent, but it is a stop-and-ask: accept "undocumented hook + regression test + environment", or require egress control first.
- **Lead's resolution (2026-10-18):** the stop condition is not met. With the documented `sessionShareDestination: "gist"`, `/share` never tries Radius, even when a Radius token exists (`if (destination !== "gist")`, `modes/interactive/session-share.ts:68 @v1.3.0`), and the gist path needs the `gh` CLI, which the image lacks and no user can install without a shell. `/bug` uploads are refused by `PI_OFFLINE=1`; `/login`'s Radius MCP write is neutralised by `--no-mcp` (ADR 0012). So the publish and credential paths are closed by supported controls, and the undocumented hook is defence in depth and UX. ADR 0013 records this; the egress allowlist becomes a Phase 2 requirement.
- MCP: disable-able by supported settings (`-builtin:mcp`; `--no-mcp` per run). Details in S3.
- These gaps exist at 0.87.1 too: `/model`, `/login`, `/share`, `/export`, `/resume` delete, Ctrl+G are reachable in the running MVP.

## 7. Contradictions with the brief or Gaffer's docs
- `ARCHITECTURE.md:120` keeps "session tree, `/resume`, `/tree`, model switching, thinking levels, themes, keybindings … unchanged — that's the point of the experiment". Branding reverses that; it needs an ADR.
- `BUILD.md:289` says `/share` "needs `gh`, which the image doesn't have". Since at least 0.87.1, `/share` first tries **Radius** with an OAuth token and needs no `gh` (`session-share.ts:69-75`).
- ADR 0005 / research 05 recommend `-O`; `harness/entrypoint.sh` has no `--check-origin`.
- Research 05 lists `addon-clipboard` as "needed for Pi `/copy`"; ttyd 1.7.7 ships without it and tmux drops OSC 52 by default, so copy has probably never worked in the browser (inferred; the running stack was not touched).
- `harness/gaffer-pi` says fullscreen scrolls with "Home/End". Since 1.0.3, Home/End move the editor cursor; transcript top/bottom are Ctrl+Home/Ctrl+End (CHANGELOG 1.0.3).
- The brief calls `/mcp` a built-in: it belongs to the built-in **extension** `builtin:mcp`; `/llama` likewise. There are also three hidden built-ins (`/debug` and two easter eggs).

---

## Sources
- Pi source at `v1.3.0` (`71023aec`, 2026-10-15) and `v0.87.1` (`f07218c4`): files cited inline.
- Pi CHANGELOG `packages/coding-agent/CHANGELOG.md`, entries 0.99.0 (2026-09-29) to 1.3.0 (2026-10-15).
- Pi docs at v1.3.0: `themes.md`, `settings.md`, `slash-commands.md`, `keybindings.md`, `tui.md`, `terminal-setup.md`, `tmux.md`, `rpc-extension-ui.md` (= pi.dev/docs/latest, undated pages).
- Pi examples: `examples/extensions/custom-header.ts`, `custom-footer.ts` (v1.3.0).
- "There are many themes, but this one is yours", Maximilian Blazek, https://earendil.com/posts/system-theme/ (2026-10-09; fetched 2026-10-18).
- "Pi 1.0", Earendil, https://earendil.com/posts/pi-1-0/ (2026-10-01; fetched 2026-10-18).
- Upstream issue #8325 and PR #8326, "Add `disabledCommands` setting to block built-in slash commands", https://github.com/earendil-works/pi/issues/8325 (2026-08-18, auto-closed).
- ttyd: releases API (1.7.7, 2024-03-30); commits API (latest 2026-08-12); `html/package.json` at `1.7.7` and `main`; `html/src/components/terminal/xterm/index.ts` and `src/protocol.c` at `1.7.7` (fetched 2026-10-17).
- ttyd 1.7.7 built-in page (`ttyd --port …` output, 2026-10-17): OSC handlers 0,1,2,4,8,10–12,104,110–112,1337; no 52.
- npm: `@xterm/xterm` 6.0.0 (2025-12-22, beta 6.1.0-beta.315), `@xterm/addon-attach` 0.12.0, `addon-fit` 0.11.0, `addon-clipboard` 0.2.0, `addon-webgl` 0.19.0, `node-pty` 1.1.0 (2025-12-22), `ws` 8.22.0 (2026-09-26) (queried 2026-10-17).
- gotty: https://github.com/sorenisanerd/gotty v1.10.0 (2026-10-10); wetty: https://github.com/butlerx/wetty v4.0.1 (2026-10-14).
- Spike S5 outputs `spikes/s5-tui-branding/out/` and S9 screenshots `spikes/s9-web-terminal/out/` (2026-10-17).
- Base image check: `node:24-trixie-slim@sha256:8ec5…` has no nano/vi/ed/xdg-open/gh/rg/fd (2026-10-18).

## Unconfirmed
- **Clipboard in a real, focused browser.** An injected OSC 52 handler received the text, but `navigator.clipboard.writeText` was refused in the desktop app's pane (probably because the pane was not focused). Not tested in Chrome, Safari or Firefox.
- **Copy in the running MVP** (0.87.1): inferred broken from the same tmux and ttyd config; the live stack was not touched.
- **Cross-site WebSocket in other browsers.** Chromium blocked it before it reached ttyd; Firefox and Safari not tested.
- **`onTerminalInput` as a fallback block**: read in source, not run.
- **`setWorkingMessage` / `setHiddenThinkingLabel`** render: set but not seen, as no model ran.
- **Whether `-builtin:mcp` alone removes `/mcp`**: S5 also filtered and blocked it, so the setting's effect was not isolated (S3 covers MCP).
- **Making `/opt/pi-agent` read-only** to stop `/login` persisting credentials: not tried; Pi may need to write `settings.json`.
- **node-pty LOC estimate** is judgement; nothing was built.
- **gotty 1.10** auth-proxy header and OSC 52 support: not checked.
- **Blog content** came through a summarising fetch; the system-theme post did not cover pairs, `appearance` or tmux, so those come from the source and docs.
