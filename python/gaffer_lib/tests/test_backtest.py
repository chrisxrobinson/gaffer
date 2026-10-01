"""gaffer_lib.backtest: replay mechanics, baselines and the no-leakage guarantee (FR-EVL-01).

The tests run on a small synthetic season (6 clubs, 6 GWs) so they need no third-party data. The
real seasons live in gitignored var/history (tools/fetch_history.py); one test checks them if present.
"""

import pytest

# The model needs the sandbox's analytics stack; without it these tests are skipped (README, "Develop").
for _dep in ("numpy", "scipy", "pandas"):
    pytest.importorskip(_dep)

import copy
import os
import random
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd

from gaffer_lib import backtest as B, plan as P, rules as R

TEAMS = ["Arsenal", "Chelsea", "Everton", "Fulham", "Leeds", "Wolves"]
SHAPE = [("GK", 2), ("DEF", 6), ("MID", 6), ("FWD", 4)]
ROUNDS = [  # (home, away) by team id; every GW has 3 fixtures
    [(1, 2), (3, 4), (5, 6)], [(2, 3), (4, 5), (6, 1)], [(1, 3), (2, 5), (4, 6)],
    [(3, 5), (6, 2), (4, 1)], [(1, 5), (2, 4), (3, 6)], [(5, 2), (6, 3), (1, 4)],
]
HAVE_SOLVER = os.path.isfile(os.path.join(os.environ.get(P.SOLVER_DIR_ENV, P.DEFAULT_SOLVER_DIR), "dev", "solver.py"))
needs_solver = pytest.mark.skipif(not HAVE_SOLVER, reason=f"open-fpl-solver not found; set {P.SOLVER_DIR_ENV}")
HISTORY = Path(__file__).resolve().parents[3] / "var" / "history"


def synthetic(seed=7, xp_gws=(1, 2, 3, 4, 5, 6)):
    rng = random.Random(seed)
    players, pid = [], 0
    for t, team in enumerate(TEAMS, start=1):
        for pos, n in SHAPE:
            for j in range(n):
                pid += 1
                players.append({"element": pid, "name": f"{team[:3]}-{pos}{j}", "position": pos, "team": team, "team_id": t,
                                "value": rng.choice([40, 45, 50, 55, 60, 70, 85]), "quality": rng.uniform(0.2, 1.0), "starter": j < {"GK": 1, "DEF": 4, "MID": 4, "FWD": 2}[pos],
                                "selected": rng.randint(1_000, 900_000)})
    rows, fixtures, fid = [], [], 0
    for gw, games in enumerate(ROUNDS, start=1):
        for h, a in games:
            fid += 1
            kickoff = (datetime(2025, 8, 8, 14) + timedelta(days=7 * (gw - 1))).strftime("%Y-%m-%dT%H:%M:%SZ")
            hs, as_ = rng.randint(0, 3), rng.randint(0, 3)
            fixtures.append({"id": fid, "event": gw, "kickoff_time": kickoff, "team_h": h, "team_a": a, "team_h_score": hs, "team_a_score": as_})
            for p in players:
                if p["team_id"] not in (h, a):
                    continue
                plays = p["starter"] and rng.random() < 0.9
                minutes = rng.choice([90, 90, 75, 60]) if plays else rng.choice([0, 0, 15])
                goals = int(plays and p["position"] != "GK" and rng.random() < 0.25 * p["quality"])
                points = (2 if minutes >= 60 else 1 if minutes else 0) + 4 * goals + (rng.randint(0, 3) if plays else 0)
                rows.append({"name": p["name"], "position": p["position"], "team": p["team"], "element": p["element"], "fixture": fid, "GW": gw, "kickoff_time": kickoff,
                             "was_home": p["team_id"] == h, "minutes": minutes, "starts": int(plays), "expected_goals": round(0.3 * p["quality"] * plays, 2),
                             "expected_assists": round(0.2 * p["quality"] * plays, 2), "goals_scored": goals, "assists": 0, "saves": 3 * (p["position"] == "GK") * plays,
                             "bonus": 0, "defensive_contribution": 8 * plays, "total_points": points, "value": p["value"], "selected": p["selected"] + 1000 * gw,
                             # Like the real archive: the GW's xP is recorded after the matches and tracks the GW's own points.
                             "xP": round(0.5 * points + 1.0, 1) if gw in xp_gws else 0.0})
    return pd.DataFrame(rows), pd.DataFrame([{"id": i, "name": n} for i, n in enumerate(TEAMS, start=1)]), pd.DataFrame(fixtures)


