# ADR 0017 — Egress allowlist: the harness on internal networks, a Squid proxy as its only exit

**Status:** Proposed (Phase 2 plan, for your review) · **Date:** 2026-10-23 · **Implements:** [ADR 0013](0013-gaffer-terminal.md)'s "the harness egress allowlist becomes required" · **Evidence:** [research 15](../research/15-egress-allowlist.md), spikes [S11](../../spikes/s11-egress-proxy/README.md) and [S13](../../spikes/s13-internal-publish/README.md) · **Requirements:** NFR-SEC-11, NFR-PRIV-02, NFR-SEC-09

## Context
- **Why it's required:** ADR 0013 made a harness egress allowlist required for Phase 2, as the one hard guarantee against future Pi features that reach out. The harness needs only three hosts:
  - the LLM provider (`api.anthropic.com`);
  - FPL (`fantasy.premierleague.com`, served by Fastly);
  - football-data (`football-data.co.uk`, the apex, as `odds.ts` calls it).
- **The sandbox** already has no network and keeps none.
- **What S11 found:**
  - Node 24's `fetch` uses a proxy only with `NODE_USE_ENV_PROXY=1`, so client settings alone enforce nothing.
  - A harness on internal-only networks has no DNS for outside names and no route out.
  - Squid refuses everything outside its allowlist, IP literals included.
- **What S13 found:** an internal-only container can't publish ports, which ADR 0016 solves with `door`.

## Options considered
1. **A CONNECT proxy as the only exit from an internal-only harness.** **Chosen.** It's enforced by the network, is the same on every Docker host, and adds one small container. CDN address changes don't affect it, because the proxy resolves names itself.
2. **Host nftables or ipsets filled from DNS.** Rejected:
   - Fastly's addresses rotate and are shared, so allowing one opens every site behind it.
   - It needs a refresh daemon.
   - It's Linux-only, and IPv6 has to be done twice.
3. **A DNS-only allowlist.** Rejected: it's bypassed by literal IPs.
4. **AWS Network Firewall** (ADR 0006's "optional allowlist later"). Moot without AWS, and about $290 a month.

## Decision
- **Networks:**

  | Network | Kind | Members |
  |---|---|---|
  | `front` | internal | `door`, `gaffer` |
  | `egress_in` | internal | `egress`, `gaffer` |
  | `sandbox_net` | internal (as today) | `gaffer`, `sandbox` |
  | `outside` | ordinary | `door`, `egress` |

  **The harness is on internal networks only.**
- **The `egress` service:** Squid, pinned by digest, configured as in S11 with `dstdomain -n`:
  - CONNECT on 443 only, to the three hosts;
  - deny IP literals;
  - deny everything else;
  - no cache;
  - access log to a file the admin report can read.

  It publishes nothing.
- **The harness gets** `NODE_USE_ENV_PROXY=1`, `HTTPS_PROXY` and `HTTP_PROXY` set to `http://egress:3128`, and `NO_PROXY=sandbox,localhost,127.0.0.1`. Its Node base image moves to **24.22.x or later**, for the `NO_PROXY` and proxy-error fixes. That's a digest change in `harness/Dockerfile`, not a Pi change.
- **One list of hosts:** the allowlist lives in `deploy/compose/egress/squid.conf`. A test reads the hosts Gaffer's code calls (`guard.ts`'s allowed hosts, `odds.ts`'s base URL, the provider base URL) and fails if they and the allowlist differ.
- **On the Mac,** the overlay is optional, but M2-0 tests it there on a separate project.

## Consequences
- **The guarantee holds even for code that ignores the proxy:** any destination outside the three hosts fails at the network, whatever the code or a future Pi feature tries. NFR-SEC-11 states it with tests: allowed hosts succeed; `example.com`, an IP literal, another port and an unlisted host all fail; and there's no DNS or raw TCP route.
- **A second model provider** (NFR-PORT-01) is one more line in the allowlist. Its absence fails loudly rather than leaking.
- **If FPL moves to another host name,** the snapshot step reports FPL unreachable (FR-DAT-05). The allowlist test then names the host to add.
- **Residual risk:** an allowed name on a shared CDN could, in principle, front for another site through a mismatched SNI. Accepted: the harness's own code makes no such requests, and Squid's SNI peek is available if this ever matters.
- **Everything outside the harness is unaffected:** the host itself (apt, Docker Hub, Tailscale, restic, healthchecks.io pings) isn't inside the allowlist, and neither is `door`.
