"""derive: FT count, purchase and selling prices, bank, chips (FR-DAT-08 machinery, FR-INP-04, FR-RUL-07)."""

import json
import shutil

import pytest
from conftest import DATA, load_json, real_bootstrap_rules_part

from gaffer_lib import rules
from gaffer_lib.derive import DeriveError, derive, derive_free_transfers
from gaffer_lib.snapshot import Snapshot

R = rules.Rules.from_bootstrap(real_bootstrap_rules_part())
ENTRY1 = DATA / "snapshot-entry-1"


def snapshot_copy(tmp_path, **changes):
    """A writable copy of the entry-1 snapshot with some files replaced or edited."""
    d = tmp_path / "snap"
    shutil.copytree(ENTRY1, d)
    for name, fn in changes.items():
        p = d / f"{name.replace('_', '-')}.json"
        data = json.loads(p.read_text()) if p.exists() else None
        p.write_text(json.dumps(fn(data)))
    return Snapshot(d)


def row(gw, transfers=0, cost=0):
    return {"event": gw, "event_transfers": transfers, "event_transfers_cost": cost}


# --- entry 1, GW5 (real, frozen 2026-09-29): BB GW2, WC GW3, FH GW5 ------------------------------


def test_entry1_real_snapshot():
    d = derive(Snapshot(ENTRY1))
    assert d["gw"] == {"current": 5, "next": 6, "deadline": "2026-10-10T10:00:00Z"}
    # Free Hit in GW5 → the GW6 squad and bank are GW4's.
    assert d["squad_basis_gw"] == 4
    prev = json.loads((ENTRY1 / "picks-prev.json").read_text())
    assert [p["id"] for p in d["squad"]] == [p["element"] for p in prev["picks"]]
    assert d["bank"] == prev["entry_history"]["bank"]
    # FTs: GW2 1 (BB, 0 transfers) → GW3 2 (WC keeps) → GW4 2 (0 transfers) → GW5 3 (FH keeps) → GW6 3.
    assert d["free_transfers"]["value"] == 3
    assert [t["ft_next"] for t in d["free_transfers"]["trace"]] == [1, 2, 2, 3, 3]
    assert d["free_transfers"]["source"] == "derived" and d["assumptions"] == {"free_transfers": 3, "ft_source": "derived", "pending_transfers": []}
    # FH-week transfers never set a purchase price; everything else comes from the latest transfer in.
    assert all(p["purchase_gw"] != 5 for p in d["squad"])
    for p in d["squad"]:
        assert p["selling_price"] == rules.selling_price(p["purchase_price"], p["now_cost"], R)
    assert d["budget"] == d["bank"] + sum(p["selling_price"] for p in d["squad"])
    chips = {(c["name"], c["half"]): c for c in d["chips"]}
    assert chips[("bboost", 1)]["used_in"] == 2 and chips[("wildcard", 1)]["used_in"] == 3 and chips[("freehit", 1)]["used_in"] == 5
    assert [k for k, c in chips.items() if c["available"]] == [("3xc", 1)]


# --- FT replay ------------------------------------------------------------------------------------


def test_ft_banked_to_the_cap():
    got = derive_free_transfers([row(g) for g in range(1, 9)], [], R)
    assert got["value"] == 5 and got["confidence"] == "high"


def test_ft_hits_and_rolls():
    rows = [row(1), row(2, 0), row(3, 3, 4), row(4, 1), row(5, 0)]
    # GW2: 1 → 2. GW3: 3 transfers with 2 FT = one hit (4 pts) → 1. GW4: 1 used → 1. GW5: → 2. GW6: 2.
    got = derive_free_transfers(rows, [], R)
    assert [t["ft_next"] for t in got["trace"]] == [1, 2, 1, 1, 2]
    assert got["value"] == 2 and got["issues"] == []


def test_ft_wc_and_fh_keep_the_count():
    rows = [row(1), row(2), row(3), row(4), row(5)]
    chips = [{"name": "wildcard", "event": 3}, {"name": "freehit", "event": 5}]
    assert derive_free_transfers(rows, chips, R)["value"] == 3


def test_ft_hits_reanchor_a_wrong_replay():
    # The replay says 2 FT in GW3, but 4 transfers cost 4 points → 3 FT were available.
    rows = [row(1), row(2), row(3, 4, 4)]
    got = derive_free_transfers(rows, [], R)
    assert got["confidence"] == "medium" and "Re-anchored" in got["issues"][0]
    assert got["value"] == 1


def test_ft_missing_history_rows_still_accrue():
    got = derive_free_transfers([row(1), row(4)], [], R)
    assert got["value"] == 4


def test_ft_team_that_hasnt_played_a_gw_yet():
    assert derive_free_transfers([], [], R)["unlimited"] is True


def test_ft_replay_is_consistent_with_every_real_hit():
    """50 real 2026/27 histories: every week's hit cost matches the replayed FT count, and
    event_transfers equals the listed transfers except in WC/FH weeks, where it is 0."""
    histories = load_json("ft-histories-2026-27.json")
    assert len(histories) == 50
    for h in histories:
        rows = h["gws"]
        chips = [{"name": r["chip"], "event": r["event"]} for r in rows if r["chip"]]
        got = derive_free_transfers(rows, chips, R)
        assert got["issues"] == [], got["issues"]
        for r in rows:
            if r["chip"] in ("wildcard", "freehit"):
                assert r["event_transfers"] == 0
            else:
                assert r["event_transfers"] == r["listed_transfers"]
    n_hits = sum(1 for h in histories for r in h["gws"] if r["event_transfers_cost"] > 0)
    assert n_hits > 0  # the check is not vacuous


