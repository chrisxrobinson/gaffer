"""Rebuild the rules-engine golden fixtures from real FPL data (ARCHITECTURE §6.1).

    uv run --no-project --python 3.14 python python/gaffer_lib/tests/data/build_fixtures.py

Sources (all public, fetched politely: one request at a time, >= 0.5 s apart, descriptive User-Agent):
- 2026/27: the live API. `event/{gw}/live/` explain[] and stats for every finished GW, plus
  `bootstrap-static/` for element types and `game_config.scoring`.
- 2025/26: the live API serves the current season only, so per-fixture stat lines and `total_points`
  come from vaastav/Fantasy-Premier-League `data/2025-26/gws/merged_gw.csv` at a pinned commit.
- Auto-subs and FT histories: public entries sampled from the overall league (314). Entry IDs and
  names are dropped; only picks, minutes and transfer counts are kept.

Outputs are small gzip/JSON files next to this script. They are committed so the tests run offline.
"""

import csv
import gzip
import io
import json
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

HERE = Path(__file__).parent
API = "https://fantasy.premierleague.com/api/"
UA = "Gaffer-dev/0.1 (personal FPL advisor; rules-engine fixtures)"
VAASTAV_COMMIT = "f9ed3e8839b0f970e0d5d4a83c5628f6eaee755a"  # "Final 2025-26 update", 2026-06-17
VAASTAV_URL = f"https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/{VAASTAV_COMMIT}/data/2025-26/gws/merged_gw.csv"
STANDINGS_PAGES = [1, 500, 5000, 20000, 60000]  # top to mid-table managers, 10 each

# The stat identifiers that score (explain[] identifiers, 2025/26 onwards).
STATS = [
    "minutes", "goals_scored", "assists", "clean_sheets", "goals_conceded", "own_goals", "penalties_saved",
    "penalties_missed", "yellow_cards", "red_cards", "saves", "bonus", "defensive_contribution",
]


def get(path, fresh=False):
    url = API + path
    if fresh:
        url += ("&" if "?" in url else "?") + f"_={time.time_ns()}"
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                time.sleep(0.5)
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(2**attempt)
    raise RuntimeError(f"GET {path} failed")


def write_gz_jsonl(name, rows):
    with gzip.open(HERE / name, "wt", encoding="utf-8", compresslevel=9) as f:
        for r in rows:
            f.write(json.dumps(r, separators=(",", ":")) + "\n")


def season_2627(bootstrap):
    types = {e["id"]: e["element_type"] for e in bootstrap["elements"]}
    finished = [e["id"] for e in bootstrap["events"] if e["finished"] and e["data_checked"]]
    rows, live = [], {}
    for gw in finished:
        data = get(f"event/{gw}/live/")
        live[gw] = {e["id"]: e["stats"]["minutes"] for e in data["elements"]}
        for e in data["elements"]:
            explain = e["explain"]
            if len(explain) == 1:
                # One fixture: the GW stat line is that fixture's full line, including non-scoring values.
                fixtures = [{k: e["stats"][k] for k in STATS}]
            else:
                fixtures = [{s["identifier"]: s["value"] for s in f["stats"]} for f in explain]
            points = Counter()
            for f in explain:
                for s in f["stats"]:
                    points[s["identifier"]] += s["points"] + s.get("points_modification", 0)
            rows.append({
                "gw": gw, "element": e["id"], "element_type": types[e["id"]], "fixtures": fixtures,
                "explain_points": {k: v for k, v in points.items() if v}, "total_points": e["stats"]["total_points"],
            })
    write_gz_jsonl("golden-2026-27.jsonl.gz", rows)
    cfg = {
        "source": "bootstrap-static game_config.scoring and element_types, fetched " + time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime()),
        "scoring": bootstrap["game_config"]["scoring"],
        "element_types": [{k: t[k] for k in ("id", "singular_name_short", "squad_select", "squad_min_play", "squad_max_play")} for t in bootstrap["element_types"]],
    }
    (HERE / "scoring-2026-27.json").write_text(json.dumps(cfg, indent=1) + "\n")
    print(f"2026/27: {len(rows)} player-GWs over GW{finished[0]}-{finished[-1]}")
    return finished, live, types


