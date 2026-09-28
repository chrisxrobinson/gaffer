# R6 — Deployment research: Gaffer (Pi harness + Python sandbox + session log + web UI + FPL data)

*Researched 2026-09-27 against live sources. Prices are list prices, us-east-1 unless stated, and change often. Re-check them before committing budget numbers.*

## TL;DR

- **Brain/hands split works in Pi without forking.** Pi's built-in tools take pluggable `*Operations` backends (`createBashTool(cwd, { operations })`). An extension can register a tool with the same name as a built-in (`bash`, `read`, `write`, `edit`) to replace it. Pi ships `ssh.ts` and `gondolin/` examples that do this, routing tools to a remote host or micro-VM. Gaffer should do the same with a small **sandbox exec client**. Pi stays in the harness container, and `bash`/`python` calls go to a separate sandbox over an internal HTTP exec API. Avoid `docker exec` through a mounted Docker socket.
- **Local MVP:** Docker Compose with 4 services: `web+harness`, `sandbox`, `fpl-data`, and an optional `otel-collector`. Harden the sandbox: read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, default seccomp, pids/mem/cpu limits, `runtime: runsc` (gVisor) where available, and **no network**, with FPL data mounted read-only.
- **AWS single-user:** ECS Fargate. One always-on service runs web+harness behind an ALB (WebSockets are native; raise the idle timeout). Sandboxes are Fargate tasks. **Fargate already gives each task its own VM isolation boundary**, so gVisor is neither needed nor possible there. Fargate cold starts are tens of seconds, so provision lazily and **keep 1 warm task** (or one per active session). Sessions live as JSONL on EFS, with S3 snapshots. The LLM key sits in Secrets Manager, injected only into the harness task.
- **Multi-user:** ALB `authenticate-oidc`/Cognito (or oauth2-proxy off-AWS), per-user sandbox task/VM, Postgres for the session index, budgets, and rate limits, and OTel GenAI spans for cost attribution. Consider a managed microVM sandbox (E2B/Modal/Deno Sandbox/AgentCore Code Interpreter) if Fargate cold start or task churn becomes the bottleneck.

---

## 1. What Pi's containerization doc recommends, and how to point `bash` at a separate container

### 1.1 The doc ("Run Pi in an isolated environment")

