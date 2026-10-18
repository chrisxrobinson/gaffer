#!/bin/sh
# M1.1-0 copy of deploy/compose/tests/verify.sh, pointed at the gaffer-m110 project (port 17682). Generated with sed (see BUILD.md M1.1-0).
# Stack checks against a running `dc_m110 up` (docker compose -p gaffer-m110 …) (run from deploy/compose):
# NFR-SEC-04 port binding, NFR-SEC-01/02 sandbox isolation, a live fpl_snapshot round trip with odds, the
# gaffer_lib golden path in the sandbox within NFR-LAT-03's 60 s, FR-DAT-09's fallback with the odds
# source down, and (M4) a scripted model's recommendation through the submit gate: rejected, corrected,
# stored, exported and replayed. No LLM key is needed: the model is Pi's scripted faux provider.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE/.."
dc_m110() { docker compose -p gaffer-m110 -f "$HERE/docker-compose.m110.yml" "$@"; }

echo "== NFR-SEC-04: web TUI published on 127.0.0.1 only"
bindings="$(docker inspect "$(dc_m110 ps -q gaffer)" --format '{{json .HostConfig.PortBindings}}')"
echo "$bindings"
[ "$bindings" = '{"7681/tcp":[{"HostIp":"127.0.0.1","HostPort":"17682"}]}' ] || { echo "FAIL: unexpected port binding"; exit 1; }
[ "$(docker inspect "$(dc_m110 ps -q sandbox)" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] || { echo "FAIL: sandbox publishes ports"; exit 1; }
code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:17682/)"
echo "GET http://127.0.0.1:17682/ -> $code"; [ "$code" = 200 ]

echo "== NFR-SEC-01/02: sandbox isolation"
dc_m110 exec -T gaffer node --input-type=module - < tests/isolation.mjs

echo "== fpl_snapshot live round trip and the golden path in the sandbox (team ${TEAM_ID:-1})"
dc_m110 exec -T -e TEAM_ID="${TEAM_ID:-1}" gaffer node --input-type=module - < tests/live-snapshot.mjs

echo "== FR-DAT-09: the same with the odds source down"
# A fresh store under /data, so no cached odds can stand in; nothing listens on 127.0.0.1:9.
scratch="/data/verify-odds-down-$$"
status=0
out="$(dc_m110 exec -T -e TEAM_ID="${TEAM_ID:-1}" -e GAFFER_DATA_DIR="$scratch" -e FOOTBALL_DATA_BASE_URL=http://127.0.0.1:9/ \
  -e EXPECT='odds unavailable — team strength from Dixon-Coles \(football-data.co.uk unavailable' \
  gaffer node --input-type=module - < tests/live-snapshot.mjs 2>&1)" || status=$?
dc_m110 exec -T gaffer sh -c "chmod -R u+w '$scratch' 2>/dev/null; rm -rf '$scratch'"
[ "$status" = 0 ] || { echo "$out" | tail -n 40; exit 1; }
echo "$out" | grep -E "^(Odds|- odds|football-data|--- odds|--- golden path)"

echo "== M4: submit_recommendation through the gate, /export-rec, replay, /prefs (team ${TEAM_ID:-1})"
# A scratch data dir under /data (the sandbox sees it at the same path), removed afterwards: the scripted
# model's recommendation is a test, so it must not reach the real ledger that gaffer-eval scores.
scratch="/data/verify-m4-$$"
status=0
out="$(dc_m110 exec -T -e TEAM_ID="${TEAM_ID:-1}" -e GAFFER_DATA_DIR="$scratch" gaffer node --input-type=module - < tests/recommend.mjs 2>&1)" || status=$?
if [ "$status" = 0 ]; then
  echo "$out" | grep -E "^(active tools|Solver:|--- /work/gaffer_lib|- \\[|rec_id|widest|validation:|chip scenarios:|/export-rec:|replay:|privacy:|skills offered:|M4 stack check passed)"
  # FR-OUT-01: the exported recommendation validates against the published JSON Schema with ajv (on the host).
  file="$(echo "$out" | sed -n 's/^EXPORT_FILE=//p')"
  dc_m110 exec -T gaffer cat "$file" > "${TMPDIR:-/tmp}/gaffer-verify-rec.json"
fi
dc_m110 exec -T gaffer sh -c "chmod -R u+w '$scratch' 2>/dev/null; rm -rf '$scratch'"
[ "$status" = 0 ] || { echo "$out" | tail -n 60; exit 1; }
(cd ../../packages/pi-gaffer && node scripts/check-schema.ts "${TMPDIR:-/tmp}/gaffer-verify-rec.json")


echo "== M5: gaffer admin, gaffer-eval (one-shot) and the privacy of everything they write"
dc_m110 exec -T gaffer node --input-type=module - < tests/m5.mjs
