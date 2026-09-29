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
