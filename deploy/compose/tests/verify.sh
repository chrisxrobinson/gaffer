#!/bin/sh
# Stack checks against a running `docker compose up` (run from deploy/compose):
# NFR-SEC-04 port binding, NFR-SEC-01/02 sandbox isolation, and a live fpl_snapshot round trip.
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

echo "== fpl_snapshot live round trip (team ${TEAM_ID:-1})"
docker compose exec -T -e TEAM_ID="${TEAM_ID:-1}" gaffer node --input-type=module - < tests/live-snapshot.mjs
