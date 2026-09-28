# 04 — FPL analytics: projections, optimisation, chips and strategy

Research date: 2026-09-27 (2026/27 season, GW5 finished, GW6 deadline 2026-10-10 10:00 UTC per the live API).
Scope: the modelling and decision science Gaffer needs to recommend transfers, captaincy, chips and a 4-GW plan.
Companion: `03-fpl-data-sources.md` (endpoints and data access). This document covers methods and evidence, not code.

All figures below are either (a) read from a live source today, (b) measured by me in the scratchpad against public data, or (c) attributed to a named source. Anything I could not confirm is listed under **Unconfirmed**.

---

## 0. Current-season rules (verified 2026-09-27)

Primary source: the live FPL API `https://fantasy.premierleague.com/api/bootstrap-static/` (`game_config.scoring`, `game_settings`, `chips`, `element_types`), with `game_config.settings.static_content_url` pointing at `.../2026_27/`. The HTML rules page (`/help/rules`) is JS-rendered and could not be read directly; the API values match the Premier League's articles below.

### Scoring (2026/27)

| Action | GK | DEF | MID | FWD |
|---|---|---|---|---|
| Played 1–59 min | 1 | 1 | 1 | 1 |
| Played 60+ min | 2 | 2 | 2 | 2 |
| Goal | 10 | 6 | 5 | 4 |
| Assist | 3 | 3 | 3 | 3 |
| Clean sheet (60+ min) | 4 | 4 | 1 | 0 |
| Every 2 goals conceded | −1 | −1 | 0 | 0 |
| Every 3 saves | 1 | – | – | – |
| Penalty save / miss | +5 / −2 | −2 | −2 | −2 |
| Defensive contribution (DefCon) | 0 | +2 at ≥10 CBIT | +2 at ≥12 CBIRT | +2 at ≥12 CBIRT |
| Yellow / red / own goal | −1 / −3 / −2 | same | same | same |
| Bonus | 1–3 to top-3 BPS in each match | | | |

- API evidence: `goals_scored {GKP:10, DEF:6, MID:5, FWD:4}`, `clean_sheets {GKP:4, DEF:4, MID:1, FWD:0}`, `defensive_contribution {GKP:0, DEF:2, MID:2, FWD:2}`, `long_play 2`, `short_play 1`, `saves 1`, `penalties_saved 5`. All `mng_*` (Assistant Manager) scoring keys are 0.
- DefCon thresholds are not in the API. The Premier League confirms 10 CBIT for defenders and 12 CBIRT (recoveries included) for MID/FWD, capped at 2 points per match, and that DefCon stays for 2026/27 (PL "defensive contribution points in 2026/27" article). DefCon started in 2025/26. The GK goal value went from 6 to 10 in 2024/25.
- **BPS changes for 2026/27** (these alter bonus modelling): CBI now earns 1 BPS per 3 instead of per 2; the −1 BPS for being tackled is gone; GK saves were restructured (more BPS for saves inside the box, plus big-chance saves); penalty saves were cut (Fantasy Football Scout; Flashscore; PL changes article).
- **Lockdown:** GW scores become final at 09:00 UK time on the day after the GW's last match, instead of one hour after the final whistle (PL changes article). Live bonus projections now appear after 20 minutes of each match.

### Squad, transfers and chips

- Squad of 15 (2 GK, 5 DEF, 5 MID, 3 FWD), budget 100.0m, max 3 per club, XI formation limits GK 1, DEF 3–5, MID 2–5, FWD 1–3 (`element_types`, `squad_team_limit 3`, `squad_total_spend 1000`).
- **Free transfers:** 1 per GW, can be banked up to **5** (`max_extra_free_transfers: 4` meaning 1 + 4, and the PL article: "roll up to five free transfers"). Every extra transfer costs −4. Selling price keeps 50% of any profit, rounded down (`transfers_sell_on_fee 0.5`, `element_sell_at_purchase_price false`).
- **Chips: two sets, eight chips in total.** A Wildcard, Free Hit, Bench Boost and Triple Captain in each half (API `chips` has 8 entries):
  - First half: WC and FH usable GW2–19; BB and TC usable GW1–19.
  - Second half: all four usable GW20–38.
  - First-half chips expire at the GW19 deadline and do not carry over. The API gives GW19's deadline as `2027-01-01T18:30:00Z`; the PL article says 13:30 GMT Saturday 2 January (see Unconfirmed).
  - One chip per GW. The solver repo encodes the same rule (`use_wc+use_fh+use_bb+use_tc <= 1`).
