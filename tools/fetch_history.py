"""Fetch the third-party history the backtest replays (ARCHITECTURE §6.2) into a gitignored directory.

    uv run --no-project --python 3.14 python tools/fetch_history.py [--out var/history]

Nothing fetched here is committed or republished (NFR-SEC-06): both sources are used privately.
- vaastav/Fantasy-Premier-League at a pinned commit: per player-fixture rows (`merged_gw.csv`),
  players, teams and fixtures for each season. Licence unclear (MIT text, GitHub says NOASSERTION).
- football-data.co.uk season CSVs (`mmz4281/<season>/E0.csv`): results and pre-match bookmaker odds.
  The site publishes no API terms; the files are fetched once, one request at a time, and cached.
  They are not versioned upstream, so the fetch date is recorded in `MANIFEST.json`.

Files already present are not fetched again; delete the directory to refresh.
"""

import argparse
import hashlib
import json
import time
import urllib.request
from pathlib import Path

UA = "Gaffer-dev/0.1 (personal FPL advisor; backtest history)"
VAASTAV_COMMIT = "f9ed3e8839b0f970e0d5d4a83c5628f6eaee755a"  # "Final 2025-26 update", 2026-06-17
VAASTAV = f"https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/{VAASTAV_COMMIT}/data"
FOOTBALL_DATA = "https://football-data.co.uk/mmz4281"
# 2022-23 is the development season and the source of priors for 2023-24; the backtest reports the other three.
SEASONS = ["2022-23", "2023-24", "2024-25", "2025-26"]
VAASTAV_FILES = ["gws/merged_gw.csv", "players_raw.csv", "teams.csv", "fixtures.csv"]


def fetch(url: str, dest: Path, manifest: dict) -> None:
    if dest.is_file() and str(dest.name) in manifest.get(str(dest.parent.name), {}):
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        body = r.read()
    dest.write_bytes(body)
    manifest.setdefault(dest.parent.name, {})[dest.name] = {
        "url": url, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest(),
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    print(f"{dest}  {len(body):,} B")
    time.sleep(1.0)  # polite: one request a second


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="var/history")
    out = Path(ap.parse_args().out)
    out.mkdir(parents=True, exist_ok=True)
    mpath = out / "MANIFEST.json"
    manifest = json.loads(mpath.read_text()) if mpath.is_file() else {"vaastav_commit": VAASTAV_COMMIT}
    for season in SEASONS:
        for f in VAASTAV_FILES:
            fetch(f"{VAASTAV}/{season}/{f}", out / season / Path(f).name, manifest)
        code = season[2:4] + season[5:7]
        fetch(f"{FOOTBALL_DATA}/{code}/E0.csv", out / season / "E0.csv", manifest)
        mpath.write_text(json.dumps(manifest, indent=1) + "\n")


if __name__ == "__main__":
    main()
