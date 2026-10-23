# Phase 2 planning — working checklist

Branch `phase-2-plan`, cut from `phase-2-prompts` (`phase-1.1-close` and `phase-2-prompts` weren't merged yet), from 2026-10-23T19:02Z. Brief: `prompts/gaffer-phase-2-prompt.md`.

## Read first
- [x] ROADMAP, ARCHITECTURE (§6.4, §7, §8, §9), REQUIREMENTS, ADRs 0001/0004/0005/0006/0009/0011/0013/0014, research 06, BUILD.md (M1.1-0 to Phase 1.1 close), `deploy/compose/`, `harness/entrypoint.sh` and `egress-ip.mjs`, `packages/gaffer-web/` (`server.ts`, the request guard in `bridge.ts`), `packages/pi-gaffer/src/sandbox.ts`, the drafted build briefs.
- [x] FPL calendar checked live: GW9 2026-10-31 11:00Z, GW10 11-06 18:30Z, GW11 11-21 11:00Z, GW12 11-27 18:30Z, **GW13 12-01 18:30Z** (ROADMAP said 12-02; corrected), GW16 12-19, GW19 2027-01-01 18:30Z.

## Research (subagents, in parallel; key claims re-checked by hand)
- [x] R13 hosting → `docs/research/13-hosting.md`. Re-checked: Hetzner's "not available" badges (visible on every CX/CAX card; hidden on CPX), the price table, and Cloudflare's "All disk is ephemeral".
- [x] R14 front door and identity → `14-front-door-identity.md`. Re-checked: Tailscale Serve's identity headers (stripped from clients; none for tagged devices or Funnel).
- [x] R15 egress → `15-egress-allowlist.md`. Its Node findings match S11.
- [x] R16 operations → `16-operations.md`. Re-checked: healthchecks.io's free tier (20 jobs).

## Spikes (local, free)
- [x] S11 egress proxy: internal-only harness and a Squid allowlist. Allowed hosts pass, everything else is refused, and there's no route out.
- [x] S12 identity header: ttyd `-H` checks presence only; `TTYD_USER` carries the value; the door replaces client copies; `gaffer-web` 421s non-loopback hosts.
- [x] S13 internal publish: an internal-only container can't publish ports, hence `door`.
- [x] S14 restic: byte-identical restore, wrong password refused, no plaintext.
- [ ] gVisor on ARM64: **not spiked**. Docker Desktop's VM can't take `runsc` without changing the Mac's Docker setup. Desk-checked (gVisor's docs: x86_64 and ARM64) and checked on the server in M2-1 step 1.

## Decisions (ADRs, status Proposed)
- [x] D1 host → ADR 0015: Hetzner, the same Compose file, CAX21, then CPX22, then CAX11, by stock.
- [x] D2 front door → ADR 0016: Tailscale Serve on the host, `door`, identity re-checked in `gaffer-web` and `gaffer-pi`. No domain.
- [x] D3 egress → ADR 0017: internal-only harness and a Squid allowlist; Node ≥ 24.22.
- [x] D4 data and backups → ADR 0018: restic to a Storage Box; the salt moves unchanged, checked by sha256.
- [x] D5 scheduler → ADR 0019: systemd timers and repo scripts; a new `tools/gaffer-snapshot`.
- [x] D6 build, deploy, observe → ADR 0020: build on the host, tag rollback, healthchecks.io; NFR-LAT-05 replaces NFR-LAT-02.
- [x] ADRs 0004, 0005, 0006 and 0013 amended (status lines), and the decisions index updated.

## Documents
- [x] ROADMAP: Phase 2 rewritten (M2-0 to M2-2, exits, cutover window); AWS moved to Phase 3; your decision to start before the Phase 1 exit recorded; risks added; GW13 corrected.
- [x] REQUIREMENTS:
  - reworded: NFR-SEC-04, NFR-PORT-02, FR-ADM-02;
  - retired: NFR-LAT-02;
  - added: NFR-SEC-10, NFR-SEC-11, NFR-REL-04, NFR-LAT-05.
- [x] ARCHITECTURE: §8 rewritten (diagram and table, with AWS as the Phase 3 column), plus §6.4, §7 and §9's Phase 2 lines and the config list.
- [x] REPO_LAYOUT: `deploy/server/`, the host overlay's directories, `tools/gaffer-snapshot`, and S11–S14.
- [x] Cost table: in research 13 and ADR 0015.
- [x] Build briefs refined: M2-0, M2-1, M2-2.

## Discovered while planning
- [x] **Hetzner's Cost-Optimized servers (CX and CAX, all of ARM) can't be ordered on 2026-10-23.** CPX can, at about three times the price. ADR 0015 orders the choice by stock.
- [x] **`gaffer-web` can't sit behind any real front door yet.** It refuses non-loopback Host (421) and expects `http://` Origins.
- [x] **ttyd's `-H` doesn't check the value.** The value check has to be in `gaffer-pi`, through `TTYD_USER`.
- [x] **`egress-ip.mjs` exits 1 on internal-only networks.** The harness would fail to start under ADR 0017 as it is. M2-0 must change how ttyd and `gaffer-web` choose their bind address.
- [x] **The odds source is the apex `football-data.co.uk`;** `www.` redirects there. The allowlist must use the code's own hosts, so there's a test for drift.
- [x] **Node 24.21 ignores `HTTPS_PROXY` without `NODE_USE_ENV_PROXY=1`.**
- [x] **restic on Docker Desktop can't read bind-mounted macOS files (EIO),** so the Mac-side backup of the cutover stages files in a volume.
- [x] **FR-DAT-10 has never had a trigger or a stand-alone command.** `tools/gaffer-snapshot` is new work in M2-0.
- [x] **ROADMAP's GW13 date was a day late** (FPL: 2026-12-01 18:30Z).

## Blocked on you (for the build, not this plan)
- [ ] Review the six Proposed ADRs (0015–0020); accept them or change them.
- [ ] Optional but useful before M2-0: a free Tailscale account, signed in on this Mac. Then M2-0 can check Serve's Host and Origin behaviour, two HTTPS ports, and WebSocket/SSE on a real tailnet before you buy a server.
- [ ] For M2-1: the Hetzner account and server, the Cloud Firewall, the tailnet policy and the phone app, the Storage Box, healthchecks.io.
