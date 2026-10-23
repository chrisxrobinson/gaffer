# R16 — Operating Gaffer on one host: backups, scheduling, deploys, patching and alerts

*Researched 2026-10-23 against vendor docs and pricing pages. healthchecks.io's free tier was re-checked by hand, and spike S14 tested restic locally.*

## TL;DR
| Topic | Default | Cost/month |
|---|---|---|
| Offsite backups | restic 0.19.1 to a **Hetzner Storage Box BX11** over SFTP; nightly; `forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune`; weekly `check`; a restore drill | €3.20 (1 TB) |
| Scheduling | **systemd timers on the host** (`Persistent=true`) calling `docker compose exec` scripts kept in the repo | 0 |
| Images | **Built on the host** from a `git archive` of the tagged commit, native architecture, base images pinned by digest as today, the previous images tagged for rollback | 0 |
| Patching | Ubuntu's unattended-upgrades (security), automatic reboot at 04:00 UTC; Docker Engine by hand inside an ADR 0009 window | 0 |
| Alerts | **healthchecks.io** free (20 checks) pinged from the host: one check per timer plus a 5-minute host heartbeat; alerts by email, and optionally ntfy | 0 |

## Backups
- **restic's model:**
  - A master key (AES-256-CTR plus Poly1305-AES) encrypts all data. It's wrapped in key files, each with a scrypt-derived password key.
  - The storage sees only sizes, object counts, times, access patterns and key-file metadata.
  - A wrong password is refused, and no file in the repository holds plaintext (S14).
  - Use a strong password kept off the host as well, in the user's password manager. Losing it loses the backups.
- **Targets:**
  - Hetzner Storage Box BX11: €3.20, 1 TB, SFTP, snapshots.
  - Cloudflare R2: $0.015/GB-month, 10 GB free, free egress.
  - Backblaze B2: $6.95/TB-month, 10 GB free.

  Gaffer's data is a few hundred MB (5.5 MiB stored for M1.1-4's test volumes after dedup and compression, S14), so any of them works. The Storage Box keeps one provider and one account, and R2 is the free alternative if a second provider is wanted. ADR 0018 picks the Storage Box and keeps R2 as a one-line change.
- **Hetzner's own server Backups** (20% of the server price, 7 daily slots) are whole-machine images, at the same provider, can't be restored on the Mac, and their encryption isn't stated. They're not a substitute, so Gaffer doesn't buy them.
- **What's backed up:** the two volumes (`sessions`, `data`) and both secret files. The salt matters most: without it, the ledger's and preferences' team hashes can't be matched to a team again.
- **Docker Desktop:** restic can't read bind-mounted files there (EIO), so a backup run on the Mac stages them in a volume first (S14).

## Scheduling
- **systemd timers** catch up a missed run after downtime (`Persistent=true`), log to the journal, and can ping a dead-man's switch before and after each run. Cron doesn't catch up.
- **A looping container or Ofelia** would run the same on Docker Desktop. But a missed run is silently lost, failure notices are mail or Slack only, and Ofelia's repo shows no recent releases.
- **Host-agnostic anyway:** the jobs themselves are scripts in the repo (`deploy/compose/jobs/*.sh`, each a `docker compose exec` of an idempotent command), runnable by hand anywhere. Only the timer units are Linux-specific.
- **The two jobs:**
  - `gaffer-eval` every 3 hours. It does nothing until FPL marks a GW data-checked, and is idempotent.
  - A pre-deadline snapshot (FR-DAT-10) every hour, which acts only inside the window before the next deadline. **That command doesn't exist yet**: M3 built the snapshot store and its per-GW index but not a stand-alone trigger (BUILD.md M3). M2-0 adds it as a small tool beside `gaffer-eval`.

