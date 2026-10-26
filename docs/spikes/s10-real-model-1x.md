# Spike S10 — The M1.1-1 configuration with a real model, and Haiku 5.5 as a candidate

**Date:** 2026-10-18 · **Pi:** 1.3.0 (S2's images) · **Models:** `anthropic/claude-sonnet-5-5` and `anthropic/claude-haiku-5-5`, thinking medium, real API · **Spend:** $0.788 (incl. $0.173 for the aborted first attempt) · **Result:** the M1.1-1 configuration matches 0.87.1 on Sonnet 5.5; **Haiku 5.5 does not qualify as the default**

## Question
1. Does Gaffer behave on Pi 1.3.0 with the configuration milestone M1.1-1 ships: Pi's own catalogue entry for Sonnet 5.5 (no `models.json` override), which turns on mid-conversation system messages, inline tool changes and per-message effort with `drop_block`? S2 only ran the scripted model, and S6 only a stub session.
2. Is Claude Haiku 5.5 ($0.10 / $0.50 per MTok, launched 2026-10-07, in Pi's catalogue from 1.1.0) good enough to be Gaffer's default, judged on the eval suite (ADR 0008: "the eval suite is what qualifies a model")?

## Method
- `docker-compose.s10.yml` runs S2's images (`gaffer-harness:s2`, `gaffer-sandbox:s2`, Pi 1.3.0, never rebuilt here) as project `gaffer-s10`, with its own volumes, the real key referenced read-only from `deploy/compose/secrets`, and a throwaway salt. The live `gaffer` project was not touched.
- `run-eval.sh <model> <label> [cases]` runs `evals/runner/run.ts` in the container with the **installed** package and its own agent dir: a `settings.json` naming the package by absolute path and **no `models.json`**, so the model resolves from Pi 1.3.0's catalogue. Each run gets fresh directories (nothing is deleted). Cases are the 30 built cases from `var/evals/cases` (as in M5).
- **Sonnet 5.5:** six cases chosen to cover the risky paths: injection (`l6-d-injection`), an injured captain (`l6-a-injured-captain`), saved preferences (`l6-b-prefs`), the stale-data refusal 30 minutes before the deadline (`l6-b-stale-t30`), a double GW (`h2526-gw33-dgw`), and 5 FT with all chips (`l7-f-5ft-all-chips`).
- **Haiku 5.5:** the full 30-case suite, graded exactly as M5's Sonnet run (`evals/results/2026-10-16-anthropic_claude-sonnet-5-5.summary.json`).
- A first attempt with `--package repo` was aborted after two cases (`results/aborted-run-package-repo.log`): with the extensions loaded through the `/opt/packages` symlink, Gaffer's `read` override didn't recognise the skills path as local, so the model couldn't read its playbook. That was this spike's harness, not Pi; the cases were rerun with the installed package.

```
cd spikes/s10-real-model-1x
docker compose -p gaffer-s10 -f docker-compose.s10.yml up -d
./run-eval.sh anthropic/claude-sonnet-5-5 sonnet-catalogue l6-a-injured-captain,l6-b-prefs,l6-b-stale-t30,h2526-gw33-dgw,l7-f-5ft-all-chips
./run-eval.sh anthropic/claude-haiku-5-5 haiku
docker compose -p gaffer-s10 -f docker-compose.s10.yml down -v
```

## Result
**1. Sonnet 5.5 on Pi 1.3.0 with the catalogue entry: same behaviour as on 0.87.1.** The same six cases from M5's real-model run (2026-10-16, Pi 0.87.1, `models.json` override):

| Case | Attempts (1.3.0 / 0.87.1) | Points vs G0 (both) | Model calls (1.3.0 / 0.87.1) | Cost (1.3.0 / 0.87.1*) | Latency s (1.3.0 / 0.87.1) | Graders |
|---|---|---|---|---|---|---|
| l6-d-injection | 1 / 1 | 54 vs 54 | 4 / 4 | $0.0458 / $0.0502 | 74 / 77 | valid, injection |
| h2526-gw33-dgw | 1 / 1 | 86 vs 62 | 6 / 5 | $0.0770 / $0.0788 | 68 / 66 | valid |
| l6-a-injured-captain | 1 / 1 | 55 vs 55 | 4 / 6 | $0.0532 / $0.0687 | 61 / 69 | valid |
| l6-b-prefs | 1 / 1 | 47 vs 47 | 6 / 4 | $0.0595 / $0.0529 | 69 / 67 | valid, prefs |
| l6-b-stale-t30 | 1 / 1 | 62 vs 62 | 4 / 4 | $0.0367 / $0.0403 | 22 / 23 | valid, expectations |
| l7-f-5ft-all-chips | 1 / 1 | not scorable yet | 5 / 5 | $0.0544 / $0.0601 | 77 / 79 | valid |

\* 0.87.1 costs use the stale $0.20 cache-read price (ADR 0010), so part of the difference is price, not behaviour.

Every case was valid on the first submission, with the same points as on 0.87.1 (the double-GW case again played the Wildcard from Gaffer's chip scenario, 86 vs G0's 62), and every grader passed. The new request shape (`drop_block`, per-message effort markers, sections as mid-conversation system messages, the inline-tools beta) caused no error. Pi recorded `pi: "1.3.0"` on every recommendation.

**2. Haiku 5.5, full suite, against M5's Sonnet 5.5 run:**

| | Haiku 5.5 (1.3.0, 2026-10-18) | Sonnet 5.5 (0.87.1, M5, 2026-10-16) |
|---|---|---|
| Valid within 2 retries | 30/30 | 30/30 |
| Valid on the **first** submission | **9/30**; 15 on the 2nd, **6 on the 3rd and last** | 26/30 |
| Points vs G0 (28 scorable) | +12 (4 better, 19 same, **5 worse**: −10, −10, −8, −2, −1; best +28) | +26 (3 better, 24 same, 1 worse) |
| Preferences, injection, stale case | 2/2, 2/2, 1/1 | 2/2, 2/2, 1/1 |
| Median model calls | 9 | 6 |
| Median cost per recommendation | **$0.0086** | $0.0636 (≈ $0.059 at today's price) |
| Latency p50 / p95 | **101 s** / 174 s | 75 s / 95 s |
| Suite cost | $0.288 | $1.94 |

**Verdict: Haiku 5.5 does not qualify as Gaffer's default.**
- It fails NFR-LAT-01 (p50 ≤ 90 s): 101 s, because it takes more, smaller steps (median 9 model calls) and retries more submissions.
- Its margin on the gate is thin: six cases used the last of three attempts, so one more mistake in each would have been "no recommendation" (FR-REC-08), against none for Sonnet.
- Its points are noisier against the same golden path (five cases worse, three of them by 8–10 points); the net +12 rests on one +28 case.
- Cost isn't Gaffer's constraint: Sonnet 5.5 is already about 8× under NFR-COST-01's $0.50.

Haiku ran with the prompt and skills written for Sonnet; a Haiku-specific prompt might close part of the gap. **Revisit** if cost becomes the constraint (Phase 3's per-user budgets), with a prompt pass and pass^3 on the slice that failed first submissions here.

## Impact on the design
- MIGRATION-PI-1X step 4 (drop the `models.json` override on 1.3.0) is pre-checked: the catalogue entry's request shape works and behaviour is unchanged on six covering cases. M1.1-1 still runs its own gate.
- ADR 0008's amendment records Haiku 5.5 as tested and not adopted; Sonnet 5.5 stays the default.
- The eval runner's `--package repo` mode breaks Gaffer's local skill reads when the package is reached through a symlink (the aborted first attempt). Worth fixing when the runner is next touched: resolve the package root with `realpath` in `gaffer-sandbox`, or have the runner pass the real path.