- **No Assistant Manager chip.** It was dropped in 2025/26 and is still absent from the 2026/27 chip list (Fantasy Football Hub; FFS 2025-07-18; API).
- **No extra AFCON free transfers in December 2026.** The tournament moved to mid-2027 (PL changes article; FFS).
- **Blanks and doubles:** none yet. Every one of GW1–38 in `/api/fixtures/` has exactly 10 fixtures, with no team playing twice in a GW (checked 2026-09-27). Historically blanks come around the FA Cup quarter-finals and semi-finals (roughly GW29–34) and doubles in GW33–37 (Fantasy Football Hub guide).
- New 2026/27 API fields worth ingesting: `price_change_projections`, `price_change_hourly_rate`, `price_change_locked_until`, `scout_risks`, plus the per-player `defensive_contribution` and `_per_90` fields already added in 2025/26.

---

## 1. The linked article: Dilyan Kovachev's "Fantasy EPL … Algo Recommendations" series

**Article:** "Fantasy EPL GW26 Recap and GW27 Algo Recommendations", Dilyan Kovachev, DataDrivenInvestor, **25 Feb 2022** (so the 2021/22 season), 11-minute read, Medium member-only. Live Medium returned 403 / Cloudflare. I read the free intro from the Wayback snapshot of 2023-01-04, and search snippets gave the rest.

**Method.** Reconstructed from the free GW7 2020/21 post on Towards Data Science (archived) and the 2021/22 season-opener. Kovachev calls it a "Moneyball approach":

1. **Crowd signal.** Take the most-selected players among the Top-100 managers each week and build a "hybrid" Top-100 team from them.
2. **Hand-built feature layers:**
   - the official FDR over the next 3 GWs;
   - bookmaker win probabilities and Over/Under 2.5 odds, to pick attackers from high-total games and defenders from likely low-scoring ones;
   - referee penalty and card tendencies;
   - team penalty history over 5 seasons;
   - projected line-ups and injury news;
   - team-level "ROI" (points per £);
   - from 2021/22, Opta-sourced xG, xA, "xROI", clean-sheet probability and an "Easy Fixtures score".
3. **Captain recommender.** A normalised blend of predicted points, set-piece duty probability, aerial threat, and P(team scores 2+), discounted by an "opponent_resistance" built from adjusted FDR and defensive strength.
4. **Predicted points and ROI** feed a Python optimisation for the next *n* GWs. The optimiser uses hard pre-filters (drop injured players, drop high-FDR teams, 3-per-club, 2/5/5/3), and one mode picks 11 "key" players plus 4 cheapest fillers based on the Top-100's most-used formation. Transfers are limited to 1–2 per week.

**Performance as the author reported it:**
- 2020/21 GW7: "on par" with the Top-100 average of about 72 points.
- 2021/22 at GW26: overall rank **187K (top 2%)** for team_id 386960, and the hybrid Top-100 team scored 144 in GW26 against a Top-100 average of 143 (search snippet of the paywalled body).
- I could **not** verify a final rank. FPL team IDs are reassigned each season: `/api/entry/386960/history/` now returns a different manager, whose 2021/22 finish (3.59M) does not match the 187K claim.

**Other posts in the series** (all by Dilyan Kovachev):
- 2020/21, Towards Data Science: "EPL Fantasy is one week away and our Algorithm is ready to play"; "EPL Fantasy Gameweek-1 Stats and Algorithm Recommendations…"; "EPL Fantasy GW7 Recap and GW8 Algo Picks" (5 Nov 2020, team_id 2122122).
- 2021/22, The Football Hub / DataDrivenInvestor: "The new EPL season is here and our Algorithm is ready to play" (30 Nov 2021); weekly "Fantasy EPL GWn Recap and GWn+1 Algo Recommendations" posts including GW26→27.
- 2023/24, The Football Hub and pruchka.medium.com: "Fantasy EPL GW2 Recap and GW3 Algo Recommendations (2023–24)", GW3→4, GW4→5.

**Takeaway for Gaffer.** This is a heuristic scorecard, not a calibrated xP model. It leans on the weak official FDR, copies the crowd (Top-100 ownership), and has no minutes model and no multi-GW transfer or FT economics. Worth borrowing: odds-implied match totals and set-piece or penalty duty as features. Not a baseline to copy.

---

## 2. Expected-points (xP) projection models

### 2a. Component ("structural") model, recommended as Gaffer's core

For player *i* in fixture *f* (sum over fixtures for a DGW):

