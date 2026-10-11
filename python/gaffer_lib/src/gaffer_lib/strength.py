"""Team goal expectations (ADR 0003, research 04 §4): what each team is expected to score in each
fixture of the planning horizon. One fixture-level input then drives goals, assists, clean sheets,
goals conceded and saves coherently in `xp`.

- Next GW: bookmaker 1X2 and over/under 2.5 prices (football-data.co.uk `fixtures.csv`), de-vigged
  and inverted to the (λ_home, λ_away) of a Dixon-Coles score grid.
- GW+2…+6, and any fixture without odds: a time-decayed Dixon-Coles model (Dixon & Coles 1997)
  fitted to results, and to match xG where the source has it.
- Where both exist they are blended geometrically, weighted towards the market.

The constants below were chosen from the literature before any backtest and have not been tuned on
the seasons the backtest reports (BUILD.md, FR-EVL-01).
"""

from __future__ import annotations

import math
from collections.abc import Hashable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime

import numpy as np
from scipy.optimize import least_squares, minimize, minimize_scalar

# Dixon & Coles (1997) found ξ = 0.0065 per half-week, a half-life of about a year.
HALF_LIFE_DAYS = 365.0
# Prior standard deviation of a team's log attack/defence strength around its prior mean. Premier
# League attack strengths spread by roughly ±0.3 in log terms.
PRIOR_SD = 0.3
# Low-score dependence. Dixon & Coles (1997) estimate about -0.13; used when too few matches to fit it.
DEFAULT_RHO = -0.13
# Weight on match xG (against goals) in the fitting target, where xG exists. xG is the less noisy
# measure of a team's chance creation (research 04 §4: "xG converges faster").
XG_WEIGHT = 0.5
# Weight on the market λ where both odds and the model exist: the market is the sharper source.
ODDS_WEIGHT = 0.8
MAX_GOALS = 10
# A typical Premier League match: used when a market or a model is missing entirely.
LEAGUE_HOME_GOALS, LEAGUE_AWAY_GOALS = 1.55, 1.25

# Team names differ between sources and seasons (football-data.co.uk says "Man United" and "Hull",
# FPL says "Man Utd" and "Hull City"), so both are reduced to one key.
_TEAM_ALIASES = {
    "man united": "man utd", "manchester united": "man utd", "manchester city": "man city", "tottenham": "spurs",
    "sheffield united": "sheffield utd", "nottingham forest": "nott'm forest", "wolverhampton": "wolves",
    "coventry city": "coventry", "hull city": "hull", "ipswich town": "ipswich", "leicester city": "leicester",
    "luton town": "luton", "leeds united": "leeds", "newcastle united": "newcastle", "west ham united": "west ham",
}


def team_key(name: str) -> str:
    """One key for a team across FPL (`teams[].name`) and football-data.co.uk (`HomeTeam`)."""
    k = " ".join(str(name).strip().lower().split())
    return _TEAM_ALIASES.get(k, k)


# ---------------------------------------------------------------------------------------------------
# Odds → probabilities → goal expectations


def devig(odds: Sequence[float]) -> list[float]:
    """Decimal odds for the exhaustive outcomes of one market → probabilities summing to 1.

    Proportional (multiplicative) normalisation: each implied probability 1/odds is divided by
    their sum, which removes the bookmaker's margin evenly.
    """
    if not odds or any((o is None) or not (o > 1.0) or not math.isfinite(o) for o in odds):
        raise ValueError(f"decimal odds must all be > 1: {list(odds)}")
    implied = [1.0 / o for o in odds]
    total = sum(implied)
    return [p / total for p in implied]


def score_grid(lam_home: float, lam_away: float, rho: float = 0.0, max_goals: int = MAX_GOALS) -> np.ndarray:
    """P(home scores i, away scores j) for i, j in 0..max_goals: independent Poissons with the
    Dixon-Coles low-score correction τ on 0-0, 1-0, 0-1 and 1-1, renormalised to sum to 1."""
    k = np.arange(max_goals + 1)
    fact = np.array([math.factorial(int(i)) for i in k], dtype=float)
    ph = np.exp(-lam_home) * lam_home**k / fact
    pa = np.exp(-lam_away) * lam_away**k / fact
    grid = np.outer(ph, pa)
    if rho:
        grid[0, 0] *= max(1 - lam_home * lam_away * rho, 0.0)
        grid[0, 1] *= max(1 + lam_home * rho, 0.0)
        grid[1, 0] *= max(1 + lam_away * rho, 0.0)
        grid[1, 1] *= max(1 - rho, 0.0)
    return grid / grid.sum()


