# Gaffer — Phase 1.1 working checklist

Branch `phase-1.1-plan`. Brief: `prompts/gaffer-phase-1.1-prompt.md`. Started 2026-10-17 (GW7 in play; GW8 deadline 2026-10-23T17:30Z, GW9 2026-10-31T11:00Z, first-half chips expire at the GW19 deadline 2027-01-01T18:30Z per the live API).

Phase 0's `TASKS.md` is left alone. This file is ticked as work finishes.

## Read Gaffer first
- [x] docs/ (ARCHITECTURE, REQUIREMENTS, ROADMAP, REPO_LAYOUT, ADRs 0001–0008, research 01–06), BUILD.md (M1–M5 incl. Discovered/Proposed), the five extensions, `src/`, harness scripts, eval runner, `evals/results/*summary.json`
- [x] Phase 1 exit check: **not met.** The live ledger (2026-10-17 14:35Z) holds 5 real recommendations, all for GW7, and `outcomes.jsonl` is empty. GW7 is in play; GW8 and GW9 recommendations and their scoring are still needed. Earliest close: GW9 data-checked, about 2026-11-04.

## Pi at the source
- [x] Clone `earendil-works/pi`; worktrees at `v1.3.0` (`71023aec`, 2026-10-15, latest) and `v0.87.1` (`f07218c4`)
- [x] Read the coding-agent changelog 0.87.1 → 1.3.0 (lead)
- [ ] Verify each subagent's key claims against source

