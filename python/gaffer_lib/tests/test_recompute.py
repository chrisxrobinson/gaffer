"""gaffer_lib.recompute: the submit gate's second half (ADR 0003). One test per M4 acceptance
criterion that the library decides. The plan file is `tests/data/plan-model.json`, the golden
path's output for `tests/data/snapshot-model`; regenerate it after a model change with

    python -m gaffer_lib run --snapshot tests/data/snapshot-model --out tests/data/plan-model.json

(`test_the_plan_fixture_is_current` fails when it is out of date). These tests need numpy and scipy
but not the solver.
"""

import pytest

for _dep in ("numpy", "scipy"):
    pytest.importorskip(_dep)

import copy
import json
import shutil

from conftest import DATA, load_json

from gaffer_lib import __version__, cli, plan as P, xp as X
from gaffer_lib.__main__ import main
from gaffer_lib.derive import derive
from gaffer_lib.inputs import from_snapshot
from gaffer_lib.recompute import recompute
from gaffer_lib.snapshot import Snapshot

SNAP_DIR = DATA / "snapshot-model"


@pytest.fixture(scope="module")
def world():
    snap = Snapshot(SNAP_DIR)
    inputs = from_snapshot(snap)
    proj = X.project(inputs, 6)
    d = derive(snap)
    state = P.TeamState.from_derived(d, {i: p.now_cost for i, p in inputs.players.items()})
    return snap, inputs, proj, state


@pytest.fixture
def doc():
    return load_json("plan-model.json")


def submission(doc, rank=1, numbers=True):
    """What a model that follows the golden path submits: plan `rank`, its numbers copied."""
    d = doc["plans"][rank - 1]
    g0 = d["gws"][0]
    ids = lambda ts: [{"out": {"id": t["out"]}, "in": {"id": t["in"]}} for t in ts]  # noqa: E731
    return {
        "transfers": [{"out": {"id": t["out"]["id"]}, "in": {"id": t["in"]["id"]}, "rationale": "Better fixtures and minutes.",
                       **({"xp_gain_4gw": t["xp_gain_4gw"], "xp_gain_6gw_decayed": t["xp_gain_6gw_decayed"]} if numbers else {})} for t in d["transfers"]],
        "captain": {"id": g0["captain"]}, "vice_captain": {"id": g0["vice_captain"]},
        "starting_xi": list(g0["xi"]), "bench": list(g0["bench"]),
        **({"expected_points_gw": g0["expected_points"]} if numbers else {}),
        "chip": {"play": None, "rationale": "No chip this week."},
        "plan": [{"gw": s["gw"], "transfers": ids(s["transfers"]), "chip": s["chip"], "captain": s["captain"]} for s in d["gws"][:4]],
        "summary": "Make the three moves and captain the best fixture.",
    }


def hold_submission(world, transfers=()):
    """No plan beyond `transfers` this GW: the best XI of the resulting squad, then rolling."""
    _, inputs, proj, state = world
    steps = [{"gw": proj.gws[0], "transfers": [{"out": o, "in": i} for o, i in transfers], "chip": None}]
    squad = P.thread_state(steps, inputs, state)[0]["squad"]
    h = P.hold_step(squad, proj.gws[0], inputs, proj)
    return {
        "transfers": [{"out": {"id": o}, "in": {"id": i}, "rationale": "Test move."} for o, i in transfers],
        "captain": {"id": h["captain"]}, "vice_captain": {"id": h["vice_captain"]}, "starting_xi": h["xi"], "bench": h["bench"],
        "chip": {"play": None, "rationale": "None."},
        "plan": [{"gw": g, "transfers": [], "chip": None} for g in proj.gws[:4]],
        "summary": "Hold.",
    }


def codes(out):
    return [e["code"] for e in out["errors"]]


# --- the golden path's own plan -------------------------------------------------------------------


