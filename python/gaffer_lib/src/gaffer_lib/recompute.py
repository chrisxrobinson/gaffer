"""The recompute half of the gate (ADR 0003, ARCHITECTURE §2.2 step 4).

`submit_recommendation` hands over three things: the model's submission (its decisions and words,
and whatever numbers it quoted), the golden path's plan file (`gaffer.plan/1`, the solver's
evidence) and the user's saved preferences. This module answers with a verdict and, if the plan is
legal, the recommendation with every number computed here:

1. The plan file is checked against the snapshot: same snapshot, same library version, the same
   `--ft`/`--pending`, the same preferences, and the same projection (its xP are recomputed and
   compared). A plan file made from other inputs is refused, and the model is told to re-run.
2. The submitted plan is checked by `validate` (the rules), then against the user's preferences,
   the "don't finalise transfers" flag (FR-DAT-05) and the solver's best plan: its decayed score
   (`plan.score`, the solver's own objective) may be at most 0.5 below the best plan in the plan
   file (FR-REC-09).
3. xP, per-transfer gains, hits, captain and vice, expected points, the 4-GW plan, the chip
   scenarios and the confidence are computed from the snapshot. The model's figures are compared
   with them (`max_model_number_drift`), gaps over 0.5 are flagged, and its figures are discarded.
   The model may lower a confidence level; it can't raise one.

Nothing here solves or reads a clock, so the same request always gives the same answer
(NFR-OBS-01). What the gate takes on trust from the plan file is only *which other plans exist*:
each one is re-validated and re-scored here, but the gate can't prove the solver had no better
plan without solving again.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence

from . import __version__, plan as P, rules as R
from .cli import SCHEMA as PLAN_SCHEMA, _resolve_prefs, resolved_prefs, transfer_numbers
from .derive import derive
from .inputs import from_snapshot
from .snapshot import Snapshot
from .validate import validate
from .xp import project

SCHEMA = "gaffer.recompute/1"
DRIFT_FLAG = 0.5  # a model figure further than this from the recomputed one is reported (ADR 0003)
NEAR_OPTIMAL = 0.5  # FR-REC-09: the chosen plan's decayed xP must be within this of the best plan
RATIONALE_WORDS = 60
SUMMARY_WORDS = 120
LEVELS = ("low", "medium", "high")
STEP_KEYS = ("gw", "transfers", "chip", "xi", "bench", "captain", "vice_captain")


def _violation(code: str, message: str, gw: int | None = None) -> dict:
    return R.Violation(code, message, gw).as_dict()


def _words(text) -> int:
    return len(str(text or "").split())


def _norm(text) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip().casefold()


def _lower(level: str, other: str | None) -> str:
    """The lower of a computed level and the model's: the model may lower confidence, never raise it."""
    if other not in LEVELS:
        return level
    return LEVELS[min(LEVELS.index(level), LEVELS.index(other))]


def _key(step: Mapping) -> tuple:
    return (frozenset((int(t["out"]), int(t["in"])) for t in step.get("transfers", [])), step.get("chip"))


def _proposal(steps: Sequence[Mapping]) -> dict:
    return {"gws": [{k: s[k] for k in STEP_KEYS if k in s} for s in steps]}


