"""What the model sees at one deadline: players with their history, fixtures, odds and rules.

`from_snapshot` builds it from an `fpl_snapshot` directory. `backtest` builds the same structure
from historical data cut off at each deadline, so the live golden path and the backtest run the
same `strength`, `minutes`, `xp` and `plan` code on the same shape of input.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone

from . import rules as R
from .snapshot import Snapshot
from .strength import Match, team_key

# How many finished GWs of per-GW stats the minutes model looks back over (research 04 §3: "last 3-6 GWs").
RECENT_GWS = 6
# Season totals a player accumulates; `games` is his team's matches in the same period.
STAT_KEYS = ("games", "minutes", "starts", "xg", "xa", "goals", "assists", "saves", "bonus", "defcon")


@dataclass
class PlayerData:
    id: int
    team: int
    element_type: int
    now_cost: int  # tenths of £1m
    name: str = ""
    status: str = "a"
    chance: int | None = None  # chance_of_playing_next_round, percent
    ep_next: float | None = None
    selected: float | None = None  # ownership, percent
    totals: dict = field(default_factory=dict)  # this season before the deadline (STAT_KEYS)
    prev: dict | None = None  # the previous season's totals, when known
    recent: list = field(default_factory=list)  # last RECENT_GWS rows, oldest first: {gw, games, minutes, starts}


@dataclass
class ModelInputs:
    season: str
    next_gw: int
    deadline: datetime | None
    players: dict[int, PlayerData]
    team_names: dict[int, str]
    fixtures: list  # FPL fixtures: id, event, team_h, team_a, kickoff_time, finished, team_h_score, team_a_score
    scoring: R.Scoring
    rules: R.Rules
    odds_rows: list = field(default_factory=list)  # football-data.co.uk rows for upcoming matches
    odds_available: bool = False
    odds_reason: str | None = None
    matches: list = field(default_factory=list)  # strength.Match: this season's finished matches
    prev_matches: list = field(default_factory=list)  # strength.Match: earlier seasons, for priors
    stale: bool = False
    last_gw: int = 38

    def horizon(self, n: int) -> list[int]:
        return list(range(self.next_gw, min(self.next_gw + n, self.last_gw + 1)))


def parse_time(s: str | None) -> datetime | None:
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc).replace(tzinfo=None)


def parse_football_data_date(date: str, time: str | None = None) -> datetime:
    """football-data.co.uk dates are dd/mm/yyyy (dd/mm/yy in old files), UK time."""
    d, m, y = (int(x) for x in date.strip().split("/"))
    hh, mm = (int(x) for x in time.split(":")) if time and ":" in time else (12, 0)
    return datetime(y + 2000 if y < 100 else y, m, d, hh, mm)


def matches_from_results(rows) -> list[Match]:
    """football-data.co.uk result rows ({date, home, away, hg, ag, hxg?, axg?}) → strength.Match."""
    out = []
    for r in rows or []:
        if r.get("hg") is None or r.get("ag") is None:
            continue
        out.append(Match(parse_football_data_date(r["date"], r.get("time")), team_key(r["home"]), team_key(r["away"]), int(r["hg"]), int(r["ag"]), r.get("hxg"), r.get("axg")))
    return out


def matches_from_fixtures(fixtures, team_names: Mapping[int, str], xg: Mapping[tuple, tuple] | None = None) -> list[Match]:
    """Finished FPL fixtures → strength.Match, with match xG from `xg[(home_key, away_key)]` if known."""
    out = []
    for f in fixtures:
        if not f.get("finished") or f.get("team_h_score") is None or f.get("team_a_score") is None or not f.get("kickoff_time"):
            continue
        h, a = team_key(team_names[f["team_h"]]), team_key(team_names[f["team_a"]])
        hx, ax = (xg or {}).get((h, a), (None, None))
        out.append(Match(parse_time(f["kickoff_time"]), h, a, int(f["team_h_score"]), int(f["team_a_score"]), hx, ax))
    return out


def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def from_snapshot(snap: Snapshot) -> ModelInputs:
    b = snap.bootstrap
    nxt = next((e for e in b["events"] if e.get("is_next")), None)
    if nxt is None:
        raise ValueError("the snapshot has no next GW (the season is over or not yet open)")
    next_gw = nxt["id"]
    team_names = {t["id"]: t["name"] for t in b["teams"]}
    fixtures = snap.fixtures
    games: dict[int, int] = {t: 0 for t in team_names}
    for f in fixtures:
        if f.get("finished") and f.get("event") is not None and f["event"] < next_gw:
            games[f["team_h"]] = games.get(f["team_h"], 0) + 1
            games[f["team_a"]] = games.get(f["team_a"], 0) + 1

    players: dict[int, PlayerData] = {}
    for e in b["elements"]:
        ep = e.get("ep_next")
        sel = e.get("selected_by_percent")
        players[e["id"]] = PlayerData(
            id=e["id"], team=e["team"], element_type=e["element_type"], now_cost=e["now_cost"], name=e.get("web_name", ""),
            status=e.get("status", "a"), chance=e.get("chance_of_playing_next_round"),
            ep_next=None if ep is None else _num(ep), selected=None if sel is None else _num(sel),
            totals={
                "games": games.get(e["team"], 0), "minutes": _num(e.get("minutes")), "starts": _num(e.get("starts")),
                "xg": _num(e.get("expected_goals")), "xa": _num(e.get("expected_assists")), "goals": _num(e.get("goals_scored")),
                "assists": _num(e.get("assists")), "saves": _num(e.get("saves")), "bonus": _num(e.get("bonus")),
                "defcon": _num(e.get("defensive_contribution")),
            },
        )

    # Recent per-GW minutes and starts, from event/{gw}/live stats stored in the snapshot.
    for gw in range(max(1, next_gw - RECENT_GWS), next_gw):
        live = snap.load(f"live-{gw}")
        if not live:
            continue
        stats = {x["id"]: x["stats"] for x in live["elements"]}
        counts = R.fixture_counts(fixtures, gw, team_names)
        for p in players.values():
            n = counts.get(p.team, 0)
            if n == 0:
                continue
            s = stats.get(p.id, {})
            p.recent.append({"gw": gw, "games": n, "minutes": _num(s.get("minutes")), "starts": _num(s.get("starts"))})

    odds = snap.load("odds") or {}
    results = odds.get("results") or {}
    seasons = sorted(results)
    # The newest results file is the current season, if any of its matches are among this season's fixtures.
    current_pairs = {(team_key(team_names[f["team_h"]]), team_key(team_names[f["team_a"]])) for f in fixtures if f.get("finished")}
    xg: dict[tuple, tuple] = {}
    prev_matches: list[Match] = []
    for s in seasons:
        ms = matches_from_results(results[s])
        if s == seasons[-1] and any((m.home, m.away) in current_pairs for m in ms):
            xg = {(m.home, m.away): (m.home_xg, m.away_xg) for m in ms}
        else:
            prev_matches += ms
    matches = matches_from_fixtures(fixtures, team_names, xg)

    manifest = snap.load("manifest") or {}
    y = parse_time(b["events"][0]["deadline_time"]).year
    return ModelInputs(
        season=f"{y}/{(y + 1) % 100:02d}", next_gw=next_gw, deadline=parse_time(nxt.get("deadline_time")), players=players,
        team_names=team_names, fixtures=fixtures, scoring=R.Scoring.from_bootstrap(b), rules=R.Rules.from_bootstrap(b),
        odds_rows=odds.get("fixtures") or [], odds_available=bool(odds.get("available")), odds_reason=odds.get("reason"),
        matches=matches, prev_matches=prev_matches, stale=bool(manifest.get("stale")), last_gw=max(e["id"] for e in b["events"]),
    )
