# ADR 0020 — Infrastructure, build, deploy and observe: AWS CDK in TypeScript, ARM images in ECR, alarms to email

**Status:** Proposed (Phase 2 plan, for your review) · **Date:** 2026-10-23 · **Extends:** [ADR 0009](0009-pi-version-policy.md) (rollback and deploy windows) · **Evidence:** [research 17](../research/17-aws.md) · **Requirements:** NFR-MNT-01, NFR-MNT-04, NFR-MNT-06, NFR-OBS-03, NFR-LAT-02, NFR-LAT-05

## Context
- **What's pinned today:** the Dockerfiles pin base images by digest (multi-arch indexes), Pi's tree is pinned by lockfile (NFR-MNT-01), and the Mac builds arm64 images natively.
- **What Phase 2 on AWS needs:**
  - infrastructure that can be reviewed, tested and recreated;
  - images in a registry;
  - deploys and rollbacks that keep ADR 0009's discipline;
  - a single-writer harness (ADR 0014's session lock, ttyd's tmux), so two harness tasks must never run at once;
  - alerts for failures, without running a monitoring stack.
- **What isn't set up:** the repository has CI (`.github/workflows/ci.yml`), but it isn't pushed or enabled yet (NFR-MNT-02, blocked on you since M5).

## Options considered
1. **AWS CDK v2 in TypeScript,** with `cdk-nag`'s AwsSolutions checks and `aws-cdk-lib/assertions` tests. **Chosen.**
   - It's the same language and toolchain as the repo (pnpm, vitest).
   - `cdk synth` and the tests run without AWS credentials, so M2-0 can build and test it all locally.
   - CloudFormation handles state, drift detection and rollback, with no Terraform state bucket to run.
2. **Terraform.** Rejected. It's equally professional, but it brings a second language, a state backend and locking to run for one stack. CDK's output is plain CloudFormation, so there's no lock-in.
3. **Console or CLI by hand.** Rejected: not reviewable, not repeatable.

## Decision
- **The infrastructure as code** lives in `deploy/aws/`, a pnpm workspace package. It has three stacks, all in `eu-west-2`:

  | Stack | What it holds | Protection |
  |---|---|---|
  | `GafferNetwork` | VPC, subnets, endpoints, DNS Firewall | |
  | `GafferData` | EFS, Secrets Manager, the Backup vault and plan, ECR repositories | termination protection; `RETAIN` removal policies |
  | `GafferService` | the ECS cluster, task definitions, services, ALB, Cognito, schedules, alarms | |

  - The versions on 2026-10-23 were `aws-cdk-lib` 2.274.0, the CLI 2.1146.1 and `cdk-nag` 3.0.2 (research 17), pinned exactly as Pi is.
  - `cdk-nag` AwsSolutions runs in `cdk synth`. Every acknowledged finding (v3's `Validations.of().acknowledge()`) carries its reason in the code.
  - `aws-cdk-lib/assertions` tests check the security properties: no NAT; the sandbox has no task role and no egress; ECS Exec off; harness `desiredCount` 1 with `maximumPercent` 100 and `minimumHealthyPercent` 0; ALB rules only after `authenticate-cognito`; EFS encrypted; secrets only on the harness and job containers.
- **Images:**
  - built on the Mac for `linux/arm64` (Graviton Fargate, the Mac's own architecture, so no emulation) by `deploy/aws/scripts/build-push.sh <git ref>`;
  - pushed to private ECR repositories (`gaffer-harness`, `gaffer-sandbox`, `gaffer-egress`) with **immutable tags** (the git commit), scan on push, and a lifecycle that keeps the last 10;
  - task definitions reference images **by digest**;
  - CI-built images (GitHub Actions with OIDC to an AWS role, no stored keys) are a later step, once NFR-MNT-02's pipeline is enabled.
- **Deploys** (`deploy/aws/scripts/deploy.sh <git ref>`), from the Mac with your AWS IAM Identity Center (SSO) session, inside an ADR 0009 window:
  1. `build-push.sh`.
  2. `cdk diff`, shown to you.
  3. `cdk deploy GafferService` with the new digests.
  4. ECS replaces the single harness task (stop, then start, because of the 0/100 settings), with the **deployment circuit breaker and rollback on**.
  5. Wait until both hostnames answer through the ALB.
  6. Run `verify-aws.sh`.
  7. Record the ref, digests and time in `deploys.log` (in the repo's `deploy/aws/`, committed with the BUILD.md section).

  **Rollback** (`rollback.sh <git ref>`) is a `cdk deploy` with an earlier ref's digests. ADR 0009's "previous image kept" holds because ECR keeps them. Both scripts refuse to run within 24 hours before a deadline unless given `--force`, reading the deadline from FPL's `events`.
- **Access to the account:**
  - You sign in with IAM Identity Center (SSO) on the Mac, with an admin permission set and MFA.
  - The agent uses the CLI session you start, and never creates or handles access keys.
  - No IAM users, no long-lived keys.
  - The root account has MFA and isn't used.
- **No shell path:** ECS Exec stays off on every service. A CDK assertion checks it, and nothing grants `ecs:ExecuteCommand`.
- **Observe:**
  - CloudWatch Logs for every container (30-day retention).
  - **CloudWatch alarms to one SNS topic with your email:**
    - the harness, sandbox or proxy service at 0 running tasks for 5 minutes;
    - ALB 5xx above 5 in 5 minutes;
    - the ALB target unhealthy;
    - a scheduled job failed, or no success in 26 hours (ADR 0019);
    - an AWS Backup job failed;
    - **an AWS Budgets alert at your monthly budget** (set in M2-1).
  - VPC Flow Logs (rejected traffic) on the private subnets, 14 days.
- **Patching:**
  - Fargate patches the host.
  - Base images move by digest through the usual Pi or dependency upgrade path (ADR 0009, Renovate when enabled).
  - ECR scanning findings at high or critical alarm by email.
- **Latency on AWS:**
  - NFR-LAT-02 (re-instated): a harness and sandbox task's start time after a deploy, launch to running.
  - NFR-LAT-05: the sandbox's first command, and the golden path's time on Graviton.

  `verify-aws.sh` records both in `deploys.log`.

## Consequences
- **New requirement NFR-MNT-06:** the infrastructure is code, it passes `cdk-nag` and its assertion tests in CI without credentials, and a deploy is a reviewed `cdk diff`.
- **Deploys cause a brief outage** (about a minute while the single harness task is replaced). It's accepted, and it's why deploys stay in ADR 0009's windows.
- **`deploys.log` and the alarms' history** give M2-2 its record of restarts (ADR 0011's T3).
- **What you do:**
  - create the AWS account (or use an existing one), with IAM Identity Center and MFA;
  - run `aws sso login` when the agent asks;
  - approve each `cdk diff`;
  - set the budget figure.
