---
name: transfer-and-captaincy
description: Judging transfers and the armband from the golden path's plans - hits versus rolling, the free-transfer bank, when to prefer plan 2 or 3 over plan 1, captain choice and the vice-captain. Read when choosing between plans or explaining a transfer or captain.
---

# Transfers and captaincy

The solver has already weighed points over 6 GWs, the value of banked free transfers, hits and the bank. Start from plan 1. Your job is to check it makes football sense and to explain it.

## Hits

- The plan's `net_xp_gain_4gw` is already net of the hit. Quote that, not the gross gain.
- A hit the solver chose paid for itself in its numbers. Still say plainly what it rests on: if the gain depends on one player whose minutes are uncertain, say so and lower your confidence.
- Never add a hit the solver didn't choose. If the user caps hits, that is `max_hits_per_gw` in their preferences, and the golden path respects it.

## Rolling and the bank

- Up to 5 free transfers can be banked. A roll is a real option, not a failure to act: the solver values a banked transfer and still chose to roll or to spend.
- When plan 1 rolls, say what the transfer is being saved for if the plan shows it (a later GW's moves).
- At the cap, an unused transfer is lost. If the plan rolls at 5, look again.

## Plan 2 or plan 3 instead of plan 1

Only when it is within 0.5 decayed xP of plan 1 (`objective_vs_best` above −0.5): the gate refuses anything further away. Within that, reasons to prefer another plan:
- the user's risk mode (`risk-and-ownership`)
- it avoids a player with a minutes doubt you couldn't quantify
- it keeps more money or transfers for a known later need

Say that it is a near-tie and why you broke it that way.

## Captain

- Default: the highest xP in the XI, which is what the plan picked. Check his P(start); a doubt is a reason to look at the next candidate, and usually a reason for an override via `team-news` rather than a hunch.
- Two candidates within a few tenths: prefer the surer starter and the better fixture, and say it is close.
- The vice-captain only matters if the captain doesn't play. He should be a near-certain starter, ideally in a different match from the captain.
- Triple Captain is a chip decision: see `chip-strategy`.

## Explaining

One rationale per move, 60 words at most: what it gains, over which fixtures, and the main risk. Use the names and numbers from `plan.json`.
