"""The multi-GW planner: a thin wrapper over open-fpl-solver (ADR 0003, research 04 §5).

open-fpl-solver (Apache-2.0, pinned commit, vendored in the sandbox image) builds and solves the
transfer MILP with HiGHS. Its own `prep_data` fetches from the FPL API and reads a projections CSV,
neither of which exists in the sandbox, so this module builds the solver's input from Gaffer's own
projection and team state and calls `solve_multi_period_fpl` directly.

Defaults (ARCHITECTURE §4): horizon 6 with 4 GWs shown, decay 0.9, the solver's default FT values
and bench weights, hit cost 4, a 45 s limit, chips off. Chip advice comes from `chip_scenarios`:
one fixed-chip solve per candidate GW, compared with the chip-free plan, because letting the MILP
place chips freely takes minutes (research 04 §5).

A solve that stops at its time limit returns the best plan found with its MIP gap, and the
confidence is capped at "medium" (NFR-REL-02). If HiGHS has no feasible plan by then, the fallback
is to hold: no transfers, the best XI from the current squad, confidence "low".
"""

from __future__ import annotations

import contextlib
import io
import math
import os
import sys
import time
import warnings as _warnings
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

import numpy as np

from . import rules as R
from .inputs import ModelInputs
from .xp import Projection

SOLVER_COMMIT = "ec65f5e2b2be34441cb4b2a9efafea1ec0fe3b79"  # solioanalytics/open-fpl-solver, 2026-09-15
SOLVER_DIR_ENV = "GAFFER_SOLVER_DIR"
DEFAULT_SOLVER_DIR = "/opt/open-fpl-solver"

HORIZON = 6
SHOWN = 4
DECAY = 0.9
TIME_LIMIT_S = 45.0
# The golden path (NFR-LAT-03) must finish inside 60 s including alternatives and chip scenarios.
TOTAL_BUDGET_S = 50.0
# Of that budget, this much is kept back from the main solve and the next-best plans for chip scenarios.
CHIP_RESERVE_S = 6.0
# Stop when the plan is proven within this many decayed points of the optimum: far below the
# projection's noise, and inside FR-REC-09's 0.5.
MIP_ABS_GAP = 0.25
# open-fpl-solver's defaults (data/comprehensive_settings.json at the pinned commit).
FT_VALUE_LIST = {"2": 2.0, "3": 1.6, "4": 1.3, "5": 1.1}
BENCH_WEIGHTS = {"0": 0.03, "1": 0.21, "2": 0.06, "3": 0.002}
VCAP_WEIGHT = 0.1
FT_USE_PENALTY = 0.2
ITB_VALUE = 0.08
NO_TRANSFER_LAST_GWS = 2
# Its player-pool filters, scaled from its 8-GW default horizon: expected minutes over the horizon,
# the EV-per-price percentile below which a player is dropped, and the top-EV share always kept.
XMIN_LB_PER_GW = 300 / 8
EV_PER_PRICE_CUTOFF = 30
KEEP_TOP_EV_PERCENT = 5

CHIP_CODES = {"wildcard": "wc", "freehit": "fh", "bboost": "bb", "3xc": "tc"}
CHIP_NAMES = {"WC": "wildcard", "FH": "freehit", "BB": "bboost", "TC": "3xc"}
POS_LETTER = {"GKP": "G", "DEF": "D", "MID": "M", "FWD": "F"}


class SolverUnavailable(RuntimeError):
    pass


