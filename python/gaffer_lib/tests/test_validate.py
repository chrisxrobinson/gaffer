"""validate: the deterministic gate over a proposed plan, and the CLI."""

import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

from conftest import DATA
from hypothesis import given, settings
from hypothesis import strategies as st

from gaffer_lib.derive import derive
from gaffer_lib.snapshot import Snapshot
from gaffer_lib.validate import validate

SNAP = Snapshot(DATA / "snapshot-entry-1")
STATE = derive(SNAP)
SQUAD = [p["id"] for p in STATE["squad"]]
ELS = {e["id"]: e for e in SNAP.bootstrap["elements"]}
BY_POS = {pos: [p for p in STATE["squad"] if p["position"] == pos] for pos in ("GKP", "DEF", "MID", "FWD")}
SRC = Path(__file__).parents[1] / "src"


def codes(res):
    return {e["code"] for e in res["errors"]}


def replacement(out_id, max_cost=None, exclude=()):
    """A same-position player not in the squad, from a club with < 2 squad players, affordable."""
    o = ELS[out_id]
    clubs = Counter(ELS[p]["team"] for p in SQUAD if p != out_id)
    cands = [
        e for e in ELS.values()
        if e["element_type"] == o["element_type"] and e["id"] not in SQUAD and e["id"] not in exclude
        and clubs[e["team"]] < 2 and (max_cost is None or e["now_cost"] <= max_cost)
    ]
    return min(cands, key=lambda e: (e["now_cost"], e["id"]))


def xi_bench():
    """The GW4 line-up as XI + bench (pick order)."""
    order = sorted(STATE["squad"], key=lambda p: p["pick_position"])
    return [p["id"] for p in order[:11]], [p["id"] for p in order[11:]]


def test_no_transfers_is_valid():
    xi, bench = xi_bench()
    res = validate(SNAP, {"transfers": [], "xi": xi, "bench": bench, "captain": xi[5], "vice_captain": xi[6]})
    assert res["valid"], res["errors"]
    assert res["gws"][0] == {"gw": 6, "ft_available": 3, "transfers": 0, "hits": 0, "hit_cost": 0, "chip": None, "bank_after": STATE["bank"], "ft_next": 4}


def test_free_transfer_within_budget():
    out = BY_POS["DEF"][-1]
    inn = replacement(out["id"])
    res = validate(SNAP, {"transfers": [{"out": out["id"], "in": inn["id"]}], "hits": 0})
    assert res["valid"], res["errors"]
    assert res["gws"][0]["bank_after"] == STATE["bank"] + out["selling_price"] - inn["now_cost"]


def test_hits_are_recomputed_and_checked():
    moves, chosen = [], []
    for p in BY_POS["DEF"][:4]:
        r = replacement(p["id"], exclude=chosen)
        chosen.append(r["id"])
        moves.append({"out": p["id"], "in": r["id"]})
    res = validate(SNAP, {"transfers": moves, "hits": 0})  # 4 transfers with 3 FT = 1 hit
    assert "HIT_MISMATCH" in codes(res)
    assert res["gws"][0]["hits"] == 1 and res["gws"][0]["hit_cost"] == 4


def test_user_ft_override_is_used_by_the_validator():
    """FR-INP-04: --ft 1 makes the same two transfers cost a hit; ft_source is recorded."""
    moves, chosen = [], []
    for p in BY_POS["DEF"][:2]:
        r = replacement(p["id"], exclude=chosen)
        chosen.append(r["id"])
        moves.append({"out": p["id"], "in": r["id"]})
    derived = validate(SNAP, {"transfers": moves})
    user = validate(SNAP, {"transfers": moves}, ft=1)
    assert derived["gws"][0]["hits"] == 0 and derived["assumptions"]["ft_source"] == "derived"
    assert user["gws"][0]["hits"] == 1 and user["assumptions"] == {"free_transfers": 1, "ft_source": "user", "pending_transfers": []}
    three = validate(SNAP, {"transfers": moves}, ft=3)
    assert three["assumptions"]["free_transfers"] == 3 and three["gws"][0]["ft_available"] == 3


def test_pending_transfers_count_towards_the_first_gw():
    a, b = BY_POS["DEF"][0], BY_POS["DEF"][1]
    ra = replacement(a["id"])
    rb = replacement(b["id"], exclude=[ra["id"]])
    res = validate(SNAP, {"transfers": [{"out": b["id"], "in": rb["id"]}]}, ft=1, pending=f"{a['id']}>{ra['id']}")
    assert res["gws"][0]["transfers"] == 2 and res["gws"][0]["hits"] == 1


