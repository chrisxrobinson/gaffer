# ADR 0018 — Data, secrets and backups on the host; moving the live data off the Mac

**Status:** Proposed (Phase 2 plan, for your review) · **Date:** 2026-10-23 · **Amends:** [ADR 0004](0004-session-storage.md) (its EFS/S3 lines move to Phase 3) · **Evidence:** [research 16](../research/16-operations.md), [spike S14](../../spikes/s14-restic-backup/README.md) · **Requirements:** NFR-REL-04, NFR-PRIV-01, FR-INP-03, FR-EVL-03

## Context
- **What's live:** Gaffer's data is on two Docker volumes on the Mac. `sessions` holds the Pi JSONL files. `data` holds snapshots, the ledger, `outcomes.jsonl`, users' preferences, exports and the admin report.
- **The two secrets:** the provider key and `GAFFER_ID_SALT`. Team IDs are HMAC-hashed with the salt at rest (NFR-PRIV-01), so **the salt must move unchanged**. A new salt would orphan every ledger row and preference file from its team.
- **What ADR 0004 assumed:** EFS with nightly S3 copies, on AWS.
- **What S14 showed:** restic backs up these volumes and secrets, restores them byte-identical, refuses a wrong password, and leaves no plaintext in the repository.

## Options considered
1. **restic to a Hetzner Storage Box (BX11) over SFTP.** **Chosen.** €3.20 a month, encrypted before it leaves the host, one provider.
2. **restic to Cloudflare R2.** Kept as the alternative. It's free at this size and puts the backups with another provider, which is a one-line repository change if you want the backups off Hetzner.
3. **Hetzner's server Backups.** Rejected as the backup. They're whole-machine images, at the same provider, can't be restored on the Mac, and their encryption isn't stated.
4. **Copying the volumes with `rsync` to the Mac.** Rejected. It isn't encrypted at rest, and the Mac would have to be on.

## Decision
- **On the host:**
  - The two volumes live on the server's disk, as Docker named volumes.
  - The secrets are files in `deploy/compose/secrets/` (mode 0600, owned by root, the directory 0700), mounted as Compose secrets. That's the existing `init-secrets.sh` layout, with stricter modes on Linux.
  - The restic password and the Storage Box SSH key sit in `/root/gaffer-backup/` (0600).
- **Backups:**
  - **Nightly at 03:30 UTC**, a host timer (ADR 0019) runs `restic/restic:0.19.1` (pinned by digest) over both volumes (read-only) and both secrets, to `sftp:<box>:/gaffer`.
  - Then `forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune`.
  - **Weekly**, `restic check`.
  - Each run pings healthchecks.io (ADR 0020).
- **Restore:** `deploy/compose/backup/restore.sh <snapshot> <project>` restores into a named Compose project's volumes and secrets. It then compares the restored files with the snapshot (restic's own `restore --verify`) and prints `gaffer admin`'s totals.
- **The restore drill is S14's comparison:** a sha256 over every file, the same on both sides. It runs once in M2-0 (local), once in M2-1 (on the host, after the first real backup) and once in M2-2 (a fresh project).
- **The password is kept in two places:** on the host, and in your password manager. A backup you can't decrypt is not a backup.
- **The cutover (M2-1)** moves the live data with this same path:
  1. Take a restic backup on the Mac (staging the files in a volume, as S14 had to on Docker Desktop).
  2. Stop the Mac's `gaffer` container.
  3. Take a final incremental backup.
  4. Restore on the host with the Mac's salt.
  5. Check before starting anything: file counts and sha256s match; `gaffer admin`'s totals match; the ledger and `outcomes.jsonl` match byte for byte; and the salt file's sha256 matches.

  The Mac's volumes, images and secrets stay, stopped, as the rollback.

## Consequences
- **New requirement NFR-REL-04:** encrypted offsite backups with a tested restore.
- **Losing the server loses at most a day of data.** You'd lose any sessions written since 03:30 UTC, never the ledger's history.
- **The salt and provider key are in the backup,** inside restic's encryption. Whoever holds the restic password holds them, so the password is treated as a secret of the same rank.
- **M2-0 adds the backup and restore scripts and their tests,** and a Mac-side backup script that stages files in a volume first.