```
xP = App + Goals + Assists + CS + GC + Saves + DefCon + Bonus + Cards (+ pens)
App     = 1·P(1–59) + 2·P(60+)
Goals   = pos_goal_pts · E[goals],  E[goals]  = λ_team(f) · share_xG_i · E[mins]/90
Assists = 3 · E[assists],           E[assists] = λ_team(f) · share_xA_i · E[mins]/90 (calibrated: FPL assists ≠ Opta xA)
CS      = cs_pts · P(60+) · P(opp scores 0 while on pitch) ≈ cs_pts · P(60+) · e^{−λ_opp}
GC      = −1 · E[floor(G_conceded/2)]  (GK/DEF; Poisson with λ_opp scaled by minutes)
Saves   = E[floor(saves/3)]  (GK; saves rate ∝ opponent shots on target)
DefCon  = 2 · P(CBIT ≥ 10 | mins) for DEF, 2 · P(CBIRT ≥ 12 | mins) for MID/FWD
          (count model, e.g. Poisson / neg-binomial on per-90 rate × mins; data: FPL API `defensive_contribution` per GW)
Bonus   = f(expected BPS rank in match), fitted empirically; 2026/27 BPS changes mean re-fit, don't reuse 2025/26
Cards   = −1 · yellow_rate · mins/90 − 3 · red_rate · mins/90
```

- `λ_team(f)` and `λ_opp(f)` are the team goal expectations for the fixture (see §4). With these, **one fixture-level input drives goals, assists, CS, GC and bonus coherently**, which is the main advantage over "form × FDR" heuristics.
- The FPL API now carries per-player `expected_goals`, `expected_assists`, `expected_goals_conceded`, `starts` and `defensive_contribution`, per GW via `element-summary`. So the whole component model runs on free data.
- The approach matches how the two leading commercial services describe themselves:
  - Solio: "sharp" betting markets plus a stochastic minutes, goals, assists, clean-sheet and bonus model (solioanalytics.com; Rob T on X).
  - FPL Review: an xMins simulation plus a separate "Massive Data Model" (docs.fplreview.com).

### 2b. ML approaches

- **OpenFPL** (Groos, arXiv:2508.09992, Aug 2025; MIT licence, repo `daniegr/OpenFPL`, last push 2025-08-15).
  - Model: position-specific ensembles of **XGBoost and Random Forest**, taking the median of 50 members. About 196–206 features from FPL plus Understat, aggregated over 1/3/5/10/38-match windows.
  - Data: trained on 2020/21–2023/24 and tested prospectively on 2024/25.
  - Benchmark: FPL Review's Massive Data Model. OpenFPL was **better on "haulers" (≥5 pts; RMSE 5.142 vs 5.172) and "tickers" (3–4 pts)** and **worse on zeros (RMSE 0.818 vs 0.689) and blanks (≤2 pts)**, over 1–3 GW horizons.
  - The authors attribute the zero/blank gap to FPL Review's proprietary expected minutes. OpenFPL only uses FPL's 0/25/50/75/100% availability tags.
  - It includes an Assistant-Manager model and pre-dates DefCon, so it needs retraining for 2025/26+ scoring and has not been updated for 2026/27.
- **Frees, Ravella, Zhang** (arXiv:2405.02412, 2024): Ridge vs LightGBM vs 1-D CNN. The CNN was best, and news-text transfer learning *hurt*. The most important features were recent points, ICT and playing time.
- **Ramezani & Dinh** (arXiv:2505.02170, 2025): MILP team selection fed by simple forecasters (averages, exponential smoothing, ARIMA, Monte Carlo) on 2023/24. ARIMA with a rolling window was the most consistent; robust-optimisation variants did not reliably help.
- **Bonello et al.** (arXiv:1912.07441, 2019): combined stats, FDR, betting odds and expert/social-media sentiment. They report beating statistical-only predictors by about 300 points on 2018/19, which they state as rank about 30,000 of 6.5M (top 0.5%).
- Many "FPL AI" GitHub projects exist (e.g. `elcaiseri/OpenFPL-Scout-AI`, MIT, active Sept 2026). Most are regressors on FPL API features without published out-of-sample evaluation. Treat them as code references, not evidence.

### 2c. Official `ep_next` / `ep_this`

- FPL publishes `ep_this` and `ep_next` per player in `bootstrap-static`. **The formula is undocumented.** It is widely described as form-driven and adjusted for availability (see Unconfirmed).
- My check on the vaastav archive's `xP` column (the historical `ep_this`) for 2023/24 and 2024/25: it correlates about as strongly with the *previous* GW's points (r 0.68) as with the same GW's points (r 0.68–0.73). That fits a mostly form-based number.
- For 2025/26 the `xP` column in that archive is **mostly zeros** (fewer than 5% of GWs populated), so it is unusable.
- **Implication:** Gaffer should snapshot `ep_next` itself before each deadline and use it as a free benchmark to beat, not as a model.

---

## 3. Minutes prediction

**Why it matters.** Minutes gate every component: the appearance points, the 60-minute clean-sheet rule, and the per-90 rates. A projected starter who gets 0 minutes costs the full projection, and the optimiser concentrates on exactly those high-xP players.