def test_the_plan_fixture_is_current(world, doc):
    snap = world[0]
    assert doc["gaffer_lib"] == __version__, "regenerate tests/data/plan-model.json (see this file's docstring)"
    out = recompute(snap, submission(doc), doc)
    assert out["valid"], out["errors"]


def test_plan_1_passes_and_every_number_is_the_golden_paths(world, doc):
    snap, inputs, proj, state = world
    out = recompute(snap, submission(doc), doc)
    rec, v, d = out["recommendation"], out["validation"], doc["plans"][0]
    assert out["schema"] == "gaffer.recompute/1" and out["gaffer_lib"] == __version__ and out["snapshot_id"] == "snapshot-model"
    # FR-REC-01: both gains per transfer, and net = Σ gain − hit cost
    assert [(t["xp_gain_4gw"], t["xp_gain_6gw_decayed"]) for t in rec["transfers"]] == [(t["xp_gain_4gw"], t["xp_gain_6gw_decayed"]) for t in d["transfers"]]
    assert rec["hit_cost"] == rec["hits"] * 4 == 0
    assert rec["net_xp_gain_4gw"] == pytest.approx(sum(t["xp_gain_4gw"] for t in rec["transfers"]) - rec["hit_cost"])
    assert all(t["out"]["name"] and t["out"]["sell_price"] > 0 and t["in"]["price"] > 0 for t in rec["transfers"])
    # FR-REC-02: captain and vice are in the XI, differ, and carry xp and p_start
    assert rec["captain"]["id"] in rec["starting_xi"] and rec["vice_captain"]["id"] in rec["starting_xi"] and rec["captain"]["id"] != rec["vice_captain"]["id"]
    assert {"xp", "p_start"} <= set(rec["captain"]) and {"xp", "p_start"} <= set(rec["vice_captain"])
    assert rec["captain"]["xp"] == round(proj.xp[rec["captain"]["id"]][6], 2)
    # FR-REC-03: a valid XI, a bench of 4 with the goalkeeper first, in the simulator's order
    assert len(rec["starting_xi"]) == 11 and len(rec["bench"]) == 4
    assert inputs.players[rec["bench"][0]].element_type == 1
    assert rec["bench"] == d["gws"][0]["bench"]
    # FR-REC-05: exactly 4 consecutive GWs from the next deadline, each with its recomputed points
    assert [p["gw"] for p in rec["plan"]] == [6, 7, 8, 9]
    assert [p["expected_points"] for p in rec["plan"]] == [s["expected_points"] for s in d["gws"][:4]]
    assert rec["expected_points_gw"] == rec["plan"][0]["expected_points"] == d["expected_points_gw"]
    assert [p["free_transfers"] for p in rec["plan"]] == [s["free_transfers"] for s in d["gws"][:4]]
    assert rec["plan"][0]["roll_ft"] is False and all(isinstance(p["roll_ft"], bool) for p in rec["plan"])
    # FR-REC-07: recomputed, nothing drifted
    assert v == {**v, "passed": True, "recomputed": True, "max_model_number_drift": 0.0, "drift": [], "gap_to_best": 0.0, "plans_compared": 3, "optimality_checked": True}
    assert v["numbers_checked"] == 2 * len(rec["transfers"]) + 1
    assert v["score"] == v["best_score"] == d["score"]
    # FR-REC-06: the same confidence the golden path computed by rules
    assert rec["confidence"]["overall"] == doc["confidence"]["overall"] == "medium"
    assert v["margin"] == pytest.approx(doc["plans"][0]["score"] - doc["plans"][1]["score"], abs=0.002)
    assert rec["assumptions"] == {"free_transfers": 3, "ft_source": "derived", "pending_transfers": [], "bank": 0.0}
    assert rec["preferences"] == {"risk": "balanced", "save_chips": [], "keep": [], "avoid": [], "max_hits_per_gw": None}
    assert "Derived FT count — confirm in app" in rec["warnings"]
    assert set(map(int, rec["players"])) >= set(rec["starting_xi"]) | set(rec["bench"])


