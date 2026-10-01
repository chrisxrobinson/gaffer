"""FR-RUL-02: squad legality (15 = 2/5/5/3, <= 3 per club, spend <= budget with selling prices)."""

from collections import Counter

from conftest import real_bootstrap_rules_part
from hypothesis import assume, given, settings
from hypothesis import strategies as st

from gaffer_lib import rules

R = rules.Rules.from_bootstrap(real_bootstrap_rules_part())
SLOTS = [1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4]


def codes(violations):
    return {v.code for v in violations}


# A legal squad over players 1..15 in SLOTS order (with pool() teams that respect the club limit).
LEGAL = list(range(1, 16))


def pool(teams):
    return {i + 1: rules.Player(i + 1, teams[i], SLOTS[i]) for i in range(15)}


TEAMS_OK = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 1, 1]  # team 1 has exactly 3


def test_legal_squad_passes():
    assert rules.check_squad(LEGAL, pool(TEAMS_OK), R, cost=1000, budget=1000) == []


def test_table():
    players = pool(TEAMS_OK)
    players[99] = rules.Player(99, 1, 2)  # a 4th player from team 1
    cases = [
        (LEGAL[:14], {"SQUAD_SIZE", "POSITION_QUOTA"}),
        (LEGAL + [99], {"SQUAD_SIZE", "POSITION_QUOTA", "CLUB_LIMIT"}),
        ([99 if p == 3 else p for p in LEGAL], {"CLUB_LIMIT"}),
        ([4 if p == 3 else p for p in LEGAL], {"DUPLICATE_PLAYER"}),
        ([12345 if p == 3 else p for p in LEGAL], {"UNKNOWN_PLAYER", "POSITION_QUOTA"}),
    ]
    for squad, want in cases:
        assert codes(rules.check_squad(squad, players, R)) == want, squad
    assert codes(rules.check_squad(LEGAL, players, R, cost=1001, budget=1000)) == {"OVER_BUDGET"}


def test_limits_come_from_bootstrap():
    b = real_bootstrap_rules_part()
    b["game_settings"]["squad_team_limit"] = 2
    strict = rules.Rules.from_bootstrap(b)
    assert codes(rules.check_squad(LEGAL, pool(TEAMS_OK), strict)) == {"CLUB_LIMIT"}


# --- Hypothesis --------------------------------------------------------------------------------

teams_legal = st.lists(st.integers(1, 20), min_size=15, max_size=15).filter(lambda t: max(Counter(t).values()) <= 3)


@st.composite
def legal_case(draw):
    teams = draw(teams_legal)
    cost = draw(st.integers(800, 1100))
    budget = draw(st.integers(cost, 1200))
    return pool(teams), cost, budget


def oracle_ok(squad, players, cost, budget):
    if len(squad) != 15 or len(set(squad)) != 15 or any(p not in players for p in squad):
        return False
    types = Counter(players[p].element_type for p in squad)
    teams = Counter(players[p].team for p in squad)
    return types == Counter({1: 2, 2: 5, 3: 5, 4: 3}) and max(teams.values()) <= 3 and cost <= budget


@settings(max_examples=500)
@given(
    st.dictionaries(st.integers(1, 60), st.tuples(st.integers(1, 20), st.integers(1, 4)), min_size=10, max_size=60),
    st.lists(st.integers(1, 70), min_size=10, max_size=18),
    st.integers(0, 1200),
    st.integers(0, 1200),
)
def test_every_accepted_squad_satisfies_all_constraints(raw, squad, cost, budget):
    players = {i: rules.Player(i, t, et) for i, (t, et) in raw.items()}
    if rules.check_squad(squad, players, R, cost=cost, budget=budget) == []:
        assert oracle_ok(squad, players, cost, budget)


@settings(max_examples=300)
@given(legal_case())
def test_generated_legal_squads_are_accepted(case):
    players, cost, budget = case
    assert rules.check_squad(LEGAL, players, R, cost=cost, budget=budget) == []


@settings(max_examples=300)
@given(legal_case(), st.data())
def test_single_club_violation_gives_club_limit(case, data):
    players, cost, budget = case
    # Move one player to a club that already has 3 other players in the squad.
    full = [t for t, n in Counter(p.team for p in players.values()).items() if n == 3]
    assume(full)
    club = data.draw(st.sampled_from(full))
    victim = data.draw(st.sampled_from([p for p in players.values() if p.team != club]))
    players = {**players, victim.id: rules.Player(victim.id, club, victim.element_type)}
    assert codes(rules.check_squad(LEGAL, players, R, cost=cost, budget=budget)) == {"CLUB_LIMIT"}


@settings(max_examples=300)
@given(legal_case(), st.data())
def test_single_position_violation_gives_position_quota(case, data):
    players, cost, budget = case
    victim = data.draw(st.sampled_from(list(players.values())))
    new_type = data.draw(st.sampled_from([t for t in (1, 2, 3, 4) if t != victim.element_type]))
    players = {**players, victim.id: rules.Player(victim.id, victim.team, new_type)}
    assert codes(rules.check_squad(LEGAL, players, R, cost=cost, budget=budget)) == {"POSITION_QUOTA"}


@settings(max_examples=300)
@given(legal_case(), st.integers(1, 200))
def test_single_budget_violation_gives_over_budget(case, over):
    players, cost, _ = case
    assert codes(rules.check_squad(LEGAL, players, R, cost=cost + over, budget=cost)) == {"OVER_BUDGET"}


@settings(max_examples=300)
@given(legal_case(), st.data())
def test_single_duplicate_gives_duplicate_player(case, data):
    players, cost, budget = case
    # Replace a player with another of the same position whose club stays within the limit.
    squad = LEGAL
    teams = Counter(p.team for p in players.values())
    pairs = [
        (a, b) for a in squad for b in squad
        if a != b and players[a].element_type == players[b].element_type
        and (players[a].team == players[b].team or teams[players[b].team] < 3)
    ]
    assume(pairs)
    a, b = data.draw(st.sampled_from(pairs))
    mutated = [b if p == a else p for p in squad]
    assert codes(rules.check_squad(mutated, players, R, cost=cost, budget=budget)) == {"DUPLICATE_PLAYER"}
