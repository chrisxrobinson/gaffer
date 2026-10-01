"""gaffer_lib.xp: component expected points scored with rules.Scoring."""

import pytest

# The model needs the sandbox's analytics stack; without it these tests are skipped (README, "Develop").
for _dep in ("numpy", "scipy"):
    pytest.importorskip(_dep)

import math
from datetime import datetime

from conftest import DATA, real_bootstrap_rules_part
from hypothesis import given, settings, strategies as st

from gaffer_lib import rules as R, xp as X
from gaffer_lib.inputs import ModelInputs, PlayerData, from_snapshot
from gaffer_lib.minutes import Minutes
from gaffer_lib.snapshot import Snapshot
from gaffer_lib.strength import Match

BOOT = real_bootstrap_rules_part()
SCORING = R.Scoring.from_bootstrap(BOOT)
RULES = R.Rules.from_bootstrap(BOOT)
GKP, DEF, MID, FWD = 1, 2, 3, 4
CERTAIN = Minutes(p_start=1.0, p_play=1.0, p60=1.0, xmins=90.0, mins_start=90.0)


# --- Poisson helpers ------------------------------------------------------------------------------


def test_poisson_helpers_hand_worked():
    assert X.expected_floor_div(1.7, 1) == pytest.approx(1.7)  # E[floor(X/1)] = E[X]
    assert X.prob_at_least(1.3, 1) == pytest.approx(1 - math.exp(-1.3))
    assert X.prob_at_least(1.3, 0) == 1.0
    # E[floor(X/2)] for Poisson(1): sum floor(k/2) e^-1 / k! = e^-1 (1/2 + 1/6 + 2/24 + 2/120 + 3/720 + ...).
    assert X.expected_floor_div(1.0, 2) == pytest.approx(math.exp(-1) * (1 / 2 + 1 / 6 + 2 / 24 + 2 / 120 + 3 / 720 + 3 / 5040 + 4 / 40320), abs=1e-5)
    assert X.expected_floor_div(0.0, 3) == 0.0
    assert X.prob_at_least(0.0, 10) == 0.0


# --- xP is rules.Scoring applied to the expected stat line ---------------------------------------

stat_lines = st.fixed_dictionaries({
    "minutes": st.integers(0, 90), "goals_scored": st.integers(0, 4), "assists": st.integers(0, 3), "clean_sheets": st.integers(0, 1),
    "goals_conceded": st.integers(0, 7), "saves": st.integers(0, 12), "bonus": st.integers(0, 3), "defensive_contribution": st.integers(0, 25),
})


@given(stat_lines, st.sampled_from([GKP, DEF, MID, FWD]))
def test_xp_of_a_known_stat_line_equals_rules_scoring(stats, element_type):
    exp = X.expectation_from_stats(stats, element_type, SCORING)
    pts = X.points_from_expectation(exp, element_type, SCORING)
    assert sum(pts.values()) == pytest.approx(SCORING.total(stats, element_type))


def test_xp_hand_worked_goalkeeper_and_midfielder():
    # GK, 90 minutes, clean sheet, 7 saves, 2 bonus: 2 + 4 + 2 + 2 = 10.
    gk = {"minutes": 90, "clean_sheets": 1, "saves": 7, "bonus": 2}
    assert sum(X.points_from_expectation(X.expectation_from_stats(gk, GKP, SCORING), GKP, SCORING).values()) == 10 == SCORING.total(gk, GKP)
    # MID, 70 minutes, a goal, an assist, clean sheet, 12 defensive contributions: 2 + 5 + 3 + 1 + 2 = 13.
    mid = {"minutes": 70, "goals_scored": 1, "assists": 1, "clean_sheets": 1, "defensive_contribution": 12}
    assert sum(X.points_from_expectation(X.expectation_from_stats(mid, MID, SCORING), MID, SCORING).values()) == 13 == SCORING.total(mid, MID)


def test_scoring_values_come_from_game_config():
    boot = real_bootstrap_rules_part()
    boot["game_config"]["scoring"]["goals_scored"]["FWD"] = 9
    changed = R.Scoring.from_bootstrap(boot)
    assert X.points_from_expectation({"goals": 0.5}, FWD, changed)["goals"] == pytest.approx(4.5)
    assert X.points_from_expectation({"goals": 0.5}, FWD, SCORING)["goals"] == pytest.approx(2.0)


# --- one fixture ----------------------------------------------------------------------------------

RATES = {"xg": 0.1, "xa": 0.2, "saves": 3.0, "bonus": 0.3, "defcon": 9.0}


