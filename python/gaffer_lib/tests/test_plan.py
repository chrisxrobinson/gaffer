"""gaffer_lib.plan and the `run` golden path: every plan the solver returns passes `validate`
against the same snapshot (FR-EVL-01's pipeline, NFR-REL-02, FR-DAT-09).

These tests need open-fpl-solver at the pinned commit: set GAFFER_SOLVER_DIR to a checkout (the
sandbox image has it at /opt/open-fpl-solver). They are skipped when it isn't there.
"""

import json
import os
import random
import shutil

import pytest
from conftest import DATA

from gaffer_lib import cli, plan as P, xp as X
from gaffer_lib.__main__ import main
from gaffer_lib.derive import derive
from gaffer_lib.inputs import from_snapshot
from gaffer_lib.snapshot import Snapshot
from gaffer_lib.validate import validate

SNAP_DIR = DATA / "snapshot-model"
HAVE_SOLVER = os.path.isfile(os.path.join(os.environ.get(P.SOLVER_DIR_ENV, P.DEFAULT_SOLVER_DIR), "dev", "solver.py"))
needs_solver = pytest.mark.skipif(not HAVE_SOLVER, reason=f"open-fpl-solver not found; set {P.SOLVER_DIR_ENV}")
H = 3  # a short horizon keeps the solves to a second or two


@pytest.fixture(scope="module")
def world():
    snap = Snapshot(SNAP_DIR)
    inputs = from_snapshot(snap)
    proj = X.project(inputs, 6)
    return snap, inputs, proj


def state_for(snap, inputs, **kw):
    d = derive(snap, **kw)
    return d, P.TeamState.from_derived(d, {i: p.now_cost for i, p in inputs.players.items()})


def assert_valid(snap, plan, **kw):
    v = validate(snap, plan.proposal(), **kw)
    assert v["valid"], v["errors"]
    return v


# --- pure pieces ----------------------------------------------------------------------------------


def test_best_xi_is_a_valid_formation_with_the_most_points(world):
    snap, inputs, proj = world
    _, st = state_for(snap, inputs)
    et = {p: inputs.players[p].element_type for p in st.squad}
    xp = {p: proj.xp[p][6] for p in st.squad}
    xi, bench = P.best_xi(st.squad, xp, et, inputs.rules)
    assert len(xi) == 11 and len(bench) == 4 and sorted(xi + bench) == sorted(st.squad)
    counts = {t: sum(et[p] == t for p in xi) for t in inputs.rules.squad_select}
    assert all(inputs.rules.min_play[t] <= n <= inputs.rules.max_play[t] for t, n in counts.items())
    assert et[bench[0]] == 1 and all(et[p] != 1 for p in bench[1:])
    assert [xp[p] for p in bench[1:]] == sorted((xp[p] for p in bench[1:]), reverse=True)
    # No single swap of an outfield bench player for a starter of the same position gains points.
    for b in bench[1:]:
        assert all(xp[b] <= xp[s] + 1e-9 for s in xi if et[s] == et[b])


def test_team_state_applies_pending_transfers(world):
    snap, inputs, _ = world
    d0, st0 = state_for(snap, inputs)
    out = st0.squad[-1]
    cheap = min((p for p in inputs.players.values() if p.element_type == inputs.players[out].element_type and p.id not in st0.squad
                 and p.now_cost <= st0.sell[out] and sum(inputs.players[q].team == p.team for q in st0.squad) < 3), key=lambda p: p.now_cost)
    d, st = state_for(snap, inputs, pending=f"{out}>{cheap.id}")
    assert cheap.id in st.squad and out not in st.squad
    assert st.free_transfers == d0["free_transfers"]["value"] - 1
    assert st.bank == st0.bank + st0.sell[out] - cheap.now_cost
    assert st.sell[cheap.id] == cheap.now_cost and out not in st.sell


def _fake_plan(objective, gw, xi, captain, transfers=(), timed_out=False, fallback=False):
    info = P.SolveInfo("Time limit reached" if timed_out else "Optimal", 0.02 if timed_out else 0.0, 1.0, 45.0, objective, timed_out)
    step = {"gw": gw, "xi": list(xi), "bench": [], "captain": captain, "vice_captain": xi[1], "transfers": list(transfers), "hits": 0, "hit_cost": 0, "expected_points": 60.0}
    return P.Plan([step], objective, info, fallback=fallback)


