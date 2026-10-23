# S11 — An allowlisting egress proxy for the harness

**Question:** can the harness be limited to the LLM provider, FPL and football-data, with everything else failing, using only containers (so the same setup runs on any Docker host)? And does Node 24 send Pi's and Gaffer's `fetch` calls through a proxy?

**Method** (2026-10-23, Docker Desktop 27.3.1, arm64; `docker compose up -d` in this directory):
- `client` is the live harness image (`gaffer-harness:local`, Node 24.21.0). Its only network is `inside` (`internal: true`), and it has `NODE_USE_ENV_PROXY=1` and `HTTPS_PROXY=http://proxy:3128`.
- `proxy` runs `ubuntu/squid:6.6-24.04_edge` (Squid 6.14) on `inside` and `outside`, with `squid.conf`. It allows only CONNECT on 443 to a hostname in the allowlist, and refuses a CONNECT to an IP literal.
- `probe.mjs` runs inside `client` with Node's `fetch`.

**Result** (`results.txt`):
- **Node needs the switch.** Without `NODE_USE_ENV_PROXY=1`, Node 24.21's `fetch` ignores `HTTPS_PROXY`: a bogus proxy still gives a 200 direct. With it, the bogus proxy gives `ECONNREFUSED`. The proxy is therefore a routing convenience; the enforcement is the internal network.
- **Allowed hosts work:** FPL bootstrap 200, Anthropic 401 (no key, but reachable), `football-data.co.uk` 200.
- **Everything else is refused by Squid** (`TCP_DENIED/403`): `example.com`, an IP literal (FPL's Fastly address), `www.football-data.co.uk` (not a host the code uses), plain HTTP (Node tunnels it as `CONNECT :80`), and an allowed name on port 8443.
- **There is no way round the proxy.** Without the proxy env, `example.com` doesn't resolve (`EAI_AGAIN`). A raw TCP connect to `140.248.134.133:443` gets `ENETUNREACH`. Docker's embedded DNS answers only container names on an internal network, so DNS isn't a channel out either.
- **The allowlist must name the code's hosts exactly.** The first run allowed `www.football-data.co.uk`, but Gaffer calls the apex (`packages/pi-gaffer/src/odds.ts:18`), and `www.` redirects there. The fix was to allow the apex only.

**Impact on the design:**
- ADR 0017 adopts this pattern: the harness only on internal networks, and a Squid proxy as its one exit. Pin Squid's image by digest, add `dstdomain -n` (so Squid never reverse-resolves an IP into a match; research 15), and use Node ≥ 24.22 (the `NO_PROXY` matching and CVE fixes; research 15).
- A side effect: the harness can no longer publish ports itself (spike S13), so a small reverse proxy fronts it.
