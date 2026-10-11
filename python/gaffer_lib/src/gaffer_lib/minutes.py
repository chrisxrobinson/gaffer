"""Expected minutes, rules plus recency (ADR 0003, research 04 §3, approach 1).

Minutes gate every points component, so the model keeps the pieces apart instead of using one
E[minutes]: P(start), minutes when starting, P(60+ | start), P(sub on | not starting) and minutes
as a sub. They come from the player's recent GWs (recency-weighted, shrunk towards his season and
previous-season start share) and are then scaled by FPL's availability flags.

Availability rules (`status`, `chance_of_playing_next_round`); the API says nothing beyond the next GW:
- `a` available: 1 throughout.
- `d` doubtful: the stated chance for the next GW, half-way back the GW after, full from then on.
- `i` injured: the stated chance (usually 0) for the next GW, recovering linearly over 4 GWs.
- `s` suspended: the stated chance for the next GW, 0.5 the GW after (ban length is unknown), then 1.
- `n` not available for this match (e.g. a loanee against his parent club): next GW only.
- `u` unavailable (left the club): 0 throughout.
News the flags don't capture goes in through structured `xmins_overrides` (ADR 0003; M4's skills).

The constants are a-priori choices, not tuned on the backtest seasons.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from .inputs import PlayerData

RECENCY_DECAY = 0.8  # weight of a GW relative to the one after it
PRIOR_GAMES = 2.0  # pseudo-matches of prior behind each recent-form estimate
PREV_SEASON_WEIGHT = 0.5  # a previous-season match counts half a current one
MAX_P_START = 0.95  # nobody is certain to start: knocks, rotation, late illness
LONG_PLAY = 60
# Used until the pool has enough recent rows to measure them (per position: GKP, DEF, MID, FWD).
FALLBACK = {1: (90.0, 0.99, 0.02, 30.0), 2: (86.0, 0.93, 0.15, 20.0), 3: (79.0, 0.85, 0.35, 20.0), 4: (78.0, 0.83, 0.40, 20.0)}


@dataclass(frozen=True)
class Baseline:
    """A player's minutes pattern before availability is applied."""

    p_start: float
    mins_start: float
    p60_start: float
    p_sub: float  # P(comes on | doesn't start)
    mins_sub: float

    @property
    def xmins(self) -> float:
        return self.p_start * self.mins_start + (1 - self.p_start) * self.p_sub * self.mins_sub


@dataclass(frozen=True)
class Minutes:
    """One player in one fixture."""

    p_start: float
    p_play: float  # P(minutes > 0)
    p60: float  # P(minutes >= 60)
    xmins: float
    mins_start: float

    @property
    def p_short(self) -> float:
        return max(self.p_play - self.p60, 0.0)


ZERO = Minutes(0.0, 0.0, 0.0, 0.0, 0.0)


def no_history_start_prob(now_cost: int) -> float:
    """P(start) for a player with no minutes history at all (a new signing in GW1): FPL prices
    expected starters up, so the price is the only signal. £4.0m → 0.08, £5.0m → 0.48, £6.0m+ → 0.9."""
    return min(0.9, max(0.05, (now_cost - 38) / 25))


def position_defaults(players: Mapping[int, PlayerData]) -> dict[int, tuple[float, float, float, float]]:
    """(minutes | start, P(60+ | start), P(sub on | not starting), minutes | sub) per position, measured
    on the pool's recent single-fixture GWs; the fallback constants where there are too few rows."""
    acc: dict[int, list[float]] = {}
    for p in players.values():
        a = acc.setdefault(p.element_type, [0.0] * 7)
        for r in p.recent:
            if r["games"] != 1:
                continue
            if r["starts"] >= 1:
                a[0] += 1
                a[1] += r["minutes"]
                a[2] += r["minutes"] >= LONG_PLAY
            else:
                a[3] += 1
                if r["minutes"] > 0:
                    a[4] += 1
                    a[5] += r["minutes"]
    out = dict(FALLBACK)
    for t, a in acc.items():
        fb = FALLBACK.get(t, FALLBACK[3])
        if a[0] >= 50 and a[3] >= 50:
            out[t] = (a[1] / a[0], a[2] / a[0], a[4] / a[3], a[5] / a[4] if a[4] >= 20 else fb[3])
    return out