def test_chip_scenarios_cover_every_chip_and_are_rescored(world, doc):
    """FR-REC-04: one entry per chip type, evaluated with numbers or with the reason it wasn't."""
    out = recompute(world[0], submission(doc), doc)
    sc = out["recommendation"]["chip"]["scenarios"]
    assert {x["chip"] for x in sc} == {"wildcard", "freehit", "bboost", "3xc"}
    tc = next(x for x in sc if x["chip"] == "3xc")
    src = next(x for x in doc["chip_scenarios"] if x["chip"] == "3xc")
    assert tc == {"chip": "3xc", "gw": 7, "evaluated": True, "delta_xp": pytest.approx(src["delta_objective"], abs=0.02), "delta_xp_gw": pytest.approx(src["delta_xp_gw"], abs=0.011)}
    for x in sc:
        assert x["evaluated"] or x["reason"]
    assert out["recommendation"]["chip"]["play"] is None


def test_the_same_request_gives_the_same_answer(world, doc):
    """NFR-OBS-01: nothing in the gate depends on time or chance."""
    a = recompute(world[0], submission(doc), doc)
    b = recompute(Snapshot(SNAP_DIR), copy.deepcopy(submission(doc)), copy.deepcopy(doc))
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


# --- FR-REC-07: numbers -----------------------------------------------------------------------------


def test_a_wrong_xp_gain_is_corrected_and_the_drift_reported(world, doc):
    sub = submission(doc)
    true = sub["transfers"][0]["xp_gain_4gw"]
    sub["transfers"][0]["xp_gain_4gw"] = true + 5.0
    sub["captain"]["xp"] = 99.0
    out = recompute(world[0], sub, doc)
    rec, v = out["recommendation"], out["validation"]
    assert out["valid"]
    assert rec["transfers"][0]["xp_gain_4gw"] == true
    assert rec["captain"]["xp"] < 15
    assert v["max_model_number_drift"] == pytest.approx(99.0 - rec["captain"]["xp"])
    assert {"path": "transfers[0].xp_gain_4gw", "model": true + 5.0, "recomputed": true, "gap": 5.0} in v["drift"]
    assert any("transfers[0].xp_gain_4gw" in w and "corrected" in w for w in rec["warnings"])


def test_a_gap_under_the_threshold_is_counted_but_not_flagged(world, doc):
    sub = submission(doc)
    sub["transfers"][0]["xp_gain_4gw"] += 0.3
    v = recompute(world[0], sub, doc)["validation"]
    assert v["max_model_number_drift"] == pytest.approx(0.3) and v["drift"] == []


def test_no_numbers_from_the_model_is_fine(world, doc):
    out = recompute(world[0], submission(doc, numbers=False), doc)
    assert out["valid"] and out["validation"]["numbers_checked"] == 0 and out["recommendation"]["transfers"][0]["xp_gain_4gw"] > 0


# --- FR-REC-08: an illegal plan is refused with the rule named ---------------------------------------


def test_four_players_from_one_club_is_rejected_naming_the_club_rule(world, doc):
    snap, inputs, proj, state = world
    by_club = {}
    for p in state.squad:
        by_club.setdefault(inputs.players[p].team, []).append(p)
    club, held = next((c, ps) for c, ps in by_club.items() if len(ps) == 3)
    out_p = next(p for p in state.squad if inputs.players[p].team != club)
    in_p = min((d.now_cost, p) for p, d in inputs.players.items() if d.team == club and p not in state.squad and d.element_type == inputs.players[out_p].element_type)[1]
    out = recompute(snap, hold_submission(world, [(out_p, in_p)]), doc)
    assert not out["valid"] and out["recommendation"] is None
    err = next(e for e in out["errors"] if e["code"] == "CLUB_LIMIT")
    assert inputs.team_names[club] in err["message"] and "limit is 3 per club" in err["message"] and err["gw"] == 6


