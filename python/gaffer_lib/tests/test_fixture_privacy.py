"""NFR-PRIV-01 for the repository itself: no committed fixture identifies an FPL entry.

Real snapshots are frozen for the tests; what identifies their owner (the team id, the team's and
the manager's names) is stripped by `data/build_fixtures.py`. This is the grep that proves it.
"""

import json
import re

from conftest import DATA

SNAPSHOTS = sorted(p.parent for p in DATA.rglob("entry.json"))
IDENTIFYING_KEYS = ("player_first_name", "player_last_name", "player_region_name", "team_id", "entry_id", "manager")


def test_there_are_snapshot_fixtures_to_check():
    assert {p.name for p in SNAPSHOTS} >= {"snapshot-entry-1", "snapshot-model", "ref-a-gw6"}


def test_entry_files_hold_no_id_and_no_real_name():
    for d in SNAPSHOTS:
        entry = json.loads((d / "entry.json").read_text())
        assert "id" not in entry and "entry" not in entry, d
        assert entry["name"] == d.name, f"{d}: the name must be the fixture's label, not the team's"
        assert not set(entry) & set(IDENTIFYING_KEYS), d


def test_no_file_carries_the_entry_id_or_a_manager():
    for d in SNAPSHOTS:
        for f in d.glob("*.json"):
            if f.name in ("bootstrap-static.json", "fixtures.json", "odds.json") or f.name.startswith("live-"):
                continue  # public data about players and matches
            text = f.read_text()
            assert not re.search(r'"entry"\s*:\s*\d', text), f"{f} holds an entry (team) id"
            for key in IDENTIFYING_KEYS:
                assert f'"{key}"' not in text, f"{f} holds {key}"


def test_the_plan_fixture_identifies_nobody():
    text = (DATA / "plan-model.json").read_text()
    assert '"snapshot_id": "snapshot-model"' in text
    for key in (*IDENTIFYING_KEYS, "team_id_hash", "team_name"):
        assert f'"{key}"' not in text


# M5: the outcome fixtures and the eval suite's committed inputs (evals/cases).
EVALS = DATA.parents[3] / "evals" / "cases"
# The real team ids whose snapshots the live eval cases come from; none may appear in what is committed.
SOURCE_TEAM_IDS = (1, 2, 3, 4, 435994, 5000000)


def test_outcome_fixtures_carry_no_entry():
    picks = json.loads((DATA / "picks-2026-27-gw6.json").read_text())
    assert len(picks) >= 50
    text = (DATA / "picks-2026-27-gw6.json").read_text() + (DATA / "result-2026-27-gw6.json").read_text()
    assert not re.search(r'"entry"\s*:', text)
    for key in IDENTIFYING_KEYS:
        assert f'"{key}"' not in text


def test_eval_cases_identify_nobody():
    import gzip  # noqa: PLC0415

    team_files = sorted((EVALS / "data").rglob("teams/*/*.json"))
    assert len(team_files) >= 20
    for f in team_files:
        text = f.read_text()
        assert not re.search(r'"entry"\s*:', text), f"{f} holds an entry (team) id"
        for key in (*IDENTIFYING_KEYS, "id"):
            assert f'"{key}"' not in text, f"{f} holds {key}"
        if f.name == "entry.json":
            assert set(json.loads(text)) == {"started_event"}, f"{f}: only the start GW is kept"
        if f.name == "history.json":
            h = json.loads(text)
            assert set(h) == {"current", "chips"} and {c["name"] for c in h["chips"]} <= {"wildcard", "freehit", "bboost", "3xc"}, f
    for f in sorted(EVALS.glob("*.json")):
        case = json.loads(f.read_text())
        # Far above any real FPL entry id (about 13 million in 2026), so a synthetic team can never be someone's.
        assert case["team_id"] >= 900_000_000, f"{f}: eval teams have synthetic ids"
        assert case["team_id"] not in SOURCE_TEAM_IDS
    # The shared files are public data about players and matches; still, no manager or team name.
    for f in sorted((EVALS / "data").rglob("*.json.gz")):
        text = gzip.decompress(f.read_bytes()).decode()
        for key in IDENTIFYING_KEYS:
            assert f'"{key}"' not in text, f"{f} holds {key}"