def test_fixture_expectation_defender_hand_worked():
    exp = X.fixture_expectation(RATES, CERTAIN, DEF, SCORING, lam_for=1.5, lam_against=1.0, p_clean_sheet=0.37, attack_factor=1.2, assist_ratio=1.1)
    assert exp["p_long"] == 1.0 and exp["p_short"] == 0.0
    assert exp["goals"] == pytest.approx(0.1 * 1.2)
    assert exp["assists"] == pytest.approx(0.2 * 1.2 * 1.1)
    assert exp["clean_sheet"] == pytest.approx(0.37)
    assert exp["conceded_units"] == pytest.approx(X.expected_floor_div(1.0, 2))
    assert exp["save_units"] == 0.0
    assert exp["defcon"] == pytest.approx(X.prob_at_least(9.0, 10))
    pts = X.points_from_expectation(exp, DEF, SCORING)
    want = 2 + 6 * 0.12 + 3 * 0.264 + 4 * 0.37 - X.expected_floor_div(1.0, 2) + 2 * X.prob_at_least(9.0, 10) + 0.3
    assert sum(pts.values()) == pytest.approx(want)


def test_fixture_expectation_by_position():
    kw = dict(lam_for=1.4, lam_against=1.6, p_clean_sheet=0.2)
    gk = X.fixture_expectation(RATES, CERTAIN, GKP, SCORING, save_factor=1.5, **kw)
    assert gk["save_units"] == pytest.approx(X.expected_floor_div(3.0 * 1.5, 3)) and gk["defcon"] == 0.0
    fwd = X.fixture_expectation(RATES, CERTAIN, FWD, SCORING, **kw)
    assert fwd["conceded_units"] == 0.0 and fwd["save_units"] == 0.0
    assert fwd["defcon"] == pytest.approx(X.prob_at_least(9.0, 12))
    assert X.points_from_expectation(fwd, FWD, SCORING)["clean_sheet"] == 0.0


def test_minutes_gate_every_component():
    none = Minutes(0.0, 0.0, 0.0, 0.0, 90.0)
    exp = X.fixture_expectation(RATES, none, DEF, SCORING, lam_for=1.5, lam_against=1.0, p_clean_sheet=0.4)
    assert sum(X.points_from_expectation(exp, DEF, SCORING).values()) == 0.0
    cameo = Minutes(p_start=0.0, p_play=1.0, p60=0.0, xmins=20.0, mins_start=90.0)
    exp = X.fixture_expectation(RATES, cameo, DEF, SCORING, lam_for=1.5, lam_against=1.0, p_clean_sheet=0.4)
    assert exp["clean_sheet"] == 0.0 and exp["p_short"] == 1.0 and exp["defcon"] == 0.0


# --- rates ----------------------------------------------------------------------------------------


def _p(pid, team, et, cost, minutes=0, games=5, starts=None, recent=True, **stats):
    starts = round(minutes / 90) if starts is None else starts
    rows = [{"gw": g, "games": 1, "minutes": 90 if g <= starts else 0, "starts": int(g <= starts)} for g in range(1, games + 1)] if recent else []
    return PlayerData(id=pid, team=team, element_type=et, now_cost=cost, name=f"p{pid}", totals={"games": games, "minutes": minutes, "starts": starts, **stats}, recent=rows)


def test_rates_shrink_towards_a_price_aware_prior():
    pool = {i: _p(i, 1, FWD, 50 + 5 * i, minutes=450, xg=0.5 * i, xa=0.2 * i, assists=0.3 * i) for i in range(1, 11)}
    priors = X.fit_rate_priors(pool)
    assert priors.prior(FWD, "xg", 100) > priors.prior(FWD, "xg", 60) > 0
    assert priors.assist_ratio == pytest.approx(1.0)  # too little xA in the pool to estimate it
    newcomer = _p(99, 1, FWD, 100, minutes=0)
    assert X.player_rates(newcomer, priors)["xg"] == pytest.approx(priors.prior(FWD, "xg", 100))
    hot = _p(98, 1, FWD, 60, minutes=90, xg=2.0)
    r = X.player_rates(hot, priors)["xg"]
    assert priors.prior(FWD, "xg", 60) < r < 2.0  # one big game moves the rate, but not to 2.0 per 90
    # The previous season counts at half weight.
    vet = _p(97, 1, FWD, 60, minutes=0)
    vet.prev = {"minutes": 3420, "xg": 19.0}
    assert X.player_rates(vet, priors)["xg"] == pytest.approx((9.5 + 6 * priors.prior(FWD, "xg", 60)) / (19 + 6))


# --- the projection -------------------------------------------------------------------------------


