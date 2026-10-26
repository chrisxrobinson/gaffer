# ADR 0015 — Sharing the local stack: Cloudflare Tunnel with Cloudflare Access in front

**Status:** Accepted · **Date:** 2026-10-26 · **Amends:** [ADR 0006](0006-deployment.md) (how the local deployment is reached) · **Requirements:** NFR-SEC-04, NFR-PRIV-02, NFR-SEC-01, -02, -05

## Context
Phase 2 was redefined on 2026-10-26: Gaffer stays on Docker Compose on the owner's Mac, and gets an HTTPS link the owner can open from a phone and send to a few trusted people. The AWS plan moves to Phase 3 unchanged.

Constraints:
- **No anonymous access.** Neither UI has its own login. A public link with no identity check would spend the owner's LLM budget and open the terminal to anyone. NFR-SEC-04 requires an identity check in front of anything that isn't local.
- **The ports stay bound to `127.0.0.1`.** Nothing listens on `0.0.0.0`.
- **ADR 0009's rules hold.** That means no user shell, a sandbox with no network or secrets, the LLM key only in the harness, hashed team IDs, and every new Pi built-in off.
- **`gaffer-web`'s Origin check and ttyd's `--check-origin`** must accept the link's hostname and still refuse every other origin.
- **Free, and no new service** unless the tunnel needs one.
- **Who gets in** (the owner's answer): the owner, plus one or two trusted people who may run Recommend for their own teams on the owner's key. Read-only viewers and many independent users are out of scope.
- **Long-lived connections.** The App's event stream (SSE) stays open through a run of about a minute. The terminal is a WebSocket.

## Options considered
Checked against each provider's documentation on 2026-10-26.

| | Identity in front, free | URL | Needs | WS / SSE | In the way |
|---|---|---|---|---|---|
| **1. Cloudflare Tunnel (remotely managed) + Access** | Access policy per hostname. Email allowlist, login by one-time PIN (or Google, GitHub). Zero Trust Free covers 50 users. | Stable, on the owner's domain | A domain on Cloudflare, a Cloudflare account; nothing for viewers | Both. WebSockets are on by default. SSE streams; 100 s to the first byte, and the App sends headers at once and a keep-alive every 15 s. | Cloudflare terminates TLS, so it can read the traffic |
| 2. Cloudflare quick tunnel (`trycloudflare.com`) | **None** | Random, changes every start | Nothing | Both | **Out:** no login can go in front |
| 3. Tailscale Serve | Tailnet identity, with headers to the app | Stable `*.ts.net` | Every viewer needs a Tailscale account and app, and must be in the tailnet or have the device shared with them | Both | Fine for the owner, too much to ask of a viewer |
| 4. Tailscale Funnel | **None** (public, no identity headers) | Stable | — | Both | **Out** |
| 5. ngrok, free tier | Google OAuth through a Traffic Policy, **3 monthly identities** | One assigned dev domain | An account | Both | A warning interstitial on HTML. 20,000 requests and 1 GB a month. 3 identities is the owner plus two. |
| 6. Others | zrok (OAuth on public shares; free-tier support unconfirmed), Pinggy (free URLs die every 60 min), Microsoft dev tunnels (viewers need the owner's GitHub org; preview) | | | | Not better than 1 |

## Decision
**Option 1.** It is free, the URL is stable, it allows an email allowlist of up to 50 users, viewers need nothing, and it supports both connection types. The owner already has a domain.

**One new moving part: `cloudflared`, the connector.**
- It is the `tunnel` service in `deploy/compose/docker-compose.yml`, under the Compose profile `tunnel`.
- Image: `cloudflare/cloudflared`, pinned by version and digest.
- Command: `tunnel --no-autoupdate run --token-file /run/secrets/cloudflared_token`.
- Network `egress` only, never `sandbox_net`, and no `ports:`.
- Read-only root, all capabilities dropped, `no-new-privileges`, the image's non-root user.

It dials out to Cloudflare, so nothing on the Mac listens beyond `127.0.0.1`. It reaches `http://gaffer:7682` (the App) and `http://gaffer:7681` (the terminal) on the Compose network, where both already bind. There is no reverse proxy, auth service or other container.

**Credentials.** The tunnel token is a Compose secret file, `deploy/compose/secrets/cloudflared_token` (gitignored, like the API key). Only `cloudflared` gets it. The LLM key and the ID salt stay in `gaffer` only.

**Hostnames and Access.**
- `GAFFER_PUBLIC_APP_HOST` and `GAFFER_PUBLIC_TERMINAL_HOST` come from `deploy/compose/.env` (gitignored).
- Each hostname is a published route of the tunnel and a self-hosted Access application:
  - **App:** the owner and the trusted few, by email.
  - **Terminal:** the owner only. ROADMAP has always kept the terminal operator-only; widening it is one policy edit.
- Login is a one-time PIN by email, and a session lasts 24 hours.
- Each route has **Protect with Access** on, so `cloudflared` checks the Access JWT before forwarding. A request that reaches the connector without a valid token gets no further.
- The harness doesn't validate the JWT itself. That would need the harness to fetch Cloudflare's signing keys, a new third-party request from the container that holds the key (NFR-PRIV-02).

**Origin checks.**
- `gaffer-web` accepts what it accepted before: a loopback `Host` with `Origin: http://<that host>`. It now also accepts `Host` equal to `GAFFER_PUBLIC_APP_HOST` with `Origin: https://<that host>`. Any other host is still 421, and any other origin still 403. With the variable unset, the public name is refused like any other.
- The App's *Open in terminal* link points at the public terminal hostname when the App was opened on its public hostname.
- ttyd's `--check-origin` is unchanged: it accepts a WebSocket only when the Origin's host equals `Host`, and through the tunnel both are the terminal hostname. It refuses any other origin by closing the connection without a reply.
- `packages/gaffer-web/test/bridge.test.ts` and `deploy/compose/tests/verify.sh` show both: the public hostname is accepted, and other origins are refused.

**On and off** (from `deploy/compose`):
- **On:** `docker compose up -d tunnel`
- **Off:** `docker compose stop tunnel`

A plain `docker compose up` doesn't start it, and Gaffer works locally exactly as before. The gaffer service gets the hostnames whether the tunnel runs or not, so switching it never recreates the harness.

**Budget caps unchanged:** $1.50 a session and $5.00 a day. The daily cap bounds what the trusted few can spend on the owner's key. The run lock (ADR 0014) still allows one run at a time, so one person's run makes another's wait.

## Consequences
- **NFR-SEC-04 is met for shared use:** an identity check in front of both UIs, and the ports are still localhost-only.
- **Cloudflare is a new party in the browser's path.** It terminates TLS, so it can read what passes through: prompts, recommendations and the team numbers people type in. The harness's own egress doesn't change: it still talks only to the LLM provider, FPL and football-data. The tunnel's traffic goes from the `cloudflared` container to Cloudflare's edge.
- **Everyone allowed into the App sees every session**, the owner's included, because the App has no per-user separation. This is acceptable for a trusted few and is the reason the allowlist stays short. Per-user sessions, data and caps remain Phase 4 (multi-user) work.
- Access sessions expire after 24 hours. An expired session shows as a failed request in the App until the page is reloaded and the person signs in again.
- Cloudflare account, DNS and Access policy are configuration outside the repo, set by the owner in the dashboard. README lists the steps.
- **Numbering:** the unmerged `phase-2-plan` branch holds AWS ADRs numbered 0015–0020. If that plan is merged, its ADRs take 0016 onwards.
