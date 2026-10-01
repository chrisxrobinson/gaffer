"""FR-RUL-01: player points under the current scoring, golden-tested against real FPL data."""

from collections import Counter

import pytest
from conftest import load_csv_gz, load_json, load_jsonl_gz

from gaffer_lib import rules

CFG_2627 = load_json("scoring-2026-27.json")
CFG_2526 = load_json("scoring-2025-26.json")


def scoring(cfg):
    return rules.Scoring(cfg["scoring"], {t["id"]: t["singular_name_short"] for t in cfg["element_types"]})


def test_golden_2026_27_explain_100_percent():
    """Every player-GW in every finished 2026/27 GW: total and per-identifier points match explain[]."""
    s = scoring(CFG_2627)
    rows = load_jsonl_gz("golden-2026-27.jsonl.gz")
    assert len(rows) > 3000
    wrong = []
    for r in rows:
        breakdown = Counter()
        for fixture in r["fixtures"]:
            breakdown.update(s.points(fixture, r["element_type"]))
        breakdown = {k: v for k, v in breakdown.items() if v}
        if sum(breakdown.values()) != r["total_points"] or breakdown != r["explain_points"]:
            wrong.append((r["gw"], r["element"], breakdown, r["explain_points"], r["total_points"]))
    assert wrong == [], f"{len(wrong)}/{len(rows)} mismatches, e.g. {wrong[:3]}"


def test_golden_2025_26_all_fixtures_100_percent():
    """Every player-fixture in all 38 GWs of 2025/26 (vaastav per-fixture rows, pinned commit)."""
    s = scoring(CFG_2526)
    pos_type = {"GK": 1, "GKP": 1, "DEF": 2, "MID": 3, "FWD": 4}
    rows = load_csv_gz("golden-2025-26.csv.gz")
    assert len(rows) == 29757
    assert {int(r["GW"]) for r in rows} == set(range(1, 39))
    wrong = []
    for r in rows:
        stats = {k: int(r[k]) for k in rules.SCORING_STATS}
        got = sum(s.points(stats, pos_type[r["position"]]).values())
        if got != int(r["total_points"]):
            wrong.append((r["GW"], r["element"], r["position"], got, r["total_points"]))
    assert wrong == [], f"{len(wrong)}/{len(rows)} mismatches, e.g. {wrong[:5]}"


@pytest.mark.parametrize(
    "etype,stats,expected",
    [
        # minutes: 0, 1-59, 60+
        (3, {"minutes": 0}, {}),
        (3, {"minutes": 59}, {"minutes": 1}),
        (3, {"minutes": 60}, {"minutes": 2}),
        # goals by position, GK goal = 10
        (1, {"minutes": 90, "goals_scored": 1}, {"minutes": 2, "goals_scored": 10}),
        (2, {"minutes": 90, "goals_scored": 1}, {"minutes": 2, "goals_scored": 6}),
        (4, {"minutes": 90, "goals_scored": 2}, {"minutes": 2, "goals_scored": 8}),
        # goals conceded: -1 per 2 for GK/DEF, nothing for MID/FWD
        (2, {"minutes": 90, "goals_conceded": 3}, {"minutes": 2, "goals_conceded": -1}),
        (1, {"minutes": 90, "goals_conceded": 4}, {"minutes": 2, "goals_conceded": -2}),
        (3, {"minutes": 90, "goals_conceded": 4}, {"minutes": 2}),
        # saves: 1 per 3
        (1, {"minutes": 90, "saves": 5}, {"minutes": 2, "saves": 1}),
        (1, {"minutes": 90, "saves": 6}, {"minutes": 2, "saves": 2}),
        # DefCon: DEF at >= 10 CBIT, MID/FWD at >= 12 CBIRT, GK never; 2 points once, not per multiple
        (2, {"minutes": 90, "defensive_contribution": 9}, {"minutes": 2}),
        (2, {"minutes": 90, "defensive_contribution": 10}, {"minutes": 2, "defensive_contribution": 2}),
        (2, {"minutes": 90, "defensive_contribution": 25}, {"minutes": 2, "defensive_contribution": 2}),
        (3, {"minutes": 90, "defensive_contribution": 11}, {"minutes": 2}),
        (3, {"minutes": 90, "defensive_contribution": 12}, {"minutes": 2, "defensive_contribution": 2}),
        (4, {"minutes": 90, "defensive_contribution": 12}, {"minutes": 2, "defensive_contribution": 2}),
        (1, {"minutes": 90, "defensive_contribution": 30}, {"minutes": 2}),
        # clean sheet, cards, pens, own goals, bonus
        (3, {"minutes": 90, "clean_sheets": 1}, {"minutes": 2, "clean_sheets": 1}),
        (4, {"minutes": 90, "clean_sheets": 1}, {"minutes": 2}),
        (1, {"minutes": 90, "penalties_saved": 1, "red_cards": 1}, {"minutes": 2, "penalties_saved": 5, "red_cards": -3}),
        (3, {"minutes": 30, "yellow_cards": 1, "own_goals": 1, "penalties_missed": 1, "bonus": 3}, {"minutes": 1, "yellow_cards": -1, "own_goals": -2, "penalties_missed": -2, "bonus": 3}),
    ],
)
def test_scoring_table(etype, stats, expected):
    got = {k: v for k, v in scoring(CFG_2627).points(stats, etype).items() if v}
    assert got == expected


def test_scoring_parameters_come_from_game_config():
    """A changed game_config value changes the points with no code change (FR-RUL-07 for scoring)."""
    cfg = dict(CFG_2627["scoring"], goals_scored={**CFG_2627["scoring"]["goals_scored"], "MID": 7}, long_play=3)
    s = rules.Scoring(cfg, {t["id"]: t["singular_name_short"] for t in CFG_2627["element_types"]})
    assert {k: v for k, v in s.points({"minutes": 90, "goals_scored": 1}, 3).items() if v} == {"minutes": 3, "goals_scored": 7}


def test_defcon_thresholds_are_constants():
    assert rules.DEFCON_THRESHOLD == {"GKP": None, "DEF": 10, "MID": 12, "FWD": 12}
