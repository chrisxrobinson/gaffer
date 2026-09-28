#!/bin/sh
# Harness entrypoint: load secrets for Pi, then serve the Pi TUI in the browser via ttyd → tmux.
set -eu

# Compose `secrets:` files → env for Pi (the LLM key stays in this container; sandboxd never inherits it).
if [ -s /run/secrets/anthropic_api_key ]; then
  ANTHROPIC_API_KEY="$(cat /run/secrets/anthropic_api_key)"; export ANTHROPIC_API_KEY
fi

# Bind ttyd only to the interface with the default route (the egress network, where Docker publishes
# the port). Never to the internal sandbox network: sandbox code must not be able to drive the TUI.
BIND_IP="$(node /opt/gaffer/egress-ip.mjs)"

exec ttyd --interface "$BIND_IP" --port 7681 --writable --max-clients 1 \
  --index /opt/gaffer/ttyd-index.html \
  -t titleFixed=Gaffer -t fontSize=15 -t disableLeaveAlert=true \
  tmux -f /opt/gaffer/tmux.conf new-session -A -s gaffer /opt/gaffer/gaffer-pi