def test_confidence_rules():
    """ARCHITECTURE §2.4: computed from the margin, P(start) and freshness; a timeout caps it at medium."""
    xi = list(range(1, 12))
    sure = X.Projection([6], {}, {}, {p: {6: 0.95} for p in range(1, 20)}, {}, [])
    best, second = _fake_plan(300.0, 6, xi, 1), _fake_plan(297.5, 6, xi, 1)
    assert P.confidence([best, second], sure, stale=False)["overall"] == "high"
    assert P.confidence([best, second], sure, stale=True)["overall"] == "low"
    assert P.confidence([best, _fake_plan(299.7, 6, xi, 1)], sure, stale=False)["overall"] == "low"  # margin < 0.5
    assert P.confidence([best, _fake_plan(299.0, 6, xi, 1)], sure, stale=False)["overall"] == "medium"  # margin 1.0
    assert P.confidence([best], sure, stale=False)["overall"] == "medium"  # no alternative to compare with
    doubt = X.Projection([6], {}, {}, {**{p: {6: 0.95} for p in range(1, 20)}, 5: {6: 0.8}}, {}, [])
    assert P.confidence([best, second], doubt, stale=False)["overall"] == "medium"  # an XI player below 0.85
    risky = X.Projection([6], {}, {}, {**{p: {6: 0.95} for p in range(1, 20)}, 1: {6: 0.6}}, {}, [])
    assert P.confidence([best, second], risky, stale=False)["overall"] == "low"  # the captain below 0.7
    buy = _fake_plan(300.0, 6, xi, 2, transfers=[{"out": 15, "in": 1}])
    assert P.confidence([buy, second], risky, stale=False)["overall"] == "low"  # a player bought below 0.7
    timed = _fake_plan(300.0, 6, xi, 1, timed_out=True)
    c = P.confidence([timed, second], sure, stale=False)
    assert c["overall"] == "medium" and any("time limit" in d for d in c["drivers"])
    slow_alt = P.confidence([best, _fake_plan(297.5, 6, xi, 1, timed_out=True)], sure, stale=False)
    assert slow_alt["overall"] == "medium"
    assert P.confidence([_fake_plan(None, 6, xi, 1, timed_out=True, fallback=True)], sure, stale=False)["overall"] == "low"


def test_solver_missing_is_a_clear_error(monkeypatch, world):
    snap, inputs, proj = world
    _, st = state_for(snap, inputs)
    monkeypatch.setenv(P.SOLVER_DIR_ENV, "/nonexistent")
    monkeypatch.setitem(__import__("sys").modules, "dev.solver", None)
    with pytest.raises(P.SolverUnavailable, match="open-fpl-solver not found"):
        P.solve(inputs, proj, st, horizon=H)


# --- solves ---------------------------------------------------------------------------------------


@needs_solver
@pytest.mark.parametrize("kw", [{}, {"ft": 0}, {"ft": 1}, {"ft": 5}], ids=["derived-ft", "ft0", "ft1", "ft5"])
def test_solver_plans_pass_validate(world, kw):
    snap, inputs, proj = world
    d, st = state_for(snap, inputs, **kw)
    plans = P.solve(inputs, proj, st, horizon=H, time_limit=20, alternatives=2, alt_time_limit=10)
    assert len(plans) == 2 and not plans[0].fallback
    for pl in plans:
        v = assert_valid(snap, pl, **kw)
        assert [g["gw"] for g in v["gws"]] == [6, 7, 8]
        # The solver's own FT and hit arithmetic agrees with the rules engine, GW by GW.
        for step, g in zip(pl.steps, v["gws"]):
            assert step["free_transfers"] == g["ft_available"] and step["hits"] == g["hits"] and step["bank"] == g["bank_after"]
    assert plans[0].objective >= plans[1].objective - P.MIP_ABS_GAP
    assert plans[0].steps[0]["transfers"] != plans[1].steps[0]["transfers"]
    assert plans[0].info.status == "Optimal" and plans[0].info.gap is not None and plans[0].info.gap < 0.01
    hold = P.hold_plan(inputs, proj, st, plans[0].info, H)
    assert sum(s["expected_points"] for s in plans[0].steps) >= sum(s["expected_points"] for s in hold.steps) - 4 * sum(s["hits"] for s in plans[0].steps) - 1e-6