def test_other_illegal_plans(world, doc):
    snap = world[0]
    sub = submission(doc)
    sub["vice_captain"] = {"id": sub["captain"]["id"]}
    assert "CAPTAIN_IS_VICE" in codes(recompute(snap, sub, doc))
    sub = submission(doc)
    sub["starting_xi"][0], sub["bench"][1] = sub["bench"][1], sub["starting_xi"][0]  # an outfield player in goal
    assert "FORMATION" in codes(recompute(snap, sub, doc))
    sub = submission(doc)
    sub["transfers"][0]["in"]["id"] = 999999
    assert "UNKNOWN_PLAYER" in codes(recompute(snap, sub, doc))
    sub = submission(doc)
    sub["plan"] = sub["plan"][:3]
    assert codes(recompute(snap, sub, doc)) == ["PLAN_LENGTH"]
    sub = submission(doc)
    sub["plan"][1]["gw"] = 9
    assert "GW_SEQUENCE" in codes(recompute(snap, sub, doc))
    sub = submission(doc)
    sub["plan"][0]["captain"] = sub["vice_captain"]["id"]
    assert codes(recompute(snap, sub, doc)) == ["PLAN_GW_MISMATCH"]
    sub = submission(doc)
    sub["summary"] = "word " * 121
    sub["transfers"][0]["rationale"] = "word " * 61
    assert codes(recompute(snap, sub, doc)) == ["WORD_LIMIT", "WORD_LIMIT"]


def test_over_budget_uses_selling_prices(world, doc):
    snap, inputs, proj, state = world
    out_p = min(state.squad, key=lambda p: inputs.players[p].now_cost)
    t = inputs.players[out_p]
    clubs = [inputs.players[p].team for p in state.squad]
    in_p = max((d.now_cost, p) for p, d in inputs.players.items() if d.element_type == t.element_type and p not in state.squad and clubs.count(d.team) < 3)[1]
    assert "OVER_BUDGET" in codes(recompute(snap, hold_submission(world, [(out_p, in_p)]), doc))


# --- FR-REC-09: within 0.5 of the solver's best plan -----------------------------------------------


def test_a_plan_more_than_half_a_point_below_the_best_is_refused(world, doc):
    snap = world[0]
    for rank in (2, 3):
        out = recompute(snap, submission(doc, rank), doc)
        assert codes(out) == ["NOT_NEAR_OPTIMAL"]
        assert "plan 1" in out["errors"][0]["message"] and "0.5" in out["errors"][0]["message"]
    assert codes(recompute(snap, hold_submission(world), doc)) == ["NOT_NEAR_OPTIMAL"]


def test_a_near_tie_is_accepted_and_reported(world, doc):
    """Plan 1 with the vice-captain given the armband: a gap below 0.5, chosen on judgement."""
    snap, _, proj, _ = world
    sub = submission(doc)
    c, vc = sub["captain"]["id"], sub["vice_captain"]["id"]
    assert 0 < proj.xp[c][6] - proj.xp[vc][6] < 0.55
    sub["captain"], sub["vice_captain"] = {"id": vc}, {"id": c}
    sub["plan"][0]["captain"] = vc
    out = recompute(snap, sub, doc)
    assert out["valid"], out["errors"]
    v = out["validation"]
    assert 0 < v["gap_to_best"] <= 0.5 and v["score"] == pytest.approx(v["best_score"] - v["gap_to_best"], abs=0.002)
    assert any("below the solver's best plan" in w for w in out["recommendation"]["warnings"])
    assert out["recommendation"]["captain"]["id"] == vc