def check_evidence(plan_doc, snap: Snapshot, derived: Mapping, prefs: Mapping) -> list[dict]:
    """Is the plan file the golden path's output for this snapshot, these overrides and these preferences?"""
    rerun = "Re-run the golden-path command from the fpl_snapshot summary and submit again."
    if not isinstance(plan_doc, Mapping) or plan_doc.get("schema") != PLAN_SCHEMA or not plan_doc.get("plans"):
        return [_violation("PLAN_MISSING", f"No golden-path plan ({PLAN_SCHEMA}) was found: the numbers can't be recomputed without it. {rerun}")]
    out = []
    if plan_doc.get("snapshot_id") != snap.id:
        out.append(_violation("PLAN_SNAPSHOT_MISMATCH", f"The plan file was made from snapshot {plan_doc.get('snapshot_id')}, not the latest one ({snap.id}). {rerun}"))
    if plan_doc.get("gaffer_lib") != __version__:
        out.append(_violation("PLAN_VERSION_MISMATCH", f"The plan file was made by gaffer_lib {plan_doc.get('gaffer_lib')}; this is {__version__}. {rerun}"))
    a, want = plan_doc.get("assumptions", {}), derived["assumptions"]
    said = lambda x: f"--ft {x['free_transfers']}" if x.get("ft_source") == "user" else "no --ft (the count is derived)"  # noqa: E731
    if (a.get("free_transfers"), a.get("ft_source")) != (want["free_transfers"], want["ft_source"]):
        out.append(_violation("PLAN_ASSUMPTIONS_MISMATCH", f"The plan file was made with {said(a)}, but the snapshot was taken with {said(want)}: free_transfers = {a.get('free_transfers')!r}, not {want['free_transfers']!r}. "
                              f"Only the user sets --ft, with /team; never add or drop it yourself. {rerun}"))
    if a.get("pending_transfers") != want["pending_transfers"]:
        out.append(_violation("PLAN_ASSUMPTIONS_MISMATCH", f"The plan file was made with pending transfers {a.get('pending_transfers')!r}, but the snapshot was taken with {want['pending_transfers']!r} (the user's /team --pending). {rerun}"))
    if plan_doc.get("prefs_resolved") != resolved_prefs(prefs):
        out.append(_violation("PLAN_PREFS_MISMATCH", f"The plan file wasn't made with the user's saved preferences ({resolved_prefs(prefs)}). Re-run the golden path with the --prefs file the fpl_snapshot summary names, and submit again."))
    return out


def check_overrides(items: Sequence, elements: Mapping, gws: Sequence[int]) -> tuple[list[dict], list[dict]]:
    """FR-REC-10: every minutes override names its player, its value and the text it rests on.
    A `news` quote must be found in the player's FPL news in this snapshot."""
    errors, out = [], []
    for i, x in enumerate(items):
        where = f"xmins override {i + 1}"
        pid = x.get("player")
        if not isinstance(pid, int) or pid not in elements:
            errors.append(_violation("XMINS_UNKNOWN_PLAYER", f"{where}: unknown player id {pid!r}"))
            continue
        name = elements[pid]["web_name"]
        mins, gw, quote, source = x.get("xmins"), x.get("gw"), str(x.get("quote") or "").strip(), x.get("source", "news")
        if isinstance(mins, bool) or not isinstance(mins, (int, float)) or not 0 <= mins <= 90:
            errors.append(_violation("XMINS_RANGE", f"{where} ({name}): xmins must be between 0 and 90, got {mins!r}"))
        if gw is not None and gw not in gws:
            errors.append(_violation("XMINS_GW", f"{where} ({name}): GW{gw} is outside the plan's GWs {gws[0]}-{gws[-1]}"))
        if source not in ("news", "user"):
            errors.append(_violation("XMINS_SOURCE", f"{where} ({name}): source must be \"news\" (FPL's news for the player) or \"user\" (something the user said), got {source!r}"))
        if not quote:
            errors.append(_violation("XMINS_QUOTE_MISSING", f"{where} ({name}): quote the text the override rests on"))
        elif source == "news" and _norm(quote) not in _norm(elements[pid].get("news")):
            errors.append(_violation("XMINS_QUOTE_NOT_IN_NEWS", f"{where} ({name}): the quote isn't in the player's FPL news in this snapshot ({elements[pid].get('news') or 'no news'!r}). Quote it exactly, or use source \"user\" for something the user told you."))
        out.append({"player": pid, "name": name, "gw": gw, "xmins": mins, "quote": quote, "source": source})
    return errors, out


def check_preferences(steps: Sequence[Mapping], threaded: Sequence[Mapping], prefs: Mapping, name) -> list[dict]:
    """FR-INP-02: saved chips aren't played, kept players aren't sold, avoided players aren't bought,
    and no GW takes more hits than the user allows."""
    out = []
    keep, avoid, save, max_hits = set(prefs.get("keep_ids", [])), set(prefs.get("avoid_ids", [])), set(prefs.get("save_chips", [])), prefs.get("max_hits_per_gw")
    for s, th in zip(steps, threaded):
        gw = s["gw"]
        if s.get("chip") in save:
            out.append(_violation("PREF_SAVE_CHIP", f"GW{gw}: the user asked to save the {s['chip']} chip (preference save_chips); don't play it", gw))
        for t in s["transfers"]:
            if t["out"] in keep:
                out.append(_violation("PREF_KEEP", f"GW{gw}: the user asked to keep {name(t['out'])} (preference keep); don't transfer him out", gw))
            if t["in"] in avoid:
                out.append(_violation("PREF_AVOID", f"GW{gw}: the user asked to avoid {name(t['in'])} (preference avoid); don't transfer him in", gw))
        if max_hits is not None and th["hits"] > max_hits:
            out.append(_violation("PREF_MAX_HITS", f"GW{gw}: {th['hits']} hit(s), but the user allows at most {max_hits} per GW (preference max_hits_per_gw)", gw))
    return out


