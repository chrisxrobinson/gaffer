"""FPL rules (ADR 0003, ARCHITECTURE §2.3): scoring, squad legality, formations and auto-subs,
free transfers and hits, chips, selling prices, blank and double GWs.

Parameters are read from the snapshot's `bootstrap-static` wherever the API exposes them
(`game_config.scoring`, `game_settings`, `element_types`, `chips`), so a season rule change needs no
code change (FR-RUL-07). The few rules the API doesn't expose are constants with a source comment.
Money is in tenths of £1m, as in the API.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from fractions import Fraction

# The stat identifiers that score (explain[] identifiers since 2025/26).
SCORING_STATS = (
    "minutes", "goals_scored", "assists", "clean_sheets", "goals_conceded", "own_goals", "penalties_saved",
    "penalties_missed", "yellow_cards", "red_cards", "saves", "bonus", "defensive_contribution",
)

# Not in the API. Source: Premier League, "Defensive contribution points in 2026/27" and the 2025/26
# rules: DEF +2 at 10 clearances, blocks, interceptions and tackles (CBIT); MID/FWD +2 at 12 CBIT plus
# recoveries (CBIRT); awarded once per match. The API's per-fixture `defensive_contribution` stat is
# already the position's count (verified on event/1/live, 2026-09-29), so the threshold applies to it.
DEFCON_THRESHOLD: dict[str, int | None] = {"GKP": None, "DEF": 10, "MID": 12, "FWD": 12}
# Not in the API: `saves` and `goals_conceded` scoring values are per 3 saves and per 2 goals conceded
# (FPL rules, "Scoring"). The 100% golden tests over 2025/26 and 2026/27 confirm both divisors.
SAVES_PER_POINT = 3
GOALS_CONCEDED_PER_POINT = 2
# Not in the API: each transfer beyond the free ones costs 4 points (FPL rules, "Transfers").
HIT_COST = 4
# Short play is 1-59 minutes, long play 60+ (FPL rules, "Scoring").
LONG_PLAY_MINUTES = 60

CHIP_NAMES = ("wildcard", "freehit", "bboost", "3xc")
TRANSFER_CHIPS = ("wildcard", "freehit")


class Scoring:
    """Per-fixture points from a stat line, using `game_config.scoring`.

    `positions` maps element_type id → short name (`element_types[].singular_name_short`), which
    is how position-specific scoring values are keyed.
    """

    def __init__(self, scoring: Mapping, positions: Mapping[int, str]):
        self.raw = scoring
        self.positions = dict(positions)

    @classmethod
    def from_bootstrap(cls, bootstrap: Mapping) -> Scoring:
        return cls(bootstrap["game_config"]["scoring"], {t["id"]: t["singular_name_short"] for t in bootstrap["element_types"]})

    def value(self, key: str, pos: str) -> int:
        v = self.raw.get(key, 0)
        return v.get(pos, 0) if isinstance(v, Mapping) else v

    def points(self, stats: Mapping[str, int], element_type: int) -> dict[str, int]:
        """Points by stat identifier for one fixture's stat line (missing stats count as 0)."""
        pos = self.positions[element_type]
        s = lambda k: int(stats.get(k, 0) or 0)  # noqa: E731
        minutes = s("minutes")
        out = {
            "minutes": 0 if minutes <= 0 else self.value("long_play" if minutes >= LONG_PLAY_MINUTES else "short_play", pos),
            "goals_scored": s("goals_scored") * self.value("goals_scored", pos),
            "assists": s("assists") * self.value("assists", pos),
            # FPL only credits `clean_sheets` after 60 minutes, so the stat is already conditioned on it.
            "clean_sheets": s("clean_sheets") * self.value("clean_sheets", pos),
            "goals_conceded": (s("goals_conceded") // GOALS_CONCEDED_PER_POINT) * self.value("goals_conceded", pos),
            "own_goals": s("own_goals") * self.value("own_goals", pos),
            "penalties_saved": s("penalties_saved") * self.value("penalties_saved", pos),
            "penalties_missed": s("penalties_missed") * self.value("penalties_missed", pos),
            "yellow_cards": s("yellow_cards") * self.value("yellow_cards", pos),
            "red_cards": s("red_cards") * self.value("red_cards", pos),
            "saves": (s("saves") // SAVES_PER_POINT) * self.value("saves", pos),
            "bonus": s("bonus") * self.value("bonus", pos),
            "defensive_contribution": 0,
        }
        threshold = DEFCON_THRESHOLD.get(pos)
        if threshold is not None and s("defensive_contribution") >= threshold:
            out["defensive_contribution"] = self.value("defensive_contribution", pos)
        return out

    def total(self, stats: Mapping[str, int], element_type: int) -> int:
        return sum(self.points(stats, element_type).values())


@dataclass(frozen=True)
class ChipDef:
    """One entry of `bootstrap.chips`: a chip usable once within [start_event, stop_event]."""

    name: str
    start_event: int
    stop_event: int
    chip_type: str = ""


@dataclass(frozen=True)
class Rules:
    """Season parameters, read from `bootstrap-static` (FR-RUL-07)."""

    positions: Mapping[int, str]  # element_type → short name
    squad_select: Mapping[int, int]  # element_type → players in the 15
    min_play: Mapping[int, int]  # element_type → min in the XI
    max_play: Mapping[int, int]  # element_type → max in the XI
    squad_size: int = 15
    squad_play: int = 11
    team_limit: int = 3
    total_spend: int = 1000
    sell_on_fee: Fraction = Fraction(1, 2)
    max_extra_free_transfers: int = 4
    chips: tuple[ChipDef, ...] = ()
    hit_cost: int = HIT_COST
    # FPL's pick positions: 1-11 the XI, 12 the bench GK (`element_types[GKP].sub_positions_locked`), 13-15 bench order.
    gk_bench_positions: tuple[int, ...] = (12,)

    @property
    def max_free_transfers(self) -> int:
        return 1 + self.max_extra_free_transfers

    @classmethod
    def from_bootstrap(cls, b: Mapping) -> Rules:
        gs = b.get("game_settings", {})
        types = b["element_types"]
        gk_locked = tuple(p for t in types for p in (t.get("sub_positions_locked") or []))
        return cls(
            positions={t["id"]: t["singular_name_short"] for t in types},
            squad_select={t["id"]: t["squad_select"] for t in types},
            min_play={t["id"]: t["squad_min_play"] for t in types},
            max_play={t["id"]: t["squad_max_play"] for t in types},
            squad_size=gs.get("squad_squadsize", 15),
            squad_play=gs.get("squad_squadplay", 11),
            team_limit=gs.get("squad_team_limit", 3),
            total_spend=gs.get("squad_total_spend", 1000),
            sell_on_fee=Fraction(str(gs.get("transfers_sell_on_fee", 0.5))),
            max_extra_free_transfers=gs.get("max_extra_free_transfers", 4),
            chips=tuple(ChipDef(c["name"], c["start_event"], c["stop_event"], c.get("chip_type", "")) for c in b.get("chips", [])),
            gk_bench_positions=gk_locked or (12,),
        )

    def position_of(self, element_type: int) -> str:
        return self.positions[element_type]


# ---------------------------------------------------------------------------------------------------
# Squad legality (FR-RUL-02)


@dataclass(frozen=True)
class Player:
    id: int
    team: int
    element_type: int


@dataclass(frozen=True)
class Violation:
    code: str
    message: str
    gw: int | None = None

    def as_dict(self) -> dict:
        d = {"code": self.code, "message": self.message}
        if self.gw is not None:
            d["gw"] = self.gw
        return d


def check_squad(squad: Sequence[int], players: Mapping[int, Player], rules: Rules, *, cost: int | None = None, budget: int | None = None) -> list[Violation]:
    """Check a 15-man squad: size, no duplicates, known players, position quotas, club limit, budget.

    `cost` is what the squad costs (selling prices for players kept, current prices for players
    bought) and `budget` what is available (bank plus the selling value of the current squad); both
    in tenths. Returns every violation found, each with a stable code.
    """
    out: list[Violation] = []
    if len(squad) != rules.squad_size:
        out.append(Violation("SQUAD_SIZE", f"squad has {len(squad)} players, needs {rules.squad_size}"))
    dupes = sorted(p for p, n in Counter(squad).items() if n > 1)
    if dupes:
        out.append(Violation("DUPLICATE_PLAYER", f"players appear more than once: {dupes}"))
    unknown = [p for p in squad if p not in players]
    if unknown:
        out.append(Violation("UNKNOWN_PLAYER", f"unknown player ids: {unknown}"))
    known = [players[p] for p in squad if p in players]
    by_type = Counter(p.element_type for p in known)
    for t, need in rules.squad_select.items():
        if by_type.get(t, 0) != need:
            out.append(Violation("POSITION_QUOTA", f"{by_type.get(t, 0)} {rules.position_of(t)} in the squad, needs {need}"))
    by_team = Counter(p.team for p in known)
    for team, n in sorted(by_team.items()):
        if n > rules.team_limit:
            out.append(Violation("CLUB_LIMIT", f"{n} players from team {team}, the limit is {rules.team_limit}"))
    if cost is not None and budget is not None and cost > budget:
        out.append(Violation("OVER_BUDGET", f"squad costs £{cost / 10:.1f}m, only £{budget / 10:.1f}m available"))
    return out


# ---------------------------------------------------------------------------------------------------
# Formation and automatic substitutions (FR-RUL-03)


def formation_violations(xi_types: Iterable[int], rules: Rules) -> list[Violation]:
    """An XI of `squad_play` players within each position's [squad_min_play, squad_max_play]."""
    types = list(xi_types)
    out: list[Violation] = []
    if len(types) != rules.squad_play:
        out.append(Violation("XI_SIZE", f"the XI has {len(types)} players, needs {rules.squad_play}"))
    counts = Counter(types)
    for t in rules.squad_select:
        n = counts.get(t, 0)
        if not rules.min_play[t] <= n <= rules.max_play[t]:
            out.append(Violation("FORMATION", f"{n} {rules.position_of(t)} in the XI, allowed {rules.min_play[t]}-{rules.max_play[t]}"))
    return out


def valid_formation(xi_types: Iterable[int], rules: Rules) -> bool:
    return not formation_violations(xi_types, rules)


@dataclass(frozen=True)
class Pick:
    element: int
    position: int  # 1-11 XI, 12-15 bench in order
    element_type: int


def automatic_subs(picks: Sequence[Pick], played: Callable[[int], bool], rules: Rules) -> list[tuple[int, int]]:
    """FPL's automatic substitutions: (element_out, element_in) pairs, in the order they are made.

    Each starter who didn't play, in pick order, is replaced by the first bench player (bench order)
    who played, isn't already used, and keeps the XI's formation valid. A goalkeeper can only be
    replaced by the bench goalkeeper, and an outfield player only by outfield players.

    FPL records the subs in Bench Boost weeks too (observed in the 2026/27 sample); they don't change
    the points there, because all 15 score.
    """
    ordered = sorted(picks, key=lambda p: p.position)
    xi = [p for p in ordered if p.position <= rules.squad_play]
    bench = [p for p in ordered if p.position > rules.squad_play]
    gk_type = next(t for t, name in rules.positions.items() if name == "GKP")
    used: set[int] = set()
    subs: list[tuple[int, int]] = []
    for starter in list(xi):
        if played(starter.element):
            continue
        for cand in bench:
            if cand.element in used or not played(cand.element):
                continue
            if (starter.element_type == gk_type) != (cand.element_type == gk_type):
                continue
            trial = [cand if p is starter else p for p in xi]
            if not valid_formation((p.element_type for p in trial), rules):
                continue
            xi = trial
            used.add(cand.element)
            subs.append((starter.element, cand.element))
            break
    return subs


# ---------------------------------------------------------------------------------------------------
# Free transfers and hits (FR-RUL-04)


def hits(ft: int, transfers: int, chip: str | None, rules: Rules) -> int:
    """Paid transfers this GW: those beyond the free ones. Wildcard and Free Hit transfers are free."""
    if chip in TRANSFER_CHIPS:
        return 0
    return max(0, transfers - ft)


def hit_cost(ft: int, transfers: int, chip: str | None, rules: Rules) -> int:
    return hits(ft, transfers, chip, rules) * rules.hit_cost


def next_free_transfers(ft: int, transfers: int, chip: str | None, rules: Rules) -> int:
    """FTs for the next GW: unused ones roll over, +1, capped at 1 + max_extra_free_transfers.

    A Wildcard or Free Hit week keeps the FT count unchanged, with no +1 (FPL rules since 2024/25;
    open-fpl-solver encodes the same: next = ft - transfers + 1 - WC - FH, clamped to [1, 5]).
    """
    if chip in TRANSFER_CHIPS:
        return min(ft, rules.max_free_transfers)
    return min(max(ft - transfers, 0) + 1, rules.max_free_transfers)


# ---------------------------------------------------------------------------------------------------
# Selling prices


def selling_price(purchase: int, now: int, rules: Rules) -> int:
    """Selling price in tenths: a rise keeps only `transfers_sell_on_fee` of the profit, rounded down
    to £0.1m; a fall is taken in full. With `element_sell_at_purchase_price` false (2026/27)."""
    if now <= purchase:
        return now
    return purchase + int((now - purchase) * rules.sell_on_fee)


# ---------------------------------------------------------------------------------------------------
# Chips (FR-RUL-05)


@dataclass(frozen=True)
class ChipState:
    name: str
    half: int  # 1 for the first window of this chip name, 2 for the second
    start_event: int
    stop_event: int
    used_in: int | None
    available: bool  # usable in the GW asked about

    def as_dict(self) -> dict:
        return {"name": self.name, "half": self.half, "window": [self.start_event, self.stop_event], "used_in": self.used_in, "available": self.available}


def _chip_defs(name: str, rules: Rules) -> list[ChipDef]:
    return sorted((c for c in rules.chips if c.name == name), key=lambda c: c.start_event)


def chip_status(rules: Rules, used: Iterable[Mapping], gw: int | None) -> list[ChipState]:
    """Each chip definition with the GW it was used in (within its window) and whether it can be
    played in `gw`. `used` is `history.chips` ({name, event})."""
    used = list(used)
    out = []
    for name in dict.fromkeys(c.name for c in rules.chips):
        for half, c in enumerate(_chip_defs(name, rules), start=1):
            u = next((x["event"] for x in used if x["name"] == name and c.start_event <= x["event"] <= c.stop_event), None)
            open_ = gw is not None and c.start_event <= gw <= c.stop_event
            out.append(ChipState(name, half, c.start_event, c.stop_event, u, u is None and open_))
    return out


def chip_violations(chips: Sequence[str], gw: int, rules: Rules, used: Iterable[Mapping]) -> list[Violation]:
    """Can `chips` (the chips proposed for `gw`) be played, given the chips already used or planned
    in other GWs (`used`: {name, event})? One chip per GW; each chip once per window; first-half
    chips expire at the GW19 deadline (their window ends at GW19); no Free Hit in consecutive GWs."""
    used = [u for u in used if u["event"] != gw]
    out: list[Violation] = []
    if len(chips) > 1:
        out.append(Violation("CHIP_ONE_PER_GW", f"only one chip per GW, got {list(chips)}", gw))
    for name in chips:
        defs = _chip_defs(name, rules)
        if not defs:
            out.append(Violation("CHIP_UNKNOWN", f"no chip called {name!r} this season", gw))
            continue
        window = next((c for c in defs if c.start_event <= gw <= c.stop_event), None)
        if window is None:
            spans = ", ".join(f"GW{c.start_event}-{c.stop_event}" for c in defs)
            out.append(Violation("CHIP_OUT_OF_WINDOW", f"{name} can't be played in GW{gw} (windows {spans})", gw))
            continue
        prior = next((u["event"] for u in used if u["name"] == name and window.start_event <= u["event"] <= window.stop_event), None)
        if prior is not None:
            out.append(Violation("CHIP_ALREADY_USED", f"{name} for GW{window.start_event}-{window.stop_event} was already used in GW{prior}", gw))
        if name == "freehit" and any(u["name"] == "freehit" and abs(u["event"] - gw) == 1 for u in used):
            out.append(Violation("FH_CONSECUTIVE", f"Free Hit can't be played in consecutive GWs (GW{gw})", gw))
    return out


# ---------------------------------------------------------------------------------------------------
# Blank and double GWs (FR-RUL-06)


def fixture_counts(fixtures: Iterable[Mapping], gw: int, team_ids: Iterable[int]) -> dict[int, int]:
    """Fixtures per team in `gw`. Unscheduled fixtures (`event` null) belong to no GW."""
    counts = {t: 0 for t in team_ids}
    for f in fixtures:
        if f.get("event") == gw:
            for t in (f["team_h"], f["team_a"]):
                counts[t] = counts.get(t, 0) + 1
    return counts


def blanks_and_doubles(fixtures: Iterable[Mapping], gw: int, team_ids: Iterable[int]) -> dict[str, list[int]]:
    counts = fixture_counts(fixtures, gw, team_ids)
    return {"blank": sorted(t for t, n in counts.items() if n == 0), "double": sorted(t for t, n in counts.items() if n >= 2)}
