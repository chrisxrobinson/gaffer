"""Offline backtest of the deterministic pipeline against baselines (ARCHITECTURE §6.2, FR-EVL-01).

    python -m gaffer_lib backtest --seasons 2023-24,2024-25,2025-26 [--data var/history]

Each season is replayed GW by GW from one starting squad (the most-owned legal £100m squad at GW1).
Every decision uses only what was known before that GW's deadline:

    B0  no transfers       hold; XI and captain by the official xP
    B1  official-xP greedy one free transfer a week, the swap that gains most official xP
    B2  template           one free transfer a week, the swap that gains most ownership
    G0  Gaffer baseline    the golden path: strength -> minutes -> xP -> solver (no chips)

All four are scored the same way: the real points of the XI after FPL's automatic substitutions,
captain doubled (vice if the captain didn't play), minus 4 per hit. No policy plays a chip.

Honesty notes, which the output repeats:
- No leakage. `inputs_at(gw)` takes stats, results and xG only from fixtures that kicked off before
  the deadline (90 minutes before the GW's first kick-off), and the price and ownership recorded for
  the GW itself. Tests change later GWs and check that earlier decisions don't move.
- The official xP. vaastav's `xP` column for GW g was captured after GW g's matches and contains
  their points (BUILD.md), so the baselines use the value recorded for the previous GW: the last
  official xP that existed before the deadline. Where that is missing the season is reported with
  its coverage, and B1 can't be built for the uncovered GWs (it holds).
- The fixture list for later GWs is the final one (reschedulings announced later are visible to G0's
  horizon); results never are.
- Availability flags (injury, suspension) aren't in the archive, so G0 runs without them here. A
  player who is no longer registered for a GW is known to be gone.
- Transfer rules are the current ones (bank up to 5 free transfers) in every season, so the policy
  being tested is the one that will run; 2023/24 really capped the bank at 2.
- Previous-season stats seed the model at the start of each season (they pre-date every deadline).
"""

from __future__ import annotations

import json
import math
import sys
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

from . import __version__, plan as P, rules as R
from .inputs import RECENT_GWS, ModelInputs, PlayerData, matches_from_fixtures, matches_from_results, parse_time
from .strength import team_key
from .xp import project

BUDGET = 1000
DEADLINE_BEFORE_KICKOFF = timedelta(minutes=90)
POSITIONS = {"GK": 1, "GKP": 1, "DEF": 2, "MID": 3, "FWD": 4}
POLICIES = ("B0", "B1", "B2", "G0")
# A GW's xP column counts as populated when more than this share of its players have a non-zero value.
XP_POPULATED_SHARE = 0.05
# A season's B1 is "built" when the previous GW's official xP exists for at least this share of its GWs.
B1_MIN_COVERAGE = 0.9

_CURRENT_SCORING = {
    "long_play": 2, "short_play": 1, "goals_conceded": {"GKP": -1, "DEF": -1, "MID": 0, "FWD": 0}, "saves": 1,
    "goals_scored": {"GKP": 10, "DEF": 6, "MID": 5, "FWD": 4}, "assists": 3, "clean_sheets": {"GKP": 4, "DEF": 4, "MID": 1, "FWD": 0},
    "bonus": 1, "defensive_contribution": {"GKP": 0, "DEF": 2, "MID": 2, "FWD": 2},
}


def season_scoring(season: str) -> dict:
    """`game_config.scoring` as it was in `season` (research 04 §0): defensive-contribution points
    began in 2025/26, and a goalkeeper's goal was worth 6 until 2024/25 made it 10."""
    s = json.loads(json.dumps(_CURRENT_SCORING))
    start = int(season[:4])
    if start < 2025:
        s["defensive_contribution"] = {"GKP": 0, "DEF": 0, "MID": 0, "FWD": 0}
    if start < 2024:
        s["goals_scored"]["GKP"] = 6
    return s


def season_rules() -> R.Rules:
    return R.Rules(positions={1: "GKP", 2: "DEF", 3: "MID", 4: "FWD"}, squad_select={1: 2, 2: 5, 3: 5, 4: 3},
                   min_play={1: 1, 2: 3, 3: 2, 4: 1}, max_play={1: 1, 2: 5, 3: 5, 4: 3})


def previous_season(season: str) -> str:
    y = int(season[:4]) - 1
    return f"{y}-{(y + 1) % 100:02d}"


