"""FR-RUL-03: XI formations and automatic substitutions."""

import pytest
from conftest import load_json, real_bootstrap_rules_part

from gaffer_lib import rules

R = rules.Rules.from_bootstrap(real_bootstrap_rules_part())
GK, DEF, MID, FWD = 1, 2, 3, 4


def squad(types_in_pick_order):
    return [rules.Pick(element=i + 1, position=i + 1, element_type=t) for i, t in enumerate(types_in_pick_order)]


# XI 1-4-4-2, bench GK, then DEF, MID, FWD
BASE = [GK, DEF, DEF, DEF, DEF, MID, MID, MID, MID, FWD, FWD, GK, DEF, MID, FWD]


def subs(picks, absent):
    return rules.automatic_subs(picks, lambda e: e not in absent, R)


@pytest.mark.parametrize(
    "xi,ok",
    [
        ((GK, DEF, DEF, DEF, MID, MID, MID, MID, MID, FWD, FWD), True),  # 3-5-2
        ((GK, DEF, DEF, DEF, DEF, DEF, MID, MID, FWD, FWD, FWD), True),  # 5-2-3
        ((GK, DEF, DEF, DEF, DEF, MID, MID, MID, MID, MID, FWD), True),  # 4-5-1
        ((GK, DEF, DEF, MID, MID, MID, MID, MID, FWD, FWD, FWD), False),  # 2 DEF
        ((GK, DEF, DEF, DEF, DEF, DEF, DEF, MID, MID, FWD, FWD), False),  # 6 DEF
        ((GK, DEF, DEF, DEF, DEF, DEF, MID, MID, MID, MID, MID), False),  # no FWD
        ((GK, GK, DEF, DEF, DEF, MID, MID, MID, MID, FWD, FWD), False),  # 2 GK
        ((DEF, DEF, DEF, DEF, MID, MID, MID, MID, MID, FWD, FWD), False),  # no GK
        ((GK, DEF, DEF, DEF, MID, MID, MID, MID, FWD, FWD), False),  # 10 players
    ],
)
def test_formations(xi, ok):
    assert rules.valid_formation(xi, R) is ok


def test_everyone_played_no_subs():
    assert subs(squad(BASE), set()) == []


def test_gk_absent_bench_gk_comes_in():
    assert subs(squad(BASE), {1}) == [(1, 12)]


def test_gk_absent_bench_gk_absent_no_sub():
    assert subs(squad(BASE), {1, 12}) == []


def test_outfield_never_replaced_by_gk():
    # MID absent, all outfield bench absent: the bench GK must not come in.
    assert subs(squad(BASE), {6, 13, 14, 15}) == []


def test_bench_order_is_respected():
    # MID 6 absent: first bench outfielder is DEF 13 → 5-3-2 is valid.
    assert subs(squad(BASE), {6}) == [(6, 13)]
    # ... unless DEF 13 also didn't play: then MID 14.
    assert subs(squad(BASE), {6, 13}) == [(6, 14)]


def test_def_sub_that_would_break_three_def_is_skipped():
    # 3-5-2 with DEF 2 absent; bench order MID, FWD, DEF: only the DEF keeps 3 DEF.
    picks = squad([GK, DEF, DEF, DEF, MID, MID, MID, MID, MID, FWD, FWD, GK, MID, FWD, DEF])
    assert subs(picks, {2}) == [(2, 15)]
    # With the bench DEF absent too, nobody can come on.
    assert subs(picks, {2, 15}) == []


def test_fwd_minimum_one():
    # 4-5-1 with the lone FWD absent; bench DEF, MID, FWD: only FWD 15 is legal.
    picks = squad([GK, DEF, DEF, DEF, DEF, MID, MID, MID, MID, MID, FWD, GK, DEF, MID, FWD])
    assert subs(picks, {11}) == [(11, 15)]


def test_multiple_absentees_use_bench_in_order():
    assert subs(squad(BASE), {6, 10, 1}) == [(1, 12), (6, 13), (10, 14)]


def test_subs_are_made_in_bench_boost_weeks_too():
    # Observed in the sample (GW1, active_chip bboost): FPL still swaps an absent starter for a bench player.
    assert subs(squad(BASE), {1, 6}) == [(1, 12), (6, 13)]


def unsub(record):
    """The deadline line-up. The API's picks are stored after auto-subs: each sub swaps the two
    players' slots, and the XI is then re-sorted by position type. So undo the swaps (latest first)
    and re-sort the XI (GK, DEF, MID, FWD), as FPL requires at the deadline."""
    pos = {p["element"]: p["position"] for p in record["picks"]}
    types = {p["element"]: p["element_type"] for p in record["picks"]}
    for s in reversed(record["automatic_subs"]):
        pos[s["element_in"]], pos[s["element_out"]] = pos[s["element_out"]], pos[s["element_in"]]
    xi = sorted((e for e in pos if pos[e] <= 11), key=lambda e: (types[e], pos[e]))
    pos.update({e: i + 1 for i, e in enumerate(xi)})
    return [rules.Pick(e, pos[e], types[e]) for e in pos]


RECORDS = load_json("autosubs-2026-27.json.gz")


def test_real_automatic_subs_records():
    """Every sampled 2026/27 entry-GW (250, of which 76 real automatic_subs records) is reproduced exactly."""
    n_subs = sum(len(r["automatic_subs"]) for r in RECORDS)
    assert n_subs >= 20
    wrong = []
    for r in RECORDS:
        played = lambda e, m=r["minutes"]: m[str(e)] > 0  # noqa: E731
        got = rules.automatic_subs(unsub(r), played, R)
        want = [(s["element_out"], s["element_in"]) for s in r["automatic_subs"]]
        if got != want:
            wrong.append((r["gw"], got, want))
    assert wrong == [], f"{len(wrong)}/{len(RECORDS)} entry-GWs differ, e.g. {wrong[:3]}"
