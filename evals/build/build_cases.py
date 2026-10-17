"""Materialise the eval cases (evals/cases/*.json) into what the eval runner serves (FR-EVL-02).

    PYTHONPATH=python/gaffer_lib/src uv run --no-project --python 3.14 --with numpy==2.5.3 --with pandas==3.0.6 \\
        --with scipy==1.18.1 python evals/build/build_cases.py [--only ID,ID] [--out var/evals/cases]

Each case becomes a directory (gitignored, under var/):

    upstream/          the responses a stand-in for the FPL API and football-data.co.uk serves to fpl_snapshot:
                       bootstrap-static.json, fixtures.json, live-<gw>.json (finished GWs before the case's),
                       entry.json, history.json, transfers.json, picks-<gw>.json,
                       football-data/fixtures.csv, football-data/mmz4281/<code>/E0.csv
    result.json        event/{gw}/live for the case's GW, trimmed to minutes and total_points: what scores
                       the recommendation. Absent while the GW is unfinished (then the case can't be scored).
    case.json          the case with its players resolved, its team's squad and the FPL clock to run at.

Two sources:

- `live`: Gaffer's own pre-deadline snapshots of 2026/27 (evals/cases/data, see extract_live.py), with
  the case's synthetic team id. The FPL clock is the time the snapshot was taken.
- `history`: a pre-deadline view rebuilt from vaastav's per-fixture archive and football-data.co.uk's
  season files (var/history, fetched by tools/fetch_history.py, never committed), with the same cut-off
  as the backtest (`backtest.SeasonData.inputs_at`): stats, results and xG only from matches that kicked
  off before the deadline; that GW's prices; and as `ep_next` the official xP recorded for the previous
  GW (the archive's value for a GW contains its own points). The team is synthetic: the most-owned legal
  £100m squad at its `started` GW, no transfers since, so its free transfers are `gw - started` (max 5)
  and every chip is available. The FPL clock is 26 hours before the deadline. What a history case can't
  have: news and availability flags (the archive has none; a case may add them), FPL's own deadline
  (approximated as 90 minutes before the GW's first kick-off), purchase prices (the team joined after
  GW1, so Gaffer, as it does live, sells at the current price), and the fixture list as it stood (later
  GWs show the final schedule).

Mutations a case can apply: `news` sets a player's status, chance and news text. Players are named
directly or chosen from the squad: `@top_ep_squad`, `@second_ep_squad`, `@lowest_ep_squad_outfield`,
`@top_ep_absent_squad` (the highest `ep_next` in the squad among those who played no minutes in the
case's GW: a ruled-out player that reality agrees with), `@top_ep_not_squad`.

Deterministic: the same inputs give the same bytes, and case.json records each file's sha256.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import json
import shutil
from datetime import timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CASES = ROOT / "evals" / "cases"
DATA = CASES / "data"
SCORING = ROOT / "python" / "gaffer_lib" / "tests" / "data" / "scoring-2026-27.json"

# Chips as the 2026/27 API serves them (research 04 §0): every history case uses today's chip set and
# transfer rules, as the backtest does.
CHIPS = [
    {"id": i + 1, "name": n, "number": 1, "start_event": a, "stop_event": b, "chip_type": t}
    for i, (n, a, b, t) in enumerate([
        ("wildcard", 2, 19, "transfer"), ("wildcard", 20, 38, "transfer"), ("freehit", 2, 19, "transfer"), ("bboost", 1, 19, "team"),
        ("3xc", 1, 19, "team"), ("freehit", 20, 38, "transfer"), ("bboost", 20, 38, "team"), ("3xc", 20, 38, "team"),
    ])
]
ELEMENT_TYPES = [
    {"id": 1, "singular_name": "Goalkeeper", "singular_name_short": "GKP", "plural_name_short": "GKP", "squad_select": 2, "squad_min_play": 1, "squad_max_play": 1, "sub_positions_locked": [12]},
    {"id": 2, "singular_name": "Defender", "singular_name_short": "DEF", "plural_name_short": "DEF", "squad_select": 5, "squad_min_play": 3, "squad_max_play": 5, "sub_positions_locked": []},
    {"id": 3, "singular_name": "Midfielder", "singular_name_short": "MID", "plural_name_short": "MID", "squad_select": 5, "squad_min_play": 2, "squad_max_play": 5, "sub_positions_locked": []},
    {"id": 4, "singular_name": "Forward", "singular_name_short": "FWD", "plural_name_short": "FWD", "squad_select": 3, "squad_min_play": 1, "squad_max_play": 3, "sub_positions_locked": []},
]
GAME_SETTINGS = {"squad_squadsize": 15, "squad_squadplay": 11, "squad_team_limit": 3, "squad_total_spend": 1000, "transfers_sell_on_fee": 0.5,
                 "max_extra_free_transfers": 4, "element_sell_at_purchase_price": False}
# FPL's player count, to turn the archive's ownership counts into selected_by_percent. Approximate
# (it moves through a season); only ownership tie-breaks use it.
MANAGERS = {"2024-25": 11_500_000, "2025-26": 12_500_000}
FD_COLUMNS = ("Div", "Date", "Time", "HomeTeam", "AwayTeam", "FTHG", "FTAG", "HxG", "AxG", "AvgH", "AvgD", "AvgA", "Avg>2.5", "Avg<2.5", "B365H", "B365D", "B365A", "B365>2.5", "B365<2.5")
PRICE_COLUMNS = FD_COLUMNS[9:]


def load(path: Path):
    if path.suffix == ".gz":
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f)
    return json.loads(path.read_text("utf-8"))


def write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, str):
        path.write_text(data, "utf-8")
    else:
        path.write_text(json.dumps(data, separators=(",", ":"), sort_keys=True, ensure_ascii=False) + "\n", "utf-8")


def iso(dt) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def csv_text(rows: list[dict], columns=FD_COLUMNS) -> str:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(columns), extrasaction="ignore", lineterminator="\n")
    w.writeheader()
    for r in rows:
        w.writerow({k: ("" if r.get(k) is None else r.get(k)) for k in columns})
    return buf.getvalue()


def season_code(season: str) -> str:
    return season[2:4] + season[5:7]


def previous_season(season: str) -> str:
    y = int(season[:4]) - 1
    return f"{y}-{(y + 1) % 100:02d}"


# ---------------------------------------------------------------------------------------------------
# live: Gaffer's own snapshots


def build_live(case: dict, out: Path) -> dict:
    base = DATA / case["source"]["base"]
    team = base / "teams" / case["source"]["team"]
    up = out / "upstream"
    boot = load(base / "bootstrap-static.json.gz")
    write(up / "fixtures.json", load(base / "fixtures.json.gz"))
    for f in sorted(base.glob("live-*.json.gz")):
        write(up / f.name.removesuffix(".gz"), load(f))
    for f in sorted(team.glob("picks-*.json")):
        write(up / f.name, load(f))
    write(up / "history.json", load(team / "history.json"))
    write(up / "transfers.json", load(team / "transfers.json"))
    started = load(team / "entry.json")["started_event"]
    cur = next(e["id"] for e in boot["events"] if e["is_current"])
    hist = load(team / "history.json")["current"]
    write(up / "entry.json", entry(case, started, cur, hist[-1]["total_points"] if hist else 0))
    # football-data.co.uk as it was: no Premier League round listed (the live snapshots had none for the
    # next GW), and the scores of the previous and current season.
    results = load(base / "football-data-results.json.gz")
    write(up / "football-data" / "fixtures.csv", csv_text([]))
    for season, rows in results.items():
        write(up / "football-data" / "mmz4281" / season_code(season) / "E0.csv",
              csv_text([{"Div": "E0", "Date": r["date"], "Time": r["time"], "HomeTeam": r["home"], "AwayTeam": r["away"], "FTHG": r["hg"], "FTAG": r["ag"], "HxG": r["hxg"], "AxG": r["axg"]} for r in rows]))
    nxt = next(e for e in boot["events"] if e["is_next"])
    result = base / f"result-{nxt['id']}.json.gz"
    picks = [load(f) for f in sorted(team.glob("picks-*.json"), key=lambda f: int(f.stem.split("-")[1]))]
    basis = picks[-2] if picks[-1].get("active_chip") == "freehit" and len(picks) > 1 else picks[-1]
    squad = [p["element"] for p in sorted(basis["picks"], key=lambda p: p["position"])]
    return {"boot": boot, "squad": squad, "result": load(result) if result.is_file() else None, "season": "2026-27", "gw": nxt["id"], "deadline": nxt["deadline_time"]}


def entry(case: dict, started: int, current: int, points: int) -> dict:
    return {"id": case["team_id"], "name": f"Eval {case['id']}", "player_first_name": "Eval", "player_last_name": "Manager",
            "started_event": started, "current_event": current, "summary_overall_points": points, "summary_overall_rank": None,
            "last_deadline_bank": None, "last_deadline_value": None, "last_deadline_total_transfers": 0}


# ---------------------------------------------------------------------------------------------------
# history: vaastav + football-data.co.uk


def scoring(season: str) -> dict:
    """2026/27's `game_config.scoring` with the season's differences (backtest.season_scoring)."""
    s = json.loads(json.dumps(load(SCORING)["scoring"]))
    start = int(season[:4])
    if start < 2025:
        s["defensive_contribution"] = {k: 0 for k in s.get("defensive_contribution", {"GKP": 0, "DEF": 0, "MID": 0, "FWD": 0})}
    if start < 2024:
        s["goals_scored"]["GKP"] = 6
    return s


def build_history(case: dict, out: Path, history: Path, seasons: dict) -> dict:
    import pandas as pd  # noqa: PLC0415

    from gaffer_lib import backtest as B, plan as P  # noqa: PLC0415

    src = case["source"]
    season, gw, started = src["season"], src["gw"], src["started"]
    if season not in seasons:
        seasons[season] = B.load_season(history, season)
    sd = seasons[season]
    if gw not in sd.gws or started not in sd.gws or not started < gw:
        raise ValueError(f"{case['id']}: GW{gw} / started GW{started} not in {season}")
    d = history / season
    raw = pd.read_csv(d / "players_raw.csv")
    names = {int(r.id): (str(r.web_name), str(r.first_name), str(r.second_name), int(r.code)) for r in raw.itertuples()}
    teams_raw = pd.read_csv(d / "teams.csv")
    fixtures_raw = pd.read_csv(d / "fixtures.csv")
    difficulty = {int(f.id): (int(f.team_h_difficulty), int(f.team_a_difficulty)) for f in fixtures_raw.itertuples()}

    inputs = sd.inputs_at(gw)
    deadline = sd.deadline[gw]
    up = out / "upstream"

    events = []
    for g in sd.gws:
        events.append({"id": g, "name": f"Gameweek {g}", "deadline_time": iso(sd.deadline[g]), "finished": g < gw, "data_checked": g < gw,
                       "is_previous": g == gw - 2, "is_current": g == gw - 1, "is_next": g == gw})
    elements = []
    first_value = {el: by_gw[min(by_gw)]["value"] for el, by_gw in sd.rows.items()}
    before = [g for g in sd.gws if g < gw]
    for pid, p in sorted(inputs.players.items()):
        web, first, second, code = names.get(pid, (p.name, "", p.name, pid))
        rows = sd.rows[pid]
        t = {k: sum(float(rows[g][k]) for g in before if g in rows) for k in ("minutes", "starts", "goals", "assists", "saves", "bonus", "defcon", "xg", "xa", "points")}
        elements.append({
            "id": pid, "code": code, "web_name": web, "first_name": first, "second_name": second, "team": p.team, "element_type": p.element_type,
            "now_cost": p.now_cost, "cost_change_start": int(p.now_cost - first_value[pid]), "status": p.status, "chance_of_playing_next_round": None,
            "chance_of_playing_this_round": None, "news": "", "news_added": None, "ep_next": None if p.ep_next is None else f"{p.ep_next:.1f}",
            "selected_by_percent": f"{100 * (p.selected or 0) / MANAGERS[season]:.1f}", "total_points": int(t["points"]), "minutes": int(t["minutes"]),
            "starts": int(t["starts"]), "goals_scored": int(t["goals"]), "assists": int(t["assists"]), "saves": int(t["saves"]), "bonus": int(t["bonus"]),
            "defensive_contribution": int(t["defcon"]), "expected_goals": f"{t['xg']:.2f}", "expected_assists": f"{t['xa']:.2f}",
        })
    boot = {
        "events": events,
        "teams": [{"id": int(t.id), "code": int(t.code), "name": str(t.name), "short_name": str(t.short_name)} for t in teams_raw.itertuples()],
        "elements": elements, "element_types": ELEMENT_TYPES, "chips": CHIPS, "game_settings": GAME_SETTINGS,
        "game_config": {"settings": {"price_change_deadlines": []}, "scoring": scoring(season)},
    }
    fixtures = []
    for f in inputs.fixtures:
        h, a = difficulty.get(f["id"], (3, 3))
        fixtures.append({"id": f["id"], "event": f["event"], "kickoff_time": f["kickoff_time"], "team_h": f["team_h"], "team_a": f["team_a"],
                         "team_h_score": f["team_h_score"], "team_a_score": f["team_a_score"], "finished": f["finished"], "started": f["finished"],
                         "team_h_difficulty": h, "team_a_difficulty": a})
    write(up / "fixtures.json", fixtures)
    for g in [x for x in sd.gws if sd.stats_from <= x < gw][-6:]:
        write(up / f"live-{g}.json", {"elements": [
            {"id": el, "stats": {"minutes": int(r["minutes"]), "starts": int(r["starts"]), "goals_scored": int(r["goals"]), "assists": int(r["assists"]),
                                 "saves": int(r["saves"]), "bonus": int(r["bonus"]), "defensive_contribution": int(r["defcon"]),
                                 "expected_goals": f"{r['xg']:.2f}", "expected_assists": f"{r['xa']:.2f}", "total_points": int(r["points"])}}
            for el, by_gw in sorted(sd.rows.items()) if g in by_gw for r in [by_gw[g]]]})

    # The team: the most-owned legal £100m squad at its first GW, held since, all chips unplayed.
    start_inputs = sd.inputs_at(started)
    squad = B.template_squad(start_inputs)
    bank = B.BUDGET - sum(start_inputs.players[p].now_cost for p in squad)
    rules = B.season_rules()
    hist, total = [], 0
    picks_doc = None
    for g in [x for x in sd.gws if started <= x < gw]:
        gi = sd.inputs_at(g)
        et = {p: gi.players[p].element_type for p in squad}
        ep = {p: gi.players[p].ep_next or 0.0 for p in squad}
        lu = B.lineup_by(squad, ep, et, rules)
        pts, mins = sd.actual(g)
        s = B.score_gw(lu, pts, mins, et, rules, 0)
        total += int(s["points"])
        value = sum(gi.players[p].now_cost for p in squad)
        on_bench = int(sum(pts.get(p, 0.0) for p in lu["bench"]))
        hist.append({"event": g, "points": int(s["points"]), "total_points": total, "rank": None, "overall_rank": None, "bank": bank, "value": value + bank,
                     "event_transfers": 0, "event_transfers_cost": 0, "points_on_bench": on_bench})
        order = list(lu["xi"]) + list(lu["bench"])
        picks_doc = {"active_chip": None, "automatic_subs": [], "entry_history": hist[-1],
                     "picks": [{"element": p, "position": i + 1, "multiplier": (2 if p == lu["captain"] else 1) if i < 11 else 0,
                                "is_captain": p == lu["captain"], "is_vice_captain": p == lu["vice_captain"], "element_type": et[p]} for i, p in enumerate(order)]}
    write(up / f"picks-{gw - 1}.json", picks_doc)
    write(up / "history.json", {"current": hist, "chips": []})
    write(up / "transfers.json", [])
    write(up / "entry.json", entry(case, started, gw - 1, total))

    # football-data.co.uk: the next round's pre-match prices, and results that kicked off before the deadline.
    def rows_of(s):
        with open(history / s / "E0.csv", encoding="utf-8-sig", newline="") as f:
            return [r for r in csv.DictReader(f) if r.get("Div") == "E0"]
    from gaffer_lib.strength import team_key  # noqa: PLC0415

    kick = {(team_key(sd.team_names[f["team_h"]]), team_key(sd.team_names[f["team_a"]])): (f["event"], f["kickoff_time"]) for f in sd.fixtures}
    current, upcoming = [], []
    for r in rows_of(season):
        ev, ko = kick.get((team_key(r["HomeTeam"]), team_key(r["AwayTeam"])), (None, None))
        if ev == gw:
            upcoming.append({k: r.get(k) for k in ("Div", "Date", "Time", "HomeTeam", "AwayTeam", *PRICE_COLUMNS)})
        if ko and B.parse_time(ko) < deadline:
            current.append(r)
    write(up / "football-data" / "fixtures.csv", csv_text(upcoming))
    write(up / "football-data" / "mmz4281" / season_code(season) / "E0.csv", csv_text(current))
    prev = previous_season(season)
    if (history / prev / "E0.csv").is_file():
        write(up / "football-data" / "mmz4281" / season_code(prev) / "E0.csv", csv_text(rows_of(prev)))

    pts, mins = sd.actual(gw)
    result = {"gw": gw, "source": f"vaastav merged_gw.csv {season} GW{gw} (official total_points and minutes, summed over the GW's fixtures)",
              "elements": [{"id": el, "stats": {"minutes": int(mins[el]), "total_points": int(pts[el])}} for el in sorted(pts)]}
    return {"boot": boot, "squad": squad, "result": result, "season": season, "gw": gw, "deadline": iso(deadline)}


# ---------------------------------------------------------------------------------------------------


def resolve(token, squad: list[int], boot: dict, result: dict | None) -> int:
    if isinstance(token, int):
        return token
    ep = {e["id"]: float(e["ep_next"]) if e.get("ep_next") not in (None, "") else 0.0 for e in boot["elements"]}
    et = {e["id"]: e["element_type"] for e in boot["elements"]}
    by_ep = sorted(squad, key=lambda p: (-ep.get(p, 0.0), p))
    if token == "@top_ep_squad":
        return by_ep[0]
    if token == "@second_ep_squad":
        return by_ep[1]
    if token == "@lowest_ep_squad_outfield":
        return min((p for p in squad if et[p] != 1), key=lambda p: (ep.get(p, 0.0), p))
    if token == "@top_ep_not_squad":
        return max((e["id"] for e in boot["elements"] if e["id"] not in squad and e["status"] == "a"), key=lambda p: (ep.get(p, 0.0), -p))
    if token == "@top_ep_absent_squad":
        if result is None:
            raise ValueError("@top_ep_absent_squad needs the GW's result")
        mins = {e["id"]: e["stats"]["minutes"] for e in result["elements"]}
        absent = [p for p in by_ep if mins.get(p, 0) == 0]
        if not absent:
            raise ValueError("every squad player played: no ruled-out player that reality agrees with")
        return absent[0]
    raise ValueError(f"unknown player selector {token!r}")


def build(case: dict, out: Path, history: Path, seasons: dict) -> dict:
    if out.exists():
        shutil.rmtree(out)
    kind = case["source"]["kind"]
    built = build_live(case, out) if kind == "live" else build_history(case, out, history, seasons)
    boot, squad, result = built["boot"], built["squad"], built["result"]
    names = {e["id"]: e["web_name"] for e in boot["elements"]}
    resolved = dict(case)
    applied = []
    for m in case.get("mutations", []):
        pid = resolve(m["player"], squad, boot, result)
        e = next(x for x in boot["elements"] if x["id"] == pid)
        team = case["team_id"]
        e.update({"status": m.get("status", e["status"]), "chance_of_playing_next_round": m.get("chance"), "chance_of_playing_this_round": m.get("chance"),
                  "news": m["news"].replace("{team}", str(team)), "news_added": built["deadline"]})
        applied.append({**m, "player": pid, "name": names[pid], "news": e["news"]})
    if applied:
        resolved["mutations"] = applied
    if "prefs" in case:
        p = dict(case["prefs"])
        for k in ("keep", "avoid"):
            p[k] = [resolve(t, squad, boot, result) for t in p.get(k, [])]
        resolved["prefs"] = p
    write(out / "upstream" / "bootstrap-static.json", boot)
    if result is not None:
        write(out / "result.json", result)
    deadline = built["deadline"]
    if case["as_of"].startswith("deadline-"):
        from datetime import datetime  # noqa: PLC0415

        hours = int(case["as_of"].removeprefix("deadline-").removesuffix("h"))
        resolved["as_of"] = iso(datetime.fromisoformat(deadline.replace("Z", "+00:00")) - timedelta(hours=hours))
    files = sorted(p for p in out.rglob("*") if p.is_file())
    resolved.update({"season": built["season"], "gw": built["gw"], "deadline": deadline, "squad": squad, "scorable": result is not None,
                     "sha256": {str(p.relative_to(out)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}})
    write(out / "case.json", resolved)
    return resolved


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "var" / "evals" / "cases"))
    ap.add_argument("--history", default=str(ROOT / "var" / "history"))
    ap.add_argument("--only", help="comma-separated case ids")
    args = ap.parse_args()
    only = set(args.only.split(",")) if args.only else None
    seasons: dict = {}
    for f in sorted(CASES.glob("*.json")):
        case = load(f)
        if only and case["id"] not in only:
            continue
        r = build(case, Path(args.out) / case["id"], Path(args.history), seasons)
        muts = "; ".join(f"{m['kind']} on {m['name']}" for m in r.get("mutations", []))
        print(f"{r['id']}: {r['season']} GW{r['gw']}, deadline {r['deadline']}, clock {r['as_of']}, {'scorable' if r['scorable'] else 'NOT scorable yet'}"
              + (f"; {muts}" if muts else "") + (f"; prefs {r['prefs']}" if "prefs" in r else ""))


if __name__ == "__main__":
    main()
