"""FR-DAT-08: derived free transfers and selling prices match what account owners read in the FPL app.

Each reference account is a frozen snapshot in data/reference/<label>/ (build_fixtures.py reference
<label> <team_id>, taken when the owner reads the app, before the next deadline) plus its true
values in data/reference-accounts.json:

    [{"label": "a-gw6", "gw": 6, "free_transfers": 2, "selling_prices": {"<element id>": 57, ...},
      "bank": 5, "notes": "WC played in GW5"}]

Money in tenths. The acceptance bar is >= 3 accounts, covering a WC or FH week and a banked-FT week.
"""

import json

import pytest
from conftest import DATA

from gaffer_lib.derive import derive
from gaffer_lib.snapshot import Snapshot

FILE = DATA / "reference-accounts.json"
ACCOUNTS = json.loads(FILE.read_text()) if FILE.exists() else []


def test_reference_accounts_cover_the_acceptance_bar():
    if not ACCOUNTS:
        pytest.skip("FR-DAT-08 blocked: no reference accounts yet (owner-read FT and selling prices needed)")
    snaps = {a["label"]: derive(Snapshot(DATA / "reference" / a["label"])) for a in ACCOUNTS}
    assert len(ACCOUNTS) >= 3
    assert any(c["used_in"] is not None and c["name"] in ("wildcard", "freehit") and c["used_in"] == snaps[a["label"]]["gw"]["current"] for a in ACCOUNTS for c in snaps[a["label"]]["chips"]), "no account played WC or FH in the GW before its snapshot"
    assert any(a["free_transfers"] >= 2 for a in ACCOUNTS), "no banked-FT week"


@pytest.mark.parametrize("account", ACCOUNTS, ids=[a["label"] for a in ACCOUNTS])
def test_reference_account_matches_the_app(account):
    d = derive(Snapshot(DATA / "reference" / account["label"]))
    assert d["gw"]["next"] == account["gw"]
    assert d["free_transfers"]["value"] == account["free_transfers"]
    if "bank" in account:
        assert d["bank"] == account["bank"]
    got = {str(p["id"]): p["selling_price"] for p in d["squad"]}
    assert got == {str(k): v for k, v in account["selling_prices"].items()}