@dataclass
class TeamState:
    """What the plan starts from: `derive`'s output, with any pending transfers already applied."""

    squad: list[int]
    sell: dict[int, int]  # selling price, tenths
    bank: int  # tenths
    free_transfers: int
    next_gw: int

    @classmethod
    def from_derived(cls, d: Mapping, now_cost: Mapping[int, int]) -> TeamState:
        sell = {p["id"]: p["selling_price"] for p in d["squad"]}
        squad = [p["id"] for p in d["squad"]]
        bank = d["bank"] or 0
        ft = d["free_transfers"]["value"]
        pend = d.get("pending")
        if pend and not pend["violations"]:
            squad, bank = list(pend["squad_after"]), pend["bank_after"]
            for t in pend["transfers"]:
                sell.pop(t["out"], None)
                sell[t["in"]] = now_cost[t["in"]]
            ft = pend["ft_remaining"]
        return cls(squad=squad, sell=sell, bank=bank, free_transfers=1 if ft is None else ft, next_gw=d["gw"]["next"])


@dataclass
class SolveInfo:
    status: str
    gap: float | None  # relative MIP gap; 0 when proven optimal
    time_s: float
    time_limit_s: float
    objective: float | None
    timed_out: bool
    pool: int = 0

    def as_dict(self) -> dict:
        return {
            "status": self.status, "gap": None if self.gap is None else round(self.gap, 6), "time_s": round(self.time_s, 2),
            "time_limit_s": self.time_limit_s, "objective": None if self.objective is None else round(self.objective, 3),
            "timed_out": self.timed_out, "pool": self.pool,
        }


@dataclass
class Plan:
    steps: list[dict]  # one per GW of the horizon; validate's proposal format plus expected points
    objective: float | None
    info: SolveInfo
    fallback: bool = False
    warnings: list[str] = field(default_factory=list)

    def proposal(self, shown: int | None = None) -> dict:
        keys = ("gw", "transfers", "chip", "xi", "bench", "captain", "vice_captain", "hits", "hit_cost")
        steps = self.steps if shown is None else self.steps[:shown]
        return {"gws": [{k: s[k] for k in keys} for s in steps]}


# ---------------------------------------------------------------------------------------------------
# Small deterministic pieces


def best_xi(squad: Sequence[int], xp: Mapping[int, float], element_type: Mapping[int, int], rules: R.Rules) -> tuple[list[int], list[int]]:
    """The valid XI with the most expected points, and the bench (GK first, then by xP)."""
    gk = next(t for t, n in rules.positions.items() if n == "GKP")
    by_type: dict[int, list[int]] = {}
    for p in sorted(squad, key=lambda p: (-xp.get(p, 0.0), p)):
        by_type.setdefault(element_type[p], []).append(p)
    xi: list[int] = []
    for t in rules.squad_select:
        xi += by_type.get(t, [])[: rules.min_play[t]]
    rest = sorted((p for p in squad if p not in xi and element_type[p] != gk), key=lambda p: (-xp.get(p, 0.0), p))
    for p in rest:
        if len(xi) >= rules.squad_play:
            break
        if sum(element_type[q] == element_type[p] for q in xi) < rules.max_play[element_type[p]]:
            xi.append(p)
    bench = [p for p in squad if p not in xi]
    bench.sort(key=lambda p: (element_type[p] != gk, -xp.get(p, 0.0), p))
    order = {t: i for i, t in enumerate(rules.squad_select)}
    xi.sort(key=lambda p: (order[element_type[p]], -xp.get(p, 0.0), p))
    return xi, bench


def hold_plan(inputs: ModelInputs, proj: Projection, state: TeamState, info: SolveInfo, horizon: int) -> Plan:
    """No transfers: the best XI, captain and vice from the current squad in every GW."""
    et = {p: inputs.players[p].element_type for p in state.squad}
    steps, ft = [], state.free_transfers
    for gw in proj.gws[:horizon]:
        xp = {p: proj.xp[p][gw] for p in state.squad}
        xi, bench = best_xi(state.squad, xp, et, inputs.rules)
        ranked = sorted(xi, key=lambda p: (-xp[p], p))
        steps.append({
            "gw": gw, "transfers": [], "chip": None, "xi": xi, "bench": bench, "captain": ranked[0], "vice_captain": ranked[1],
            "hits": 0, "hit_cost": 0, "free_transfers": ft, "bank": state.bank,
            "expected_points": round(sum(xp[p] for p in xi) + xp[ranked[0]], 2),
        })
        ft = R.next_free_transfers(ft, 0, None, inputs.rules)
    return Plan(steps, None, info, fallback=True, warnings=["The solver found no plan within its time limit: holding (no transfers)."])


