"""The golden path (ADR 0003, ARCHITECTURE §2.2 step 2): one command from a snapshot to a full
candidate plan.

    python -m gaffer_lib run --snapshot DIR [--prefs FILE] --out /work/plan.json

strength → minutes → xP → solver (horizon 6, 4 GWs shown) → next-best plans → chip scenarios →
captain candidates, every plan checked by `validate` against the same snapshot. It writes the full
`gaffer.plan/1` JSON to `--out` and prints a compact summary with the top plans.

The whole run is budgeted to finish inside NFR-LAT-03's 60 s on the sandbox's 2 vCPUs: the main
solve may take its 45 s limit, and the next-best plans and chip scenarios share what is left; a
scenario that doesn't fit is reported as not evaluated, with the reason.
"""

from __future__ import annotations

import json
import time
from collections.abc import Mapping

from . import __version__, plan as P, rules as R
from .derive import DeriveError, derive, resolve_player
from .inputs import from_snapshot
from .snapshot import Snapshot
from .validate import validate
from .xp import compare_with_ep_next, project

SCHEMA = "gaffer.plan/1"
CHIP_ALIASES = {
    "wildcard": "wildcard", "wc": "wildcard", "freehit": "freehit", "free_hit": "freehit", "fh": "freehit",
    "bboost": "bboost", "bench_boost": "bboost", "bb": "bboost", "3xc": "3xc", "triple_captain": "3xc", "tc": "3xc",
}
CHIP_LABEL = {"wildcard": "Wildcard", "freehit": "Free Hit", "bboost": "Bench Boost", "3xc": "Triple Captain"}
ALTERNATIVE_LIMIT_S = 8.0


def load_prefs(path: str | None) -> dict:
    if not path:
        return {}
    with open(path, encoding="utf-8") as f:
        prefs = json.load(f)
    if not isinstance(prefs, dict):
        raise DeriveError("--prefs must be a JSON object")
    return prefs


def _resolve_prefs(prefs: Mapping, elements: Mapping, teams: Mapping) -> dict:
    out = dict(prefs)
    for key, dest in (("keep", "keep_ids"), ("avoid", "avoid_ids")):
        out[dest] = [resolve_player(str(x), elements, teams) for x in prefs.get(key, [])]
    chips = []
    for c in prefs.get("save_chips", []):
        name = CHIP_ALIASES.get(str(c).strip().lower().replace(" ", "_"))
        if name is None:
            raise DeriveError(f"unknown chip in save_chips: {c!r}")
        chips.append(name)
    out["save_chips"] = chips
    return out


