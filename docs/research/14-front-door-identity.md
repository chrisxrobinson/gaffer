# R14 — The front door: reaching Gaffer from a laptop and a phone, and only by its owner

*Researched 2026-10-23 against vendor docs. Tailscale's identity-header behaviour was re-checked by hand. Spikes S12 and S13 tested the harness side locally.*

## TL;DR
- **Tailscale, with `tailscale serve` on the host, meets every requirement with no domain, no public port and no monthly cost.**
  - **HTTPS without a domain:** `<machine>.<tailnet>.ts.net` with a real certificate.
  - **Identity headers:** `Tailscale-User-Login`, `-Name` and `-Profile-Pic`. Serve **removes** any copies the client sent.
  - **Phone:** the Tailscale iOS or Android app.
  - **Sign-in:** the tailnet's identity provider (Google, Apple, GitHub, Microsoft, passkeys, OIDC).
  - **Cost:** free for personal use (6 users).
- **Cloudflare Tunnel with Access** also has no public port, but it **needs a domain** on Cloudflare (a .com is about $10.46 a year). Quick tunnels don't support Server-Sent Events, which the App uses, and their hostname changes on every run.
- **Caddy with oauth2-proxy** is public (80/443 open to the internet) and needs a DNS name. sslip.io and nip.io share Let's Encrypt's per-domain rate limit with every other user. Let's Encrypt's IP-address certificates (GA 2026-01-15) last 6 days.
- **Do you need a domain? No**, with Tailscale.

## Options
| | Tailscale + Serve | Cloudflare Tunnel + Access | Caddy + oauth2-proxy | WireGuard alone |
|---|---|---|---|---|
| Domain | No (`*.ts.net`) | **Yes** | Yes (or an IP certificate) | No |
| Monthly cost | $0 | $0 plus a domain (~$0.87) | $0 | $0 |
| Open to the internet | **Nothing** | Nothing (outbound tunnel) | 80/443 | 1 UDP port |
| Identity to the app | `Tailscale-User-Login`; Serve strips client copies | `Cf-Access-Jwt-Assertion` JWT, verified against the team's certs and AUD | `X-Forwarded-Email`; the proxy must strip client copies | None |
| WebSocket / SSE | Works in practice; not stated in the docs | WebSocket yes; SSE yes on named tunnels, **not on quick tunnels** | Yes | Yes |
| Phone | Tailscale app | Browser | Browser | WireGuard app, keys by hand |
| Parts to run | `tailscaled` on the host | `cloudflared` + a Zero Trust account + a zone | Caddy + oauth2-proxy + a Google OAuth client | WireGuard + per-device keys |

## Tailscale details that shape the design
- **Identity headers are absent for traffic from tagged devices.** The server can be tagged, but the laptop and phone must be the user's own (untagged) devices. Funnel traffic (public) has no identity headers, so **Funnel must stay off**.
- **Where the backend should listen:** Tailscale advises that a backend authenticating by these headers listen only on localhost, "otherwise, any user that can reach the backend directly could forge them". Gaffer's Compose file already publishes both ports on `127.0.0.1` only (NFR-SEC-04). So `tailscale serve` on the **host** proxies to `127.0.0.1:7682` and `127.0.0.1:7681`, and the Compose file keeps its bindings. A Tailscale sidecar container was considered and not chosen:
  - it would need Serve to proxy to a Docker service name (not documented);
  - it adds its own state volume;
  - sharing its network namespace with the harness would give the harness Tailscale's full egress (research 15).
- **Two UIs on one name:** use two HTTPS ports (`--https=443` for the App, `--https=8443` for the terminal) rather than a path. That avoids the question of whether Serve strips a `--set-path` prefix (unconfirmed) and the need to give ttyd `-b`.
- **Host SSH can go over the tailnet** (plain `sshd` bound to the Tailscale address, or Tailscale SSH). The Hetzner firewall then allows nothing inbound at all.

## What the harness must check itself (S12)
- **ttyd's `-H <header>` only requires the header to be present.** Any value passes, so it proves only that the request came through something that adds it. ttyd hands the value to its command as `TTYD_USER`. **`gaffer-pi` compares it with the allowed login** and refuses to start Pi otherwise.
- **`gaffer-web` today refuses any non-loopback Host** (`421 wrong host`) and expects Origin `http://<host>`. With a front door it must also accept one configured public origin (`https://<machine>.<tailnet>.ts.net[:port]`), and require the identity header to equal the allowed login on every route, the event stream included.
- **ttyd's `--check-origin` compares Origin with Host.** If Serve passes the browser's Host through unchanged, nothing changes. If it rewrites Host to the backend's (`127.0.0.1:7681`), the terminal's WebSocket will be refused, and the door has to put the public Host back. **Unconfirmed**; it's the first check on a real tailnet (TASKS-2).

## Sources
- Tailscale Serve, identity headers ("If Serve finds the following headers on an incoming request, it will remove them"; "not populated for traffic originating from tagged devices"; listen on localhost). Last validated 2026-01-20, re-checked 2026-10-23: https://tailscale.com/kb/1312/serve
- Tailscale Serve CLI (`--https`, `--set-path`), read 2026-10-23: https://tailscale.com/kb/1242/tailscale-serve
- Tailscale pricing (Personal, free, 6 users), read 2026-10-23: https://tailscale.com/pricing
- Tailscale identity providers, read 2026-10-23: https://tailscale.com/kb/1013/sso-providers
- Tailscale on iOS (15.0+), read 2026-10-23: https://tailscale.com/kb/1020/install-ios
- Tailscale Funnel (public; no identity headers), read 2026-10-23: https://tailscale.com/kb/1223/funnel
- Tailscale in Docker (`TS_SERVE_CONFIG`, `TS_STATE_DIR`, userspace networking), read 2026-10-23: https://tailscale.com/docs/features/containers/docker/docker-params
- Tailscale issues #18827 (WebSocket drops over Serve, on WSL2, unresolved) and #18651 (query strings on Funnel WebSockets), read 2026-10-23: https://github.com/tailscale/tailscale/issues/18827, https://github.com/tailscale/tailscale/issues/18651
- Cloudflare Access self-hosted apps (an active zone is required), read 2026-10-23: https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/
- Cloudflare quick tunnels ("do not support Server-Sent Events"), read 2026-10-23: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/
- Cloudflare Access JWT validation, read 2026-10-23: https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
- Domain prices (a third-party tracker of Cloudflare Registrar, data 2026-10-21), read 2026-10-23: https://cfdomainpricing.com/
- Let's Encrypt rate limits and IP certificates (GA 2026-01-15), read 2026-10-23: https://letsencrypt.org/docs/rate-limits/, https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability
- oauth2-proxy configuration, read 2026-10-23: https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview
- ttyd options (`-H`, `--check-origin`, `--max-clients`), and spike S12 (2026-10-23): https://github.com/tsl0922/ttyd

## Unconfirmed
- **Whether Serve passes the browser's Host and Origin through unchanged.** This matters for ttyd's `--check-origin` and for `gaffer-web`. It's the first check on a real tailnet.
- **Whether two `--https` ports can be served at once** from one node's config. It's documented per port; running both together is untested.
- **WebSocket and SSE through Serve:** the docs don't mention them. The one open drop report (#18827) is on WSL2 and unconfirmed by maintainers.
- **Whether identity headers are set for requests that start on the serving node itself.** Gaffer doesn't need them: nothing on the host uses the UIs.
- **The Cloudflare Zero Trust free tier's user limit (50)** is from search summaries; the plans page didn't render. Not material once that option is rejected.
