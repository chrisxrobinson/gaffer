# ADR 0018 — Data, secrets and backups on AWS; moving the live data off the Mac

**Status:** Accepted (2026-10-23, with the ~$183/month budget) · **Date:** 2026-10-23 · **Confirms:** [ADR 0004](0004-session-storage.md)'s cloud line (EFS for `/sessions` and `/data`), with AWS Backup in place of "nightly S3 copies" · **Evidence:** [research 17](../research/17-aws.md), [spike S14](../../spikes/s14-restic-backup/README.md) (byte-for-byte restore checks) · **Requirements:** NFR-REL-04, NFR-PRIV-01, FR-INP-03, FR-EVL-03

## Context
- **What's live:** Gaffer's data is on two Docker volumes on the Mac. `sessions` holds Pi's JSONL files. `data` holds snapshots, the ledger, `outcomes.jsonl`, preferences, exports and the admin report.
- **The secrets:** the provider key and `GAFFER_ID_SALT`. Team IDs are HMAC-hashed with the salt at rest (NFR-PRIV-01), so **the salt must move unchanged**. A new salt would orphan every ledger row and preference file from its team.
- **Locks on EFS:** Pi writes JSONL by appending, and Gaffer's locks are `O_EXCL` files (ADR 0014), which NFSv4 (EFS) supports.

## Options considered
1. **EFS (Standard, multi-AZ),** encrypted with KMS, with access points per role, and AWS Backup daily plus a copy in another region. **Chosen.** It's a managed filesystem Pi uses unchanged, backups are point-in-time and managed, and at under 1 GB it costs cents.
2. **EFS One Zone.** Rejected. It saves cents and loses the data if that AZ is lost.
3. **The Pi session store in S3 or DynamoDB.** Rejected. It would replace Pi's file-based `SessionManager`, which is against the Pi-package thesis and buys nothing at this scale.
4. **restic to S3, as on the small host.** Rejected. AWS Backup does the same with managed retention and restore, and needs no password kept outside the account.

## Decision
- **EFS:**
  - one encrypted file system (`gaffer`), with mount targets in both private subnets;
  - automatic backups through AWS Backup;
  - `PreventDelete`-style protection through a CDK removal policy of `RETAIN`;
  - **three access points:**

    | Access point | Path | Owner | Mode | Mounted by |
    |---|---|---|---|---|
    | `sessions` | `/sessions` | uid/gid 10002 | read-write | harness and job tasks |
    | `data` | `/data` | uid/gid 10002 | read-write | harness and job tasks |
    | `data-ro` | `/data` | uid/gid 10001 | read-only | sandbox |

  - **Authorisation on mounts:**
    - The harness and job task roles may mount `sessions` and `data` read-write, with IAM authorisation and TLS required.
    - The sandbox has no task role, and EFS IAM authorisation uses the task role (research 17), so its mount can't be authorised by IAM. Instead, the file system policy allows `elasticfilesystem:ClientMount` only (never `ClientWrite`) through the `data-ro` access point, and only from the VPC.
    - The task definition also mounts it read-only, and the access point's POSIX user (10001) owns nothing.
- **Secrets Manager:**
  - two secrets, `gaffer/anthropic-api-key` and `gaffer/id-salt`;
  - injected into the harness and job containers only, through `secrets` on the task definition;
  - readable by the task *execution* role only.
- **AWS Backup:**
  - a vault, `gaffer`, encrypted with KMS;
  - a plan with daily backups at 03:30 UTC kept 35 days, and monthly backups kept 12 months;
  - a monthly copy to the same vault name in `eu-west-1`, kept 12 months;
  - a vault access policy that denies deleting recovery points, except to an admin role;
  - backup job failures alarm to your email (ADR 0020).
- **The secrets aren't in the EFS backups.** Secrets Manager is their system of record. Your copy of the salt, taken at the cutover, goes into your password manager.
- **The restore drill:** a script restores the latest recovery point to a new EFS file system, mounts it in a one-off task beside the live one, and compares a sha256 manifest over every file (S14's comparison) and `gaffer admin`'s totals. It runs once in M2-1 and again in M2-2.
- **The cutover (M2-1)** moves the live data:
  1. On the Mac, stop `gaffer`, then tar both volumes (staged through a volume, as S14 needed on Docker Desktop) with a sha256 manifest.
  2. Upload the archive to a temporary migration bucket: private, SSE-KMS, with a 7-day lifecycle expiry, and readable only by a one-off migration task's role.
  3. The migration task (the AWS CLI image) untars into the EFS access points and checks the manifest.
  4. **You put the salt into Secrets Manager yourself** from the Mac's secret file (`aws secretsmanager put-secret-value … file://…`), along with the provider key. Neither ever passes through the agent.
  5. Before the service starts, check:
     - the manifest matches;
     - `gaffer admin`'s totals match the Mac's;
     - the ledger and `outcomes.jsonl` match byte for byte;
     - the salt's sha256 matches the Mac's file.

  The Mac's volumes, images and secrets stay, stopped, as the rollback.

## Consequences
- **New requirement NFR-REL-04:** managed backups with a tested restore, including a copy outside the region.
- **The worst case loses about a day of data:** at most the sessions written since the last daily backup, never the ledger's history. AWS Backup supports point-in-time restore per recovery point, not continuously.
- **Losing the salt** (deleting the secret) would orphan the ledger's team hashes. The secret has a 30-day recovery window, and you keep the copy in your password manager.
- **M2-0 adds** the CDK constructs, the restore-drill and migration scripts, and their tests (CDK assertions; the manifest comparison against a local volume).