# ---------------------------------------------------------------------------------------------------
# Season data


STATS = {"minutes": "minutes", "starts": "starts", "xg": "expected_goals", "xa": "expected_assists", "goals": "goals_scored",
         "assists": "assists", "saves": "saves", "bonus": "bonus", "defcon": "defensive_contribution"}


class SeasonData:
    """One season of per player-fixture rows (vaastav `merged_gw.csv` columns), teams, fixtures and
    football-data.co.uk rows, indexed for cut-offs by GW."""

    def __init__(self, season: str, merged, teams, fixtures, e0=None, codes: Mapping[int, int] | None = None, prev_totals: Mapping[int, dict] | None = None, prev_e0=None):
        import pandas as pd  # noqa: PLC0415

        self.season = season
        self.codes = dict(codes or {})
        self.prev_totals = dict(prev_totals or {})
        self.team_names = {int(r.id): str(r.name) for r in teams.itertuples()}
        name_to_id = {team_key(n): t for t, n in self.team_names.items()}
        # 2025/26's archive repeats 10 player-fixture rows verbatim; counted twice they would double points.
        m = merged[merged["position"].isin(POSITIONS)].drop_duplicates(["element", "fixture"]).copy()
        for col in STATS.values():
            if col not in m.columns:
                m[col] = 0.0
            m[col] = pd.to_numeric(m[col], errors="coerce").fillna(0.0)
        m["xP"] = pd.to_numeric(m.get("xP", 0.0), errors="coerce").fillna(0.0)
        unknown = sorted({str(n) for n in m["team"].unique() if team_key(n) not in name_to_id})
        if unknown:
            raise ValueError(f"{season}: teams in the player rows that aren't in teams.csv: {unknown}")
        m["team_id"] = m["team"].map(lambda n: name_to_id[team_key(n)])
        m["et"] = m["position"].map(POSITIONS)
        self.fixtures = [
            {"id": int(f.id), "event": None if f.event != f.event else int(f.event), "kickoff_time": f.kickoff_time if isinstance(f.kickoff_time, str) else None,
             "team_h": int(f.team_h), "team_a": int(f.team_a), "finished": True,
             "team_h_score": None if f.team_h_score != f.team_h_score else int(f.team_h_score), "team_a_score": None if f.team_a_score != f.team_a_score else int(f.team_a_score)}
            for f in fixtures.itertuples()
        ]
        kick = {f["id"]: parse_time(f["kickoff_time"]) for f in self.fixtures if f["kickoff_time"]}
        self.gws = sorted({f["event"] for f in self.fixtures if f["event"] is not None and f["id"] in kick})
        self.deadline = {g: min(kick[f["id"]] for f in self.fixtures if f["event"] == g and f["id"] in kick) - DEADLINE_BEFORE_KICKOFF for g in self.gws}
        self.kickoff = kick

        # Per player and GW: stat sums over his fixtures in that GW.
        g = m.groupby(["element", "GW"]).agg(games=("fixture", "count"), points=("total_points", "sum"), value=("value", "last"), selected=("selected", "last"),
                                             xp=("xP", "first"), team_id=("team_id", "last"), et=("et", "last"), name=("name", "last"), **{k: (v, "sum") for k, v in STATS.items()})
        self.rows: dict[int, dict[int, dict]] = {}
        for (el, gw), r in zip(g.index, g.to_dict("records")):
            self.rows.setdefault(int(el), {})[int(gw)] = r
        # Team xG per fixture, from the players' xG.
        xg = m.groupby(["fixture", "was_home"])["expected_goals"].sum()
        self.fixture_xg = {}
        for (fx, home), v in xg.items():
            self.fixture_xg.setdefault(int(fx), [None, None])[0 if str(home) == "True" else 1] = float(v)
        # Which GWs have a populated official-xP column.
        share = (m["xP"] != 0).groupby(m["GW"]).mean()
        self.xp_gws = sorted(int(gw) for gw, s in share.items() if s > XP_POPULATED_SHARE)
        self.e0 = e0_rows(e0)
        self.prev_matches = matches_from_results(results_from_e0(e0_rows(prev_e0)))
        self._has_xg = bool(m["expected_goals"].sum() > 0)
        # 2022/23's archive has no starts or xG before GW16 (FPL added them mid-season): those GWs
        # can't feed the model, so they are left out of every total.
        starts = m.groupby("GW")["starts"].sum()
        with_stats = [int(g) for g, v in starts.items() if v > 0]
        self.stats_from = min(with_stats) if with_stats else self.gws[0]

    # -- what was known before a deadline ---------------------------------------------------------

    def official_xp_gw(self, gw: int) -> int | None:
        """The GW whose official xP was the latest recorded before `gw`'s deadline: the previous GW
        (GW1's own for GW1, when nothing has been played and it can hold no result)."""
        if gw == self.gws[0]:
            return gw if gw in self.xp_gws else None
        prev = [g for g in self.xp_gws if g < gw]
        return prev[-1] if prev else None

    def has_fresh_xp(self, gw: int) -> bool:
        src = self.official_xp_gw(gw)
        if src is None:
            return False
        return src == gw or src == max((g for g in self.gws if g < gw), default=None)

    def inputs_at(self, gw: int) -> ModelInputs:
        deadline = self.deadline[gw]
        played = {f["id"] for f in self.fixtures if f["id"] in self.kickoff and self.kickoff[f["id"]] < deadline}
        fixtures = []
        for f in self.fixtures:
            done = f["id"] in played
            fixtures.append({**f, "finished": done, "team_h_score": f["team_h_score"] if done else None, "team_a_score": f["team_a_score"] if done else None})
        before = [g for g in self.gws if self.stats_from <= g < gw]
        recent_gws = before[-RECENT_GWS:]
        teams_playing = {t for f in self.fixtures if f["event"] == gw for t in (f["team_h"], f["team_a"])}
        xp_src = self.official_xp_gw(gw)
        players: dict[int, PlayerData] = {}
        for el, by_gw in self.rows.items():
            seen = [g for g in by_gw if g <= gw]
            if not seen:
                continue  # not in the game yet
            last = by_gw[max(seen)]
            past = [by_gw[g] for g in by_gw if self.stats_from <= g < gw]
            totals = {k: float(sum(r[k] for r in past)) for k in ("games", *STATS)}
            registered = gw in by_gw or last["team_id"] not in teams_playing
            players[el] = PlayerData(
                id=el, team=int(last["team_id"]), element_type=int(last["et"]), now_cost=int(last["value"]), name=str(last["name"]),
                status="a" if registered else "u", ep_next=float(by_gw[xp_src]["xp"]) if xp_src in by_gw else None,
                selected=float(last["selected"]), totals=totals, prev=self.prev_totals.get(self.codes.get(el)),
                recent=[{"gw": g, "games": by_gw[g]["games"], "minutes": by_gw[g]["minutes"], "starts": by_gw[g]["starts"]} for g in recent_gws if g in by_gw],
            )
        xg = {}
        if self._has_xg:
            for f in self.fixtures:
                if f["id"] in played and f["id"] in self.fixture_xg:
                    h, a = self.fixture_xg[f["id"]]
                    if not h and not a:
                        continue  # no xG recorded for this match
                    xg[(team_key(self.team_names[f["team_h"]]), team_key(self.team_names[f["team_a"]]))] = (h, a)
        pairs = {(team_key(self.team_names[f["team_h"]]), team_key(self.team_names[f["team_a"]])) for f in self.fixtures if f["event"] == gw}
        odds_rows = [r for r in self.e0 if (team_key(r["home"]), team_key(r["away"])) in pairs and r["odds"]]
        return ModelInputs(
            season=self.season, next_gw=gw, deadline=deadline, players=players, team_names=self.team_names, fixtures=fixtures,
            scoring=R.Scoring(season_scoring(self.season), season_rules().positions), rules=season_rules(), odds_rows=odds_rows,
            odds_available=bool(odds_rows), odds_reason=None if odds_rows else "no odds rows for this GW",
            matches=matches_from_fixtures(fixtures, self.team_names, xg), prev_matches=self.prev_matches, last_gw=self.gws[-1],
        )

    # -- what happened ----------------------------------------------------------------------------

    def actual(self, gw: int) -> tuple[dict[int, float], dict[int, float]]:
        pts, mins = {}, {}
        for el, by_gw in self.rows.items():
            if gw in by_gw:
                pts[el], mins[el] = float(by_gw[gw]["points"]), float(by_gw[gw]["minutes"])
        return pts, mins

    def totals_by_code(self) -> dict[int, dict]:
        out = {}
        for el, by_gw in self.rows.items():
            code = self.codes.get(el)
            if code is not None:
                out[code] = {k: float(sum(r[k] for g, r in by_gw.items() if g >= self.stats_from)) for k in ("games", *STATS)}
        return out


