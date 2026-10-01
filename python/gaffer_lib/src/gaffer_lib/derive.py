"""Derived team state from public entry endpoints (ADR 0002, ADR 0003): the squad the next GW starts
from, purchase and selling prices, bank, free transfers, chips remaining, and blank/double GWs.

Neither free transfers nor selling prices are public, so both are derived here and marked as such:
- Free transfers replay `history.current` from the entry's first GW with `rules.next_free_transfers`.
  Wildcard and Free Hit weeks report `event_transfers` 0 (observed), and keep the FT count anyway.
  Every week with a hit re-anchors the count (hits = transfers - FT), and a mismatch is reported.
- A purchase price is the `element_in_cost` of the latest transfer that brought the player in,
  ignoring Free Hit weeks (the squad reverts). Players held since the entry's first GW were bought
  at the season-start price (`now_cost - cost_change_start`) if the entry started in GW1.

The user can override the FT count and declare pending transfers, which are invisible publicly
(FR-INP-04): `ft_source` then says "user", and pending transfers are applied to the returned state.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Mapping, Sequence

from . import __version__, rules as R
from .snapshot import Snapshot

SCHEMA = "gaffer.derived/1"


class DeriveError(ValueError):
    """Bad user input (an unknown player in --pending, an out-of-range --ft)."""


def _events(b: Mapping) -> tuple[dict | None, dict | None]:
    cur = next((e for e in b["events"] if e.get("is_current")), None)
    nxt = next((e for e in b["events"] if e.get("is_next")), None)
    return cur, nxt


def derive_free_transfers(rows: Sequence[Mapping], chips_used: Sequence[Mapping], rules: R.Rules) -> dict:
    """Replay the entry's GWs. `rows` is `history.current`, `chips_used` is `history.chips`.

    Returns the FT count for the GW after the last row, a per-GW trace, and any inconsistencies.
    """
    rows = sorted(rows, key=lambda r: r["event"])
    if not rows:
        return {"value": None, "unlimited": True, "confidence": "high", "trace": [], "issues": []}
    chip_at = {c["event"]: c["name"] for c in chips_used}
    trace, issues = [], []
    # The first GW's squad is picked with unlimited free changes; the next GW starts with 1 FT.
    first = rows[0]["event"]
    trace.append({"gw": first, "ft": None, "transfers": rows[0]["event_transfers"], "chip": chip_at.get(first), "hits": 0, "ft_next": 1})
    ft, prev = 1, first
    for r in rows[1:]:
        gw = r["event"]
        for missing in range(prev + 1, gw):  # a GW with no row: no transfers were made
            nxt = R.next_free_transfers(ft, 0, None, rules)
            trace.append({"gw": missing, "ft": ft, "transfers": 0, "chip": None, "hits": 0, "ft_next": nxt, "note": "no history row"})
            ft = nxt
        chip = chip_at.get(gw)
        transfers, cost = r["event_transfers"], r["event_transfers_cost"]
        expected = R.hit_cost(ft, transfers, chip, rules)
        if cost != expected:
            if chip not in R.TRANSFER_CHIPS and cost > 0 and cost % rules.hit_cost == 0:
                implied = transfers - cost // rules.hit_cost
                issues.append(f"GW{gw}: {transfers} transfers cost {cost} points, so {implied} FT were available; the replay had {ft}. Re-anchored.")
                ft = implied
            elif cost == 0 and chip not in R.TRANSFER_CHIPS:
                issues.append(f"GW{gw}: {transfers} transfers cost no points, so at least {transfers} FT were available; the replay had {ft}. Re-anchored.")
                ft = transfers
            else:
                issues.append(f"GW{gw}: transfer cost {cost} doesn't match {transfers} transfers with {ft} FT (chip {chip}).")
        nxt = R.next_free_transfers(ft, transfers, chip, rules)
        trace.append({"gw": gw, "ft": ft, "transfers": transfers, "chip": chip, "hits": R.hits(ft, transfers, chip, rules), "ft_next": nxt})
        ft, prev = nxt, gw
    return {"value": ft, "unlimited": False, "confidence": "high" if not issues else "medium", "trace": trace, "issues": issues}


def purchase_prices(squad: Sequence[int], transfers: Sequence[Mapping], *, basis_gw: int, fh_events: set[int], started_event: int, elements: Mapping[int, Mapping], snap: Snapshot | None = None) -> dict[int, dict]:
    """Purchase price (tenths) and its source for each squad player."""
    relevant = sorted((t for t in transfers if t["event"] <= basis_gw and t["event"] not in fh_events), key=lambda t: (t["event"], t.get("time", "")))
    bought: dict[int, Mapping] = {}
    for t in relevant:
        bought[t["element_in"]] = t
    out = {}
    for el in squad:
        e = elements[el]
        if el in bought:
            t = bought[el]
            out[el] = {"price": t["element_in_cost"], "source": "transfer", "gw": t["event"]}
        elif started_event <= 1:
            out[el] = {"price": e["now_cost"] - e.get("cost_change_start", 0), "source": "season_start", "gw": started_event}
        else:
            price = None
            summary = snap.element_summary(el) if snap else None
            if summary:
                row = next((h for h in summary.get("history", []) if h.get("round") == started_event), None)
                price = row and row.get("value")
            out[el] = {"price": price, "source": "joined_late" if price is not None else "unknown", "gw": started_event}
    return out


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    return re.sub(r"\s+", " ", "".join(c for c in s if not unicodedata.combining(c))).strip().casefold()


def resolve_player(token: str, elements: Mapping[int, Mapping], teams: Mapping[int, str], among: Sequence[int] | None = None) -> int:
    """A player id from an id or a name (web_name, or first + second name), optionally limited to `among`."""
    token = token.strip()
    if re.fullmatch(r"\d+", token):
        el = int(token)
        if el not in elements:
            raise DeriveError(f"unknown player id {el}")
        return el
    pool = [elements[i] for i in (among if among is not None else elements)]
    want = _norm(token)
    for key in (lambda e: e["web_name"], lambda e: f"{e.get('first_name', '')} {e.get('second_name', '')}", lambda e: e.get("second_name", "")):
        hits = [e for e in pool if _norm(key(e)) == want]
        if len(hits) == 1:
            return hits[0]["id"]
        if len(hits) > 1:
            opts = ", ".join(f"{e['web_name']} ({teams.get(e['team'], '?')}) = {e['id']}" for e in hits)
            raise DeriveError(f"{token!r} is ambiguous: {opts}. Use the player id.")
    where = " in the squad" if among is not None else ""
    raise DeriveError(f"no player called {token!r}{where}. Use the player id.")


def parse_pending(spec: str | Sequence | None, elements: Mapping[int, Mapping], teams: Mapping[int, str], squad: Sequence[int]) -> list[tuple[int, int]]:
    """`"Salah>Palmer, 381>12"` (or [[out, in], ...]) → [(out_id, in_id)], resolving names."""
    if not spec:
        return []
    pairs = [p.split(">") for p in re.split(r"[,;]", spec) if p.strip()] if isinstance(spec, str) else [list(map(str, p)) for p in spec]
    out, current = [], list(squad)
    for p in pairs:
        if len(p) != 2:
            raise DeriveError(f"pending transfer {'>'.join(p)!r} should look like OUT>IN, e.g. Salah>Palmer")
        o = resolve_player(p[0], elements, teams, among=current)
        i = resolve_player(p[1], elements, teams)
        out.append((o, i))
        current = [i if x == o else x for x in current]
    return out


def derive(snap: Snapshot, *, ft: int | None = None, pending: str | Sequence | None = None) -> dict:
    b = snap.bootstrap
    rules = R.Rules.from_bootstrap(b)
    elements = {e["id"]: e for e in b["elements"]}
    teams = {t["id"]: t["short_name"] for t in b["teams"]}
    cur, nxt = _events(b)
    next_gw = nxt["id"] if nxt else None
    warnings: list[str] = []

    entry, history, picks = snap.entry or {}, snap.history or {"current": [], "chips": []}, snap.picks
    chips_used = history.get("chips", [])
    fh_events = {c["event"] for c in chips_used if c["name"] == "freehit"}
    basis = picks
    if picks and picks.get("active_chip") == "freehit":
        basis = snap.picks_prev
        warnings.append(f"Free Hit was played in GW{picks['entry_history']['event']}: the squad and bank revert to GW{basis['entry_history']['event'] if basis else '?'}.")
        if basis is None:
            warnings.append("The pre-Free Hit picks are missing from the snapshot; squad and bank are unknown.")
    basis_gw = basis["entry_history"]["event"] if basis else None
    squad = [p["element"] for p in sorted(basis["picks"], key=lambda p: p["position"])] if basis else []
    bank = basis["entry_history"]["bank"] if basis else None
    started = entry.get("started_event") or (history["current"][0]["event"] if history.get("current") else 1)

    # Free transfers
    fts = derive_free_transfers(history.get("current", []), chips_used, rules)
    warnings += fts["issues"]
    if cur and history.get("current") and history["current"][-1]["event"] != cur["id"]:
        warnings.append(f"History ends at GW{history['current'][-1]['event']} but GW{cur['id']} is current; the FT count may be behind.")
    if ft is not None:
        if not 0 <= ft <= rules.max_free_transfers:
            raise DeriveError(f"--ft must be between 0 and {rules.max_free_transfers}, got {ft}")
        free = {"value": ft, "source": "user", "derived": fts["value"], "confidence": "high", "trace": fts["trace"]}
        if fts["value"] is not None and fts["value"] != ft:
            warnings.append(f"You set {ft} free transfers; Gaffer derived {fts['value']} from public data. Using yours.")
    else:
        free = {"value": fts["value"], "source": "derived", "derived": fts["value"], "confidence": fts["confidence"], "trace": fts["trace"]}
        if fts["unlimited"]:
            free["unlimited"] = True

    # Squad, purchase and selling prices
    prices = purchase_prices(squad, snap.transfers, basis_gw=basis_gw or 0, fh_events=fh_events, started_event=started, elements=elements, snap=snap)
    later = [t for t in snap.transfers if basis_gw is not None and t["event"] > basis_gw and t["event"] not in fh_events]
    if later:
        warnings.append(f"{len(later)} transfer(s) after GW{basis_gw} are already listed publicly; they aren't applied.")
    unknown = [elements[e]["web_name"] for e, p in prices.items() if p["price"] is None]
    if unknown:
        warnings.append(f"Purchase price unknown for {', '.join(unknown)} (team joined in GW{started}); selling price assumed = current price.")
    pos_names = rules.positions
    players = []
    for i, el in enumerate(squad):
        e = elements[el]
        p = prices[el]
        sell = R.selling_price(p["price"], e["now_cost"], rules) if p["price"] is not None else e["now_cost"]
        pick = next(x for x in basis["picks"] if x["element"] == el)
        players.append({
            "id": el, "name": e["web_name"], "team": teams.get(e["team"], "?"), "position": pos_names[e["element_type"]],
            "pick_position": pick["position"], "is_captain": pick["is_captain"], "is_vice_captain": pick["is_vice_captain"],
            "now_cost": e["now_cost"], "purchase_price": p["price"], "purchase_source": p["source"], "purchase_gw": p["gw"], "selling_price": sell,
        })
    selling_value = sum(p["selling_price"] for p in players)

    # Pending transfers (FR-INP-04), applied on top of the public state.
    pend = parse_pending(pending, elements, teams, squad)
    pending_out = None
    if pend:
        sell_of = {p["id"]: p["selling_price"] for p in players}
        new_squad, bank_after, errors = list(squad), bank or 0, []
        for o, i in pend:
            if o not in new_squad:
                errors.append(R.Violation("TRANSFER_OUT_NOT_IN_SQUAD", f"{elements[o]['web_name']} isn't in the squad"))
                continue
            if i in new_squad:
                errors.append(R.Violation("TRANSFER_IN_ALREADY_IN_SQUAD", f"{elements[i]['web_name']} is already in the squad"))
                continue
            bank_after += sell_of.get(o, elements[o]["now_cost"]) - elements[i]["now_cost"]
            sell_of[i] = elements[i]["now_cost"]
            new_squad = [i if x == o else x for x in new_squad]
        pl = {e: R.Player(e, elements[e]["team"], elements[e]["element_type"]) for e in new_squad}
        errors += R.check_squad(new_squad, pl, rules)
        if bank_after < 0:
            errors.append(R.Violation("OVER_BUDGET", f"the pending transfers leave the bank at £{bank_after / 10:.1f}m"))
        n = len(pend)
        avail = free["value"]
        pending_out = {
            "transfers": [{"out": o, "out_name": elements[o]["web_name"], "in": i, "in_name": elements[i]["web_name"], "in_price": elements[i]["now_cost"]} for o, i in pend],
            "count": n,
            "hits": R.hits(avail, n, None, rules) if avail is not None else 0,
            "hit_cost": R.hit_cost(avail, n, None, rules) if avail is not None else 0,
            "ft_remaining": max(avail - n, 0) if avail is not None else None,
            "squad_after": new_squad,
            "bank_after": bank_after,
            "violations": [v.as_dict() for v in errors],
        }
        if errors:
            warnings.append("Pending transfers are not legal: " + "; ".join(v.message for v in errors))

    # Chips and fixture flags
    chips = [c.as_dict() for c in R.chip_status(rules, chips_used, next_gw)]
    flags = {}
    if next_gw:
        for gw in range(next_gw, min(next_gw + 6, 39)):
            bd = R.blanks_and_doubles(snap.fixtures, gw, teams)
            if bd["blank"] or bd["double"]:
                flags[str(gw)] = {k: [teams[t] for t in v] for k, v in bd.items()}

    return {
        "schema": SCHEMA,
        "gaffer_lib_version": __version__,
        "snapshot_id": snap.id,
        "gw": {"current": cur["id"] if cur else None, "next": next_gw, "deadline": nxt["deadline_time"] if nxt else None},
        "team_name": entry.get("name"),
        "started_event": started,
        "squad_basis_gw": basis_gw,
        "bank": bank,
        "squad_value": sum(p["now_cost"] for p in players),
        "selling_value": selling_value,
        "budget": (bank or 0) + selling_value,
        "squad": players,
        "free_transfers": free,
        "pending": pending_out,
        "chips": chips,
        "blanks_doubles": flags,
        "assumptions": {
            "free_transfers": free["value"],
            "ft_source": free["source"],
            "pending_transfers": [[o, i] for o, i in pend],
        },
        "warnings": warnings,
    }
