# Spike S9 — Does Pi 1.3.0 fullscreen work through ttyd 1.7.7 + tmux in a browser, and is a node-pty + xterm.js server worth replacing ttyd?

**Date:** 2026-10-17 · **Pi:** 1.3.0 · **ttyd:** 1.7.7 (static binary, sha256-checked as in `harness/Dockerfile`) · **tmux:** 3.5a · **Browser:** the Claude desktop app's built-in Chromium pane · **Result: works, with two gaps (clipboard, mobile) and one title quirk; replacing ttyd is not worth it yet**

## Question
Does Pi 1.3.0's fullscreen TUI (with the S5 branding extension) work through ttyd 1.7.7 → tmux → Pi in a browser: wheel scrolling, selection and copy (OSC 52), Shift+Enter, Ctrl+C, the tab title, hyperlinks (OSC 8), OSC 7501, a 375 px phone viewport? And is a small node-pty + `@xterm/xterm` 6 server worth the code?

## Method
- Image `gaffer-spike-s9` = the S5 image (Pi 1.3.0, tmux, branding extension, themes) + ttyd 1.7.7 + `ttyd-keys.js` (the harness's Shift+Enter handler injected into ttyd's page, same build step as the harness).
- ttyd flags as `harness/entrypoint.sh`, except: port 27681 (published on host `127.0.0.1` only), no `titleFixed` (to see whether Pi's title reaches the tab), and `-t theme={"background":"#121a15",...}`.
- `tmux.conf` = the harness file plus `set-titles on`, `set-clipboard on`, and `terminal-features xterm-256color:clipboard:hyperlinks:title`. Toggled `set-clipboard external` (the tmux default, i.e. what the harness has) at run time to compare.
- `run-pi.sh` = `harness/gaffer-pi` with a temp agent dir, the S5 settings/keybindings, theme pair `gaffer-light/gaffer-dark`, no API key. `fill-extension.ts` adds `/fill`, which puts ~90 lines of recommendation-shaped markdown (a 15-row table, a link) into the transcript without a model call.
- Drove http://127.0.0.1:27681 with the browser tools at exactly 100 columns (`window.term.cols === 100`), hooking `term.parser.registerOscHandler` and `term.onData` to see what crossed the wire.

## Re-run
```sh
(cd ../s5-tui-branding && docker build -t gaffer-spike-s5:latest .)
docker build -t gaffer-spike-s9:latest .
docker run -d --rm --name gaffer-spike-s9 -e LANG=C.UTF-8 -p 127.0.0.1:27681:27681 gaffer-spike-s9:latest
# open http://127.0.0.1:27681, resize to 100 columns, type /fill
docker stop gaffer-spike-s9 && docker image rm gaffer-spike-s9:latest gaffer-spike-s5:latest
```

## Result

| Check | Observed |
|---|---|
| Fullscreen render, wordmark, strip, theme | Works (`out/s9-100col-fill-top.jpg`). The pair resolved to `gaffer-dark`: ttyd's background → tmux → Pi's OSC 11 query. |
| UTF-8 | **Without `LANG=C.UTF-8` in ttyd's environment the wordmark and `£` render as `_`** (tmux decides UTF-8 from the client's locale; `out/s9-no-utf8-locale.jpg`). The harness sets `LANG`, so production is fine; keep it. |
| Wheel scroll | Works: xterm.js sends SGR wheel events (`ESC[<64;…M`) through tmux; Pi scrolls its transcript and shows "↓ Jump to latest message". |
| Selection + copy | Pi owns selection in fullscreen: drag → Pi flashes **"Copied!"** and emits OSC 52. With `set-clipboard on` the OSC 52 reaches xterm.js; with tmux's default `external` (the harness) it does not. **ttyd 1.7.7 has no OSC 52 handler** (no clipboard addon in its bundle), so the browser clipboard is never written either way: "Copied!" is false. A handler injected like `ttyd-keys.js` received the text, but `navigator.clipboard.writeText` was refused ("Write permission denied") in this pane. |
| Shift+Enter | Works: the injected handler sends `ESC[13;2u`, the editor shows two lines. |
| Ctrl+C | Clears the editor (`\x03`), via a dispatched keydown; the pane's automation swallows a literal Ctrl+C (as noted in BUILD.md M1). |
| Tab title | Pi's title reaches the tab only with tmux `set-titles on`, and ttyd 1.7.7 then shows `Gaffer · GW8 \| tmux -f … new-session -A -s s9 /spike/s9/run-pi.sh (<container id>)` (ttyd appends its command and hostname, `html/src/components/terminal/xterm/index.ts:170-172 @1.7.7`). Keep `titleFixed=Gaffer`. |
| OSC 8 hyperlinks | Pi emits them and they reach xterm.js, but a click goes to Pi as a mouse event (`ESC[<0;31;9M`), not to the browser; Pi then runs `openBrowser()` → `xdg-open` **inside the container** (absent, so nothing happens). Links are not clickable in Gaffer Terminal. |
| OSC 7501 | Never emitted: Pi only reports program status when the terminal answers its query (`tui/src/terminal.ts:286-298 @v1.3.0`); tmux/xterm.js don't. |
| Kitty keyboard / images | Not available: ttyd's xterm.js is 5.x (has `CanvasAddon`, no kitty flags); tmux has no kitty graphics. Pi falls back to modifyOtherKeys; Gaffer draws no images. |
| 375 px viewport | ttyd 1.7.7's page has **no viewport meta tag**: a phone lays it out at 980 px → 106×106 tiny cells. With the tag added (as ttyd `main` did on 2026-08-12, unreleased) it is 38 columns: the header falls back to one word, the strip is cut after "D…" (`out/s9-375px-38col.jpg`). |
| Cross-site WebSocket | From `https://example.com` and from an `http://` site, `new WebSocket("ws://127.0.0.1:27681/ws")` failed in the browser (never reached ttyd). The browser blocked it, not ttyd: the harness runs without `--check-origin`. Other browsers not tested. |

