"""FR-EVL-03 / FR-EVL-02: realised points of a pre-deadline decision, its B0/B1 baselines and the
projection error, on the frozen real GW6 snapshot (`snapshot-model`) and GW6's real results
(`result-2026-27-gw6.json`: event/6/live trimmed to minutes and total_points, fetched 2026-10-16)."""

import json
import subprocess
import sys

import pytest

for _dep in ("numpy", "scipy"):
    pytest.importorskip(_dep)

from conftest import DATA

from gaffer_lib import __version__
from gaffer_lib.outcomes import live_points, score
from gaffer_lib.snapshot import Snapshot

SNAP = Snapshot(DATA / "snapshot-model")
LIVE = json.loads((DATA / "result-2026-27-gw6.json").read_text())
PLAN = json.loads((DATA / "plan-model.json").read_text())
G = PLAN["plans"][0]["gws"][0]
REC = {"xi": G["xi"], "bench": G["bench"], "captain": G["captain"], "vice_captain": G["vice_captain"], "chip": None, "hit_cost": G["hit_cost"]}


def test_recommended_line_up_scored_by_hand():
    # Counted by hand from event/6/live: XI Kelleher 2, Calafiori 9, De Cuyper 15, Egan 1, B.Fernandes 1,
    # Saka 2, Groß 6, Szoboszlai 0 (0 min), Haaland 6, Barry 6, Wissa 2 = 50. Szoboszlai is replaced by the
    # first bench outfielder who keeps the formation, Konsa (4). Captain B.Fernandes played: +1 again. 55.
    out = score(SNAP, {"gw": 6, "live": LIVE, "lineups": {"rec": REC}})
    r = out["lineups"]["rec"]
    assert r["points"] == 55 and r["gross"] == 55 and r["hit_cost"] == 0
    assert r["autosubs"] == [[368, 31]] and r["armband"] == 426 and r["multiplier"] == 2
    assert r["bench_points"] == 6  # Button 0, Boscagli 5, M.Sangaré 1
    assert out["schema"] == "gaffer.score/1" and out["gaffer_lib"] == __version__ and out["snapshot_id"] == "snapshot-model"


def test_baselines_from_the_same_pre_deadline_squad_scored_by_hand():
    out = score(SNAP, {"gw": 6, "live": LIVE, "baselines": True})
    b0, b1 = out["baselines"]["B0"], out["baselines"]["B1"]
    # B0 holds; XI and captain by the official ep_next. XI 2+5+4+9+1+6+2+0+8+6+12 = 55, Szoboszlai (0 min)
    # replaced by M.Sangaré (1), captain Groß 6 doubled: 62.
    assert b0["decision"]["transfers"] == []
    assert b0["points"] == 62 and b0["autosubs"] == [[368, 565]] and b0["armband"] == 124
    # B1 spends its free transfer on the swap that gains most official xP (O'Reilly -> Bogle) and
    # captains Bogle: XI 2+1+5+4+9+1+6+2+0+6+12 = 48, Palmer (8) on for Szoboszlai, Bogle 1 again: 57.
    assert b1["decision"]["transfers"] == [[387, 330]]
    assert b1["points"] == 57 and b1["autosubs"] == [[368, 154]] and b1["armband"] == 330
    squad = set(b0["decision"]["xi"] + b0["decision"]["bench"])
    assert squad == {p["element"] for p in json.loads((DATA / "snapshot-model" / "picks-prev.json").read_text())["picks"]}


def test_b1_holds_without_a_free_transfer():
    out = score(SNAP, {"gw": 6, "live": LIVE, "baselines": True, "ft": 0})
    assert out["baselines"]["B1"]["decision"]["transfers"] == []
    assert out["baselines"]["B1"]["points"] == out["baselines"]["B0"]["points"]


def test_projection_error_compares_gaffer_and_the_official_xp_with_the_points():
    xp = {k: v["xp"][0] for k, v in PLAN["players"].items()}
    p = score(SNAP, {"gw": 6, "live": LIVE, "xp": xp})["projection"]
    assert p["players"] == 23
    pts, _ = live_points(LIVE)
    ep = {e["id"]: float(e["ep_next"]) for e in SNAP.bootstrap["elements"]}
    n = len(xp)
    assert p["mae_gaffer"] == round(sum(abs(x - pts.get(int(k), 0.0)) for k, x in xp.items()) / n, 3)
    assert p["mae_official"] == round(sum(abs(ep[int(k)] - pts.get(int(k), 0.0)) for k in xp) / n, 3)


def test_a_player_with_no_fixture_scores_zero_and_did_not_play():
    pts, mins = live_points({"elements": [{"id": 1, "stats": {"minutes": 0, "total_points": 0}}]})
    assert pts.get(2, 0.0) == 0.0 and mins.get(2, 0.0) == 0.0


def test_score_command_reads_the_request_on_stdin():
    req = json.dumps({"gw": 6, "live": LIVE, "lineups": {"rec": REC}, "baselines": True})
    r = subprocess.run([sys.executable, "-m", "gaffer_lib", "score", "--snapshot", str(DATA / "snapshot-model"), "--request", "-"],
                       input=req, capture_output=True, text=True, env={"PYTHONPATH": str(DATA.parents[1] / "src")}, check=False)
    assert r.returncode == 0, r.stdout + r.stderr
    out = json.loads(r.stdout.strip().splitlines()[-1])
    assert out["lineups"]["rec"]["points"] == 55 and out["baselines"]["B0"]["points"] == 62


PICKS = json.loads((DATA / "picks-2026-27-gw6.json").read_text())


def test_real_managers_gw6_points_are_reproduced_from_their_picks():
    """51 public 2026/27 entries' GW6 picks (sampled from the overall league on 2026-10-16; entry ids
    dropped): rebuilt to the deadline line-up, scored by lineup_points against event/6/live, minus the
    transfer cost, each equals FPL's own `entry_history.points - event_transfers_cost`. The sample has
    15 automatic subs, a Bench Boost, 4 Wildcards and 2 hits."""
    assert sum(len(p["automatic_subs"]) for p in PICKS) >= 10 and any(p["active_chip"] == "bboost" for p in PICKS)
    out = score(SNAP, {"gw": 6, "live": LIVE, "lineups": {str(i): {"picks": p} for i, p in enumerate(PICKS)}})["lineups"]
    wrong = [(i, o["points"], o["fpl_points"]) for i, o in out.items() if not o["matches_fpl"]]
    assert wrong == [], f"{len(wrong)}/{len(PICKS)} differ (index, ours, FPL's): {wrong[:5]}"
    assert any(o["hit_cost"] > 0 for o in out.values()) and any(o["chip"] == "bboost" for o in out.values())
