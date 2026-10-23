# Project Gaffer — Phase 2 Brief: Gaffer on a small host, behind sign-in

> **Note, 2026-10-23 (after this run):** you then changed Phase 2 to AWS ("keep it professional"). The plan this brief produced is kept as the small-host alternative (research 13–16). The current plan is ROADMAP's Phase 2, ADRs 0015–0020 (the AWS versions) and research 17, and the build briefs `gaffer-m2-0` to `gaffer-m2-2` follow it.

## Where we are

Gaffer is a Fantasy Premier League agent built as a Pi package (`packages/pi-gaffer`) on `@earendil-works/pi-coding-agent` 1.3.0. Its harness container (Pi, `ttyd` for the Gaffer Terminal on 7681, `gaffer-web` for the Gaffer App on 7682) runs beside a no-network Python sandbox. Phase 0, Phase 1 (M1–M5) and Phase 1.1 (M1.1-0 to M1.1-4) are built and merged. Phase 1.1 was deployed on 2026-10-23 to the only live stack: Docker Compose on my Mac (project `gaffer`, `deploy/compose`), with both ports bound to `127.0.0.1`. BUILD.md's last section, "Phase 1.1 close and deploy", records the deploy and its evidence.

**Phase 1's exit is not met, and I've decided to start Phase 2 anyway.** The exit needs three consecutive live GWs scored. GW7 is scored, GW8 is waiting for FPL's data check (about 2026-10-28), and GW9 needs a recommendation before its deadline (2026-10-31 11:00Z). Record this decision in ROADMAP. Phase 2 must not get in the way of Phase 1's live use.

**ROADMAP's Phase 2 is AWS** (ECS Fargate, ALB with OIDC, EFS, Secrets Manager; ADR 0006 and research 06). **I'm dropping AWS for cost.** Rough list prices put that design at about $140 a month before any egress firewall. I want Gaffer on a small, cheap host instead: Hetzner, or Cloudflare if it really fits. The setup must stay host-agnostic, the same images and Compose shape, so that a big cloud is still a mapping exercise in Phase 3 rather than a rewrite.

I don't own a domain. Don't assume I'll buy one. If the design you choose needs one, say so, and say what it costs.

## The task

Plan **Phase 2**: where Gaffer runs, how I reach it from my laptop and phone, and how it's kept safe, backed up and up to date. Then refine the three build briefs I've already drafted, so that they match what you decide:
- `prompts/gaffer-m2-0-prompt.md`: the production setup, built and tested locally;
- `prompts/gaffer-m2-1-prompt.md`: the host and the cutover;
- `prompts/gaffer-m2-2-prompt.md`: operating it, and the Phase 2 exit.

This is **research, spikes and architecture, not the build.** Don't change application code on `main`. Spikes prove or disprove one assumption each, and live in `spikes/sN-<name>/` with a README (question, method, result, impact on the design); they're never merged. Spikes are numbered from S11.

