# Spike S5 — Can a Pi 1.3.0 extension brand the TUI as Gaffer without patching Pi?

**Date:** 2026-10-17 · **Pi:** `@earendil-works/pi-coding-agent@1.3.0` (installed in the image from `package-lock.json`) · **tmux:** 3.5a (Debian trixie, as in the harness) · **Result: YES, with one undocumented hook** (the slash-command block)

## Question
Can one extension plus a theme file make the Pi 1.3.0 TUI look like Gaffer: a Gaffer wordmark instead of Pi's header, a live status strip (team, GW, deadline countdown, FTs, bank, budget), the tab title, a brand theme in light and dark, and only Gaffer's slash commands, without patching Pi?

## Method
- `extension/gaffer-brand.ts` (one file, ~190 lines):
  - `ctx.ui.setHeader()` with a placeholder 5-line block-letter wordmark (falls back to one word under 52 columns);
  - `ctx.ui.setFooter()` with a one-line strip of fake data; a 1 s `setInterval` calls `tui.requestRender()` so the countdown ticks;
  - `ctx.ui.setTitle()`, re-applied 50 ms later because Pi resets the title after `session_start`;
  - `ctx.ui.addAutocompleteProvider()` that drops blocked commands, `/skill:*`, `@file` and Tab path completion;
  - `ctx.ui.setEditorComponent()` with a `CustomEditor` subclass whose `onSubmit` is an accessor: Pi assigns its own submit handler to the custom editor (`interactive-mode.ts:2889 @v1.3.0`), the setter wraps it, and blocked commands never reach Pi's built-in dispatch (`interactive-mode.ts:3202-3345`);
  - probes: an `input` handler that logs what it sees, and an extension command named `share`.