def season(merged=None, teams=None, fixtures=None, **kw):
    m, t, f = synthetic(**kw)
    return B.SeasonData("2025-26", m if merged is None else merged, t if teams is None else teams, f if fixtures is None else fixtures)


def tamper_from(gw, seed=99):
    """The same season with every outcome from `gw` on rewritten (results, minutes, points, stats, xP)."""
    m, t, f = synthetic()
    rng = random.Random(seed)
    late = m["GW"] >= gw
    for col, hi in (("minutes", 90), ("starts", 1), ("total_points", 20), ("goals_scored", 3), ("saves", 9), ("defensive_contribution", 20)):
        m.loc[late, col] = [rng.randint(0, hi) for _ in range(int(late.sum()))]
    for col in ("expected_goals", "expected_assists", "xP"):
        m.loc[late, col] = [round(rng.uniform(0, 9), 2) for _ in range(int(late.sum()))]
    f.loc[f["event"] >= gw, ["team_h_score", "team_a_score"]] = 9
    return m, t, f


# --- cut-offs: only what was known before the deadline -------------------------------------------


def test_inputs_at_uses_only_earlier_gws():
    s = season()
    inp = s.inputs_at(3)
    m, _, f = synthetic()
    assert inp.next_gw == 3 and inp.deadline == datetime(2025, 8, 22, 14) - B.DEADLINE_BEFORE_KICKOFF
    for pid in (1, 37, 90):
        past = m[(m["element"] == pid) & (m["GW"] < 3)]
        t = inp.players[pid].totals
        assert t["games"] == len(past) and t["minutes"] == past["minutes"].sum() and t["xg"] == pytest.approx(past["expected_goals"].sum())
        assert [r["gw"] for r in inp.players[pid].recent] == [1, 2]
        assert inp.players[pid].now_cost == m[(m["element"] == pid) & (m["GW"] == 3)]["value"].iloc[0]
    assert len(inp.matches) == 6 and all(mt.date < inp.deadline for mt in inp.matches)
    assert all(fx["team_h_score"] is None and not fx["finished"] for fx in inp.fixtures if fx["event"] >= 3)
    assert all(fx["team_h_score"] is not None and fx["finished"] for fx in inp.fixtures if fx["event"] < 3)
    first = s.inputs_at(1)
    assert first.matches == [] and all(p.totals["games"] == 0 and p.recent == [] for p in first.players.values())


def test_future_results_do_not_change_what_the_model_sees():
    a, b = season().inputs_at(4), season(*tamper_from(4)).inputs_at(4)
    assert a.players == b.players and a.matches == b.matches and a.fixtures == b.fixtures and a.odds_rows == b.odds_rows


def test_official_xp_is_the_previous_gws_value():
    s = season()
    m, *_ = synthetic()
    assert s.official_xp_gw(1) == 1 and s.official_xp_gw(4) == 3 and s.has_fresh_xp(4)
    inp = s.inputs_at(4)
    row = lambda gw: m[(m["element"] == 5) & (m["GW"] == gw)]["xP"].iloc[0]  # noqa: E731
    assert inp.players[5].ep_next == row(3) and (row(3) != row(4) or True)
    # Gaps in the archive (2025/26 has 11 of 38 GWs): a GW after a gap has only a stale value.
    gappy = season(xp_gws=(1, 2, 5))
    assert gappy.xp_gws == [1, 2, 5]
    assert [gappy.has_fresh_xp(g) for g in range(1, 7)] == [True, True, True, False, False, True]
    assert gappy.official_xp_gw(4) == 2 and gappy.official_xp_gw(6) == 5
    assert season(xp_gws=()).official_xp_gw(3) is None