The evidence is nuanced:
- **OpenFPL vs FPL Review.** The commercial model's only clear edge is on "zeros" and "blanks", which the paper attributes to proprietary xMins. Its advantage also grows at short horizons, consistent with better availability information (arXiv:2508.09992).
- **My decomposition** (2023/24 and 2024/25 data, player-GWs where the official xP was ≥2 or the player averaged ≥45 minutes; about 7.8k rows per season):
  - 29–31% of rows ended in 0 or 1–59 minutes, and those rows produced 17–24% of squared error.
  - Among players who played 60+ minutes, the points SD was still 3.3–3.5.
  - So **raw RMSE is dominated by haul noise, but minutes error is the largest *avoidable* error** and the main cause of costly decisions such as captaining or buying a benched player.
- **FPL Review's xMins** is the average over 1,000 simulations. It blends start and sub scenarios, rotation, injury proneness and role security, is updated hourly, and is human-validated (docs.fplreview.com).

**Approaches, cheapest first:**
1. **Rules plus recency.** Use FPL `status` and `chance_of_playing_next_round` (0/25/50/75/100) × recent start share (last 3–6 GWs, from `starts`) × minutes-when-started. Separate P(start) from E[mins | start] and E[mins | sub].
2. **Classifier for P(start).** Logistic regression or GBM on start history, days since the last match (congestion and European fixtures), position depth-chart competition, returning-from-injury flags, and manager rotation tendencies.
3. **Minutes distribution.** A mixture of {0, sub cameo, early off, 90} so the 60-minute thresholds (appearance, clean sheet) are handled properly rather than through E[mins].
4. **News overrides.** Press-conference and line-up leaks are high value but unstructured, so this is **LLM territory** (see §12), bounded and logged.

---

## 4. Fixture difficulty and team strength

**Why the official FDR is weak.**
- It is a single 1–5 integer per fixture (`team_h_difficulty` / `team_a_difficulty`, from team-level `strength*` fields), based on opposition strength.
- It **does not separate attacking from defensive difficulty**: the same number serves your goalkeeper chasing a clean sheet and your striker chasing goals.
- The 5-point scale is coarse (Onside Arena FDR explainer; FFS / OddAlerts odds-priced tickers).
- It carries no goal expectation, so it cannot feed a points model.

**Alternatives:**
- **Odds-implied goal expectations.** De-vig the 1X2 and Over/Under 2.5 prices, then solve for (λ_home, λ_away) under Poisson or Dixon-Coles. This is the market consensus and what Solio uses ("sharp betting markets").
  - **Free source verified:** `https://football-data.co.uk/fixtures.csv` lists upcoming fixtures with 1X2, O/U 2.5 and Asian handicap odds from several books plus Betfair Exchange.
  - `mmz4281/2627/E0.csv` has 2026/27 results with closing odds and **match xG** (HxG, AxG).
  - Limitation: odds exist only for about the next round, so later GWs need a model.
- **Team-strength model for GW+2…GW+8:**
  - **Dixon-Coles** (1997, JRSS C 46(2):265–280) is a Poisson model with attack and defence parameters, home advantage, a low-score dependence correction and time-decay weighting.
  - Fit it to **xG plus goals**; xG converges faster.
  - Blend it with odds where odds exist, or anchor it to the odds-implied λ for the next GW.
  - Elo is a simpler alternative for win probability but does not give goal rates directly.
- **Solio** combines market odds with its own team-strength model for later GWs (Rob T on X: projections "from sharp betting markets & our Solio team strength model"). **FPL Review** documents a "Fixture Likelihoods" component alongside xMins (docs nav).

---

## 5. Multi-GW optimisation (integer programming)

### The reference implementation: `solioanalytics/open-fpl-solver` (formerly `sertalpbilal/FPL-Optimization-Tools`)

- **Identity.** GitHub redirects the old repo (repository id 344928234) to `solioanalytics/open-fpl-solver`. **Apache-2.0**, 191 stars, last push **2026-09-15** (commit "Fix boolean command-line option parsing (#65)"), so actively maintained.
- **People.** Originally by Sertalp Bilal; now maintained by Chris Musson (pyproject).
- **Stack.** pandas plus **HiGHS via `highspy`** (≥1.11; HiGHS 1.15.1 installed). Requires Python ≥3.14 per `pyproject.toml`.
- **Inputs.** It needs a projections CSV (Solio, FPL Review or "Mikkel" formats: `{gw}_Pts`, `{gw}_xMins`). **It does not produce projections itself.**

**Formulation** (read from `dev/solver.py` and `data/comprehensive_settings.json`):
- **Variables per player per GW:** squad, lineup, captain, vice-captain, bench order (4 slots), transfer_in, transfer_out, Free Hit squad; chip binaries per GW; FT state as integer 0–5 with one-hot `ft_state`.
- **Constraints:**
  - 2/5/5/3 squad, 11-player lineup with formation bounds, 3 per club, budget with selling-price logic;
  - FT dynamics clamp to [1, 5], and WC/FH weeks preserve FTs;
  - hits via `penalized_transfers`;
  - at most one chip per GW; FH squad reverts;
  - TC must be on the captain; optional hit limits, bans and locks, booked transfers.
