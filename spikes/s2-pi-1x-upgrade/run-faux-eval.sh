#!/bin/sh
# Spike S2: `pnpm eval --model faux` against the gaffer-s2 Compose project instead of the default one.
# Same steps as evals/runner/cli.ts (no case build: uses the cases already built in var/evals/cases),
# but every docker call names -p gaffer-s2 and this directory's compose file. Results stay in ./results/.
# Faux only: the s2 stack's anthropic_api_key secret is empty and ANTHROPIC_API_KEY is unset for the run.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DC="docker compose -p gaffer-s2 -f $HERE/docker-compose.s2.yml"
mkdir -p "$HERE/results"
COPYFILE_DISABLE=1 tar -C "$REPO/var/evals" -cf - cases | $DC exec -T gaffer sh -c 'rm -rf /data/evals/cases && mkdir -p /data/evals/results && tar --warning=no-unknown-keyword -C /data/evals -xf -'
NAME="$(date -u +%Y-%m-%d)-faux-s2"
$DC exec -T gaffer sh -c "set -eu; unset ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY || true; cd /work; node /opt/evals/runner/run.ts --cases /data/evals/cases --model faux --thinking medium --out /data/evals/results/$NAME.jsonl --sessions /sessions/evals --data /data/evals/runs --timeout 300"
$DC exec -T gaffer cat "/data/evals/results/$NAME.jsonl" > "$HERE/results/$NAME.jsonl"
$DC exec -T gaffer cat "/data/evals/results/$NAME.summary.json" > "$HERE/results/$NAME.summary.json"
# FR-OUT-01 over the suite, as cli.ts does: every recommendation against the published schema with ajv.
node --input-type=module -e '
import { readFileSync } from "node:fs"; import { createRequire } from "node:module";
const [file, repo] = process.argv.slice(1);
const require = createRequire(repo + "/evals/package.json");
const Ajv2020 = require("ajv/dist/2020.js").default;
const check = new Ajv2020({ allErrors: true, strict: false }).compile(JSON.parse(readFileSync(repo + "/schemas/recommendation-1.json", "utf8")));
const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.schema === "gaffer.evalresult/1");
const invalid = rows.filter((r) => r.recommendation && !check(r.recommendation)).map((r) => r.case);
console.log(JSON.stringify({ recommendations: rows.filter((r) => r.recommendation).length, schema_invalid: invalid, pi: [...new Set(rows.map((r) => r.recommendation?.pi))] }));
' "$HERE/results/$NAME.jsonl" "$REPO"
