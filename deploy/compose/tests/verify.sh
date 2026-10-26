#!/bin/sh
# Stack checks against a running `docker compose up` (run from deploy/compose):
# NFR-SEC-04 port bindings, NFR-SEC-01/02 sandbox isolation, NFR-SEC-08 the built-ins locked off, FR-UI-06
# the command allowlist in the real TUI, the Gaffer App's bridge (tests/app.mjs, M1.1-3), a live
# fpl_snapshot round trip with odds, the gaffer_lib golden path in the sandbox within NFR-LAT-03's 60 s,
# FR-DAT-09's fallback with the odds source down, ADR 0015's origin checks for the tunnel's host names, and (M4)
# a scripted model's recommendation through the submit gate: rejected, corrected, stored, exported and replayed.
# No LLM key is needed: the model is Pi's scripted faux provider.
# The live stack by default; another Compose project with its own file and host ports, for example:
#   GAFFER_PROJECT=gaffer-test GAFFER_PORT=17681 GAFFER_APP_PORT=17682 COMPOSE_FILE=docker-compose.yml:test.override.yml ./tests/verify.sh
set -eu
cd "$(dirname "$0")/.."
PROJECT="${GAFFER_PROJECT:-gaffer}"; PORT="${GAFFER_PORT:-7681}"; APP_PORT="${GAFFER_APP_PORT:-7682}"
dc() { docker compose -p "$PROJECT" "$@"; }

