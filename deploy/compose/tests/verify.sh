#!/bin/sh
# Stack checks against a running `docker compose up` (run from deploy/compose):
# NFR-SEC-04 port binding, NFR-SEC-01/02 sandbox isolation, a live fpl_snapshot round trip with odds, the
# gaffer_lib golden path in the sandbox within NFR-LAT-03's 60 s, and FR-DAT-09's fallback with the odds
# source down.
set -eu
cd "$(dirname "$0")/.."

echo "== NFR-SEC-04: web TUI published on 127.0.0.1 only"
bindings="$(docker inspect "$(docker compose ps -q gaffer)" --format '{{json .HostConfig.PortBindings}}')"
echo "$bindings"
[ "$bindings" = '{"7681/tcp":[{"HostIp":"127.0.0.1","HostPort":"7681"}]}' ] || { echo "FAIL: unexpected port binding"; exit 1; }
[ "$(docker inspect "$(docker compose ps -q sandbox)" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] || { echo "FAIL: sandbox publishes ports"; exit 1; }
code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7681/)"
echo "GET http://127.0.0.1:7681/ -> $code"; [ "$code" = 200 ]

echo "== NFR-SEC-01/02: sandbox isolation"
docker compose exec -T gaffer node --input-type=module - < tests/isolation.mjs

echo "== fpl_snapshot live round trip and the golden path in the sandbox (team ${TEAM_ID:-1})"
docker compose exec -T -e TEAM_ID="${TEAM_ID:-1}" gaffer node --input-type=module - < tests/live-snapshot.mjs

echo "== FR-DAT-09: the same with the odds source down"
# A fresh store under /data, so no cached odds can stand in; nothing listens on 127.0.0.1:9.
scratch="/data/verify-odds-down-$$"
status=0
out="$(docker compose exec -T -e TEAM_ID="${TEAM_ID:-1}" -e GAFFER_DATA_DIR="$scratch" -e FOOTBALL_DATA_BASE_URL=http://127.0.0.1:9/ \
  -e EXPECT='odds unavailable — team strength from Dixon-Coles \(football-data.co.uk unavailable' \
  gaffer node --input-type=module - < tests/live-snapshot.mjs 2>&1)" || status=$?
docker compose exec -T gaffer sh -c "chmod -R u+w '$scratch' 2>/dev/null; rm -rf '$scratch'"
[ "$status" = 0 ] || { echo "$out" | tail -n 40; exit 1; }
echo "$out" | grep -E "^(Odds|- odds|football-data|--- odds|--- golden path)"