def recompute(snap: Snapshot, submission: Mapping, plan_doc, *, prefs: Mapping | None = None, ft: int | None = None, pending=None, finalise_blocked: str | None = None) -> dict:
    b = snap.bootstrap
    elements = {e["id"]: e for e in b["elements"]}
    teams = {t["id"]: t["short_name"] for t in b["teams"]}
    name = lambda p: elements[p]["web_name"] if p in elements else f"player {p}"  # noqa: E731
    sub = submission
    errors: list[dict] = []

    def result(rec=None, validation=None):
        return {"schema": SCHEMA, "gaffer_lib": __version__, "snapshot_id": snap.id, "valid": not errors, "errors": errors,
                "recommendation": rec if not errors else None, "validation": validation or {"passed": False, "recomputed": False}}

    derived = derive(snap, ft=ft, pending=pending)
    inputs = from_snapshot(snap)
    rules = inputs.rules
    rp = _resolve_prefs(dict(prefs or {}), elements, teams)
    state = P.TeamState.from_derived(derived, {i: e["now_cost"] for i, e in elements.items()})
    et = {pid: p.element_type for pid, p in inputs.players.items()}

    # 1. The plan file ---------------------------------------------------------------------------
    errors += check_evidence(plan_doc, snap, derived, rp)
    if not errors and plan_doc.get("hold") and not finalise_blocked:
        errors.append(_violation("PLAN_HOLD_NOT_ALLOWED", "The plan file was made with --hold, which is only for when transfers can't be finalised. Re-run the golden path without --hold and submit again."))
    if errors:
        return result()
    horizon = len(inputs.horizon(P.HORIZON))
    xin_errors, overrides = check_overrides(plan_doc.get("xmins_input") or [], elements, inputs.horizon(P.HORIZON))
    errors += xin_errors
    if errors:
        return result()
    proj = project(inputs, P.HORIZON, plan_doc.get("xmins_input") or None)
    gws = proj.gws
    off = [d.get("name", pid) for pid, d in plan_doc.get("players", {}).items()
           if int(pid) not in proj.xp or any(abs(round(proj.xp[int(pid)][g], 2) - x) > 0.011 for g, x in zip(gws, d.get("xp", [])))]
    if off or len(gws) != horizon:
        errors.append(_violation("PLAN_XP_MISMATCH", f"The plan file's xP don't match this snapshot's projection (e.g. {', '.join(map(str, off[:3])) or 'the GWs'}): it was made from different inputs. Re-run the golden path and submit again."))
        return result()

    # 2. The submitted plan: rules, preferences, the finalise flag -----------------------------------
    shown = min(P.SHOWN, len(gws))
    plan_in = list(sub.get("plan") or [])
    if len(plan_in) != shown:
        errors.append(_violation("PLAN_LENGTH", f"`plan` must have exactly {shown} entries, GW{gws[0]} to GW{gws[shown - 1]}; got {len(plan_in)}"))
        return result()
    pairs = lambda ts: [{"out": int(t["out"]["id"]), "in": int(t["in"]["id"])} for t in ts or []]  # noqa: E731
    bench_in = list(sub["bench"])
    gk_type = next(t for t, n in rules.positions.items() if n == "GKP")
    # FPL fixes the bench goalkeeper's slot; the outfield order is set by the simulator below.
    bench_gk_first = sorted(bench_in, key=lambda p: elements.get(p, {}).get("element_type") != gk_type)
    step0 = {"gw": gws[0], "transfers": pairs(sub.get("transfers")), "chip": sub["chip"].get("play"), "xi": list(sub["starting_xi"]), "bench": bench_gk_first,
             "captain": sub["captain"]["id"], "vice_captain": sub["vice_captain"]["id"]}
    first = plan_in[0]
    differs = [
        field for field, differ in (
            ("transfers", first.get("transfers") is not None and _key({"transfers": pairs(first["transfers"])})[0] != _key(step0)[0]),
            ("chip", "chip" in first and first["chip"] != step0["chip"]),
            ("captain", first.get("captain") is not None and first["captain"] != step0["captain"]),
        ) if differ
    ]
    for field in differs:
        errors.append(_violation("PLAN_GW_MISMATCH", f"plan[0].{field} (GW{gws[0]}) doesn't match the recommendation's own {field}. Make them the same, or leave it out of plan[0].", gws[0]))
    declared = [step0] + [{"gw": p.get("gw"), "transfers": pairs(p.get("transfers")), "chip": p.get("chip")} for p in plan_in[1:]]
    if first.get("gw") not in (None, gws[0]):
        declared[0] = {**step0, "gw": first["gw"]}
    checked = validate(snap, _proposal(declared), ft=ft, pending=pending)
    errors += checked["errors"]
    for label, text, limit in [("summary", sub.get("summary"), SUMMARY_WORDS), ("chip.rationale", sub["chip"].get("rationale"), RATIONALE_WORDS)] + [
        (f"transfers[{i}].rationale", t.get("rationale"), RATIONALE_WORDS) for i, t in enumerate(sub.get("transfers") or [])
    ] + [(f"plan[{i}].note", p.get("note"), RATIONALE_WORDS) for i, p in enumerate(plan_in)]:
        if _words(text) > limit:
            errors.append(_violation("WORD_LIMIT", f"{label} has {_words(text)} words; the limit is {limit}"))
    if errors:
        return result()
    threaded = P.thread_state(declared, inputs, state)
    errors += check_preferences(declared, threaded, rp, name)
    if finalise_blocked and step0["transfers"]:
        errors.append(_violation("TRANSFERS_NOT_FINAL", f"Transfers can't be finalised now: {finalise_blocked} Submit a recommendation with no transfers this GW (run the golden path with --hold for the line-up), and tell the user why.", gws[0]))
    if errors:
        return result()

    # 3. The full plan over the horizon: XI and captain for the later GWs, and the GWs beyond those shown.
    legal = lambda d: validate(snap, _proposal(d["gws"]), ft=ft, pending=pending)["valid"]  # noqa: E731
    ev_plans = [d for d in plan_doc["plans"] if legal(d)]
    if not ev_plans:
        errors.append(_violation("PLAN_NO_VALID_PLANS", "No plan in the plan file passes validation against this snapshot. Re-run the golden path and submit again."))
        return result()
    # Chip scenarios are plans too: a submission that follows one takes its line-ups from it. They are
    # not part of the comparison below (a chip always adds points; the question there is the transfers).
    ev_scenarios = [x for x in plan_doc.get("chip_scenarios") or [] if x.get("evaluated") and x.get("gws") and legal(x)]
    followable = ev_plans + ev_scenarios
    xp_at = lambda gw: {p: proj.xp[p][gw] for p in proj.xp}  # noqa: E731
    squad0 = step0["xi"] + step0["bench"]
    pp0 = {p: proj.p_play[p][gws[0]] for p in squad0}
    bench0 = P.order_bench(step0["xi"], step0["bench"], xp_at(gws[0]), pp0, et, rules)
    order = {t: i for i, t in enumerate(rules.squad_select)}
    steps = [{**step0, "xi": sorted(step0["xi"], key=lambda p: (order[et[p]], -proj.xp[p][gws[0]], p)), "bench": bench0}]
    for k in range(1, shown):
        gw, squad = gws[k], threaded[k]["squad"]
        match = next((d["gws"][k] for d in followable if len(d["gws"]) > k and all(_key(d["gws"][j]) == _key(declared[j]) for j in range(k + 1))
                      and sorted(d["gws"][k]["xi"] + d["gws"][k]["bench"]) == sorted(squad)), None)
        step = {**declared[k], **({x: match[x] for x in ("xi", "bench", "captain", "vice_captain")} if match else
                                  {x: v for x, v in P.hold_step(squad, gw, inputs, proj).items() if x in ("xi", "bench", "captain", "vice_captain")})}
        want = plan_in[k].get("captain")
        if want is not None and want != step["captain"]:
            if want not in step["xi"]:
                errors.append(_violation("PLAN_CAPTAIN_NOT_IN_XI", f"GW{gw}: {name(want)} isn't in that GW's best XI, so he can't be the planned captain", gw))
            else:
                step["vice_captain"] = step["captain"] if step["vice_captain"] == want else step["vice_captain"]
                step["captain"] = want
        steps.append(step)
    if errors:
        return result()
    tail = next((d["gws"] for d in followable if len(d["gws"]) >= len(gws) and all(_key(d["gws"][j]) == _key(declared[j]) for j in range(shown))), None)
    squad = threaded[shown - 1]["next_squad"]
    for k in range(shown, len(gws)):
        steps.append({x: tail[k][x] for x in STEP_KEYS} if tail else P.hold_step(squad, gws[k], inputs, proj))
    threaded = P.thread_state(steps, inputs, state)

    # 4. Distance from the solver's best plan (FR-REC-09) ---------------------------------------------
    chosen = P.score(steps, inputs, proj, state)
    scored = [(P.score(d["gws"], inputs, proj, state), d) for d in ev_plans]
    best_score, best = max(scored, key=lambda x: x[0])
    gap = best_score - chosen
    if gap > NEAR_OPTIMAL + 1e-6 and not finalise_blocked:
        moves = ", ".join(f"{name(t['out'])}→{name(t['in'])}" for t in best["gws"][0]["transfers"]) or "no transfers"
        errors.append(_violation("NOT_NEAR_OPTIMAL", f"This plan's decayed xP is {gap:.2f} below the solver's best plan (plan {best.get('rank', '?')}: {moves} in GW{gws[0]}); the limit is {NEAR_OPTIMAL}. "
                                 "Risk modes only break ties among near-equal plans: submit a plan within the limit, or re-run the golden path if your inputs have changed (new preferences or minutes overrides)."))
        return result()
    others = [s for s, d in scored if _key(d["gws"][0]) != _key(steps[0])]
    margin = chosen - max(others) if others else None

    # 5. The numbers --------------------------------------------------------------------------------
    gw0, s0, th0 = gws[0], steps[0], threaded[0]
    who = lambda p: {"id": p, "name": name(p)}  # noqa: E731
    transfers = []
    for t, t_in in zip(s0["transfers"], sub.get("transfers") or []):
        n = transfer_numbers(t["out"], t["in"], proj, shown)
        p_in = proj.p_start[t["in"]][gw0]
        level = "medium"
        if p_in >= 0.85 and n["xp_gain_6gw_decayed"] >= 2.0 and not inputs.stale:
            level = "high"
        if inputs.stale or p_in < 0.7 or n["xp_gain_6gw_decayed"] <= 0:
            level = "low"
        transfers.append({
            "out": {**who(t["out"]), "sell_price": state.sell.get(t["out"], elements[t["out"]]["now_cost"]) / 10},
            "in": {**who(t["in"]), "price": elements[t["in"]]["now_cost"] / 10},
            **n, "rationale": str(t_in.get("rationale", "")), "confidence": _lower(level, t_in.get("confidence")),
        })
    hits = th0["hits"]
    hit_cost = hits * rules.hit_cost
    role = lambda p: {**who(p), "xp": round(proj.xp[p][gw0], 2), "p_start": round(proj.p_start[p][gw0], 2)}  # noqa: E731
    plan_out = []
    for k in range(shown):
        s, th = steps[k], threaded[k]
        plan_out.append({
            "gw": s["gw"], "transfers": [{"out": who(t["out"]), "in": who(t["in"])} for t in s["transfers"]], "roll_ft": not s["transfers"] and s.get("chip") not in R.TRANSFER_CHIPS,
            "chip": s.get("chip"), "captain": s["captain"], "free_transfers": th["free_transfers"], "hits": th["hits"], "hit_cost": th["hits"] * rules.hit_cost,
            "expected_points": round(P.expected_points(s, proj), 2), "note": str(plan_in[k].get("note") or ""),
        })

    # Chip scenarios: each one's plan is re-validated and re-scored against the chip-free plan 1.
    base = plan_doc["plans"][0]
    base_ok = any(d is base for d in ev_plans)
    base_score = P.score(base["gws"], inputs, proj, state) if base_ok else best_score
    base_net = {s["gw"]: P.expected_points(s, proj) - th["hits"] * rules.hit_cost for s, th in zip(base["gws"], P.thread_state(base["gws"], inputs, state))} if base_ok else {}
    scenarios = []
    for x in plan_doc.get("chip_scenarios") or []:
        entry = {"chip": x["chip"], "gw": x.get("gw"), "evaluated": False}
        if x.get("evaluated") and x.get("gws") and base_ok:
            if any(x is y for y in ev_scenarios):
                th = P.thread_state(x["gws"], inputs, state)
                at = next(i for i, s in enumerate(x["gws"]) if s["gw"] == x["gw"])
                entry.update(evaluated=True, delta_xp=round(P.score(x["gws"], inputs, proj, state) - base_score, 2),
                             delta_xp_gw=round(P.expected_points(x["gws"][at], proj) - th[at]["hits"] * rules.hit_cost - base_net[x["gw"]], 2))
            else:
                entry["reason"] = "the scenario's plan failed validation"
        else:
            entry["reason"] = str(x.get("reason") or "not evaluated")
        scenarios.append(entry)
    play = s0.get("chip")
    if play and not any(x["chip"] == play and x["gw"] == gw0 and x["evaluated"] for x in scenarios):
        scenarios.append({"chip": play, "gw": gw0, "evaluated": True, "delta_xp": round(chosen - base_score, 2),
                          "delta_xp_gw": round(P.expected_points(s0, proj) - hit_cost - base_net.get(gw0, P.expected_points(s0, proj) - hit_cost), 2)})
    for chip in dict.fromkeys(c.name for c in rules.chips):
        if not any(x["chip"] == chip for x in scenarios):
            scenarios.append({"chip": chip, "gw": None, "evaluated": False, "reason": "no scenario was solved for this chip" + (" (hold plan only)" if plan_doc.get("hold") else "")})
    unevaluated = sorted({x["chip"] for x in scenarios} - {x["chip"] for x in scenarios if x["evaluated"]} - {x["chip"] for x in scenarios if "not available" in x.get("reason", "") or "saved by preference" in x.get("reason", "")})
    if play:
        delta = chosen - base_score
        chip_level = "high" if delta >= 2.0 else "low" if delta < 0.5 else "medium"
    else:
        chip_level = "medium" if unevaluated else "high"
    if inputs.stale:
        chip_level = "low"

    # Confidence (ARCHITECTURE §2.4), by rules; the model may only lower it.
    solver = plan_doc.get("solver", {})
    conf = P.confidence_rules(
        margin=margin, xi_p_start=[proj.p_start[p][gw0] for p in s0["xi"]],
        recommended_p_start=[proj.p_start[p][gw0] for p in [t["in"] for t in s0["transfers"]] + [s0["captain"]]],
        stale=inputs.stale, fallback=bool(base.get("fallback")) and not plan_doc.get("hold"), timed_out=bool(solver.get("timed_out")), gap=solver.get("gap"),
        next_best_timed_out=any(d.get("solver", {}).get("timed_out") for d in plan_doc["plans"][1:2]),
    )
    drivers = list(conf["drivers"])
    overall = conf["overall"]
    free = derived["free_transfers"]
    if free["source"] == "derived" and free.get("confidence") != "high":
        overall = _lower(overall, "medium")
        drivers.append("the derived free-transfer count had to be re-anchored")
    if finalise_blocked:
        overall = "low"
        drivers.append("transfers can't be finalised on stale data this close to the deadline")
    model_conf = sub.get("confidence") or {}
    if _lower(overall, model_conf.get("overall")) != overall:
        overall = _lower(overall, model_conf.get("overall"))
        drivers.append("lowered by Gaffer's own judgement" + (": " + "; ".join(str(d) for d in model_conf.get("drivers", [])[:3]) if model_conf.get("drivers") else ""))

    # Warnings: computed ones first, then the model's own.
    warnings = list(dict.fromkeys(proj.warnings + derived["warnings"] + list(base.get("warnings") or [])))
    if free["source"] == "derived":
        warnings.append("Derived FT count — confirm in app")
    if finalise_blocked:
        warnings.insert(0, f"No transfers recommended: {finalise_blocked}")
    if bench0 != bench_in:
        warnings.append("Bench order set by the auto-sub simulator: " + ", ".join(name(p) for p in bench0))
    if gap > 0.005:
        warnings.append(f"This plan is {gap:.1f} decayed xP below the solver's best plan (a near-tie, chosen on judgement)")

    # Drift: the model's figures against the recomputed ones (FR-REC-07).
    rec_numbers: list[tuple[str, object, float]] = []
    for i, (t_in, t_out) in enumerate(zip(sub.get("transfers") or [], transfers)):
        rec_numbers += [(f"transfers[{i}].xp_gain_4gw", t_in.get("xp_gain_4gw"), t_out["xp_gain_4gw"]), (f"transfers[{i}].xp_gain_6gw_decayed", t_in.get("xp_gain_6gw_decayed"), t_out["xp_gain_6gw_decayed"]),
                        (f"transfers[{i}].out.sell_price", t_in["out"].get("sell_price"), t_out["out"]["sell_price"]), (f"transfers[{i}].in.price", t_in["in"].get("price"), t_out["in"]["price"])]
    net = round(sum(t["xp_gain_4gw"] for t in transfers) - hit_cost, 2)
    expected = round(P.expected_points(s0, proj), 2)
    captain, vice = role(s0["captain"]), role(s0["vice_captain"])
    rec_numbers += [("hits", sub.get("hits"), hits), ("hit_cost", sub.get("hit_cost"), hit_cost), ("net_xp_gain_4gw", sub.get("net_xp_gain_4gw"), net),
                    ("captain.xp", sub["captain"].get("xp"), captain["xp"]), ("captain.p_start", sub["captain"].get("p_start"), captain["p_start"]),
                    ("vice_captain.xp", sub["vice_captain"].get("xp"), vice["xp"]), ("vice_captain.p_start", sub["vice_captain"].get("p_start"), vice["p_start"]),
                    ("expected_points_gw", sub.get("expected_points_gw"), expected)]
    rec_numbers += [(f"plan[{k}].expected_points", plan_in[k].get("expected_points"), plan_out[k]["expected_points"]) for k in range(shown)]
    given = [(path, float(m), float(r)) for path, m, r in rec_numbers if isinstance(m, (int, float)) and not isinstance(m, bool)]
    drift = [{"path": path, "model": m, "recomputed": r, "gap": round(abs(m - r), 2)} for path, m, r in given if abs(m - r) > DRIFT_FLAG]
    for d in drift:
        warnings.append(f"A figure Gaffer quoted was wrong and has been corrected: {d['path']} {d['model']:g} → {d['recomputed']:g}")
    warnings += [str(w) for w in (sub.get("warnings") or [])[:5]]

    referenced = sorted({p for s in steps[:shown] for p in s["xi"] + s["bench"] + [t["out"] for t in s["transfers"]]})
    rec = {
        "season": inputs.season, "gw": gw0, "deadline": derived["gw"]["deadline"],
        "assumptions": {**derived["assumptions"], "bank": state.bank / 10},
        "preferences": {"risk": rp.get("risk") or "balanced", "save_chips": list(rp.get("save_chips", [])),
                        "keep": [who(p) for p in rp.get("keep_ids", [])], "avoid": [who(p) for p in rp.get("avoid_ids", [])],
                        "max_hits_per_gw": rp.get("max_hits_per_gw")},
        "transfers": transfers, "hits": hits, "hit_cost": hit_cost, "net_xp_gain_4gw": net,
        "captain": captain, "vice_captain": vice, "starting_xi": s0["xi"], "bench": s0["bench"], "expected_points_gw": expected,
        "chip": {"play": play, "rationale": str(sub["chip"].get("rationale", "")), "confidence": _lower(chip_level, sub["chip"].get("confidence")), "scenarios": scenarios},
        "plan": plan_out,
        "xmins_overrides": overrides,
        "players": {str(p): {"name": name(p), "team": teams[elements[p]["team"]], "position": rules.positions[et[p]],
                             "xp": round(proj.xp[p][gw0], 2), "p_start": round(proj.p_start[p][gw0], 2)} for p in referenced},
        "warnings": list(dict.fromkeys(warnings)),
        "summary": str(sub.get("summary", "")),
        "confidence": {"overall": overall, "drivers": drivers},
    }
    validation = {
        "passed": True, "recomputed": True,
        "max_model_number_drift": round(max((abs(m - r) for _, m, r in given), default=0.0), 2), "numbers_checked": len(given), "drift": drift,
        "score": round(chosen, 3), "best_score": round(best_score, 3), "gap_to_best": round(gap, 3), "margin": None if margin is None else round(margin, 3),
        "plans_compared": len(ev_plans), "optimality_checked": not finalise_blocked,
        "solver": {k: solver.get(k) for k in ("name", "commit", "status", "gap", "timed_out")},
    }
    return result(rec, validation)