## Research (one subagent each; lead verifies)
- [ ] R7 Pi 1.x migration → `docs/research/07-pi-1x-migration.md`, `docs/MIGRATION-PI-1X.md`, spike S2
- [x] R8 Pi Durable → `docs/research/08-pi-durable.md`, spike S8 (claims checked: README "Experimental", hooks can't abort/steer `types.ts:757-806`, no cross-process locking `README.md:682`, S8 output)
- [ ] R9 Codemode and MCP → `docs/research/09-codemode-and-mcp.md`, spikes S3, S4
- [ ] R10 TUI, themes and branding → `docs/research/10-tui-themes-branding.md`, spikes S5, S9
- [ ] R11 Structured agent UI → `docs/research/11-structured-agent-ui.md`, spike S7
- [x] R12 Harness patterns update → `docs/research/12-harness-patterns-update.md` (+ pointer in 02) (claims checked: price cut dated 2026-10-07 in Anthropic release notes; preserved-thinking 400 rule in the API reference; `usage` entries in `session-format.md` @0.87.1 vs `budget.ts:14`)

## Spikes
- [ ] S2 `spikes/s2-pi-1x-upgrade` — does Gaffer run unchanged on Pi 1.3.0? (R7)
- [ ] S3 `spikes/s3-mcp-lockdown` — can MCP, codemode, tool_search and llama.cpp be kept off whatever config exists? (R9)
- [ ] S4 `spikes/s4-codemode-guards` — do codemode's nested calls pass Gaffer's guards and accounting? (R9)
- [ ] S5 `spikes/s5-tui-branding` — header, status strip, brand theme, only Gaffer's commands, no Pi patch? (R10)
- [x] S6 `spikes/s6-prompt-cache` — does rewriting `fpl_context` each prompt defeat caching; do mid-conversation system messages fix it? (lead, real model, **$0.1637** incl. a thinking follow-up run) → yes for follow-up prompts (whole prefix re-written); `compat.supportsMidConvoSystemMessages: true` fixes it on 0.87.1 and 1.3.0 alike, follow-ups −75%
- [ ] S7 `spikes/s7-rpc-events` — is `pi --mode rpc` enough to render UI 2 without scraping? (R11)
- [x] S8 `spikes/s8-durable-gaffer` — a Gaffer-shaped run on pi-durable: LOC and crash resume (R8) → 68 lines for the core (same as S1); resume works; `watch()` is single-process; two owners double-run
- [ ] S9 `spikes/s9-web-terminal` — Pi 1.3 fullscreen through ttyd; is a node-pty server worth it? (R10)

## Decisions and docs (lead)
- [x] ADR 0010 (per-prompt context as mid-conversation system messages; prices), ADR 0011 (Durable deferred); ADR 0007 reaffirmed with the isolated-critic note; ADR 0008 amended
- [ ] Remaining ADRs from 0009: Pi pinning and upgrade policy; Durable; codemode and MCP posture; TUI branding and blocked commands; second UI and transport; changes to 0007/0008 if justified
- [ ] `docs/MIGRATION-PI-1X.md`
- [x] `docs/ui/` branding (mark, ASCII wordmark, tokens), two visual directions as clickable HTML mockups (`mockups/index.html`, `mockups/terminal.html`), spec draft
- [ ] `docs/ui/README.md` §7–8: event → UI table and what the agent must emit (after R11)
- [ ] ARCHITECTURE, REQUIREMENTS (new IDs), ROADMAP (Phase 1.1 section; Phase 2/3 revisions), REPO_LAYOUT updated in place
- [ ] Decision log (`docs/decisions/README.md`) lists the new ADRs and spikes

## Discovered
- [x] **Mid-conversation system messages and prompt-cache warming are not 1.0 features.** Both arrived in **0.86.0** (2026-09-19; coding-agent CHANGELOG `0.86.0` "Transcript-aware prompt and tool updates", "Prompt cache warming"), so Gaffer's 0.87.1 already has them. The brief's version history is wrong on this point; the cache question can be measured on today's pin as well as on 1.3.0.
- [x] `pi-protocol` and `pi-client` stop at 1.1.0 on npm and are gone from the 1.3.0 tree (1.2.0 "Removed"), confirming the brief.
- [x] **Gaffer's `harness/models.json` disables mid-conversation system messages for Sonnet 5.5** (it omits `supportsMidConvoSystemMessages`; the adapter defaults it to false and collapses section patches into a rebuilt leading system prompt). Every follow-up prompt re-writes the whole cached prefix (S6). On 1.3.0 a `models.json` entry *replaces* the catalogue entry, so keeping the override keeps the problem.
- [x] **Gaffer's Sonnet 5.5 cache-read price is wrong:** $0.20/MTok in `harness/models.json` and ADR 0008; the live pricing page (2026-10-17) and Pi 1.3.0's catalogue say $0.10 (0.05× input). Gaffer's costs are about 7% high per recommendation; NFR-COST-03 would fail on this alone.
- [x] Pi's Anthropic adapter only requests `thinking.display` `"summarized"` (default) or `"omitted"`; Sonnet 5.5's `"updates"` progress notes are never requested. Live sessions: 69/201 Sonnet calls carry a short (≈200 char) summarized thinking block.
- [x] Cost recorded per real-model run: S6 $0.0397 + $0.0216 + $0.0375 + $0.0217 + $0.0432 (thinking follow-up) = **$0.1637**. Budget for the phase: ≈$3.
- [x] **The Sonnet 5.5 cache-read cut is dated 2026-10-07** (Anthropic release notes), not 2026-09-28 as first written in S6: Gaffer's $0.20 was right at launch and stale from 10-07. Corrected in S6 and ADR 0010 (R12 caught it).
- [x] **A follow-up after a thinking block would 400 on accounts created after 2026-08-31** with Gaffer's current config (rebuilt `system` invalidates thinking blocks; Pi 0.87.1 only sends `drop_block` with `supportsMidConvoEffort`). Gaffer's own account is not enforced (S6 `A-0.87.1-think` returned normally); no live session has had such a follow-up yet.
- [x] **Gaffer's caps miss Pi `usage` entries** (cache warming, summaries; `session-format.md` @0.87.1). None in the 75 live sessions yet. NFR-COST-05.
- [x] Rate limits paused all six research agents twice (≈8 h lost, 15:45–23:00 UTC); they were resumed, not restarted.
- [x] The "experimental durable coding agent" and the vacation-planner demo are not in the 1.3.0 tree: `src/experimental/` holds only `source-resolver.ts`. The demo is in git history (commit `395315f4`); the 1.2.0 removal took the whole experimental stack.
