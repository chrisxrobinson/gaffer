"""Realised points of decisions made before a deadline, once the GW is finished (ARCHITECTURE §6.3,
§6.4; FR-EVL-02, FR-EVL-03).

    python -m gaffer_lib score --snapshot DIR --request FILE|-

The snapshot is the pre-deadline one the decisions were made on; it supplies the rules, the squad
and the official `ep_next`. The request carries what happened and what to score:

    {"gw": 7,
     "live": {"elements": [{"id": 1, "stats": {"minutes": 90, "total_points": 6}}, ...]},  # event/{gw}/live
     "lineups": {"recommended": {"xi": [...], "bench": [...], "captain": 1, "vice_captain": 2,
                                 "chip": null, "hit_cost": 0}, ...},
     "baselines": true,          # also score B0 and B1 from the snapshot's squad
     "ft": null, "pending": null, # the overrides the snapshot was taken with
     "xp": {"<player id>": 5.2}}  # Gaffer's xP for this GW, for the projection error

Every point is scored by `rules.lineup_points` (automatic substitutions, captaincy, chips) from the
official per-player GW totals, so the backtest, the live tracker and the eval graders share one
implementation. B0 and B1 are `backtest.decide`'s policies on the snapshot's squad, with the official
xP the snapshot recorded before the deadline:

    B0  hold; XI and captain by the official xP
    B1  one free transfer on the swap that gains most official xP (none without a free transfer);
        XI and captain by the official xP
"""

from __future__ import annotations

import math
from collections.abc import Mapping

from . import __version__, rules as R
from .derive import derive
from .snapshot import Snapshot

SCHEMA = "gaffer.score/1"


def live_points(live: Mapping) -> tuple[dict[int, float], dict[int, float]]:
    """Per-player GW points and minutes from `event/{gw}/live` (a double GW's fixtures are already
    summed there). A player the response doesn't list had no fixture: 0 points, 0 minutes."""
    pts, mins = {}, {}
    for e in live.get("elements", []):
        s = e.get("stats") or {}
        pts[int(e["id"])] = float(s.get("total_points", 0) or 0)
        mins[int(e["id"])] = float(s.get("minutes", 0) or 0)
    return pts, mins


def score_lineup(lineup: Mapping, pts: Mapping[int, float], mins: Mapping[int, float], element_type: Mapping[int, int], rules: R.Rules) -> dict:
    s = R.lineup_points(lineup["xi"], lineup["bench"], lineup["captain"], lineup["vice_captain"], lineup.get("chip"),
                        pts, lambda p: mins.get(p, 0) > 0, element_type, rules, int(lineup.get("hit_cost") or 0))
    return {k: s[k] for k in ("points", "gross", "hit_cost", "chip", "autosubs", "armband", "multiplier", "captain_points", "bench_points")}


def baselines(snap: Snapshot, *, ft: int | None = None, pending=None) -> dict:
    """B0 and B1's decisions for the snapshot's next GW, from the squad, bank and free transfers it
    derives (with the same `--ft`/`--pending` the recommendation used)."""
    from . import backtest as B, plan as P  # noqa: PLC0415  (numpy: only in the sandbox)
    from .inputs import from_snapshot  # noqa: PLC0415

    inputs = from_snapshot(snap)
    d = derive(snap, ft=ft, pending=pending)
    if not d["squad"]:
        raise ValueError("the snapshot has no squad: nothing to compare with")
    state = P.TeamState.from_derived(d, {i: p.now_cost for i, p in inputs.players.items()})
    team = B.Team(list(state.squad), {}, state.bank, state.free_transfers)
    out = {}
    for policy in ("B0", "B1"):
        dec = B.decide(policy, team, inputs, first=False, fresh_xp=True, sell=state.sell)
        out[policy] = {"transfers": [list(t) for t in dec["transfers"]], "xi": list(dec["xi"]), "bench": list(dec["bench"]),
                       "captain": dec["captain"], "vice_captain": dec["vice_captain"], "chip": None, "hit_cost": 0}
    return out


def projection_error(xp: Mapping, snap: Snapshot, pts: Mapping[int, float]) -> dict:
    """Gaffer's xP and the official `ep_next`, both recorded before the deadline, against the points
    scored: over the players Gaffer projected that have both values."""
    ep = {e["id"]: e.get("ep_next") for e in snap.bootstrap["elements"]}
    rows = []
    for k, x in xp.items():
        pid = int(k)
        e = ep.get(pid)
        if x is None or e is None:
            continue
        try:
            e = float(e)
        except (TypeError, ValueError):
            continue
        rows.append((float(x), e, pts.get(pid, 0.0)))
    if not rows:
        return {"players": 0}
    n = len(rows)
    err = lambda i: [r[i] - r[2] for r in rows]  # noqa: E731
    g, o = err(0), err(1)
    return {
        "players": n,
        "mae_gaffer": round(sum(map(abs, g)) / n, 3), "mae_official": round(sum(map(abs, o)) / n, 3),
        "rmse_gaffer": round(math.sqrt(sum(v * v for v in g) / n), 3), "rmse_official": round(math.sqrt(sum(v * v for v in o) / n), 3),
        "bias_gaffer": round(sum(g) / n, 3), "bias_official": round(sum(o) / n, 3),
    }


def score(snap: Snapshot, req: Mapping) -> dict:
    b = snap.bootstrap
    rules = R.Rules.from_bootstrap(b)
    element_type = {e["id"]: e["element_type"] for e in b["elements"]}
    pts, mins = live_points(req["live"])
    out: dict = {"schema": SCHEMA, "gaffer_lib": __version__, "snapshot_id": snap.id, "gw": req.get("gw"), "lineups": {}}
    for name, lineup in (req.get("lineups") or {}).items():
        out["lineups"][name] = score_lineup(lineup, pts, mins, element_type, rules)
    if req.get("baselines"):
        decided = baselines(snap, ft=req.get("ft"), pending=req.get("pending"))
        out["baselines"] = {k: {**score_lineup(v, pts, mins, element_type, rules), "decision": v} for k, v in decided.items()}
    if req.get("xp"):
        out["projection"] = projection_error(req["xp"], snap, pts)
    return out