ODDS_COLUMNS = ("AvgH", "AvgD", "AvgA", "Avg>2.5", "Avg<2.5", "B365H", "B365D", "B365A", "B365>2.5", "B365<2.5")


def _num(v):
    try:
        x = float(v)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def e0_rows(e0) -> list[dict]:
    """football-data.co.uk season rows → the shape `odds.json` uses: pre-match prices (not the closing
    ones, which post-date the deadline) and the result."""
    if e0 is None:
        return []
    out = []
    for r in e0.to_dict("records"):
        if not isinstance(r.get("HomeTeam"), str):
            continue
        out.append({"date": r["Date"], "time": r.get("Time") if isinstance(r.get("Time"), str) else None, "home": r["HomeTeam"], "away": r["AwayTeam"],
                    "odds": {k: _num(r.get(k)) for k in ODDS_COLUMNS if _num(r.get(k)) is not None},
                    "hg": _num(r.get("FTHG")), "ag": _num(r.get("FTAG")), "hxg": _num(r.get("HxG")), "axg": _num(r.get("AxG"))})
    return out


def results_from_e0(rows: Sequence[Mapping]) -> list[dict]:
    return [r for r in rows if r.get("hg") is not None and r.get("ag") is not None]


def load_season(data_dir: str | Path, season: str, *, with_previous: bool = True) -> SeasonData:
    """Read one season fetched by tools/fetch_history.py, with the previous season's totals as priors."""
    import pandas as pd  # noqa: PLC0415

    d = Path(data_dir) / season
    if not (d / "merged_gw.csv").is_file():
        raise FileNotFoundError(f"no history for {season} in {data_dir}: run tools/fetch_history.py")
    merged = pd.read_csv(d / "merged_gw.csv", low_memory=False)
    raw = pd.read_csv(d / "players_raw.csv", usecols=["id", "code"])
    codes = {int(r.id): int(r.code) for r in raw.itertuples()}
    e0 = pd.read_csv(d / "E0.csv", encoding="utf-8-sig") if (d / "E0.csv").is_file() else None
    prev_totals, prev_e0 = {}, None
    prev_dir = Path(data_dir) / previous_season(season)
    if with_previous and (prev_dir / "merged_gw.csv").is_file():
        prev = load_season(data_dir, previous_season(season), with_previous=False)
        prev_totals = prev.totals_by_code()
        prev_e0 = pd.read_csv(prev_dir / "E0.csv", encoding="utf-8-sig") if (prev_dir / "E0.csv").is_file() else None
    return SeasonData(season, merged, pd.read_csv(d / "teams.csv"), pd.read_csv(d / "fixtures.csv"), e0, codes, prev_totals, prev_e0)