- **Objective.** Per GW: `xP·(lineup + captain + 0.1·vice + TC + Σ bench_weight·bench)`, minus 4 per hit, plus FT-rollover value, minus 0.2 per FT used, plus 0.08 per £m in the bank. Summed with **decay 0.9^(w − next_gw)** (default 0.84 in code if unset).
- **Default parameters:**
  - `horizon` 8, `bench_weights` {GK 0.03, 1st 0.21, 2nd 0.06, 3rd 0.002};
  - `ft_value_list` {2: 2.0, 3: 1.6, 4: 1.3, 5: 1.1} (value of rolling into each FT state);
  - `hit_cost` 4, `no_transfer_last_gws` 2, `secs` 600, `gap` 0;
  - pool filters `xmin_lb` 300 and `ev_per_price_cutoff` 30th percentile.
- **Extras:** `run/simulations.py`, `run/sensitivity.py` (re-solve under perturbed projections), `binary_file_generator.py`, and `randomized` for solution diversity.

**Measured runtime** on this Mac, HiGHS 1.15.1, preseason (free squad) mode, 667 players, synthetic fixture-varying projections, default filters:

| Horizon | Chips allowed | Status | Solve time |
|---|---|---|---|
| 4 | none | optimal | 0.2 s |
| 4 | WC+FH+BB+TC (1 each) | optimal | 114 s |
| 8 | none | optimal | 10 s |
| 8 | WC+FH+BB+TC | time limit 300 s, gap 2.66% | 300 s |

**Takeaway:** transfer-only planning over 4–8 GWs is interactive-fast. **Free chip placement blows up the search**, so evaluate chips as a handful of fixed-chip scenario solves (`use_bb: [gw]` and so on) rather than letting the MIP choose freely.

**Other repos:**
- `sertalpbilal/fpl_optimized`: active 2026-09-20, licence NOASSERTION.
- `vaastav/Fantasy-Premier-League`: historical data, 1.8k stars, licence NOASSERTION (check before redistributing).
- `amosbastian/fpl`: async API wrapper, MIT, last push 2024-07, effectively unmaintained.
- `spinalwiz/fpl-optimiser` (2022) and `wiscostret/optimize_fpl` (GPL-3.0, 2019): stale.

**Solver choice:** HiGHS (MIT, pip-installable, no licence server) is the right default. CBC via PuLP works but is slower; Gurobi is faster but commercial.

---

## 6. Transfer hits and FT rollover

- **Break-even rule:** a hit is worth it if the decayed xP gain over the ownership horizon exceeds 4, **plus** the value of the FT state you give up. In solver terms the whole plan decides this through `hit_cost` and `ft_value_list`; the heuristic version is "Δ decayed xP over 4–6 GWs > 4 + ~1.5".
- **FT rollover value.** Solio/Sertalp defaults value rolling into 2 FTs at about 2.0 points, into 3 at 1.6, into 4 at 1.3 and into 5 at 1.1, with 0 beyond 5 because of the cap. That is diminishing marginal value, and a banked FT at 5 is wasted.
- **Evidence from winners:** the 2025/26 champion took **zero hits** all season and made no transfer in 15 GWs (fplgod "ten years of winners"). With 5-FT banking, the bar for hits has risen (several strategy guides agree).
- Hits make more sense when rank variance is the goal (cups, mini-league catch-up) than for overall-rank expected value (fplgod, the FPL Cup example with 31 hits).

## 7. Captaincy EV, vice-captain and variance

- **EV:** the captain adds 1× the player's points (2× under TC), so pick `argmax xP`, but use the **distribution**: haul probability matters when you are chasing.
- **Vice-captain value** ≈ P(captain plays 0) × xP_vice. The solver weights the vice at 0.1 of xP, and it matters mainly for rotation-risk captains.
- Captaincy is a large share of the score: about 29% of the 2024/25 winner's points came from the armband, and choosing the wrong captain is described as a 10–15 point weekly swing (fplgod).
- **Variance and rank:** EO ≈ ownership + captaincy share (§9). Captaining a very high-EO player is roughly rank-neutral when he hauls and rank-damaging when he blanks. A differential captain has positive rank skew but lower EV. Winners' advice is to take risk in the squad and keep the armband safe (fplgod; FPL Oracle EO thresholds <40% / 40–70% / >70%, which are practitioner heuristics).

## 8. Chip timing

