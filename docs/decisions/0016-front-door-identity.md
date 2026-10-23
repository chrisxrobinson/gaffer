# ADR 0016 — Front door and identity: an ALB with Cognito, the identity verified again in the harness

**Status:** Proposed (Phase 2 plan, for your review) · **Date:** 2026-10-23 · **Refines:** [ADR 0005](0005-web-tui.md)'s cloud line (ALB OIDC, `-H X-Amzn-Oidc-Identity`, idle timeout 3600 s) · **Evidence:** [research 17](../research/17-aws.md), [research 14](../research/14-front-door-identity.md) (alternatives), [spike S12](../../spikes/s12-identity-header/README.md) · **Requirements:** NFR-SEC-04, NFR-SEC-10, FR-ADM-02, NFR-A11Y-01 (phone)

## Context
- **What you need:** both UIs on the internet over HTTPS, from your laptop and your phone, with only you getting in. ADR 0005 already planned an ALB with OIDC for the cloud.
- **What the harness enforces today:** both ports are bound to loopback only. `gaffer-web` refuses any non-loopback Host (421) and any Origin other than `http://<host>`. ttyd checks Origin against Host and allows one client.
- **What S12 found:**
  - ttyd's `-H` checks only that the header is present (any value passes).
  - ttyd hands the value to its command as `TTYD_USER`.
- **You don't own a domain.** An ALB needs one for an ACM certificate and for Cognito's callback.

## Options considered
1. **An ALB with `authenticate-cognito`,** a Cognito user pool with one user and MFA required, and self-registration off. **Chosen.**
   - It's AWS-native, with no third-party identity provider.
   - The ALB authenticates before any request reaches a target.
   - It signs the user's claims into `x-amzn-oidc-data`, which the harness verifies.
2. **An ALB with `authenticate-oidc` to Google.** Rejected for now. It needs a Google Cloud project and OAuth client, and the Cognito user pool can federate Google later without changing the ALB.
3. **CloudFront in front of the ALB.** Rejected. It adds a layer and a second certificate for one user; WAF can go on the ALB directly if ever needed.
4. **No auth at the edge, auth in the app only.** Rejected. The app would carry a whole login flow, and every request would reach the harness unauthenticated.

## Decision
- **A domain, which you register:**
  - The domain is registered in Route 53 (a `.com` or `.co.uk`; prices in research 17), with its hosted zone.
  - It has two names: `gaffer.<domain>` (the App) and `terminal.<domain>` (the terminal). Separate hostnames avoid path rewriting under ttyd.
  - One ACM certificate covers both, validated through DNS.
- **The ALB** is internet-facing, in two public subnets:
  - HTTPS only (TLS policy `ELBSecurityPolicy-TLS13-1-2-2021-06` or newer); HTTP on 80 just redirects.
  - Idle timeout 3600 s, for ttyd's WebSocket and the App's SSE.
  - **The default action is a fixed 404.** Two host-header rules, `gaffer.<domain>` and `terminal.<domain>`, each run `authenticate-cognito`, then forward to **one target group, `gaffer-web` on 7682**. ttyd isn't a target at all (see below).
  - `deletion_protection` is on; access logs go to S3.
- **Cognito:**
  - one user pool on the **Essentials** plan (free for up to 10,000 MAU; it adds passkeys and managed login), self-registration off, **MFA required** (TOTP or passkey), and a strong password policy;
  - one app client for the ALB (authorization-code grant, `openid email`);
  - managed login on a Cognito domain;
  - the ALB's `SessionTimeout` set to 12 hours (the default is 7 days);
  - one user, you. You set your own password and MFA at first sign-in.
- **The harness verifies the identity itself** when `GAFFER_AUTH=alb` is set (unset on the Mac, where loopback is the boundary).
  - **`gaffer-web`:**
    - verifies `x-amzn-oidc-data` on every request, the event stream included: ES256, the key fetched by `kid` from the region's ALB public-key endpoint and cached, `signer` equal to the ALB's ARN, `exp` in the future;
    - requires the token's `sub` (or `email`) to equal `GAFFER_ALLOWED_SUB` (or `GAFFER_ALLOWED_EMAIL`), and answers 401 otherwise;
    - accepts Host and Origin for `GAFFER_PUBLIC_ORIGIN` (`https://gaffer.<domain>`) as well as loopback;
    - serves `/admin` (FR-ADM-02) behind the same check.
  - **The terminal goes through the same verification.** `x-amzn-oidc-identity` is an *unsigned* header, and no AWS doc says the ALB strips a client's copy (research 17). So ttyd isn't exposed and never trusts it:
    - ttyd binds to `127.0.0.1:7681` inside the task.
    - `gaffer-web` serves `terminal.<domain>`: it verifies `x-amzn-oidc-data` exactly as for the App, then proxies the page and its WebSocket to ttyd on loopback (Node's own `http` upgrade handling, no new dependency).
    - `gaffer-web` sets `X-Gaffer-User` to the verified `sub`, after deleting any copy the client sent.
    - ttyd runs with `-H X-Gaffer-User`, and **`gaffer-pi`** refuses to start Pi unless `TTYD_USER` equals the allowed `sub`.
    - Locally (no `GAFFER_AUTH`), ttyd keeps today's binding and port.
  - **Only the ALB can reach the harness:** its security group allows inbound 7682 only from the ALB's security group. `gaffer-web` binds to the task's private address, and ttyd to loopback.
- **`GAFFER_PUBLIC_ORIGIN`, the allowed identity and the ALB's ARN** are CDK outputs passed to the task as environment, not secrets.

## Consequences
- **You need to buy a domain** (about $15 a year for a `.com` in Route 53; research 17). This is the one thing the small-host plan avoided.
- **Sign-in is Cognito with MFA,** a stronger second factor than relying on a device staying logged in. The ALB's session cookie lasts 12 hours. An open terminal WebSocket can outlive it (the ALB checks only at the handshake); its next reconnect signs in again.
- **Code changes, all in M2-0:**
  - the JWT verification and settings in `gaffer-web`, with tests using a locally generated ES256 key and a fake `signer`;
  - `/admin`;
  - the `TTYD_USER` check in `gaffer-pi`;
  - a bind address that isn't the default-route interface's when an explicit one is given;
  - the terminal proxy (the page and WebSocket upgrade to `127.0.0.1:7681`);
  - the identity tests: no header, a bad signature, a wrong `signer`, an expired token, the wrong user, a forged `x-amzn-oidc-identity` or `X-Gaffer-User`, and the allowed user. Each is checked on every route and on the terminal's WebSocket.
- **First checks on AWS (M2-1):**
  - what the ALB does with client-sent `x-amzn-oidc-*` headers (research 17 found no doc). The design doesn't depend on it;
  - the terminal's WebSocket stays up through the ALB for a whole recommendation;
  - `--check-origin` sees the public Host (the ALB preserves Host).
- **ttyd's one-client limit stays.** The terminal page's reconnect message should say "open in another tab" (BUILD.md, Phase 1.1 close, Proposed).
- **The phone:** the App's phone layout (NFR-A11Y-01) is reachable on a real phone for the first time, through the browser, with no app to install.