def season_2526():
    req = urllib.request.Request(VAASTAV_URL, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        text = r.read().decode("utf-8")
    cols = ["GW", "element", "position", "fixture"] + STATS + ["total_points"]
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(cols)
    n = 0
    for row in csv.DictReader(io.StringIO(text)):
        w.writerow([row[c] for c in cols])
        n += 1
    with gzip.open(HERE / "golden-2025-26.csv.gz", "wt", encoding="utf-8", compresslevel=9) as f:
        f.write(out.getvalue())
    print(f"2025/26: {n} player-fixtures from vaastav@{VAASTAV_COMMIT[:8]}")


def entries(finished, live, types):
    ids = []
    for page in STANDINGS_PAGES:
        s = get(f"leagues-classic/314/standings/?page_standings={page}")
        ids += [r["entry"] for r in s["standings"]["results"][:10]]
    subs, histories = [], []
    for eid in ids:
        history = get(f"entry/{eid}/history/", fresh=True)
        transfers = get(f"entry/{eid}/transfers/", fresh=True)
        chips = {c["event"]: c["name"] for c in history["chips"]}
        per_gw = Counter(t["event"] for t in transfers)
        histories.append({
            "gws": [
                {"event": r["event"], "event_transfers": r["event_transfers"], "event_transfers_cost": r["event_transfers_cost"],
                 "chip": chips.get(r["event"]), "listed_transfers": per_gw.get(r["event"], 0)}
                for r in history["current"]
            ],
        })
        for gw in finished:
            p = get(f"entry/{eid}/event/{gw}/picks/", fresh=True)
            if p is None:
                continue
            subs.append({
                "gw": gw,
                "active_chip": p["active_chip"],
                "picks": [{"element": x["element"], "position": x["position"], "element_type": types[x["element"]], "multiplier": x["multiplier"]} for x in p["picks"]],
                "minutes": {str(x["element"]): live[gw].get(x["element"], 0) for x in p["picks"]},
                "automatic_subs": [{"element_in": a["element_in"], "element_out": a["element_out"]} for a in p["automatic_subs"]],
            })
    with gzip.open(HERE / "autosubs-2026-27.json.gz", "wt", encoding="utf-8", compresslevel=9) as f:
        f.write(json.dumps(subs, separators=(",", ":")) + "\n")
    (HERE / "ft-histories-2026-27.json").write_text(json.dumps(histories, separators=(",", ":")) + "\n")
    print(f"entries: {len(ids)}; {len(subs)} entry-GWs, {sum(len(s['automatic_subs']) for s in subs)} automatic_subs records")


def trimmed_bootstrap(b):
    keep = {
        "events": ("id", "deadline_time", "finished", "data_checked", "is_previous", "is_current", "is_next"),
        "teams": ("id", "name", "short_name"),
        "elements": ("id", "web_name", "first_name", "second_name", "team", "element_type", "now_cost", "cost_change_start", "status"),
    }
    out = {k: [{f: x[f] for f in fields} for x in b[k]] for k, fields in keep.items()}
    out["element_types"] = [{k: t[k] for k in ("id", "singular_name_short", "squad_select", "squad_min_play", "squad_max_play", "sub_positions_locked")} for t in b["element_types"]]
    out["chips"] = [{k: c[k] for k in ("id", "name", "number", "start_event", "stop_event", "chip_type")} for c in b["chips"]]
    out["game_settings"] = b["game_settings"]
    out["game_config"] = {"scoring": b["game_config"]["scoring"]}
    return out


def snapshot_entry(bootstrap, entry_id, out_dir, keep_id=True):
    """A frozen, trimmed real snapshot for derive tests (same file names as fpl_snapshot writes)."""
    d = HERE / out_dir
    d.mkdir(parents=True, exist_ok=True)
    cur = next(e["id"] for e in bootstrap["events"] if e["is_current"])
    entry = get(f"entry/{entry_id}/", fresh=True)
    files = {
        "bootstrap-static": trimmed_bootstrap(bootstrap),
        "fixtures": [{k: f[k] for k in ("id", "event", "team_h", "team_a", "finished")} for f in get("fixtures/")],
        # Team-level fields only: no manager names.
        "entry": {k: entry[k] for k in (("id",) if keep_id else ()) + ("name", "started_event", "current_event", "last_deadline_bank", "last_deadline_value", "last_deadline_total_transfers")},
        "history": get(f"entry/{entry_id}/history/", fresh=True),
        "transfers": get(f"entry/{entry_id}/transfers/", fresh=True),
        "picks": get(f"entry/{entry_id}/event/{cur}/picks/", fresh=True),
    }
    files["history"].pop("past", None)
    if not keep_id:
        files["entry"]["name"] = out_dir.rsplit("/", 1)[-1]
        for t in files["transfers"]:
            t.pop("entry", None)
        for name in ("picks", "picks-prev"):
            for sub in (files.get(name) or {}).get("automatic_subs", []):
                sub.pop("entry", None)
    if files["picks"]["active_chip"] == "freehit":
        files["picks-prev"] = get(f"entry/{entry_id}/event/{cur - 1}/picks/", fresh=True)
    for name, data in files.items():
        (d / f"{name}.json").write_text(json.dumps(data, separators=(",", ":")) + "\n")
    print(f"snapshot of entry {entry_id} at GW{cur} -> {out_dir}")


if __name__ == "__main__":
    import sys

    boot = get("bootstrap-static/")
    if sys.argv[1:] == ["snapshot"]:
        snapshot_entry(boot, 1, "snapshot-entry-1")
        raise SystemExit
    if sys.argv[1:2] == ["reference"]:
        # FR-DAT-08: freeze a reference account at the moment its owner reads the true values in the
        # app. The team ID and manager name are not stored. Usage: reference <label> <team_id>
        label, team = sys.argv[2], int(sys.argv[3])
        snapshot_entry(boot, team, f"reference/{label}", keep_id=False)
        raise SystemExit
    finished, live, types = season_2627(boot)
    season_2526()
    entries(finished, live, types)
    snapshot_entry(boot, 1, "snapshot-entry-1")