echo "== NFR-SEC-04: the web TUI and the Gaffer App published on 127.0.0.1 only ($PROJECT)"
bindings="$(docker inspect "$(dc ps -q gaffer)" --format '{{json .HostConfig.PortBindings}}')"
echo "$bindings"
[ "$bindings" = "{\"7681/tcp\":[{\"HostIp\":\"127.0.0.1\",\"HostPort\":\"$PORT\"}],\"7682/tcp\":[{\"HostIp\":\"127.0.0.1\",\"HostPort\":\"$APP_PORT\"}]}" ] || { echo "FAIL: unexpected port binding"; exit 1; }
[ "$(docker inspect "$(dc ps -q sandbox)" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] || { echo "FAIL: sandbox publishes ports"; exit 1; }
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")"
echo "GET http://127.0.0.1:$PORT/ -> $code"; [ "$code" = 200 ]
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/")"
echo "GET http://127.0.0.1:$APP_PORT/ (the App) -> $code"; [ "$code" = 200 ]

echo "== ADR 0015: the tunnel's host names accepted, every other origin refused"
# ttyd --check-origin: a WebSocket upgrade only when the Origin's host is the Host (through the tunnel, the terminal's
# name); a refused one gets no reply at all (curl: 000). A handshake alone: ttyd starts nothing until the page's first
# message. --max-clients 1: close any open browser terminal first, or the accepted case is refused too.
term_host="$(dc exec -T gaffer printenv GAFFER_PUBLIC_TERMINAL_HOST 2>/dev/null || true)"; term_host="${term_host:-term.example.test}"
ws() { curl -s -o /dev/null -w '%{http_code}' --max-time 3 --http1.1 -H "Host: $term_host" -H "Origin: $1" -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Protocol: tty' "http://127.0.0.1:$PORT/ws" || true; }
code="$(ws "https://$term_host")"; echo "ttyd upgrade, Host and Origin $term_host -> $code"; [ "$code" = 101 ] || { echo "FAIL: refused (is a browser terminal open? --max-clients 1)"; exit 1; }
for o in https://evil.example "https://$term_host.evil.example" "http://127.0.0.1:$PORT"; do
  code="$(ws "$o")"; echo "ttyd upgrade, Host $term_host, Origin $o -> $code (refused)"; [ "$code" = 000 ]
done
# gaffer-web: under GAFFER_PUBLIC_APP_HOST only from https://<it>; unset, that name is refused like any other.
app_host="$(dc exec -T gaffer printenv GAFFER_PUBLIC_APP_HOST 2>/dev/null || true)"
app() { curl -s -o /dev/null -w '%{http_code}' -H "Host: ${app_host:-gaffer.example.test}" -H "Origin: $1" "http://127.0.0.1:$APP_PORT/api/home"; }
if [ -n "$app_host" ]; then
  code="$(app "https://$app_host")"; echo "App, Host and Origin https://$app_host -> $code"; [ "$code" = 200 ]
  for o in "http://$app_host" https://evil.example "https://$app_host.evil.example"; do
    code="$(app "$o")"; echo "App, Host $app_host, Origin $o -> $code"; [ "$code" = 403 ]
  done
else
  code="$(app https://gaffer.example.test)"; echo "App, no public host set, Host gaffer.example.test -> $code"; [ "$code" = 421 ]
fi
# The connector, when on: no published port, and on the egress network only (never sandbox_net).
if [ -n "$(dc ps -q tunnel 2>/dev/null)" ]; then
  [ "$(docker inspect "$(dc ps -q tunnel)" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] || { echo "FAIL: tunnel publishes ports"; exit 1; }
  nets="$(docker inspect "$(dc ps -q tunnel)" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
  echo "tunnel networks: $nets"; [ "$nets" = "${PROJECT}_egress " ] || { echo "FAIL: tunnel networks"; exit 1; }
fi

echo "== NFR-SEC-01/02: sandbox isolation"
dc exec -T gaffer node --input-type=module - < tests/isolation.mjs

echo "== NFR-SEC-08: Pi's built-in MCP, codemode, tool search and llama.cpp locked off"
dc exec -T gaffer node --input-type=module - < tests/lockdown.mjs

echo "== FR-UI-06: only Gaffer's commands in the real TUI (tmux, 100 columns); the shortcuts do nothing"
dc exec -T gaffer node --input-type=module - < tests/commands.mjs

echo "== The Gaffer App's bridge: NFR-SEC-05/07 fuzz, a Recommend run with a scripted model (FR-UI-08/09/11), NFR-LAT-04, the locks (NFR-REL-03)"
dc exec -T -e TEAM_ID="${TEAM_ID:-1}" gaffer node --input-type=module - < tests/app.mjs

echo "== fpl_snapshot live round trip and the golden path in the sandbox (team ${TEAM_ID:-1})"
dc exec -T -e TEAM_ID="${TEAM_ID:-1}" gaffer node --input-type=module - < tests/live-snapshot.mjs

echo "== FR-DAT-09: the same with the odds source down"
# A fresh store under /data, so no cached odds can stand in; nothing listens on 127.0.0.1:9.
scratch="/data/verify-odds-down-$$"
status=0
out="$(dc exec -T -e TEAM_ID="${TEAM_ID:-1}" -e GAFFER_DATA_DIR="$scratch" -e FOOTBALL_DATA_BASE_URL=http://127.0.0.1:9/ \
  -e EXPECT='odds unavailable — team strength from Dixon-Coles \(football-data.co.uk unavailable' \
  gaffer node --input-type=module - < tests/live-snapshot.mjs 2>&1)" || status=$?
dc exec -T gaffer sh -c "chmod -R u+w '$scratch' 2>/dev/null; rm -rf '$scratch'"
# On failure, every invalid plan's validation errors first (the tail can miss them), then the tail.
[ "$status" = 0 ] || { echo "$out" | grep -E "^(invalid plan|Plan [0-9].*\\[INVALID)" || true; echo "$out" | tail -n 40; exit 1; }
echo "$out" | grep -E "^(Odds|- odds|football-data|--- odds|--- golden path)"

echo "== M4: submit_recommendation through the gate, /export-rec, replay, /prefs (team ${TEAM_ID:-1})"
# A scratch data dir under /data (the sandbox sees it at the same path), removed afterwards: the scripted
# model's recommendation is a test, so it must not reach the real ledger that gaffer-eval scores.
scratch="/data/verify-m4-$$"
status=0
out="$(dc exec -T -e TEAM_ID="${TEAM_ID:-1}" -e GAFFER_DATA_DIR="$scratch" gaffer node --input-type=module - < tests/recommend.mjs 2>&1)" || status=$?
if [ "$status" = 0 ]; then
  echo "$out" | grep -E "^(active tools|Solver:|--- /work/gaffer_lib|- \\[|rec_id|widest|validation:|chip scenarios:|/export-rec:|replay:|privacy:|skills offered:|M4 stack check passed)"
  # FR-OUT-01: the exported recommendation validates against the published JSON Schema with ajv (on the host).
  file="$(echo "$out" | sed -n 's/^EXPORT_FILE=//p')"
  dc exec -T gaffer cat "$file" > "${TMPDIR:-/tmp}/gaffer-verify-rec.json"
fi
dc exec -T gaffer sh -c "chmod -R u+w '$scratch' 2>/dev/null; rm -rf '$scratch'"
[ "$status" = 0 ] || { echo "$out" | tail -n 60; exit 1; }
(cd ../../packages/pi-gaffer && node scripts/check-schema.ts "${TMPDIR:-/tmp}/gaffer-verify-rec.json")


echo "== M5: gaffer admin, gaffer-eval (one-shot) and the privacy of everything they write"
dc exec -T gaffer node --input-type=module - < tests/m5.mjs
