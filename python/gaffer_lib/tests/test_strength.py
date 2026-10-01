"""gaffer_lib.strength: odds de-vig, the score grid, Dixon-Coles and the horizon (FR-DAT-09)."""

import math
from datetime import datetime, timedelta

import numpy as np
import pytest
from hypothesis import given, settings, strategies as st

from gaffer_lib import strength as S


# --- de-vig ---------------------------------------------------------------------------------------


def test_devig_hand_worked():
    # Implied 1/2 + 1/4 + 1/4 = 1: no margin, probabilities unchanged.
    assert S.devig([2.0, 4.0, 4.0]) == pytest.approx([0.5, 0.25, 0.25])
    # 1/1.8 + 1/3.6 + 1/4.5 = 0.5556 + 0.2778 + 0.2222 = 1.0556 (5.56% margin).
    p = S.devig([1.8, 3.6, 4.5])
    assert p == pytest.approx([0.5556 / 1.0556, 0.2778 / 1.0556, 0.2222 / 1.0556], abs=1e-4)
    assert sum(p) == pytest.approx(1.0)


@given(st.lists(st.floats(min_value=1.01, max_value=500), min_size=2, max_size=5))
def test_devig_sums_to_one_and_keeps_order(odds):
    p = S.devig(odds)
    assert sum(p) == pytest.approx(1.0)
    assert all(0 < x < 1 for x in p)
    # A shorter price is never a smaller probability.
    assert all((p[i] >= p[j]) for i in range(len(odds)) for j in range(len(odds)) if odds[i] < odds[j])


@pytest.mark.parametrize("bad", [[1.0, 2.0], [0.5, 3.0], [], [2.0, float("nan")], [2.0, None]])
def test_devig_rejects_impossible_odds(bad):
    with pytest.raises(ValueError):
        S.devig(bad)


# --- score grid -----------------------------------------------------------------------------------


def test_score_grid_known_clean_sheet_probability():
    # Independent Poissons: P(away scores 0) = e^-1.0, P(home scores 0) = e^-1.5, P(0-0) = e^-2.5.
    g = S.score_grid(1.5, 1.0, rho=0.0, max_goals=15)
    p = S.grid_probs(g)
    assert g.sum() == pytest.approx(1.0)
    assert p["home_clean_sheet"] == pytest.approx(math.exp(-1.0), abs=1e-9)
    assert p["away_clean_sheet"] == pytest.approx(math.exp(-1.5), abs=1e-9)
    assert g[0, 0] == pytest.approx(math.exp(-2.5), abs=1e-9)
    assert p["home"] + p["draw"] + p["away"] == pytest.approx(1.0)
    # P(total <= 2) for Poisson(2.5) = e^-2.5 (1 + 2.5 + 3.125).
    assert p["over25"] == pytest.approx(1 - math.exp(-2.5) * 6.625, abs=1e-9)


def test_dixon_coles_correction_moves_only_the_four_low_scores():
    lh, la, rho = 1.4, 1.1, -0.1
    base, dc = S.score_grid(lh, la, 0.0), S.score_grid(lh, la, rho)
    z = dc[3, 2] / base[3, 2]  # the renormalisation constant
    assert dc[0, 0] / base[0, 0] / z == pytest.approx(1 - lh * la * rho)
    assert dc[0, 1] / base[0, 1] / z == pytest.approx(1 + lh * rho)
    assert dc[1, 0] / base[1, 0] / z == pytest.approx(1 + la * rho)
    assert dc[1, 1] / base[1, 1] / z == pytest.approx(1 - rho)
    assert dc[2, 0] / base[2, 0] == pytest.approx(z)
    # Negative rho makes 0-0 and 1-1 more likely, so draws rise.
    assert S.grid_probs(dc)["draw"] > S.grid_probs(base)["draw"]


@settings(max_examples=40, deadline=None)
@given(st.floats(0.3, 3.5), st.floats(0.3, 3.5))
def test_lambdas_round_trip_through_market_probabilities(lh, la):
    p = S.grid_probs(S.score_grid(lh, la, S.DEFAULT_RHO))
    got = S.lambdas_from_probs(p["home"], p["away"], p["over25"])
    assert got == pytest.approx((lh, la), rel=2e-3)