def test_a_changed_later_gw_is_scored_on_its_own_line_up(world, doc):
    snap = world[0]
    sub = submission(doc)
    sub["plan"][3]["transfers"] = []
    sub["plan"][3].pop("captain")
    out = recompute(snap, sub, doc)
    assert out["valid"] or codes(out) == ["NOT_NEAR_OPTIMAL"]
    if out["valid"]:
        assert out["recommendation"]["plan"][3]["roll_ft"] is True and out["validation"]["gap_to_best"] > 0


# --- FR-REC-06: confidence is computed, and can only be lowered ---------------------------------------


@pytest.fixture
def stale_snap(tmp_path):
    dst = tmp_path / "snap"
    shutil.copytree(SNAP_DIR, dst)
    (dst / "manifest.json").write_text(json.dumps({"id": "snapshot-model", "stale": True, "stale_reason": "fpl_updating"}))
    return Snapshot(dst)


def test_a_stale_snapshot_gives_low_confidence_even_if_the_model_says_high(stale_snap, doc):
    sub = submission(doc)
    sub["confidence"] = {"overall": "high", "drivers": ["I am sure"]}
    sub["transfers"][0]["confidence"] = "high"
    sub["chip"]["confidence"] = "high"
    out = recompute(stale_snap, sub, doc)
    rec = out["recommendation"]
    assert out["valid"], out["errors"]
    assert rec["confidence"]["overall"] == "low" and "the snapshot is stale" in rec["confidence"]["drivers"]
    assert rec["transfers"][0]["confidence"] == "low" and rec["chip"]["confidence"] == "low"


def test_the_model_can_lower_confidence_but_not_raise_it(world, doc):
    snap = world[0]
    sub = submission(doc)
    sub["confidence"] = {"overall": "high"}
    for t in sub["transfers"]:
        t["confidence"] = "high"
    rec = recompute(snap, sub, doc)["recommendation"]
    assert rec["confidence"]["overall"] == "medium"
    computed = [t["confidence"] for t in recompute(snap, submission(doc), doc)["recommendation"]["transfers"]]
    assert [t["confidence"] for t in rec["transfers"]] == computed  # what the rules say, whatever the model claimed
    sub["confidence"] = {"overall": "low", "drivers": ["late team news expected"]}
    sub["transfers"][0]["confidence"] = "low"
    rec = recompute(snap, sub, doc)["recommendation"]
    assert rec["confidence"]["overall"] == "low" and any("late team news expected" in d for d in rec["confidence"]["drivers"])
    assert rec["transfers"][0]["confidence"] == "low"


# --- FR-DAT-05: no transfers on stale data inside the last hour -----------------------------------


def test_transfers_are_refused_when_they_cannot_be_finalised(world, doc):
    snap = world[0]
    why = "FPL data is stale (fpl_updating) and the GW6 deadline is under an hour away."
    out = recompute(snap, submission(doc), doc, finalise_blocked=why)
    assert codes(out) == ["TRANSFERS_NOT_FINAL"] and why in out["errors"][0]["message"] and "--hold" in out["errors"][0]["message"]
    hold = cli.golden_path(snap, hold=True)
    assert hold["hold"] and len(hold["plans"]) == 1 and hold["plans"][0]["transfers"] == [] and hold["chip_scenarios"] == []
    out = recompute(snap, hold_submission(world), hold, finalise_blocked=why)
    rec = out["recommendation"]
    assert out["valid"], out["errors"]
    assert rec["transfers"] == [] and all(p["transfers"] == [] for p in rec["plan"])
    assert rec["warnings"][0] == f"No transfers recommended: {why}"
    assert rec["confidence"]["overall"] == "low" and out["validation"]["optimality_checked"] is False
    # A hold plan file is not a way round the optimality check.
    assert codes(recompute(snap, hold_submission(world), hold)) == ["PLAN_HOLD_NOT_ALLOWED"]


# --- FR-RUL-05: chips -------------------------------------------------------------------------------


