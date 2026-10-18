# Gaffer — Phase 1.1 working checklist

Branch `phase-1.1-plan`. Brief: `prompts/gaffer-phase-1.1-prompt.md`. Started 2026-10-17 (GW7 in play; GW8 deadline 2026-10-23T17:30Z, GW9 2026-10-31T11:00Z, first-half chips expire at the GW19 deadline 2027-01-01T18:30Z per the live API).

Phase 0's `TASKS.md` is left alone. This file is ticked as work finishes.

## Read Gaffer first
- [x] docs/ (ARCHITECTURE, REQUIREMENTS, ROADMAP, REPO_LAYOUT, ADRs 0001–0008, research 01–06), BUILD.md (M1–M5 incl. Discovered/Proposed), the five extensions, `src/`, harness scripts, eval runner, `evals/results/*summary.json`
- [x] Phase 1 exit check: **not met.** The live ledger (2026-10-17 14:35Z) holds 5 real recommendations, all for GW7, and `outcomes.jsonl` is empty. GW7 is in play; GW8 and GW9 recommendations and their scoring are still needed. Earliest close: GW9 data-checked, about 2026-11-04.

## Pi at the source
- [x] Clone `earendil-works/pi`; worktrees at `v1.3.0` (`71023aec`, 2026-10-15, latest) and `v0.87.1` (`f07218c4`)
- [x] Read the coding-agent changelog 0.87.1 → 1.3.0 (lead)
- [x] Verify each subagent's key claims against source (noted per research item below)

