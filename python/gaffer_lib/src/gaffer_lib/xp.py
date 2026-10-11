"""Component expected points (ADR 0003, research 04 §2a).

For a player in a fixture, the expected stat line is built from the fixture's goal expectations
(`strength`), the player's minutes (`minutes`) and his per-90 rates, and is then scored with
`rules.Scoring`, the same table the rules engine uses for real points:

    appearance   P(1-59) and P(60+)
    goals        xG per 90 x minutes x (team λ in this fixture / team's typical λ)
    assists      xA per 90 x minutes x the same factor x the league's assists-per-xA ratio
    clean sheet  P(60+) x P(opponent scores 0)
    conceded     E[floor(goals conceded / 2)] for those on the pitch
    saves        E[floor(saves / 3)], saves scaling with the opponent's λ
    DefCon       P(defensive contributions reach the position's threshold)
    bonus        the player's bonus points per 90

Rates are shrunk towards a price-aware position prior fitted on the data available at the deadline
(nothing from the future, no constants tuned on the backtest seasons). Cards, own goals and penalty
saves and misses are not modelled. A GW's xP is the sum over the player's fixtures in it.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, field

import numpy as np

from . import rules as R
from .inputs import ModelInputs, PlayerData
from .minutes import PREV_SEASON_WEIGHT, Minutes, availability, baseline, expected_minutes, parse_overrides, position_defaults
from .strength import FixtureLambda, TeamStrength, fit_dixon_coles, fixture_lambdas, newcomer_priors, team_key

RATE_STATS = ("xg", "xa", "saves", "bonus", "defcon")
PRIOR_90S = 6.0  # 90s of prior behind each per-90 rate
MIN_POOL_90S = 3.0  # a player needs this many 90s to inform the position prior
SHORT_PLAY_MINUTES = 30.0  # typical minutes of an appearance under 60
MAX_FIXTURE_XP = 15.0
FIXTURE_FACTOR_RANGE = (0.4, 2.5)
ODDS_WARNING = "odds unavailable — team strength from Dixon-Coles"  # FR-DAT-09


def poisson_pmf(mu: float, kmax: int = 40) -> np.ndarray:
    k = np.arange(kmax + 1)
    if mu <= 0:
        out = np.zeros(kmax + 1)
        out[0] = 1.0
        return out
    logp = -mu + k * math.log(mu) - np.array([math.lgamma(i + 1) for i in k])
    return np.exp(logp)


def expected_floor_div(mu: float, n: int) -> float:
    """E[floor(X / n)] for X ~ Poisson(mu): the points units for "every n saves / goals conceded"."""
    p = poisson_pmf(mu)
    return float(np.sum((np.arange(len(p)) // n) * p))


def prob_at_least(mu: float, threshold: int) -> float:
    """P(X >= threshold) for X ~ Poisson(mu)."""
    if threshold <= 0:
        return 1.0
    return float(max(0.0, 1.0 - poisson_pmf(mu)[:threshold].sum()))


# ---------------------------------------------------------------------------------------------------
# Scoring an expected stat line


def points_from_expectation(exp: Mapping[str, float], element_type: int, scoring: R.Scoring) -> dict[str, float]:
    """Points by component for an expected stat line, using `game_config.scoring`.

    `exp`: p_short and p_long (P of 1-59 and 60+ minutes), goals, assists, clean_sheet (P of a clean
    sheet that counts), conceded_units (E[floor(conceded / 2)]), save_units (E[floor(saves / 3)]),
    defcon (P of reaching the threshold) and bonus. With probabilities of 0 or 1 and whole numbers
    this is exactly `Scoring.points` on the stat line.
    """
    pos = scoring.positions[element_type]
    g = lambda k: float(exp.get(k, 0.0) or 0.0)  # noqa: E731
    has_defcon = R.DEFCON_THRESHOLD.get(pos) is not None
    return {
        "appearance": g("p_short") * scoring.value("short_play", pos) + g("p_long") * scoring.value("long_play", pos),
        "goals": g("goals") * scoring.value("goals_scored", pos),
        "assists": g("assists") * scoring.value("assists", pos),
        "clean_sheet": g("clean_sheet") * scoring.value("clean_sheets", pos),
        "conceded": g("conceded_units") * scoring.value("goals_conceded", pos),
        "saves": g("save_units") * scoring.value("saves", pos),
        "defcon": g("defcon") * scoring.value("defensive_contribution", pos) if has_defcon else 0.0,
        "bonus": g("bonus") * scoring.value("bonus", pos),
    }


def expectation_from_stats(stats: Mapping[str, int], element_type: int, scoring: R.Scoring) -> dict[str, float]:
    """The degenerate expectation of a known stat line (used to test the scoring identity)."""
    pos = scoring.positions[element_type]
    minutes = int(stats.get("minutes", 0))
    threshold = R.DEFCON_THRESHOLD.get(pos)
    return {
        "p_short": float(0 < minutes < R.LONG_PLAY_MINUTES),
        "p_long": float(minutes >= R.LONG_PLAY_MINUTES),
        "goals": stats.get("goals_scored", 0),
        "assists": stats.get("assists", 0),
        "clean_sheet": stats.get("clean_sheets", 0),
        "conceded_units": stats.get("goals_conceded", 0) // R.GOALS_CONCEDED_PER_POINT,
        "save_units": stats.get("saves", 0) // R.SAVES_PER_POINT,
        "defcon": float(threshold is not None and stats.get("defensive_contribution", 0) >= threshold),
        "bonus": stats.get("bonus", 0),
    }


# ---------------------------------------------------------------------------------------------------
# Per-90 rates


def _eff(p: PlayerData, key: str) -> float:
    return (p.totals or {}).get(key, 0.0) + PREV_SEASON_WEIGHT * (p.prev or {}).get(key, 0.0)


@dataclass(frozen=True)
class RatePriors:
    """Per position and stat: rate per 90 ≈ a + b x price (tenths), fitted on the pool by weighted
    least squares; `assist_ratio` is the pool's FPL assists per xA."""

    coef: dict  # (element_type, stat) → (a, b)
    assist_ratio: float = 1.0

    def prior(self, element_type: int, stat: str, now_cost: int) -> float:
        a, b = self.coef.get((element_type, stat), (0.0, 0.0))
        return max(0.0, a + b * now_cost)