def golden_path(
    snap: Snapshot, prefs: Mapping | None = None, *, ft: int | None = None, pending=None, horizon: int = P.HORIZON, shown: int = P.SHOWN,
    time_limit: float = P.TIME_LIMIT_S, budget: float = P.TOTAL_BUDGET_S, alternatives: int = 3, chips: bool = True, threads: int | None = None,
) -> dict:
    t0 = time.perf_counter()
    timings: dict[str, float] = {}
    b = snap.bootstrap
    elements = {e["id"]: e for e in b["elements"]}
    teams = {t["id"]: t["short_name"] for t in b["teams"]}
    prefs = _resolve_prefs(prefs or {}, elements, teams)

    derived = derive(snap, ft=ft, pending=pending)
    if not derived["squad"]:
        raise DeriveError("the snapshot has no squad to plan from (the team hasn't passed its first deadline)")
    if derived["pending"] and derived["pending"]["violations"]:
        raise DeriveError("the pending transfers are not legal: " + "; ".join(v["message"] for v in derived["pending"]["violations"]))
    inputs = from_snapshot(snap)
    state = P.TeamState.from_derived(derived, {i: e["now_cost"] for i, e in elements.items()})

    t = time.perf_counter()
    proj = project(inputs, horizon, prefs.get("xmins_overrides"))
    timings["project_s"] = time.perf_counter() - t

    # The main solve gets its full limit; next-best plans are capped so chip scenarios keep a share.
    t = time.perf_counter()
    reserve = P.CHIP_RESERVE_S if chips else 0.0
    plans = P.solve(inputs, proj, state, horizon=horizon, time_limit=min(time_limit, budget), alternatives=alternatives, prefs=prefs,
                    threads=threads, alt_time_limit=min(ALTERNATIVE_LIMIT_S, time_limit), deadline=t0 + max(budget - reserve, 1.0))
    timings["solve_s"] = time.perf_counter() - t
    best = plans[0]

    used = [{"name": c["name"], "event": c["used_in"]} for c in derived["chips"] if c["used_in"]]
    scenarios: list[dict] = []
    if chips:
        t = time.perf_counter()
        remaining = budget - (time.perf_counter() - t0)
        scenarios = P.chip_scenarios(inputs, proj, state, best, used, horizon=horizon, budget_s=max(remaining, 0.0), save=prefs["save_chips"], prefs=prefs, threads=threads)
        timings["chips_s"] = time.perf_counter() - t

    pend_n = derived["pending"]["count"] if derived["pending"] else 0
    free = derived["free_transfers"]["value"]
    plan_docs = []
    for rank, pl in enumerate(plans, start=1):
        if pend_n and free is not None:
            # validate counts the pending transfers in the first GW, so the hits there include them.
            s0 = pl.steps[0]
            s0["hits"] = R.hits(free, pend_n + len(s0["transfers"]), s0["chip"], inputs.rules)
            s0["hit_cost"] = s0["hits"] * inputs.rules.hit_cost
        v = validate(snap, pl.proposal(), ft=ft, pending=pending)
        first = pl.steps[0]
        gws_shown = [s["gw"] for s in pl.steps[:shown]]
        transfers = []
        for tr in first["transfers"]:
            gain = lambda gws, d=1.0: sum((proj.xp[tr["in"]][g] - proj.xp[tr["out"]][g]) * d**k for k, g in enumerate(gws))  # noqa: E731
            transfers.append({
                "out": {"id": tr["out"], "name": elements[tr["out"]]["web_name"], "sell_price": state.sell.get(tr["out"], elements[tr["out"]]["now_cost"]) / 10},
                "in": {"id": tr["in"], "name": elements[tr["in"]]["web_name"], "price": elements[tr["in"]]["now_cost"] / 10},
                "xp_gain_4gw": round(gain(gws_shown), 2), "xp_gain_6gw_decayed": round(gain(proj.gws[:horizon], P.DECAY), 2),
            })
        plan_docs.append({
            "rank": rank, "objective": None if pl.objective is None else round(pl.objective, 3),
            "objective_vs_best": None if pl.objective is None or best.objective is None else round(pl.objective - best.objective, 3),
            "fallback": pl.fallback, "solver": pl.info.as_dict(), "transfers": transfers,
            "hits": first["hits"], "hit_cost": first["hit_cost"],
            "net_xp_gain_4gw": round(sum(x["xp_gain_4gw"] for x in transfers) - first["hit_cost"], 2),
            "expected_points_gw": first["expected_points"],
            "expected_points_shown": round(sum(s["expected_points"] - s["hit_cost"] for s in pl.steps[:shown]), 2),
            "gws": pl.steps, "shown": shown,
            "validation": {"valid": v["valid"], "errors": v["errors"]},
            "warnings": pl.warnings,
        })

    gw = inputs.next_gw
    xi = best.steps[0]["xi"]
    captains = [{"id": p, "name": elements[p]["web_name"], "xp": round(proj.xp[p][gw], 2), "p_start": round(proj.p_start[p][gw], 2)}
                for p in sorted(xi, key=lambda p: (-proj.xp[p][gw], p))[:3]]
    conf = P.confidence(plans, proj, stale=inputs.stale)
    warnings = list(dict.fromkeys(proj.warnings + derived["warnings"] + best.warnings))
    if derived["free_transfers"]["source"] == "derived":
        warnings.append("Derived FT count — confirm in app")
    if any(not d["validation"]["valid"] for d in plan_docs):
        warnings.append("A plan failed validation against the snapshot; see plans[].validation.errors.")
    referenced = {p for d in plan_docs for s in d["gws"] for p in s["xi"] + s["bench"] + [t["out"] for t in s["transfers"]]}
    timings["total_s"] = time.perf_counter() - t0
    return {
        "schema": SCHEMA, "gaffer_lib": __version__, "solver": {"name": "open-fpl-solver", "commit": P.SOLVER_COMMIT, **best.info.as_dict()},
        "snapshot_id": snap.id, "stale": inputs.stale, "season": inputs.season, "gw": gw, "deadline": derived["gw"]["deadline"],
        "settings": {"horizon": len(proj.gws), "shown": shown, "decay": P.DECAY, "hit_cost": inputs.rules.hit_cost, "time_limit_s": time_limit,
                     "budget_s": budget, "ft_value_list": P.FT_VALUE_LIST, "bench_weights": P.BENCH_WEIGHTS, "chips_in_plan": False},
        "assumptions": {**derived["assumptions"], "bank": state.bank / 10, "free_transfers_at_start": state.free_transfers},
        "preferences": {k: prefs[k] for k in ("risk", "save_chips", "keep", "avoid", "max_hits_per_gw") if k in prefs},
        "xmins_overrides": proj.overrides_applied,
        "plans": plan_docs,
        "chip_scenarios": scenarios,
        "captain": captains,
        "confidence": conf,
        "ep_next_comparison": compare_with_ep_next(inputs, proj),
        "team_strength": {"source": sorted({f.source for f in proj.fixtures if f.gw == gw}), "odds_available": inputs.odds_available,
                          "fixtures": [{"gw": f.gw, "home": teams[f.home], "away": teams[f.away], "lam_home": round(f.lam_home, 2), "lam_away": round(f.lam_away, 2), "source": f.source}
                                       for f in proj.fixtures if f.gw == gw]},
        "players": {str(p): {"name": elements[p]["web_name"], "team": teams[elements[p]["team"]], "position": inputs.rules.positions[elements[p]["element_type"]],
                             "xp": [round(proj.xp[p][g], 2) for g in proj.gws], "p_start": round(proj.p_start[p][gw], 2), "ep_next": inputs.players[p].ep_next}
                    for p in sorted(referenced)},
        "warnings": warnings,
        "timings": {k: round(v, 2) for k, v in timings.items()},
    }


