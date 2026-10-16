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