- **2026/27 chip set:** 2× WC, FH, BB and TC, split across two halves; first-half chips expire at the GW19 deadline (§0).
- **Heuristics:**
  - BB and TC in DGWs; with no DGWs in the first half so far, first-half BB/TC go to the best single-GW fixture spot or high-xP bench weeks.
  - FH for blanks.
  - WC to restructure ahead of a DGW or BGW cluster, or after injuries or price swings.
  - Don't waste first-half chips.
- **Optimiser-based:** force each chip into candidate GWs (`use_bb`, `use_tc`, `allowed_chip_gws`), solve each scenario, and compare decayed objectives. Given the runtime table in §5, that is about 5–20 small solves rather than one hard one. The 2023/24 winner's WC-in-BGW then FH-in-DGW ordering produced 143 points versus 105 for a rival who reversed it (fplgod), which shows sequencing matters.
- With both halves' chips available, Gaffer must track **chip availability per half** and warn before the GW19 deadline.

## 9. Effective ownership, rank risk and differentials

- **EO** = Σ over managers of the multiplier (0 bench, 1 XI, 2 captain, 3 TC) ÷ the number of managers, measured *within the reference field* (overall, top 10k, or a mini-league).
- Your rank change in a GW is roughly Σ_i (your_multiplier_i − EO_i) × points_i.
- The FPL API exposes `selected_by_percent` (overall ownership only) and, per event, `most_captained`. Top-10k EO requires sampling entry picks (`/api/entry/{id}/event/{gw}/picks/`) from league standings.
- **Strategy:** tracking the field protects rank; beating it needs low-EO exposure with good EV. Mini-league play is a different objective from overall rank.
- **For Gaffer:** default to **max EV**, and expose a user "risk mode" that adds an EO-aware tiebreak between near-equal plans.

## 10. Published results and benchmarks

**Points by final overall rank.** Measured from 600 randomly sampled entry IDs' `/api/entry/{id}/history/` past-season rows, using FPL's own `rank_percentage` bands:

| Season | Top 1% | Top 5% | Top 10% | Top 25% | Median |
|---|---|---|---|---|---|
| 2023/24 | ~2,465–2,530 | ~2,360–2,375 | ~2,290 | ~2,160 | ~1,944 |
| 2024/25 | ~2,500–2,605 | ~2,395–2,405 | ~2,330–2,335 | ~2,200 | ~1,978 |
| 2025/26 | ~2,300–2,400 | ~2,225–2,230 | ~2,160–2,170 | ~2,045 | ~1,865 |

The samples are small, so read these as ±~20. The 2025/26 winner was a first-season manager (fplgod).

**Algorithms that report a rank:**
- Matthews, Ramchurn & Chalkiadakis (AAAI 2012, Bayesian RL, 2010/11 data): mean season score 2,056.7, about rank 31,924 of about 2.5M, roughly the top 1%.
- Bonello et al. (2019): top 0.5% on 2018/19.
- Venter & van Vuuren (cited via search): top 4% on 2021/22; a retrospective integrated approach placed top 4% on 2020/21.
- Kovachev: self-reported top 2% at GW26 of 2021/22, final rank unverified.
- OpenFPL gives accuracy (RMSE by bucket) rather than a season rank.

**Reading:** a sound xP model plus an MILP planner plausibly sits in the **top 1–5%** band. Beating that is mostly about minutes and news, chip sequencing and risk management, not a fancier regressor. No reproducible public benchmark compares projection services head-to-head on season rank; FPL Review's "Expectation vs Reality" and Solio's EoS pages are self-published.

---

## 11. Recommendation

### Baseline for the MVP (free data, deterministic, cheap to maintain)

1. **Data:**
   - FPL API: `bootstrap-static`, `fixtures`, `element-summary/{id}` for per-GW xG, xA, xGC, starts, DefCon and minutes; `entry/{id}` for picks, bank and FTs.
   - football-data.co.uk `fixtures.csv` (next-round odds) and season CSVs (results, closing odds, match xG).
   - Snapshot everything before each deadline so it can be backtested later.
2. **Team goal model:** odds-implied λ for the next GW; a time-decayed Dixon-Coles (or plain Poisson GLM) on xG plus goals for GW+2…GW+8; blend at the join.
3. **Minutes (xMins):** rules plus recency (§3.1), with P(start), E[mins | start], P(60+ | start) and a sub-appearance probability. Availability tags applied multiplicatively.
4. **xP:** the component model (§2a) using player xG/xA shares, CS/GC from λ_opp, a DefCon threshold probability, bonus from a simple empirical fit on 2025/26+ data re-weighted for the 2026/27 BPS changes, and GK saves. Clip and sanity-check against `ep_next`.
5. **Optimiser:** vendor or wrap `open-fpl-solver` (Apache-2.0, HiGHS) or write an equivalent MILP.
   - Horizon 6 (show the 4-GW plan), decay 0.9, default bench weights and FT values, hit cost 4, time limit about 30–60 s, chips off by default.
   - Chip advice comes from scenario solves over candidate GWs.