def fit_rate_priors(players: Mapping[int, PlayerData]) -> RatePriors:
    coef = {}
    by_type: dict[int, list[PlayerData]] = {}
    for p in players.values():
        if _eff(p, "minutes") / 90.0 >= MIN_POOL_90S:
            by_type.setdefault(p.element_type, []).append(p)
    for t, pool in by_type.items():
        w = np.array([_eff(p, "minutes") / 90.0 for p in pool])
        x = np.array([p.now_cost for p in pool], dtype=float)
        for stat in RATE_STATS:
            y = np.array([_eff(p, stat) for p in pool]) / w
            mean = float(np.sum(w * y) / np.sum(w))
            a, b = mean, 0.0
            if len(pool) >= 8 and np.ptp(x) > 0:
                xm = float(np.sum(w * x) / np.sum(w))
                var = float(np.sum(w * (x - xm) ** 2))
                if var > 0:
                    b = float(np.sum(w * (x - xm) * (y - mean)) / var)
                    a = mean - b * xm
            coef[(t, stat)] = (a, b)
    xa = sum(_eff(p, "xa") for pool in by_type.values() for p in pool)
    assists = sum(_eff(p, "assists") for pool in by_type.values() for p in pool)
    return RatePriors(coef, assists / xa if xa >= 20 else 1.0)


def player_rates(p: PlayerData, priors: RatePriors) -> dict[str, float]:
    """Per-90 rates: the player's own (previous season at half weight) shrunk towards the prior."""
    n90 = _eff(p, "minutes") / 90.0
    return {s: (_eff(p, s) + PRIOR_90S * priors.prior(p.element_type, s, p.now_cost)) / (n90 + PRIOR_90S) for s in RATE_STATS}