def baseline(p: PlayerData, defaults: Mapping[int, tuple[float, float, float, float]] | None = None) -> Baseline:
    d = (defaults or FALLBACK).get(p.element_type, FALLBACK[3])
    # Season-long start share, with the previous season at half weight: the prior for recent form.
    t, prev = p.totals or {}, p.prev or {}
    games = t.get("games", 0) + PREV_SEASON_WEIGHT * prev.get("games", 0)
    starts = t.get("starts", 0) + PREV_SEASON_WEIGHT * prev.get("starts", 0)
    s0 = min(starts / games, 1.0) if games > 0 else no_history_start_prob(p.now_cost)

    w_games = w_starts = 0.0
    st_n = st_min = st_long = sub_n = sub_on = sub_min = 0.0
    for age, r in enumerate(reversed(p.recent)):
        w = RECENCY_DECAY**age
        w_games += w * r["games"]
        w_starts += w * min(r["starts"], r["games"])
        if r["games"] != 1:
            continue  # a double GW's minutes can't be split between its fixtures
        if r["starts"] >= 1:
            st_n += w
            st_min += w * min(r["minutes"], 90)
            st_long += w * (r["minutes"] >= LONG_PLAY)
        else:
            sub_n += w
            if r["minutes"] > 0:
                sub_on += w
                sub_min += w * r["minutes"]
    k = PRIOR_GAMES
    return Baseline(
        p_start=min((w_starts + k * s0) / (w_games + k), MAX_P_START),
        mins_start=(st_min + k * d[0]) / (st_n + k),
        p60_start=(st_long + k * d[1]) / (st_n + k),
        p_sub=(sub_on + k * d[2]) / (sub_n + k),
        mins_sub=(sub_min + k * d[3]) / (sub_on + k),
    )


def availability(status: str, chance: int | None, k: int) -> float:
    """P(available) in the GW `k` after the next one (k = 0 is the next GW). See the module docstring."""
    if status == "u":
        return 0.0
    if chance is None:
        a0 = 1.0 if status == "a" else 0.5 if status == "d" else 0.0
    else:
        a0 = min(max(chance / 100.0, 0.0), 1.0)
    if k <= 0:
        return a0
    if status == "a" or status == "n":
        return 1.0
    if status == "d":
        return a0 + (1 - a0) * min(1.0, k / 2)
    if status == "s":
        return 1.0 if k >= 2 else a0 + (1 - a0) * 0.5
    return a0 + (1 - a0) * min(1.0, k / 4)  # injured


def expected_minutes(base: Baseline, avail: float = 1.0, override: float | None = None) -> Minutes:
    """Minutes for one fixture: the baseline scaled by availability, or matched to an `xmins` override."""
    if override is not None:
        target = min(max(float(override), 0.0), 90.0)
        if base.xmins <= 0:
            return ZERO
        if target <= base.xmins:
            avail = target / base.xmins
        else:
            # More minutes than recent form implies: raise P(start) until the expectation matches.
            per_start = base.mins_start - base.p_sub * base.mins_sub
            s = min(1.0, (target - base.p_sub * base.mins_sub) / per_start) if per_start > 0 else 1.0
            base = Baseline(max(s, base.p_start), base.mins_start, base.p60_start, base.p_sub, base.mins_sub)
            avail = 1.0
    s = base.p_start
    return Minutes(
        p_start=avail * s,
        p_play=avail * (s + (1 - s) * base.p_sub),
        p60=avail * s * base.p60_start,
        xmins=avail * base.xmins,
        mins_start=base.mins_start,
    )


def parse_overrides(spec) -> dict[int, dict[int | None, float]]:
    """`xmins_overrides` from prefs → {player: {gw or None (every GW): xmins}}.

    Accepts `{"430": 60}`, `{"430": {"7": 0, "8": 45}}` or a list of
    `{"player": 430, "gw": 7, "xmins": 0, ...}` (extra keys such as the quoted source are ignored).
    """
    out: dict[int, dict[int | None, float]] = {}
    if not spec:
        return out
    if isinstance(spec, Mapping):
        for pid, v in spec.items():
            if isinstance(v, Mapping):
                out[int(pid)] = {int(g): float(x) for g, x in v.items()}
            else:
                out[int(pid)] = {None: float(v)}
        return out
    for item in spec:
        gw = item.get("gw")
        out.setdefault(int(item["player"]), {})[None if gw is None else int(gw)] = float(item["xmins"])
    return out