def test_repeated_rows_are_counted_once():
    m, t, f = synthetic()
    doubled = pd.concat([m, m[m["element"] == 5]], ignore_index=True)
    a, b = B.SeasonData("2025-26", m, t, f), B.SeasonData("2025-26", doubled, t, f)
    assert a.actual(2) == b.actual(2) and a.inputs_at(4).players[5] == b.inputs_at(4).players[5]


def test_unregistered_players_are_flagged():
    m, t, f = synthetic()
    m = m[~((m["element"] == 10) & (m["GW"] >= 4))]  # player 10 leaves the game after GW3
    s = B.SeasonData("2025-26", m, t, f)
    assert s.inputs_at(3).players[10].status == "a" and s.inputs_at(4).players[10].status == "u"


def test_gws_without_stats_are_left_out():
    """2022/23's archive has no starts or xG before GW16."""
    m, t, f = synthetic()
    m.loc[m["GW"] <= 2, ["starts", "expected_goals"]] = 0
    s = B.SeasonData("2025-26", m, t, f)
    assert s.stats_from == 3
    inp = s.inputs_at(5)
    assert all(r["gw"] >= 3 for p in inp.players.values() for r in p.recent)
    assert inp.players[1].totals["games"] == 2


# --- scoring --------------------------------------------------------------------------------------

RULES = B.season_rules()
ET = {**{i: 1 for i in (1, 2)}, **{i: 2 for i in range(3, 8)}, **{i: 3 for i in range(8, 13)}, **{i: 4 for i in range(13, 16)}}
LINEUP = {"xi": [1, 3, 4, 5, 6, 8, 9, 10, 11, 13, 14], "bench": [2, 7, 12, 15], "captain": 13, "vice_captain": 8}


def test_score_gw_captain_vice_autosubs_and_hits():
    pts = {p: 2.0 for p in ET}
    mins = {p: 90.0 for p in ET}
    pts[13] = 10.0
    assert B.score_gw(LINEUP, pts, mins, ET, RULES, 0) == {"points": 11 * 2 + 8 + 10, "gross": 40.0, "captain_points": 10.0, "autosubs": 0}
    assert B.score_gw(LINEUP, pts, mins, ET, RULES, 8)["points"] == 32.0
    # The captain doesn't play: the vice is doubled, and the first bench player who keeps a valid formation comes on.
    mins2, pts2 = {**mins, 13: 0.0}, {**pts, 13: 0.0, 8: 6.0, 7: 5.0}
    s = B.score_gw(LINEUP, pts2, mins2, ET, RULES, 0)
    assert s["autosubs"] == 1 and s["captain_points"] == 6.0
    assert s["points"] == (9 * 2 + 6) + 5 + 6  # ten starters + the sub (player 7) + the vice doubled
    # Neither plays: nobody is doubled.
    mins3 = {**mins2, 8: 0.0}
    assert B.score_gw(LINEUP, {**pts2, 8: 0.0}, mins3, ET, RULES, 0)["captain_points"] == 0.0
    # A goalkeeper can only be replaced by the bench goalkeeper.
    s = B.score_gw(LINEUP, {**pts, 2: 9.0}, {**mins, 1: 0.0}, ET, RULES, 0)
    assert s["points"] == 10 * 2 + 9 + 8 + 10 - 0 and s["autosubs"] == 1


def test_season_scoring_follows_the_rule_changes():
    assert B.season_scoring("2025-26")["defensive_contribution"]["DEF"] == 2
    assert B.season_scoring("2024-25")["defensive_contribution"]["DEF"] == 0 and B.season_scoring("2024-25")["goals_scored"]["GKP"] == 10
    assert B.season_scoring("2023-24")["goals_scored"]["GKP"] == 6
    assert B.previous_season("2023-24") == "2022-23" and B.previous_season("2000-01") == "1999-00"


# --- baselines ------------------------------------------------------------------------------------


def start_team(s, gw=1):
    inp = s.inputs_at(gw)
    squad = B.template_squad(inp)
    return inp, B.Team(squad, {p: inp.players[p].now_cost for p in squad}, B.BUDGET - sum(inp.players[p].now_cost for p in squad))