## Images, deploys and rollback
- **A registry (GHCR)** costs nothing today, but it would need a pull credential on the host and a private package. For one host it adds a secret and a dependency for no gain. Not used.
- **Building on the host** gives the host's own architecture without emulation, which matters because the CAX/CPX choice is decided by stock (research 13). The Dockerfiles already pin base images by digest (multi-arch indexes), and Pi's tree is pinned by lockfile (NFR-MNT-01). The repo reaches the host as a `git archive` of the tagged commit over the tailnet; the host needs no GitHub access.
- **Deploy:** tag the running images `:pre-<release>` (ADR 0009), build, `docker compose up -d`, run `verify-prod.sh`. **Rollback:** retag `:pre-<release>` as `:local` and `up -d`.
- **CI on GitHub Actions** (`ubuntu-24.04-arm` runners are free for public repos and use the 2,000 free minutes on private ones) stays as it is: it tests, it doesn't deploy.

## Patching
- **Ubuntu 24.04's unattended-upgrades** is installed and enabled by default, with the release, `-security` and ESM origins. Since 24.04, needrestart restarts affected services by itself.
- **Automatic reboot** is off by default. Gaffer turns it on at 04:00 UTC, which is never within 6 hours of a deadline (deadlines fall between 11:00 and 18:30 UTC). After a reboot, Compose's `restart: unless-stopped` brings the stack back.
- **Docker Engine** comes from Docker's apt repo, which isn't among unattended-upgrades' origins. It's upgraded by hand inside a deploy window.

## Alerts
- **healthchecks.io Hobbyist** is $0 for 20 checks (re-checked 2026-10-23), with `/start`, success, `/fail` and `/<exit code>` pings and grace periods. It needs only outbound HTTPS from the host, so it works for a private host.
- **A missing 5-minute heartbeat is the "host is down" alarm.** External uptime checks need a public endpoint, which Gaffer doesn't have.
- **ntfy.sh** (free, no sign-up, the topic name is the secret) or Pushover ($4.99 once) can deliver phone pushes. Email is enough to start.

## Sources
- restic releases (0.19.1, 2026-07-05), its design reference (encryption) and `forget`, read 2026-10-23: https://github.com/restic/restic/releases/latest, https://restic.readthedocs.io/en/stable/100_references.html, https://restic.readthedocs.io/en/stable/060_forget.html
- Hetzner Storage Box (BX11, €3.20, 1 TB), read 2026-10-23: https://www.hetzner.com/storage/storage-box/
- Cloudflare R2 pricing, read 2026-10-23: https://developers.cloudflare.com/r2/pricing/
- Backblaze B2 pricing, read 2026-10-23: https://www.backblaze.com/cloud-storage/pricing
- Hetzner Cloud backups, read 2026-10-23: https://docs.hetzner.com/cloud/servers/backups-snapshots/overview/
- systemd.timer (`Persistent=`), read 2026-10-23: https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html
- Ofelia, read 2026-10-23: https://github.com/mcuadros/ofelia
- GitHub Packages billing (container registry free) and hosted runners, read 2026-10-23: https://docs.github.com/en/billing/concepts/product-billing/github-packages, https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- Ubuntu automatic updates, read 2026-10-23: https://ubuntu.com/server/docs/how-to/software/automatic-updates/
- healthchecks.io pricing (Hobbyist $0, 20 jobs), re-checked 2026-10-23: https://healthchecks.io/pricing/
- ntfy and Pushover, read 2026-10-23: https://docs.ntfy.sh/publish/, https://pushover.net/pricing
- Spike S14 (2026-10-23): `spikes/s14-restic-backup/`

## Unconfirmed
- **Whether BX11 was repriced in 2026.** It isn't on Hetzner's price-adjustment page, and the product page still shows €3.20.
- **Whether Hetzner's server Backups are encrypted or kept in another data centre.** Not material; they aren't used.
- **ntfy.sh's daily message limit for free use.** The limits section didn't render.
- **The architectures the `restic/restic` image is published for.** S14 used it on arm64; amd64 is expected. Check by digest when pinning.
