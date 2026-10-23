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

## Decisions (the small-host ADRs, superseded by the AWS versions below)
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

## Re-planned on AWS (your instruction, 2026-10-23: "change it to use AWS - keep it professional")
- [x] R17 AWS facts and prices (subagent; key behaviours checked against AWS docs it cited) → `docs/research/17-aws.md`. About $183 a month before VAT for the ARM64, NAT-free design.
- [x] Research 13–16 kept as the evidence for the small-host alternative, each with a status line. S11–S13 still apply: the egress pattern, the harness-side identity, and the bind address.
- [x] ADRs 0015–0020 rewritten for AWS (**Accepted 2026-10-23**, with the ~$183/month budget; the small-host versions are in git history at `46393af`):
  - 0015: Fargate ARM64, always-on harness and sandbox;
  - 0016: ALB, Cognito Essentials and MFA, `gaffer-web` verifying `x-amzn-oidc-data` and fronting ttyd;
  - 0017: no NAT, a Squid service, endpoints, DNS Firewall;
  - 0018: EFS, AWS Backup with a copy in `eu-west-1`, and the migration;
  - 0019: EventBridge Scheduler jobs;
  - 0020: CDK and `cdk-nag`, ECR, deploy scripts, alarms and Budgets.
- [x] ADRs 0004, 0005, 0006 and 0013 status lines, and the index, re-pointed.
- [x] ROADMAP Phase 2 (AWS, M2-0 to M2-2, exits) and Phase 3. REQUIREMENTS:
  - FR-ADM-02, NFR-SEC-04, NFR-PORT-02 and NFR-LAT-02 back to AWS wording;
  - NFR-SEC-10, -11, NFR-REL-04 and NFR-LAT-05 restated;
  - NFR-OBS-03 and NFR-MNT-06 added.
- [x] ARCHITECTURE §6.4, §7, §8 and §9, and REPO_LAYOUT, now on AWS.
- [x] The M2-0 to M2-2 briefs rewritten for AWS.

## Discovered while re-planning on AWS
- [x] **`x-amzn-oidc-identity` is unsigned**, and no AWS doc says the ALB strips a client's copy. ttyd's `-H` on it would be trusting a header anyone signed in could set. So `gaffer-web` verifies the signed `x-amzn-oidc-data` and fronts the terminal, and ttyd listens on loopback.
- [x] **Security groups and NACLs can't filter traffic to the VPC's DNS server,** so a task with no egress rules can still leak data through DNS. Hence DNS Firewall, with `TRUST_REDIRECTION_DOMAIN` because FPL's CNAME chain runs through Fastly names that change.
- [x] **A task with no role can't use EFS IAM authorisation.** The sandbox's read-only mount is allowed by the file system policy for one access point instead.
- [x] **The always-on sandbox is the largest line ($66 a month).** Per-run `RunTask` would save most of it, at 30–60 s a recommendation. That's left for Phase 3.
- [x] **You need a domain** for the ALB's certificate and Cognito's callback: `.com` is $16 a year in Route 53.

## Blocked on you (for the build, not this plan)
- [x] ADRs 0015–0020 (AWS) and the ~$183/month budget: accepted by you on 2026-10-23.
- [ ] For M2-1:
  - an AWS account with IAM Identity Center and MFA (root MFA too);
  - a domain registered in Route 53 (or one you move there);
  - the two secrets put into Secrets Manager yourself;
  - your Cognito user's first sign-in;
  - the SNS email confirmation;
  - your AWS Budgets figure.