def _hold_start(hold: Plan, state: TeamState, pool: Sequence[int], max_ft: int) -> dict[str, float]:
    """The hold plan as values of open-fpl-solver's variables (named `squad(p,w)`, `ft6`, ...)."""
    gws = [s["gw"] for s in hold.steps]
    start: dict[str, float] = {}
    in_squad = set(state.squad)
    for p in pool:
        for w in [gws[0] - 1, *gws]:
            start[f"squad({p},{w})"] = float(p in in_squad)
    ft = state.free_transfers
    start[f"itb{gws[0] - 1}"] = state.bank / 10
    for s in hold.steps:
        w = s["gw"]
        bench = {p: o for o, p in enumerate(s["bench"])}
        for p in pool:
            start[f"squad_fh({p},{w})"] = 0.0
            start[f"lineup({p},{w})"] = float(p in s["xi"])
            start[f"captain({p},{w})"] = float(p == s["captain"])
            start[f"vicecap({p},{w})"] = float(p == s["vice_captain"])
            start[f"transfer_in({p},{w})"] = 0.0
            start[f"tr_out_reg({p},{w})"] = 0.0
            start[f"tr_out_first({p},{w})"] = 0.0
            start[f"use_tc({p},{w})"] = 0.0
            for o in range(4):
                start[f"bench({p},{w},{o})"] = float(bench.get(p) == o)
        raw = ft + 1
        start.update({f"itb{w}": state.bank / 10, f"ft{w}": float(ft), f"pt{w}": 0.0, f"trc{w}": 0.0, f"aux{w}": 0.0,
                      f"use_wc{w}": 0.0, f"use_bb{w}": 0.0, f"use_fh{w}": 0.0, f"ft_above{w}": float(raw > max_ft), f"ft_below{w}": 0.0})
        for st in range(6):
            start[f"ft_state({w},{st})"] = float(st == ft)
        ft = min(raw, max_ft)
    return start


# ---------------------------------------------------------------------------------------------------
# open-fpl-solver


def _load_solver():
    path = os.environ.get(SOLVER_DIR_ENV, DEFAULT_SOLVER_DIR)
    if not os.path.isfile(os.path.join(path, "dev", "solver.py")):
        raise SolverUnavailable(f"open-fpl-solver not found at {path} (set {SOLVER_DIR_ENV}); it is vendored in the sandbox image at commit {SOLVER_COMMIT[:8]}")
    if path not in sys.path:
        sys.path.insert(0, path)
    with _warnings.catch_warnings():
        _warnings.simplefilter("ignore")  # fuzzywuzzy warns that python-Levenshtein isn't installed
        import dev.solver as solver  # noqa: PLC0415

        import highspy  # noqa: PLC0415
    return solver, highspy


