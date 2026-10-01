"""FR-DAT-08: derived free transfers and selling prices match what account owners read in the FPL app.

Each reference account is a frozen snapshot in data/reference/<label>/ (build_fixtures.py reference
<label> <team_id>, taken when the owner reads the app, before the next deadline) plus its true
values in data/reference-accounts.json:

    [{"label": "a-gw6", "gw": 6, "free_transfers": 2, "selling_prices": {"<element id>": 57, ...},
      "bank": 5, "notes": "WC played in GW5"}]

Money in tenths; `selling_prices` and `bank` are checked when supplied. The acceptance bar is >= 3
accounts with selling prices, covering a WC or FH week and a banked-FT week. Until it is met, the
coverage test skips and says exactly what is missing (it never passes on partial data).
"""

import json

import pytest
from conftest import DATA

from gaffer_lib.derive import derive
from gaffer_lib.snapshot import Snapshot

FILE = DATA / "reference-accounts.json"
ACCOUNTS = json.loads(FILE.read_text()) if FILE.exists() else []


def test_reference_accounts_cover_the_acceptance_bar():
    snaps = {a["label"]: derive(Snapshot(DATA / "reference" / a["label"])) for a in ACCOUNTS}
    chip_week = [a["label"] for a in ACCOUNTS if any(c["name"] in ("wildcard", "freehit") and c["used_in"] == snaps[a["label"]]["gw"]["current"] for c in snaps[a["label"]]["chips"])]
    banked = [a["label"] for a in ACCOUNTS if a["free_transfers"] >= 2]
    priced = [a["label"] for a in ACCOUNTS if a.get("selling_prices")]
    missing = []
    if len(ACCOUNTS) < 3:
        missing.append(f"{len(ACCOUNTS)}/3 accounts")
    if len(priced) < 3:
        missing.append(f"{len(priced)}/3 with owner-read selling prices")
    if not chip_week:
        missing.append("no WC/FH week")
    if not banked:
        missing.append("no banked-FT week")
    if missing:
        pytest.skip("FR-DAT-08 blocked: " + "; ".join(missing))


@pytest.mark.parametrize("account", ACCOUNTS, ids=[a["label"] for a in ACCOUNTS])
def test_reference_account_matches_the_app(account):
    d = derive(Snapshot(DATA / "reference" / account["label"]))
    assert d["gw"]["next"] == account["gw"]
    assert d["free_transfers"]["value"] == account["free_transfers"]
    if "bank" in account:
        assert d["bank"] == account["bank"]
    if account.get("selling_prices"):
        got = {str(p["id"]): p["selling_price"] for p in d["squad"]}
        assert got == {str(k): v for k, v in account["selling_prices"].items()}
