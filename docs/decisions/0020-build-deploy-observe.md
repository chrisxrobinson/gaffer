# ADR 0020 — Build, deploy, patch and observe: built on the host, rolled back by tag, watched by a dead-man's switch

**Status:** Proposed (Phase 2 plan, for your review) · **Date:** 2026-10-23 · **Extends:** [ADR 0009](0009-pi-version-policy.md) (rollback tags and deploy windows) · **Evidence:** [research 16](../research/16-operations.md), [research 13](../research/13-hosting.md) · **Requirements:** NFR-MNT-01, NFR-MNT-04, NFR-REL-04, NFR-LAT-05

## Context
- **How it's done today:** one machine builds the images (`docker compose up -d --build`), and ADR 0009 keeps the previous images tagged for rollback.
- **What changes with the host:**
  - The images may need a different architecture: CAX is arm64, CPX is amd64, and stock decides which (ADR 0015).
  - Deploys happen remotely.
  - The host OS needs patching.
  - You need to hear when the host is down or a job failed, without running a monitoring service.
- **What's already pinned:** the Dockerfiles pin their base images by digest (multi-arch indexes), and Pi's tree is pinned by lockfile (NFR-MNT-01).

## Options considered
1. **Build on the host** from a `git archive` of the tagged commit, sent over the tailnet. **Chosen.** It's the host's own architecture, with no registry and no credential on the host.
2. **CI builds multi-arch images and pushes them to a private GHCR package; the host pulls by digest.** Rejected for one host. It needs a pull token on the host, and an amd64 or arm64 build in Actions per release. Kept as the Phase 3 path.
3. **`docker save | ssh host docker load` from the Mac.** Rejected. Images of 1–2 GB over a home uplink, and amd64 images built under emulation on the Mac.
4. **Monitoring with a Prometheus or Grafana stack, or an uptime service polling a public URL.** Rejected. It's more services than Gaffer, and there's no public URL to poll.

## Decision
- **Server setup** (`deploy/server/setup.sh`, run once by hand over SSH, idempotent):
  - a non-root admin user;
  - Docker Engine from Docker's apt repository;
  - gVisor `runsc` registered with Docker;
  - Tailscale, and `tailscale serve` for both UIs (ADR 0016);
  - SSH on the tailnet only;
  - unattended-upgrades for security updates, with `Automatic-Reboot "true"` at 04:00 UTC;
  - the systemd units (ADR 0019);
  - a check that nothing listens on a public address.

  Hetzner's Cloud Firewall (no inbound rules) is set in the console. That's yours.
- **Deploy** (`deploy/server/deploy.sh <git ref>`, from the Mac over the tailnet, inside an ADR 0009 window):
  1. `git archive <ref>` is copied to `/srv/gaffer/releases/<ref>`.
  2. Tag the running images `:pre-<ref>`.
  3. `docker compose build`.
  4. `up -d`.
  5. Wait for both UIs to answer 200 through `door`.
  6. `verify-prod.sh` (`verify.sh` plus the identity and egress checks).
  7. Record the ref, the image IDs and the time in `/srv/gaffer/deploys.log`.

  **Rollback** (`deploy/server/rollback.sh`): retag `:pre-<ref>` as `:local`, and `up -d` with that release's Compose files. Both scripts refuse to run within 24 hours before a deadline unless `--force` is given, reading the deadline from FPL's `events`.
- **Patching:**
  - The OS patches itself (security updates, the 04:00 UTC reboot).
  - Docker Engine and gVisor are upgraded by hand inside a window, then `verify-prod.sh` runs.
  - Pi and image changes follow ADR 0009 as before.
- **Alerts:**
  - healthchecks.io (free; your account), with one check per job (ADR 0019) and a 5-minute heartbeat from a host timer. The heartbeat also curls both UIs through `door` with the allowed identity, so a stack that's down shows up as well as a host that's down.
  - Alerts go to your email, and optionally to an ntfy topic on your phone.
- **Latency on the host** (NFR-LAT-05): `verify-prod.sh` records the sandbox's first-command latency after `up -d`, and the golden path's time, in `deploys.log`.

## Consequences
- **The host needs outbound access while building** (Docker Hub, npm, PyPI, GitHub for the solver pin), as the Mac does. The harness's egress allowlist doesn't apply to the host.
- **There's no registry,** so a second host would build its own images. Fine for Phase 2; Phase 3 revisits it (option 2).
- **The only standing third-party service is healthchecks.io.** It sees ping times and exit codes, never content.
- **`deploys.log` and the job lines** give M2-2 its record of restarts and failures (ADR 0011's T3).
