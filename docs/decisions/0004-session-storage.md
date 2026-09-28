# ADR 0004 — Session and recommendation storage: Pi's JSONL session files are the system of record

**Status:** Accepted · **Date:** 2026-09-27

## Context
Gaffer needs four things stored:
- an audit trail of each run, showing what data was seen, what code ran and what was advised
- persisted recommendations, so they can be scored later against actual points
- per-user preferences
- enough usage data for the admin centre

Pi already writes an append-only JSONL session per conversation. Each entry is a tree node (`id`/`parentId`). Every assistant message records provider, model, token usage and cost. Extensions can add `custom` entries with `pi.appendEntry(customType, data)` that stay out of model context ([research 01 §5](../research/01-pi-internals.md), and [spike S1](../../spikes/s1-extension-hooks/README.md) check 7). Managed Agents treats the session as a durable append-only log that lives outside the context window ([research 02](../research/02-harness-patterns.md)).

## Options considered
1. **A parallel store** (Postgres or SQLite tables for runs, recommendations and usage). Queries are easy, but it duplicates what Pi already writes and the two can drift. Rejected for MVP.
2. **Pi JSONL only, with Gaffer data as `custom` entries, plus small derived files.** **Chosen.**
3. **An event-sourced external log** (Kafka and similar). Far too much for one user and a few runs per GW.

## Decision
- **System of record:** Pi session files under `/sessions` (`--session-dir`), one file per conversation, on a Docker volume (locally) or EFS (on AWS, synced to S3 nightly).
- **Gaffer entries** (`customType` values):
  - `gaffer.snapshot`: snapshot path, content hash, freshness and the `stale` flag
  - `gaffer.recommendation`: the full validated JSON ([ARCHITECTURE §2.4](../ARCHITECTURE.md)), with `rec_id` (ULID), `team_id_hash`, `gw` and `model`
  - `gaffer.validation`: validator verdict and errors, including failed attempts
  - `gaffer.budget`: running cost and whether the cap was hit
- **Derived, rebuildable files** (not a second source of truth):
  - `/data/ledger/recommendations.jsonl`: an index that makes scoring easy. It is appended at the same time as the custom entry and can be rebuilt by scanning the sessions.
  - `/data/ledger/outcomes.jsonl`: written by the evaluator after `data_checked`. It holds realised points of the recommended moves and of the user's actual moves, plus baselines. This is new information, not a copy.
  - `/data/users/<team_id_hash>/prefs.json`: preferences owned by the harness. They have to outlive sessions, and the sandbox is ephemeral.
- The **admin centre reads these files**. It adds no parallel store ([ARCHITECTURE §9](../ARCHITECTURE.md)).
- **Privacy:** team IDs are stored as `HMAC-SHA256(team_id, GAFFER_ID_SALT)` in ledger and user paths. The raw ID only appears in session transcripts, and those stay on the private volume.

## Consequences
- Queries across sessions are file scans. That is fine at single-user scale (hundreds of sessions per season). In the multi-user phase, a tailer loads the JSONL into Postgres for querying, and JSONL stays the source of record ([ROADMAP phase 3](../ROADMAP.md)).
- Cost figures come from Pi's `calculateCost` and the model catalogue's prices. When Pi's catalogue is behind a provider's price change, both the admin figures and the budget checks inherit the error. There is a mitigation for this in [ADR 0008](0008-model-and-budget.md).
- Session files contain whatever the model saw, including FPL manager names. They are treated as personal data (NFR-PRIV).