@needs_solver
def test_plans_with_pending_transfers_and_preferences_pass_validate(world):
    snap, inputs, proj = world
    _, st0 = state_for(snap, inputs)
    out = st0.squad[-1]
    cheap = min((p for p in inputs.players.values() if p.element_type == inputs.players[out].element_type and p.id not in st0.squad
                 and p.now_cost <= st0.sell[out] and sum(inputs.players[q].team == p.team for q in st0.squad) < 3), key=lambda p: p.now_cost)
    pending = f"{out}>{cheap.id}"
    _, st = state_for(snap, inputs, pending=pending)
    base = P.solve(inputs, proj, st, horizon=H, time_limit=20)[0]
    assert_valid(snap, base, pending=pending)
    bought = base.steps[0]["transfers"][0]["in"] if base.steps[0]["transfers"] else None
    keep = st.squad[3]
    prefs = {"keep_ids": [keep], "avoid_ids": [bought] if bought else [], "max_hits_per_gw": 0}
    pl = P.solve(inputs, proj, st, horizon=H, time_limit=20, prefs=prefs)[0]
    assert_valid(snap, pl, pending=pending)
    assert all(keep in s["xi"] + s["bench"] for s in pl.steps)
    assert all(bought not in s["xi"] + s["bench"] for s in pl.steps)
    assert all(s["hits"] == 0 for s in pl.steps)


@needs_solver
@pytest.mark.parametrize("seed", [1, 2, 3])
def test_plans_from_perturbed_projections_pass_validate(world, seed):
    """Whatever the numbers say, the plan must be legal: shuffle the projections and re-solve."""
    snap, inputs, proj = world
    rng = random.Random(seed)
    noisy = X.Projection(proj.gws, {p: {g: v * rng.uniform(0.3, 1.9) for g, v in row.items()} for p, row in proj.xp.items()}, proj.xmins, proj.p_start, proj.components, proj.fixtures)
    kw = {"ft": rng.choice([1, 2, 4])}
    _, st = state_for(snap, inputs, **kw)
    pl = P.solve(inputs, noisy, st, horizon=H, time_limit=20)[0]
    assert not pl.fallback
    assert_valid(snap, pl, **kw)


@needs_solver
def test_one_second_limit_returns_the_incumbent_with_its_gap(world):
    """NFR-REL-02: a solver time-out returns the best incumbent; gap reported, confidence <= medium."""
    snap, inputs, proj = world
    _, st = state_for(snap, inputs)
    plans = P.solve(inputs, proj, st, horizon=6, time_limit=1.0)
    pl = plans[0]
    assert pl.info.timed_out and pl.info.status == "Time limit reached"
    assert pl.info.gap is not None and pl.info.gap > 0 and pl.info.objective is not None
    assert pl.info.time_s < 3.0
    assert not pl.fallback  # the hold plan is the MIP start, so there is always an incumbent
    assert_valid(snap, pl)
    assert any("best plan found, not a proven optimum" in w for w in pl.warnings)
    assert P.confidence(plans, proj, stale=False)["overall"] in ("medium", "low")


@needs_solver
def test_a_deadline_caps_every_run(world):
    """NFR-LAT-03's budget: the main solve and the next-best plans all end by the caller's deadline."""
    import time

    snap, inputs, proj = world
    _, st = state_for(snap, inputs)
    t0 = time.perf_counter()
    plans = P.solve(inputs, proj, st, horizon=6, time_limit=45, alternatives=3, alt_time_limit=8, deadline=t0 + 4.0)
    assert time.perf_counter() - t0 < 6.5
    assert plans[0].info.timed_out and plans[0].info.time_limit_s <= 4.0 and plans[0].info.gap is not None
    for pl in plans:
        assert_valid(snap, pl)


@needs_solver
def test_no_incumbent_falls_back_to_holding(world, monkeypatch):
    snap, inputs, proj = world
    _, st = state_for(snap, inputs)
    monkeypatch.setattr(P, "_hold_start", lambda *a, **k: None)  # no MIP start: nothing feasible in 0.05 s
    pl = P.solve(inputs, proj, st, horizon=6, time_limit=0.05)[0]
    assert pl.fallback and pl.info.timed_out and pl.info.gap is None
    assert all(s["transfers"] == [] for s in pl.steps)
    assert_valid(snap, pl)
    assert P.confidence([pl], proj, stale=False)["overall"] == "low"


