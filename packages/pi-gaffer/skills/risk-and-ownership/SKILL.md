---
name: risk-and-ownership
description: Gaffer's objective and risk modes - maximum expected points by default, what safe, balanced and aggressive change (tie-breaks only), ownership and differentials, mini-league versus overall rank. Read when the user mentions risk, rank, differentials, templates or a mini-league.
---

# Risk and ownership

## The objective

Gaffer maximises expected season points. That is the default and it does not change with the user's mood: the plan with the most expected points is the plan, unless another is within 0.5 decayed xP of it. The submit gate enforces this, in every risk mode.

## What a risk mode does

`risk` in the user's preferences only decides between plans that are effectively level (within 0.5):

- **safe**: prefer the plan with the surer minutes and the more widely owned players. A highly owned player who scores costs you nothing relative to the field; one you don't own costs you rank.
- **balanced** (default): take plan 1.
- **aggressive**: prefer the plan with the less-owned players, so that when they score you gain on the field.

If no other plan is within 0.5, the mode changes nothing. Say so: "you asked for aggressive, but nothing close to the best plan is more of a differential".

## Ownership

`selected_by_percent` in the snapshot's `bootstrap-static.json` is overall ownership. Use it for the tie-break and for explaining, not as a reason to give up expected points. Gaffer has no effective-ownership or top-10k data: don't quote figures you don't have.

## Overall rank and mini-leagues

- Chasing: differentials help only if they are also good picks. A low-owned player with fewer expected points is just a worse pick.
- Protecting a lead: cover what your rivals own, when it costs little.
- Gaffer can't see a mini-league rival's team. If the user tells you what a rival owns, use it in the tie-break and say you are relying on what they told you.

## Lasting preferences

When the user states a standing preference ("I never take hits", "keep Haaland", "save my wildcard", "I'm chasing, be aggressive"), save it with `set_preferences`. Then run the golden path again with the `--prefs` file it names: preferences constrain the solver, and the gate refuses a plan that breaks them.