def test_template_squad_is_legal_within_budget_and_most_owned():
    inp, team = start_team(season())
    players = {p: R.Player(p, inp.players[p].team, inp.players[p].element_type) for p in team.squad}
    assert R.check_squad(team.squad, players, inp.rules, cost=B.BUDGET - team.bank, budget=B.BUDGET) == []
    assert team.bank >= 0
    own = sum(inp.players[p].selected for p in team.squad)
    rng = random.Random(3)
    for _ in range(200):  # no random legal squad is more owned
        pick = []
        for t, n in inp.rules.squad_select.items():
            pick += rng.sample([p.id for p in inp.players.values() if p.element_type == t], n)
        legal = not R.check_squad(pick, {p: R.Player(p, inp.players[p].team, inp.players[p].element_type) for p in pick}, inp.rules,
                                  cost=sum(inp.players[p].now_cost for p in pick), budget=B.BUDGET)
        if legal:
            assert sum(inp.players[p].selected for p in pick) <= own


def test_greedy_transfer_takes_the_best_legal_swap():
    s = season()
    inp, team = start_team(s, 2)
    value = {i: (p.ep_next or 0.0) for i, p in inp.players.items()}
    swap = B.greedy_transfer(team, inp, value)
    assert swap is not None
    out, into = swap
    po, pi = inp.players[out], inp.players[into]
    assert pi.element_type == po.element_type and into not in team.squad
    assert pi.now_cost <= team.bank + R.selling_price(team.purchase[out], po.now_cost, inp.rules)
    # Exhaustive check: no legal swap gains more.
    best = 0.0
    for o in team.squad:
        for c in inp.players.values():
            if c.id in team.squad or c.element_type != inp.players[o].element_type:
                continue
            if c.now_cost > team.bank + R.selling_price(team.purchase[o], inp.players[o].now_cost, inp.rules):
                continue
            after = [c.id if x == o else x for x in team.squad]
            if R.check_squad(after, {p: R.Player(p, inp.players[p].team, inp.players[p].element_type) for p in after}, inp.rules):
                continue
            best = max(best, value[c.id] - value[o])
    assert value[into] - value[out] == pytest.approx(best) and best > 0
    assert B.greedy_transfer(team, inp, {i: 1.0 for i in inp.players}) is None  # nothing gains
    before = copy.deepcopy(team)
    B.apply_transfers(team, [swap], inp)
    assert team.bank == before.bank + R.selling_price(before.purchase[out], po.now_cost, inp.rules) - pi.now_cost and team.purchase[into] == pi.now_cost


def test_a_real_life_move_can_leave_four_from_one_club():
    """FPL lets you keep a player who moves to a club you already have three from; you can't add a fifth."""
    m, t, f = synthetic()
    s0 = B.SeasonData("2025-26", m, t, f)
    inp, team = start_team(s0)
    clubs = {}
    for p in team.squad:
        clubs.setdefault(inp.players[p].team, []).append(p)
    full = next(c for c, ps in clubs.items() if len(ps) == 3)
    mover = next(p for p in team.squad if inp.players[p].team != full)
    m.loc[(m["element"] == mover) & (m["GW"] >= 3), "team"] = TEAMS[full - 1]  # he joins the full club before GW3
    s = B.SeasonData("2025-26", m, t, f)
    inp3 = s.inputs_at(3)
    assert sum(inp3.players[p].team == full for p in team.squad) == 4
    for policy in ("B0", "B1", "B2"):
        out = B.run_policy(s, policy, team, gws=[1, 2, 3, 4])  # no crash; nobody else is bought from that club
        final = out.squad
        assert sum(s.inputs_at(4).players[p].team == full for p in final) <= 4
    newcomer = next(p.id for p in inp3.players.values() if p.team == full and p.id not in team.squad and p.element_type == inp3.players[team.squad[0]].element_type)
    grow = team.copy()
    grow.bank = 500
    victim = next(p for p in grow.squad if inp3.players[p].element_type == inp3.players[newcomer].element_type and inp3.players[p].team != full)
    with pytest.raises(AssertionError, match="illegal squad"):
        B.apply_transfers(grow, [(victim, newcomer)], inp3)