def test_a_used_chip_or_one_played_twice_is_refused(world, doc):
    snap = world[0]
    sub = submission(doc)
    sub["chip"]["play"] = "bboost"  # played in GW2
    sub["plan"][0]["chip"] = "bboost"
    assert "CHIP_ALREADY_USED" in codes(recompute(snap, sub, doc))
    sub = submission(doc)
    sub["chip"]["play"] = "3xc"
    sub["plan"][0]["chip"] = sub["plan"][1]["chip"] = "3xc"
    out = recompute(snap, sub, doc)
    assert "CHIP_ALREADY_USED" in codes(out) and any(e.get("gw") == 7 for e in out["errors"])
    sub = submission(doc)
    sub["chip"]["play"] = "3xc"  # plan[0] still says no chip
    assert codes(recompute(snap, sub, doc)) == ["PLAN_GW_MISMATCH"]


def test_an_expired_chip_is_refused(world, doc, tmp_path):
    """The first-half Triple Captain window closed before this GW (the window is read from the API)."""
    dst = tmp_path / "snap"
    shutil.copytree(SNAP_DIR, dst)
    b = json.loads((dst / "bootstrap-static.json").read_text())
    next(c for c in b["chips"] if c["name"] == "3xc" and c["start_event"] == 1)["stop_event"] = 5
    (dst / "bootstrap-static.json").write_text(json.dumps(b))
    (dst / "manifest.json").write_text(json.dumps({"id": "snapshot-model"}))
    sub = submission(doc)
    sub["chip"]["play"] = "3xc"
    sub["plan"][0]["chip"] = "3xc"
    assert "CHIP_OUT_OF_WINDOW" in codes(recompute(Snapshot(dst), sub, doc))


def test_an_available_chip_is_scored_against_the_chip_free_plan(world, doc):
    snap = world[0]
    sub = submission(doc)
    sub["chip"]["play"] = "3xc"
    sub["plan"][0]["chip"] = "3xc"
    out = recompute(snap, sub, doc)
    rec = out["recommendation"]
    assert out["valid"], out["errors"]
    cap = rec["captain"]["xp"]
    assert rec["chip"]["play"] == "3xc" and rec["expected_points_gw"] == pytest.approx(doc["plans"][0]["expected_points_gw"] + cap, abs=0.011)
    mine = next(x for x in rec["chip"]["scenarios"] if x["chip"] == "3xc" and x["gw"] == 6)
    assert mine["evaluated"] and mine["delta_xp"] == pytest.approx(cap, abs=0.02) and rec["chip"]["confidence"] == "high"


# --- FR-INP-02: preferences ---------------------------------------------------------------------------


def test_preferences_are_enforced_and_listed(world, doc):
    snap, inputs, _, _ = world
    sold = doc["plans"][0]["transfers"][0]["out"]["id"]
    bought = doc["plans"][0]["transfers"][1]["in"]["id"]
    prefs = {"risk": "safe", "save_chips": ["wildcard", "3xc"], "keep": [{"id": sold, "name": "x"}], "avoid": [bought], "max_hits_per_gw": 0}
    # A plan file made without those preferences is refused outright.
    out = recompute(snap, submission(doc), doc, prefs=prefs)
    assert codes(out) == ["PLAN_PREFS_MISMATCH"] and "--prefs" in out["errors"][0]["message"]
    # With a plan file that claims them, each broken preference is named.
    claimed = {**doc, "prefs_resolved": {"save_chips": ["3xc", "wildcard"], "keep_ids": [sold], "avoid_ids": [bought], "max_hits_per_gw": 0}}
    sub = submission(doc)
    sub["chip"]["play"] = "3xc"
    sub["plan"][0]["chip"] = "3xc"
    out = recompute(snap, sub, claimed, prefs=prefs)
    assert sorted(codes(out)) == ["PREF_AVOID", "PREF_KEEP", "PREF_SAVE_CHIP"]
    assert inputs.players[sold].name in " ".join(e["message"] for e in out["errors"])
    hit = submission(doc, 3)
    out = recompute(snap, hit, {**doc, "prefs_resolved": {"save_chips": [], "keep_ids": [], "avoid_ids": [], "max_hits_per_gw": 0}}, prefs={"max_hits_per_gw": 0})
    assert codes(out) == ["PREF_MAX_HITS"]
    # Preferences the plan honours are listed in the recommendation.
    keep = doc["plans"][0]["gws"][0]["xi"][0]
    prefs = {"risk": "aggressive", "save_chips": ["wildcard"], "keep": [{"id": keep, "name": "x"}]}
    claimed = {**doc, "prefs_resolved": {"save_chips": ["wildcard"], "keep_ids": [keep], "avoid_ids": [], "max_hits_per_gw": None}}
    rec = recompute(snap, submission(doc), claimed, prefs=prefs)["recommendation"]
    assert rec["preferences"] == {"risk": "aggressive", "save_chips": ["wildcard"], "keep": [{"id": keep, "name": inputs.players[keep].name}], "avoid": [], "max_hits_per_gw": None}
    assert rec["chip"]["play"] != "wildcard" and keep in rec["starting_xi"] + rec["bench"]


