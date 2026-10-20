---
description: Plan when to play each chip you have left, over a range of gameweeks
argument-hint: "[weeks, e.g. GW8-GW19]"
---
Plan my chips for ${@:-the next 6 gameweeks}.

From the latest snapshot (take one with odds if there is none), list the chips I still have and when each expires. Then work it out in the sandbox with gaffer_lib: project expected points over the whole range (`xp.project` with that horizon), solve the chip-free plan over it (`plan.solve`), and for each chip left and each week in the range that the rules allow, solve again with the chip forced in that week (`plan.solve` with `chip=(name, gw)`, or `plan.chip_scenarios` with `per_chip`), keeping the whole job within about three minutes. For each chip give its best week and what it adds in expected points over the chip-free plan, the next-best week, and why; say which weeks you could not evaluate and why. Keep to the rules (one chip per GW, first-half chips expire at the GW19 deadline, no Free Hit in GW20 after one in GW19) and read the chip-strategy skill. Answer in plain text with one small table: chip, best GW, xP added, next-best GW. This is a plan, not a decision: do not call submit_recommendation or set_preferences.
