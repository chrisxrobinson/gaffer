# S13 — Can a container on an internal-only network publish a port?

**Question:** S11 puts the harness only on `internal: true` networks so its one way out is the egress proxy. Can Docker still publish its ports (7681, 7682) on the host's `127.0.0.1`, where a front door on the host would reach them?

**Method** (2026-10-23, Docker Engine 27.3.1 in Docker Desktop): two Caddy containers publish `127.0.0.1:17698` and `127.0.0.1:17697`. One sits only on an internal network; the other has a second, ordinary network as well. Then `curl` each.

**Result** (`results.txt`):
- **Internal only:** no answer (`curl` exit 7). Docker gives a container on an internal-only network no published port.
- **Internal plus an ordinary network:** answers. But an ordinary bridge network has a NAT route out, which would let the harness bypass the egress proxy.

**Impact on the design (ADRs 0016 and 0017):**
- The harness can't both publish its ports and have no route out.
- A small reverse-proxy container (`door`, Caddy) sits on an ordinary network and on the harness's internal `front` network, and publishes `127.0.0.1:7681` and `:7682`. The harness stays internal-only: `front` and `egress_in` towards the proxies, and `sandbox_net` towards the sandbox.
- Considered and not chosen: an ordinary bridge with IP masquerade turned off (`com.docker.network.bridge.enable_ip_masquerade=false`). Packets would still leave the host with a private source address. That's weaker and harder to test than having no route at all.