# --- the plan file must belong to this snapshot and these inputs ---------------------------------------


def test_a_plan_file_from_other_inputs_is_refused(world, doc):
    snap = world[0]
    sub = submission(doc)
    assert codes(recompute(snap, sub, None)) == ["PLAN_MISSING"]
    assert codes(recompute(snap, sub, {"schema": "gaffer.plan/1", "plans": []})) == ["PLAN_MISSING"]
    assert codes(recompute(snap, sub, {**doc, "snapshot_id": "2026-27/6/other"})) == ["PLAN_SNAPSHOT_MISMATCH"]
    assert codes(recompute(snap, sub, {**doc, "gaffer_lib": "0.3.0"})) == ["PLAN_VERSION_MISMATCH"]
    out = recompute(snap, sub, doc, ft=1)  # the snapshot was taken with /team --ft 1; the plan was not
    assert codes(out) == ["PLAN_ASSUMPTIONS_MISMATCH", "PLAN_ASSUMPTIONS_MISMATCH"] and "--ft" in out["errors"][0]["message"]
    tampered = copy.deepcopy(doc)
    pid = str(doc["plans"][0]["gws"][0]["captain"])
    tampered["players"][pid]["xp"][0] += 3.0
    out = recompute(snap, sub, tampered)
    assert codes(out) == ["PLAN_XP_MISMATCH"] and tampered["players"][pid]["name"] in out["errors"][0]["message"]
    bad = copy.deepcopy(doc)
    bad["plans"] = [p for p in bad["plans"] if p["rank"] != 1]  # hiding the best plan leaves the others still checked
    assert recompute(snap, submission(doc, 2), bad)["valid"]
    for p in bad["plans"]:
        p["gws"][0]["captain"] = p["gws"][0]["bench"][0]
    assert codes(recompute(snap, submission(doc, 2), bad)) == ["PLAN_NO_VALID_PLANS"]


# --- FR-REC-03: bench order -------------------------------------------------------------------------


def test_the_bench_is_put_in_the_simulators_order(world, doc):
    snap = world[0]
    sub = submission(doc)
    best = list(sub["bench"])
    sub["bench"] = [best[3], best[0], best[2], best[1]]
    out = recompute(snap, sub, doc)
    rec = out["recommendation"]
    assert out["valid"] and rec["bench"] == best
    assert any(w.startswith("Bench order set by the auto-sub simulator") for w in rec["warnings"])
    assert not any("Bench order" in w for w in recompute(snap, submission(doc), doc)["recommendation"]["warnings"])


# --- FR-REC-10: minutes overrides are recorded with their quote -----------------------------------