def test_ft_cap_from_bootstrap_via_derive(tmp_path):
    """FR-RUL-07: max_extra_free_transfers 3 in the snapshot caps derived FTs at 4, no code change."""

    def edit_boot(b):
        b["game_settings"]["max_extra_free_transfers"] = 3
        return b

    def long_history(h):
        h["current"] = [dict(h["current"][0], event=g, event_transfers=0, event_transfers_cost=0) for g in range(1, 6)]
        h["chips"] = []
        return h

    snap = snapshot_copy(tmp_path, bootstrap_static=edit_boot, history=long_history)
    assert derive(snap)["free_transfers"]["value"] == 4


# --- FR-INP-04: user override and pending transfers -------------------------------------------------


def test_ft_override_is_used_and_recorded():
    d = derive(Snapshot(ENTRY1), ft=1)
    assert d["free_transfers"]["value"] == 1 and d["free_transfers"]["source"] == "user" and d["free_transfers"]["derived"] == 3
    assert d["assumptions"]["free_transfers"] == 1 and d["assumptions"]["ft_source"] == "user"
    assert any("You set 1 free transfers" in w for w in d["warnings"])


@pytest.mark.parametrize("bad", [-1, 6])
def test_ft_override_range(bad):
    with pytest.raises(DeriveError):
        derive(Snapshot(ENTRY1), ft=bad)


def cheapest_same_position_not_in_squad(d, snap, position):
    squad = {p["id"] for p in d["squad"]}
    types = {t["id"]: t["singular_name_short"] for t in snap.bootstrap["element_types"]}
    return min((e for e in snap.bootstrap["elements"] if types[e["element_type"]] == position and e["id"] not in squad), key=lambda e: (e["now_cost"], e["id"]))


def test_pending_transfers_by_name_and_id():
    snap = Snapshot(ENTRY1)
    base = derive(snap)
    out = next(p for p in base["squad"] if p["name"] == "Egan")
    cheap = cheapest_same_position_not_in_squad(base, snap, "DEF")
    d = derive(snap, pending=f"egan>{cheap['id']}")
    pend = d["pending"]
    assert pend["transfers"][0]["out"] == out["id"] and pend["transfers"][0]["in"] == cheap["id"]
    assert pend["count"] == 1 and pend["hits"] == 0 and pend["ft_remaining"] == 2
    assert pend["bank_after"] == base["bank"] + out["selling_price"] - cheap["now_cost"]
    assert pend["violations"] == []
    assert d["assumptions"]["pending_transfers"] == [[out["id"], cheap["id"]]]


def test_pending_transfers_beyond_fts_are_hits():
    snap = Snapshot(ENTRY1)
    base = derive(snap)
    defs = [p for p in base["squad"] if p["position"] == "DEF"][:2]
    others = sorted((e for e in snap.bootstrap["elements"] if e["element_type"] == 2 and e["id"] not in {p["id"] for p in base["squad"]} and e["now_cost"] <= 40), key=lambda e: e["id"])
    spec = ",".join(f"{a['id']}>{b['id']}" for a, b in zip(defs, others[:2]))
    d = derive(snap, ft=1, pending=spec)
    assert d["pending"]["hits"] == 1 and d["pending"]["hit_cost"] == 4 and d["pending"]["ft_remaining"] == 0


def test_pending_over_budget_is_flagged():
    snap = Snapshot(ENTRY1)
    base = derive(snap)
    cheap_def = min((p for p in base["squad"] if p["position"] == "DEF"), key=lambda p: p["selling_price"])
    dear = max((e for e in snap.bootstrap["elements"] if e["element_type"] == 2 and e["id"] not in {p["id"] for p in base["squad"]}), key=lambda e: e["now_cost"])
    d = derive(snap, pending=f"{cheap_def['id']}>{dear['id']}")
    assert "OVER_BUDGET" in {v["code"] for v in d["pending"]["violations"]}


def test_pending_unknown_or_not_in_squad():
    with pytest.raises(DeriveError, match="in the squad"):
        derive(Snapshot(ENTRY1), pending="Salah>Palmer")  # Salah isn't in this squad
    with pytest.raises(DeriveError, match="OUT>IN"):
        derive(Snapshot(ENTRY1), pending="Egan")


# --- purchase prices -------------------------------------------------------------------------------


def test_late_joiner_without_price_history_is_flagged(tmp_path):
    snap = snapshot_copy(tmp_path, entry=lambda e: dict(e, started_event=2))
    d = derive(snap)
    held = [p for p in d["squad"] if p["purchase_source"] in ("unknown", "joined_late")]
    assert held and all(p["purchase_source"] == "unknown" and p["selling_price"] == p["now_cost"] for p in held)
    assert any("Purchase price unknown" in w for w in d["warnings"])
