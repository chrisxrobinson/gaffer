# R17 — Gaffer on AWS: facts and prices for a single-user deployment in eu-west-2

*Researched 2026-10-23. Prices come from AWS's public price-list JSON for `eu-west-2` (each file's publication date in brackets), and the behaviour from AWS's docs. They're list prices in USD, excluding VAT and data transfer out.*

## TL;DR
- **The ARM64, NAT-free design in ADRs 0015–0020 costs about $183 a month.** The biggest lines are the always-on sandbox ($66), the four interface endpoints ($32), the harness ($33), and the ALB with its public IPv4 addresses (about $36).
  - On x86 it would be about $28 more.
  - A NAT gateway instead of the proxy's public IP adds about $33, plus $0.05/GB, and enforces nothing.
  - AWS Network Firewall would add at least $288 per endpoint.
- **The ALB's identity headers.** Only `x-amzn-oidc-data` is signed: ES256, with the key from `https://public-keys.auth.elb.<region>.amazonaws.com/<kid>`, and a `signer` that must equal the ALB's ARN. `x-amzn-oidc-identity` and `x-amzn-oidc-accesstoken` are "legacy unsigned headers". **No AWS doc says the ALB strips client-supplied copies**, and AWS's best-practice post says to verify the signature and `signer`, and to accept target traffic only from the ALB's security group (CVE-2024-8901 was a forged-JWT bypass). So the harness must verify `x-amzn-oidc-data` itself, for the terminal as well, and must never trust `x-amzn-oidc-identity`.
- **DNS can't be filtered by security groups or network ACLs**: "You cannot filter traffic to or from the Amazon DNS server". A task with no egress rules can still resolve names, which is a channel out, so Route 53 Resolver DNS Firewall is needed. Its default checks every name in a CNAME chain (`INSPECT_REDIRECTION_DOMAIN`). FPL's chain runs through Fastly names that change, so Gaffer's rule uses `TRUST_REDIRECTION_DOMAIN` for its three allowed names.
- **Fargate task networking:** on platform 1.4.0, image pulls, ECR auth, awslogs, Secrets Manager and EFS all go through the **task ENI and its security group**. A private subnet with no NAT needs interface endpoints for `ecr.api`, `ecr.dkr`, `logs` and `secretsmanager`, and the S3 gateway endpoint, whose policy can be limited to `arn:aws:s3:::prod-eu-west-2-starport-layer-bucket/*`.
- **ECS:**
  - With `desiredCount` 1 and `minimumHealthyPercent` 0 / `maximumPercent` 100, ECS stops the old task before starting the new one, so there is never a second writer.
  - The circuit breaker rolls back to the last completed deployment.
  - ECS Exec is off unless `enableExecuteCommand` is set, and it also needs a task role with `ssmmessages` and a route to it, which the sandbox has neither of.

## Unit prices (USD, eu-west-2)
| Item | Price | Source [date] |
|---|---|---|
| Fargate Linux/ARM | $0.03725 per vCPU-h, $0.00409 per GB-h | AmazonECS [2026-10-19] |
| Fargate Linux/x86 | $0.04656 per vCPU-h, $0.00511 per GB-h | AmazonECS [2026-10-19] |
| ALB | $0.02646/h, $0.0084 per LCU-h | AWSELB [2026-09-11] |
| NAT gateway (for comparison) | $0.05/h, $0.05/GB | AmazonEC2 [2026-10-22] |
| Public IPv4 | $0.005/h | AmazonVPC [2026-10-16] |
| Interface endpoint | $0.011 per AZ-h, $0.01/GB | AmazonVPC [2026-10-16] |
| EFS Standard / One Zone | $0.33 / $0.176 per GB-month; elastic throughput reads $0.03/GB, writes $0.07/GB | AmazonEFS [2026-09-11] |
| Secrets Manager | $0.40 per secret-month | [2026-09-11] |
| ECR storage | $0.10 per GB-month | [2026-09-11] |
| CloudWatch Logs | ingest $0.5985/GB, storage $0.0315/GB-month; alarm $0.10/month; vended (Flow) logs $0.5985/GB | AmazonCloudWatch [2026-10-07] |
| Route 53 | hosted zone $0.50/month; `.com` $16/year from 2026-07-01 | global price list [2026-09-11]; `.com` from a secondary source (AWS's PDF didn't parse) |
| Cognito | Lite $0.0055 and Essentials $0.015 per MAU, with **10,000 MAU free every month** on both; Plus $0.020 | AmazonCognito [2026-10-20]; pricing page |
| AWS Backup (EFS warm) | $0.06 per GB-month | AWSBackup [2026-10-14] |
| Network Firewall (for comparison) | $0.395 per endpoint-h, $0.065/GB | [2026-09-11] |
| DNS Firewall | $0.0005 per domain-month in a list, $0.60 per million queries | global price list, eu-west-2 rows |
| EventBridge Scheduler | 14 million invocations a month free | AWSEvents [2026-09-24] |
| SNS email | 1,000 a month free | AmazonSNS [2026-09-15] |