- `agent/settings.gaffer.json`: `quietStartup: true`, `doubleEscapeAction: "none"`, `enableSkillCommands: false`, `sessionShareDestination: "gist"`, `externalEditor: "/bin/false"`, `extensions: ["-builtin:mcp", "-builtin:llama.cpp", "-builtin:codemode", "-builtin:tool-search"]`.
- `agent/keybindings.json`: unbinds model select/cycle, thinking cycle, external editor, suspend and the session actions.
- `themes/`: `gaffer.json` (Gaffer's current theme, unchanged), `gaffer-dark.json` (the same colours, `appearance: "dark"`), `gaffer-light.json` (new, written in `oklch()`, `appearance: "light"`).
- `run-s5.sh` runs inside the container: the real `pi` CLI in a detached 100×40 tmux pane (the harness's `tmux.conf`), driven with `tmux send-keys`, captured with `tmux capture-pane -e -p` (ANSI) and `-p` (plain) into `out/`. A temp `PI_CODING_AGENT_DIR` per run; `PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1`; the container runs with `--network none` and a fake key, so no model call can leave it.
- Runs: (1) **baseline**: stock Pi, no extension, default settings; (2) **gaffer**: extension + settings + keybindings, every built-in command typed and submitted, plus the shortcuts; (3) **themes**: theme unset (system), `gaffer`, and the pair `gaffer-light/gaffer-dark`, each on a dark and a light terminal (tmux `window-style` sets the background tmux reports to Pi's OSC 11 query).

## Re-run
```sh
cd spikes/s5-tui-branding
docker build -t gaffer-spike-s5:latest .
rm -rf out && mkdir out && chmod 777 out
docker run --rm --name gaffer-spike-s5 --network none -v "$PWD/out:/spike/out" gaffer-spike-s5:latest   # ~3 min
docker image rm gaffer-spike-s5:latest
```

## Result

| Check | Mechanism | Observed (`out/`) |
|---|---|---|
| Header replaced by a wordmark | `setHeader` + `quietStartup: true` | Wordmark and tagline; no Pi logo, version, key hints or `[Prompts]` listing (`gaffer-start.txt`). Baseline shows Pi's logo, `v1.3.0` and hints (`baseline-start.txt`). |
| Live status strip | `setFooter` + 1 s `requestRender` | `Deadline 2d 03:11:56` → `2d 03:11:54` two seconds later (`gaffer-start.txt`, `gaffer-start-2s.txt`). Pi's footer (cwd, tokens, cost, context, model) is gone: Gaffer must redraw what it wants from it. |
| Tab title | `setTitle` + re-apply on the next tick | `#{pane_title}` = `Gaffer · GW8`; baseline `π - work` (`titles.txt`) |
| Only Gaffer's commands in `/` | `addAutocompleteProvider` | Menu = `copy, hotkeys, new` + `explain, gw, whatif` + `team, prefs, export-rec, usage, scorecard` (`gaffer-slash-menu.txt`). Baseline lists 29 (24 built-ins, `/mcp`, `/llama`, 3 templates) (`baseline-slash-menu.txt`). |
| Built-in commands blocked | `CustomEditor` `onSubmit` wrapper | All 29 blocked names (incl. hidden `/debug`, `/arminsayshi`, `/dementedelves`, and `/mcp`, `/llama`, `/skill:*`, `/model claude-opus`) show "`/x isn't available in Gaffer`" and do nothing (`gaffer.log`, `gaffer-_<cmd>_-after.txt`). `/quit` blocked: Pi still running. `/team 1234567` still works. |
| `input` event sees built-ins? | probe | **No.** Only `@` (a plain message) reached `input`; no built-in did (`gaffer.log`). Built-ins are dispatched before `session.prompt()`. |
| Extension command named `share` | probe | Pi reports "conflicts with built-in interactive command. Skipping in autocomplete." and the built-in wins. Not a way to override. |
| Shortcuts | `keybindings.json` `[]` + `doubleEscapeAction: "none"` | Ctrl+L, Ctrl+P, Shift+Tab, Ctrl+G, Ctrl+Z, Esc Esc: nothing happens (`gaffer-key-*.txt`). Baseline: Ctrl+L opens the model selector, Esc Esc opens the tree (`baseline-key-*.txt`). |
| Branding survives `/new` | re-apply in `session_start` (`reason=new`) | Wordmark, strip and editor back after `/new` (`gaffer-_new_-after.txt`, `gaffer.log`). |
| Theme `gaffer` (unchanged file) under 1.3.0 validation | settings `theme: "gaffer"` | Loads (`theme=gaffer`); no validation error. On a **light** terminal it stays dark-designed: text `#e8e8e3` on a light background. |
| No theme setting | default | `system` theme: Pi's violet accent derived from the terminal, not Gaffer's colours (`theme-system-*.ansi`). |
| Light/dark pair | `theme: "gaffer-light/gaffer-dark"` | Dark terminal → `gaffer-dark`; light terminal → `gaffer-light`, `oklch()` resolved to truecolor (`theme-pair-*.log`, `.ansi`). |

Also seen: `Warning: fd not found` / `ripgrep not found. Offline mode enabled` print under the header even with `quietStartup: true` (also true at 0.87.1); `/hotkeys` lists unbound actions with empty keys and "`!` Run bash command".

## Impact on the design
- Gaffer can be branded from an extension on Pi 1.3.0 (and on 0.87.1: every UI method used exists there, `extensions/types.ts:151-281 @v0.87.1`), with no Pi patch.
- **There is no supported way to remove or disable a built-in slash command.** `BUILTIN_SLASH_COMMANDS` is a hard-coded list (`core/slash-commands.ts:19-44 @v1.3.0`), dispatched in the editor's submit handler before extensions see input. The working block relies on Pi copying `onSubmit` onto a custom editor, which is behaviour, not a documented contract. Keep `run-s5.sh` (or a port of it) as a regression test on every Pi upgrade.
- Use an allowlist, not a blocklist, in the wrapper, so built-ins added by a later Pi are blocked by default.
- Ship the theme as a light/dark pair and pin the browser terminal's palette (ttyd `-t theme=`) so Pi picks the dark one.
- Replace `/hotkeys` with a Gaffer `/help`; install `ripgrep` and `fd-find` in the harness or accept the two warnings.