# ---------------------------------------------------------------------------------------------------
# The team being managed


@dataclass
class Team:
    squad: list[int]
    purchase: dict[int, int]
    bank: int
    ft: int = 1
    points: float = 0.0
    hits: int = 0
    transfers: int = 0
    by_gw: list[dict] = field(default_factory=list)

    def copy(self) -> Team:
        return Team(list(self.squad), dict(self.purchase), self.bank, self.ft)


def template_squad(inputs: ModelInputs) -> list[int]:
    """The starting squad every policy shares: the legal 15 within £100m with the highest total
    ownership at the first deadline (a small MILP)."""
    from scipy.optimize import Bounds, LinearConstraint, milp  # noqa: PLC0415

    ps = [p for p in inputs.players.values() if p.status != "u"]
    n = len(ps)
    own = np.array([p.selected or 0.0 for p in ps], dtype=float)
    own = own / max(own.max(), 1.0)
    cons = [LinearConstraint(np.array([[p.now_cost for p in ps]], dtype=float), 0, BUDGET)]
    for t, need in inputs.rules.squad_select.items():
        cons.append(LinearConstraint(np.array([[float(p.element_type == t) for p in ps]]), need, need))
    for team in inputs.team_names:
        cons.append(LinearConstraint(np.array([[float(p.team == team) for p in ps]]), 0, inputs.rules.team_limit))
    res = milp(c=-own, constraints=cons, integrality=np.ones(n), bounds=Bounds(0, 1))
    if not res.success:
        raise RuntimeError(f"no legal starting squad: {res.message}")
    return sorted(ps[i].id for i in range(n) if res.x[i] > 0.5)