@pytest.fixture(scope="module")
def all_chips(tmp_path_factory):
    """The same snapshot with no chip played, so every chip is available in GW6."""
    d = tmp_path_factory.mktemp("snap") / "all-chips"
    shutil.copytree(SNAP_DIR, d)
    h = json.loads((d / "history.json").read_text())
    h["chips"] = []
    (d / "history.json").write_text(json.dumps(h))
    for name in ("picks", "picks-prev"):
        p = json.loads((d / f"{name}.json").read_text())
        p["active_chip"] = None
        (d / f"{name}.json").write_text(json.dumps(p))
    snap = Snapshot(d)
    inputs = from_snapshot(snap)
    return snap, inputs, X.project(inputs, 6)


@needs_solver
@pytest.mark.parametrize("chip,gw", [("wildcard", 6), ("freehit", 7), ("bboost", 6), ("3xc", 8)])
def test_fixed_chip_plans_pass_validate(all_chips, chip, gw):
    snap, inputs, proj = all_chips
    _, st = state_for(snap, inputs, ft=1)
    pl = P.solve(inputs, proj, st, horizon=H, time_limit=25, chip=(chip, gw))[0]
    assert not pl.fallback
    assert [s["chip"] for s in pl.steps] == [chip if g == gw else None for g in (6, 7, 8)]
    v = assert_valid(snap, pl, ft=1)
    step = next(s for s in pl.steps if s["gw"] == gw)
    if chip in ("wildcard", "freehit"):
        assert step["hits"] == 0 and len(step["transfers"]) > 1
        after = next((g for g in v["gws"] if g["gw"] == gw + 1), None)
        if after:
            assert after["ft_available"] == next(g for g in v["gws"] if g["gw"] == gw)["ft_available"]  # WC/FH keep the FT count
    if chip == "freehit" and gw < 8:
        # The Free Hit squad reverts: next GW's XI is drawn from the squad as it was before.
        before = set(st.squad) if gw == 6 else set(pl.steps[0]["xi"] + pl.steps[0]["bench"])
        nxt = next(s for s in pl.steps if s["gw"] == gw + 1)
        assert len(set(nxt["xi"] + nxt["bench"]) - before) == len(nxt["transfers"])


@needs_solver
def test_chip_scenarios_cover_every_chip(all_chips, world):
    snap, inputs, proj = all_chips
    d, st = state_for(snap, inputs, ft=1)
    base = P.solve(inputs, proj, st, horizon=H, time_limit=20)[0]
    todo, skipped = P.chip_candidates(inputs, proj, base, [], save=["wildcard"])
    assert {c for c, _ in todo} == {"freehit", "bboost", "3xc"} and skipped == [{"chip": "wildcard", "reason": "saved by preference"}]
    out = P.chip_scenarios(inputs, proj, st, base, [], horizon=H, budget_s=30, save=["wildcard", "freehit"])
    by = {x["chip"]: x for x in out}
    assert set(by) == {"wildcard", "freehit", "bboost", "3xc"}
    assert not by["wildcard"]["evaluated"] and by["wildcard"]["reason"] == "saved by preference"
    for chip in ("bboost", "3xc"):
        assert by[chip]["evaluated"] and by[chip]["delta_xp_gw"] > 0 and by[chip]["delta_objective"] > 0 and by[chip]["pool"] == "base plan players"
    # Triple Captain adds the captain's points once more; Bench Boost adds the bench.
    tc = by["3xc"]
    cap = next(s for s in base.steps if s["gw"] == tc["gw"])["captain"]
    assert tc["delta_xp_gw"] >= proj.xp[cap][tc["gw"]] - 0.5
    # With no time left, a scenario is reported as not evaluated rather than dropped.
    starved = P.chip_scenarios(inputs, proj, st, base, [], horizon=H, budget_s=0.0)
    assert all(not x["evaluated"] and x["reason"] == "time budget exhausted" for x in starved)
    # The real snapshot: entry 1 has used Bench Boost, Wildcard and Free Hit, so only Triple Captain remains.
    snap1, inputs1, proj1 = world
    d1, st1 = state_for(snap1, inputs1)
    used = [{"name": c["name"], "event": c["used_in"]} for c in d1["chips"] if c["used_in"]]
    todo1, skipped1 = P.chip_candidates(inputs1, proj1, P.hold_plan(inputs1, proj1, st1, base.info, H), used)
    assert {c for c, _ in todo1} == {"3xc"} and {s["chip"] for s in skipped1} == {"wildcard", "freehit", "bboost"}


# --- the golden path ------------------------------------------------------------------------------


