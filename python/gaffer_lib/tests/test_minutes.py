"""gaffer_lib.minutes: rules + recency expected minutes."""

import pytest
from hypothesis import given, strategies as st

from gaffer_lib import minutes as M
from gaffer_lib.inputs import PlayerData


def player(rows, *, games=None, starts=None, element_type=3, now_cost=60, prev=None, **kw):
    recent = [{"gw": i + 1, "games": 1, "minutes": m, "starts": s} for i, (m, s) in enumerate(rows)]
    totals = {"games": len(rows) if games is None else games, "starts": sum(s for _, s in rows) if starts is None else starts}
    return PlayerData(id=1, team=1, element_type=element_type, now_cost=now_cost, totals=totals, prev=prev, recent=recent, **kw)


def test_nailed_starter():
    b = M.baseline(player([(90, 1)] * 6))
    assert b.p_start > 0.95 and b.mins_start > 85 and b.p60_start > 0.9
    m = M.expected_minutes(b)
    assert m.xmins > 82 and m.p60 > 0.88 and m.p_play >= m.p_start >= m.p60


def test_bench_player_who_comes_on():
    b = M.baseline(player([(20, 0), (0, 0), (25, 0), (0, 0), (15, 0), (0, 0)]))
    assert b.p_start < 0.05
    assert 0.3 < b.p_sub < 0.6 and 15 < b.mins_sub < 25
    m = M.expected_minutes(b)
    assert m.p60 < 0.05 and 5 < m.xmins < 15 and m.p_short > 0.3


def test_recency_outweighs_older_games():
    lost_place = M.baseline(player([(90, 1)] * 4 + [(0, 0)] * 2))
    won_place = M.baseline(player([(0, 0)] * 2 + [(90, 1)] * 4))
    assert lost_place.p_start < 0.6 < won_place.p_start
    # Same season totals, so the difference is recency alone.
    assert lost_place.p_start < won_place.p_start - 0.15


def test_early_substitutions_lower_p60():
    b = M.baseline(player([(55, 1)] * 6))
    assert b.p60_start < 0.3 and 55 <= b.mins_start < 65


def test_previous_season_is_the_prior_before_any_game():
    regular = M.baseline(player([], games=0, starts=0, prev={"games": 38, "starts": 36}))
    fringe = M.baseline(player([], games=0, starts=0, prev={"games": 38, "starts": 4}))
    assert regular.p_start == pytest.approx(36 / 38) and fringe.p_start == pytest.approx(4 / 38)


def test_no_history_uses_price():
    assert M.no_history_start_prob(40) == pytest.approx(0.08)
    assert M.no_history_start_prob(50) == pytest.approx(0.48)
    assert M.no_history_start_prob(130) == 0.9
    assert M.baseline(player([], games=0, starts=0, now_cost=45)).p_start == pytest.approx(0.28)


def test_double_gw_rows_count_towards_start_share_only():
    p = player([(90, 1)] * 3)
    p.recent.append({"gw": 4, "games": 2, "minutes": 180, "starts": 2})
    p.totals = {"games": 5, "starts": 5}
    b = M.baseline(p)
    assert b.p_start > 0.95 and b.mins_start <= 90


@pytest.mark.parametrize(
    "status,chance,k,expected",
    [
        ("a", None, 0, 1.0), ("a", 100, 3, 1.0),
        ("d", 75, 0, 0.75), ("d", 50, 1, 0.75), ("d", 50, 2, 1.0), ("d", None, 0, 0.5),
        ("i", 0, 0, 0.0), ("i", 0, 2, 0.5), ("i", 0, 4, 1.0), ("i", 25, 0, 0.25), ("i", None, 0, 0.0),
        ("s", 0, 0, 0.0), ("s", 0, 1, 0.5), ("s", 0, 2, 1.0),
        ("n", 0, 0, 0.0), ("n", 0, 1, 1.0),
        ("u", 0, 0, 0.0), ("u", None, 5, 0.0), ("u", 100, 0, 0.0),
    ],
)
def test_availability_rules(status, chance, k, expected):
    assert M.availability(status, chance, k) == pytest.approx(expected)


def test_injured_player_has_no_minutes_next_gw():
    b = M.baseline(player([(90, 1)] * 6))
    assert M.expected_minutes(b, M.availability("i", 0, 0)) == M.Minutes(0.0, 0.0, 0.0, 0.0, b.mins_start)
    later = M.expected_minutes(b, M.availability("i", 0, 2))
    assert later.xmins == pytest.approx(0.5 * b.xmins)


def test_overrides():
    b = M.baseline(player([(90, 1)] * 6))
    assert M.expected_minutes(b, 1.0, override=0).xmins == 0
    half = M.expected_minutes(b, 1.0, override=45)
    assert half.xmins == pytest.approx(45) and half.p_start == pytest.approx(b.p_start * 45 / b.xmins)
    # An override replaces availability rather than stacking on it.
    assert M.expected_minutes(b, 0.0, override=45).xmins == pytest.approx(45)
    sub = M.baseline(player([(20, 0)] * 6))
    up = M.expected_minutes(sub, 1.0, override=80)
    assert up.xmins == pytest.approx(80, abs=1.0) and up.p_start > 0.85
    assert M.expected_minutes(sub, 1.0, override=500).xmins <= 90


def test_parse_overrides_forms():
    assert M.parse_overrides(None) == {}
    assert M.parse_overrides({"430": 60}) == {430: {None: 60.0}}
    assert M.parse_overrides({"430": {"7": 0, "8": 45}}) == {430: {7: 0.0, 8: 45.0}}
    spec = [{"player": 430, "gw": 7, "xmins": 0, "source": "ruled out"}, {"player": 12, "xmins": 70}]
    assert M.parse_overrides(spec) == {430: {7: 0.0}, 12: {None: 70.0}}


def test_position_defaults_measured_from_the_pool():
    assert M.position_defaults({}) == M.FALLBACK
    pool = {}
    for i in range(20):
        pool[i] = player([(80, 1), (80, 1), (80, 1), (10, 0), (0, 0), (0, 0)], element_type=2)
    d = M.position_defaults(pool)
    assert d[2][0] == pytest.approx(80) and d[2][1] == pytest.approx(1.0)
    assert d[2][2] == pytest.approx(1 / 3) and d[2][3] == pytest.approx(10)
    assert d[1] == M.FALLBACK[1]


rows = st.lists(st.tuples(st.integers(0, 90), st.integers(0, 1)).map(lambda r: (r[0] if r[1] else min(r[0], 45), r[1])), max_size=6)


@given(rows, st.floats(0, 1), st.one_of(st.none(), st.floats(0, 120)))
def test_minutes_invariants(rs, avail, override):
    b = M.baseline(player(rs))
    m = M.expected_minutes(b, avail, override)
    assert 0 <= m.p60 <= m.p_start + 1e-9 <= m.p_play + 2e-9 <= 1 + 3e-9
    assert 0 <= m.xmins <= 90 + 1e-6
    assert 0 <= b.p_start <= 1 and 0 <= b.p_sub <= 1 and 0 <= b.p60_start <= 1


@given(rows, st.floats(0, 1), st.floats(0, 1))
def test_more_availability_never_means_fewer_minutes(rs, a1, a2):
    b = M.baseline(player(rs))
    lo, hi = sorted([a1, a2])
    assert M.expected_minutes(b, lo).xmins <= M.expected_minutes(b, hi).xmins + 1e-9