# ---------------------------------------------------------------------------------------------------
# One player in one fixture


def fixture_expectation(
    rates: Mapping[str, float], mins: Minutes, element_type: int, scoring: R.Scoring, *,
    lam_for: float, lam_against: float, p_clean_sheet: float, attack_factor: float = 1.0, save_factor: float = 1.0, assist_ratio: float = 1.0,
) -> dict[str, float]:
    pos = scoring.positions[element_type]
    share = mins.xmins / 90.0
    threshold = R.DEFCON_THRESHOLD.get(pos)
    concedes = scoring.value("goals_conceded", pos) != 0
    saves = scoring.value("saves", pos) != 0 and pos == "GKP"
    return {
        "p_short": mins.p_short,
        "p_long": mins.p60,
        "goals": rates["xg"] * share * attack_factor,
        "assists": rates["xa"] * share * attack_factor * assist_ratio,
        "clean_sheet": mins.p60 * p_clean_sheet,
        "conceded_units": (
            mins.p60 * expected_floor_div(lam_against, R.GOALS_CONCEDED_PER_POINT)
            + mins.p_short * expected_floor_div(lam_against * SHORT_PLAY_MINUTES / 90.0, R.GOALS_CONCEDED_PER_POINT)
        ) if concedes else 0.0,
        "save_units": mins.p_start * expected_floor_div(rates["saves"] * save_factor * mins.mins_start / 90.0, R.SAVES_PER_POINT) if saves else 0.0,
        "defcon": mins.p_start * prob_at_least(rates["defcon"] * mins.mins_start / 90.0, threshold) if threshold is not None else 0.0,
        "bonus": rates["bonus"] * share,
    }


# ---------------------------------------------------------------------------------------------------
# The projection


@dataclass
class Projection:
    gws: list[int]
    xp: dict[int, dict[int, float]]  # player → gw → expected points
    xmins: dict[int, dict[int, float]]
    p_start: dict[int, dict[int, float]]
    components: dict[int, dict[int, dict[str, float]]]
    fixtures: list[FixtureLambda]
    warnings: list[str] = field(default_factory=list)
    strength: TeamStrength | None = None
    overrides_applied: list = field(default_factory=list)

    def total(self, player: int) -> float:
        return sum(self.xp.get(player, {}).values())


def team_strength(inputs: ModelInputs) -> TeamStrength:
    """Dixon-Coles on every match played before the deadline, this season and the previous one
    (time-decayed). Promoted teams start from the relegated teams' mean strength."""
    asof = inputs.deadline or max((m.date for m in inputs.matches + inputs.prev_matches), default=None)
    if asof is None:
        return TeamStrength()
    current = {team_key(n) for n in inputs.team_names.values()}
    return fit_dixon_coles(inputs.prev_matches + inputs.matches, asof, priors=newcomer_priors(inputs.prev_matches, current, asof))


