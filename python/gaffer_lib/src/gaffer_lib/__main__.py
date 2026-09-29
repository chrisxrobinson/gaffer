"""python -m gaffer_lib <command>. Prints one JSON document on stdout.

  derive   --snapshot DIR [--ft N] [--pending "OUT>IN,..."]
  validate --snapshot DIR --proposal FILE|- [--ft N] [--pending "OUT>IN,..."]

Exit status: 0 ok (validate: valid), 1 validate found rule violations, 2 bad input or data.
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
    for name in ("derive", "validate"):
        p = sub.add_parser(name)
        p.add_argument("--snapshot", required=True, help="snapshot directory written by fpl_snapshot")
        p.add_argument("--ft", type=int, help="free transfers, overriding the derived count")
        p.add_argument("--pending", help='transfers already made for the next GW, e.g. "Salah>Palmer,381>12"')
        if name == "validate":
            p.add_argument("--proposal", required=True, help="proposal JSON file, or - for stdin")
    args = ap.parse_args(argv)
    try:
        snap = Snapshot(args.snapshot)
        if args.cmd == "derive":
            out, code = derive(snap, ft=args.ft, pending=args.pending), 0
        else:
            text = sys.stdin.read() if args.proposal == "-" else open(args.proposal, encoding="utf-8").read()
            out = validate(snap, json.loads(text), ft=args.ft, pending=args.pending)
            code = 0 if out["valid"] else 1
    except (DeriveError, FileNotFoundError, json.JSONDecodeError, KeyError) as e:
        json.dump({"error": f"{type(e).__name__}: {e}"}, sys.stdout)
        sys.stdout.write("\n")
        return 2
    json.dump(out, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return code


if __name__ == "__main__":
    sys.exit(main())