def test_baselines_run_a_season_and_follow_their_rule():
    s = season()
    out = B.backtest_season(s, ["B0", "B1", "B2"])
    assert out["official_xp"] == {"gws_with_fresh_value": 6, "of": 6, "coverage": 1.0, "missing_gws": [], "b1_built": True}
    p = out["policies"]
    assert p["B0"]["transfers"] == 0 and p["B0"]["hits"] == 0
    for name in ("B1", "B2"):
        assert p[name]["by_gw"][0]["transfers"] == 0  # the starting squad is fixed
        assert all(g["transfers"] <= 1 and g["hits"] == 0 for g in p[name]["by_gw"])
    assert p["B1"]["transfers"] >= 1
    assert p["B2"]["transfers"] == 0  # the start is already the most-owned squad and ownership ranks don't move here
    for name in ("B0", "B1", "B2"):
        assert p[name]["points"] == pytest.approx(sum(g["points"] for g in p[name]["by_gw"]))
        assert len(p[name]["by_gw"]) == 6
    # B0's captain each week is the squad's highest official xP (the previous GW's value).
    for g in p["B0"]["by_gw"]:
        inp = s.inputs_at(g["gw"])
        assert inp.players[g["captain"]].ep_next == max(inp.players[x].ep_next for x in g["xi"])


def test_b1_holds_when_the_official_xp_is_stale():
    s = season(xp_gws=(1, 2))
    out = B.backtest_season(s, ["B1"])
    assert out["official_xp"]["gws_with_fresh_value"] == 3 and out["official_xp"]["b1_built"] is False and out["official_xp"]["missing_gws"] == [4, 5, 6]
    assert [g["transfers"] for g in out["policies"]["B1"]["by_gw"]][3:] == [0, 0, 0]


def decisions(team):
    return [(g["gw"], g["transfer_ids"], g["xi"], g["bench"], g["captain"], g["vice_captain"]) for g in team.by_gw]


@pytest.mark.parametrize("policy", ["B0", "B1", "B2"])
def test_no_leakage_in_baseline_decisions(policy):
    """Rewriting GW4-6's results (and the xP recorded for them) can't change a decision up to GW4."""
    a, b = season(), season(*tamper_from(4))
    _, start = start_team(a)
    da = decisions(B.run_policy(a, policy, start, gws=[1, 2, 3, 4]))
    db = decisions(B.run_policy(b, policy, start, gws=[1, 2, 3, 4]))
    assert da == db
    # ...while the points scored in GW4 do change: the tampering is real.
    assert B.run_policy(a, policy, start, gws=[1, 2, 3, 4]).points != B.run_policy(b, policy, start, gws=[1, 2, 3, 4]).points


@needs_solver
def test_no_leakage_in_g0_decisions():
    """FR-EVL-01: the pipeline's decision for a GW uses nothing from that GW or later."""
    a, b = season(), season(*tamper_from(4))
    _, start = start_team(a)
    ta = B.run_policy(a, "G0", start, gws=[1, 2, 3, 4], time_limit=20)
    tb = B.run_policy(b, "G0", start, gws=[1, 2, 3, 4], time_limit=20)
    assert decisions(ta) == decisions(tb)
    assert [g["points"] for g in ta.by_gw][:3] == [g["points"] for g in tb.by_gw][:3] and ta.by_gw[3]["points"] != tb.by_gw[3]["points"]
    assert ta.transfers >= 1  # it did make decisions
    # And an earlier cut: GW3's decision doesn't move when GW3 itself is rewritten.
    c = season(*tamper_from(3))
    assert decisions(B.run_policy(c, "G0", start, gws=[1, 2, 3], time_limit=20)) == decisions(ta)[:3]