def grid_probs(grid: np.ndarray) -> dict[str, float]:
    """Market probabilities of a score grid (rows = home goals)."""
    n = grid.shape[0]
    i, j = np.indices((n, n))
    return {
        "home": float(grid[i > j].sum()),
        "draw": float(grid[i == j].sum()),
        "away": float(grid[i < j].sum()),
        "over25": float(grid[i + j >= 3].sum()),
        "home_clean_sheet": float(grid[:, 0].sum()),  # the away side scores 0
        "away_clean_sheet": float(grid[0, :].sum()),
    }


def lambdas_from_probs(p_home: float, p_away: float, p_over25: float | None, rho: float = DEFAULT_RHO) -> tuple[float, float]:
    """The (λ_home, λ_away) whose score grid best reproduces de-vigged market probabilities.

    Three targets (home win, away win, over 2.5 goals) and two unknowns, by least squares on the
    log-rates. Without an over/under price the total is held at the league average.
    """
    total_prior = LEAGUE_HOME_GOALS + LEAGUE_AWAY_GOALS

    def resid(x):
        lh, la = math.exp(x[0]), math.exp(x[1])
        p = grid_probs(score_grid(lh, la, rho))
        r = [p["home"] - p_home, p["away"] - p_away]
        r.append(p["over25"] - p_over25 if p_over25 is not None else (lh + la - total_prior) * 0.2)
        return r

    sol = least_squares(resid, x0=[math.log(LEAGUE_HOME_GOALS), math.log(LEAGUE_AWAY_GOALS)], bounds=([-3.0, -3.0], [2.0, 2.0]))
    return float(math.exp(sol.x[0])), float(math.exp(sol.x[1]))


def _first_price(odds: Mapping[str, float], keys: Iterable[tuple[str, ...]]) -> tuple[float, ...] | None:
    for group in keys:
        vals = [odds.get(k) for k in group]
        if all(isinstance(v, (int, float)) and v > 1.0 for v in vals):
            return tuple(float(v) for v in vals)
    return None


# Market average first (the consensus), then single books, as football-data.co.uk names them.
_1X2 = [("AvgH", "AvgD", "AvgA"), ("MaxH", "MaxD", "MaxA"), ("B365H", "B365D", "B365A"), ("PSH", "PSD", "PSA"), ("BWH", "BWD", "BWA")]
_OU = [("Avg>2.5", "Avg<2.5"), ("Max>2.5", "Max<2.5"), ("B365>2.5", "B365<2.5"), ("P>2.5", "P<2.5")]


def lambdas_from_odds(odds: Mapping[str, float], rho: float = DEFAULT_RHO) -> tuple[float, float] | None:
    """(λ_home, λ_away) from one football-data.co.uk odds row, or None if it has no usable 1X2 price."""
    x12 = _first_price(odds, _1X2)
    if x12 is None:
        return None
    p_home, _, p_away = devig(x12)
    ou = _first_price(odds, _OU)
    p_over = devig(ou)[0] if ou else None
    return lambdas_from_probs(p_home, p_away, p_over, rho)


# ---------------------------------------------------------------------------------------------------
# Dixon-Coles


@dataclass(frozen=True)
class Match:
    """One played match. Teams are any hashable key, used consistently (Gaffer uses `team_key` names)."""

    date: datetime
    home: Hashable
    away: Hashable
    home_goals: int
    away_goals: int
    home_xg: float | None = None
    away_xg: float | None = None


@dataclass
class TeamStrength:
    """log λ_home = mu + home_adv + attack[home] − defence[away]; log λ_away = mu + attack[away] − defence[home].
    A higher `defence` concedes less. Unknown teams take `default` (attack, defence)."""

    mu: float = math.log(LEAGUE_AWAY_GOALS)
    home_adv: float = math.log(LEAGUE_HOME_GOALS / LEAGUE_AWAY_GOALS)
    rho: float = DEFAULT_RHO
    attack: dict = field(default_factory=dict)
    defence: dict = field(default_factory=dict)
    default: tuple[float, float] = (0.0, 0.0)
    matches: int = 0

    def lambdas(self, home: Hashable, away: Hashable) -> tuple[float, float]:
        ah, dh = self.attack.get(home, self.default[0]), self.defence.get(home, self.default[1])
        aa, da = self.attack.get(away, self.default[0]), self.defence.get(away, self.default[1])
        return math.exp(self.mu + self.home_adv + ah - da), math.exp(self.mu + aa - dh)

    def typical(self, team: Hashable) -> tuple[float, float]:
        """(scored, conceded) per match for `team` against an average opponent, averaged over home
        and away: the baseline a fixture's λ is compared with."""
        a, d = self.attack.get(team, self.default[0]), self.defence.get(team, self.default[1])
        avg_att = float(np.mean(list(self.attack.values()))) if self.attack else 0.0
        avg_def = float(np.mean(list(self.defence.values()))) if self.defence else 0.0
        venue = (math.exp(self.home_adv) + 1.0) / 2.0
        return math.exp(self.mu + a - avg_def) * venue, math.exp(self.mu + avg_att - d) * venue


