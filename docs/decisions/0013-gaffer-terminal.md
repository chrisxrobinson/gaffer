# ADR 0013 — Gaffer Terminal: Gaffer's identity and command surface on the Pi TUI

**Status:** Accepted · **Date:** 2026-10-17 · **Amends:** [ADR 0005](0005-web-tui.md) (MVP hardening), ARCHITECTURE §1.4 ("kept unchanged" list) · **Evidence:** [research 10](../research/10-tui-themes-branding.md), [spike S5](../../spikes/s5-tui-branding/README.md), [spike S9](../../spikes/s9-web-terminal/README.md), [docs/ui §3](../ui/README.md#3-gaffer-terminal-ui-1) · **Requirements:** FR-UI-05, -06, -07, NFR-SEC-04, -09 · **Egress line implemented by** [ADR 0017](0017-egress-allowlist.md) (2026-10-23)

## Context
The browser terminal is the Pi CLI with a Gaffer theme: Pi's logo and key hints at start-up, a footer with the cwd (`/work`) and token counters, and Pi's 24 built-in slash commands (plus `/mcp` and `/llama` from built-in extensions on 1.x). Phase 0 kept the session tree, `/resume`, model switching and keybindings "unchanged, as the point of the experiment" (ARCHITECTURE §1.4). The brief now wants it to feel like Gaffer: a wordmark instead of Pi's header, a status strip, only Gaffer's commands, and no loss in how reasoning, tools and the recommendation render.

Research 10 and spikes S5 (real Pi 1.3.0 in a 100×40 tmux pane) and S9 (ttyd 1.7.7 + tmux in a browser) found:
- **Branding needs no Pi patch.** `ctx.ui.setHeader()` with `quietStartup: true` replaces the header with no flash of Pi's logo; `setFooter()` with its own one-second timer gives a ticking strip; `setTitle()` works but Pi resets it after `session_start`, so it is re-applied there. All of these exist at 0.87.1 too.
- **Themes:** `theme: "gaffer"` in settings wins over the `system` theme (which only applies when no theme is set). Today's `gaffer.json` passes 1.3.0's stricter validation but has unreadable regions on a light terminal. A `gaffer-light`/`gaffer-dark` pair switches correctly from the background colour the terminal reports, and ttyd's `-t theme=` palette reaches Pi through tmux.
- **There is no supported way to remove a built-in slash command.** The 24 are a hard-coded list (`core/slash-commands.ts:19-44 @v1.3.0`), matched in the editor's submit handler before an extension's `input` event can see them (`interactive-mode.ts:3202-3345`); an extension command with a built-in's name loses. An upstream `disabledCommands` proposal (#8325, 2026-08-18) was closed unmerged. What works: `addAutocompleteProvider` (supported) hides them from the `/` list, and a `CustomEditor` set with `setEditorComponent` can wrap the submit handler, because Pi assigns `newEditor.onSubmit = this.defaultEditor.onSubmit` (`interactive-mode.ts:2889`). That assignment is undocumented behaviour; S5 proved it refuses all 29 commands (24 listed, 3 hidden, `/mcp`, `/llama`), `/skill:*` and `/model <arg>`. Shortcuts that reach the same actions are closed with supported config: `keybindings.json` entries set to `[]` and `doubleEscapeAction: "none"` (S5: Ctrl+L, Ctrl+P, Shift+Tab, Ctrl+G, Ctrl+Z, Esc Esc dead).
- **What the dangerous commands do:** `/share` publishes the session (to Radius with an OAuth token, else a GitHub gist via `gh`); `/bug` uploads diagnostics; `/login` creates provider credentials (and Radius sign-in offers to write an MCP server into `mcp.json`); `/export` and `/import` write and read any path the harness user can; `/model` and `/thinking` bypass ADR 0008; the `/resume` selector's Ctrl+D deletes session files; Ctrl+G opens `$EDITOR` in the harness (latent: the image has none). Most are reachable in today's 0.87.1 MVP as well.
- **The guarantees that matter rest on supported controls,** not on the hook:
  - `/share`: with the documented `sessionShareDestination: "gist"`, Pi never contacts Radius and needs the `gh` CLI (`modes/interactive/session-share.ts:68-85 @v1.3.0`), which the image doesn't have and nobody can install without a shell.
  - `/bug`: `PI_OFFLINE=1` (already set) refuses the upload (`bug-report.ts:56`).
  - MCP via `/login radius`: `--no-mcp` (ADR 0012).
  - The user shell: `user_bash` (fail-closed since 0.86.0).
  The brief's stop condition ("no supported way to stop `/share` … reaching the harness") is therefore not met; the hook is defence in depth and UX.
- **The web terminal:** fullscreen, wheel scrolling, Shift+Enter, Ctrl+C, the wordmark and the strip work through ttyd 1.7.7 and tmux. **Copy is silently broken today** (tmux drops Pi's OSC 52 and ttyd 1.7.7 has no handler), ttyd's page has no viewport tag, and the harness runs ttyd without `--check-origin` although ADR 0005 and research 05 recommended it. ttyd's last release is 2024-03; a node-pty + xterm.js 6 server would be about 250 lines with a native dependency.

## Options considered
1. **Leave the Pi TUI as it is** (ADR 0005's MVP). Fails the brief's identity goal and leaves `/model`, `/export`, `/import` and `/resume`-delete reachable. Rejected.
2. **Fork or patch Pi's TUI** to drop the built-ins. Breaks NFR-MNT-01 and the thesis. Rejected.
3. **One more extension plus settings and keybindings**, with an allowlist enforced twice (autocomplete and submit) and the security-relevant commands neutralised by supported settings as well. **Chosen.**
4. **Replace ttyd now** with a node-pty server. About 250 lines and a native dependency for gains (xterm.js 6, OSC 52) that ten lines of page script and config also deliver. Deferred to the Phase 3 bridge.

## Decision
**Identity** (a `gaffer-ui` module in `gaffer-core`, re-applied on every `session_start`):
- Header: Gaffer's mark and three-row ASCII wordmark with a tagline ([docs/ui §2](../ui/README.md#2-branding)); `quietStartup: true`.
- Footer: two lines. Line 1, the status strip: team, GW and live deadline countdown, FT (and whether derived), bank. Line 2: today's and this session's spend against the caps, and the model. Refreshed every second and on `turn_end` and `tool_execution_end`.
- Title: "Gaffer · GW8 · 6d" (re-set after `session_start`); ttyd keeps `titleFixed` (S9: a dynamic title shows the container id).
- Themes: ship `gaffer-dark` (today's colours, renamed) and `gaffer-light`, selected as a pair; give ttyd the matching xterm.js palette from [`docs/ui/brand/tokens.json`](../ui/brand/tokens.json).

**Command surface** (FR-UI-06): an **allowlist**, so built-ins added by later Pi versions are refused by default.

| Keep | Why |
|---|---|
| `/gw`, `/whatif`, `/explain` (and `/chips` once M1.1-4 adds it) | Gaffer's templates |
| `/team`, `/prefs`, `/scorecard`, `/usage`, `/export-rec` | Gaffer's commands |
| `/new` | start a fresh session |
| `/resume` | open a session started in the Gaffer App (FR-UI-12), with the selector's delete and rename keys unbound |
| `/copy` | copy the last answer, once OSC 52 works |
| `/help` (new, Gaffer's) | what Gaffer can do and how to ask |

Everything else is hidden from `/` and refused with one line saying why (for example "/share is not available in Gaffer: sessions stay on this machine"). Mechanism: `addAutocompleteProvider` to hide; a `CustomEditor` wrapping `onSubmit` to refuse. Because the second relies on undocumented behaviour, S5's run script becomes a regression test in the upgrade gate (ADR 0009).

**Settings and keybindings shipped in the image:** `sessionShareDestination: "gist"`, `quietStartup: true`, `doubleEscapeAction: "none"`, `enableSkillCommands: false`, `externalEditor: "/bin/false"`, `theme` pair, the `-builtin:` entries (ADR 0012); the autocomplete provider also returns nothing for `@file` and Tab path completion, which would otherwise list the harness filesystem; `keybindings.json` unbinds model cycling and selection, thinking-level cycling, the external editor, suspend, tree and fork, and `app.session.delete`, `deleteNoninvasive` and `rename`. `PI_OFFLINE=1` stays.

**Web terminal fixes** (about 10 lines): an OSC 52 → `navigator.clipboard` handler and a viewport tag in the page Gaffer already injects into ttyd; tmux `set-clipboard on`; ttyd `--check-origin`. ttyd stays for UI 1; a node-pty server is reconsidered with the Phase 3 bridge.

**Egress:** Phase 2's harness egress allowlist (ADR 0006's "optional allowlist later") becomes required: LLM provider, FPL, football-data. It is the only hard guarantee against future Pi features that reach out.

## Consequences
- ARCHITECTURE §1.4 changes: model switching, thinking levels, the session tree, `/fork`, `/compact`, `/export`, `/import`, `/settings`, `/login` and keybinding changes are no longer "kept unchanged". **For the theory:** Gaffer still uses Pi's loop, sessions and package system unchanged, but the *interactive surface* had to be narrowed, and Pi offers no supported switch for it. The thesis survives with one caveat recorded here: a domain agent on Pi has to own its command surface through an undocumented seam.
- The undocumented `onSubmit` seam is a maintenance risk; the regression test catches a change, and the supported controls keep the security guarantees if the seam breaks (the commands would then run, but `/share`, `/bug` and MCP still couldn't publish or connect).
- Copy works in the browser for the first time.
- The `/` list is short enough to read at a glance, and the mockup ([`docs/ui/mockups/terminal.html`](../ui/mockups/terminal.html)) shows it.