## Research (one subagent each; lead verifies)
- [x] R7 Pi 1.x migration → `docs/research/07-pi-1x-migration.md`, `docs/MIGRATION-PI-1X.md`, spike S2 (claims checked: `models.json` replace rule reproduced in S6 variant A on 1.3.0; built-ins prepended in `main.ts:578`; S2 eval summary read)
- [x] R8 Pi Durable → `docs/research/08-pi-durable.md`, spike S8 (claims checked: README "Experimental", hooks can't abort/steer `types.ts:757-806`, no cross-process locking `README.md:682`, S8 output)
- [x] R9 Codemode and MCP → `docs/research/09-codemode-and-mcp.md`, spikes S3, S4 (claims checked: `stdio.ts:94` env spread, `main.ts:788` `--no-mcp`, `resource-loader.ts:578-583`, `codemode.mode` only `on|only`, S3 results rows)
- [x] R10 TUI, themes and branding → `docs/research/10-tui-themes-branding.md`, spikes S5, S9 (claims checked: hard-coded command list `slash-commands.ts:19-44`, `onSubmit` assignment `interactive-mode.ts:2889`, `/bug` offline refusal; its stop-and-ask resolved by `session-share.ts:68`, see Found)
- [x] R11 Structured agent UI → `docs/research/11-structured-agent-ui.md`, spike S7 (claims checked: RPC `bash` → `emitUserBash` `rpc-mode.ts:561-584`; no session lock, `proper-lockfile` only in settings/auth/trust/MCP OAuth)
- [x] R12 Harness patterns update → `docs/research/12-harness-patterns-update.md` (+ pointer in 02) (claims checked: price cut dated 2026-10-07 in Anthropic release notes; preserved-thinking 400 rule in the API reference; `usage` entries in `session-format.md` @0.87.1 vs `budget.ts:14`)

## Spikes
- [x] S2 `spikes/s2-pi-1x-upgrade` — does Gaffer run unchanged on Pi 1.3.0? (R7) → yes but one test (version hard-coded); 227/227 + 10/10, S1 8/8, same 17 type errors, faux eval identical, `verify.sh` passes
- [x] S3 `spikes/s3-mcp-lockdown` — can MCP, codemode, tool_search and llama.cpp be kept off whatever config exists? (R9) → yes with `--no-mcp` + `-builtin:*` settings + `--tools`; **Gaffer's current line spawns any configured MCP server with the key**
- [x] S4 `spikes/s4-codemode-guards` — do codemode's nested calls pass Gaffer's guards and accounting? (R9) → guard yes; budget no (`models.*` spend invisible); nested submit wouldn't terminate
- [x] S5 `spikes/s5-tui-branding` — header, status strip, brand theme, only Gaffer's commands, no Pi patch? (R10) → yes; command refusal relies on an undocumented `onSubmit` seam (regression test)
- [x] S6 `spikes/s6-prompt-cache` — does rewriting `fpl_context` each prompt defeat caching; do mid-conversation system messages fix it? (lead, real model, **$0.1637** incl. a thinking follow-up run) → yes for follow-up prompts (whole prefix re-written); `compat.supportsMidConvoSystemMessages: true` fixes it on 0.87.1 and 1.3.0 alike, follow-ups −75%
- [x] S7 `spikes/s7-rpc-events` — is `pi --mode rpc` enough to render UI 2 without scraping? (R11) → yes; `export_html`/`switch_session` reach arbitrary paths (allowlist)
- [x] S8 `spikes/s8-durable-gaffer` — a Gaffer-shaped run on pi-durable: LOC and crash resume (R8) → 68 lines for the core (same as S1); resume works; `watch()` is single-process; two owners double-run
- [x] S10 `spikes/s10-real-model-1x` — does the M1.1-1 configuration (Pi 1.3.0, catalogue model entry) hold up with a real model, and does Haiku 5.5 qualify? (lead, real model, **$0.788**) → Sonnet 5.5 on 1.3.0: 6/6 first-attempt, points identical to 0.87.1; Haiku 5.5: 30/30 valid at $0.0086 but p50 101 s, 9/30 first-attempt, 5 worse than G0 → not adopted
- [x] S9 `spikes/s9-web-terminal` — Pi 1.3 fullscreen through ttyd; is a node-pty server worth it? (R10) → works; copy silently broken (OSC 52); keep ttyd, fix with ~10 lines

## Decisions and docs (lead)
- [x] ADR 0010 (per-prompt context as mid-conversation system messages; prices), ADR 0011 (Durable deferred); ADR 0007 reaffirmed with the isolated-critic note; ADR 0008 amended
- [x] ADR 0009 (Pi version policy), 0012 (built-ins locked off; ADR 0002 amended), 0013 (Gaffer Terminal), 0014 (Gaffer App; supersedes ADR 0005's Phase 3 part)
- [x] ADR index; ADR 0005 marked superseded in part
- [x] `docs/MIGRATION-PI-1X.md` (R7's inventory, with the lead's corrections from S3 and ADR 0013)
- [x] `docs/ui/` branding (mark, ASCII wordmark, tokens), two visual directions as clickable HTML mockups (`mockups/index.html`, `mockups/terminal.html`), spec draft
- [x] `docs/ui/README.md` §7–8: event → UI table and what the agent must emit
- [x] ARCHITECTURE, REQUIREMENTS (new IDs), ROADMAP (Phase 1.1 section; Phase 2/3 revisions), REPO_LAYOUT updated in place
- [x] Decision log (`docs/decisions/README.md`) lists the new ADRs and spikes

## Discovered
- [x] **The scratchpad (a temp directory) was wiped during a pause** (between 2026-10-17 23:00 and 2026-10-18 08:54 UTC): Pi clones and three draft notes were lost. Spike dirs in the repo and the spike/s2 branch survived; R10 and R11 rewrote their notes from context; Pi was re-cloned into gitignored `var/phase11/`. Drafts now live there.
- [x] **R10's stop-and-ask is resolved, not escalated.** No supported Pi switch removes built-in commands, but `sessionShareDestination: "gist"` makes `/share` skip Radius (`session-share.ts:68`) and need a `gh` CLI the image lacks; `PI_OFFLINE=1` refuses `/bug` uploads; `--no-mcp` neutralises `/login`'s Radius MCP write. The publish and credential paths are closed by supported controls; the undocumented editor hook is defence in depth (ADR 0013).
- [x] **The local sandbox is shared by every Pi process and releasing a session clears `/work`** (`src/sandbox.ts:17-26`), so a second UI needs a run lock in Phase 1.1 (ADR 0014).
- [x] **Pi does not lock session files** (R11): two UIs on one session would interleave entries. Gaffer adds a session lock in `gaffer-core` (ADR 0014).
- [x] **Copy has never worked in the browser terminal** (S9: tmux drops Pi's OSC 52; ttyd 1.7.7 has no handler); ttyd also runs without `--check-origin`, against ADR 0005.
- [x] **Mid-conversation system messages and prompt-cache warming are not 1.0 features.** Both arrived in **0.86.0** (2026-09-19; coding-agent CHANGELOG `0.86.0` "Transcript-aware prompt and tool updates", "Prompt cache warming"), so Gaffer's 0.87.1 already has them. The brief's version history is wrong on this point; the cache question can be measured on today's pin as well as on 1.3.0.
- [x] `pi-protocol` and `pi-client` stop at 1.1.0 on npm and are gone from the 1.3.0 tree (1.2.0 "Removed"), confirming the brief.
- [x] **Gaffer's `harness/models.json` disables mid-conversation system messages for Sonnet 5.5** (it omits `supportsMidConvoSystemMessages`; the adapter defaults it to false and collapses section patches into a rebuilt leading system prompt). Every follow-up prompt re-writes the whole cached prefix (S6). On 1.3.0 a `models.json` entry *replaces* the catalogue entry, so keeping the override keeps the problem.
- [x] **Gaffer's Sonnet 5.5 cache-read price is wrong:** $0.20/MTok in `harness/models.json` and ADR 0008; the live pricing page (2026-10-17) and Pi 1.3.0's catalogue say $0.10 (0.05× input). Gaffer's costs are about 7% high per recommendation; NFR-COST-03 would fail on this alone.
- [x] Pi's Anthropic adapter only requests `thinking.display` `"summarized"` (default) or `"omitted"`; Sonnet 5.5's `"updates"` progress notes are never requested. Live sessions: 69/201 Sonnet calls carry a short (≈200 char) summarized thinking block.
- [x] Cost recorded per real-model run: S6 $0.0397 + $0.0216 + $0.0375 + $0.0217 + $0.0432 (thinking follow-up) + $0.0330 (variant C) = **$0.1967**; S10 $0.1729 (aborted `--package repo` attempt, 2 cases) + $0.0458 (setup check) + $0.2808 (Sonnet, 5 cases) + $0.2880 (Haiku, 30 cases) = **$0.7875**. **Phase 1.1 total: $0.98** of the ≈ $3 budget.
- [x] **The eval runner's `--package repo` mode loses Gaffer's skills when the package is reached through a symlink** (Gaffer's `read` override compares against the real path). S10's first attempt was aborted for it; harmless in the image, worth a `realpath` fix.
- [x] **The Sonnet 5.5 cache-read cut is dated 2026-10-07** (Anthropic release notes), not 2026-09-28 as first written in S6: Gaffer's $0.20 was right at launch and stale from 10-07. Corrected in S6 and ADR 0010 (R12 caught it).
- [x] **A follow-up after a thinking block would 400 on accounts created after 2026-08-31** with Gaffer's current config (rebuilt `system` invalidates thinking blocks; Pi 0.87.1 only sends `drop_block` with `supportsMidConvoEffort`). Gaffer's own account is not enforced (S6 `A-0.87.1-think` returned normally); no live session has had such a follow-up yet.
- [x] **Gaffer's caps miss Pi `usage` entries** (cache warming, summaries; `session-format.md` @0.87.1). None in the 75 live sessions yet. NFR-COST-05.
- [x] Rate limits paused all six research agents twice (≈8 h lost, 15:45–23:00 UTC); they were resumed, not restarted.
- [x] The "experimental durable coding agent" and the vacation-planner demo are not in the 1.3.0 tree: `src/experimental/` holds only `source-resolver.ts`. The demo is in git history (commit `395315f4`); the 1.2.0 removal took the whole experimental stack.

---

## Blocked on me
- **Approve the Phase 1.1 plan and its first window.** M1.1-0 is a two-line `harness/models.json` change plus counting Pi's `usage` entries and ttyd `--check-origin`; it should land by **2026-10-21**, at least 48 h before the GW8 deadline (2026-10-23 17:30Z). M1.1-1 (Pi 1.3.0 with the lock) then deploys between the GW8 and GW9 deadlines. Nothing was changed on `main`.
- **Phase 1 exit still needs you:** recommendations before the GW8 and GW9 deadlines, and `gaffer-eval` run after GW7, GW8 and GW9 are data-checked (about 10-21, 10-28, 11-04). Nothing runs it on a schedule yet (BUILD.md M5, "decide later").
- **NFR-COST-03:** the Console comparison is still yours, and must use Sonnet 5.5's cache-read price of $0.10 for any window after 2026-10-07 (ADR 0010); Gaffer's own figures since then are about 7% high.
- **ADR 0013 accepts an undocumented Pi seam** (`CustomEditor.onSubmit`) to refuse built-in commands, guarded by a regression test; the security guarantees rest on supported settings. If you'd rather push upstream for a supported switch, Pi's `disabledCommands` proposal (#8325, closed unmerged 2026-08-18) is the place.
- **Egress allowlist for the harness becomes a Phase 2 requirement** (ADR 0013); it needs an AWS Network Firewall (or equivalent) budget decision.
- **By hand in a normal browser** (automation can't check these): copy after M1.1-2's OSC 52 fix, Ctrl+Home/Ctrl+End through ttyd and tmux, and M4's Ctrl+C and wheel-speed checks.
- **Leftovers to prune when you like** (kept because they're cheap and nothing here deletes data): the S2 images `gaffer-harness:s2` and `gaffer-sandbox:s2`; the S10 volumes `gaffer-s10_sessions` and `gaffer-s10_data`; the gitignored `var/phase11/` (Pi clones and the subagents' drafts); the branch `spike/s2-pi-1x-upgrade` (never to be merged).
- **Still open from Phase 1** (unchanged; not Phase 1.1's to solve): FR-DAT-08 reference accounts, FR-DAT-10's pre-deadline snapshot trigger, FR-RUL-02's four-from-one-club rule, NFR-PORT-01's second provider, enabling Actions and Renovate for NFR-MNT-02.

## Produced
- **Research** (`docs/research/`): 07 Pi 1.x migration, 08 Pi Durable, 09 codemode and MCP, 10 TUI, themes and branding, 11 structured agent UI, 12 harness patterns update (with a pointer added to 02). Each ends with dated Sources and an Unconfirmed list.
- **Migration:** `docs/MIGRATION-PI-1X.md`, the inventory of every Pi API, event, flag, setting, env var and file format Gaffer touches, with status at 1.3.0, the change, a citation, the upgrade order and each step's gate.
- **ADRs** (`docs/decisions/`): 0009 Pi version policy; 0010 per-prompt context as mid-conversation system messages and live prices; 0011 Durable deferred with triggers; 0012 MCP, codemode, tool search and llama.cpp locked off; 0013 Gaffer Terminal; 0014 Gaffer App and transport. Amended: 0002 (context), 0007 (reaffirmed), 0008 (prices, Haiku candidate); 0005 superseded in part. Index updated with S2–S10.
- **UI** (`docs/ui/`): the spec for both UIs (principles, branding, IA, screens, every state, the event → UI table, what the agent must emit, accessibility); the brand mark (SVG), ASCII wordmark and colour tokens; clickable mockups of the Gaffer App in two visual directions, light and dark (`mockups/index.html`), and of the Gaffer Terminal at 100 columns (`mockups/terminal.html`).
- **Updated in place:** ARCHITECTURE (Pi 1.3.0 baseline, extension points, both UIs, built-ins off, harness features, evals, deployment, NFRs, facts), REQUIREMENTS (FR-UI-05…13; NFR-COST-04/05, NFR-SEC-07/08/09, NFR-MNT-04/05, NFR-REL-03, NFR-LAT-04, NFR-A11Y-01; FR-UI-01 and NFR-SEC-05 revised), ROADMAP (Phase 1.1, M1.1-0 to M1.1-4 on the live calendar; Phases 2 and 3 revised; risks), REPO_LAYOUT.
- **Spikes** (`spikes/`, never merged): S2 Pi 1.3.0 upgrade (branch `spike/s2-pi-1x-upgrade`), S3 MCP lockdown, S4 codemode guards, S5 TUI branding, S6 prompt cache (real model), S7 RPC events, S8 Durable, S9 web terminal, S10 real-model checks on 1.3.0.

## Found
1. **On Pi 1.x, Gaffer's current launch line would run any configured MCP server next to the API key.** `--tools` hides MCP tools from the model, but since 1.0.4 servers named in `mcp.json` are still spawned, with the harness environment including `ANTHROPIC_API_KEY` (S3; `packages/mcp/src/transports/stdio.ts:94`). `/login` → Radius offers to write such a file. The fix is supported (`--no-mcp` plus `-builtin:` settings) and must ship in the same deploy as the upgrade (ADR 0012).
2. **Every follow-up prompt re-writes the whole prompt cache today, and on newer Anthropic accounts would fail.** Gaffer's own `models.json` entry for Sonnet 5.5 omits `supportsMidConvoSystemMessages`, so the per-prompt `fpl_context` rebuilds the system prompt. Follow-ups cost 4× more than they need to, and a rebuilt system prompt invalidates thinking blocks, which accounts created after 2026-08-31 reject with a 400 (Gaffer's account predates that). A one-line config change fixes both on 0.87.1 (S6, ADR 0010).
3. **Gaffer's cost figures have been about 7% high since 2026-10-07:** Anthropic halved Sonnet 5.5's cache-read price that day, and Gaffer's `models.json` still says $0.20. Pi 1.3.0's catalogue has the right price, but a same-id `models.json` entry *replaces* the catalogue entry (no merge), so keeping the override keeps the error.
4. **Eleven Pi releases changed no line of Gaffer's extension code.** S2 needed one test fix; 237 tests, the S1 checks and the faux eval were identical on 1.3.0. The brief expected `before_agent_start` and `deliverAs` to bite; Gaffer only touches the shared part of the event and uses `sendMessage`, not `sendUserMessage`. The cost of being a Pi package moved into configuration that silently changed meaning: the `models.json` replace rule, built-ins that load by default, and an npm install that no longer pins its dependency tree.
5. **Pi has no supported way to remove a built-in slash command,** and the TUI dispatches them before an extension can see them. Gaffer refuses them through an undocumented editor seam (S5) and relies on supported settings for what matters: `sessionShareDestination: "gist"` means `/share` never tries Radius and needs a `gh` CLI the image lacks; `PI_OFFLINE` refuses `/bug` uploads. R10 raised this as a stop-and-ask; the source showed the supported controls are enough (ADR 0013).
6. **Two UIs on one session store need locks Pi doesn't have.** Pi appends session files with no lock, and the local sandbox is shared by every Pi process (releasing one clears `/work`). Gaffer adds a session lock and, until per-session sandboxes in Phase 2, a run lock (ADR 0014).
7. **Copy has never worked in the browser terminal** (tmux drops Pi's OSC 52; ttyd 1.7.7 has no handler), and ttyd runs without the `--check-origin` that ADR 0005 recommended (S9).
8. **Pi Durable isn't a base for Gaffer today.** The core ports in the same 68 lines as on Pi, but skills, templates, packages, the TUI and RPC are missing; it is marked experimental (14 breaking changes in 14 days); `watch()` works within one process only; and there is no scheduler, only a sleep inside a live process (S8, ADR 0011).
9. **The brief's version history was wrong in places:** mid-conversation system messages and cache warming arrived in 0.86.0 (already in Gaffer's pin), not 1.0; `gaffer-budget` doesn't use `before_agent_start`; the experimental durable agent and vacation planner were removed in 1.2.0; Pi offers no `display: "updates"` thinking.
10. **Haiku 5.5 is not good enough to replace Sonnet 5.5 for Gaffer, despite being 7× cheaper:** 30/30 valid, but latency p50 101 s (over NFR-LAT-01), only 9/30 first-time submissions, and noisier points (S10). On Pi 1.3.0 with the catalogue entry, Sonnet 5.5 behaved exactly as on 0.87.1.
11. **The Phase 1 exit criterion is not met yet** (five real GW7 recommendations, no scored outcome); Phase 1.1's milestones are placed so live use is never interrupted, with the big change (the App) in the international break.
