import csv
import gzip
import json
from pathlib import Path

DATA = Path(__file__).parent / "data"


def load_json(name):
    path = DATA / name
    opener = gzip.open if name.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as f:
        return json.load(f)


def load_jsonl_gz(name):
    with gzip.open(DATA / name, "rt", encoding="utf-8") as f:
        return [json.loads(line) for line in f]


def load_csv_gz(name):
    with gzip.open(DATA / name, "rt", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def real_bootstrap_rules_part():
    """The rules-relevant part of the live 2026/27 bootstrap (element_types, settings, chips)."""
    cfg = load_json("scoring-2026-27.json")
    return {
        "element_types": [dict(t, sub_positions_locked=[12] if t["id"] == 1 else []) for t in cfg["element_types"]],
        "game_settings": {
            "squad_squadsize": 15, "squad_squadplay": 11, "squad_team_limit": 3, "squad_total_spend": 1000,
            "transfers_sell_on_fee": 0.5, "max_extra_free_transfers": 4,
        },
        # bootstrap.chips as served on 2026-09-29 (research 04 §0).
        "chips": [
            {"name": n, "start_event": a, "stop_event": b, "chip_type": t}
            for n, a, b, t in [
                ("wildcard", 2, 19, "transfer"), ("wildcard", 20, 38, "transfer"), ("freehit", 2, 19, "transfer"),
                ("bboost", 1, 19, "team"), ("3xc", 1, 19, "team"), ("freehit", 20, 38, "transfer"),
                ("bboost", 20, 38, "team"), ("3xc", 20, 38, "team"),
            ]
        ],
        "game_config": {"scoring": cfg["scoring"]},
    }
