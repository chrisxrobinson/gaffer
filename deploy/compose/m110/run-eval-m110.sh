#!/bin/sh
# M1.1-0: the eval runner against the gaffer-m110 Compose project instead of the live one (the pattern of
# spikes/s2-pi-1x-upgrade/run-faux-eval.sh and spikes/s10-real-model-1x/run-eval.sh).
#   ./run-eval-m110.sh faux faux                                   # the whole suite, free
#   ./run-eval-m110.sh anthropic/claude-sonnet-5-5 sonnet l6-a-follow-up,l6-d   # SPENDS MONEY
# Same steps as evals/runner/cli.ts, without the case build (uses var/evals/cases), but every docker call
# names -p gaffer-m110. The runner uses the image's installed package and agent dir, so the model comes from
# this branch's harness/models.json. The key is read from the Compose secret for anthropic/* only; the faux
# run gets none. Each run gets its own directories (named by run), so nothing is deleted. Results go to ./results/.
set -eu
MODEL="$1"; LABEL="$2"; ONLY="${3:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
DC="docker compose -p gaffer-m110 -f $HERE/docker-compose.m110.yml"
NAME="$(date -u +%Y-%m-%dT%H%M)-$LABEL"
mkdir -p "$HERE/results"
COPYFILE_DISABLE=1 tar -C "$REPO/var/evals" -cf - cases | $DC exec -T gaffer \
  sh -c "mkdir -p /data/evals/$NAME /data/evals/results && tar --warning=no-unknown-keyword -C /data/evals/$NAME -xf -"
KEY='unset ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY || true'
case "$MODEL" in anthropic/*) KEY='export ANTHROPIC_API_KEY="$(cat /run/secrets/anthropic_api_key)"' ;; esac
ONLYARG=""
[ -n "$ONLY" ] && ONLYARG="--only $ONLY"
$DC exec -T gaffer sh -c "set -eu; $KEY; cd /work
node /opt/evals/runner/run.ts --cases /data/evals/$NAME/cases --model $MODEL --thinking medium \
  --out /data/evals/results/$NAME.jsonl --sessions /sessions/evals --data /data/evals/runs --timeout 300 $ONLYARG"
$DC exec -T gaffer cat "/data/evals/results/$NAME.jsonl" > "$HERE/results/$NAME.jsonl"
$DC exec -T gaffer cat "/data/evals/results/$NAME.summary.json" > "$HERE/results/$NAME.summary.json"
# FR-OUT-01 over the run, as cli.ts does: every recommendation against the published schema with ajv.
node --input-type=module -e '
import { readFileSync } from "node:fs"; import { createRequire } from "node:module";
const [file, repo] = process.argv.slice(1);
const require = createRequire(repo + "/evals/package.json");
const Ajv2020 = require("ajv/dist/2020.js").default;
const check = new Ajv2020({ allErrors: true, strict: false }).compile(JSON.parse(readFileSync(repo + "/schemas/recommendation-1.json", "utf8")));
const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.schema === "gaffer.evalresult/1");
const invalid = rows.filter((r) => r.recommendation && !check(r.recommendation)).map((r) => r.case);
console.log(JSON.stringify({ recommendations: rows.filter((r) => r.recommendation).length, schema_invalid: invalid }));
' "$HERE/results/$NAME.jsonl" "$REPO"
echo "results: $HERE/results/$NAME.summary.json"