## Monthly estimate (730 hours, ARM64)
| Line | $/month |
|---|---|
| Harness, 1 vCPU / 2 GB, always on | 33.16 |
| Sandbox, 2 vCPU / 4 GB, always on | 66.33 |
| Egress proxy, 0.25 vCPU / 0.5 GB | 8.29 |
| Scheduled jobs (about 30 task-hours at 1 vCPU / 2 GB) | 1.36 |
| ALB hours, plus 1 LCU on average (likely high) | 25.45 |
| Public IPv4: the ALB in two AZs, plus the proxy | 10.95 |
| 4 interface endpoints × 1 AZ, plus about 5 GB | 32.17 |
| EFS (1 GB plus I/O), AWS Backup, Secrets Manager (2), ECR (2 GB) | 1.89 |
| CloudWatch Logs (1 GB), alarms (about 8), Flow Logs (rejected traffic only, under 1 GB) | 2.10 |
| Route 53 hosted zone, plus `.com` ÷ 12 | 1.83 |
| Cognito (1 MAU), DNS Firewall, Scheduler, SNS | ~0 |
| **Total** | **≈ $183** before VAT (about $220 with 20% UK VAT, if your account is billed with it) |

**Levers if the bill matters more than the design:**
- **Run the sandbox only while a run is on** (per-session `RunTask`, ADR 0006's original design): it saves most of $66, at the cost of a 30–60 s cold start per run and the `SandboxProvider=ecs` code. That's planned for Phase 3.
- **Drop the interface endpoints by giving the harness a NAT:** saves nothing ($33 instead of $32), and loses the allowlist.
- **x86:** costs more.

## ALB authentication
- **Headers:**
  - `x-amzn-oidc-data` carries the user's claims as a JWT, signed ES256 (P-256, SHA-256). Its header carries `alg`, `kid`, `signer` (the ALB's ARN), `iss`, `client` and `exp`.
  - It is base64url-encoded **with padding**, so strict JWT libraries can reject it. Node's own `crypto.verify` with `dsaEncoding: "ieee-p1363"` handles it.
  - `x-amzn-oidc-identity` (the `sub`) and `x-amzn-oidc-accesstoken` are unsigned.
- **Session:**
  - The cookie is `AWSELBAuthSessionCookie`.
  - `SessionTimeout` defaults to 7 days and can be set as short as 1 second.
  - The login flow must finish within 15 minutes.
- **WebSockets:** the ALB supports them, but no doc describes authentication during the upgrade. Expect the session to be checked at the handshake only, so an open socket outlives the session's expiry. The terminal's reconnect then re-authenticates.
- **New since 2025:** a `jwt-validation` listener action for RS256 bearer tokens against a JWKS. It's for service-to-service calls, not browser sign-in, and Gaffer doesn't use it.

## Cognito
- **Feature plans:**
  - Lite: TOTP and SMS MFA, the classic hosted UI.
  - Essentials: adds **passkeys**, email MFA, passwordless sign-in and **managed login**. New pools default to Essentials.
  - Plus: adds threat protection.
- Lite and Essentials both include 10,000 free MAU a month, permanently, so **Essentials is free for one user**.
- Admin-only user creation (self-registration off) is a standard setting on every plan.

## Fargate networking, EFS and ECS
- **ENI traffic:** the task ENI carries image pulls, ECR auth, awslogs, Secrets Manager and EFS. So the harness's security group must allow the endpoints (443), the S3 prefix list (443) and EFS (2049), and they all show in Flow Logs.
- **EFS:**
  - It needs platform 1.4.0 or later.
  - The task's security group needs egress to 2049, and the mount target's security group needs ingress from it.
  - EFS IAM authorisation uses the **task role**. A task without one (the sandbox) can't use it, so its mount is allowed by the file system's resource policy for one access point, read-only, plus POSIX permissions.