def score_gw(lineup: Mapping, points: Mapping[int, float], minutes: Mapping[int, float], element_type: Mapping[int, int], rules: R.Rules, hit_cost: int) -> dict:
    """Real points for a lineup: automatic substitutions, captain doubled (the vice if the captain
    didn't play), minus the hit cost."""
    played = lambda p: minutes.get(p, 0) > 0  # noqa: E731
    picks = [R.Pick(p, i + 1, element_type[p]) for i, p in enumerate(list(lineup["xi"]) + list(lineup["bench"]))]
    subs = R.automatic_subs(picks, played, rules)
    xi = list(lineup["xi"])
    for out, into in subs:
        xi[xi.index(out)] = into
    captain = lineup["captain"] if played(lineup["captain"]) else lineup["vice_captain"] if played(lineup["vice_captain"]) else None
    total = sum(points.get(p, 0.0) for p in xi) + (points.get(captain, 0.0) if captain in xi else 0.0)
    return {"points": total - hit_cost, "gross": total, "captain_points": points.get(captain, 0.0) if captain in xi else 0.0, "autosubs": len(subs)}


def lineup_by(squad: Sequence[int], value: Mapping[int, float], element_type: Mapping[int, int], rules: R.Rules) -> dict:
    xi, bench = P.best_xi(squad, value, element_type, rules)
    ranked = sorted(xi, key=lambda p: (-value.get(p, 0.0), p))
    return {"xi": xi, "bench": bench, "captain": ranked[0], "vice_captain": ranked[1]}


def greedy_transfer(team: Team, inputs: ModelInputs, value: Mapping[int, float]) -> tuple[int, int] | None:
    """The single legal swap (same position, within budget and the club limit) that gains the most
    `value`, or None if no swap gains anything."""
    rules = inputs.rules
    by_team: dict[int, int] = {}
    for p in team.squad:
        by_team[inputs.players[p].team] = by_team.get(inputs.players[p].team, 0) + 1
    best, best_gain = None, 1e-9
    candidates = sorted((p for p in inputs.players.values() if p.id not in team.squad and p.status != "u"), key=lambda p: -value.get(p.id, 0.0))
    for out in team.squad:
        po = inputs.players[out]
        funds = team.bank + R.selling_price(team.purchase[out], po.now_cost, rules)
        for c in candidates:
            gain = value.get(c.id, 0.0) - value.get(out, 0.0)
            if gain <= best_gain:
                break  # candidates are sorted: nothing further gains more
            if c.element_type != po.element_type or c.now_cost > funds:
                continue
            if by_team.get(c.team, 0) - (po.team == c.team) >= rules.team_limit:
                continue
            best, best_gain = (out, c.id), gain
            break
    return best


def apply_transfers(team: Team, transfers: Sequence[tuple[int, int]], inputs: ModelInputs) -> None:
    for out, into in transfers:
        team.bank += R.selling_price(team.purchase.pop(out), inputs.players[out].now_cost, inputs.rules) - inputs.players[into].now_cost
        team.purchase[into] = inputs.players[into].now_cost
        team.squad[team.squad.index(out)] = into
    if team.bank < 0:
        raise AssertionError(f"transfers left the bank at {team.bank}")
    players = {p: R.Player(p, inputs.players[p].team, inputs.players[p].element_type) for p in team.squad}
    bad = R.check_squad(team.squad, players, inputs.rules)
    if bad:
        raise AssertionError(f"illegal squad after transfers: {[v.message for v in bad]}")


# ---------------------------------------------------------------------------------------------------
# Policies: each returns the GW's transfers and lineup from what was known before the deadline


