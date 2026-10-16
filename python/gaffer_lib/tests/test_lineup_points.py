"""FR-EVL-03: a finished GW's points for a line-up, scored by rules.automatic_subs and Scoring's
captaincy and chip rules. Every expected total below is counted by hand from FPL's rules."""

from conftest import real_bootstrap_rules_part

from gaffer_lib import rules

R = rules.Rules.from_bootstrap(real_bootstrap_rules_part())
GK, DEF, MID, FWD = 1, 2, 3, 4
# Players 1-15: XI 1-4-4-2 (1 GK; 2-5 DEF; 6-9 MID; 10-11 FWD), bench 12 GK, 13 DEF, 14 MID, 15 FWD.
ET = {1: GK, **{i: DEF for i in range(2, 6)}, **{i: MID for i in range(6, 10)}, 10: FWD, 11: FWD, 12: GK, 13: DEF, 14: MID, 15: FWD}
XI, BENCH = list(range(1, 12)), [12, 13, 14, 15]
# GW points: starters 1-11 score 1..11 (player n scores n); bench 12-15 score 20, 3, 4, 5.
PTS = {**{i: float(i) for i in range(1, 12)}, 12: 20.0, 13: 3.0, 14: 4.0, 15: 5.0}
STARTERS_TOTAL = sum(range(1, 12))  # 66


def score(captain=10, vice=11, chip=None, absent=(), pts=PTS, hit_cost=0, xi=XI, bench=BENCH):
    played = lambda p: p not in absent  # noqa: E731
    return rules.lineup_points(xi, bench, captain, vice, chip, pts, played, ET, R, hit_cost)


def test_everyone_plays_captain_doubled():
    s = score()
    assert s["points"] == STARTERS_TOTAL + 10  # 66 + the captain's 10 again
    assert s["armband"] == 10 and s["multiplier"] == 2 and s["autosubs"] == []
    assert s["bench_points"] == 20 + 3 + 4 + 5


def test_hits_are_deducted():
    assert score(hit_cost=8)["points"] == STARTERS_TOTAL + 10 - 8
    assert score(hit_cost=8)["gross"] == STARTERS_TOTAL + 10


def test_auto_sub_first_bench_player_who_keeps_the_formation():
    # DEF 3 doesn't play (0 points): the first outfield bench player, DEF 13 (3 points), comes on.
    s = score(absent={3}, pts={**PTS, 3: 0.0})
    assert s["autosubs"] == [[3, 13]]
    assert s["points"] == STARTERS_TOTAL - 3 + 3 + 10


def test_auto_sub_skips_a_bench_player_who_would_break_the_formation():
    # A MID absent from a 4-4-2 is replaced by the first outfield bench player, DEF 13 (5-3-2 is legal).
    s = score(absent={6}, pts={**PTS, 6: 0.0})
    assert s["autosubs"] == [[6, 13]]
    # A 3-5-2 (DEF 5 benched, MID 14 starts) with DEF 2 absent: FWD 15, first on the bench, would
    # leave two defenders, so he is skipped and DEF 5 comes on.
    xi352 = [1, 2, 3, 4, 6, 7, 8, 9, 14, 10, 11]
    bench352 = [12, 15, 5, 13]
    played = lambda p: p != 2  # noqa: E731
    s = rules.lineup_points(xi352, bench352, 10, 11, None, {**PTS, 2: 0.0}, played, ET, R)
    assert s["autosubs"] == [[2, 5]]


def test_captain_does_not_play_vice_is_doubled():
    # Captain 10 (FWD) has 0 minutes: the first bench player who keeps a legal formation is DEF 13
    # (3 points; 5-4-1 is legal), and the vice (11) is doubled instead.
    s = score(absent={10}, pts={**PTS, 10: 0.0})
    assert s["autosubs"] == [[10, 13]]
    assert s["armband"] == 11 and s["multiplier"] == 2
    assert s["points"] == (STARTERS_TOTAL - 10) + 3 + 11
    assert s["captain_points"] == 11


def test_neither_captain_nor_vice_plays_nobody_is_doubled():
    s = score(absent={10, 11}, pts={**PTS, 10: 0.0, 11: 0.0})
    assert s["armband"] is None and s["multiplier"] == 1
    # FWD 10 out: DEF 13 comes on (5-4-1). FWD 11 out: MID 14 would leave no forward, so FWD 15.
    assert s["autosubs"] == [[10, 13], [11, 15]]
    assert s["points"] == (STARTERS_TOTAL - 21) + 3 + 5


def test_goalkeeper_replaced_only_by_the_bench_goalkeeper():
    s = score(absent={1}, pts={**PTS, 1: 0.0})
    assert s["autosubs"] == [[1, 12]]
    assert s["points"] == STARTERS_TOTAL - 1 + 20 + 10


def test_bench_boost_counts_all_fifteen():
    s = score(chip="bboost")
    assert s["points"] == STARTERS_TOTAL + 32 + 10  # all 15 + the captain again
    assert sorted(s["counted"]) == list(range(1, 16))


def test_bench_boost_with_an_absent_starter_counts_the_bench_once():
    # FPL records the sub in a Bench Boost week, but the bench already scores: nothing is counted twice.
    s = score(chip="bboost", absent={3}, pts={**PTS, 3: 0.0})
    assert s["autosubs"] == [[3, 13]]
    assert s["points"] == (STARTERS_TOTAL - 3) + 32 + 10


def test_triple_captain_and_its_transfer_to_the_vice():
    assert score(chip="3xc")["points"] == STARTERS_TOTAL + 2 * 10
    s = score(chip="3xc", absent={10}, pts={**PTS, 10: 0.0})
    assert s["armband"] == 11 and s["multiplier"] == 3
    assert s["points"] == (STARTERS_TOTAL - 10) + 3 + 2 * 11


def test_double_gw_points_are_the_sum_the_caller_passes():
    # A DGW captain with 6 + 9 = 15: doubled to 30.
    s = score(pts={**PTS, 10: 15.0})
    assert s["points"] == STARTERS_TOTAL - 10 + 30


def test_negative_points_are_doubled_too():
    s = score(pts={**PTS, 10: -2.0})
    assert s["points"] == STARTERS_TOTAL - 10 - 4
