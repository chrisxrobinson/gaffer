# S14 — Encrypted backup and restore of Gaffer's volumes with restic

**Question:** does restic back up Gaffer's volumes and secrets so that a restore is byte-identical, and does the storage learn nothing about the contents?

**Method** (2026-10-23; `./run.sh` here):
- `restic/restic:0.19.1` backs up a copy of the data, never the live volumes. That's M1.1-4's test volumes (`gaffer-m114_sessions`, `gaffer-m114_data`) and throwaway secret files, into a repository on a local volume standing in for offsite storage.
- It restores into fresh volumes, then compares a sha256 over every file. It also tries a wrong password, and greps the repository for plaintext.
- The script removes its volumes afterwards.

**Result** (`results.txt`):
- **One snapshot:** 2,262 files and 207 MiB in, 5.5 MiB stored after compression and dedup, in about a second.
- **The restore is byte-identical** for sessions, data and secrets (the same sha256 over every file, on both sides).
- **A wrong password** gives "Fatal: wrong password or no key found".
- **No plaintext in the repository:** no repository file contains `sessions` or `gaffer.recommendation`. (The first grep reported 2 because of a flag mistake in the script, now fixed.)
- **Docker Desktop only:** restic got `input/output error` reading files bind-mounted from macOS (it opens them with `O_NOATIME`). The secrets were staged into a volume instead. This doesn't apply on a Linux host, where restic reads local files, but a backup run from the Mac needs the same staging.

**Impact on the design (ADR 0018):**
- restic 0.19.1, pinned by digest, as a one-shot container run by a host timer.
- Repository on a Hetzner Storage Box over SFTP. The password is kept off the host (in the user's password manager) and in a root-only file on it.
- The restore drill uses this script's comparison.