## Alternative: node-pty + @xterm/xterm 6
Not built (estimate is over 100 lines). Estimate: server ≈ 120–150 LOC (static files, WebSocket upgrade with auth-header and Origin check, one client, `node-pty` spawning only `tmux new -A -s gaffer /opt/gaffer/gaffer-pi`, resize messages, bind to the egress IP), page ≈ 80–100 LOC (xterm + fit + clipboard + webgl, Shift+Enter, title, reconnect, viewport meta). Dependencies: `node-pty` 1.1.0 (native addon: prebuild or node-gyp toolchain), `ws` 8.22.0, `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, `@xterm/addon-clipboard` 0.2.0, optional `@xterm/addon-webgl` 0.19.0. It would fix the clipboard, viewport and title and give an auth-header check in our own code, but it is ~250 lines of security-relevant code we would own, plus a native build. The same fixes cost ~10 lines on ttyd 1.7.7 (an OSC 52 handler and a viewport tag in the injected page, `set-clipboard on`, `--check-origin`). Revisit if ttyd stays unreleased past the cloud phase or when the multi-user bridge (ADR 0005, phase 3) needs node anyway; `sorenisanerd/gotty` v1.10.0 (2026-10-10, xterm 6.0) is the maintained drop-in to evaluate first.

## Impact on the design
- Keep ttyd 1.7.7 for UI 1, with: `--check-origin`, `titleFixed=Gaffer`, a ttyd `theme` matching the Gaffer dark theme, an OSC 52 → `navigator.clipboard` handler and a viewport meta tag added to the injected page, and tmux `set-clipboard on`. Verify the clipboard by hand in Chrome, Safari and Firefox.
- Phone use stays poor (38 columns, no Esc/Ctrl keys): a status strip that wraps to two lines below ~60 columns, and the RPC "Gaffer App" for mobile.