class _Recorder:
    """Stands in for the `highspy` module inside dev.solver so each model it creates is ours:
    a `Highs` subclass that applies Gaffer's time limits per run and records status and gap."""

    def __init__(self, highspy, limits: list[float], threads: int | None, start: Mapping[str, float] | None = None, deadline: float | None = None):
        self._real = highspy
        self.runs: list[dict] = []
        recorder = self

        class Highs(highspy.Highs):
            def run(self):
                n = len(recorder.runs)
                limit = limits[min(n, len(limits) - 1)]
                if deadline is not None:
                    # Whatever is left before the caller's deadline is shared between the runs still to come.
                    left = deadline - time.perf_counter()
                    limit = min(limit, left if n == 0 else left / max(len(limits) - n, 1))
                if start and not recorder.runs:
                    # A MIP start (the hold plan), so that even a 1 s solve has an incumbent and a gap.
                    cols = [(i, start[n]) for i in range(self.numVariables) if (n := self.variableName(i)) in start]
                    self.setSolution(len(cols), np.array([c[0] for c in cols], dtype=np.int32), np.array([c[1] for c in cols], dtype=np.float64))
                self.setOptionValue("mip_abs_gap", MIP_ABS_GAP)
                self.setOptionValue("time_limit", float(max(limit, 0.05)))  # per run: HiGHS restarts its clock
                if threads:
                    self.setOptionValue("threads", int(threads))
                t0 = time.perf_counter()
                out = super().run()
                info = self.getInfo()
                status = self.modelStatusToString(self.getModelStatus())
                feasible = info.primal_solution_status == 2  # kSolutionStatusFeasible
                recorder.runs.append({
                    "status": status, "time_s": time.perf_counter() - t0, "limit": limit, "feasible": feasible,
                    "gap": float(info.mip_gap) if feasible and math.isfinite(info.mip_gap) else None,
                    "objective": float(info.objective_function_value) if feasible else None,
                })
                return out

        self.Highs = Highs

    def __getattr__(self, name):
        return getattr(self._real, name)


def default_threads() -> int:
    """HiGHS threads: the sandbox has 2 vCPUs, which HiGHS can't see through the cgroup quota."""
    return max(1, int(os.environ.get("GAFFER_SOLVER_THREADS", "2")))


def build_solver_data(inputs: ModelInputs, proj: Projection, state: TeamState, horizon: int, keep: Sequence[int] = (), only: Sequence[int] | None = None):
    """The `data` dict `solve_multi_period_fpl` expects (what its `prep_data` builds from the API).
    `only` restricts the player pool to those ids (plus the squad)."""
    import pandas as pd  # noqa: PLC0415

    gws = proj.gws[:horizon]
    rows = []
    for pid, p in inputs.players.items():
        if pid not in proj.xp:
            continue
        row = {"ID": pid, "web_name": p.name, "element_type": p.element_type, "name": inputs.team_names[p.team],
               "Pos": POS_LETTER[inputs.rules.positions[p.element_type]], "now_cost": p.now_cost, "status": p.status}
        for gw in gws:
            row[f"{gw}_Pts"] = round(proj.xp[pid][gw], 4)
            row[f"{gw}_xMins"] = round(proj.xmins[pid][gw], 2)
        row["total_ev"] = sum(row[f"{gw}_Pts"] for gw in gws)
        row["total_min"] = sum(row[f"{gw}_xMins"] for gw in gws)
        rows.append(row)
    if only is not None:
        allowed = set(only) | set(state.squad)
        rows = [r for r in rows if r["ID"] in allowed]
    df = pd.DataFrame(rows).set_index("ID", drop=False)
    df.index.name = "id_x"
    df = df.sort_values("total_ev", ascending=False)

    # The solver's pool filters (prep_data): always keep the squad, locked players and the top EV.
    safe = set(state.squad) | set(keep)
    top = df["total_ev"].quantile((100 - KEEP_TOP_EV_PERCENT) / 100)
    safe |= set(df.index[df["total_ev"] > top])
    if only is not None:
        safe |= set(df.index)
    df = df[(df["total_min"] >= XMIN_LB_PER_GW * len(gws)) | df.index.isin(safe)]
    df = df[(df["status"] != "u") | df.index.isin(state.squad)]
    per_price = df["total_ev"] / df["now_cost"]
    df = df[(per_price > per_price.quantile(EV_PER_PRICE_CUTOFF / 100)) | df.index.isin(safe)].copy()

    types = pd.DataFrame(
        [{"id": t, "singular_name_short": n, "squad_select": inputs.rules.squad_select[t], "squad_min_play": inputs.rules.min_play[t], "squad_max_play": inputs.rules.max_play[t]} for t, n in inputs.rules.positions.items()]
    ).set_index("id")
    teams = pd.DataFrame([{"id": t, "name": n} for t, n in inputs.team_names.items()])
    buy = (df["now_cost"] / 10).to_dict()
    sell = {p: state.sell[p] / 10 for p in state.squad}
    by_team: dict[int, int] = {}
    for p in state.squad:
        by_team[inputs.players[p].team] = by_team.get(inputs.players[p].team, 0) + 1
    return {
        "merged_data": df, "team_data": teams, "type_data": types, "my_data": {}, "next_gw": gws[0], "initial_squad": list(state.squad),
        "sell_price": sell, "buy_price": buy, "price_modified_players": [p for p in state.squad if buy[p] != sell[p]],
        "itb": state.bank / 10, "ft": state.free_transfers, "ft_base": state.free_transfers,
        "fixtures": [{"gw": f.gw, "home": inputs.team_names[f.home], "away": inputs.team_names[f.away]} for f in proj.fixtures],
        "max_players_from_team": max(by_team.values(), default=0),
    }


