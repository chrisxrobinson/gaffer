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
