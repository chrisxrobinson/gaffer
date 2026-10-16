---
name: gaffer-workflow
description: How to produce a Gaffer recommendation - the golden path (snapshot, gaffer_lib run, judge, submit_recommendation), how to read plan.json, how to fill in the submission, what the submit gate checks and how to fix a rejection. Read this before any transfer, captain, line-up or chip recommendation.
---

# The Gaffer workflow

The code does the arithmetic and enforces the rules. You choose between the options it gives you and explain the choice. Never estimate a number yourself.

## 1. Snapshot

`fpl_snapshot` with `include: ["odds"]`. Read its warnings: stale data, an assumed free-transfer count, pending transfers, "DO NOT FINALISE TRANSFERS". The summary ends with the golden-path command for this snapshot.

## 2. Golden path

Run that command exactly as given. It already carries the user's `--ft`, `--pending` and `--prefs`; never add, change or drop `--ft` or `--pending` yourself, even when the summary shows a free-transfer count (only the user sets those, with `/team`, and a plan made with different ones is refused). The only things you may append are ` --xmins /work/xmins.json` (team news) and, after `set_preferences`, ` --prefs <the file it names>`. It takes up to a minute and writes `/work/plan.json`. Its printed summary has up to 3 plans, chip scenarios, captain candidates, the confidence and the warnings.

Reading `plan.json` (Python, in the sandbox):
- `plans[k]`: `transfers` (this GW, with `xp_gain_4gw` and `xp_gain_6gw_decayed`), `gws[0..5]` (per GW: `transfers`, `chip`, `xi`, `bench`, `captain`, `vice_captain`, `expected_points`), `objective_vs_best`, `validation`.
- `chip_scenarios[]`: one per chip, with its own `gws` when evaluated, or the `reason` it wasn't.
- `players[id]`: name, club, xP per GW, P(start), official `ep_next`.
- `confidence`, `warnings`, `ep_next_comparison`.

## 3. Judge

- Team news: read the `team-news` skill. A minutes override means running the golden path again with `--xmins`.
- Choosing between plans: `transfer-and-captaincy` and `risk-and-ownership`.
- Chips: `chip-strategy`.
- If something looks wrong (a large gap to `ep_next`, a surprising transfer), look at it in Python before trusting or dismissing it. `from gaffer_lib import xp, inputs, snapshot` gives you the projection and its `components`.

## 4. Submit

Call `submit_recommendation` once, as your last action. Take every id from `plan.json`; do not retype a squad from memory.

| Field | From |
|---|---|
| `transfers[]` | the chosen `plans[k].transfers`: `out.id`, `in.id`, your `rationale` (60 words at most), and the two gains if you quote them |
| `starting_xi`, `bench` | `plans[k].gws[0].xi`, `.bench` (the bench order is set for you) |
| `captain.id`, `vice_captain.id` | `plans[k].gws[0].captain`, `.vice_captain` |
| `chip.play` | `null`, or the chip if you are playing a scenario this GW; always a `rationale` |
| `plan[0..3]` | `plans[k].gws[0..3]`: `gw`, `transfers` as `{out: {id}, in: {id}}`, `chip`, `captain`, and a short `note` |
| `summary` | the advice in plain words, 120 words at most |
| `warnings` | only what the computed warnings won't say |
| `confidence` | leave it out unless you have a reason to lower it |

What the gate checks, and what to do when it says no:
- **A rule** (club limit, budget, formation, chip window, hits): you changed something by hand. Go back to a plan from `plan.json`.
- **`NOT_NEAR_OPTIMAL`**: your plan is more than 0.5 decayed xP below the best one. Submit plan 1, or another plan whose `objective_vs_best` is above −0.5. If you believe the best plan is wrong, change the inputs (a minutes override, a preference) and run the golden path again; do not argue with the solver in words.
- **`PLAN_*_MISMATCH`**: `plan.json` wasn't made from the latest snapshot, overrides or preferences. Run the golden-path command again.
- **`PREF_*`**: the plan breaks a saved preference. Use a plan made with `--prefs`.
- **`TRANSFERS_NOT_FINAL`**: data is stale inside the last hour. Run the command with `--hold` and submit that line-up with no transfers, saying why.

There are 3 attempts. A rejection is not shown to the user; a third one ends the run with a failure.

## When not to submit

A question about a player, a price, the squad or a what-if is answered in text. Only a recommendation the user should act on goes through `submit_recommendation`. If the user wants a plan the gate would refuse (for example a hit the numbers don't support), say what the numbers say and discuss it in text.
