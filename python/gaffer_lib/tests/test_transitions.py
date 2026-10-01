"""FR-RUL-04 (FT and hits), FR-RUL-05 (chips), FR-RUL-06 (blanks/doubles), FR-RUL-07 (parameters), selling prices."""

import pytest
from conftest import load_json, real_bootstrap_rules_part
from hypothesis import given
from hypothesis import strategies as st

from gaffer_lib import rules

R = rules.Rules.from_bootstrap(real_bootstrap_rules_part())

# Next-GW FTs with no chip: rows are FTs 0-5, columns transfers 0-6 (worked by hand from the rules:
# unused FTs roll over, +1, cap 5).
NEXT_FT_NO_CHIP = {
    0: [1, 1, 1, 1, 1, 1, 1],
    1: [2, 1, 1, 1, 1, 1, 1],
    2: [3, 2, 1, 1, 1, 1, 1],
    3: [4, 3, 2, 1, 1, 1, 1],
    4: [5, 4, 3, 2, 1, 1, 1],
    5: [5, 5, 4, 3, 2, 1, 1],
}
HIT_POINTS_NO_CHIP = {
    0: [0, 4, 8, 12, 16, 20, 24],
    1: [0, 0, 4, 8, 12, 16, 20],
    2: [0, 0, 0, 4, 8, 12, 16],
    3: [0, 0, 0, 0, 4, 8, 12],
    4: [0, 0, 0, 0, 0, 4, 8],
    5: [0, 0, 0, 0, 0, 0, 4],
}


@pytest.mark.parametrize("ft", range(6))
@pytest.mark.parametrize("transfers", range(7))
@pytest.mark.parametrize("chip", [None, "wildcard", "freehit"])
def test_ft_transition_table(ft, transfers, chip):
    if chip is None:
        assert rules.next_free_transfers(ft, transfers, None, R) == NEXT_FT_NO_CHIP[ft][transfers]
        assert rules.hit_cost(ft, transfers, None, R) == HIT_POINTS_NO_CHIP[ft][transfers]
    else:
        # WC and FH keep the FT count unchanged (no +1) and every transfer is free.
        assert rules.next_free_transfers(ft, transfers, chip, R) == ft
        assert rules.hit_cost(ft, transfers, chip, R) == 0


@pytest.mark.parametrize("chip", ["bboost", "3xc"])
def test_team_chips_dont_change_transfers(chip):
    assert rules.next_free_transfers(2, 3, chip, R) == 1
    assert rules.hit_cost(2, 3, chip, R) == 4


def test_ft_cap_is_read_from_the_api():
    """FR-RUL-07: max_extra_free_transfers = 3 caps FTs at 4 with no code change."""
    b = real_bootstrap_rules_part()
    b["game_settings"]["max_extra_free_transfers"] = 3
    r3 = rules.Rules.from_bootstrap(b)
    assert r3.max_free_transfers == 4
    ft = 1
    for _ in range(10):
        ft = rules.next_free_transfers(ft, 0, None, r3)
    assert ft == 4


def test_rules_parameters_from_bootstrap():
    assert (R.squad_size, R.squad_play, R.team_limit, R.total_spend, R.max_free_transfers) == (15, 11, 3, 1000, 5)
    assert R.squad_select == {1: 2, 2: 5, 3: 5, 4: 3}
    assert (R.min_play, R.max_play) == ({1: 1, 2: 3, 3: 2, 4: 1}, {1: 1, 2: 5, 3: 5, 4: 3})
    assert len(R.chips) == 8


# --- selling price -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "purchase,now,sell",
    [(50, 50, 50), (50, 51, 50), (50, 52, 51), (50, 53, 51), (50, 55, 52), (50, 49, 49), (50, 45, 45), (125, 131, 128)],
)
def test_selling_price(purchase, now, sell):
    assert rules.selling_price(purchase, now, R) == sell


