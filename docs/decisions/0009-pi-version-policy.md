# ADR 0009 — Pi version: move to 1.3.0 in Phase 1.1, then one minor at a time, landed after a deadline

**Status:** Accepted · **Date:** 2026-10-17 · **Evidence:** [research 07](../research/07-pi-1x-migration.md), [MIGRATION-PI-1X](../MIGRATION-PI-1X.md), [spike S2](../../spikes/s2-pi-1x-upgrade/README.md), [spike S6](../../spikes/s6-prompt-cache/README.md) · **Requirements:** NFR-MNT-01, -02, -04, -05

## Context
Gaffer was pinned to `@earendil-works/pi-coding-agent` 0.87.1 (2026-09-22) for Phase 1. Pi has since shipped 0.99.0–0.99.2, 1.0.0–1.0.4, 1.1.0, 1.2.0 and 1.3.0 (2026-10-15): eleven releases in 24 days. Five things from that history shape the policy:
- **The upgrade is small for Gaffer's code.** Spike S2 bumped the three Pi packages and the image to 1.3.0 and changed one test that hard-coded `"0.87.1"`. All 237 unit and extension tests passed (the S1 checks included), the type errors were the same 17 as before, the image built, and the faux eval passed 30/30 with the same points and latency as on 0.87.1. No extension or `src/` line had to change (MIGRATION-PI-1X §4–6).
- **The risk is in configuration and new built-ins, not the API.** On 1.3.0 a `models.json` entry with the same id *replaces* the catalogue entry, so Gaffer's Sonnet 5.5 override would keep the stale price and the missing mid-conversation flag (ADR 0010). Four built-in extensions (MCP, codemode, tool search, llama.cpp) now load in the TUI, though not in the SDK hosts the tests use, so the tested and shipped configurations differ unless Gaffer turns them off (ADR 0012). New built-in commands appear (`/mcp`, `/llama`) and `/share` gained a Radius destination (ADR 0013).
- **Pi's minor versions break things.** 1.2.0 changed `before_agent_start`'s type and `sendUserMessage`'s contract; 0.99.0 changed what `--no-extensions` means. Semver can't be relied on to mean "safe".
- **Transitive dependencies are no longer pinned by Pi.** Since 1.0.1 the npm package ships no `npm-shrinkwrap.json`, so `npm install -g …@1.3.0` resolves its dependency tree afresh on every build (MIGRATION-PI-1X §1). NFR-MNT-01's "pinned version" now pins only the top package.
- **Gaffer is in live use.** Phase 1's exit needs recommendations for three consecutive live GWs; GW7 is in play, GW8's deadline is 2026-10-23 17:30Z and GW9's is 2026-10-31 11:00Z. A broken harness near a deadline costs the user a GW.

## Options considered
1. **Stay on 0.87.1 until Phase 2.** No churn now, but every later upgrade is bigger. Gaffer forgoes the Sonnet 5.5 catalogue entry, Haiku 5.5, and the fixes since September, and keeps an ADR-0005 assumption (pi-server) that no longer holds. Rejected.
2. **Track every Pi release automatically** (Renovate automerge on green CI). Pi ships weekly or faster, CI doesn't run a real model, and a release can turn on new built-ins. Rejected.
3. **Move to the latest release now, then upgrade one minor version at a time on Gaffer's own schedule, gated and landed after a deadline.** **Chosen.**

## Decision
**Now (Phase 1.1, milestone M1.1-1):** upgrade to **1.3.0** in the order MIGRATION-PI-1X §9 gives, after the GW8 deadline and before the GW9 deadline. The model-config fix (ADR 0010) and counting `usage` entries ship first on 0.87.1 (M1.1-0), so the upgrade itself changes no behaviour except the built-ins, which are switched off in the same step.

**From then on:**
- **Pinning.** Exact versions for the three Pi packages, and a committed lockfile for the harness image's Pi install (`npm ci` from `harness/pi/package-lock.json`), so the whole tree is pinned again (NFR-MNT-01).
- **Cadence.** Consider each new Pi **minor** within about three weeks of its release, one minor at a time. Take a **patch** release only if it fixes something Gaffer hits or a security issue. Skip a release with a one-line reason in the upgrade PR rather than leaving it pending.
- **When it lands.** Deploy an upgrade in the 48 hours after a GW deadline, never in the 48 hours before one. That leaves the most time to roll back before the next deadline. Around the GW19 chip expiry (2027-01-01) and the double and blank GWs (historically GW29–37), freeze upgrades for a week.
- **Rollback.** Keep the previous harness image tagged by Pi version (`gaffer-harness:pi-1.3.0`); rollback is a re-tag and `docker compose up -d`. Session files must stay readable by the previous version (Pi's session format version is checked in the upgrade PR).
- **Gates** (all in the upgrade PR, NFR-MNT-02 and -04):
  1. `pnpm test` with the S1 checks as tests; typecheck error set no larger than before
  2. sandboxd and `gaffer_lib` suites
  3. `deploy/compose/tests/verify.sh` on the new images
  4. `pnpm eval --model faux`: 30/30 valid, points equal to G0
  5. ≥ 5 real-model cases, including one with a follow-up prompt (cost per session, NFR-COST-04), and a look at the TUI in the browser
  6. the lock tests: no MCP, codemode, tool search or llama.cpp (NFR-SEC-08), and the command surface (FR-UI-06, NFR-SEC-09)
  7. the price and compat check for the default model (NFR-MNT-05)
- **Changelog review.** The PR lists, from Pi's changelogs, anything touching: built-in extensions and their defaults; slash commands and keybindings; `before_agent_start`, `tool_call`, `user_bash`, `input` and the tool definition; the session format and `SessionEntry`; settings defaults; the model catalogue and prices; `--tools`, `--continue` and `--session-dir` semantics.
- **`models.json`** holds only models the catalogue lacks. A change to a catalogue model uses `modelOverrides`, which merges, not a same-id entry, which replaces.

## Consequences
- After M1.1-1 Gaffer can't return to 0.87.1 except by rollback in the same window; the 0.87.1 image is kept until Phase 1.1 closes.
- The theory holds so far: eleven Pi releases changed no line of Gaffer's extension code, though the brief expected `before_agent_start` and `deliverAs` to bite (Gaffer only touches the shared part of the event and uses `sendMessage`, not `sendUserMessage`). The cost of being a Pi package showed up instead as configuration that silently changed meaning: the `models.json` replace rule, built-ins that load by default, and an unpinned dependency tree. The upgrade gates now look for exactly those.
- The tested and shipped configurations stay the same: the SDK hosts load no built-ins, and the image turns them off by name.
- Renovate still opens the PR (grouped, never automerged, `renovate.json`); a human runs the real-model gate and chooses the deploy time.
- ROADMAP's "Pi API churn" risk is managed by this ADR and adds ADR 0011's Durable triggers to the same review.
