# ADR 0019 — Scheduler: host systemd timers calling job scripts kept in the repo

**Status:** Proposed (Phase 2 plan, for your review) · **Date:** 2026-10-23 · **Settles:** the open M3 and M5 question of what runs `gaffer-eval` and FR-DAT-10's pre-deadline snapshot · **Evidence:** [research 16](../research/16-operations.md) · **Requirements:** FR-EVL-03, FR-DAT-10, NFR-REL-04

## Context
- **Nothing scheduled exists yet:** since M3 and M5, nothing has run `gaffer-eval` after a GW is data-checked (it has been run by hand: GW7 on 2026-10-23), and nothing takes a pre-deadline snapshot in a week when Gaffer isn't opened (FR-DAT-10).
- **Both jobs are idempotent** (`gaffer-eval` does nothing until FPL marks a GW data-checked), so a job can run often and catch up after downtime.
- **Phase 2 has an always-on host,** and Phase 1's exit (three consecutive scored GWs) depends on scoring actually happening.

## Options considered
1. **systemd timers on the host, calling scripts in `deploy/compose/jobs/`.** **Chosen.**
   - `Persistent=true` catches up a missed run.
   - The journal keeps each run's output.
   - Each run pings healthchecks.io at start and end.
   - The scripts run by hand on any host, the Mac included.
2. **A looping Compose service.** Rejected. It's portable, but a run missed while the host is down is silently lost. It needs its own failure reporting, and putting a scheduler inside the stack puts it inside the harness's egress allowlist, or adds another service outside it.
3. **Ofelia, or a cron container.** Rejected. It's another image, the repo shows no recent releases, and it notifies by mail or Slack only.
4. **Cron on the host.** Rejected. It doesn't catch up after downtime.

## Decision
- **The jobs.** Each is a POSIX shell script that runs one command through `docker compose exec -T gaffer` against the stack in its directory:

  | Script | What it runs | Timer |
  |---|---|---|
  | `deploy/compose/jobs/score.sh` | `gaffer-eval` | every 3 hours, `Persistent=true` |
  | `deploy/compose/jobs/snapshot.sh` | the new `tools/gaffer-snapshot` | hourly, `Persistent=true` |
  | `deploy/compose/jobs/backup.sh` | restic (ADR 0018), outside the harness | 03:30 UTC nightly, plus a weekly `check` |

  `gaffer-snapshot` is new, beside `gaffer-eval`. It takes one shared snapshot with `ep_next` (no team), only inside the window from 6 h to 1 h before the next deadline, and only if the store has none for that GW in the window yet.
- **Unit files** live in `deploy/compose/systemd/`, installed by the server setup script (ADR 0020).
- **Every job pings** `https://hc-ping.com/<uuid>/start` first, then the success or `/<exit code>` endpoint. The UUIDs sit in a root-only env file on the host, not in the repo.
- **Failures are visible in two places:** in healthchecks.io's email, and in the admin report, as a line each job writes to `/data/admin/jobs.jsonl` with time, job, exit code and a one-line summary.

## Consequences
- **FR-DAT-10 gets its trigger**, and FR-EVL-03's "within 24 h of `data_checked`" is met by a 3-hourly run.
- **Phase 1's exit can close** without anyone remembering to score a GW.
- **On the Mac, the jobs run by hand** (or from launchd, if you want, but that's not part of the plan). Only the timer units are Linux-specific.
- **M2-0 adds** `tools/gaffer-snapshot` and its tests, the three scripts, the unit files, and the `jobs.jsonl` line in the admin report.