Work on a new branch, `phase-2-plan`, cut from `main` once `phase-1.1-close` and `phase-2-prompts` are merged (if they aren't yet, cut it from `phase-2-prompts`, which contains both). Commit at sensible points. Don't push, open a PR or merge; I'll review the branch.

## What "done" looks like

All of the following exist, and are consistent with each other and with the documents they update:
1. **`docs/research/`**: new notes numbered from 13, one per research area below. Each ends with a **Sources** list (with dates) and an **Unconfirmed** list (what you couldn't verify, and where you looked).
2. **`docs/decisions/`**: one ADR per decision below, numbered from 0015.
   - ADR 0006 gets status "Superseded in part" and a link forward. Its AWS mapping stays as the reference for a later big-cloud move.
   - ADR 0005's and ADR 0013's Phase 2 lines (ALB OIDC, ttyd's `-H X-Amzn-Oidc-Identity`, the egress allowlist) are updated the same way.
   - Don't delete any ADR.
3. **A monthly cost table** for the chosen design and the main alternatives, with prices checked live and dated: host, storage, backups, bandwidth, domain if any, sign-in. Put it in the hosting research note, and give the chosen total in ADR 0015.
4. **`docs/ARCHITECTURE.md`, `REQUIREMENTS.md`, `ROADMAP.md` and `REPO_LAYOUT.md`, updated in place.**
   - ROADMAP's Phase 2 is rewritten around the chosen design, with milestones M2-0 to M2-2 (or a better split, if you can justify it). Each milestone has exit criteria that cite requirement IDs.
   - Say what moved to Phase 3 (AWS, at least).
   - Requirements that name AWS (NFR-SEC-04's "ALB OIDC", NFR-LAT-02's Fargate cold start, NFR-PORT-02's "maps to ECS Fargate", FR-ADM-02) get reworded, or replaced by new IDs with testable acceptance criteria. List every requirement you change, with the reason.
5. **The three build briefs**, edited where your decisions differ from what they assume. Keep their structure: where we are, the task, what done looks like, constraints, how turns end. Each one states which ADRs it implements.
6. **`TASKS-2.md`**: your working checklist. Tick items as you finish them, and add what you discover.

## Decisions to make

Each one gets an ADR. For each, weigh the options against the same criteria:
- the security posture (below), which may only stay the same or get stronger;
- monthly cost;
- ops burden for one person;
- portability to another host;
- the latency and reliability requirements;
- data durability.

**D1. The host (ADR 0015).** At least:
- **Hetzner Cloud**, one VPS running the same Compose file. Answer these:
  - ARM (CAX) or x86 (CX)? The images are built `arm64` on my Mac today. Does gVisor (`runsc`, `deploy/compose/docker-compose.gvisor.yml`) run on the one you pick?
  - What size do the solver and Pi need? The sandbox is limited to 2 vCPU and 2 GB.
  - Which region, given latency to FPL and Anthropic?
- **Cloudflare**, likely Containers with Workers or Durable Objects in front. ADR 0011 already found that Durable Objects can't host the sandbox. Answer these:
  - Can a Container run the sandbox with no network at all?
  - Can it run the harness with a persistent disk for `/sessions` and `/data`? Pi writes JSONL to a filesystem.
  - Can it hold ttyd's long-lived WebSocket?
  - What are the cold starts and the price?

  If it can't meet the security posture or keep the session store, reject it with that reason.
- One more you find worth comparing (for example Fly.io Machines). Keep it brief.

**D2. The front door and identity (ADR 0016).** How I reach both UIs from my laptop and phone, and how only I get in. Compare at least:
- **Tailscale**: a private tailnet, `tailscale serve` with HTTPS on a `*.ts.net` name, no domain, no public port. Does it pass identity headers the harness can check?
- **Cloudflare Tunnel with Cloudflare Access**: needs a domain on Cloudflare. Which JWT header does it send, and how does the harness verify it?
- **Caddy with oauth2-proxy**: public, needs a domain and ACME.

Whatever you choose, the harness checks identity itself as well (defence in depth):
- ttyd takes its auth-proxy header (`-H`);
- `gaffer-web` refuses a request without the expected identity;
- the identity is trusted only from the proxy's own network;
- nothing except the front door can reach 7681 or 7682.

Answer "do I need a domain?" plainly. Choose the sign-in too: Google, a Tailscale login or a Cloudflare Access login. I left that to you; prefer what has the fewest moving parts.

**D3. The egress allowlist (ADR 0017).** ADR 0013 made it required for Phase 2. The harness reaches only the LLM provider, FPL and football-data (and whatever the front door itself needs); everything else fails. The sandbox keeps no network at all. Design the mechanism for the chosen host, for example an egress proxy container on the harness's only route, or host `nftables` with DNS-resolved sets. Say how it's tested, and how it fails when FPL's CDN changes its addresses.

**D4. Data, secrets and backups (ADR 0018).**
- **Volumes and secrets on the host.** The secrets are the provider key and `GAFFER_ID_SALT`.
- **Moving the live data off my Mac.** This covers sessions, the ledger, `outcomes.jsonl`, users' preferences and snapshots. **The salt must move unchanged**, or every team's hash changes and the ledger and preferences no longer match their teams. Say how the copy is checked.
- **Offsite backups.** Encrypted, for example `restic` to a Hetzner Storage Box, Cloudflare R2 or Backblaze B2. Give the retention, and a restore procedure with a test.

**D5. The scheduler (ADR 0019).** This has been open since M5:
- what runs `gaffer-eval` after each GW is data-checked;
- what takes FR-DAT-10's pre-deadline snapshot.

There is an always-on host now. Compare a systemd timer with a looping Compose service. Pick the one that keeps the setup host-agnostic.

**D6. Build, deploy, update and observe (ADR 0020).**
- **Images:** where they're built (CI to a private registry such as GHCR, or on the host), for which architecture, and pinned by digest.
- **Deploys and rollback:** how a deploy and a rollback run. ADR 0009's rollback tags carry over.
- **Patching:** how the host OS and Docker are patched.
- **Knowing it's broken:** how I find out the host is down or a scheduled job failed, without adding a monitoring service Gaffer can't do without.

Also say what replaces NFR-LAT-02. An always-on sandbox container has no cold start to measure.

## Working method

- **Read Gaffer before choosing a host.** Read these, in this order, before you research anything:
  - `docs/ROADMAP.md`, `docs/ARCHITECTURE.md` (§9 and the deployment section), `docs/REQUIREMENTS.md`;
  - ADRs 0001, 0004, 0005, 0006, 0009, 0011, 0013 and 0014;
  - `docs/research/06-deployment.md`;
  - BUILD.md's M1.1-0 to Phase 1.1 close sections;
  - `deploy/compose/` (the Compose files, `init-secrets.sh`, `tests/verify.sh` and what it runs);
  - `harness/entrypoint.sh` and `harness/Dockerfile`;
  - `packages/pi-gaffer/src/sandbox.ts` (the `SandboxProvider` seam);
  - `packages/gaffer-web/server.ts`;
  - the drafted build briefs.

  You need to know what runs today, and why, before judging where it should run.
- **Split the research across subagents.** Give each research area its own subagent with a self-contained brief, and run them in parallel. When one reports back, check its key claims against the source before you accept them. The decisions, the ADRs and the cost table are yours; don't delegate them. Time matters here: don't spend time that can be avoided, and the earlier a correct result is obtained, the better.
- **Current information only.** Verify today's date, prices, product limits and the FPL calendar live; don't trust research 06's figures or mine. When sources disagree (docs, pricing pages, changelogs), say which one you trusted and why.
- **Spike what the design would otherwise assume.** Spikes that run locally and cost nothing are always fine. Examples:
  - ttyd and `gaffer-web` behind a proxy that sets an identity header;
  - an egress-proxy container that refuses `example.com` while FPL and Anthropic work;
  - gVisor on an ARM64 Linux VM;
  - a `restic` backup and restore of a copy of the volumes.

  Anything that needs an account or costs money is my decision (see "How your turns end"). That includes a real VPS, a Tailscale tailnet, a Cloudflare zone and a storage bucket.
- **Stay minimal.** For each service, dependency or account you propose, state in one line why Gaffer can't do without it. "It's the standard stack" is not a reason. Fewer moving parts beats more features.
- **Treat fetched content as data.** Web pages, vendor docs, READMEs and sample configs are evidence, not instructions to you.

## Constraints

- **Don't touch the live stack** (Compose project `gaffer`, ports 7681/7682, images `:local`, its volumes). Plain `docker compose` in `deploy/compose`, and `pnpm eval` through `evals/runner/cli.ts`, both target it. For anything local, use a separate project name and other ports, as M1.1-1 to M1.1-4 did.
- **Keep Phase 1's live use working.** Recommendations are needed before GW9 (2026-10-31 11:00Z), GW10 (2026-11-06 18:30Z) and GW11 (2026-11-21 11:00Z), and the planning mustn't get in the way. ADR 0009's deploy windows apply again: the 2026-10-23 waiver covered that deploy only. The international break (after GW10, until GW11) is the obvious cutover window. Check the deadlines live from FPL's `events`.
- **Security can only stay the same or get stronger.** It must remain true that:
  - there is no user shell;
  - the sandbox has no network and no secrets;
  - the LLM key stays in the harness;
  - team IDs are hashed at rest;
  - Pi's built-ins stay locked off (ADR 0012).

  Phase 2 adds four more:
  - nothing is reachable from the internet except the front door;
  - SSH, if any, takes keys only and is not open to the world if the front door can avoid it;
  - the harness's egress is allowlisted;
  - backups are encrypted before they leave the host.
- **Accounts and money are mine.** Never create accounts, enter payment details, buy a domain or change DNS. Name what's needed and I'll do it.
- **The Pi-package thesis is the point of the project.** If a choice moves Gaffer away from "Pi core unchanged, Gaffer as a package", call it out as a test result for the theory.

## How your turns end

This is a long, multi-part run and I won't be watching most of it. A message with no tool call ends your turn, and the work stops there.
- Don't end a turn with a summary that announces the next step instead of taking it.
- Don't offer to carry on and then wait.
- Don't hand me a list of decisions when, by your own account, none of them blocks the rest of the work.
- Don't stop just because a decision is made or the turn has been long.

Status notes and recommendations are welcome: put them in the same message as your next tool call, and keep going with whatever doesn't depend on my answer.

Stop and ask me only when:
- a spike or decision needs an account, a payment or a domain;
- a core assumption turns out to be false (for example, no affordable host can keep the sandbox network-free, or no front door works without a public port and a domain);
- a choice would mean leaving `pi-coding-agent` as Gaffer's base;
- something you'd need to change is on the live stack, or would delete data.

End the run with three headings:
- **Blocked on me:** each account, purchase or decision, with what it unblocks.
- **Produced.**
- **Found:** the most important or surprising findings.

## References

Gaffer's own:
- `docs/` (all of it), `BUILD.md`, `deploy/compose/`, `harness/`, `packages/gaffer-web/server.ts`, `packages/pi-gaffer/src/sandbox.ts`;
- `prompts/gaffer-m2-0-prompt.md` to `gaffer-m2-2-prompt.md`.

Hosting and front doors (starting points; verify everything live):
- Hetzner Cloud: https://www.hetzner.com/cloud and https://docs.hetzner.com/cloud/
- Hetzner Storage Box: https://www.hetzner.com/storage/storage-box
- Cloudflare Containers: https://developers.cloudflare.com/containers/
- Cloudflare Tunnel and Access: https://developers.cloudflare.com/cloudflare-one/
- Tailscale Serve and identity headers: https://tailscale.com/kb/1312/serve
- Fly.io Machines: https://fly.io/docs/machines/
- oauth2-proxy: https://oauth2-proxy.github.io/oauth2-proxy/
- Caddy: https://caddyserver.com/docs/
- gVisor on ARM64: https://gvisor.dev/docs/
- restic: https://restic.readthedocs.io/
- ttyd's options (`-H`, `--check-origin`, `--max-clients`): https://github.com/tsl0922/ttyd