def solver_options(horizon: int, *, alternatives: int = 1, chip: tuple[str, int] | None = None, prefs: Mapping | None = None, decay: float = DECAY, hit_cost: int = 4) -> dict:
    prefs = prefs or {}
    opts = {
        "horizon": horizon, "decay_base": decay, "ft_value_list": dict(FT_VALUE_LIST), "bench_weights": dict(BENCH_WEIGHTS),
        "vcap_weight": VCAP_WEIGHT, "ft_use_penalty": FT_USE_PENALTY, "itb_value": ITB_VALUE, "hit_cost": hit_cost,
        "no_transfer_last_gws": NO_TRANSFER_LAST_GWS, "weekly_hit_limit": prefs.get("max_hits_per_gw"),
        "chip_limits": {"wc": 0, "bb": 0, "fh": 0, "tc": 0}, "allowed_chip_gws": {}, "forced_chip_gws": {},
        "num_iterations": alternatives, "iteration_criteria": "this_gw_transfer_in_out", "iteration_difference": 1,
        "secs": TIME_LIMIT_S, "gap": 0, "verbose": False, "solver": "highs", "report_decay_base": [],
        "banned": [int(x) for x in prefs.get("avoid_ids", [])], "locked": [int(x) for x in prefs.get("keep_ids", [])],
    }
    if chip:
        opts[f"use_{CHIP_CODES[chip[0]]}"] = [chip[1]]
    return opts


