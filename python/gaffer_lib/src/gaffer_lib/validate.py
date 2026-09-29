"""The deterministic gate (ADR 0003): check a proposed plan against the snapshot it was made from.

M2 checks the rules: squad legality and budget with selling prices, FT and hit arithmetic, chip
availability, one chip per GW, XI formation, bench and captaincy. M4's `submit_recommendation`
calls this, then adds the xP recomputation.

A proposal is one GW step, or `{"gws": [step, ...]}` for consecutive GWs from the next deadline:

    {"gw": 6, "transfers": [{"out": 381, "in": 12}], "chip": null,
     "xi": [11 ids], "bench": [4 ids, GK first], "captain": 12, "vice_captain": 381,
     "hits": 0}

Everything except `transfers` is optional. `hits`/`hit_cost`, when given, are checked against the
recomputed values. Pending transfers (FR-INP-04) count towards the first GW's transfers. Later GWs
assume current prices, and a Free Hit GW's squad and bank revert afterwards.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from . import rules as R
from .derive import derive
from .snapshot import Snapshot

SCHEMA = "gaffer.validation/1"


def _chips(step: Mapping) -> list[str]:
    c = step.get("chip", step.get("chips"))
    if c is None:
        return []
    return [c] if isinstance(c, str) else list(c)


def validate(snap: Snapshot, proposal: Mapping, *, ft: int | None = None, pending=None) -> dict:
    b = snap.bootstrap
    rules = R.Rules.from_bootstrap(b)
    elements = {e["id"]: e for e in b["elements"]}
    players = {e["id"]: R.Player(e["id"], e["team"], e["element_type"]) for e in b["elements"]}
    state = derive(snap, ft=ft, pending=pending)
    steps = list(proposal["gws"]) if "gws" in proposal else [proposal]
    errors: list[R.Violation] = []
    gw_out = []

    squad = [p["id"] for p in state["squad"]]
    sell = {p["id"]: p["selling_price"] for p in state["squad"]}
    bank = state["bank"] or 0
    free = state["free_transfers"]["value"]
    used = [{"name": c["name"], "event": c["used_in"]} for c in state["chips"] if c["used_in"]]
    pend = [(t["out"], t["in"]) for t in (state["pending"] or {}).get("transfers", [])]
    gk_type = next(t for t, n in rules.positions.items() if n == "GKP")

    for k, step in enumerate(steps):
        gw = step.get("gw", (state["gw"]["next"] or 0) + k)
        expected_gw = (state["gw"]["next"] or 0) + k
        if gw != expected_gw:
            errors.append(R.Violation("GW_SEQUENCE", f"step {k + 1} is GW{gw}, expected GW{expected_gw}", gw))
        chips = _chips(step)
        errors += R.chip_violations(chips, gw, rules, used)
        chip = chips[0] if len(chips) == 1 else None
        before = (list(squad), dict(sell), bank)

        moves = (pend if k == 0 else []) + [(int(t["out"]), int(t["in"])) for t in step.get("transfers", [])]
        for o, i in moves:
            bad = False
            for el in (o, i):
                if el not in elements:
                    errors.append(R.Violation("UNKNOWN_PLAYER", f"unknown player id {el}", gw))
                    bad = True
            if bad:
                continue
            if o not in squad:
                errors.append(R.Violation("TRANSFER_OUT_NOT_IN_SQUAD", f"{elements[o]['web_name']} ({o}) isn't in the squad", gw))
                continue
            if i in squad:
                errors.append(R.Violation("TRANSFER_IN_ALREADY_IN_SQUAD", f"{elements[i]['web_name']} ({i}) is already in the squad", gw))
                continue
            bank += sell.pop(o) - elements[i]["now_cost"]
            sell[i] = elements[i]["now_cost"]  # a later sale assumes no price change
            squad = [i if x == o else x for x in squad]
        errors += [R.Violation(v.code, v.message, gw) for v in R.check_squad(squad, players, rules)]
        if bank < 0:
            errors.append(R.Violation("OVER_BUDGET", f"GW{gw} transfers leave the bank at £{bank / 10:.1f}m", gw))

        n = len(moves)
        hits = R.hits(free, n, chip, rules) if free is not None else 0
        cost = hits * rules.hit_cost
        for key, want in (("hits", hits), ("hit_cost", cost)):
            if key in step and step[key] != want:
                errors.append(R.Violation("HIT_MISMATCH", f"GW{gw}: {n} transfers with {free} FT means {key} = {want}, not {step[key]}", gw))

        # XI, bench and captaincy
        xi, bench = step.get("xi"), step.get("bench")
        if xi is not None:
            if len(set(xi)) != len(xi) or any(p not in squad for p in xi):
                errors.append(R.Violation("XI_NOT_IN_SQUAD", f"GW{gw}: the XI must be distinct players from the squad", gw))
            errors += [R.Violation(v.code, f"GW{gw}: {v.message}", gw) for v in R.formation_violations((players[p].element_type for p in xi if p in players), rules)]
            if bench is not None:
                if sorted(list(xi) + list(bench)) != sorted(squad):
                    errors.append(R.Violation("BENCH_MISMATCH", f"GW{gw}: XI + bench must be exactly the 15 in the squad", gw))
                elif players[bench[0]].element_type != gk_type:
                    errors.append(R.Violation("BENCH_GK_FIRST", f"GW{gw}: the bench GK must be first", gw))
            cap, vice = step.get("captain"), step.get("vice_captain")
            for role, p in (("captain", cap), ("vice_captain", vice)):
                if p is not None and p not in xi:
                    errors.append(R.Violation("CAPTAIN_NOT_IN_XI", f"GW{gw}: the {role.replace('_', '-')} must be in the XI", gw))
            if cap is not None and cap == vice:
                errors.append(R.Violation("CAPTAIN_IS_VICE", f"GW{gw}: captain and vice-captain must differ", gw))

        ft_next = R.next_free_transfers(free, n, chip, rules) if free is not None else 1
        gw_out.append({"gw": gw, "ft_available": free, "transfers": n, "hits": hits, "hit_cost": cost, "chip": chip, "bank_after": bank, "ft_next": ft_next})
        for c in chips:
            used.append({"name": c, "event": gw})
        if chip == "freehit":
            squad, sell, bank = before
        free = ft_next

    return {
        "schema": SCHEMA,
        "snapshot_id": state["snapshot_id"],
        "valid": not errors,
        "errors": [e.as_dict() for e in errors],
        "gws": gw_out,
        "assumptions": state["assumptions"],
    }