@given(st.integers(35, 160), st.integers(35, 160))
def test_selling_price_properties(purchase, now):
    s = rules.selling_price(purchase, now, R)
    assert s <= now
    assert s >= min(purchase, now)
    assert s == (purchase + (now - purchase) // 2 if now > purchase else now)


# --- chips (over the API's chips array) --------------------------------------------------------


def codes(v):
    return {x.code for x in v}


def test_chip_status_over_api_chips_array():
    used = [{"name": "bboost", "event": 2}, {"name": "wildcard", "event": 3}, {"name": "freehit", "event": 5}]
    status = {(c.name, c.half): c for c in rules.chip_status(R, used, 6)}
    assert len(status) == 8
    assert status[("wildcard", 1)].used_in == 3 and not status[("wildcard", 1)].available
    assert status[("wildcard", 2)].used_in is None and not status[("wildcard", 2)].available  # window not open
    assert status[("3xc", 1)].available and status[("3xc", 1)].used_in is None
    at20 = {(c.name, c.half): c for c in rules.chip_status(R, used, 20)}
    assert all(not c.available for (n, h), c in at20.items() if h == 1)  # first half expired at the GW19 deadline
    assert all(c.available for (n, h), c in at20.items() if h == 2)


@pytest.mark.parametrize(
    "chips,gw,used,want",
    [
        (["wildcard"], 6, [], set()),
        (["wildcard"], 1, [], {"CHIP_OUT_OF_WINDOW"}),  # WC/FH from GW2
        (["bboost"], 1, [], set()),  # BB/TC from GW1
        (["wildcard"], 19, [], set()),  # last GW of the first half
        (["wildcard"], 20, [{"name": "wildcard", "event": 5}], set()),  # second-half chip is separate
        (["wildcard"], 12, [{"name": "wildcard", "event": 5}], {"CHIP_ALREADY_USED"}),
        (["3xc"], 25, [{"name": "3xc", "event": 21}], {"CHIP_ALREADY_USED"}),
        (["wildcard", "bboost"], 8, [], {"CHIP_ONE_PER_GW"}),
        (["freehit"], 20, [{"name": "freehit", "event": 19}], {"FH_CONSECUTIVE"}),  # no FH in GW20 after FH in GW19
        (["freehit"], 21, [{"name": "freehit", "event": 19}], set()),
        (["assistant_manager"], 8, [], {"CHIP_UNKNOWN"}),  # no AM chip in 2026/27
    ],
)
def test_chip_rules(chips, gw, used, want):
    assert codes(rules.chip_violations(chips, gw, R, used)) == want


@given(st.lists(st.tuples(st.sampled_from(rules.CHIP_NAMES), st.integers(1, 38)), max_size=12), st.sampled_from(rules.CHIP_NAMES), st.integers(1, 38))
def test_accepted_chip_is_in_an_open_unused_window(history, chip, gw):
    used = [{"name": n, "event": e} for n, e in history]
    if not rules.chip_violations([chip], gw, R, used):
        window = next(c for c in R.chips if c.name == chip and c.start_event <= gw <= c.stop_event)
        assert not any(u["name"] == chip and u["event"] != gw and window.start_event <= u["event"] <= window.stop_event for u in used)


# --- blank and double GWs ----------------------------------------------------------------------


def test_blanks_and_doubles_from_synthetic_fixtures():
    """Team A (1) plays twice and team B (2) not at all in GW30; everyone else once."""
    teams = range(1, 21)
    fixtures = [{"event": 30, "team_h": 1, "team_a": 3}, {"event": 30, "team_h": 4, "team_a": 1}]
    fixtures += [{"event": 30, "team_h": h, "team_a": h + 1} for h in range(5, 20, 2)]
    fixtures += [{"event": None, "team_h": 2, "team_a": 5}]  # postponed, not yet rescheduled
    fixtures += [{"event": 31, "team_h": 2, "team_a": 6}]  # another GW doesn't count
    assert rules.blanks_and_doubles(fixtures, 30, teams) == {"blank": [2], "double": [1]}


def test_real_2026_27_fixture_shape_has_no_blanks_or_doubles_yet():
    # Research 04 §0: every GW1-38 has 10 fixtures with no team twice (checked 2026-09-27).
    fixtures = [{"event": gw, "team_h": 2 * m + 1, "team_a": 2 * m + 2} for gw in range(1, 39) for m in range(10)]
    for gw in range(1, 39):
        assert rules.blanks_and_doubles(fixtures, gw, range(1, 21)) == {"blank": [], "double": []}