def test_lambdas_from_a_real_odds_row():
    # Arsenal v Coventry, 2026-08-21 (football-data.co.uk E0.csv): a heavy home favourite.
    row = {"AvgH": 1.19, "AvgD": 6.77, "AvgA": 14.19, "Avg>2.5": 1.55, "Avg<2.5": 2.38}
    lh, la = S.lambdas_from_odds(row)
    assert lh > 2.0 and la < 0.8
    p = S.grid_probs(S.score_grid(lh, la, S.DEFAULT_RHO))
    ph, _, pa = S.devig([1.19, 6.77, 14.19])
    assert p["home"] == pytest.approx(ph, abs=0.02) and p["away"] == pytest.approx(pa, abs=0.02)
    assert p["over25"] == pytest.approx(S.devig([1.55, 2.38])[0], abs=0.02)


def test_lambdas_from_odds_falls_back_between_books_and_reports_none():
    assert S.lambdas_from_odds({}) is None
    assert S.lambdas_from_odds({"AvgH": None, "B365H": 2.0, "B365D": 3.5, "B365A": 3.8}) is not None
    # No over/under price: the total stays near the league average.
    lh, la = S.lambdas_from_odds({"AvgH": 2.0, "AvgD": 3.5, "AvgA": 3.8})
    assert lh > la and 2.0 < lh + la < 3.6


# --- Dixon-Coles ----------------------------------------------------------------------------------

T0 = datetime(2026, 1, 1)


def _league(n_rounds=6, seed=1):
    """A synthetic league with known strengths: A strong, D weak."""
    rng = np.random.default_rng(seed)
    att = {"A": 0.4, "B": 0.1, "C": -0.1, "D": -0.4}
    dfn = {"A": 0.3, "B": 0.0, "C": 0.0, "D": -0.3}
    out, day = [], 0
    for _ in range(n_rounds):
        for h in att:
            for a in att:
                if h == a:
                    continue
                lh = math.exp(0.1 + 0.25 + att[h] - dfn[a])
                la = math.exp(0.1 + att[a] - dfn[h])
                out.append(S.Match(T0 + timedelta(days=day), h, a, int(rng.poisson(lh)), int(rng.poisson(la))))
                day += 1
    return out, att, dfn


def test_dixon_coles_recovers_the_order_of_known_strengths():
    matches, att, dfn = _league(n_rounds=12)
    s = S.fit_dixon_coles(matches, T0 + timedelta(days=1000), half_life_days=10_000, prior_sd=1.0)
    assert sorted(att, key=att.get) == sorted(s.attack, key=s.attack.get)
    assert s.defence["A"] > s.defence["D"]
    assert s.home_adv > 0
    lh, la = s.lambdas("A", "D")
    assert lh > 2.0 > 0.8 > la
    assert s.matches == len(matches)


def test_dixon_coles_uses_only_matches_before_asof():
    matches, *_ = _league()
    asof = matches[30].date
    a = S.fit_dixon_coles(matches, asof)
    # Rewrite every later result: the fit must not change (no leakage).
    tampered = matches[:30] + [S.Match(m.date, m.home, m.away, 9, 0) for m in matches[30:]]
    b = S.fit_dixon_coles(tampered, asof)
    assert a.attack == b.attack and a.defence == b.defence and a.mu == b.mu and a.rho == b.rho
    assert a.matches == 30


def test_time_decay_favours_recent_form():
    old = [S.Match(T0, "A", "B", 4, 0), S.Match(T0, "B", "A", 0, 4)] * 5
    new = [S.Match(T0 + timedelta(days=700), "A", "B", 0, 3), S.Match(T0 + timedelta(days=700), "B", "A", 3, 0)] * 5
    asof = T0 + timedelta(days=701)
    decayed = S.fit_dixon_coles(old + new, asof, half_life_days=100)
    flat = S.fit_dixon_coles(old + new, asof, half_life_days=1e9)
    assert decayed.attack["B"] > decayed.attack["A"]
    assert abs(flat.attack["A"] - flat.attack["B"]) < abs(decayed.attack["A"] - decayed.attack["B"])