def decide(policy: str, team: Team, inputs: ModelInputs, *, first: bool, fresh_xp: bool = True, time_limit: float = P.TIME_LIMIT_S, proj=None) -> dict:
    """`fresh_xp`: whether the official xP in `inputs` was recorded for the previous GW. B1 only
    transfers on a fresh value; on a stale one it holds."""
    et = {i: p.element_type for i, p in inputs.players.items()}
    ep = {i: (p.ep_next or 0.0) for i, p in inputs.players.items()}
    own = {i: (p.selected or 0.0) for i, p in inputs.players.items()}
    if policy == "B0":
        return {"transfers": [], **lineup_by(team.squad, ep, et, inputs.rules)}
    if policy in ("B1", "B2"):
        value = ep if policy == "B1" else own
        swap = None
        if not first and team.ft >= 1 and (policy == "B2" or fresh_xp):
            swap = greedy_transfer(team, inputs, value)
        squad = [swap[1] if swap and p == swap[0] else p for p in team.squad]
        return {"transfers": [swap] if swap else [], **lineup_by(squad, value, et, inputs.rules)}
    if policy == "G0":
        proj = proj or project(inputs, P.HORIZON)
        sell = {p: R.selling_price(team.purchase[p], inputs.players[p].now_cost, inputs.rules) for p in team.squad}
        state = P.TeamState(list(team.squad), sell, team.bank, 0 if first else team.ft, inputs.next_gw)
        if first:
            # The starting squad is fixed for every policy, so GW1 is a lineup decision only.
            step = P.hold_plan(inputs, proj, state, P.SolveInfo("", None, 0.0, 0.0, None, False), 1).steps[0]
            return {"transfers": [], **{k: step[k] for k in ("xi", "bench", "captain", "vice_captain")}, "solver": None}
        plan = P.solve(inputs, proj, state, horizon=P.HORIZON, time_limit=time_limit)[0]
        step = plan.steps[0]
        return {"transfers": [(t["out"], t["in"]) for t in step["transfers"]], **{k: step[k] for k in ("xi", "bench", "captain", "vice_captain")},
                "solver": plan.info.as_dict(), "fallback": plan.fallback}
    raise ValueError(f"unknown policy {policy}")


def run_policy(season: SeasonData, policy: str, start: Team, *, gws: Sequence[int] | None = None, time_limit: float = P.TIME_LIMIT_S, log=None) -> Team:
    team = start.copy()
    gws = list(gws or season.gws)
    for n, gw in enumerate(gws):
        t0 = time.perf_counter()
        inputs = season.inputs_at(gw)
        first = n == 0
        d = decide(policy, team, inputs, first=first, fresh_xp=season.has_fresh_xp(gw), time_limit=time_limit)
        apply_transfers(team, d["transfers"], inputs)
        made = len(d["transfers"])
        hits = R.hits(team.ft, made, None, inputs.rules) if not first else 0
        cost = hits * inputs.rules.hit_cost
        et = {p: inputs.players[p].element_type for p in team.squad}
        bad = R.formation_violations((et[p] for p in d["xi"]), inputs.rules)
        if bad or sorted(d["xi"] + d["bench"]) != sorted(team.squad):
            raise AssertionError(f"{policy} GW{gw}: illegal lineup {[v.message for v in bad]}")
        pts, mins = season.actual(gw)
        s = score_gw(d, pts, mins, et, inputs.rules, cost)
        team.points += s["points"]
        team.hits += hits
        team.transfers += made
        row = {"gw": gw, "points": s["points"], "transfers": made, "hits": hits, "captain": d["captain"], "captain_points": s["captain_points"],
               "ft": team.ft, "bank": team.bank, "transfer_ids": [list(t) for t in d["transfers"]], "xi": list(d["xi"]), "bench": list(d["bench"]), "vice_captain": d["vice_captain"]}
        if d.get("solver"):
            row["solver"] = d["solver"]
        team.by_gw.append(row)
        if not first:
            team.ft = R.next_free_transfers(team.ft, made, None, inputs.rules)
        if log:
            log(f"{season.season} {policy} GW{gw}: {s['points']:.0f} pts (total {team.points:.0f}), {made} transfer(s), {hits} hit(s), {time.perf_counter() - t0:.1f} s")
    return team