6. **Captain:** the solver's argmax xP, with the vice-captain chosen by the solver. Report P(DNP) and haul probability.
7. **Evaluation harness:** every week log Gaffer's xP, `ep_next` and actual points. Track MAE and RMSE by bucket (zeros, blanks, tickers, haulers, as in OpenFPL) and the realised points of the recommended XI against the `ep_next`-optimal XI.

### Upgrade path

- **Stage 1 (calibration):**
  - Backtest the component model on 2024/25 and 2025/26 (DefCon exists only from 2025/26).
  - Calibrate the assist rate against xA, the DefCon threshold model, and the bonus model.
  - Tune decay and FT values by replaying seasons through the solver.
- **Stage 2 (learned minutes):**
  - GBM P(start) and minutes-mixture model with congestion and European-fixture features.
  - LLM-assisted news ingestion that produces **structured** xMins overrides.
- **Stage 3 (ML residuals / OpenFPL-style ensemble):**
  - XGBoost/LightGBM on component features to correct the structural model's residuals.
  - Retrain OpenFPL's approach for the DefCon era if it beats Stage 1 on haulers.
- **Stage 4 (stochastic planning):**
  - Sampled-projection solves (`simulations.py`, `sensitivity.py`) to show robust transfers.
  - EO-aware risk modes using sampled top-10k picks.
  - Price-change awareness using the new `price_change_projections` field.
- **Stage 5 (optional paid inputs):** accept a user-supplied Solio or FPL Review CSV as an alternative projection source; the solver already parses both.

## 12. Deterministic code vs LLM judgement

**Deterministic, tested library code:**
- rules engine: the scoring table, FT accrual and cap, chip windows per half, one chip per GW, squad legality, selling-price formula, DGW/BGW detection;
- data ingestion and snapshots;
- odds de-vig and the λ solver; the team-strength fit;
- xMins rules; the xP components;
- the MILP (build, solve, parse) and hit/FT arithmetic;
- EO computation; backtest metrics.

Golden-file tests should cover the scoring table and FT and chip transitions.

