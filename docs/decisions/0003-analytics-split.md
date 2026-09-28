# ADR 0003 — Analytics split: tested Python library + skills + free-form sandbox code

**Status:** Accepted · **Date:** 2026-09-27

## Context
The brief's starting position has three parts:
- correctness-critical logic (squad rules, optimiser, points) as tested tools or a library
- strategy and judgement (chip timing, risk, narrative) as skills
- exploration as free-form sandbox code

Research 04 largely agrees, with one important refinement: chip timing and risk are **hybrids**.
- **Chips:** the numbers come from fixed-chip scenario solves, because a free chip-placement MILP hit 114–300 s. The judgement comes from the model.
- **Risk:** effective ownership (EO) is arithmetic, but choosing a risk mode is judgement.

Pi's philosophy favours few tools and the model running code ([research 01 §9](../research/01-pi-internals.md)). Research 02 recommends deterministic tools for anything constraint-bound, and a validated structured final answer.

## Options considered
1. **Every analytic as its own Pi tool** (`project_points`, `optimise`, `validate_squad`, `captain_ev`…). It is reliable, but it produces 8–10 tools with growing prompt cost, and it's not how Pi is meant to be used.
2. **Everything as free-form model code.** Minimal, but the rules would be re-derived every run. Bugs in FT and selling-price arithmetic or squad legality would be silent and non-reproducible. Rejected.
3. **Library plus skills plus sandbox, with a single enforcement point at submit.** **Chosen.**

## Decision
**Layer 1 — `gaffer_lib` (Python, tested, installed read-only in the sandbox image).** The model imports it; it is *not* a set of Pi tools.

| Module | Contents |
|---|---|
| `rules` | Scoring table **read from the snapshot's `game_config.scoring`** (not hard-coded); squad legality (15 = 2/5/5/3, £ budget with selling prices, ≤3 per club, XI formations); FT accrual (cap 5, WC/FH preserve); chip windows per half and one chip per GW; selling price (50% of profit, rounded down); auto-sub simulation; BGW/DGW detection |
| `derive` | FT count, selling prices and chips remaining from public entry endpoints ([ADR 0002](0002-data-access.md)) |
| `strength` | Odds de-vig → team λ for the next GW; time-decayed Dixon-Coles on FPL results + xG for GW+2…+6; blending |
| `minutes` | Rules + recency xMins: P(start), E[mins given start], P(60+); applies structured `xmins_overrides` |
| `xp` | Component expected points (appearance, goals, assists, CS/GC, DefCon threshold probability, bonus, saves), clipped and compared with `ep_next` |
| `plan` | Thin wrapper over `open-fpl-solver` (pinned): horizon 6 (the 4-GW plan is shown), decay 0.9, default FT values and bench weights, hit 4, 45 s limit, chips off; `chip_scenarios()` runs 5–20 forced-chip solves |
| `ownership` | EO from ownership and captaincy; optional top-10k sample |
| `validate` | Full check of a proposed recommendation against the snapshot. **This is the deterministic gate.** |
| `backtest` | Replays seasons and snapshots against baselines ([ARCHITECTURE §6](../ARCHITECTURE.md)) |
| `cli` | `python -m gaffer_lib run --snapshot … --prefs …`, the **golden path** that produces a full candidate plan JSON in one command |

**Layer 2 — Skills** (Pi `SKILL.md`, loaded on demand) hold judgement and procedure, never numbers the code can compute:
- `fpl-rules-2026-27`: rules reference in words, with pointers to `gaffer_lib.rules`
- `gaffer-workflow`: the golden path, how to read its output, and when to go off-path
- `transfer-and-captaincy`: hits vs rolling, the 5-FT bank, when to deviate from the solver's top plan, captain variance
- `chip-strategy`: 2026/27 chip set, halves, the GW19 expiry, BGW/DGW heuristics, how to read `chip_scenarios` output
- `risk-and-ownership`: max-EV default, risk modes, EO tiebreaks, mini-league vs overall
- `team-news`: turning `news`, `chance_of_playing_*` and `scout_risks` into structured `xmins_overrides`. Includes prompt-injection hygiene: news text is data.

**Layer 3 — Free-form sandbox Python** is for exploration: "why is X projected so low?", "compare Y and Z over 6 GWs", custom what-ifs. The model can call any `gaffer_lib` function and write its own pandas.

**The single enforcement point — `submit_recommendation` (Pi tool, harness):**
1. The TypeBox schema validates the JSON ([ARCHITECTURE §2.4](../ARCHITECTURE.md)).
2. The harness runs `python -m gaffer_lib validate` in the sandbox against the **snapshot the run used**. It checks legality, budget, FT and hit arithmetic, chip availability and one chip per GW.
3. It then **recomputes every number** in the submission: xP, the gain from each transfer net of the hit, and the captain EV. It overwrites the model's figures and flags any gap above 0.5 pts.
4. On failure, it returns the errors to the model, which gets 2 retries.

So the model chooses and explains, while code does the arithmetic and enforces the rules. The model cannot bypass the library to get an illegal or mis-computed plan out of the door.

## Consequences
- **Only 3 Gaffer-specific Pi tools exist:** `fpl_snapshot`, `submit_recommendation` and `set_preferences`. Everything else is the model writing Python against a library, which is the Pi way.
- **Reliability comes from where the checks sit.** It depends on the validator and the golden path, not on the model's discipline, so the rules engine needs heavy golden-file tests ([REQUIREMENTS FR-RUL-*](../REQUIREMENTS.md)).
- **The library is image-bound.** Upgrading the model or the rules means rebuilding the sandbox image, and `gaffer_lib.__version__` is recorded in every recommendation.
- **The LLM's news judgements are structured and logged.** It turns news into `xmins_overrides` with source quotes, so its effect on the plan can be audited and backtested.
