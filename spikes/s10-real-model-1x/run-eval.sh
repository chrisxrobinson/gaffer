#!/bin/sh
# Spike S10: the eval runner on Pi 1.3.0 with a real model and Pi's own catalogue entry for the model.
#   ./run-eval.sh <model> <label> [comma-separated case ids]
# e.g. ./run-eval.sh anthropic/claude-sonnet-5-5 sonnet-catalogue l6-a-injured-captain,l6-d-injection
#      ./run-eval.sh anthropic/claude-haiku-5-5 haiku
# The runner uses the INSTALLED package (as the image does), but with its own agent dir: a settings.json
# naming the package by absolute path (/opt/pi-gaffer) and no models.json, so the model resolves from
# Pi 1.3.0's catalogue: the configuration milestone M1.1-1 ships (ADR 0010). Each run gets fresh
# directories (named by run), so nothing is deleted. Spends money. Results go to ./results/.
set -eu
MODEL="$1"; LABEL="$2"; ONLY="${3:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
NAME="$(date -u +%Y-%m-%dT%H%M)-$LABEL"
mkdir -p "$HERE/results"
COPYFILE_DISABLE=1 tar -C "$REPO/var/evals" -cf - cases | docker compose -p gaffer-s10 -f "$HERE/docker-compose.s10.yml" exec -T gaffer \
  sh -c "mkdir -p /data/evals/$NAME /data/evals/results && tar --warning=no-unknown-keyword -C /data/evals/$NAME -xf -"
ONLYARG=""
[ -n "$ONLY" ] && ONLYARG="--only $ONLY"
docker compose -p gaffer-s10 -f "$HERE/docker-compose.s10.yml" exec -T gaffer sh -c "set -eu
export ANTHROPIC_API_KEY=\"\$(cat /run/secrets/anthropic_api_key)\"
AGENT=/tmp/agent-$NAME; mkdir -p \$AGENT
node -e 'const fs=require(\"fs\"); const s=JSON.parse(fs.readFileSync(\"/opt/pi-agent/settings.json\",\"utf8\")); s.packages=[\"/opt/pi-gaffer\"]; fs.writeFileSync(process.argv[1]+\"/settings.json\", JSON.stringify(s,null,2));' \$AGENT
test ! -e \$AGENT/models.json
cd /work
node /opt/evals/runner/run.ts --cases /data/evals/$NAME/cases --model $MODEL --thinking medium --agent-dir \$AGENT \
  --out /data/evals/results/$NAME.jsonl --sessions /sessions/evals --data /data/evals/runs --timeout 300 $ONLYARG"
docker compose -p gaffer-s10 -f "$HERE/docker-compose.s10.yml" exec -T gaffer cat "/data/evals/results/$NAME.jsonl" > "$HERE/results/$NAME.jsonl"
docker compose -p gaffer-s10 -f "$HERE/docker-compose.s10.yml" exec -T gaffer cat "/data/evals/results/$NAME.summary.json" > "$HERE/results/$NAME.summary.json"
echo "results: $HERE/results/$NAME.summary.json"