def synthetic_inputs(odds=True, **kw):
    teams = {1: "Arsenal", 2: "Spurs", 3: "Wolves", 4: "Hull City"}
    fixtures = [
        {"id": 1, "event": 6, "team_h": 1, "team_a": 2},
        {"id": 2, "event": 6, "team_h": 3, "team_a": 4},
        {"id": 3, "event": 7, "team_h": 2, "team_a": 3},  # GW7: Arsenal and Hull blank
        {"id": 4, "event": 8, "team_h": 1, "team_a": 3},
        {"id": 5, "event": 8, "team_h": 4, "team_a": 1},  # GW8: Arsenal double
        {"id": 6, "event": 8, "team_h": 2, "team_a": 4},
    ]
    players = {}
    pid = 0
    for team in teams:
        for et, n in ((GKP, 2), (DEF, 5), (MID, 5), (FWD, 3)):
            for j in range(n):
                pid += 1
                starter = j < {GKP: 1, DEF: 4, MID: 4, FWD: 2}[et]
                players[pid] = _p(pid, team, et, 45 + 10 * (et - 1) + 5 * j, minutes=450 if starter else 0, xg=0.4 * (et - 1) * starter, xa=0.5 * starter,
                                  assists=0.6 * starter, saves=15 * (et == GKP) * starter, bonus=2 * starter, defcon=40 * (et in (DEF, MID)) * starter)
    odds_rows = [{"home": "Arsenal", "away": "Tottenham", "odds": {"AvgH": 1.5, "AvgD": 4.5, "AvgA": 6.5, "Avg>2.5": 1.6, "Avg<2.5": 2.3}},
                 {"home": "Wolves", "away": "Hull", "odds": {"AvgH": 2.0, "AvgD": 3.4, "AvgA": 3.9, "Avg>2.5": 2.0, "Avg<2.5": 1.8}}]
    matches = [Match(datetime(2026, 9, 1), "arsenal", "wolves", 3, 0), Match(datetime(2026, 9, 8), "hull", "spurs", 1, 1)]
    return ModelInputs(season="2026/27", next_gw=6, deadline=datetime(2026, 10, 10, 10), players=players, team_names=teams, fixtures=fixtures,
                       scoring=SCORING, rules=RULES, odds_rows=odds_rows if odds else [], odds_available=odds, odds_reason=None if odds else "HTTP 503",
                       matches=matches, **kw)


def test_project_blank_double_and_bench():
    inp = synthetic_inputs()
    proj = X.project(inp, horizon=3)
    assert proj.gws == [6, 7, 8]
    arsenal_fwd = next(p for p in inp.players.values() if p.team == 1 and p.element_type == FWD and p.totals["minutes"] > 0)
    spurs_fwd = next(p for p in inp.players.values() if p.team == 2 and p.element_type == FWD and p.totals["minutes"] > 0)
    bench = next(p for p in inp.players.values() if p.team == 1 and p.element_type == FWD and p.totals["minutes"] == 0)
    x = proj.xp[arsenal_fwd.id]
    assert x[7] == 0.0 and proj.xmins[arsenal_fwd.id][7] == 0.0 and proj.p_start[arsenal_fwd.id][7] == 0.0  # blank
    assert x[8] > 1.6 * x[6] * 0.6 and proj.xmins[arsenal_fwd.id][8] == pytest.approx(2 * proj.xmins[arsenal_fwd.id][6])  # double
    assert x[6] > proj.xp[spurs_fwd.id][6]  # the home favourite's striker
    assert proj.xp[bench.id][6] < 1.0 < x[6]
    assert proj.warnings == []
    assert {f.source for f in proj.fixtures if f.gw == 6} == {"odds+dixon_coles"}
    assert {f.source for f in proj.fixtures if f.gw > 6} == {"dixon_coles"}
    comps = proj.components[arsenal_fwd.id][6]
    assert sum(comps.values()) == pytest.approx(x[6]) and comps["appearance"] > 1.5


def test_project_without_odds_warns_and_still_completes():
    """FR-DAT-09: with the odds source down the projection completes on Dixon-Coles and says so."""
    proj = X.project(synthetic_inputs(odds=False), horizon=3)
    assert proj.warnings == ["odds unavailable — team strength from Dixon-Coles (HTTP 503)"]
    assert {f.source for f in proj.fixtures} == {"dixon_coles"}
    assert all(v >= 0 for row in proj.xp.values() for v in row.values())
    assert max(row[6] for row in proj.xp.values()) > 3


def test_project_partial_odds_says_how_many():
    inp = synthetic_inputs()
    inp.odds_rows = inp.odds_rows[:1]
    assert X.project(inp, horizon=1).warnings == ["odds cover 1 of 2 GW6 fixtures; the rest use Dixon-Coles"]