@needs_solver
def test_run_golden_path_end_to_end(tmp_path, capsys):
    """One command produces a full candidate plan; with no odds in the snapshot it still completes and
    carries FR-DAT-09's warning."""
    out = tmp_path / "plan.json"
    prefs = tmp_path / "prefs.json"
    prefs.write_text(json.dumps({"risk": "balanced", "save_chips": ["Triple Captain"], "max_hits_per_gw": 1}))
    code = main(["run", "--snapshot", str(SNAP_DIR), "--prefs", str(prefs), "--out", str(out), "--time-limit", "6", "--budget", "14"])
    text = capsys.readouterr().out
    assert code == 0
    doc = json.loads(out.read_text())
    assert doc["schema"] == "gaffer.plan/1" and doc["gaffer_lib"] == "0.3.0" and doc["gw"] == 6
    assert doc["solver"]["commit"] == P.SOLVER_COMMIT and doc["solver"]["gap"] is not None
    assert 1 <= len(doc["plans"]) <= 3
    for p in doc["plans"]:
        assert p["validation"] == {"valid": True, "errors": []}
        assert len(p["gws"]) == 6 and p["shown"] == 4 and [s["gw"] for s in p["gws"]] == [6, 7, 8, 9, 10, 11]
        assert all(s["chip"] is None for s in p["gws"])  # chips off in the plan itself
        assert p["net_xp_gain_4gw"] == pytest.approx(sum(t["xp_gain_4gw"] for t in p["transfers"]) - p["hit_cost"], abs=0.02)
        # The plan in the file passes the CLI validator against the same snapshot.
        proposal = tmp_path / f"proposal-{p['rank']}.json"
        proposal.write_text(json.dumps({"gws": [{k: s[k] for k in ("gw", "transfers", "chip", "xi", "bench", "captain", "vice_captain", "hits", "hit_cost")} for s in p["gws"]]}))
        assert main(["validate", "--snapshot", str(SNAP_DIR), "--proposal", str(proposal)]) == 0
    capsys.readouterr()
    assert "odds unavailable — team strength from Dixon-Coles" in doc["warnings"][0]
    assert "Derived FT count — confirm in app" in doc["warnings"]
    assert doc["confidence"]["overall"] in ("low", "medium")  # the 6 s solve can't be proven optimal
    assert {x["chip"] for x in doc["chip_scenarios"]} == {"wildcard", "freehit", "bboost", "3xc"}
    assert next(x for x in doc["chip_scenarios"] if x["chip"] == "3xc")["reason"] == "saved by preference"
    assert len(doc["captain"]) == 3 and doc["captain"][0]["xp"] >= doc["captain"][1]["xp"]
    assert doc["ep_next_comparison"]["players"] > 100 and "correlation" in doc["ep_next_comparison"]
    assert doc["timings"]["total_s"] < 14 + 4  # the budget, plus start-up and validation
    assert doc["assumptions"]["ft_source"] == "derived" and doc["preferences"]["max_hits_per_gw"] == 1
    assert text.startswith("Gaffer plan for GW6") and "Plan 1" in text and "odds unavailable — team strength from Dixon-Coles" in text
    assert f"Full plan JSON: {out}" in text and len(text) < 9000


@needs_solver
def test_run_reports_bad_input(tmp_path, capsys):
    assert main(["run", "--snapshot", str(tmp_path)]) == 2
    assert "not a Gaffer snapshot" in capsys.readouterr().out
    bad = tmp_path / "prefs.json"
    bad.write_text(json.dumps({"keep": ["Nobody McNobody"]}))
    assert main(["run", "--snapshot", str(SNAP_DIR), "--prefs", str(bad)]) == 2
    assert "no player called" in capsys.readouterr().out
    bad.write_text(json.dumps({"save_chips": ["mystery"]}))
    assert main(["run", "--snapshot", str(SNAP_DIR), "--prefs", str(bad)]) == 2
    assert main(["run", "--snapshot", str(SNAP_DIR), "--pending", "1>2"]) == 2


@needs_solver
def test_xmins_overrides_change_the_plan_inputs(world):
    snap, inputs, proj = world
    doc = cli.golden_path(snap, {"xmins_overrides": [{"player": 426, "gw": 6, "xmins": 0, "source": "ruled out"}]}, time_limit=3, budget=4, alternatives=1, chips=False)
    assert doc["xmins_overrides"] == [{"player": 426, "gw": 6, "xmins": 0.0}]
    assert all(426 not in s["xi"] for s in doc["plans"][0]["gws"][:1])
    assert doc["plans"][0]["validation"]["valid"]
