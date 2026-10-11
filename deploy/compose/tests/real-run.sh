#!/bin/sh
# One real-model session through the installed package, headless, with the model in GAFFER_MODEL
# (default claude-sonnet-5-5) and the key in secrets/. THIS COSTS MONEY: about $0.30-$0.60 a run, capped
# by GAFFER_BUDGET_HARD. Prints the tool calls, the recommendation and the cost from the session log.
#   ./tests/real-run.sh <name> "<prompt>"
# The session is kept in /sessions/m4-live/<name> (so it counts towards the daily cap).
set -eu
cd "$(dirname "$0")/.."
name="$1"; prompt="$2"
docker compose exec -T -e RUN_NAME="$name" -e PROMPT="$prompt" gaffer sh -c '
  ANTHROPIC_API_KEY="$(cat /run/secrets/anthropic_api_key)"; export ANTHROPIC_API_KEY
  dir=/sessions/m4-live/$RUN_NAME; mkdir -p "$dir"; cd /work
  pi --session-dir "$dir" --no-context-files --tools read,write,edit,bash,fpl_snapshot,submit_recommendation,set_preferences \
     --provider "${GAFFER_PROVIDER:-anthropic}" --model "${GAFFER_MODEL:-claude-sonnet-5-5}" --thinking "${GAFFER_THINKING:-medium}" \
     --mode json -p "$PROMPT" < /dev/null > "$dir/run.events" 2> "$dir/run.err" || echo "pi exited $?"
'
docker compose exec -T -e RUN_DIR="/sessions/m4-live/$name" gaffer node --input-type=module - < tests/real-run-report.mjs
