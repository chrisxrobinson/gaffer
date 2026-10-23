# ADR 0017 — Egress allowlist: no route out for the harness except a Squid proxy service

**Status:** Proposed (Phase 2 plan, for your review) · **Date:** 2026-10-23 · **Implements:** [ADR 0013](0013-gaffer-terminal.md)'s "the harness egress allowlist becomes required" · **Evidence:** [research 15](../research/15-egress-allowlist.md), [research 17](../research/17-aws.md), [spike S11](../../spikes/s11-egress-proxy/README.md) · **Requirements:** NFR-SEC-11, NFR-PRIV-02, NFR-SEC-09

## Context
- **Why it's required:** ADR 0013 made a harness egress allowlist required for Phase 2, as the one hard guarantee against future Pi features that reach out. The harness needs three hosts:
  - `api.anthropic.com`;
  - `fantasy.premierleague.com` (served by Fastly, whose addresses rotate and are shared);
  - `football-data.co.uk` (the apex, as `odds.ts` calls it).
- **It also needs some AWS services:** ECR to pull its image, Secrets Manager, CloudWatch Logs and EFS.
- **The sandbox** must reach nothing at all.
- **What S11 showed:**
  - A harness with no route out, plus a Squid proxy allowing CONNECT on 443 to those three names only, refuses everything else (IP literals included).
  - Node 24 uses the proxy only with `NODE_USE_ENV_PROXY=1`.

## Options considered
1. **A Squid proxy service as the harness's only route to the internet.** **Chosen.**
   - The harness and sandbox run in private subnets with **no NAT and no internet gateway route**.
   - AWS services are reached through VPC endpoints.
   - Security groups allow the harness to reach only the proxy, the sandbox, EFS and the endpoints.

   It's enforced by routing and security groups, it's the design S11 tested, and Fastly's rotating addresses don't matter because the proxy resolves names itself.
2. **AWS Network Firewall with a domain allowlist on a NAT path** (ADR 0006's "optional allowlist later"). Rejected:
   - about $290 a month per endpoint before data (research 17), more than the rest of the stack;
   - its SNI/Host matching has the same domain-fronting limit as a CONNECT proxy, so it buys nothing in strength.
3. **Route 53 Resolver DNS Firewall alone.** Rejected as the control, because it's bypassed by literal IPs. It's adopted as a second layer that closes DNS as a channel out (see Decision).
4. **A NAT gateway with security-group egress to 0.0.0.0/0:443.** Rejected: that's no allowlist at all.

## Decision
- **Subnets** (two AZs, as the ALB requires):

  | Subnet | Route out | Holds |
  |---|---|---|
  | public | internet gateway | the ALB, the proxy task |
  | private | **none** | the harness, the sandbox, job tasks, EFS mount targets, interface endpoints |

  No NAT gateway.
- **The proxy service** (`gaffer-egress`):
  - Fargate ARM64, 0.25 vCPU / 0.5 GB, 1 task, in a public subnet with a public IPv4.
  - Squid pinned by digest, S11's config with `dstdomain -n`: CONNECT 443 to the three hosts, deny IP literals, deny everything else.
  - Its security group allows inbound 3128 only from the harness's and the jobs' security groups, and outbound 443 and 53.
  - Its access log goes to CloudWatch Logs.
  - Reached at `egress.gaffer.internal:3128` through Cloud Map.
- **The harness and job security group, outbound only to:**
  - the proxy (3128);
  - the sandbox (8080);
  - EFS (2049);
  - the interface endpoints' security group (443);
  - the S3 gateway endpoint's prefix list (443), for ECR image layers. The endpoint's policy allows only `s3:GetObject` on `arn:aws:s3:::prod-eu-west-2-starport-layer-bucket/*`, so it isn't a route to arbitrary S3 buckets.
- **The sandbox's security group:** no outbound rules at all; inbound 8080 from the harness and job security group only. **No task role.**
- **VPC endpoints,** in one AZ (the harness's):
  - interface endpoints for `ecr.api`, `ecr.dkr`, `logs` and `secretsmanager`, with private DNS;
  - the S3 gateway endpoint, with its policy.
- **DNS:** security groups don't filter queries to the VPC's own resolver, so DNS would otherwise be a channel out: a lookup of `<data>.attacker.example` leaves through it. Route 53 Resolver **DNS Firewall** is attached to the VPC with an allow list, and every other name gets NXDOMAIN, for the harness, the sandbox and the proxy alike. The list:
  - the three hosts, with `TRUST_REDIRECTION_DOMAIN`, because FPL's CNAME chain runs through Fastly names that change, and those names aren't attacker-controlled;
  - the region's endpoint names under `amazonaws.com`;
  - `gaffer.internal`.
- **The harness container** gets `NODE_USE_ENV_PROXY=1`, `HTTPS_PROXY` and `HTTP_PROXY` set to `http://egress.gaffer.internal:3128`, and `NO_PROXY=sandbox.gaffer.internal,localhost,127.0.0.1,169.254.170.2` (the ECS metadata and credentials endpoint). Its Node base image moves to **24.22.x or later**, for the `NO_PROXY` and proxy-error fixes.
- **One list of hosts:** the allowlist lives in `deploy/aws/egress/squid.conf`. A test fails if it differs from the hosts Gaffer's code calls (`guard.ts`, `odds.ts`, the provider's base URL).

## Consequences
- **The guarantee holds for any code:** whatever the code or a future Pi feature tries, nothing outside the three hosts and the VPC's own endpoints is reachable from the harness. NFR-SEC-11 tests it, and VPC Flow Logs on the private subnets (rejected traffic only) give the evidence on AWS.
- **A second model provider** (NFR-PORT-01) is one line in the allowlist, plus a test update.
- **If FPL moves to a new host name,** the snapshot step reports FPL unreachable (FR-DAT-05), and the allowlist test names the host to add.
- **Residual risk:** an allowed CDN name could front for another site through a mismatched SNI. Accepted, as on the small host (research 15).
- **The proxy is a single task.** If it's down, model and FPL calls fail loudly, and ECS replaces it. Its health is a CloudWatch alarm (ADR 0020).
- **Cost** (research 17): the four interface endpoints are about $32 a month in one AZ, and the proxy about $12 with its public IPv4. A NAT gateway would be about $33 and enforce nothing; Network Firewall at least $288. DNS Firewall costs cents.
- **Locally,** the same Squid config runs as a Compose overlay with internal networks (S11, S13), so the allowlist test and the probes run without AWS.