def test_availability_and_overrides_flow_into_xp():
    inp = synthetic_inputs()
    star = next(p for p in inp.players.values() if p.team == 3 and p.element_type == MID and p.totals["minutes"] > 0)
    base = X.project(inp, horizon=3)
    star.status, star.chance = "i", 0
    hurt = X.project(inp, horizon=3)
    assert hurt.xp[star.id][6] == 0.0 and 0 < hurt.xp[star.id][8] < base.xp[star.id][8]
    over = X.project(inp, horizon=3, xmins_overrides=[{"player": star.id, "gw": 6, "xmins": 90}])
    assert over.xp[star.id][6] > base.xp[star.id][6] * 0.95
    assert over.overrides_applied == [{"player": star.id, "gw": 6, "xmins": 90.0}]


def test_projection_uses_nothing_after_the_deadline():
    inp = synthetic_inputs()
    a = X.project(inp, horizon=3)
    inp.matches = inp.matches + [Match(datetime(2026, 10, 11), "wolves", "arsenal", 9, 0)]  # played after the deadline
    b = X.project(inp, horizon=3)
    assert a.xp == b.xp


def test_compare_with_ep_next():
    inp = synthetic_inputs()
    proj = X.project(inp, horizon=1)
    for p in inp.players.values():
        p.ep_next = round(proj.xp[p.id][6] * 1.1, 1)
    c = X.compare_with_ep_next(inp, proj)
    assert c["gw"] == 6 and c["correlation"] > 0.99 and c["mean_ep_next"] > c["mean_xp"] and len(c["largest_gaps"]) == 8


@settings(max_examples=25, deadline=None)
@given(st.floats(0.2, 3.5), st.floats(0.2, 3.5), st.sampled_from([GKP, DEF, MID, FWD]), st.floats(0, 1))
def test_fixture_xp_is_bounded_and_falls_with_goals_against_for_defenders(lam_for, lam_against, et, avail):
    mins = Minutes(avail, avail, avail * 0.9, avail * 85, 88.0)
    def total(la):
        e = X.fixture_expectation(RATES, mins, et, SCORING, lam_for=lam_for, lam_against=la, p_clean_sheet=math.exp(-la))
        return sum(X.points_from_expectation(e, et, SCORING).values())
    t = total(lam_against)
    assert -2 <= t <= 15
    if et == DEF:
        assert total(lam_against + 0.5) <= t + 1e-9


# --- a real snapshot ------------------------------------------------------------------------------


def test_from_snapshot_on_the_frozen_real_snapshot():
    """The M2 snapshot fixture is trimmed (no per-player stats, no odds): inputs still load and project."""
    inp = from_snapshot(Snapshot(DATA / "snapshot-entry-1"))
    assert inp.next_gw == 6 and inp.season == "2026/27" and len(inp.team_names) == 20
    assert not inp.odds_available
    proj = X.project(inp, horizon=6)
    assert proj.gws == [6, 7, 8, 9, 10, 11]
    assert proj.warnings and proj.warnings[0].startswith("odds unavailable — team strength from Dixon-Coles")
    assert len(proj.xp) == len(inp.players)


def test_snapshot_with_the_odds_source_down_falls_back_to_dixon_coles(tmp_path):
    """FR-DAT-09: the `odds.json` fpl_snapshot writes when football-data.co.uk is down (see
    packages/pi-gaffer/test/odds.test.ts) still gives a projection, with the specified warning."""
    import json
    import shutil

    d = tmp_path / "snap"
    shutil.copytree(DATA / "snapshot-model", d)
    down = {"schema": "gaffer.odds/1", "source": "football-data.co.uk", "available": False, "reason": "football-data.co.uk unavailable: HTTP 503", "fixtures": [], "results": {}}
    (d / "odds.json").write_text(json.dumps(down))
    inp = from_snapshot(Snapshot(d))
    assert not inp.odds_available and inp.prev_matches == [] and len(inp.matches) == 50  # this season's FPL results only
    proj = X.project(inp, horizon=6)
    assert proj.warnings == ["odds unavailable — team strength from Dixon-Coles (football-data.co.uk unavailable: HTTP 503)"]
    assert {f.source for f in proj.fixtures} == {"dixon_coles"} and proj.strength.matches == 50
    assert max(row[6] for row in proj.xp.values()) > 4

    # With the source up, the previous season's results and this season's xG feed the model too.
    up = from_snapshot(Snapshot(DATA / "snapshot-model"))
    assert up.odds_available and len(up.prev_matches) == 380 and len(up.matches) == 50
    assert sum(m.home_xg is not None for m in up.matches) == 50
    assert up.odds_reason == "football-data.co.uk lists no Premier League fixtures yet"  # frozen in an international break
    assert X.project(up, horizon=1).warnings[0].startswith("odds unavailable — team strength from Dixon-Coles (football-data.co.uk lists no")
    assert all(len(p.recent) <= 5 and p.totals["games"] == 5 for p in up.players.values())
