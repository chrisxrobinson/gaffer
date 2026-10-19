#!/bin/sh
# Harness entrypoint: load secrets for Pi, then serve the Gaffer App (gaffer-web) and the Pi TUI in the browser
# via ttyd → tmux.
set -eu

# Compose `secrets:` files → env for Pi (the LLM key stays in this container; sandboxd never inherits it).
if [ -s /run/secrets/anthropic_api_key ]; then
  ANTHROPIC_API_KEY="$(cat /run/secrets/anthropic_api_key)"; export ANTHROPIC_API_KEY
fi

# Bind ttyd and gaffer-web only to the interface with the default route (the egress network, where Docker
# publishes the ports). Never to the internal sandbox network: sandbox code must not be able to drive either UI.
# --check-origin: refuse a WebSocket whose Origin isn't the page's own host (ADR 0005, ADR 0013).
BIND_IP="$(node /opt/gaffer/egress-ip.mjs)"

# Gaffer's xterm.js palette from docs/ui/brand/tokens.json (dark unless GAFFER_TERMINAL_THEME=light). Pi asks
# the terminal for its background through tmux and picks gaffer-dark or gaffer-light to match (ADR 0013).
case "${GAFFER_TERMINAL_THEME:-dark}" in light) PALETTE=light ;; *) PALETTE=dark ;; esac
THEME="$(node -e 'process.stdout.write(JSON.stringify(require("/opt/gaffer/tokens.json").terminal[process.argv[1]]))' "$PALETTE")"

# The Gaffer App's bridge (ADR 0014), bound the same way on 7682, and started again if it exits. Its Pi processes
# use the same launcher, flags and locks as the terminal (gaffer-pi --mode rpc).
(
  while :; do
    node /opt/packages/gaffer-web/server.ts --host "$BIND_IP" --port 7682 || true
    echo "gaffer-web exited; restarting in 2 s" >&2
    sleep 2
  done
) &

exec ttyd --interface "$BIND_IP" --port 7681 --writable --max-clients 1 --check-origin \
  --index /opt/gaffer/ttyd-index.html \
  -t titleFixed=Gaffer -t fontSize=15 -t disableLeaveAlert=true -t scrollback=10000 -t "theme=$THEME" \
  tmux -f /opt/gaffer/tmux.conf new-session -A -s gaffer /opt/gaffer/gaffer-pi
