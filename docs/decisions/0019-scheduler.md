# ADR 0019 — Scheduler: EventBridge Scheduler runs one-off Fargate tasks from the harness image

**Status:** Accepted (2026-10-23, with the ~$183/month budget) · **Date:** 2026-10-23 · **Settles:** the open M3 and M5 question of what runs `gaffer-eval` and FR-DAT-10's pre-deadline snapshot · **Evidence:** [research 17](../research/17-aws.md), [research 16](../research/16-operations.md) (the single-host alternatives) · **Requirements:** FR-EVL-03, FR-DAT-10, NFR-OBS-03

## Context
- **Nothing scheduled exists yet:** since M3 and M5, nothing has run `gaffer-eval` after a GW is data-checked (GW7 was scored by hand on 2026-10-23), and nothing takes a pre-deadline snapshot in a week when Gaffer isn't opened (FR-DAT-10).
- **Both jobs are idempotent**, so a job can run often and catch up after downtime.
- **ROADMAP's AWS plan** already said `gaffer-eval` would be a scheduled task (ARCHITECTURE §6.4).
- **Phase 1's exit** depends on scoring actually happening.

## Options considered
1. **EventBridge Scheduler → ECS `RunTask`:** a one-off Fargate task from the harness image, with the command overridden, mounting the same EFS access points, in the harness's subnets and security group. **Chosen.**
   - It's AWS's managed scheduler, with a retry policy and a dead-letter queue.
   - Nothing runs between jobs.
   - The job gets exactly the harness's network and egress allowlist (ADR 0017).
2. **`docker exec`-style commands into the running harness task through ECS Exec.** Rejected. It would mean turning on ECS Exec, which is a shell path into the harness (NFR-SEC-07).
3. **A timer loop inside the harness container.** Rejected. A run missed while the task is replaced is lost silently. Failure reporting would be ours to build, and it couples the jobs to the interactive service's lifecycle.
4. **Lambda.** Rejected. The jobs need the harness image's code and the sandbox (scoring runs `gaffer_lib score` in the sandbox), so a Lambda would duplicate the image.

## Decision
- **Three schedules,** in the time zone `UTC`, each a `RunTask` of a dedicated task definition (`gaffer-job`). It uses the harness image, has no ALB and no ports, mounts the same EFS access points, runs in the harness's security group, and reads `GAFFER_ID_SALT` (and the provider key only for jobs that need it: none of these do) from Secrets Manager.

  | Schedule | Command | When |
  |---|---|---|
  | `score` | `node /opt/tools/gaffer-eval/main.ts` | every 3 hours |
  | `snapshot` | `node /opt/tools/gaffer-snapshot/main.ts` | hourly |
  | `report` | `node /opt/tools/gaffer-admin/main.ts` | daily |

  - `gaffer-snapshot` is **new**, beside `gaffer-eval`. It takes one shared snapshot with `ep_next` (no team), only inside the window from 6 h to 1 h before the next deadline, and only if the store has none for that GW in the window yet.
  - `report` refreshes `/data/admin/admin.html` for `/admin` (FR-ADM-02).
- **Each schedule** has a retry policy (2 attempts) and a dead-letter SQS queue.
- **Job results:**
  - A CloudWatch metric filter on the job log group counts non-zero exits.
  - An alarm on failures, or on a schedule with no successful run in 26 hours, notifies your email through SNS (ADR 0020).
  - Each job also appends a line to `/data/admin/jobs.jsonl` (time, job, exit code, one-line summary), which the admin report shows.
- **The sandbox:** jobs that need it (`score` runs `gaffer_lib score`) reach the always-on sandbox service exactly as the harness does (ADR 0015). The run lock (ADR 0014) still serialises them with interactive runs, because the sandbox's `/work` is shared.

## Consequences
- **FR-DAT-10 gets its trigger,** and FR-EVL-03's "within 24 h of `data_checked`" is met by a 3-hourly run. Phase 1's exit can close without anyone remembering to score a GW.
- **Cost is negligible:** a few minutes of Fargate a day.
- **New requirement NFR-OBS-03:** a scheduled job's failure or absence alerts within a day.
- **On the Mac, the same commands run by hand** (`docker compose exec gaffer node /opt/tools/...`), so local and cloud run identical code.
- **M2-0 adds** `tools/gaffer-snapshot` with its tests, the `jobs.jsonl` line, and the CDK constructs for the schedules, the queue and the alarms.
