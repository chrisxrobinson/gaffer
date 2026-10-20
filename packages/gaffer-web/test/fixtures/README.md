# Test fixtures

- `faux-run.jsonl`, `faux-run.session.jsonl`: a Recommend run through the bridge on the built image, with a scripted
  (faux) model and the real FPL API (team 1, FPL's own public team), sandbox, golden path and gate: one rejected
  submission (CAPTAIN_IS_VICE), then a valid one. The first is the event stream as the page receives it
  (`{t, rec}` per event, `--replay`-compatible); the second is the session file Pi wrote. Recorded with
  `docker compose exec -T -e RECORD=/tmp/app-record gaffer node --input-type=module - < tests/app.mjs`, then
  `docker compose cp gaffer:/tmp/app-record/. packages/gaffer-web/test/fixtures/`.
- `eval-recommendations.json`: every recommendation of a faux eval run (the results files are gitignored), with the
  team hash replaced; made by `eval-recommendations.mjs`.