- **SOCI** lazy loading works on Fargate ARM64 from private ECR, for gzip or uncompressed layers, and is recommended above 250 MiB compressed.
- **Task start time:** no AWS figure for 2025–26. Image pull dominates it (zstd was reported to cut start time by up to 27%). Expect roughly 30–60 s for a 1 GB image, measured in M2-1 (NFR-LAT-02).
- **The circuit breaker:** the default `BOUNDED_PERCENT` of 50 gives a threshold of 3 failed tasks when the desired count is 1.

## CDK
- **Versions on npm (2026-10-23):** `aws-cdk-lib` 2.274.0 (2026-10-20), the `aws-cdk` CLI 2.1146.1 (2026-10-22), and `cdk-nag` 3.0.2 (2026-08-04).
- **cdk-nag v3** keeps the AwsSolutions pack and replaces `NagSuppressions` with `Validations.of().acknowledge()`, one acknowledgment per finding.
- **`aws-cdk-lib/assertions`** is part of the library.
- **Context lookups** need the account and are cached in `cdk.context.json` (commit it). With no lookups, `synth` needs no credentials.

## Sources (all read 2026-10-23)
- AWS price list (per service, per region): `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<Service>/current/eu-west-2/index.json` (AmazonECS, AWSELB, AmazonEC2, AmazonVPC, AmazonEFS, AWSSecretsManager, AmazonECR, AmazonCloudWatch, AmazonCognito, AWSBackup, AWSNetworkFirewall, AWSEvents, AmazonSNS), and `AmazonRoute53/current/index.json`
- Route 53 pricing (domains PDF): https://aws.amazon.com/route53/pricing/; the 2026-07-01 `.com` change: https://dev.classmethod.jp/en/articles/route53-tld-pricing-change-2026/
- Cognito pricing and feature plans: https://aws.amazon.com/cognito/pricing/, https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-sign-in-feature-plans.html
- ALB authentication: https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html; `AuthenticateCognitoActionConfig`: https://docs.aws.amazon.com/elasticloadbalancing/latest/APIReference/API_AuthenticateCognitoActionConfig.html; JWT validation action: https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-verify-jwt.html
- Security best practices for ALB authentication (updated 2026-03-17): https://aws.amazon.com/blogs/networking-and-content-delivery/security-best-practices-when-using-alb-authentication/
- Amazon DNS server and security groups: https://docs.aws.amazon.com/vpc/latest/userguide/AmazonDNS-concepts.html
- Route 53 Resolver DNS Firewall rules (`FirewallDomainRedirectionAction`): the Route 53 API reference (seen in search results)
- Fargate task networking: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html
- ECR VPC endpoints (the layer bucket): https://docs.aws.amazon.com/AmazonECR/latest/userguide/vpc-endpoints.html
- EFS network access and ECS EFS volumes: https://docs.aws.amazon.com/efs/latest/ug/network-access.html, https://docs.aws.amazon.com/AmazonECS/latest/developerguide/efs-volumes.html
- ECS deployments, the circuit breaker, ECS Exec, SOCI: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-type-ecs.html, .../deployment-circuit-breaker.html, .../ecs-exec.html, .../fargate-tasks-services.html
- CDK context: https://docs.aws.amazon.com/cdk/v2/guide/context.html; cdk-nag: https://github.com/cdklabs/cdk-nag; npm registry entries for `aws-cdk-lib`, `aws-cdk` and `cdk-nag`

## Unconfirmed
- **Whether the ALB strips client-supplied `x-amzn-oidc-*` headers.** The design assumes it doesn't, and M2-1 tests it.
- **Authentication on WebSocket upgrades.** Assumed: checked at the handshake only.
- **The `.com` price** ($16, from a secondary source) and the `.co.uk` price after July 2026.
- **Fargate ARM task start time** for Gaffer's images. Measured in M2-1.
- **DNS Firewall's `TRUST_REDIRECTION_DOMAIN` behaviour**, seen only in API reference search results.
- **A doc statement that `cdk synth` needs no credentials without lookups.** It matches how the tool behaves.
- **CloudWatch's always-free logs allowance, data transfer out prices, and real LCU use.**