def render_summary(doc: Mapping, out_path: str | None = None) -> str:
    """The compact, model-facing summary (ARCHITECTURE §2.2: "a compact summary and the top 3 plans")."""
    pl = doc["players"]
    name = lambda p: pl[str(p)]["name"]  # noqa: E731
    L = []
    s = doc["solver"]
    gap = "n/a" if s["gap"] is None else f"{100 * s['gap']:.2f}%"
    a = doc["assumptions"]
    L.append(f"Gaffer plan for GW{doc['gw']} (deadline {doc['deadline']}) — gaffer_lib {doc['gaffer_lib']}, snapshot {doc['snapshot_id']}{' (STALE)' if doc['stale'] else ''}")
    L.append(f"Start: {a['free_transfers_at_start']} FT ({a['ft_source']}), bank £{a['bank']:.1f}m" + (f", {len(a['pending_transfers'])} pending transfer(s) applied" if a["pending_transfers"] else "") + ".")
    L.append(f"Solver: {s['status']}, gap {gap}, {s['time_s']:.1f} s (limit {s['time_limit_s']:.0f} s), {s['pool']} players considered. Run took {doc['timings']['total_s']:.1f} s.")
    c = doc["confidence"]
    L.append(f"Confidence: {c['overall']}" + (f" — {'; '.join(c['drivers'])}" if c["drivers"] else ""))
    for d in doc["plans"]:
        head = f"Plan {d['rank']}" + ("" if d["rank"] == 1 or d["objective_vs_best"] is None else f" ({d['objective_vs_best']:+.2f} decayed xP vs plan 1)")
        head += " [HOLD: no solver plan]" if d["fallback"] else ""
        head += "" if d["validation"]["valid"] else " [INVALID: " + "; ".join(e["message"] for e in d["validation"]["errors"][:3]) + "]"
        L.append("")
        L.append(f"{head}: {d['expected_points_gw']:.1f} xP in GW{doc['gw']}, {d['expected_points_shown']:.1f} over {d['shown']} GWs net of hits.")
        for t in d["transfers"]:
            L.append(f"  OUT {t['out']['name']} (id {t['out']['id']}, sells £{t['out']['sell_price']:.1f}m) → IN {t['in']['name']} (id {t['in']['id']}, £{t['in']['price']:.1f}m): {t['xp_gain_4gw']:+.1f} xP over 4 GWs, {t['xp_gain_6gw_decayed']:+.1f} decayed over 6")
        if d["transfers"]:
            L.append(f"  Hits: {d['hits']} (−{d['hit_cost']}); net gain over 4 GWs {d['net_xp_gain_4gw']:+.1f} xP.")
        for st in d["gws"][: d["shown"]]:
            moves = ", ".join(f"{name(t['out'])}→{pl[str(t['in'])]['name']}" for t in st["transfers"]) or "roll"
            chip = f" [{CHIP_LABEL[st['chip']]}]" if st["chip"] else ""
            L.append(f"  GW{st['gw']}{chip}: {moves}; {st['free_transfers']} FT, hits {st['hits']}; C {name(st['captain'])}, V {name(st['vice_captain'])}; {st['expected_points']:.1f} xP")
        if d["rank"] == 1:
            first = d["gws"][0]
            L.append(f"  XI GW{doc['gw']}: " + ", ".join(f"{name(p)} {pl[str(p)]['xp'][0]:.1f}" for p in first["xi"]))
            L.append("  Bench (GK, then order): " + ", ".join(f"{name(p)} {pl[str(p)]['xp'][0]:.1f}" for p in first["bench"]))
    if doc["chip_scenarios"]:
        L.append("")
        L.append("Chip scenarios (forced in one GW, against plan 1 with no chip):")
        for x in doc["chip_scenarios"]:
            label = CHIP_LABEL.get(x["chip"], x["chip"])
            if x["evaluated"]:
                note = "" if x["solver"]["status"] == "Optimal" else f" (best found in {x['solver']['time_limit_s']:.0f} s; a lower bound)"
                L.append(f"  {label} GW{x['gw']}: {x['delta_xp_gw']:+.1f} xP that GW, {x['delta_xp_horizon']:+.1f} over the horizon, {x['delta_objective']:+.1f} decayed objective{note}")
            else:
                L.append(f"  {label}{f' GW{x['gw']}' if x['gw'] else ''}: not evaluated — {x['reason']}")
    L.append("")
    L.append("Captain candidates: " + "; ".join(f"{x['name']} {x['xp']:.1f} xP (P(start) {x['p_start']:.2f})" for x in doc["captain"]))
    e = doc["ep_next_comparison"]
    if "correlation" in e:
        gaps = ", ".join(f"{g['name']} {g['xp']:.1f} vs {g['ep_next']}" for g in e["largest_gaps"][:4])
        L.append(f"xP vs official ep_next (GW{e['gw']}, {e['players']} players): r {e['correlation']}, mean gap {e['mean_abs_gap']}; largest: {gaps}")
    if doc["warnings"]:
        L.append("")
        L.append("Warnings:")
        L += [f"- {w}" for w in doc["warnings"]]
    if out_path:
        L.append("")
        L.append(f"Full plan JSON: {out_path}")
    return "\n".join(L)