def test_illegal_moves():
    haaland = next(p for p in STATE["squad"] if p["name"] == "Haaland")
    gk = BY_POS["GKP"][0]
    fwd_not_in = replacement(haaland["id"])
    res = validate(SNAP, {"transfers": [{"out": gk["id"], "in": fwd_not_in["id"]}]})
    assert "POSITION_QUOTA" in codes(res)
    res = validate(SNAP, {"transfers": [{"out": 999999, "in": gk["id"]}]})
    assert "UNKNOWN_PLAYER" in codes(res)
    res = validate(SNAP, {"transfers": [{"out": gk["id"], "in": BY_POS["GKP"][1]["id"]}]})
    assert "TRANSFER_IN_ALREADY_IN_SQUAD" in codes(res)
    cheap = min(BY_POS["FWD"], key=lambda p: p["selling_price"])
    dear = max((e for e in ELS.values() if e["element_type"] == 4 and e["id"] not in SQUAD), key=lambda e: e["now_cost"])
    assert "OVER_BUDGET" in codes(validate(SNAP, {"transfers": [{"out": cheap["id"], "in": dear["id"]}]}))


def test_chip_checks():
    assert codes(validate(SNAP, {"chip": "wildcard"})) == {"CHIP_ALREADY_USED"}  # used in GW3
    assert validate(SNAP, {"chip": "3xc"})["valid"]
    assert "CHIP_ONE_PER_GW" in codes(validate(SNAP, {"chip": ["3xc", "bboost"]}))
    plan = {"gws": [{"gw": 6, "chip": "3xc"}, {"gw": 7, "chip": "3xc"}]}
    assert codes(validate(SNAP, plan)) == {"CHIP_ALREADY_USED"}  # the plan can't use a chip twice either


def test_multi_gw_plan_threads_ft_and_bank():
    out = BY_POS["MID"][-1]
    inn = replacement(out["id"])
    plan = {"gws": [{"gw": 6, "transfers": []}, {"gw": 7, "transfers": [{"out": out["id"], "in": inn["id"]}]}, {"gw": 8}]}
    res = validate(SNAP, plan)
    assert res["valid"], res["errors"]
    assert [g["ft_available"] for g in res["gws"]] == [3, 4, 4]
    assert codes(validate(SNAP, {"gws": [{"gw": 7}]})) == {"GW_SEQUENCE"}


def test_xi_bench_captain_checks():
    xi, bench = xi_bench()
    gk_first = bench[0]
    assert "BENCH_GK_FIRST" in codes(validate(SNAP, {"xi": xi, "bench": bench[1:] + [gk_first]}))
    three_def_to_two = [p for p in xi if ELS[p]["element_type"] != 2][:9] + [p for p in xi if ELS[p]["element_type"] == 2][:2]
    assert "FORMATION" in codes(validate(SNAP, {"xi": three_def_to_two}))
    assert "CAPTAIN_NOT_IN_XI" in codes(validate(SNAP, {"xi": xi, "captain": bench[1]}))
    assert "CAPTAIN_IS_VICE" in codes(validate(SNAP, {"xi": xi, "captain": xi[3], "vice_captain": xi[3]}))


@settings(max_examples=150, deadline=None)
@given(st.lists(st.tuples(st.sampled_from(SQUAD), st.sampled_from(sorted(ELS))), max_size=4))
def test_every_accepted_plan_is_legal(moves):
    res = validate(SNAP, {"transfers": [{"out": o, "in": i} for o, i in moves]})
    if res["valid"]:
        squad = list(SQUAD)
        for o, i in moves:
            squad = [i if x == o else x for x in squad]
        assert len(set(squad)) == 15
        assert Counter(ELS[p]["element_type"] for p in squad) == Counter({1: 2, 2: 5, 3: 5, 4: 3})
        assert max(Counter(ELS[p]["team"] for p in squad).values()) <= 3
        assert res["gws"][0]["bank_after"] >= 0


def run_cli(*args, stdin=None):
    env = {"PYTHONPATH": str(SRC), "PATH": "/usr/bin:/bin"}
    return subprocess.run([sys.executable, "-m", "gaffer_lib", *args], capture_output=True, text=True, input=stdin, env=env)


def test_cli_derive_and_validate():
    r = run_cli("derive", "--snapshot", str(DATA / "snapshot-entry-1"), "--ft", "2")
    assert r.returncode == 0, r.stderr
    d = json.loads(r.stdout)
    assert d["assumptions"]["free_transfers"] == 2 and d["assumptions"]["ft_source"] == "user"
    r = run_cli("validate", "--snapshot", str(DATA / "snapshot-entry-1"), "--proposal", "-", stdin=json.dumps({"chip": "wildcard"}))
    assert r.returncode == 1 and json.loads(r.stdout)["errors"][0]["code"] == "CHIP_ALREADY_USED"
    r = run_cli("derive", "--snapshot", str(DATA / "snapshot-entry-1"), "--pending", "Nobody>Somebody")
    assert r.returncode == 2 and "no player called" in json.loads(r.stdout)["error"]
    r = run_cli("derive", "--snapshot", "/nonexistent")
    assert r.returncode == 2