def test_prior_shrinks_a_thin_sample_and_xg_tempers_a_freak_score():
    one = [S.Match(T0, "A", "B", 6, 0)]
    asof = T0 + timedelta(days=1)
    tight = S.fit_dixon_coles(one, asof, prior_sd=0.05)
    loose = S.fit_dixon_coles(one, asof, prior_sd=2.0)
    assert abs(tight.attack["A"]) < abs(loose.attack["A"])
    with_xg = S.fit_dixon_coles([S.Match(T0, "A", "B", 6, 0, 1.2, 1.0)], asof, prior_sd=2.0)
    assert with_xg.lambdas("A", "B")[0] < loose.lambdas("A", "B")[0]


def test_no_matches_gives_priors_and_league_average():
    s = S.fit_dixon_coles([], T0, priors={"A": (0.2, 0.1)})
    lh, la = s.lambdas("X", "Y")
    assert lh == pytest.approx(S.LEAGUE_HOME_GOALS) and la == pytest.approx(S.LEAGUE_AWAY_GOALS)
    assert s.lambdas("A", "Y")[0] > lh


def test_promoted_teams_start_at_the_relegated_teams_strength():
    matches, *_ = _league(n_rounds=10)
    priors, default = S.promoted_default(matches, {"A", "B", "C", "NEW"}, T0 + timedelta(days=500))
    base = S.fit_dixon_coles(matches, T0 + timedelta(days=500))
    assert set(priors) == {"A", "B", "C"}
    assert default == pytest.approx((base.attack["D"], base.defence["D"]))  # D went down, NEW replaces it
    s = S.fit_dixon_coles([], T0, priors=priors, default=default)
    assert s.lambdas("NEW", "A")[0] < s.lambdas("B", "A")[0]


# --- the horizon ----------------------------------------------------------------------------------

NAMES = {1: "Arsenal", 2: "Spurs", 3: "Man Utd", 4: "Wolves"}
FIXTURES = [
    {"id": 10, "event": 6, "team_h": 1, "team_a": 2},
    {"id": 11, "event": 6, "team_h": 3, "team_a": 4},
    {"id": 12, "event": 7, "team_h": 2, "team_a": 1},
    {"id": 13, "event": None, "team_h": 4, "team_a": 3},
    {"id": 14, "event": 9, "team_h": 4, "team_a": 3},
]
ODDS = [{"home": "Arsenal", "away": "Tottenham", "odds": {"AvgH": 1.6, "AvgD": 4.2, "AvgA": 5.5, "Avg>2.5": 1.7, "Avg<2.5": 2.15}}]


def test_fixture_lambdas_sources():
    model = S.TeamStrength(attack={"Arsenal": 0.3}, defence={"Arsenal": 0.2})
    out = {f.fixture: f for f in S.fixture_lambdas(FIXTURES, [6, 7, 8], NAMES, model, ODDS)}
    assert set(out) == {10, 11, 12}  # unscheduled and out-of-horizon fixtures are left out
    assert out[10].source == "odds+dixon_coles"  # football-data's "Tottenham" is FPL's "Spurs"
    assert out[11].source == "dixon_coles"  # no odds row for this fixture
    assert out[12].source == "dixon_coles"  # odds apply to the next GW only
    o = S.lambdas_from_odds(ODDS[0]["odds"], model.rho)
    m = model.lambdas("Arsenal", "Spurs")
    assert out[10].lam_home == pytest.approx(S.blend(o[0], m[0]))
    assert min(o[0], m[0]) <= out[10].lam_home <= max(o[0], m[0])
    assert out[10].for_team(2) == (out[10].lam_away, out[10].lam_home)
    assert out[10].clean_sheet(1) == pytest.approx(S.grid_probs(S.score_grid(out[10].lam_home, out[10].lam_away, model.rho))["home_clean_sheet"])


def test_fixture_lambdas_without_odds_or_model():
    model = S.TeamStrength()
    assert {f.source for f in S.fixture_lambdas(FIXTURES, [6], NAMES, model, [])} == {"dixon_coles"}
    assert {f.source for f in S.fixture_lambdas(FIXTURES, [6], NAMES, None, ODDS)} == {"odds", "league_average"}


def test_blend_is_geometric():
    assert S.blend(2.0, 1.0, 1.0) == pytest.approx(2.0)
    assert S.blend(2.0, 1.0, 0.0) == pytest.approx(1.0)
    assert S.blend(2.0, 0.5, 0.5) == pytest.approx(1.0)