Pi offers four methods ([containerization](https://pi.dev/docs/latest/containerization); source `packages/coding-agent/docs/containerization.md` in `earendil-works/pi`):

| Method | Where Pi runs | What is isolated | Credentials |
|---|---|---|---|
| Plain Docker | Container | Pi, built-in tools, `!` commands, extensions | "Credentials passed into the container" |
| Docker Sandboxes (`sbx`) | Managed sandbox | Same as plain Docker | "Provider credentials remain on the host and are substituted by the proxy" |
| NVIDIA OpenShell | Local or remote sandbox | Same as plain Docker | "Policy-controlled credentials and inference routing" |
| Gondolin extension | **Host** | Built-in tools and `!` commands only | Stored creds stay on host, "but commands inherit host environment variables" |

Key points:
- The doc supports both models: *"You can isolate the complete Pi process or keep Pi on the host and route selected tools into an isolated environment."*
- Tool-only isolation has a caveat: *"Tool-only isolation does not constrain the host Pi process or extension tools that do not use the isolated backend."* Every Gaffer extension tool that runs model-authored code must therefore delegate to the sandbox too.
- Gondolin carries a credential warning: *"Commands inside the VM inherit the host process environment. Provider keys supplied through environment variables can therefore be visible inside the VM."* A custom exec backend must build the sandbox environment from an explicit allowlist and never forward `process.env`.
- The plain Docker recipe (`node:24-bookworm-slim`, `npm i -g @earendil-works/pi-coding-agent`, `-e ANTHROPIC_API_KEY`, named volume for `/root/.pi/agent`) puts the key *inside* the boundary. That is the opposite of what Gaffer wants.
- Pi's [security page](https://pi.dev/docs/latest/security) says to *"Treat model-generated commands and code as untrusted"* and *"Keep credentials outside the environment where possible."*

### 1.2 Mechanism for routing `bash` elsewhere (verified in source)

- `examples/extensions/tool-override.ts`: *"Extensions can register tools with the same name as built-in tools to replace them … Routing tool calls to remote systems (e.g., pi-ssh-remote)"*.
- `examples/extensions/ssh.ts` imports `BashOperations, createBashTool, ReadOperations, WriteOperations, EditOperations` from `@earendil-works/pi-coding-agent`. It implements `BashOperations.exec(command, cwd, { onData, signal, timeout }) → { exitCode }`, and then calls `pi.registerTool({ ...localBash, execute: … createBashTool(localCwd, { operations: remoteOps }).execute(...) })`. Streaming output (`onData`), abort (`signal`), and timeout are all part of the interface.
- `examples/extensions/gondolin/index.ts` does the same for `read/write/edit/bash/grep/find/ls` against a QEMU micro-VM.
- `examples/extensions/sandbox/` wraps bash in `@anthropic-ai/sandbox-runtime` (bubblewrap/sandbox-exec) with domain allowlists. Its comment notes you can alternatively sandbox bash *"via `tool_call` input mutation without replacing the tool."*
- Pi's SDK ([sdk.md](https://pi.dev/docs/latest/sdk)) exposes `tools`, `noTools`, `excludeTools`, and `customTools` on `createAgentSession`, plus a pluggable `SessionManager` (`SessionManager.inMemory()` or persistent).

**Options for Gaffer's transport, ranked:**

1. **HTTP/gRPC exec agent inside the sandbox (recommended).** A tiny server in the sandbox image exposes `exec` (streamed), `put_file`, and `get_file`. The harness implements `BashOperations`/`ReadOperations`/`WriteOperations` against it. This is the managed-agents `execute(name, input) → string` shape, and it works identically in Compose (service DNS), Fargate (task private IP), and E2B/Modal (swap the backend for their SDKs).
2. **`docker exec` via the Docker API.** This is simple locally, but the harness then needs the Docker socket, and Docker's docs say *"Only trusted users should be allowed to control your Docker daemon"* because the daemon runs as root ([Docker security](https://docs.docker.com/engine/security/)). A prompt-injected harness plus the socket gives host root. Use only in dev, and if you must, put a socket proxy in front.
3. **SSH (the Pi `ssh.ts` pattern).** Workable but adds key management. The exec API gives the same result with less work.
4. **Whole-process isolation (Pi inside the sandbox).** Rejected. It puts the LLM key and session log inside the untrusted boundary, which contradicts the brain/hands/session split.

> Spike S1 should confirm that same-name registration replaces `bash` for the model's tool list in the current Pi release (the examples show it; runtime behaviour is still unverified).

---

## 2. Sandbox options compared

Workload profile: short Python runs (pandas/numpy plus a MILP solve via SciPy `milp`/HiGHS, PuLP+CBC, or OR-Tools), roughly 1 vCPU / 1–2 GB, seconds to a minute each, bursty within a session of about 5–30 minutes.

| Option | Isolation strength | Cold start | Cost (list, ~1 vCPU + 2 GB for 1 h) | Self-hostable | AWS mapping | Notes for Gaffer |
|---|---|---|---|---|---|---|
| **Hardened Docker (runc)** — read-only rootfs, `no-new-privileges`, `cap_drop: ALL`, default seccomp (blocks ~44 syscalls), pids/mem/cpu limits, `network_mode: none` | Weakest: shared host kernel; namespaces + cgroups + seccomp | ~<1 s (container start; image cached) | Host cost only | Yes | ECS on EC2 (not Fargate-specific) | Fine for **single-user local MVP** where the only tenant is you. |
| **gVisor (`runsc`)** | Strong: user-space "application kernel" intercepts syscalls; defence-in-depth | ~sub-second to ~1 s (unverified number) | Host cost only; syscall-heavy perf penalty | Yes (OCI runtime, Docker/K8s) | ECS on EC2 or EKS (GKE Sandbox natively). **Not on Fargate** (no custom runtime; only `CAP_SYS_PTRACE` addable) | Drop-in `runtime: runsc` in Compose. `systrap` platform works inside VMs (no nested virt needed). |
| **Firecracker / Kata** | Strongest self-host: hardware virt, own guest kernel | ~125 ms boot (Firecracker claim), snapshots faster | Host cost; needs KVM | Yes, but ops-heavy | Needs bare metal **or** nested virt on C8i/M8i/R8i/C7i/M7i/R7i etc. (GA Feb 2026) | Overkill until multi-user self-host at scale. |
| **AWS Fargate task per session** | Strong: *"Fargate runs each workload on an isolated virtual environment"*; tasks don't share kernel/CPU/mem/ENI | **Slow: ~10–60 s+** (ENI + image pull; SOCI lazy-load helps) | x86: $0.000011244/vCPU-s + $0.000001235/GB-s ⇒ **≈$0.049/h**; ARM ≈ **$0.040/h**; 1-min minimum; Spot up to 70% off | No (managed) | Native | Best AWS-native isolation per $. Cold start forces **warm pool / lazy + keep-alive**. |
| **AWS Lambda per exec** | Strong (Firecracker) | ~sub-second warm, seconds cold with big numeric deps | $0.0000166667/GB-s x86 ⇒ 2 GB ≈ $0.12/h of *busy* time; $0.20/M req | No | Native | Stateless per call; 15-min cap; no session-scoped filesystem. OK for "run this script on this snapshot", awkward for iterative notebooks. |
| **AWS Bedrock AgentCore Code Interpreter** | microVM per session (per AWS/secondary sources) | seconds (unverified) | ~$0.0895/vCPU-h + $0.00945/GB-h, active CPU only (secondary source) | No | Native | Managed "hands" with sessions up to 8 h. Worth a spike if staying on AWS. |
| **E2B** | Firecracker microVM per sandbox | ~150 ms (snapshot restore; secondary sources) | $0.000014/vCPU-s + $0.0000045/GiB-s ⇒ **≈$0.083/h** (1 vCPU/2 GiB). Hobby free w/ $100 credit, 1-h sessions; Pro $150/mo, 24-h sessions | Yes: `e2b-dev/infra` Apache-2.0 (GCP; AWS beta); BYOC on AWS/GCP (enterprise) | BYOC into your VPC | Best-fit managed option: Python SDK, `allow_internet_access=False` or `allowOut` domain allowlist. |
| **Modal Sandboxes** | gVisor | ~1 s-class (unverified) | $0.00003942/physical-core-s (=2 vCPU) + $0.00000667/GiB-s ⇒ **≈$0.19/h**; $30/mo free | No | None (external) | `block_network=True`, CIDR allowlist, domain allowlist (beta). Timeouts to 24 h. |
| **Daytona** | "dedicated kernel" (per marketing) | "sub 90 ms" (vendor claim) | $0.0504/vCPU-h + $0.0162/GiB-h ⇒ **≈$0.083/h**; $200 free credit | **No longer**: OSS repo "no longer maintained" as of June 2026; core moved private | None | Don't bet on the self-host path. |
| **microsandbox** | libkrun microVM | "<100 ms" (M1, vendor claim) | Free (Apache-2.0) | Yes (macOS Apple Silicon, Linux KVM, Windows WHP) | EC2 w/ nested virt / metal | **Beta** ("Expect breaking changes"). Has host allowlists and "secrets that can't leak". Watch, don't depend. |
| **Deno Sandbox** | Firecracker microVM | fast (unverified) | $0.05/CPU-hour (CPU time) + $0.016/GB-h mem; Pro includes 40 CPU-h | No | None | Beta since 2026-02-03. Runs arbitrary Linux code, not only JS. |
| **Pyodide (WASM)** | Strong: WASM memory sandbox, no syscalls/sockets | fast after load; big first load | Free | Yes (in-process in Node/Deno or browser) | Any | Pyodide 314.x ships **pandas 3.0.2, numpy 2.4.6, scipy 1.18.0, highspy 1.13.1, cvxpy-base**, so `scipy.optimize.milp`/HiGHS is viable. **No PuLP/CBC, no OR-Tools, no threads/subprocess, sockets non-functional.** The model's `bash` becomes Python-only. |

**Does ECS Fargate support gVisor-like isolation?** It already exceeds it. AWS: *"Each task has a dedicated infrastructure capacity because Fargate runs each workload on an isolated virtual environment. Workloads that run on Fargate do not share network interfaces, ephemeral storage, CPU, or memory with other tasks."* Fargate also blocks privileged containers and restricts capabilities (only `CAP_SYS_PTRACE` can be added), so you **cannot** run `runsc` inside it, and there is no reason to. Caveat: **containers within one task share a network namespace and ephemeral storage**. The sandbox must therefore be its **own task**, never a sidecar of the harness task, or it could reach the harness on localhost and read its disk.

---

## 3. Topologies per phase

### Phase 0 — Local single-user MVP (Docker Compose)

```
browser ──ws/http──▶ [gaffer-app]  (web UI + Pi harness + Gaffer extensions)
                        │  LLM API key (env / .env, only here)
                        │── HTTPS ──▶ LLM provider
                        │── http (net: data) ──▶ [fpl-data]  (fetch + cache FPL API → parquet/sqlite)
                        │── http exec API (net: sandbox, internal) ──▶ [sandbox]
                        │── writes JSONL ──▶ volume: sessions/
[fpl-data] ──HTTPS──▶ fantasy.premierleague.com   (only service with FPL egress)
[sandbox]  no egress; mounts fpl-cache read-only; tmpfs /tmp, /work
[otel-collector] (optional) ◀── OTLP from gaffer-app
```

Compose sketch (config, illustrative only):

```yaml
services:
  app:        # Pi harness + web UI
    env_file: .env            # ANTHROPIC_API_KEY lives only here
    volumes: [sessions:/data/sessions]
    networks: [edge, data, sandbox]
    ports: ["127.0.0.1:8080:8080"]
  fpl-data:
    volumes: [fpl-cache:/cache]
    networks: [data, egress]   # only service allowed out
  sandbox:
    image: gaffer-sandbox      # python + pandas/numpy/scipy/highspy/pulp + exec agent
    runtime: runsc             # gVisor if installed; omit on Docker Desktop
    read_only: true
    tmpfs: ["/tmp:size=256m", "/work:size=512m"]
    volumes: [fpl-cache:/data:ro]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]   # default seccomp stays on
    pids_limit: 256
    mem_limit: 2g
    cpus: 1.0
    user: "10001:10001"
    networks: [sandbox]        # internal: true → no route out
networks:
  edge: {}
  egress: {}
  data:    { internal: true }
  sandbox: { internal: true }
volumes: { sessions: {}, fpl-cache: {} }
```

Notes:
- `internal: true` networks have no external route. The sandbox can reach only `app` (for the exec API), and it should not even need that: the harness initiates the calls. Only `fpl-data` sits on an egress network.
- gVisor on macOS Docker Desktop isn't a standard path. For the local MVP, hardened `runc` is acceptable because the only tenant is you. Use `runsc` on a Linux host.
- Lazy provisioning: `app` can start the sandbox on first tool call (Compose `profiles` + Docker API) or keep it always running. Always-on is simpler for single-user local. The *interface* should still be lazy (`ensureSandbox()` before the first exec) so it ports to Fargate/E2B.

### Phase 1 — AWS single-user

| Component | AWS |
|---|---|
| Web UI + harness | ECS Fargate **service** (desired=1), private subnet, behind **ALB** (HTTPS listener, ACM cert). ALB supports WebSockets natively; set `idle_timeout.timeout_seconds` above the default 60 s (range 1–4000) and send app-level pings; the app's own idle timeout should exceed the ALB's. |
| Auth (even for 1 user) | ALB `authenticate-oidc` or `authenticate-cognito` rule (HTTPS listener required). Verify the signed `x-amzn-oidc-data` JWT and its `signer` ARN. |
| Sandbox | Separate Fargate **task definition** launched via `RunTask` by the harness (IAM `ecs:RunTask`/`StopTask` scoped to that task def). Private subnet, security group that allows ingress only from the harness SG on the exec port, **no egress** (SG egress rule empty, or subnet with no NAT). `readonlyRootFilesystem: true`, non-root user, `linuxParameters.capabilities.drop: [ALL]`, `initProcessEnabled`. |
| Warm pool vs per-session | Fargate launch is roughly 10–60 s (ENI attach + image pull; AWS Batch docs cite ~30 s). Per-session `RunTask` on first tool call is fine if the UI shows "starting sandbox…". Better: keep **one pre-warmed idle task** and claim it on first tool call, then start the next warm one. Scale-to-zero after N minutes idle. Cost of 1 warm ARM task 24×7 ≈ $0.040 × 730 ≈ **$29/mo** at 1 vCPU/2 GB; 0.5 vCPU/1 GB ≈ $15/mo. Use SOCI indexes and a slim image to cut pull time. |
| FPL data layer | Scheduled task (EventBridge Scheduler → Fargate task, or Lambda) fetches FPL and writes parquet snapshots to **S3** (or EFS). The harness mounts or copies the snapshot into the sandbox. With EFS, mount an access point **read-only** into the sandbox task; with S3, the harness streams files via `put_file`. |
| Session log | **EFS** access point mounted only in the harness task (Pi writes JSONL natively). Periodic or on-close copy to **S3**, versioned, for durability and cheap archive. |
| Secrets | **Secrets Manager** → `secrets[].valueFrom` on the **harness container only** (task execution role reads it). Rotation needs a new task / force-deploy. |
| Cache | **No ElastiCache.** A single harness plus a file/sqlite cache is enough. Add Redis only when multiple harness replicas need shared rate-limit counters or pub/sub. |
| Logs/metrics | CloudWatch Logs (awslogs driver); ADOT/OTel collector sidecar in the harness task → CloudWatch/X-Ray or any OTLP backend. |
| Egress for harness | NAT gateway (or public subnet with public IP) for LLM API + FPL fetcher. |

### Phase 2 — Multi-user

- **Front door:** ALB + Cognito user pool (social/Google) or external OIDC IdP. Off-AWS, use oauth2-proxy (injects `X-Forwarded-User`/`X-Forwarded-Email`). The app maps `sub` → `user_id`.
- **Harness tier:** N Fargate tasks. Pin a WebSocket to the task that holds the live session (WebSockets are inherently sticky after the 101 upgrade). Session state lives in the durable log, so any task can `wake(sessionId)` after a reconnect.
- **Session store:** Postgres (RDS/Aurora Serverless v2) as the **index and authority** (sessions, users, budgets, event rows or pointers). JSONL blobs go to S3 (see §6).
- **Sandboxes:** one sandbox per active session (never shared across users), lazily provisioned, idle-reaped. Options: Fargate warm pool (N warm tasks, claim-on-demand) or a managed microVM (E2B/Modal/Deno/AgentCore) behind the same `SandboxBackend` interface. Tag each task with `user_id`/`session_id` for cost allocation.
- **Budgets/rate limits:** enforced in the harness before each LLM call and each sandbox exec. Token/cost counters live in Postgres (or Redis if hot). Per-user daily $ cap, max concurrent sessions, max sandbox-seconds per day.
- **Egress control at scale:** AWS Network Firewall domain allowlist (SNI/Host based) on the NAT path for harness/fetcher egress; sandboxes keep no egress at all.

### Generic hosts

| Host | Mapping | Notes |
|---|---|---|
| **Hetzner + Compose** | Same Compose file on a VPS; Caddy/Traefik for TLS + WebSocket; oauth2-proxy for auth; gVisor installable on the Linux host | Cheapest: CX23 €5.49/mo, CAX11 €5.99/mo after the June 2026 price rise (excl. IPv4/VAT). Single box, so you do backups (restic → object storage). |
| **Fly.io** | App = harness+web Machine; sandbox = separate Fly Machine per session (Firecracker VMs), started/stopped via Machines API; volume for sessions | shared-cpu-1x ≈ $1.94/30d at 256 MB; +RAM ≈ $5/GB-30d (computed from Fly's published per-second rates); stopped Machine rootfs $0.15/GB-30d; volumes $0.15/GB-mo. Machine-per-session plus stop/start maps directly to lazy provisioning. |
| **Kubernetes** | Deployment (harness), Service/Ingress (WebSocket-aware), sandbox as Pod per session with `runtimeClassName: gvisor` (or Kata), NetworkPolicy deny-all egress, Secret mounted only in harness | The K8s SIG "agent-sandbox" project targets exactly this (gVisor isolation use-case). Heaviest ops. |

---

## 4. Egress control for the sandbox

**Recommendation: no network in the sandbox; data mounted in.** The FPL fetch/cache layer is trusted code outside the sandbox, so the model never needs to reach FPL directly. That:
- removes exfiltration paths (prompt-injected code can't POST session contents anywhere);
- avoids SNI/Host-header allowlists, which can be bypassed by domain-fronting-style tricks. AWS itself notes Network Firewall *"uses the SNI or host header, not the IP addresses"* and recommends separate IP rules against manipulation;
- makes runs reproducible (the snapshot id is recorded in the session log).

Implementations:
- Compose: `networks: { sandbox: { internal: true } }` or `network_mode: none` (then use `docker exec`/volume transport).
- Fargate: security group with **no egress rules**, and a subnet with no NAT/IGW route. Keep VPC endpoints (ECR, CloudWatch Logs, S3 gateway) reachable only if the sandbox task needs them for pulling its image and shipping logs (the task *execution* role pulls the image at the platform level).
- E2B: `allow_internet_access=False`; Modal: `block_network=True` (or empty allowlists).

If an allowlist is ever needed (e.g. letting the model fetch a player's history on demand), put it behind an **egress proxy** that holds no credentials and allowlists `fantasy.premierleague.com` only. Options: E2B `allowOut`, Modal `outbound_domain_allowlist` (TLS/443 only, beta), AWS Network Firewall stateful domain list ($0.395/endpoint-hour + $0.065/GB; NAT charges waived when paired), or Route 53 Resolver DNS Firewall allowlist (DNS-level only, weaker). Prefer adding a **harness tool** (`fpl_fetch(player_id)`) over giving the sandbox network access.

---

## 5. Secrets handling

- The LLM API key lives only in the harness: `.env` → `app` service locally; Secrets Manager → harness container `secrets` on ECS. **Never** in the sandbox task definition, image, env, or mounted volumes.
- The sandbox exec backend must spawn processes with an **explicit, minimal env** (`PATH`, `HOME`, `LANG`, `PYTHONUNBUFFERED`). Do not inherit the harness env. This is the Gondolin failure mode Pi's docs warn about.
- ECS caveat from AWS: *"Applications that run on the container and container logs and debugging tools have access to the environment variables."* In the harness, prefer fetching the key at startup via the SDK (task role) and keeping it in memory rather than a long-lived env var. Scrub it from logs and OTel attributes.
- The sandbox task role should be **none** (no `taskRoleArn`), so there are no AWS creds via the metadata endpoint. The execution role only pulls the image and writes logs.
- The FPL API is public. If a user's FPL login is ever needed for private team data, treat it like OAuth tools in managed-agents: stored in a vault and used by a harness-side tool, never passed to the sandbox.
- Pattern reference: managed-agents keeps OAuth credentials in a vault accessed by a proxy, and Docker Sandboxes/OpenShell substitute credentials at an egress proxy. Gaffer gets the same property more simply, because the sandbox has no network.

---

## 6. Session storage for append-only JSONL

Pi's native format is JSONL: *"Each line is a JSON object with a `type` field. Session entries form a tree structure via `id`/`parentId`"* (v3). It is stored under `~/.pi/agent/sessions/…/<ts>_<id>.jsonl`, and the SDK allows a custom `SessionManager`.

| Store | Append semantics | Pros | Cons | Use in phase |
|---|---|---|---|---|
| **File on volume** (Docker volume / EFS) | Native `O_APPEND` | Zero code; Pi works as-is; `tail -f` debuggable | EFS latency per small write; single-writer assumption; backups are yours | **Local + AWS single-user** (EFS access point, harness-only) |
| **S3** | No true append on standard buckets; write immutable chunk objects (`sessions/{id}/{seq:08d}.jsonl`) using conditional `If-None-Match: *` (GA Aug 2024) for exactly-once sequence claims | Cheap, durable, versioned, lifecycle to Glacier | Many small objects; need a compaction/read-assembly step; custom `SessionManager` | Archive/snapshot tier in all phases; primary only with custom manager |
| **Postgres** | `INSERT` into `session_events(session_id, seq, parent_id, type, payload jsonb)` with a `UNIQUE(session_id, seq)` guard | Transactions, queries (per-user cost, search), multi-writer safety, easy tenancy (`user_id` column + RLS) | Custom `SessionManager`; DB ops | **Multi-user primary**; keep JSONL export for Pi compatibility/debug |

Recommendation: files on a volume through Phase 1, with a nightly/on-close S3 copy. In Phase 2, switch to Postgres as the authoritative event log plus an S3 JSONL export, implemented as a custom `SessionManager` so Pi still sees the same entry tree. The managed-agents framing (`getSession(id)` / `wake(sessionId)`, log outside the harness) argues for making the session store a separate component from the start, even if its first implementation is "a directory".

---

## 7. Multi-user seams to build in now

1. **Identity:** every request carries `user_id` from a verified header (ALB `x-amzn-oidc-data` JWT; oauth2-proxy `X-Forwarded-User` only when the proxy is the sole ingress). Locally, stub a fixed `user_id`.
2. **Tenancy keys:** `user_id` on sessions, sandbox leases, FPL "my team" cache entries, and budgets. S3 prefixes `users/{user_id}/…`. EFS access point per user if files are kept.
3. **Sandbox per session:** `SandboxBackend` interface (`acquire(sessionId) / exec / putFile / getFile / release`) with Docker, Fargate, and E2B implementations. The lease table maps session → sandbox, with an idle TTL reaper.
4. **Budgets/rate limits:** pre-flight check before each LLM call (estimated tokens × price) and each exec (sandbox-seconds); post-hoc reconcile from provider `usage`. Per-user daily/monthly caps; global kill-switch.
5. **Auth options:** ALB+Cognito (least code on AWS; Cognito supports Google/social; ALB auth needs an HTTPS listener and a publicly resolvable IdP); oauth2-proxy (portable, CNCF sandbox project); app-native OIDC (most control, most code).

---

## 8. Observability and cost tracking

- **OpenTelemetry GenAI semantic conventions** (now in `open-telemetry/semantic-conventions-genai`; status **Development**, so expect renames). They define model spans (`{gen_ai.operation.name} {gen_ai.request.model}`), **agent spans** (`invoke_agent`, `execute_tool`), events, and metrics (`gen_ai.client.operation.duration`, `gen_ai.client.operation.time_to_first_chunk`, `gen_ai.invoke_agent.tool_calls`, `gen_ai.execute_tool.duration`, token metrics). Key attributes: `gen_ai.provider.name`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens`, `gen_ai.usage.reasoning.output_tokens`, `gen_ai.conversation.id` (use Pi's session id). Message content (`gen_ai.input.messages`, etc.) is **Opt-In**; keep it off by default for privacy and cost. There is an Anthropic-specific page.
- **Gaffer spans:** `invoke_agent gaffer` (per user turn) → `chat <model>` (per LLM call, token usage) → `execute_tool bash` / `execute_tool fpl_fetch` → child span `sandbox.acquire` (records cold vs warm and latency) and `sandbox.exec` (cpu-seconds, exit code). Add `user.id`/`session.id` as attributes (hashed if exported to third parties).
- **Cost:** compute `$ = tokens × price table` in the harness at span end (price table in config, versioned). Write a `cost` event into the session log (durable, per-user queryable) *and* emit a metric. Sandbox cost = sandbox-seconds × rate (Fargate per-second, 1-min minimum). AWS-side: cost-allocation tags on sandbox tasks.
- **Backends:** local = OTel Collector → Jaeger/Grafana or Langfuse/Phoenix (both accept OTLP); AWS = ADOT → CloudWatch/X-Ray or a hosted OTLP vendor.

---

## Recommendation

1. **Build the exec seam first:** a Pi extension that overrides `bash` (and `read`/`write` if the model needs files) with a `SandboxBackend` over an HTTP exec agent, plus a strict env allowlist. This is the same mechanism as Pi's `ssh.ts`/Gondolin examples.
2. **Phase 0:** Compose with hardened `runc` (plus `runsc` on Linux), sandbox on an `internal` network with no egress, FPL snapshots mounted read-only, and JSONL sessions on a named volume.
3. **Phase 1 (AWS):** Fargate harness service + ALB (OIDC, idle timeout ≥ 300 s + WS pings) and Fargate sandbox tasks with no egress and no task role. Warm pool of 1, lazy acquire, idle reap. EFS for sessions with an S3 copy; Secrets Manager into the harness only; no ElastiCache.
4. **Phase 2:** Cognito/OIDC, Postgres-backed `SessionManager`, per-session sandboxes, budgets. Re-evaluate E2B (BYOC) or AgentCore Code Interpreter if Fargate cold start or `RunTask` rate limits hurt.
5. **Solver choice affects sandbox choice:** prefer SciPy `milp`/HiGHS (`highspy`). It keeps the Pyodide/WASM option open as a very cheap, zero-infra fallback. PuLP+CBC and OR-Tools are not in Pyodide.

---

## Sources

- Pi — Run Pi in an isolated environment: https://pi.dev/docs/latest/containerization (raw: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/containerization.md)
- Pi — Run Pi safely: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/security.md
- Pi — Session format: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/session-format.md
- Pi — SDK (SessionManager, tools): https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/sdk.md
- Pi — Extensions: https://pi.dev/docs/latest/extensions
- Pi examples: https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions (`ssh.ts`, `tool-override.ts`, `gondolin/index.ts`, `sandbox/index.ts`)
- Anthropic — Managed agents: https://www.anthropic.com/engineering/managed-agents
- AWS — Fargate security considerations: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-security-considerations.html
- AWS — Fargate pricing: https://aws.amazon.com/fargate/pricing/
- AWS — Fargate SOCI: https://aws.amazon.com/about-aws/whats-new/2023/07/aws-fargate-container-startup-seekable-oci
- AWS — Running Fargate tasks / Batch "when to use Fargate": https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs_run_task_fargate.html , https://docs.aws.amazon.com/batch/latest/userguide/when-to-use-fargate.html
- AWS re:Post — Fargate PENDING: https://repost.aws/knowledge-center/ecs-fargate-tasks-pending-state
- AWS — ALB attributes (idle timeout): https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html
- AWS — ALB sticky sessions / WebSockets: https://docs.aws.amazon.com/elasticloadbalancing/latest/application/sticky-sessions.html
- AWS — ALB authenticate users: https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html
- AWS — ECS secrets via Secrets Manager: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html
- AWS — ECS EFS volumes: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/efs-volumes.html
- AWS — Network Firewall domain lists: https://docs.aws.amazon.com/network-firewall/latest/developerguide/stateful-rule-groups-domain-names.html ; pricing: https://aws.amazon.com/network-firewall/pricing/
- AWS — Route 53 Resolver DNS Firewall: https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver-dns-firewall.html
- AWS — Lambda pricing: https://aws.amazon.com/lambda/pricing/
- AWS — EC2 nested virtualization (Feb 2026): https://aws.amazon.com/about-aws/whats-new/2026/02/amazon-ec2-nested-virtualization-on-virtual
- AWS — S3 conditional writes: https://www.amazonaws.cn/en/new/2024/amazon-s3-supports-conditional-writes/
- AgentCore pricing: https://aws.amazon.com/bedrock/agentcore/pricing/ (figures via https://cloudburn.io/blog/amazon-bedrock-agentcore-pricing)
- Docker — Security: https://docs.docker.com/engine/security/ ; Seccomp: https://docs.docker.com/engine/security/seccomp/ ; Compose services: https://docs.docker.com/reference/compose-file/services/
- gVisor: https://gvisor.dev/docs/ ; platforms: https://gvisor.dev/docs/architecture_guide/platforms/
- Firecracker: https://github.com/firecracker-microvm/firecracker ; Kata+FC: https://github.com/kata-containers/kata-containers/blob/main/docs/how-to/how-to-use-kata-containers-with-firecracker.md
- E2B pricing: https://e2b.dev/pricing ; internet access: https://docs.e2b.dev/sandbox/internet-access ; BYOC: https://docs.e2b.dev/byoc ; self-host: https://github.com/e2b-dev/infra/blob/main/self-host.md ; snapshots: https://e2b.dev/docs/sandbox/snapshots
- Modal pricing: https://modal.com/pricing ; sandboxes: https://modal.com/docs/guide/sandbox ; networking/security: https://modal.com/docs/guide/sandbox-networking
- Daytona pricing: https://www.daytona.io/pricing ; repo status: https://github.com/daytonaio/daytona
- microsandbox: https://github.com/microsandbox/microsandbox
- Deno Sandbox: https://deno.com/blog/introducing-deno-sandbox , https://docs.deno.com/sandbox/ , https://deno.com/deploy/pricing
- Pyodide packages: https://pyodide.org/en/stable/usage/packages-in-pyodide.html ; WASM constraints: https://pyodide.org/en/stable/usage/wasm-constraints.html
- SciPy milp: https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.milp.html
- Fly.io pricing: https://docs.fly.io/about/pricing/
- Hetzner price adjustment (15 June 2026): https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/
- oauth2-proxy: https://oauth2-proxy.github.io/oauth2-proxy/
- OpenTelemetry GenAI semconv: https://opentelemetry.io/docs/specs/semconv/gen-ai/ → https://github.com/open-telemetry/semantic-conventions-genai (docs/gen-ai/*.md)
- K8s agent-sandbox gVisor: https://agent-sandbox.sigs.k8s.io/docs/use-cases/gvisor-isolation/

## Unconfirmed

- **Fargate launch latency:** no official AWS SLA or number. The "~30 s" figure is from AWS Batch docs (via search summary). The 10–90 s ranges come from re:Post and blog posts. Measure in a spike (RunTask → exec-agent healthy) with a slim ARM image and SOCI.
- **Pi runtime behaviour of same-name tool override:** confirmed from example source and comments (`tool-override.ts`, `ssh.ts`), not by running Pi. The `pi.dev/docs/latest/extensions` page fetch did not surface `BashOperations`; it came from the example source on GitHub (repo `badlogic/pi-mono` now redirects to `earendil-works/pi`). Covered by spike S1.
- **gVisor cold-start overhead and perf for pandas/HiGHS:** not measured; gVisor docs only describe platforms qualitatively.
- **AgentCore Code Interpreter pricing and microVM isolation:** from secondary sources (cloudburn.io, Medium) via search; I did not fetch the AWS pricing page directly.
- **E2B ~150 ms start:** secondary sources (blogs/Medium), not an E2B SLA. The E2B pricing page did not mention Firecracker; Firecracker is stated in e2b-dev/infra and third-party reviews. The pricing page quoted "default 2 vCPU / 4 GiB", which I did not cross-check against E2B's SDK docs.
- **Modal and Deno Sandbox cold-start times:** not verified. Deno pricing came from the search summary of Deno's blog/pricing page, not a direct fetch.
- **Daytona "dedicated kernel" / isolation tech:** marketing README language only. The pricing page did not name the isolation tech.
- **Fly.io prices:** the WebFetch summary gave inconsistent numbers ($3.46 vs $5.70/mo for 1 GB). I computed from the page's embedded constants (shared CPU $0.00000075/s, RAM $0.00000193/GB-s), but the exact region multipliers were not verified.
- **Hetzner prices:** from Hetzner's price-adjustment doc (CX23 €5.49, CAX11 €5.99). Current live list pricing may have changed again.
- **Lambda 15-minute max timeout:** long-standing documented limit, not re-fetched this session.
- **Docker Compose `internal: true` networks:** the services-reference fetch did not show it (it lives in the networks reference); widely documented but not re-verified here.
- **ECS `RunTask` API rate limits** for a warm-pool design at multi-user scale: not researched.
- **FPL egress hostnames** (beyond `fantasy.premierleague.com`, e.g. image/CDN hosts): defer to R3 (03-fpl-data-sources.md).
