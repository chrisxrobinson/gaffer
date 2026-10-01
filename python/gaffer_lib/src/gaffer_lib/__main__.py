"""python -m gaffer_lib <command>.

  derive   --snapshot DIR [--ft N] [--pending "OUT>IN,..."]
  validate --snapshot DIR --proposal FILE|- [--ft N] [--pending "OUT>IN,..."]
  run      --snapshot DIR [--prefs FILE] [--out FILE] [--ft N] [--pending ...] [--time-limit S] [--budget S] [--no-chips] [--json]
  backtest --seasons 2023-24,2024-25,2025-26 [--data DIR] [--policies B0,B1,B2,G0] [--out FILE]

derive and validate print one JSON document on stdout. run writes the full plan JSON to --out and
prints a compact summary (the JSON itself with --json). backtest prints season points per policy.

Exit status: 0 ok (validate: valid; run: the best plan passes validate), 1 rule violations,
2 bad input or data.
"""

from __future__ import annotations

import argparse
import json
import sys

from .derive import DeriveError, derive
from .snapshot import Snapshot
from .validate import validate


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m gaffer_lib")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("derive", "validate", "run"):
        p = sub.add_parser(name)
        p.add_argument("--snapshot", required=True, help="snapshot directory written by fpl_snapshot")
        p.add_argument("--ft", type=int, help="free transfers, overriding the derived count")
        p.add_argument("--pending", help='transfers already made for the next GW, e.g. "Salah>Palmer,381>12"')
        if name == "validate":
            p.add_argument("--proposal", required=True, help="proposal JSON file, or - for stdin")
        if name == "run":
            p.add_argument("--prefs", help="preferences JSON (keep, avoid, save_chips, max_hits_per_gw, xmins_overrides)")
            p.add_argument("--out", help="where to write the full plan JSON, e.g. /work/plan.json")
            p.add_argument("--time-limit", type=float, default=None, help="solver time limit in seconds (default 45)")
            p.add_argument("--budget", type=float, default=None, help="time budget for the whole run in seconds (default 50)")
            p.add_argument("--no-chips", action="store_true", help="skip the chip scenario solves")
            p.add_argument("--json", action="store_true", help="print the plan JSON instead of the summary")
    bt = sub.add_parser("backtest")
    bt.add_argument("--seasons", required=True, help="comma-separated, e.g. 2023-24,2024-25,2025-26")
    bt.add_argument("--data", default="var/history", help="directory filled by tools/fetch_history.py")
    bt.add_argument("--policies", default="B0,B1,B2,G0")
    bt.add_argument("--out", help="write the full result JSON here")
    bt.add_argument("--time-limit", type=float, default=None, help="solver time limit per GW for G0 (default 45)")
    args = ap.parse_args(argv)
    if args.cmd == "backtest":
        from .backtest import main as backtest_main  # noqa: PLC0415

        return backtest_main(args)
    try:
        snap = Snapshot(args.snapshot)
        if args.cmd == "derive":
            out, code = derive(snap, ft=args.ft, pending=args.pending), 0
        elif args.cmd == "validate":
            text = sys.stdin.read() if args.proposal == "-" else open(args.proposal, encoding="utf-8").read()
            out = validate(snap, json.loads(text), ft=args.ft, pending=args.pending)
            code = 0 if out["valid"] else 1
        else:
            from . import cli, plan  # noqa: PLC0415

            kw = {}
            if args.time_limit is not None:
                kw["time_limit"] = args.time_limit
            if args.budget is not None:
                kw["budget"] = args.budget
            try:
                out = cli.golden_path(snap, cli.load_prefs(args.prefs), ft=args.ft, pending=args.pending, chips=not args.no_chips, **kw)
            except plan.SolverUnavailable as e:
                raise DeriveError(str(e)) from e
            code = 0 if out["plans"][0]["validation"]["valid"] else 1
            if args.out:
                with open(args.out, "w", encoding="utf-8") as f:
                    json.dump(out, f, ensure_ascii=False)
            if not args.json:
                print(cli.render_summary(out, args.out))
                return code
    except (DeriveError, FileNotFoundError, json.JSONDecodeError, KeyError, ValueError) as e:
        json.dump({"error": f"{type(e).__name__}: {e}"}, sys.stdout)
        sys.stdout.write("\n")
        return 2
    json.dump(out, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return code


if __name__ == "__main__":
    sys.exit(main())