def projection_error(season: SeasonData, gws: Sequence[int] | None = None) -> dict:
    """RMSE of Gaffer's xP and of the official xP against real points, by OpenFPL's buckets (research
    04 §2b): zeros (0 points), blanks (1-2), tickers (3-4) and haulers (5+). Players the model
    expected to feature (xP or official xP above 0.5), in GWs where the official xP was fresh."""
    acc: dict[str, list[float]] = {}
    for gw in gws or season.gws:
        if not season.has_fresh_xp(gw):
            continue
        inputs = season.inputs_at(gw)
        proj = project(inputs, 1)
        pts, _ = season.actual(gw)
        for pid, p in inputs.players.items():
            x, e = proj.xp[pid][gw], p.ep_next or 0.0
            if max(x, e) <= 0.5:
                continue
            y = pts.get(pid, 0.0)
            bucket = "zeros" if y <= 0 else "blanks" if y <= 2 else "tickers" if y <= 4 else "haulers"
            for name in (bucket, "all"):
                a = acc.setdefault(name, [0, 0.0, 0.0, 0.0, 0.0])
                a[0] += 1
                a[1] += (x - y) ** 2
                a[2] += (e - y) ** 2
                a[3] += abs(x - y)
                a[4] += abs(e - y)
    return {k: {"n": int(a[0]), "rmse_gaffer": round(math.sqrt(a[1] / a[0]), 3), "rmse_official": round(math.sqrt(a[2] / a[0]), 3),
                "mae_gaffer": round(a[3] / a[0], 3), "mae_official": round(a[4] / a[0], 3)} for k, a in acc.items()}


def backtest_season(season: SeasonData, policies: Sequence[str] = POLICIES, *, time_limit: float = P.TIME_LIMIT_S, log=None, from_gw: int | None = None) -> dict:
    """`from_gw` starts the replay part-way through (the starting squad is then picked at that GW)."""
    gws_run = [g for g in season.gws if from_gw is None or g >= from_gw]
    first = season.inputs_at(gws_run[0])
    squad = template_squad(first)
    cost = sum(first.players[p].now_cost for p in squad)
    start = Team(squad, {p: first.players[p].now_cost for p in squad}, BUDGET - cost)
    fresh = [g for g in gws_run if season.has_fresh_xp(g)]
    out = {
        "season": season.season, "gws": len(gws_run), "from_gw": gws_run[0], "start_squad": squad, "start_bank": start.bank,
        "official_xp": {"gws_with_fresh_value": len(fresh), "of": len(gws_run), "coverage": round(len(fresh) / len(gws_run), 3),
                        "missing_gws": [g for g in gws_run if g not in fresh]},
        "policies": {},
    }
    out["official_xp"]["b1_built"] = out["official_xp"]["coverage"] >= B1_MIN_COVERAGE
    for policy in policies:
        t0 = time.perf_counter()
        team = run_policy(season, policy, start, gws=gws_run, time_limit=time_limit, log=log)
        gws = team.by_gw
        doc = {"points": round(team.points, 1), "points_per_gw": round(team.points / len(gws), 2), "transfers": team.transfers, "hits": team.hits,
               "hit_cost": team.hits * 4, "captain_points": round(sum(g["captain_points"] for g in gws), 1), "seconds": round(time.perf_counter() - t0, 1), "by_gw": gws}
        if policy == "G0":
            solves = [g["solver"] for g in gws if g.get("solver")]
            doc["solver"] = {"solves": len(solves), "timed_out": sum(s["timed_out"] for s in solves), "max_gap": max((s["gap"] or 0.0 for s in solves), default=0.0),
                             "mean_time_s": round(float(np.mean([s["time_s"] for s in solves])), 2) if solves else None, "max_time_s": max((s["time_s"] for s in solves), default=None)}
        out["policies"][policy] = doc
    return out


def summarise(results: Sequence[Mapping], policies: Sequence[str]) -> dict:
    """Season points per policy, the mean over seasons, and FR-EVL-01's verdict."""
    table = {p: {r["season"]: r["policies"][p]["points"] for r in results} for p in policies}
    mean = {p: round(float(np.mean(list(v.values()))), 1) for p, v in table.items()}
    verdict = {}
    if "G0" in mean:
        for b in ("B0", "B1", "B2"):
            if b not in mean:
                continue
            seasons = [r["season"] for r in results if b != "B1" or r["official_xp"]["b1_built"]]
            g = float(np.mean([table["G0"][s] for s in seasons])) if seasons else None
            o = float(np.mean([table[b][s] for s in seasons])) if seasons else None
            v = {"seasons": seasons, "g0_mean": None if g is None else round(g, 1), "baseline_mean": None if o is None else round(o, 1),
                 "g0_beats": None if g is None else g > o, "all_seasons_mean": {"g0": mean["G0"], "baseline": mean[b], "g0_beats": mean["G0"] > mean[b]}}
            if b == "B1":
                v["blocked_seasons"] = [r["season"] for r in results if not r["official_xp"]["b1_built"]]
            verdict[b] = v
    passed = None
    if verdict:
        blocked = bool(verdict.get("B1", {}).get("blocked_seasons"))
        beats = all(v["g0_beats"] for v in verdict.values() if v["g0_beats"] is not None)
        passed = "blocked" if blocked and beats else bool(beats)
    return {"points": table, "mean": mean, "g0_vs": verdict, "fr_evl_01": passed}


