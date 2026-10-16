---
name: chip-strategy
description: Chip decisions for 2026/27 - the eight chips and their two halves, the GW19 expiry, blank and double gameweeks, how to read the golden path's chip_scenarios, sequencing, and when playing a chip now is justified. Read before recommending or ruling out a chip.
---

# Chips

## The set this season

Four chips, each available once in each half of the season: Wildcard, Free Hit, Bench Boost and Triple Captain. One chip per GW. First-half chips expire at the GW19 deadline and do not carry over. There is no Assistant Manager chip. The snapshot summary lists which the user still has, and `fpl-rules-2026-27` has the detail. Availability is checked at submit; you cannot play a chip the user doesn't have.

## Read the scenarios first

`chip_scenarios` in `plan.json` has one entry per chip:
- **evaluated**: the chip was forced in its most promising GW and the plan re-solved. `delta_objective` is what it adds over the chip-free plan across the horizon; `delta_xp_gw` is what it adds in that GW.
- **not evaluated**, with the reason: not available, saved by preference, or there wasn't time to solve it. "Not evaluated" is not "not worth playing": say that you have no number for it.

Bench Boost and Triple Captain scenarios are solved over the chip-free plan's players, so they are a floor on the chip's value.

## Judging

- A chip is worth its best GW, not this GW. The question is whether a better GW is likely later in its half. Before a blank or double GW is announced, a later GW usually is; say what you'd be waiting for.
- A chip about to expire is worth whatever it adds: as GW19 nears, an unplayed first-half chip is worth nothing afterwards.
- Blank and double GWs are in the snapshot summary when they are within the horizon. A Free Hit covers a blank; Bench Boost and Triple Captain want a double. If none is flagged, don't invent one.
- Wildcard: the case is a squad that needs more changes than the free transfers allow. Look at how many transfers plan 1 wants over the horizon and how many hits it takes.
- Sequencing: one chip per GW, and a Free Hit can't follow a Free Hit across GW19 and GW20.
- A user who saved a chip (`save_chips`) has decided; don't relitigate it.

## Recommending

- Not playing: `chip.play` is `null`, with a rationale that names the scenario evidence (which chip, which GW, what it adds, and why now is not that GW).
- Playing this GW: submit the scenario's own plan (its `gws`), with `chip.play` set. The gate re-scores it.
- Planning a chip for a later GW: put it in that GW's `plan[].chip` and say so.

If you have no evaluated scenario for the chip the user asks about, say so plainly rather than guessing its value.
