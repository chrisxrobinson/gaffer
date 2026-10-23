# S12 — Identity from a front door, checked by ttyd and gaffer-web

**Question:** if a front door (Tailscale Serve in the design) sets an identity header, what do ttyd's `-H` and today's `gaffer-web` do with it? Can a client forge it?

**Method** (2026-10-23, Docker Desktop 27.3.1; `docker compose up -d` here):
- `door` is Caddy 2.10, standing in for Tailscale Serve. It publishes `127.0.0.1:17699`, routes `/terminal*` to ttyd and everything else to `gaffer-web`, and sets `Tailscale-User-Login: owner@example.com`, replacing anything the client sent.
- `harness` is `gaffer-harness:local` running `gaffer-web` (empty session and data directories) and `ttyd -H Tailscale-User-Login --check-origin`, whose command prints `TTYD_USER`.
- `outsider` sits on another network.
- `ws-probe.mjs` opens the terminal's WebSocket the way the page does.

**Result** (`results.txt`):
- **ttyd `-H` checks only that the header is there, not its value.** Straight to ttyd without the header: `407 Proxy Auth Required`. With *any* value (`anyone@evil`): `200`. So ttyd must be reachable only through the door, and the value has to be checked elsewhere.
- **The command sees the value as `TTYD_USER`.** Through the door, the terminal's command printed `user=owner@example.com`, even when the client also sent `Tailscale-User-Login: attacker@example.com`; the door's value replaced it. `gaffer-pi` can therefore refuse to start Pi unless `TTYD_USER` is the allowed login: that's the value check for the terminal.
- **`--check-origin` needs the page's Origin.** A WebSocket with no Origin, or a different one, is refused ("refuse to serve WS client from different origin"). It compares Origin with Host, so the door must pass Host through unchanged. Whether Tailscale Serve does is **unconfirmed** (research 14).
- **`gaffer-web` refuses any non-loopback Host.** A real hostname gets `421 {"error":"wrong host"}` (`bridge.ts` `LOOPBACK`), and its Origin check expects `http://<host>`. Behind an HTTPS door with a `*.ts.net` name, every request would fail. It needs a configured public origin (scheme and host) besides loopback.
- A container on another Docker network can't even resolve the harness (`ENOTFOUND`).

**Impact on the design (ADR 0016):**
- `gaffer-web` gets three settings: `GAFFER_PUBLIC_ORIGIN` (its accepted Host and Origin, besides loopback), `GAFFER_IDENTITY_HEADER` and `GAFFER_ALLOWED_LOGIN`. It refuses any request whose header is missing or different, and trusts the header only from the door's address.
- `gaffer-pi` checks `TTYD_USER` when the same settings are present.
- ttyd and `gaffer-web` are reachable only on a network shared with the door.
