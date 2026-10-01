"""Read an immutable fpl_snapshot directory (ADR 0002): one `<name>.json` per upstream response."""

from __future__ import annotations

import json
from pathlib import Path


class Snapshot:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        if not (self.path / "bootstrap-static.json").is_file():
            raise FileNotFoundError(f"not a Gaffer snapshot (no bootstrap-static.json): {self.path}")
        self._cache: dict[str, object] = {}

    def load(self, name: str, default=None):
        if name not in self._cache:
            p = self.path / f"{name}.json"
            self._cache[name] = json.loads(p.read_text("utf-8")) if p.is_file() else default
        return self._cache[name]

    @property
    def id(self) -> str:
        m = self.load("manifest") or {}
        return m.get("id") or self.path.name

    @property
    def bootstrap(self) -> dict:
        return self.load("bootstrap-static")

    @property
    def fixtures(self) -> list:
        return self.load("fixtures", [])

    @property
    def entry(self) -> dict | None:
        return self.load("entry")

    @property
    def history(self) -> dict | None:
        return self.load("history")

    @property
    def transfers(self) -> list:
        return self.load("transfers", [])

    @property
    def picks(self) -> dict | None:
        return self.load("picks")

    @property
    def picks_prev(self) -> dict | None:
        return self.load("picks-prev")

    def element_summary(self, element: int) -> dict | None:
        return self.load(f"element-summary-{element}")