def _steps_from_solution(sol: Mapping, inputs: ModelInputs, proj: Projection, state: TeamState, gws: Sequence[int]) -> list[dict]:
    picks = sol["picks"]
    stats = sol["statistics"]
    et = {pid: p.element_type for pid, p in inputs.players.items()}
    order = {t: i for i, t in enumerate(inputs.rules.squad_select)}
    real = list(state.squad)  # the squad a Free Hit reverts to
    steps = []
    for gw in gws:
        wk = picks[picks["week"] == gw]
        chip_code = stats[gw].get("chip")
        chip = CHIP_NAMES.get(chip_code) if chip_code else None
        squad = [int(x) for x in wk[wk["squad"] == 1]["id"]]
        if chip == "freehit":
            outs, ins = [p for p in real if p not in squad], [p for p in squad if p not in real]
        else:
            outs = [int(x) for x in wk[wk["transfer_out"] == 1]["id"]]
            ins = [int(x) for x in wk[wk["transfer_in"] == 1]["id"]]
        key = lambda p: (order[et[p]], -inputs.players[p].now_cost, p)  # noqa: E731
        transfers = [{"out": o, "in": i} for o, i in zip(sorted(outs, key=key), sorted(ins, key=key))]
        xp = {p: proj.xp[p][gw] for p in squad}
        captain = int(wk[wk["captain"] == 1]["id"].iloc[0])
        vice = int(wk[wk["vicecaptain"] == 1]["id"].iloc[0])
        if chip == "bboost":
            xi, bench = best_xi(squad, xp, et, inputs.rules)  # all 15 score; the XI/bench split is nominal
            for role in (captain, vice):
                if role not in xi:
                    out = min((p for p in xi if et[p] == et[role] and p not in (captain, vice)), key=lambda p: xp[p])
                    xi[xi.index(out)] = role
                    bench[bench.index(role)] = out
            gk = next(t for t, n in inputs.rules.positions.items() if n == "GKP")
            bench.sort(key=lambda p: (et[p] != gk, -xp[p], p))
            points = sum(xp.values()) + xp[captain]
        else:
            xi = sorted((int(x) for x in wk[wk["lineup"] == 1]["id"]), key=lambda p: (order[et[p]], -xp[p], p))
            bench = [int(x) for x in wk[wk["bench"] >= 0].sort_values("bench")["id"]]
            points = sum(xp[p] for p in xi) + xp[captain] * (2 if chip == "3xc" else 1)
        hits = int(round(stats[gw].get("pt", 0)))
        steps.append({
            "gw": gw, "transfers": transfers, "chip": chip, "xi": xi, "bench": bench, "captain": captain, "vice_captain": vice,
            "hits": hits, "hit_cost": hits * inputs.rules.hit_cost, "free_transfers": int(round(stats[gw].get("ft", 0))),
            "bank": int(round(stats[gw].get("itb", 0) * 10)), "expected_points": round(points, 2),
        })
        if chip != "freehit":
            real = squad
    return steps


def solve(
    inputs: ModelInputs, proj: Projection, state: TeamState, *, horizon: int = HORIZON, time_limit: float = TIME_LIMIT_S,
    alternatives: int = 1, chip: tuple[str, int] | None = None, prefs: Mapping | None = None, threads: int | None = None,
    alt_time_limit: float | None = None, decay: float = DECAY, hit_cost: int = 4, only: Sequence[int] | None = None,
    deadline: float | None = None,
) -> list[Plan]:
    """Solve the plan, plus `alternatives - 1` next-best plans that differ in this GW's transfers.
    `deadline` (a `time.perf_counter()` value) caps the time limits so every run ends by then.

    Returns at least one Plan: the solver's best incumbent with its gap, or the hold plan if HiGHS
    found nothing feasible in time. Later alternatives that find nothing are dropped.
    """
    solver, highspy = _load_solver()
    gws = proj.gws[:horizon]
    prefs = prefs or {}
    threads = threads or default_threads()
    data = build_solver_data(inputs, proj, state, len(gws), keep=prefs.get("keep_ids", ()), only=only)
    opts = solver_options(len(gws), alternatives=alternatives, chip=chip, prefs=prefs, decay=decay, hit_cost=hit_cost)
    limits = [time_limit] + [alt_time_limit if alt_time_limit is not None else time_limit] * max(alternatives - 1, 0)
    start = None
    if chip is None:
        hold = hold_plan(inputs, proj, state, SolveInfo("", None, 0.0, time_limit, None, False), len(gws))
        start = _hold_start(hold, state, list(data["merged_data"].index), 5)
    rec = _Recorder(highspy, limits, threads, start, deadline)
    saved, solutions, error = solver.highspy, [], None
    solver.highspy = rec
    try:
        with contextlib.redirect_stdout(io.StringIO()):  # the solver prints its licence note and settings
            try:
                solutions = solver.solve_multi_period_fpl(data, opts)
            except Exception as e:  # noqa: BLE001  an infeasible or empty solution fails inside its reporting code
                error = e
    finally:
        solver.highspy = saved

    plans: list[Plan] = []
    for i, run in enumerate(rec.runs):
        timed_out = run["status"] != "Optimal"
        info = SolveInfo(run["status"], run["gap"], run["time_s"], run["limit"], run["objective"], timed_out, pool=len(data["merged_data"]))
        if not run["feasible"] or i >= len(solutions):
            if i == 0:
                plan = hold_plan(inputs, proj, state, info, len(gws))
                if run["status"] != "Time limit reached" or run["feasible"]:
                    plan.warnings = [f"The solver returned no plan ({run['status']}{f': {error}' if error else ''}): holding (no transfers)."]
                plan.info.timed_out = True
                plans.append(plan)
            break
        plan = Plan(_steps_from_solution(solutions[i], inputs, proj, state, gws), run["objective"], info)
        if timed_out:
            plan.warnings.append(f"The solver stopped at its {run['limit']:.0f} s limit with a gap of {100 * (run['gap'] or 0):.2f}%: this is the best plan found, not a proven optimum.")
        plans.append(plan)
    if not plans:
        info = SolveInfo("Error", None, 0.0, time_limit, None, True, pool=len(data["merged_data"]))
        plan = hold_plan(inputs, proj, state, info, len(gws))
        plan.warnings = [f"The solver failed ({error}): holding (no transfers)."]
        plans.append(plan)
    return plans


