# R15 — An egress allowlist for the harness

*Researched 2026-10-23 against Node's docs and source, Docker's and Squid's docs. Spikes S11 and S13 tested it locally.*

## TL;DR
- **Enforce it with the network, not the client.**
  - The harness sits only on `internal: true` networks, so it has no route out at all.
  - A Squid forward proxy, on that network and on an ordinary one, is its only exit. Squid allows CONNECT on 443 to three hostnames, `api.anthropic.com`, `fantasy.premierleague.com` and `football-data.co.uk`, and denies everything else, including IP literals. That's the S11 config, plus `dstdomain -n`.
  - With no route out, even code that ignores the proxy settings can't leave.
- **Node needs `NODE_USE_ENV_PROXY=1`** for `fetch` to use the proxy: from v24.0.0 for `fetch`, and from v24.5.0 for `node:http`/`https`. It's marked "Active Development", not stable. Pin Node ≥ **24.22** for the `NO_PROXY` matching fix and CVE-2026-48615 (proxy credentials leaking in error messages). The harness image is 24.21.0 today.
- **Pi's provider calls are covered.** `@anthropic-ai/sdk` uses `globalThis.fetch` by default (checked in its npm tarball, 1.2.0), and so do Gaffer's FPL and odds fetches.
- **A side effect:** a container on internal networks only gets no published ports (S13). A small reverse proxy has to front the harness (ADR 0016).

## Mechanisms compared
| Mechanism | Strength | Complexity | Notes |
|---|---|---|---|
| **CONNECT proxy, with the harness internal-only** | **High:** no route except the proxy | One small container and one config file | Checks the CONNECT target name. A client could CONNECT to an allowed name and send a different SNI inside, but bytes still go only to that name's addresses; residual domain-fronting risk on a shared CDN (Fastly). Squid's `ssl_bump peek` adds an SNI check at the cost of more config. |
| Host nftables or ipset from DNS | Medium | A refresh daemon | Fastly addresses rotate and are shared, so allowing one opens every Fastly customer on it. IPv6 has to be duplicated. Refresh races drop legitimate traffic. |
| DNS-only allowlist | Weak | Low | Bypassed by literal IPs, `--resolve`, DoH to an IP. |
| Docker alone | Partial | Lowest | `internal: true` cuts everything; Docker has no per-host allowlist. Published ports bypass UFW (use `DOCKER-USER`). The nftables backend is experimental. |

**Images:**
- Squid 6.14 (`ubuntu/squid:6.6-24.04_edge`) was tested in S11. `ubuntu/squid:7.2-26.04_edge` is newer, and Alpine 3.24 ships Squid 7.6.
- tinyproxy 1.11.3 (Alpine 3.24) is maintained and smaller, but checks only the CONNECT host and wasn't tested.

Gaffer takes Squid, the tested one, pinned by digest.

## How it's tested (from the harness)
1. **Allowed hosts succeed through the proxy:** Anthropic 401 (reachable, no key), FPL 200, football-data 200.
2. **Refused through the proxy:** `example.com`, an IP literal, `www.football-data.co.uk` (not a host the code uses), plain HTTP, and an allowed name on another port.
3. **No direct route:** no DNS for outside names (`EAI_AGAIN`), and raw TCP to an outside IP fails (`ENETUNREACH`).
4. **Logs:** Squid's access log shows only allowed hosts. A tcpdump on the host's uplink during a run shows only the proxy's connections to those hosts (NFR-PRIV-02).
5. **Sandbox unchanged:** `isolation.mjs` 17/17.

S11 ran steps 1–3 and the log check.

## Gotchas
- **Gaffer's hosts must be listed exactly as the code calls them:** `football-data.co.uk` is the apex (`odds.ts:18`). A test compares the proxy's allowlist with the hosts in `guard.ts` and `odds.ts`, so the two can't drift.
- **`NO_PROXY=sandbox`:** the sandbox is reached directly on `sandbox_net`.
- **Rotating addresses:** the proxy resolves names itself, so FPL's CDN changing its addresses changes nothing.
- **When FPL moves to a new host name**, its requests fail loudly. The snapshot step reports FPL unreachable (FR-DAT-05), and the fix is one line in the allowlist.
- **Don't share the front door's namespace:** never give the harness `network_mode: service:<tailscale>`, or it inherits that container's full egress.
- **IPv6:** keep it off on Gaffer's Docker networks (the default).

## Sources
- Node CLI docs (`NODE_USE_ENV_PROXY`, `--use-env-proxy`, v24.x), read 2026-10-23: https://github.com/nodejs/node/blob/v24.x/doc/api/cli.md
- Node HTTP docs, "Built-in Proxy Support" (`proxyEnv`; Active Development), read 2026-10-23: https://github.com/nodejs/node/blob/v24.x/doc/api/http.md
- Node v24 changelog (`fetch()` supports `NODE_USE_ENV_PROXY` from 24.0.0; the `no_proxy` fix #62333; CVE-2026-48615), read 2026-10-23: https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V24.md
- Node releases (24.22.1, 2026-10-20), read 2026-10-23: https://nodejs.org/dist/index.json
- @anthropic-ai/sdk 1.2.0 `internal/shims.mjs` (`getDefaultFetch`), npm tarball read 2026-10-23: https://www.npmjs.com/package/@anthropic-ai/sdk
- Docker packet filtering and firewalls (`DOCKER-USER`, UFW bypass), read 2026-10-23: https://docs.docker.com/engine/network/packet-filtering-firewalls/
- Squid peek and splice (SNI is client-supplied; `ssl::server_name` does no DNS), read 2026-10-23: https://wiki.squid-cache.org/Features/SslPeekAndSplice
- tinyproxy releases (1.11.3, 2026-03-07), read 2026-10-23: https://github.com/tinyproxy/tinyproxy
- Spikes S11 and S13 (2026-10-23): `spikes/s11-egress-proxy/`, `spikes/s13-internal-publish/`

## Unconfirmed
- **Whether Node's global `WebSocket` follows `NODE_USE_ENV_PROXY`.** Gaffer opens no outbound WebSocket, and without a route a WebSocket just fails.
- **Whether Pi ever spawns a subprocess that makes network calls.** None is in use (built-ins are locked off, ADR 0012), and without a route one would fail rather than leak.
- **Whether Fastly blocks SNI/Host domain fronting in 2026.**
- **Whether the `ubuntu/squid` build supports `ssl_bump`.** It isn't needed for the chosen config.
- **The exact v24 minor that added `http.setGlobalProxyFromEnv`.** Not used.
