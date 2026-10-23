# R13 — Where Gaffer runs in Phase 2: a small host

*Researched 2026-10-23 against live vendor pages; prices exclude VAT. Key claims re-checked by hand: Hetzner's availability and price table, Cloudflare's disk model.*

## TL;DR
- **Hetzner Cloud, one VPS, the same Compose file.** It keeps everything Gaffer depends on: a real filesystem for Pi's JSONL sessions, an `internal: true` network for a network-free sandbox, gVisor (`runsc`, on both x86_64 and ARM64), and Docker Engine on Ubuntu 24.04 for both architectures.
- **The catch: stock.** Every Cost-Optimized plan is shown as **"not available"** today: CX23, CAX11, CX33 and CAX21, ARM and x86 alike. Hetzner says "the number of available servers is limited". Its status page has had a "Limited availability of cloud instances" notice open since 2026-06-26. The Regular Performance line (CPX, AMD) can be ordered, at about three times the price.
- **Cloudflare Containers doesn't fit the harness.** Container disk is ephemeral ("a fresh disk from the container image" after sleep), images must be linux/amd64, and there's no persistent volume (only FUSE to R2, which Cloudflare warns isn't SSD-like). Pi's session store is a filesystem, and moving it would mean replacing Pi's `SessionManager`, which contradicts the Pi-package thesis. It *could* run the sandbox with no network (`enableInternet = false`), but the harness is the hard part.
- **Fly.io:** about $25/month for a 2-shared-vCPU / 4 GB Machine, amd64. No documented way to give a Machine zero egress.
- **Oracle's Always Free A1:** free and ARM, but Oracle "may" reclaim instances that look idle for 7 days (95th-percentile CPU, network and memory all below 20%). Gaffer looks exactly like that most of the week.

## Options for this workload
The workload: one user, a few runs a week, each about a minute of heavy CPU (the solver at up to 2 vCPU), always on for the terminal, the App and the scheduler.

| Option | €/month (excl. VAT) | Orderable 2026-10-23 | Persistent disk | Sandbox with no network | gVisor | Arch |
|---|---|---|---|---|---|---|
| Hetzner CAX11 (2 vCPU Ampere / 4 GB / 40 GB) | 5.99 + 0.50 IPv4 = **6.49** | **No** | Yes | Yes | Yes | arm64 |
| Hetzner CAX21 (4 vCPU Ampere / 8 GB / 80 GB) | 10.49 + 0.50 = **10.99** | **No** | Yes | Yes | Yes | arm64 |
| Hetzner CX33 (4 vCPU Intel/AMD / 8 GB) | 8.49 + 0.50 = 8.99 | **No** | Yes | Yes | Yes | amd64 |
| Hetzner CPX22 (2 vCPU AMD / 4 GB / 80 GB) | 19.49 + 0.50 = **19.99** | Yes | Yes | Yes | Yes | amd64 |
| Hetzner CPX32 (4 vCPU AMD / 8 GB) | 35.49 + 0.50 = 35.99 | Yes | Yes | Yes | Yes | amd64 |
| Cloudflare Containers (always-on harness) | ≈ $32 (R13's calculation: Workers Paid $5 plus usage) | Yes | **No** | Yes | n/a (Firecracker) | amd64 only |
| Fly.io (shared-cpu-2x, 4 GB, volume) | ≈ $25 plus $0.15/GB volume | Yes | Yes | Not documented | Not documented | amd64 |
| Oracle Always Free A1 | 0 | Yes (capacity varies) | Yes | Yes | Yes | arm64 |

Hetzner details:
- **Prices** are from Hetzner's "Price Adjustment 15 June 2026" table for Germany (FSN/NBG) and Finland (HEL), the "new price" column. Existing servers kept their old prices.
- **IPv4** is €0.50/month and optional. Gaffer keeps it: FPL, Anthropic and Tailscale's relays are all reachable over IPv4.
- **Traffic:** 20 TB included.
- **Locations:** Cost-Optimized plans list NBG1 and HEL1 (FSN on some). Hetzner offers no ARM in the US.
- **Server Backups** cost 20% of the server price and keep 7 daily slots.

## Sizing
- **What the box has to hold:** the sandbox is limited to 2 vCPU and 2 GB, and the golden path runs the solver at full CPU for up to 60 s (NFR-LAT-03; 31.6–49.2 s on the Mac in the Phase 1.1 gates). The harness (Node, Pi, ttyd, `gaffer-web`) uses well under 1 GB.
- **Two vCPU (CAX11, CPX22):** the solve takes the whole machine. The harness's event stream to the UIs then shares a starved CPU. 4 GB of RAM is enough.
- **Four vCPU / 8 GB (CAX21):** headroom for the harness during a solve, at €4.50 more than CAX11.
- **Ampere per-core speed:** Ampere Altra cores are slower per core than the M-series the latencies were measured on. **No published figure ties this to HiGHS**, so the golden path's time on the chosen box is an M2-1 measurement (NFR-LAT-03).

## Latency
No published measurements were found from Hetzner's German or Finnish sites to `api.anthropic.com`, or to FPL (Fastly). The model call dominates each run (tens of seconds) and FPL's CDN is global, so the site matters little. It's measured in M2-1, not assumed.

## Sources
- Hetzner Cost-Optimized plans and the "not available" badges, read 2026-10-23 (badge visibility checked in the browser): https://www.hetzner.com/cloud/cost-optimized/
- Hetzner Regular Performance plans (orderable), read 2026-10-23: https://www.hetzner.com/cloud/regular-performance/
- Hetzner Price Adjustment 15 June 2026 (the price table; page updated 2026-07-08), read 2026-10-23: https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/
- Hetzner IPv4 pricing, read 2026-10-23: https://docs.hetzner.com/general/infrastructure-and-availability/ipv4-pricing
- Hetzner backups (20%, 7 slots) and snapshots, read 2026-10-23: https://docs.hetzner.com/cloud/billing/faq/ and https://docs.hetzner.com/cloud/servers/backups-snapshots/overview/
- Hetzner status page, "Limited availability of cloud instances" since 2026-06-26, read 2026-10-23 (R13 subagent): https://status.hetzner.com/
- gVisor install guide ("supports x86_64 and ARM64, and requires Linux 5.6+"), read 2026-10-23: https://gvisor.dev/docs/user_guide/install/
- Docker Engine on Ubuntu (Noble, arm64 and amd64), read 2026-10-23: https://docs.docker.com/engine/install/ubuntu/
- Cloudflare Containers FAQ ("All disk is ephemeral by default"), re-checked 2026-10-23: https://developers.cloudflare.com/containers/faq/
- Cloudflare Containers pricing, GA changelog (2026-04-13), outbound traffic and architecture, read 2026-10-23: https://developers.cloudflare.com/containers/pricing/, https://developers.cloudflare.com/changelog/product/containers/, https://developers.cloudflare.com/containers/platform-details/outbound-traffic/, https://developers.cloudflare.com/containers/platform-details/architecture/
- Fly.io pricing and private networking, read 2026-10-23: https://docs.fly.io/about/pricing, https://docs.fly.io/networking/private-networking/
- Oracle Always Free resources and idle reclaim, read 2026-10-23: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm

## Unconfirmed
- **When Cost-Optimized plans will be orderable again.** There's no date on the product pages or the status page.
- **Hetzner Volume price per GB.** It isn't shown on the block-storage page or in the docs. Gaffer doesn't need a Volume: the server's own disk holds a few hundred MB.
- **A reported 2026-04-01 price rise.** Only third parties report it; Hetzner's docs show only the 2026-06-15 round.
- **HiGHS solve time on Ampere Altra cores** against the M-series baseline. No source; measured in M2-1.
- **The Fly.io price for Frankfurt**, and how Cloudflare Containers behaves with open WebSockets during host restarts. Not material once those options are rejected.