# ---------------------------------------------------------------------------------------------------
# Chip scenarios


def chip_candidates(inputs: ModelInputs, proj: Projection, base: Plan, chips_used: Sequence[Mapping], *, save: Sequence[str] = (), per_chip: int = 1) -> tuple[list[tuple[str, int]], list[dict]]:
    """Which (chip, GW) scenarios to solve, and the chips that get none, with the reason.

    A chip is a candidate in the GWs where the rules allow it (window open, not used, one per GW).
    Among those, the GWs are ranked with the chip-free plan: Triple Captain by the captain's xP,
    Bench Boost by the bench's xP, Free Hit by blanks and doubles then by XI xP, Wildcard earliest.
    """
    rules = inputs.rules
    todo, skipped = [], []
    steps = {s["gw"]: s for s in base.steps}
    team_ids = list(inputs.team_names)
    for name in dict.fromkeys(c.name for c in rules.chips):
        if name in save:
            skipped.append({"chip": name, "reason": "saved by preference"})
            continue
        gws = [gw for gw in steps if not R.chip_violations([name], gw, rules, chips_used)]
        if not gws:
            skipped.append({"chip": name, "reason": "not available in the next GWs (already used, or outside its window)"})
            continue

        def score(gw: int) -> float:
            s = steps[gw]
            if name == "3xc":
                return proj.xp[s["captain"]][gw]
            if name == "bboost":
                return sum(proj.xp[p][gw] for p in s["bench"])
            if name == "freehit":
                bd = R.blanks_and_doubles(inputs.fixtures, gw, team_ids)
                return 100.0 * (len(bd["blank"]) + len(bd["double"])) - s["expected_points"]
            return -gw  # wildcard: the earlier, the more GWs it improves

        for gw in sorted(gws, key=lambda g: (-score(g), g))[:per_chip]:
            todo.append((name, gw))
    return todo, skipped