def render(results: Sequence[Mapping], summary: Mapping, policies: Sequence[str]) -> str:
    seasons = [r["season"] for r in results]
    L = ["Season points per policy (no chips; current transfer rules; real points after auto-subs, hits deducted)", ""]
    L.append("policy  " + "".join(f"{s:>10}" for s in seasons) + f"{'mean':>10}")
    for p in policies:
        L.append(f"{p:<8}" + "".join(f"{summary['points'][p][s]:>10.0f}" for s in seasons) + f"{summary['mean'][p]:>10.1f}")
    L.append("")
    for r in results:
        x = r["official_xp"]
        note = "" if x["b1_built"] else "  -> B1 NOT BUILT for this season (it holds in the uncovered GWs); B0's XI and captain use stale values there"
        L.append(f"{r['season']}: official xP available before the deadline for {x['gws_with_fresh_value']}/{x['of']} GWs{note}")
        for p in policies:
            d = r["policies"][p]
            extra = f"; solver: {d['solver']['timed_out']}/{d['solver']['solves']} solves timed out, max gap {100 * d['solver']['max_gap']:.2f}%, mean {d['solver']['mean_time_s']} s" if "solver" in d else ""
            L.append(f"  {p}: {d['points']:.0f} pts, {d['transfers']} transfers, {d['hits']} hits (-{d['hit_cost']}), captain {d['captain_points']:.0f}{extra}")
    if summary["g0_vs"]:
        L.append("")
        L.append("FR-EVL-01: G0 must beat B0, B1 and B2 on the mean over the seasons.")
        for b, v in summary["g0_vs"].items():
            if v["g0_beats"] is None:
                L.append(f"  G0 vs {b}: BLOCKED (no season with the baseline built)")
                continue
            word = "beats" if v["g0_beats"] else "DOES NOT beat"
            scope = f"{len(v['seasons'])} season(s) with {b} built" if v.get("blocked_seasons") else f"{len(v['seasons'])}-season mean"
            L.append(f"  G0 {word} {b}: {v['g0_mean']:.1f} vs {v['baseline_mean']:.1f} ({scope})" + (f"; blocked for {', '.join(v['blocked_seasons'])}" if v.get("blocked_seasons") else ""))
        verdict = {True: "PASS", False: "FAIL", "blocked": "BLOCKED IN PART (passes where the baselines could be built)"}[summary["fr_evl_01"]]
        L.append(f"  Result: {verdict}")
    return "\n".join(L)


def main(args) -> int:
    policies = [p.strip() for p in args.policies.split(",") if p.strip()]
    unknown = [p for p in policies if p not in POLICIES]
    if unknown:
        print(json.dumps({"error": f"unknown policies {unknown}; choose from {list(POLICIES)}"}))
        return 2
    log = lambda m: print(m, file=sys.stderr, flush=True)  # noqa: E731
    results = []
    try:
        for s in [x.strip() for x in args.seasons.split(",") if x.strip()]:
            season = load_season(args.data, s)
            results.append(backtest_season(season, policies, time_limit=args.time_limit or P.TIME_LIMIT_S, log=log, from_gw=getattr(args, "from_gw", None)))
    except (FileNotFoundError, P.SolverUnavailable) as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        return 2
    summary = summarise(results, policies)
    if args.out:
        doc = {"schema": "gaffer.backtest/1", "gaffer_lib": __version__, "solver_commit": P.SOLVER_COMMIT, "run_at": datetime.now().isoformat(timespec="seconds"),
               "settings": {"horizon": P.HORIZON, "decay": P.DECAY, "time_limit_s": args.time_limit or P.TIME_LIMIT_S, "hit_cost": 4, "chips": False},
               "summary": summary, "seasons": results}
        Path(args.out).write_text(json.dumps(doc))
    print(render(results, summary, policies))
    return 0