# --- PROPOSED, NOT BUILT: a squad that already holds four from one club -------------------------------
#
# FR-RUL-02 as built rejects any squad with more than `squad_team_limit` players from a club. FPL
# lets a manager keep a fourth player who joined that club in real life; only *adding* to the club
# is barred. Today `validate` therefore fails every plan for such a manager, and so would the
# submit gate. The change proposed in BUILD.md (M4, "Blocked on you") is: CLUB_LIMIT applies to a GW
# only if that GW's transfers bring a player in from a club that is over the limit afterwards.
# These tests state that behaviour. They are expected to fail until the change is approved and made
# (strict: they will fail the suite, as a reminder to remove the marker, once it is).

import shutil  # noqa: E402

import pytest  # noqa: E402

proposed = pytest.mark.xfail(strict=True, reason="proposed FR-RUL-02 change (four from one club after a real-life move): awaiting a decision")


@pytest.fixture
def four_from_one_club(tmp_path):
    """The frozen snapshot, with one squad player moved in real life to a club the squad has three of."""
    clubs = Counter(ELS[p]["team"] for p in SQUAD)
    club = next(c for c, n in clubs.items() if n == 3)
    mover = next(p for p in SQUAD if ELS[p]["team"] != club and clubs[ELS[p]["team"]] == 1)
    dst = tmp_path / "snap"
    shutil.copytree(DATA / "snapshot-entry-1", dst)
    b = json.loads((dst / "bootstrap-static.json").read_text())
    next(e for e in b["elements"] if e["id"] == mover)["team"] = club
    (dst / "bootstrap-static.json").write_text(json.dumps(b))
    return Snapshot(dst), club, mover


def test_today_such_a_squad_fails_every_plan(four_from_one_club):
    """The behaviour as built, so the proposal's effect is visible: holding is already 'illegal'."""
    snap, _, _ = four_from_one_club
    assert "CLUB_LIMIT" in codes(validate(snap, {"transfers": []}))


@proposed
def test_proposed_holding_four_after_a_real_life_move_is_legal(four_from_one_club):
    snap, _, _ = four_from_one_club
    xi, bench = xi_bench()
    assert validate(snap, {"transfers": [], "xi": xi, "bench": bench})["valid"]


@proposed
def test_proposed_a_transfer_elsewhere_is_legal(four_from_one_club):
    snap, club, _ = four_from_one_club
    out = next(p for p in SQUAD if ELS[p]["team"] != club)
    res = validate(snap, {"transfers": [{"out": out, "in": replacement(out)["id"]}]})
    assert "CLUB_LIMIT" not in codes(res)


def test_proposed_adding_to_the_club_stays_illegal(four_from_one_club):
    """A fifth player from the club, or swapping one of the four for another from it, is refused
    (this already holds, and must still hold after the change)."""
    snap, club, _ = four_from_one_club
    els = {e["id"]: e for e in snap.bootstrap["elements"]}
    squad_club = [p for p in SQUAD if els[p]["team"] == club]
    outsider = next(p for p in SQUAD if els[p]["team"] != club)
    fifth = next(e for e in els.values() if e["team"] == club and e["id"] not in SQUAD and e["element_type"] == els[outsider]["element_type"])
    assert "CLUB_LIMIT" in codes(validate(snap, {"transfers": [{"out": outsider, "in": fifth["id"]}]}))
    one = squad_club[0]
    like = next(e for e in els.values() if e["team"] == club and e["id"] not in SQUAD and e["element_type"] == els[one]["element_type"])
    assert "CLUB_LIMIT" in codes(validate(snap, {"transfers": [{"out": one, "in": like["id"]}]}))


def test_selling_one_of_the_four_is_legal_already(four_from_one_club):
    """The one move such a manager can make today: selling down to three."""
    snap, club, _ = four_from_one_club
    els = {e["id"]: e for e in snap.bootstrap["elements"]}
    one = next(p for p in SQUAD if els[p]["team"] == club)
    clubs = Counter(els[p]["team"] for p in SQUAD if p != one)
    new = min((e for e in els.values() if e["element_type"] == els[one]["element_type"] and e["id"] not in SQUAD and e["team"] != club and clubs[e["team"]] < 3), key=lambda e: e["now_cost"])
    assert "CLUB_LIMIT" not in codes(validate(snap, {"transfers": [{"out": one, "in": new["id"]}]}))