def chip_scenarios(
    inputs: ModelInputs, proj: Projection, state: TeamState, base: Plan, chips_used: Sequence[Mapping], *, horizon: int = HORIZON,
    budget_s: float = 20.0, save: Sequence[str] = (), per_chip: int = 1, prefs: Mapping | None = None, threads: int | None = None,
) -> list[dict]:
    """Fixed-chip solves: for each candidate (chip, GW), re-solve with the chip forced in that GW and
    report the change in the decayed objective and in that GW's expected points against `base`."""
    todo, skipped = chip_candidates(inputs, proj, base, chips_used, save=save, per_chip=per_chip)
    out = [{"chip": s["chip"], "gw": None, "evaluated": False, "reason": s["reason"]} for s in skipped]
    base_points = {s["gw"]: s["expected_points"] - s["hit_cost"] for s in base.steps}
    base_players = sorted({p for s in base.steps for p in s["xi"] + s["bench"]} | set(state.squad))
    todo.sort(key=lambda c: c[0] not in ("bboost", "3xc"))  # the cheap scenarios first
    t_end = time.perf_counter() + budget_s
    for n, (name, gw) in enumerate(todo):
        remaining = t_end - time.perf_counter()
        share = remaining / (len(todo) - n)
        if share < 0.5 or base.objective is None:
            reason = "time budget exhausted" if base.objective is not None else "no solved base plan to compare with"
            out.append({"chip": name, "gw": gw, "evaluated": False, "reason": reason})
            continue
        # Bench Boost and Triple Captain add no new players, so they re-solve over the players of the
        # chip-free plan (lineups, captaincy, transfer timing): fast, and a lower bound on the chip's value.
        only = base_players if name in ("bboost", "3xc") else None
        plan = solve(inputs, proj, state, horizon=horizon, time_limit=share, chip=(name, gw), prefs=prefs, threads=threads, only=only)[0]
        if plan.fallback or plan.objective is None:
            out.append({"chip": name, "gw": gw, "evaluated": False, "reason": f"no plan found in {share:.1f} s", "solver": plan.info.as_dict()})
            continue
        step = next(s for s in plan.steps if s["gw"] == gw)
        total = sum(s["expected_points"] - s["hit_cost"] for s in plan.steps) - sum(base_points.values())
        out.append({
            "chip": name, "gw": gw, "evaluated": True,
            "delta_objective": round(plan.objective - base.objective, 2),
            "delta_xp_gw": round(step["expected_points"] - step["hit_cost"] - base_points[gw], 2),
            "delta_xp_horizon": round(total, 2),
            "transfers": len(step["transfers"]), "pool": "base plan players" if only is not None else "full", "solver": plan.info.as_dict(),
        })
    return out


# ---------------------------------------------------------------------------------------------------
# Confidence (ARCHITECTURE §2.4): computed by rules, never asserted


def confidence(plans: Sequence[Plan], proj: Projection, *, stale: bool) -> dict:
    best = plans[0]
    step = best.steps[0]
    gw = step["gw"]
    drivers: list[str] = []
    margin = None
    if len(plans) > 1 and best.objective is not None and plans[1].objective is not None:
        margin = best.objective - plans[1].objective
        drivers.append(f"top-2 plan gap {margin:.1f} xP")
    low_start = [p for p in step["xi"] if proj.p_start[p][gw] < 0.7]
    recommended = [t["in"] for t in step["transfers"]] + [step["captain"]]
    risky = [p for p in recommended if proj.p_start[p][gw] < 0.7]
    shaky = [p for p in step["xi"] if proj.p_start[p][gw] < 0.85]
    level = "medium"
    if margin is not None and margin >= 2.0 and not shaky and not stale:
        level = "high"
    if stale:
        level = "low"
        drivers.append("the snapshot is stale")
    if margin is not None and margin < 0.5:
        level = "low"
    if risky:
        level = "low"
        drivers.append(f"{len(risky)} recommended player(s) with P(start) < 0.7")
    if best.fallback:
        level = "low"
        drivers.append("no solver plan: holding")
    if shaky:
        drivers.append(f"minutes uncertainty: {len(shaky)} of the XI with P(start) < 0.85 ({len(low_start)} below 0.7)")
    if best.info.timed_out and not best.fallback:
        if level == "high":
            level = "medium"
        drivers.append(f"solver stopped at its time limit (gap {100 * (best.info.gap or 0):.2f}%)")
    elif level == "high" and any(p.info.timed_out for p in plans[1:2]):
        level = "medium"
        drivers.append("the next-best plan wasn't solved to optimality, so the margin may be overstated")
    return {"overall": level, "drivers": drivers, "margin": None if margin is None else round(margin, 2)}