**LLM judgement**, always bounded and logged, never computing points or legality:
- turning press-conference and team-news text into structured availability or xMins adjustments, with the source quoted;
- choosing a risk profile from the user's stated goal (overall rank, mini-league, cup);
- picking between near-tied solver plans and explaining trade-offs in plain language;
- flagging when inputs look stale or contradictory (e.g. `ep_next` and Gaffer's xP diverge sharply);
- narrative chip-timing advice built on top of the scenario-solve numbers.

The LLM proposes inputs and constraints (bans, locks, chip GWs); the solver decides.

---

## Sources

- FPL live API bootstrap-static (scoring, chips, settings, element_types, events): https://fantasy.premierleague.com/api/bootstrap-static/
- FPL live API fixtures: https://fantasy.premierleague.com/api/fixtures/
- FPL entry history API (sampled): https://fantasy.premierleague.com/api/entry/{id}/history/
- PL, "All you need to know about changes to FPL for 2026/27": https://www.premierleague.com/en/news/4679873/all-you-need-to-know-about-changes-to-fpl-for-202627
- PL, defensive contribution points in 2026/27: https://www.premierleague.com/en/news/4361991/whats-happening-with-defensive-contribution-points-in-202627-fantasy
- PL, FPL basics: scoring points: https://www.premierleague.com/en/news/2174909/fpl-basics-explained-scoring-points
- PL, changes for 2025/26: https://www.premierleague.com/en/news/4362211/all-you-need-to-know-about-changes-to-fantasy-for-202526
- Fantasy Football Scout, FPL 2026/27 rule changes: https://www.fantasyfootballscout.co.uk/2026/07/20/fpl-2026-27-5-rule-changes-new-features-announced
- Flashscore, 2026/27 changes: https://www.flashscore.com/news/soccer-premier-league-fantasy-premier-league-2026-27-all-rule-changes-and-new-features/KGmq7ts1/
- Fantasy Football Hub, AM scrapped / two chip sets: https://www.fantasyfootballhub.co.uk/fpl-chips-2025-26-announced
- Fantasy Football Hub, BGW/DGW guide 2026/27: https://www.fantasyfootballhub.co.uk/fpl-blank-double-gameweek-guide
- GK goal = 10 (2024/25 change): https://www.premierleague.com/en/news/4059044
- Kovachev GW26 article (Wayback): http://web.archive.org/web/20230104112909/https://medium.datadriveninvestor.com/fantasy-epl-gw26-recap-and-gw27-algo-recommendations-d11ac0e8304a
- Kovachev GW7 2020/21 (Wayback): http://web.archive.org/web/20250211094131/https://towardsdatascience.com/epl-fantasy-gw7-recap-and-gw8-algo-picks-855240acc9a2/
- Kovachev 2021/22 opener (Wayback): http://web.archive.org/web/20241204002732/https://medium.com/the-football-pub/the-new-epl-season-is-here-and-our-algorithm-is-ready-to-play-f51299837652
- Kovachev 2023/24 posts: https://medium.com/the-football-pub/fantasy-epl-gw3-recap-and-gw4-algo-recommendations-2023-24-58b61d330add ; https://pruchka.medium.com/fantasy-epl-gw2-recap-and-gw3-algo-recommendations-2023-24-e3c4e88ed4e9
- OpenFPL paper: https://arxiv.org/html/2508.09992v1 ; repo https://github.com/daniegr/OpenFPL
- Frees et al. 2024: https://arxiv.org/abs/2405.02412
- Ramezani & Dinh 2025: https://arxiv.org/abs/2505.02170
- Bonello et al. 2019: https://arxiv.org/abs/1912.07441
- Matthews et al. AAAI 2012: https://ojs.aaai.org/index.php/AAAI/article/view/8259 ; https://eprints.soton.ac.uk/340382/1/fantasyFootball2012cr.pdf
- Dixon & Coles 1997: https://rss.onlinelibrary.wiley.com/doi/abs/10.1111/1467-9876.00065
- open-fpl-solver (cloned, commit 2026-09-15): https://github.com/solioanalytics/open-fpl-solver
- GitHub API repo metadata (licences, pushed_at): https://api.github.com/repos/{owner}/{repo}
- vaastav dataset: https://github.com/vaastav/Fantasy-Premier-League
- FPL Review xMins docs: https://docs.fplreview.com/the-model/projections/xmins/
- Solio: https://solioanalytics.com/ ; https://x.com/robtFPL/status/2049234210934706577
- football-data.co.uk: https://www.football-data.co.uk/englandm.php ; https://football-data.co.uk/fixtures.csv ; https://www.football-data.co.uk/mmz4281/2627/E0.csv
- FDR limitations: https://onsidearena.com/guides/fpl-fixture-difficulty-explained ; https://www.oddalerts.com/fpl/fixture-ticker
- FBref loses Opta advanced stats (Jan 2026): https://ricardoheredia.substack.com/p/farewell-fbref-advanced-stats-when-one-door-closes-another-opens (and https://tildes.net/~sports.football/1sa6/)
- fplgod, ten years of winners: https://fplgod.com/blog/what-we-learned-from-ten-years-of-fpl-winners
- FPL Oracle, EO and rank percentile: https://fploracle.team/blog/effective-ownership-fpl ; https://fploracle.team/blog/fpl-rank-percentile

## Unconfirmed

- **Kovachev GW26 article body and method specifics for 2021/22:** member-only. Live Medium returned 403/Cloudflare and the Wayback copy has only the free intro. The 187K rank and "hybrid 144 vs Top-100 143" come from the snapshot header and a search snippet. Final 2021/22 rank is unverified because team ID 386960 now maps to a different manager in `/api/entry/386960/history/`.
- **Official `ep_next` formula:** not published anywhere I could find (searched FPL help and API docs). The "form-based" description comes from third-party sites plus my correlation check.
- **Timing of vaastav's `xP` column (pre- or post-deadline capture):** not documented in the repo README I saw. My correlation results are indicative only, and the 2025/26 column is mostly empty.
- **First-half chip deadline:** the PL article (via WebFetch summary) says 13:30 GMT Saturday 2 January, but the API's GW19 `deadline_time` is 2027-01-01T18:30Z. Re-check the API near the date; the API is authoritative.
- **Official rules page** (`fantasy.premierleague.com/help/rules` and `/en/help/new`): JS-rendered and returned no content through fetch. Scoring was verified from the API and PL news articles instead.
- **Top-10k / top-100k thresholds:** my sample of about 400 entries per season cannot resolve ranks above about 1%. Practitioner figures (FPL Oracle: top 10k ≈ 2,300–2,450) are unverified and, for 2025/26, look high relative to my top-1% band.
- **Venter & van Vuuren (top 4%, 2021/22):** seen only in a search-engine summary; the paper was not opened.
- **Bonello et al. selection method:** whether their top-0.5% result used real-time or hindsight team selection was not checked in the full paper.
- **Solio and FPL Review internals** beyond their public descriptions (market weighting, bonus model, Massive Data Model features): proprietary.
- **"Mikkel" free projections format** supported by the solver: the source and current availability of those projections was not checked.
- **Solver runtimes:** measured on synthetic projections in preseason mode on one laptop. Real projections and an existing squad with FT state will differ.
- **FBref / Understat:** reports say FBref lost Opta advanced stats in January 2026. Understat returned HTTP 200 today, but its terms and continued EPL coverage were not reviewed.