def project(inputs: ModelInputs, horizon: int = 6, xmins_overrides=None, *, strength: TeamStrength | None = None) -> Projection:
    gws = inputs.horizon(horizon)
    warnings: list[str] = []
    model = strength or team_strength(inputs)
    fls = fixture_lambdas(inputs.fixtures, gws, inputs.team_names, model, inputs.odds_rows if inputs.odds_available else [], odds_gw=inputs.next_gw)
    next_fx = [f for f in fls if f.gw == inputs.next_gw]
    with_odds = sum(f.source.startswith("odds") for f in next_fx)
    if next_fx and with_odds == 0:
        warnings.append(ODDS_WARNING + (f" ({inputs.odds_reason})" if inputs.odds_reason else ""))
    elif with_odds < len(next_fx):
        warnings.append(f"odds cover {with_odds} of {len(next_fx)} GW{inputs.next_gw} fixtures; the rest use Dixon-Coles")

    by_team_gw: dict[tuple[int, int], list[FixtureLambda]] = {}
    for f in fls:
        by_team_gw.setdefault((f.home, f.gw), []).append(f)
        by_team_gw.setdefault((f.away, f.gw), []).append(f)
    league_lam = float(np.mean([x for f in fls for x in (f.lam_home, f.lam_away)])) if fls else 1.4
    typical = {tid: model.typical(team_key(name)) for tid, name in inputs.team_names.items()}
    clean = {(f.fixture, t): f.clean_sheet(t) for f in fls for t in (f.home, f.away)}

    priors = fit_rate_priors(inputs.players)
    defaults = position_defaults(inputs.players)
    overrides = parse_overrides(xmins_overrides)
    applied = []
    lo, hi = FIXTURE_FACTOR_RANGE
    out = Projection(gws, {}, {}, {}, {}, fls, warnings, model)
    for pid, p in inputs.players.items():
        rates = player_rates(p, priors)
        base = baseline(p, defaults)
        ov = overrides.get(pid, {})
        xp_p, xm_p, ps_p, comp_p = {}, {}, {}, {}
        for k, gw in enumerate(gws):
            override = ov.get(gw, ov.get(None))
            if override is not None:
                applied.append({"player": pid, "gw": gw, "xmins": override})
            mins = expected_minutes(base, availability(p.status, p.chance, k), override)
            total, xm, comps = 0.0, 0.0, {}
            fixtures = by_team_gw.get((p.team, gw), [])
            for f in fixtures:
                lam_for, lam_against = f.for_team(p.team)
                exp = fixture_expectation(
                    rates, mins, p.element_type, inputs.scoring, lam_for=lam_for, lam_against=lam_against, p_clean_sheet=clean[(f.fixture, p.team)],
                    attack_factor=min(max(lam_for / max(typical[p.team][0], 1e-6), lo), hi), save_factor=min(max(lam_against / league_lam, lo), hi),
                    assist_ratio=priors.assist_ratio,
                )
                pts = points_from_expectation(exp, p.element_type, inputs.scoring)
                fx_total = min(max(sum(pts.values()), 0.0), MAX_FIXTURE_XP)
                total += fx_total
                xm += mins.xmins
                for c, v in pts.items():
                    comps[c] = comps.get(c, 0.0) + v
            xp_p[gw], xm_p[gw], comp_p[gw] = total, xm, comps
            ps_p[gw] = mins.p_start if fixtures else 0.0
        out.xp[pid], out.xmins[pid], out.p_start[pid], out.components[pid] = xp_p, xm_p, ps_p, comp_p
    out.overrides_applied = applied
    return out


def compare_with_ep_next(inputs: ModelInputs, proj: Projection, top: int = 8) -> dict:
    """Gaffer's next-GW xP against the official `ep_next` (research 04 §2c: a benchmark, not an input)."""
    gw = inputs.next_gw
    rows = [(p, proj.xp[p.id][gw], p.ep_next) for p in inputs.players.values() if p.ep_next is not None and gw in proj.xp.get(p.id, {})]
    played = [(p, x, e) for p, x, e in rows if x > 0.5 or e > 0.5]
    if len(played) < 3:
        return {"gw": gw, "players": len(played)}
    x = np.array([r[1] for r in played])
    e = np.array([r[2] for r in played])
    gaps = sorted(played, key=lambda r: abs(r[1] - r[2]), reverse=True)[:top]
    return {
        "gw": gw, "players": len(played),
        "correlation": round(float(np.corrcoef(x, e)[0, 1]), 3),
        "mean_xp": round(float(x.mean()), 2), "mean_ep_next": round(float(e.mean()), 2),
        "mean_abs_gap": round(float(np.abs(x - e).mean()), 2),
        "largest_gaps": [{"id": p.id, "name": p.name, "xp": round(xv, 2), "ep_next": ev, "status": p.status} for p, xv, ev in gaps],
    }