def fit_dixon_coles(
    matches: Sequence[Match],
    asof: datetime,
    *,
    priors: Mapping[Hashable, tuple[float, float]] | None = None,
    default: tuple[float, float] = (0.0, 0.0),
    half_life_days: float = HALF_LIFE_DAYS,
    prior_sd: float = PRIOR_SD,
    xg_weight: float = XG_WEIGHT,
) -> TeamStrength:
    """Time-decayed Dixon-Coles fit on matches played strictly before `asof`.

    Each match is weighted by 0.5^(age / half-life). The target for a side is its goals, or a blend
    of goals and xG where the match has xG. Attack and defence strengths carry a Gaussian prior
    (mean from `priors`, else `default`; sd `prior_sd`), which keeps the fit stable on few matches
    and gives promoted teams a sensible starting point. ρ is then fitted on the actual scores.
    """
    used = [m for m in matches if m.date < asof]
    if not used:
        return TeamStrength(default=default, attack={t: p[0] for t, p in (priors or {}).items()}, defence={t: p[1] for t, p in (priors or {}).items()})
    teams = sorted({m.home for m in used} | {m.away for m in used}, key=str)
    idx = {t: i for i, t in enumerate(teams)}
    n = len(teams)
    h = np.array([idx[m.home] for m in used])
    a = np.array([idx[m.away] for m in used])
    w = np.array([0.5 ** (max((asof - m.date).total_seconds(), 0.0) / 86400.0 / half_life_days) for m in used])

    def target(goals, xg):
        return goals if xg is None else (1 - xg_weight) * goals + xg_weight * xg

    yh = np.array([target(m.home_goals, m.home_xg) for m in used], dtype=float)
    ya = np.array([target(m.away_goals, m.away_xg) for m in used], dtype=float)
    prior = np.array([(priors or {}).get(t, default) for t in teams], dtype=float)
    lam = 1.0 / (2.0 * prior_sd**2)

    def unpack(x):
        return x[0], x[1], x[2 : 2 + n], x[2 + n :]

    def nll(x):
        mu, home, att, dfn = unpack(x)
        lh = mu + home + att[h] - dfn[a]
        la = mu + att[a] - dfn[h]
        eh, ea = np.exp(lh), np.exp(la)
        val = float(np.sum(w * (eh - yh * lh + ea - ya * la)) + lam * (np.sum((att - prior[:, 0]) ** 2) + np.sum((dfn - prior[:, 1]) ** 2)))
        gh, ga = w * (eh - yh), w * (ea - ya)
        g = np.zeros_like(x)
        g[0] = gh.sum() + ga.sum()
        g[1] = gh.sum()
        g_att = np.bincount(h, gh, n) + np.bincount(a, ga, n) + 2 * lam * (att - prior[:, 0])
        g_def = -np.bincount(a, gh, n) - np.bincount(h, ga, n) + 2 * lam * (dfn - prior[:, 1])
        g[2 : 2 + n], g[2 + n :] = g_att, g_def
        return val, g

    x0 = np.concatenate([[math.log(max(ya.mean(), 0.1)), 0.2], prior[:, 0], prior[:, 1]])
    sol = minimize(nll, x0, jac=True, method="L-BFGS-B")
    mu, home, att, dfn = unpack(sol.x)

    out = TeamStrength(
        mu=float(mu), home_adv=float(home), default=default, matches=len(used),
        attack={t: float(att[i]) for t, i in idx.items()}, defence={t: float(dfn[i]) for t, i in idx.items()},
    )
    for t, p in (priors or {}).items():
        out.attack.setdefault(t, p[0])
        out.defence.setdefault(t, p[1])
    out.rho = _fit_rho(used, w, out) if len(used) >= 100 else DEFAULT_RHO
    return out