@pytest.fixture
def news_snap(tmp_path):
    dst = tmp_path / "snap"
    shutil.copytree(SNAP_DIR, dst)
    b = json.loads((dst / "bootstrap-static.json").read_text())
    for e in b["elements"]:
        e["news"] = "Hamstring injury - Expected back 24 Oct" if e["web_name"] == "Saka" else ""
    (dst / "bootstrap-static.json").write_text(json.dumps(b))
    (dst / "manifest.json").write_text(json.dumps({"id": "snapshot-model"}))
    snap = Snapshot(dst)
    return snap, next(e["id"] for e in b["elements"] if e["web_name"] == "Saka")


def test_an_xmins_override_is_recorded_with_player_value_and_quote(world, news_snap):
    snap, saka = news_snap
    why = "stale data inside the last hour."
    x = [{"player": saka, "gw": 6, "xmins": 0, "quote": "Hamstring injury - Expected back 24 Oct", "source": "news"}]
    hold = cli.golden_path(snap, hold=True, xmins=x)
    assert hold["xmins_input"] == x and hold["xmins_overrides"] == [{"player": saka, "gw": 6, "xmins": 0.0}]
    _, inputs, _, state = world
    proj = X.project(inputs, 6, x)
    h = P.hold_step(state.squad, 6, inputs, proj)
    sub = hold_submission(world)
    sub.update(starting_xi=h["xi"], bench=h["bench"], captain={"id": h["captain"]}, vice_captain={"id": h["vice_captain"]})
    out = recompute(snap, sub, hold, finalise_blocked=why)
    assert out["valid"], out["errors"]
    rec = out["recommendation"]
    assert rec["xmins_overrides"] == [{"player": saka, "name": "Saka", "gw": 6, "xmins": 0, "quote": "Hamstring injury - Expected back 24 Oct", "source": "news"}]
    assert saka not in rec["starting_xi"] and rec["players"][str(saka)]["xp"] == 0.0
    # The quote has to be the player's news; a made-up one is refused, as is an override with none.
    for quote, code in (("He told me he is injured", "XMINS_QUOTE_NOT_IN_NEWS"), ("", "XMINS_QUOTE_MISSING")):
        bad = {**hold, "xmins_input": [{**x[0], "quote": quote}]}
        assert codes(recompute(snap, sub, bad, finalise_blocked=why)) == [code]
    said = {**hold, "xmins_input": [{**x[0], "quote": "my mate at the club says he is out", "source": "user"}]}
    assert recompute(snap, sub, said, finalise_blocked=why)["valid"]
    assert codes(recompute(snap, sub, {**hold, "xmins_input": [{**x[0], "xmins": 120}]}, finalise_blocked=why)) == ["XMINS_RANGE"]
    # A plan file that claims an override its numbers don't reflect is from other inputs.
    assert codes(recompute(snap, sub, {**cli.golden_path(snap, hold=True), "xmins_input": x}, finalise_blocked=why)) == ["PLAN_XP_MISMATCH"]


# --- the command ------------------------------------------------------------------------------------


def test_validate_request_command(world, doc, tmp_path, capsys):
    req = tmp_path / "req.json"
    req.write_text(json.dumps({"submission": submission(doc), "plan": doc, "prefs": None}))
    assert main(["validate", "--snapshot", str(SNAP_DIR), "--request", str(req)]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["valid"] and out["recommendation"]["gw"] == 6
    req.write_text(json.dumps({"submission": submission(doc, 3), "plan": doc}))
    assert main(["validate", "--snapshot", str(SNAP_DIR), "--request", str(req)]) == 1
    assert json.loads(capsys.readouterr().out)["errors"][0]["code"] == "NOT_NEAR_OPTIMAL"
    req.write_text(json.dumps({"submission": {"plan": [{}, {}, {}, {}]}, "plan": doc}))  # not a submission at all
    assert main(["validate", "--snapshot", str(SNAP_DIR), "--request", str(req)]) == 2
    assert "error" in json.loads(capsys.readouterr().out)
