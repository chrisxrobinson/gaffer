"""Turn Gaffer's own pre-deadline snapshots into the eval suite's live 2026/27 inputs (evals/cases/data).

    python evals/build/extract_live.py --base 2026-27-gw6 --snapshot DIR [--team LABEL=DIR ...] [--result FILE]

A snapshot directory is what `fpl_snapshot` wrote under /data/snapshots (copy it out of the volume with
`docker compose exec -T gaffer tar -C /data/snapshots -cf - <path> | tar -xf -`). What is kept:

- shared by every case of the GW (`--snapshot`): bootstrap-static (the fields Gaffer reads), fixtures,
  the recent `live-N` stats, and football-data.co.uk's results (scores and match xG only; no
  bookmaker prices are committed);
- per team (`--team label=DIR`): history, transfers and picks, with every entry id removed. The
  team's id, name and manager are not kept (NFR-PRIV-01); a case gives the team a synthetic id;
- `--result`: the GW's event/{gw}/live trimmed to minutes and points, for scoring once it is finished.

Gzipped JSON, small and derived: the raw upstream data stays on the private volume.
"""

import argparse
import gzip
import json
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "cases" / "data"

ELEMENT_FIELDS = (
    "id", "code", "web_name", "first_name", "second_name", "team", "element_type", "now_cost", "cost_change_start", "status",
    "chance_of_playing_next_round", "chance_of_playing_this_round", "news", "news_added", "ep_next", "ep_this", "form", "points_per_game",
    "selected_by_percent", "total_points", "event_points", "minutes", "starts", "goals_scored", "assists", "clean_sheets", "goals_conceded",
    "own_goals", "penalties_saved", "penalties_missed", "yellow_cards", "red_cards", "saves", "bonus", "bps", "expected_goals",
    "expected_assists", "expected_goals_conceded", "defensive_contribution", "penalties_order", "corners_and_indirect_freekicks_order",
    "direct_freekicks_order", "transfers_in_event", "transfers_out_event",
)
FIXTURE_FIELDS = ("id", "event", "kickoff_time", "team_h", "team_a", "team_h_score", "team_a_score", "finished", "finished_provisional",
                  "started", "team_h_difficulty", "team_a_difficulty")


def load(path: Path):
    return json.loads(path.read_text("utf-8"))


def dump(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, separators=(",", ":"), sort_keys=True, ensure_ascii=False) + "\n"
    if path.suffix == ".gz":
        with gzip.GzipFile(path, "wb", mtime=0) as f:  # mtime 0: the same input gives the same bytes
            f.write(text.encode("utf-8"))
    else:
        path.write_text(text, "utf-8")


def bootstrap(b: dict) -> dict:
    return {
        "events": [{k: e[k] for k in ("id", "name", "deadline_time", "finished", "data_checked", "is_previous", "is_current", "is_next") if k in e} for e in b["events"]],
        "teams": [{k: t[k] for k in ("id", "code", "name", "short_name") if k in t} for t in b["teams"]],
        "elements": [{k: e.get(k) for k in ELEMENT_FIELDS if k in e} for e in b["elements"]],
        "element_types": [{k: t[k] for k in ("id", "singular_name", "singular_name_short", "plural_name_short", "squad_select", "squad_min_play", "squad_max_play", "sub_positions_locked", "element_count") if k in t} for t in b["element_types"]],
        "chips": b["chips"],
        "game_settings": b["game_settings"],
        "game_config": {"settings": {"price_change_deadlines": b["game_config"]["settings"].get("price_change_deadlines", [])}, "scoring": b["game_config"]["scoring"]},
    }


def strip_entry(rows):
    for r in rows:
        r.pop("entry", None)
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="name of the shared base, e.g. 2026-27-gw6")
    ap.add_argument("--snapshot", required=True, help="the snapshot whose shared files the base uses")
    ap.add_argument("--team", action="append", default=[], help="label=snapshot dir, one per team")
    ap.add_argument("--result", help="event/{gw}/live trimmed to minutes and total_points (a finished GW)")
    args = ap.parse_args()
    src, out = Path(args.snapshot), DATA / args.base
    dump(out / "bootstrap-static.json.gz", bootstrap(load(src / "bootstrap-static.json")))
    dump(out / "fixtures.json.gz", [{k: f.get(k) for k in FIXTURE_FIELDS} for f in load(src / "fixtures.json")])
    for live in sorted(src.glob("live-*.json")):
        dump(out / f"{live.stem}.json.gz", load(live))
    odds = load(src / "odds.json")
    dump(out / "football-data-results.json.gz", {season: [{k: r[k] for k in ("date", "time", "home", "away", "hg", "ag", "hxg", "axg")} for r in rows] for season, rows in odds["results"].items()})
    if args.result:
        shutil.copyfile(args.result, out / Path(args.result).name)
    for spec in args.team:
        label, d = spec.split("=", 1)
        d = Path(d)
        history = load(d / "history.json")
        history.pop("past", None)
        dump(out / "teams" / label / "history.json", history)
        dump(out / "teams" / label / "transfers.json", strip_entry(load(d / "transfers.json")))
        for name in ("picks", "picks-prev"):
            if (d / f"{name}.json").is_file():
                picks = load(d / f"{name}.json")
                strip_entry(picks.get("automatic_subs", []))
                dump(out / "teams" / label / f"picks-{picks['entry_history']['event']}.json", picks)
        entry = load(d / "entry.json")
        dump(out / "teams" / label / "entry.json", {"started_event": entry["started_event"]})
        print(f"{args.base}/{label}: started GW{entry['started_event']}, chips used {[c['name'] + str(c['event']) for c in history['chips']]}")
    print(f"{args.base}: {sum(1 for _ in out.rglob('*') if _.is_file())} files")


if __name__ == "__main__":
    main()