def _fit_rho(matches: Sequence[Match], w: np.ndarray, s: TeamStrength) -> float:
    lams = [s.lambdas(m.home, m.away) for m in matches]

    def nll(rho):
        total = 0.0
        for (lh, la), m, wi in zip(lams, matches, w):
            x, y = m.home_goals, m.away_goals
            if x == 0 and y == 0:
                tau = 1 - lh * la * rho
            elif x == 0 and y == 1:
                tau = 1 + lh * rho
            elif x == 1 and y == 0:
                tau = 1 + la * rho
            elif x == 1 and y == 1:
                tau = 1 - rho
            else:
                continue
            total -= wi * math.log(max(tau, 1e-9))
        return total

    return float(minimize_scalar(nll, bounds=(-0.25, 0.25), method="bounded").x)


def newcomer_priors(previous: Sequence[Match], current_teams: Iterable[Hashable], asof: datetime) -> dict:
    """Prior (attack, defence) for each current team that didn't play in `previous` (the promoted
    sides): the mean strength of the teams that left the league, i.e. the relegated sides they
    replaced. That needs no tuned constant. Teams that stayed need no prior: their previous-season
    matches are in the fit itself.
    """
    if not previous:
        return {}
    base = fit_dixon_coles(previous, asof)
    current = set(current_teams)
    gone = [t for t in base.attack if t not in current]
    if not gone:
        return {}
    mean = (float(np.mean([base.attack[t] for t in gone])), float(np.mean([base.defence[t] for t in gone])))
    return {t: mean for t in current if t not in base.attack}


# ---------------------------------------------------------------------------------------------------
# The horizon


def blend(lam_odds: float, lam_model: float, w: float = ODDS_WEIGHT) -> float:
    """Geometric blend of a market λ and a model λ (weight `w` on the market)."""
    return math.exp(w * math.log(lam_odds) + (1 - w) * math.log(lam_model))


@dataclass(frozen=True)
class FixtureLambda:
    fixture: int
    gw: int
    home: int  # FPL team ids
    away: int
    lam_home: float
    lam_away: float
    source: str  # "odds+dixon_coles", "odds" or "dixon_coles"
    rho: float = DEFAULT_RHO

    def for_team(self, team: int) -> tuple[float, float]:
        """(goals the team is expected to score, goals it is expected to concede)."""
        return (self.lam_home, self.lam_away) if team == self.home else (self.lam_away, self.lam_home)

    def clean_sheet(self, team: int) -> float:
        p = grid_probs(score_grid(self.lam_home, self.lam_away, self.rho))
        return p["home_clean_sheet"] if team == self.home else p["away_clean_sheet"]


def fixture_lambdas(
    fixtures: Iterable[Mapping],
    gws: Sequence[int],
    team_names: Mapping[int, str],
    model: TeamStrength | None,
    odds_rows: Iterable[Mapping] = (),
    *,
    odds_gw: int | None = None,
    odds_weight: float = ODDS_WEIGHT,
) -> list[FixtureLambda]:
    """Goal expectations for every fixture in `gws`.

    `fixtures` is FPL's fixtures list; `odds_rows` are football-data.co.uk rows
    (`{"home", "away", "odds": {...}}`), matched to fixtures of `odds_gw` (default: the first GW)
    by team names. A fixture with odds takes the market λ blended with the model; the others take
    the model alone, or league averages if there is no model either.
    """
    odds_gw = gws[0] if odds_gw is None and gws else odds_gw
    by_teams = {}
    for r in odds_rows:
        lam = lambdas_from_odds(r.get("odds", {}), model.rho if model else DEFAULT_RHO)
        if lam:
            by_teams[(team_key(r["home"]), team_key(r["away"]))] = lam
    out = []
    for f in fixtures:
        if f.get("event") not in gws:
            continue
        hn, an = team_key(team_names[f["team_h"]]), team_key(team_names[f["team_a"]])
        m = model.lambdas(hn, an) if model else None
        o = by_teams.get((hn, an)) if f["event"] == odds_gw else None
        if o and m:
            lh, la, src = blend(o[0], m[0], odds_weight), blend(o[1], m[1], odds_weight), "odds+dixon_coles"
        elif o:
            lh, la, src = o[0], o[1], "odds"
        elif m:
            lh, la, src = m[0], m[1], "dixon_coles"
        else:
            lh, la, src = LEAGUE_HOME_GOALS, LEAGUE_AWAY_GOALS, "league_average"
        out.append(FixtureLambda(f["id"], f["event"], f["team_h"], f["team_a"], float(lh), float(la), src, model.rho if model else DEFAULT_RHO))
    return out