@needs_solver
def test_g0_plans_are_legal_and_account_for_hits():
    s = season()
    out = B.backtest_season(s, ["B0", "G0"], time_limit=20)
    g0 = out["policies"]["G0"]
    assert g0["solver"]["solves"] == 5 and g0["solver"]["timed_out"] == 0
    assert g0["points"] == pytest.approx(sum(g["points"] for g in g0["by_gw"]))
    ft = 1
    for g in g0["by_gw"][1:]:
        assert g["ft"] == ft and g["hits"] == max(0, g["transfers"] - ft)
        ft = R.next_free_transfers(ft, g["transfers"], None, RULES)
    summary = B.summarise([out], ["B0", "G0"])
    assert summary["g0_vs"]["B0"]["g0_beats"] == (g0["points"] > out["policies"]["B0"]["points"])
    text = B.render([out], summary, ["B0", "G0"])
    assert "Season points per policy" in text and "FR-EVL-01" in text


# --- the verdict ----------------------------------------------------------------------------------


def _result(season_name, pts, built=True):
    return {"season": season_name, "official_xp": {"b1_built": built, "gws_with_fresh_value": 38 if built else 10, "of": 38},
            "policies": {k: {"points": v, "transfers": 0, "hits": 0, "hit_cost": 0, "captain_points": 0} for k, v in pts.items()}}


def test_verdict_reports_failures_and_blocked_seasons():
    pol = ["B0", "B1", "B2", "G0"]
    win = B.summarise([_result("a", {"B0": 1900, "B1": 1950, "B2": 2000, "G0": 2100}), _result("b", {"B0": 1800, "B1": 2000, "B2": 2050, "G0": 2060})], pol)
    assert win["fr_evl_01"] is True and win["mean"]["G0"] == 2080.0
    lose = B.summarise([_result("a", {"B0": 1900, "B1": 1950, "B2": 2200, "G0": 2100})], pol)
    assert lose["fr_evl_01"] is False and lose["g0_vs"]["B2"]["g0_beats"] is False and lose["g0_vs"]["B0"]["g0_beats"] is True
    assert "DOES NOT beat B2" in B.render([_result("a", {"B0": 1900, "B1": 1950, "B2": 2200, "G0": 2100})], lose, pol) and "Result: FAIL" in B.render([_result("a", {"B0": 1900, "B1": 1950, "B2": 2200, "G0": 2100})], lose, pol)
    # A season where B1 couldn't be built is left out of the B1 comparison and reported as blocked.
    rs = [_result("a", {"B0": 1900, "B1": 1950, "B2": 2000, "G0": 2100}), _result("b", {"B0": 1800, "B1": 900, "B2": 2050, "G0": 2060}, built=False)]
    part = B.summarise(rs, pol)
    assert part["g0_vs"]["B1"]["seasons"] == ["a"] and part["g0_vs"]["B1"]["blocked_seasons"] == ["b"] and part["fr_evl_01"] == "blocked"
    assert "blocked for b" in B.render(rs, part, pol)
    # Blocked doesn't hide a real loss.
    rs2 = [_result("a", {"B0": 1900, "B1": 2150, "B2": 2000, "G0": 2100}), _result("b", {"B0": 1800, "B1": 900, "B2": 2050, "G0": 2060}, built=False)]
    assert B.summarise(rs2, pol)["fr_evl_01"] is False


# --- the real seasons, when fetched ---------------------------------------------------------------


@pytest.mark.skipif(not (HISTORY / "2025-26" / "merged_gw.csv").is_file(), reason="var/history not fetched (tools/fetch_history.py)")
def test_real_season_cutoffs_and_xp_coverage():
    s = B.load_season(HISTORY, "2025-26")
    assert s.gws == list(range(1, 39)) and s.xp_gws == [1, 2, 3, 4, 5, 6, 8, 9, 24, 29, 38]
    # GW1's own value, then the GW after each populated one.
    assert [g for g in s.gws if s.has_fresh_xp(g)] == [1, 2, 3, 4, 5, 6, 7, 9, 10, 25, 30]
    inp = s.inputs_at(10)
    assert all(m.date < inp.deadline for m in inp.matches) and len(inp.matches) == 90 and len(inp.prev_matches) == 380
    assert len(inp.odds_rows) == 10 and inp.odds_available
    assert sum(p.prev is not None for p in inp.players.values()) > 300
    assert max(p.totals["games"] for p in inp.players.values()) == 9
