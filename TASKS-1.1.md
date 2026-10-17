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
- [ ] R8 Pi Durable → `docs/research/08-pi-durable.md`, spike S8
- [ ] R9 Codemode and MCP → `docs/research/09-codemode-and-mcp.md`, spikes S3, S4
- [ ] R10 TUI, themes and branding → `docs/research/10-tui-themes-branding.md`, spikes S5, S9
- [ ] R11 Structured agent UI → `docs/research/11-structured-agent-ui.md`, spike S7
- [ ] R12 Harness patterns update → `docs/research/12-harness-patterns-update.md` (+ pointer in 02)

## Spikes
- [ ] S2 `spikes/s2-pi-1x-upgrade` — does Gaffer run unchanged on Pi 1.3.0? (R7)
- [ ] S3 `spikes/s3-mcp-lockdown` — can MCP, codemode, tool_search and llama.cpp be kept off whatever config exists? (R9)
- [ ] S4 `spikes/s4-codemode-guards` — do codemode's nested calls pass Gaffer's guards and accounting? (R9)
- [ ] S5 `spikes/s5-tui-branding` — header, status strip, brand theme, only Gaffer's commands, no Pi patch? (R10)
- [x] S6 `spikes/s6-prompt-cache` — does rewriting `fpl_context` each prompt defeat caching; do mid-conversation system messages fix it? (lead, real model, **$0.1205**) → yes for follow-up prompts (whole prefix re-written); `compat.supportsMidConvoSystemMessages: true` fixes it on 0.87.1 and 1.3.0 alike, follow-ups −75%
- [ ] S7 `spikes/s7-rpc-events` — is `pi --mode rpc` enough to render UI 2 without scraping? (R11)
- [ ] S8 `spikes/s8-durable-gaffer` — a Gaffer-shaped run on pi-durable: LOC and crash resume (R8)
- [ ] S9 `spikes/s9-web-terminal` — Pi 1.3 fullscreen through ttyd; is a node-pty server worth it? (R10)

## Decisions and docs (lead)
- [ ] ADRs from 0009: Pi pinning and upgrade policy; Durable; codemode and MCP posture; TUI branding and blocked commands; second UI and transport; changes to 0007/0008 if justified
- [ ] `docs/MIGRATION-PI-1X.md`
- [ ] `docs/ui/` spec, event → UI table, branding, two visual directions as clickable HTML mockups
- [ ] ARCHITECTURE, REQUIREMENTS (new IDs), ROADMAP (Phase 1.1 section; Phase 2/3 revisions), REPO_LAYOUT updated in place
- [ ] Decision log (`docs/decisions/README.md`) lists the new ADRs and spikes

## Discovered
- [x] **Mid-conversation system messages and prompt-cache warming are not 1.0 features.** Both arrived in **0.86.0** (2026-09-19; coding-agent CHANGELOG `0.86.0` "Transcript-aware prompt and tool updates", "Prompt cache warming"), so Gaffer's 0.87.1 already has them. The brief's version history is wrong on this point; the cache question can be measured on today's pin as well as on 1.3.0.
- [x] `pi-protocol` and `pi-client` stop at 1.1.0 on npm and are gone from the 1.3.0 tree (1.2.0 "Removed"), confirming the brief.
- [x] **Gaffer's `harness/models.json` disables mid-conversation system messages for Sonnet 5.5** (it omits `supportsMidConvoSystemMessages`; the adapter defaults it to false and collapses section patches into a rebuilt leading system prompt). Every follow-up prompt re-writes the whole cached prefix (S6). On 1.3.0 a `models.json` entry *replaces* the catalogue entry, so keeping the override keeps the problem.
- [x] **Gaffer's Sonnet 5.5 cache-read price is wrong:** $0.20/MTok in `harness/models.json` and ADR 0008; the live pricing page (2026-10-17) and Pi 1.3.0's catalogue say $0.10 (0.05× input). Gaffer's costs are about 7% high per recommendation; NFR-COST-03 would fail on this alone.
- [x] Pi's Anthropic adapter only requests `thinking.display` `"summarized"` (default) or `"omitted"`; Sonnet 5.5's `"updates"` progress notes are never requested. Live sessions: 69/201 Sonnet calls carry a short (≈200 char) summarized thinking block.
- [x] Cost recorded per real-model run: S6 $0.0397 + $0.0216 + $0.0375 + $0.0217 = **$0.1205**. Budget for the phase: ≈$3.
- [x] The "experimental durable coding agent" and the vacation-planner demo are not in the 1.3.0 tree: `src/experimental/` holds only `source-resolver.ts`. The demo is in git history (commit `395315f4`); the 1.2.0 removal took the whole experimental stack.
