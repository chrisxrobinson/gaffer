# ADR 0016 — Front door and identity: Tailscale Serve on the host, identity checked again in the harness

**Status:** Proposed (Phase 2 plan, for your review) · **Date:** 2026-10-23 · **Supersedes in part:** [ADR 0005](0005-web-tui.md) and [ADR 0006](0006-deployment.md) (the Phase 2 ALB, OIDC and `-H X-Amzn-Oidc-Identity` lines) · **Evidence:** [research 14](../research/14-front-door-identity.md), spikes [S12](../../spikes/s12-identity-header/README.md) and [S13](../../spikes/s13-internal-publish/README.md) · **Requirements:** NFR-SEC-04, NFR-SEC-10, FR-ADM-02, NFR-A11Y-01 (phone)

## Context
- **What you need:** to reach both UIs from your laptop and your phone, with only you getting in. You don't own a domain and left the sign-in method to this plan.
- **What the harness enforces today:** both ports are published on `127.0.0.1` only (NFR-SEC-04). `gaffer-web` refuses any non-loopback Host and any Origin other than `http://<host>` (`bridge.ts`). ttyd checks Origin against Host and allows one client.
- **What S12 found about the harness behind a door:**
  - ttyd's `-H` checks only that the header is present, not its value.
  - The value reaches ttyd's command as `TTYD_USER`.
  - `gaffer-web` returns 421 to a real hostname.
- **What S13 found:** a container on internal networks only can't publish a port. That matters because the egress allowlist (ADR 0017) keeps the harness internal-only.

## Options considered
1. **Tailscale, `tailscale serve` on the host.** **Chosen.**
   - HTTPS on `<machine>.<tailnet>.ts.net`, with no domain.
   - Nothing open to the internet.
   - Free for personal use.
   - The phone gets the Tailscale app.
   - Sign-in through the tailnet's identity provider.
   - Serve adds `Tailscale-User-Login` and strips client copies.
2. **Tailscale as a sidecar container.** Rejected:
   - Serve proxying to a Docker service name isn't documented.
   - It needs its own state volume.
   - Sharing its network namespace would give the harness Tailscale's egress.
3. **Cloudflare Tunnel with Access.** Rejected:
   - It needs a domain on Cloudflare.
   - A JWT has to be verified against rotating keys.
   - Quick tunnels can't carry the App's SSE.
4. **Caddy with oauth2-proxy and Google.** Rejected:
   - It's public on 80/443.
   - It needs a DNS name, and free wildcard-DNS names hit Let's Encrypt's shared rate limits.
   - It's two more services, plus an OAuth client.
5. **WireGuard alone.** Rejected: no identity reaches the app, and keys are managed by hand per device.

## Decision
- **The front door is Tailscale Serve, running as `tailscaled` on the host:**
  - `https://<machine>.<tailnet>.ts.net/` (port 443) proxies to `http://127.0.0.1:7682`, the App;
  - `https://<machine>.<tailnet>.ts.net:8443/` proxies to `http://127.0.0.1:7681`, the terminal.

  Using two ports rather than a path avoids rewriting paths under ttyd. **Funnel stays off.**
- **The tailnet:**
  - You sign in with your chosen identity provider (Google, Apple, GitHub, Microsoft or a passkey).
  - The server joins tagged `tag:gaffer`. Your laptop and phone join as **your own untagged devices**: identity headers aren't set for traffic from tagged devices.
  - The tailnet policy lets only your user reach `tag:gaffer` on 443 and 8443, and on 22 for SSH.
- **Ports stay where they are:** the Compose file keeps publishing `127.0.0.1:7681` and `127.0.0.1:7682`, which is Tailscale's advice for header-authenticated backends. Because the harness is internal-only (ADR 0017), the binding moves to a small **`door` container** (Caddy, pinned by digest). `door` is on an ordinary network and on the harness's internal `front` network, publishes the two loopback ports, and passes Host, Origin and the identity header through unchanged. Nothing else is on `front`.
- **The harness checks identity itself** when `GAFFER_ALLOWED_LOGIN` is set (on the server; unset on the Mac, where loopback is the boundary):
  - **`gaffer-web`:**
    - accepts Host and Origin for loopback and for `GAFFER_PUBLIC_ORIGIN` (for example `https://gaffer.tail1234.ts.net`);
    - requires `Tailscale-User-Login` (the name is configurable, `GAFFER_IDENTITY_HEADER`) to equal `GAFFER_ALLOWED_LOGIN` on every route, the event stream included, and answers 401 otherwise;
    - trusts the header only from `door`'s address on `front`;
    - logs at start-up which mode it is in.
  - **ttyd** runs with `-H Tailscale-User-Login`, and **`gaffer-pi`** refuses to start Pi unless `TTYD_USER` equals `GAFFER_ALLOWED_LOGIN`. A refused terminal shows one line and no Pi.
  - **The admin report (FR-ADM-02)** is served by `gaffer-web` at `/admin`, read-only, behind the same check. It reads `admin.html` from `/data/admin`.
- **SSH to the host** listens only on the Tailscale interface (or through Tailscale SSH). Hetzner's Cloud Firewall allows nothing inbound.

## Consequences
- **The answer to "do I need a domain?" is no.**
- **Sign-in is your tailnet login.** A stolen laptop or phone that's still logged in to the tailnet is the residual risk. Mitigate it with your identity provider's two-factor authentication and Tailscale's key expiry, and by removing a lost device in the admin console.
- **The bind address changes.** Today ttyd and `gaffer-web` bind to the interface with the default route (`harness/egress-ip.mjs`). An internal-only harness has none, and the script exits 1 (checked 2026-10-23, S13's README). In the overlay they bind to the `front` interface, and never to `sandbox_net`.
- **Code changes, all in M2-0:**
  - three settings in `gaffer-web` and its tests;
  - the `/admin` route;
  - a check of `TTYD_USER` in `gaffer-pi`;
  - the `door` service;
  - new tests: no header, a wrong header, and a forged header from outside `front` are each refused on every route and on the terminal's WebSocket.
- **First checks on a real tailnet**, in M2-0 if you create a free tailnet early, otherwise M2-1 step 1:
  - Does Serve pass the browser's Host and Origin through unchanged? ttyd's `--check-origin` and `gaffer-web` depend on it.
  - Can 443 and 8443 be served together?
  - Do WebSocket and SSE run for a whole recommendation without dropping?

  If Serve rewrites Host, `door` restores the public Host from configuration before it forwards.
- **ttyd's one-client limit stays.** The terminal page's reconnect message should say "open in another tab" (BUILD.md, Phase 1.1 close, Proposed).
- **The phone:** the App's phone layout (NFR-A11Y-01) is now reachable on a real phone for the first time.
- **New requirement NFR-SEC-10**, and NFR-SEC-04 and FR-ADM-02 are reworded (REQUIREMENTS).
