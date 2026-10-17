# R12 — Agent harness patterns, August–October 2026: an update to note 02

_Researched 2026-10-17 (researcher R12, Phase 1.1). Paraphrased; quotes kept under 15 words. Web research plus source reading; no spikes and no paid model calls. The prompt-caching claims are measured by spike S6 (`spikes/s6-prompt-cache/`), which this note cites but does not repeat._

**Scope.** What was published from mid-August to mid-October 2026 on nine harness topics, read against [note 02](02-harness-patterns.md) (2026-09-27), [ARCHITECTURE §5](../ARCHITECTURE.md), [ADR 0007](../decisions/0007-no-subagents.md) and [ADR 0008](../decisions/0008-model-and-budget.md). A few earlier sources that note 02 did not cite are included and dated as such.

**Versions read.** Pi at **v0.87.1** (Gaffer's pin, `f07218c4`), **v0.99.0** and **v1.3.0** (`71023aec`, 2026-10-15). Paths: `ai/…` = `packages/ai/…`, `ca/…` = `packages/coding-agent/…`. Gaffer paths are relative to the repo root.

**The lens (unchanged from 02).** One linear run per question, minutes long, 4–5 model calls, about $0.06 median on `claude-sonnet-5-5` at thinking `medium`, seven tools, a no-network Python sandbox, and the Pi session JSONL as system of record. A pattern earns a place only if Gaffer can't do without it.

---

## TL;DR for Gaffer

Most of the period's news confirms note 02. Three findings change something.

| # | Finding | Evidence | What it changes |
|---|---|---|---|
| 1 | **Gaffer's per-prompt sections reach Sonnet 5.5 by rewriting the top-level system prompt.** The `now:` line in `fpl_context` changes on every prompt. Gaffer's own `harness/models.json` entry has no `supportsMidConvoSystemMessages`, so Pi 0.87.1 folds the section update into the leading system prompt. That re-bills the whole history on every follow-up prompt. | `ai/src/api/anthropic-messages.ts:217,517 @v0.87.1`; `ai/src/utils/transcript.ts:105-120 @v0.87.1`; `packages/pi-gaffer/src/prompt.ts:78`; spike S6 (follow-ups 75% cheaper with the flag) | Caching approach (new ADR). Mid-conversation system messages are the documented fix. |
| 2 | **The same rewrite can break follow-ups outright on newer Anthropic accounts.** On Sonnet 5.5, Opus 5.5, Haiku 5.5 and Fable 5.1, a changed `system` fails the "prefix check" for every earlier thinking block. For accounts created on or after 2026-08-31 the default is a **400 error**. Pi only opts into `drop_block` when `supportsMidConvoEffort` is set, which Gaffer's entry also lacks. Pi resends same-model thinking blocks with signatures. | Anthropic preserved-thinking docs (read 2026-10-17); `ai/src/api/anthropic-messages.ts:1151-1158 @v0.87.1`; `ai/src/api/transform-messages.ts:109 @v0.87.1` | Same fix. Mirror the built-in catalogue's compat flags (or upgrade). **Checked by the lead afterwards (S6 run `A-0.87.1-think`):** Gaffer's own account is not enforced (a follow-up after a thinking block returned normally), so live use is unaffected today; a key from an account created after 2026-08-31 would get the 400. |
| 3 | **Budget and usage miss Pi's non-message spend.** Pi records cache-warming refreshes (on by default, mode `"streaming"`) and summarisation as `type: "usage"` entries. `gaffer-budget` and `/usage` sum only assistant `message` entries. | `ca/src/core/settings-manager.ts:157 @v0.87.1`; `ca/docs/session-format.md:113 @v0.87.1`; `packages/pi-gaffer/src/budget.ts:14` | ADR 0008's "one source for spend" holds only once `usage` entries are counted (or warming is turned off). |

Reaffirmed, with new evidence:
- **ADR 0007 (no subagents) stands.** Cognition now ships a lead plus a cheap "sidekick", but says short tasks gain little.
- **Compaction stays a safety net.** A controlled study found full history beat summarisation on both recall and cost.
- **Tool search and code mode stay off.** Gaffer has seven compact tools and already runs code in its sandbox.
- **Durable execution stays out of scope.** Pi Durable is experimental.

Smaller items:
- Sonnet 5.5 cache reads fell from $0.20 to **$0.10/MTok on 2026-10-07**.
- **Haiku 5.5** launched the same day at $0.10/$0.50 per MTok, a candidate for the eval suite to qualify.
- Sonnet 5.5's guidance on progress updates, mid-turn messages and pasted text matters for the UIs and the budget steer (§10).

---

## 1. Compaction

**What's new.**
- **Pi's own explanation** (Earendil, 13 Aug 2026).
  - Auto-compaction runs after a turn when the context nears the window, mid-turn on an overflow error, or on `/compact`.
  - Recent messages up to a token budget are kept verbatim. The rest goes to a standalone summarisation request, which can use a cheaper model.
  - The summary is stored in plain text, which keeps it portable across models.
  - The post states that compaction breaks the prompt cache: the first request afterwards recomputes from the first changed token.
  - Defaults at 0.87.1: `reserveTokens` 16,384 and `keepRecentTokens` 20,000 (`ca/docs/settings.md:54-56 @v0.87.1`).
  - Since 0.87.1, thinking blocks are left out of the summarised text (1.2.0 changelog). Per-model compaction budgets arrived in 0.86.0.
- **Anthropic server-side compaction.**
  - "Compaction on demand" is in beta (`compact-2026-09-04`, release note 2026-09-14). It returns a signed `compaction` block that stands in for earlier turns.
  - The docs now recommend it over the threshold mode. Both modes keep recent turns, and on-demand can run in the background.
  - Pi does not use either mode. It summarises on the client.
- **Evidence against summarising** (Bouchard et al., 18 Aug 2026; a production tutor, 11–13-turn sessions, small trial counts).
  - Full history recalled a planted fact 92% of the time; the production summarise-and-clear preset managed 38%.
  - Full history was also cheaper: $0.11 against $0.24 per turn, because about 87% of its input was billed at the cache rate.
  - Capping tool outputs at a stable size cut cost by 38% with no loss of recall.
  - Their rule: "Shrink the context, don't rewrite it."
- **SoL-Pi** (arXiv 2609.20519, 17 Sep 2026). An auto-research loop over Pi's own harness. It kept four mechanisms, including context compaction and "delegated reading", and cut token traffic by 45–49% against stock Pi at similar scores. Abstract only.
- **Cross-harness defaults** (Arize, Apr 2026, earlier than this window). Pi, Claude Code, OpenClaw and Letta all cap file reads, cap tool results, keep tool call/result pairs together and summarise on a threshold.

**Verdict: unchanged, ADAPT (safety net only).** Gaffer's design of compact tool outputs (summaries plus file paths) is the "shrink, don't rewrite" pattern the new evidence favours. Gaffer declares a 1,000,000-token window, so Pi's threshold (window minus 16k) effectively never fires in a recommendation run; the $1.50 hard cap fires first. Keep `session_before_compact` as written. Don't adopt Anthropic server compaction. Log any compaction entry as an anomaly (02 §5).

## 2. Session portability

**What's new.**
- **Five tests for a portable session** (Earendil, "The Session You Cannot Take With You", 30 Jul 2026): inspection, export, replay, audit and deletion.
  - The post names what breaks portability: provider-sealed reasoning (`signature`, `encrypted_content`), server-held state (`previous_response_id`), hosted search, opaque compaction items and encrypted sub-agent messages.
  - Its proposed rules: the local event log is canonical, and every compaction returns a readable summary.
- **Sonnet 5.5 thinking blocks are account-bound** (release note 2026-09-28). A session resumed under a key from a different organisation silently loses its reasoning.
- **Pi 1.3.0 changed model switching.** It now drops another model's thinking blocks; 0.87.1 sent them to the new model as plain text (1.3.0 changelog, #10995).

**Verdict: unchanged, ADOPT (Pi JSONL).** Gaffer passes the inspection, export, replay and audit tests. Its JSONL is local and canonical. Anthropic's Messages API is stateless. Pi's compaction text is readable. Gaffer's `gaffer.recommendation` entries carry the decision record, so reasoning signatures are not needed for audit. **Deletion** is the gap: provider-side retention is outside Gaffer's control, so it belongs in the privacy notes, not the harness. One operational note: rotating the API key to another organisation drops prior reasoning in resumed sessions.

## 3. Prompt caching in agents

**What's new.**
- **Pi's view** (Earendil, "Prompt Caching In Agents", 22 Jul 2026).
  - Caching is an exact token-prefix match. Changing tools, the system prompt or old messages invalidates everything after the change.
  - The post warns that extensions which "inject timestamps" or rebuild the system prompt every turn defeat caching for the session. It lists dynamic system prompts among eight common causes of poor hit rates.
  - Pi favours append-only transcripts and treats compaction as a cache reset.
  - Observability: footer `R`/`W`/`CH`, `/session` and `showCacheMissNotices`.
- **Anthropic's API** (docs read 2026-10-17).
  - Prefix order is `tools` → `system` → `messages`. Volatile content must sit after the last breakpoint.
  - **Mid-conversation system messages** (`{"role": "system"}` inside `messages`) change instructions "without invalidating the cached prefix". They are supported on Sonnet 5.5 with no beta header, and are not available on Sonnet 5.
  - The page lists per-turn context such as a "freshness note" or "session deadline" among the intended uses. That is exactly what `fpl_context` is.
  - Sonnet 5.5 minimum cacheable prompt is 512 tokens. 5-minute writes cost 1.25× input, 1-hour writes 2×.
  - Pre-warming (`max_tokens: 0`) is documented.
  - Cache diagnostics, which report why a request missed, left beta on 2026-09-23.
- **Pi already has the machinery.** Since 0.86.0, a changed `before_agent_start` section is recorded as a transcript delta. Providers whose model has `supportsMidConvoSystemMessages` send it in place as a system message. Others collapse it into the leading system prompt (`ai/src/utils/transcript.ts:105-120 @v0.87.1`; flag default `false` at `ai/src/api/anthropic-messages.ts:217 @v0.87.1`).
  - Pi's built-in catalogue only learned about Sonnet 5.5 in **0.99.0**. That version sets `supportsMidConvoSystemMessages`, `supportsMidConvoToolChanges` and `supportsMidConvoEffort` for it (`ai/scripts/generate-models.ts:594-609 @v0.99.0`).
  - Gaffer's hand-written entry in `harness/models.json` sets none of these, so on 0.87.1 every new prompt rewrites the system prompt. Within a run nothing is lost; on follow-ups the history is re-written at 1.25×. S6 measured follow-ups 75% cheaper with the flag on.
- **Preserved thinking turns the cache problem into a correctness problem** (preserved-thinking docs).
  - On the 5.5 models a changed `system` or `tools` invalidates every earlier thinking block.
  - Accounts created on or after 2026-08-31 get a 400 by default. Older accounts get the block passed through and billed.
  - Pi 0.87.1 sends `block_binding: { prefix_mismatch_behavior: "drop_block" }` only for models with `supportsMidConvoEffort` (`ai/src/api/anthropic-messages.ts:1151-1158 @v0.87.1`). Its code comment gives the reason as avoiding "persistent 400 responses".
  - Measured on Gaffer's account (S6, `A-0.87.1-think`, $0.0432): a thinking block on prompt 1, then two follow-ups with the rebuilt system prompt, returned normally. The account predates enforcement.
- **Cache warming** (Pi 0.86.0, so already in Gaffer).
  - Default mode is `"streaming"`: it refreshes during long tool runs when Pi estimates at least $0.05 of avoided misses (`ca/src/core/cache-warmer.ts:20 @v0.87.1`). Mode `"idle"` also refreshes between runs.
  - Refreshes are logged as `usage` entries of kind `cache_warm` (`ca/docs/session-format.md:113 @v0.87.1`).
  - Gaffer's tool calls take seconds, so warming should rarely fire. But when it does, `gaffer-budget` doesn't count it (`packages/pi-gaffer/src/budget.ts:14`).
- **Price change.** Sonnet 5.5 cache reads were cut from $0.20 to **$0.10/MTok on 2026-10-07** (release notes; pricing page). Gaffer's `cacheRead: 0.2` was right when ADR 0008 was written and is stale now.

**Verdict: new, ADOPT (mid-conversation system messages, no code).** Why Gaffer can't do without it: follow-up questions are the normal TUI pattern. Without it each one re-bills the history (about $0.035 at a 16k prefix, per S6), and on a new account it may 400.
- **On 0.87.1:** add `supportsMidConvoSystemMessages: true` to the Sonnet 5.5 compat block and set `cacheRead` to 0.1. S6 tested this.
- Also consider `supportsMidConvoToolChanges` and `supportsMidConvoEffort`, which match the 0.99.0+ catalogue and bring `drop_block`. These two are **untested in Gaffer**.
- **On ≥ 0.99.0:** drop the override and use the catalogue entry.
- **Keep:** `before_agent_start` sections, the `now:` line and the countdown. With the flag, they arrive in exactly the form Anthropic recommends.
- **Fix:** count `usage` entries in `gaffer-budget`, `/usage` and admin. Turning `cacheWarming` off is the cheaper alternative, but don't do both.
- **Don't adopt:** pre-warming, 1-hour retention or cache diagnostics plumbing. Gaffer's runs are short and Pi already reports misses.

## 4. Deferred tool loading and tool search

**What's new.**
- **Anthropic's guidance** (24 Nov 2025, before 02 but not cited there). Tool search pays off above roughly 10 tools or 10k tokens of definitions. It is not worth using with fewer than 10 tools, or when every tool is used in every session.
- **Pi.**
  - Pi 0.99.0 ships `tool_search`, codemode and MCP as **built-in extensions**, with tool `exposure` modes (`direct`, `deferred`, `codemode`, `hidden`).
  - Pi 1.0 adds native deferred loading for supporting models. Since 1.0.1, Anthropic tools added mid-conversation are defined inline so the cache survives.
  - Earendil's "You Said No MCP!" (29 Sep 2026) explains the turn to MCP: "the world is not static", and dumping every tool into context doesn't scale.
- **Anthropic inline tools** (beta `inline-tools-2026-09-15`, release note 2026-09-22). Tools can be added mid-conversation by value without editing `tools`.

**Verdict: REJECT.** Gaffer has 7 tools, all compact and almost all used in every run, which is the case Anthropic says not to defer. `setActiveTools` runs once at `session_start`, so the tool list never changes mid-session. Keep `tool_search` inactive. On 0.99.0+, check that `--tools` and `--no-extensions` still keep the built-ins off (the MCP lockdown spike, S3).

## 5. Programmatic and code-mode tool calling

**What's new.**
- **Anthropic.**
  - Programmatic tool calling (24 Nov 2025): the model writes Python that calls your tools, and only the final output enters context. It cut tokens by 37% on complex research tasks, and is not for single simple calls.
  - Code execution with MCP (4 Nov 2025): cut tokens from 150k to 2k in one example, but needs a real sandbox.
- **Cloudflare Code Mode** (20 Feb 2026, search snippet only): two tools, `search()` and `execute()`, cover the whole Cloudflare API in about 1,000 tokens.
- **Pi codemode** (0.99.0, docs at pi.dev).
  - A `codemode` tool runs model-written JavaScript in a **QuickJS** sandbox **on the harness side**. Scripts call Pi's other tools as `tools.*` methods.
  - Limits: no Node APIs, filesystem, network or timers; 256 MB per script; at most two workers per process.
  - Tool calls are real and are not rolled back on failure.
  - The docs don't say whether nested calls pass through extension `tool_call` hooks. The S4 spike covers this.

**Verdict: REJECT for the harness; Gaffer already does this in Python.** Gaffer's sandbox is its code mode. The model writes Python against `gaffer_lib`, large tables stay in files, and only summaries come back (ARCHITECTURE §4). Pi codemode would add a second code-execution surface inside the harness container, next to the LLM key, to save one or two model calls in a 4–5-call run. Keep it disabled, and keep the `--tools` allowlist as the second line of defence.

## 6. Durable or resumable execution

**What's new.**
- **Pi Durable** (Earendil, 1 Oct 2026; experimental, "the API might still change"). A separate TypeScript framework, not a replacement for pi-coding-agent.
  - Every model call and tool run is a checkpointed task, so a restart resumes from the last checkpoint (`harness.resume()`).
  - Interrupted tools rerun only if declared `replay: "safe"`. A `requestId` makes submissions exactly-once.
  - Sub-agents are conversations owned by a tool call.
  - State lives in typed documents committed with the transcript, stored in memory, SQLite or JSONL. Several clients can attach and steer.
- **Pi Durable on Cloudflare** (16 Oct 2026). One SQLite-backed Durable Object per session, hibernatable WebSockets, alarms (handlers must be idempotent), and a durable inbox for concurrent messages. The demo has no authentication.
- **Others.**
  - Google Agent Executor (open source, 20 May 2026, news reports): event logs, snapshots, trajectory branching.
  - Cognition snapshots whole microVMs while agents wait (23 Apr 2026).
  - Temporal raised a Series E (14 Sep 2026) and Restate a Series A (30 Sep 2026), per news reports. These are market signals, not technical evidence.

**Verdict: unchanged, REJECT for the run.** A Gaffer run takes about 75 s and is safe to re-run. The deterministic pieces (`fpl_snapshot`, the validator) are idempotent, and the session JSONL already records everything. Pi Durable's multiplayer attach and steer model is worth a look for the phase-3 web UI. It is experimental and is a different harness, so it would break the "Pi core unchanged" theory. **Revisit only if** Gaffer gets server-side multi-client sessions.

## 7. Sandbox containment

**What's new.**
- **Anthropic, "How we contain Claude across products"** (25 May 2026, not cited in 02). Contain at the environment layer first, then steer the model. Lessons:
  - Keep credentials out of the sandbox, using scoped, revocable tokens.
  - An egress allowlist is "a capability grant", not just a destination filter.
  - Resolve symlinks before validating paths.
  - Treat project-open and config-load as untrusted input.
  - Inspect tool output live.
  - Be wary of custom components: a custom proxy was the part that failed in a serious incident.
  - Permission prompts were approved 93% of the time, so approvals are not a boundary.
- **Cognition** (23 Apr 2026). Each session runs in a microVM, because containers share a kernel.
- **Managed Agents release notes.** `allowed_hosts` and `web_fetch` restrictions (2026-08-19, 2026-10-07), and an `auto` permission policy (2026-09-10).

**Verdict: unchanged, ADOPT (as built).** Gaffer already does what the post recommends:
- The no-network sandbox holds no keys.
- `fpl_snapshot` and the odds fetch use path-level GET allowlists (`packages/pi-gaffer/src/guard.ts`), which is the capability view of egress.
- There is no user shell.

`sandboxd` does no path validation; it relies on the container boundary. So the symlink lesson applies only if path checks are ever added there. The "custom components fail" lesson argues for keeping `sandboxd.py` (282 lines) small and covered by tests. A microVM would add nothing while the sandbox holds no secrets and no network.

## 8. Harness-level evals

**What's new.**
- **Infrastructure is a variable** (Anthropic, "Quantifying infrastructure noise", 5 Feb 2026, not cited in 02). Sandbox resource limits moved Terminal-Bench scores by up to 6 points. The post recommends treating resource configuration as "a first-class experimental variable".
- **Harness changes need before/after comparisons.**
  - marmelab audited 246 repositories (24 Sep 2026). 60% of harnesses have neither tests nor evals. Only 1 of 26 with eval cases publishes a before/after comparison.
  - The same audit reports that executable guards beat prose rules, and that adding a reviewer agent cut success by 8% in one study.
  - The audit's advice is to give each control an expiry condition.
- **Harness-evolution papers** report token traffic and cost alongside score:
  - SoL-Pi (Sep 2026), above.
  - Ecdysis (arXiv 2609.11677, Sep 2026): change the harness only for failures that recur across tasks.
  - arXiv 2608.13608 (Aug 2026): a same-size LLM judge "yields no usable signal" for harness uplift.
- **Graders.** Anthropic Managed Agents "Outcomes" (May 2026, secondary sources) grades against a rubric with a separate grader in its own context. pass^k, from 02 §9b, remains the standard reliability metric.

**Verdict: unchanged, ADOPT, with three additions to §6.3 evals.**
1. Report **pass^k** (k = 3) for validity on a fixed slice, not just pass@1.
2. Record the harness configuration in each eval result: Pi version, model and compat flags, thinking level, sandbox limits and timeouts.
3. Add three harness-level metrics:
   - **runs that end without a successful `submit_recommendation`** (Sonnet 5.5 at `medium` is documented to stop and check in more often);
   - cache-read share of input;
   - cost per task.

Any harness component added later needs an ablated before/after run. Keep LLM-judge rubrics secondary to code graders.

## 9. Agent UIs (brief; R11 covers this in depth)

**What's new.**
- **Sonnet 5.5 and Opus 5.5 send progress notes as `thinking` blocks.** Between tool calls they write short notes for the user, and these come back as `thinking` blocks, not `text`.
  - The API default display is `"omitted"`, which returns them empty. `display: "updates"` (beta, release note 2026-09-01) returns just these notes.
  - **Pi always requests `"summarized"`** and supports only `"summarized" | "omitted"` (`ai/src/api/anthropic-messages.ts:192,1287,1294 @v1.3.0`). So in Gaffer the notes arrive as thinking text, indistinguishable from reasoning summaries.
  - A UI that renders only `text` will look silent during long turns.
- **Codex as a platform** (OpenAI developer blog, undated). An app-server with threads, turns, events and approval requests that applications embed in their own surfaces.
- **Pi Durable** lets any number of clients attach to a conversation and steer it.
- **AG-UI** gained AWS Bedrock AgentCore support (13 Mar 2026). No primary changelog was read.
- **Observability.** Anthropic OpenTelemetry export for Messages API requests is in beta (release note 2026-10-14).

**Verdict: no new harness feature; two UI requirements.**
1. Any Gaffer UI must render `thinking` blocks, or at least their first line, as progress. Pi's TUI already does unless `hideThinkingBlock` is set.
2. Don't build a "message the user" tool. Gaffer's turns are short, and `submit_recommendation`'s renderer is the hand-off.

## 10. What the Claude 5.5 prompting guides say (progress, system messages, pasted text)

Read 2026-10-17: [Prompting Claude Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5) and, because Gaffer runs Sonnet, [Prompting Claude Sonnet 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5).

**Progress updates and thinking display.**
- The model writes notes on "what it just found and what it's doing next". They arrive as progress-update `thinking` blocks.
- Four levers:
  1. Set `display: "updates"`.
  2. Give the model a "send the user a message" tool for verbatim content, declared from the first request.
  3. Ask in the system prompt for a one-line intent and a closing recap.
  4. After about five silent tool steps, append a turn-scoped system message (`clear_at: "next_user_message"`) asking for a brief update, and stop after two or three. Anthropic says this roughly halved long silent stretches on Opus 5.5 at no measurable cost.
- **Unattended runs:** treat a text-only end of turn as a report, not as done. Keep a checklist, and send at most two or three automatic continuations.
- **For Gaffer:** levers 1 and 4 aren't reachable through Pi without core or request-hook changes, and Gaffer's turns are short. Lever 3 is a cheap prompt line if UI testing shows silent stretches. The unattended-run advice applies to headless evals: track "ended without submission" (§8) before adding any `agent_before_settle` continuation.

**Mid-conversation system messages.**
- Freeze `system` at session start. Append `role: "system"` messages for later changes, and leave them in place. Changing the top-level `system` mid-way invalidates earlier thinking blocks.
- State facts rather than override commands. Keep tool output and retrieved documents in `tool_result`, not system messages.
- **Sonnet 5.5 caveat:**
  - It resists injection through tool results, so it may ignore a system message placed right after a tool result.
  - It can also misread frequent harness text after tool results, such as token or budget countdowns, as injection.
  - Deliver mid-turn user input as a text block after the last `tool_result`, and keep harness notices in a separate system message.
- **For Gaffer:**
  - `fpl_context` updates come at prompt start, after a user message, which is the safe placement.
  - The `gaffer-budget` soft-cap steer is sent as a user-role custom message after tool results (`extensions/gaffer-budget/index.ts:67`; custom → user at `ca/src/core/messages.ts:162-169 @v0.87.1`), phrased as a command ("Wrap up now").
  - It fires at most once per session, so the misread risk is low. If evals ever show the model ignoring it, rephrase it as a fact: "Harness notice: session cost $X is past the soft cap; the run stops at $Y."
  - Don't add a per-step countdown.

**Pasted content.**
- Opus 5.5 resists instructions inside text the user pasted, but only if the harness marks it. Wrap each paste in `<pasted_content id="…">` tags with a random ID on both tags, and add a system-prompt note telling the model to follow instructions inside them only when the user's own message asks.
- The Sonnet 5.5 guide does not include this section, so the effect on Sonnet is untested.
- **For Gaffer:**
  - Pi's TUI collapses large pastes into `[paste #N …]` markers and expands them inline on submit with no tags (`packages/tui/src/components/editor.ts:1090-1097 @v1.3.0`). Tagging in the TUI would need a core change.
  - A custom web composer (R11) could tag pastes itself.
  - Users pasting FPL news or tweets is plausible, and Gaffer's untrusted-data rule (ARCHITECTURE §1.3) already covers tool data. Treat tagging as optional UI hardening, not a harness feature.

**Other points that touch ADR 0008.**
- Sonnet 5.5's API default effort is `high`. For "agentic coding and multistep tool use", the guide says to start at `medium` for well-specified tasks, which matches Gaffer.
- At `low`/`medium` the model is likelier to stop early on long tasks.
- Changing the top-level effort invalidates the cache, but per-message effort (`supportsMidConvoEffort`) doesn't.
- Forced `tool_choice` returns 400 on Sonnet 5.5 and Opus 5.5. Gaffer doesn't use it.
- Accept tool names that differ only in letter case (tolerant tool-call handling).

## 11. Sub-agents and the critic (ADR 0007)

**What's new.**
- **Cognition "Fusion"** (11 Sep 2026; 13 Jul 2026 for the cost study). A frontier "lead" plus a cheaper persistent "sidekick", exchanging briefs rather than transcripts.
  - 23–46% cheaper on long coding benchmarks, with small score losses on some.
  - Cognition's own caveat: "short tasks and serial root-cause debugging offered little to delegate".
  - This is a softening of its 2025 "Don't Build Multi-Agents".
- **LangChain** (8 Sep 2026). Fork the context for workers that need gathered evidence; isolate verifiers so the supervisor's diagnosis doesn't anchor them. No eval data.
- **Anthropic.** The Opus 5.5 guide adds "time signals" for multi-agent harnesses. Managed Agents added dynamic multi-agent workflows (release note 2026-10-09).
- **marmelab.** A reviewer agent cut success by 8% in one study, and Microsoft reports that chains of more than four hand-offs "almost always failed".

**Verdict: unchanged, REJECT.** Gaffer's runs are the short, coupled tasks that Cognition says gain little. A run costs $0.06, so there is nothing to save by delegating. **Refinement for the deferred critic (option 2):** if evals ever justify one, run it in an **isolated** context over the structured recommendation, not a forked one, so it isn't anchored by the agent's reasoning.

## 12. Model and budget (ADR 0008)

New facts, from the pricing page and release notes as of 2026-10-17:

| Model | Input | Output | Cache read | Note |
|---|---|---|---|---|
| `claude-sonnet-5-5` | $2 | $10 | **$0.10** (was $0.20 until 2026-10-07) | No long-context premium up to 1M |
| `claude-opus-5-5` | $4 | $20 | $0.20 | |
| `claude-haiku-5-5` (prompts ≤ 100k) | **$0.10** | **$0.50** | $0.01 | Launched 2026-10-07; higher tier above 100k; in Pi's catalogue from 1.1.0 |

- **Correct `cacheRead`** in `harness/models.json` and the ADR 0008 table. S6 measured that the stale price makes Gaffer's cost figures about 7% too high.
- **Haiku 5.5 is a candidate, not a decision.** Gaffer prompts stay well under 100k, so a run would cost a small fraction of today's. The eval suite decides; nothing here says its FPL reasoning is good enough. On 0.87.1 it needs a `models.json` entry with the prompt-length tier.
- **Count Pi's `usage` entries in budgets** (§3).
- Managed Agents added hard session budgets (release note 2026-08-07). That confirms Gaffer's extension-enforced caps are the mainstream pattern.

---

## Verdict table

| Pattern | Phase 0 verdict (02) | New evidence (Aug–Oct 2026) | Phase 1.1 verdict | Why (Gaffer-specific) |
|---|---|---|---|---|
| Compaction / tool-result clearing | ADAPT (safety net; prevent with compact outputs) | Pi explainer (cache reset); Anthropic on-demand compaction beta; full history beat summarising on recall and cost (Bouchard); SoL-Pi | **ADAPT, unchanged** | 1M window and short runs: compaction never fires; stable-size tool outputs is what the evidence favours |
| Append-only log / session portability | ADOPT (Pi JSONL) | Earendil's five tests; Sonnet 5.5 thinking is account-bound; Pi 1.3.0 drops foreign-model thinking | **ADOPT, unchanged** | JSONL is local and canonical; recommendation entries carry the audit record; key rotation across organisations drops reasoning |
| Prompt caching of per-prompt context | Not designed (assumed "heavy caching" in ADR 0008) | Volatile system prompts defeat caching (Earendil); mid-conversation system messages documented for "freshness note" and "session deadline"; prefix check returns 400 on newer accounts | **ADOPT mid-conversation system messages (config only)** | Follow-ups are normal; without the flag each re-bills the history (S6: follow-ups 75% cheaper with it) and may 400 |
| Cache warming / pre-warm / 1-hour TTL | — | Pi default `streaming` warming (0.86.0); Anthropic `max_tokens: 0` pre-warm | **Keep Pi default; count its spend; don't add pre-warm or 1h** | Runs are short; warming rarely fires, but its `usage` entries must reach the budget |
| Deferred tool loading / tool search | (9d) few consolidated tools, ADOPT | Pi built-in `tool_search` (0.99.0); deferred loading (1.0); Anthropic inline tools beta | **REJECT** | 7 compact tools, all used; below Anthropic's 10-tool threshold |
| Programmatic / code-mode tool calling | (implicit) Python in the sandbox | Pi codemode (QuickJS, harness-side); Anthropic PTC; Cloudflare Code Mode | **REJECT in harness; keep Python sandbox** | Gaffer's sandbox already is code mode; codemode adds an execution surface next to the key for 1–2 saved calls |
| Durable / resumable execution | ADAPT (skip wake/resume) | Pi Durable (experimental) and its Cloudflare port; Google Agent Executor; Restate/Temporal funding | **REJECT for runs; look again for phase-3 multi-client UI** | 75 s re-runnable runs; Pi Durable is a different, unstable harness |
| Sandbox containment, creds out | ADAPT (creds-out mandatory) | Anthropic containment post: environment first, allowlist = capability, custom proxies fail | **ADOPT as built** | No-network keyless sandbox plus GET-path allowlists already match; keep `sandboxd` small and tested |
| Orchestrator / worker sub-agents | REJECT | Cognition Fusion lead + sidekick; LangChain fork vs isolate | **REJECT, unchanged** | $0.06, 4–5-call coupled runs; "short tasks offered little to delegate" |
| Separate critic pass | ADAPT (later) | Verifiers should be isolated (LangChain); reviewer agent −8% (marmelab); Outcomes grader in own context | **Deferred; if built, isolated context** | Avoid anchoring on the agent's reasoning; only if evals show validator-missed errors |
| Evals in the loop / harness evals | ADOPT | Infra noise (±6 pts); pass^k; before/after ablations rare; harness-evolution papers report tokens and cost | **ADOPT, plus pass^k, config capture, "no submission" and cache-share metrics** | The harness itself is under test (the project's theory) |
| Progress updates / thinking display | — | 5.5 models send progress as thinking blocks; `display: "updates"`; turn-scoped nudges | **No harness change; UIs must render thinking** | Pi requests `summarized`; turns are short |
| Pasted-content tagging | — | Opus 5.5 guide: `<pasted_content id>` tags | **Optional, web UI only** | Needs a TUI core change; untested on Sonnet 5.5 |
| Budget caps | ADOPT (ADR 0008) | Managed Agents session budgets; Pi `usage` entries outside messages | **ADOPT; fix accounting** | Caps must include warming and summarisation spend |

---

## Pointer paragraph for note 02

> **Update, 2026-10-17:** [Research 12](12-harness-patterns-update.md) reviews what was published from mid-August to mid-October 2026 and keeps every verdict here, with three additions. (1) Prompt caching is now a design concern. Gaffer's per-prompt `fpl_context` must reach Sonnet 5.5 as a mid-conversation system message, not a rewritten system prompt: the rewrite re-bills each follow-up and, on newer Anthropic accounts, can fail with a 400. (2) Budgets must count Pi's `usage` entries (cache warming, summaries). (3) If the critic in §9e is ever built, it runs in an isolated context. ADR 0007 and the compaction posture in §5 are reaffirmed.

---

## Sources

Earendil / Pi
- https://earendil.com/posts/prompt-caching/ (22 Jul 2026)
- https://earendil.com/posts/session-portability/ (30 Jul 2026)
- https://earendil.com/posts/compaction-in-pi/ (13 Aug 2026)
- https://earendil.com/posts/what-is-a-harness/ (20 Aug 2026). Definitional only; no harness-design claims used.
- https://earendil.com/posts/you-said-no-mcp/ (29 Sep 2026)
- https://earendil.com/posts/pi-1-0/ (1 Oct 2026)
- https://earendil.com/posts/pi-durable/ (1 Oct 2026)
- https://earendil.com/posts/pi-durable-on-cloudflare/ (16 Oct 2026)
- https://pi.dev/docs/latest/codemode (undated; matches v1.3.0 docs)
- Pi source: `github.com/earendil-works/pi` at v0.87.1 (`f07218c4`), v0.99.0 and v1.3.0 (`71023aec`, 2026-10-15). Files cited inline; `packages/coding-agent/CHANGELOG.md` and `packages/ai/CHANGELOG.md` at v1.3.0.

Anthropic
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5 (undated; read 2026-10-17)
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5 (undated; read 2026-10-17)
- https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages (undated; read 2026-10-17)
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching (undated; read 2026-10-17)
- https://platform.claude.com/docs/en/build-with-claude/preserved-thinking (undated; read 2026-10-17)
- https://platform.claude.com/docs/en/build-with-claude/thinking (undated; read 2026-10-17)
- https://platform.claude.com/docs/en/build-with-claude/compaction (undated; read 2026-10-17)
- https://platform.claude.com/docs/en/about-claude/pricing (read 2026-10-17)
- https://platform.claude.com/docs/en/release-notes/overview (entries 2026-08-01 to 2026-10-15; read 2026-10-17)
- https://www.anthropic.com/engineering/how-we-contain-claude (25 May 2026)
- https://www.anthropic.com/engineering/infrastructure-noise (5 Feb 2026)
- https://www.anthropic.com/engineering/advanced-tool-use (24 Nov 2025)
- https://www.anthropic.com/engineering/code-execution-with-mcp (4 Nov 2025)
- https://www.anthropic.com/engineering (index; latest dated post 25 May 2026, read 2026-10-17)

Others
- https://www.louisbouchard.ai/context-engineering-2026/ (18 Aug 2026)
- https://www.langchain.com/blog/organizing-context-in-a-multi-agent-harness (8 Sep 2026)
- https://cognition.com/blog/local-fusion (11 Sep 2026)
- https://cognition.com/blog/making-fable-cheaper-than-opus (13 Jul 2026)
- https://cognition.com/blog/what-we-learned-building-cloud-agents (23 Apr 2026)
- https://marmelab.com/blog/2026/09/24/the-state-of-ai-harness-engineering-2026.html (24 Sep 2026)
- https://developers.openai.com/blog/codex-as-a-platform (undated; listed as Sep 2026 by an awesome list)
- https://www.infoq.com/news/2026/02/openai-harness-engineering-codex (21 Feb 2026), summarising https://openai.com/index/harness-engineering/ (11 Feb 2026)
- https://arize.com/blog/context-management-in-agent-harnesses/ (Apr 2026)
- https://arxiv.org/abs/2609.20519 SoL-Pi (17 Sep 2026)
- https://arxiv.org/abs/2609.11677 Ecdysis (10 Sep 2026, v2 20 Sep)
- https://arxiv.org/abs/2608.13608 (11 Aug 2026)
- Search results only: Cloudflare Code Mode MCP (20 Feb 2026); AWS AgentCore AG-UI (13 Mar 2026); Google Agent Executor (20 May 2026); Temporal Series E (14 Sep 2026) and Restate Series A (30 Sep 2026) news; Managed Agents "Outcomes" (May 2026, secondary write-ups).
- Discovery only, not cited as evidence: https://github.com/ai-boost/awesome-harness-engineering , https://github.com/Picrew/awesome-agent-harness
- Gaffer: `harness/models.json`, `packages/pi-gaffer/src/{prompt,budget,guard}.ts`, `packages/pi-gaffer/extensions/gaffer-budget/index.ts`, `sandbox/sandboxd.py`, `spikes/s6-prompt-cache/README.md` (2026-10-17)

## Unconfirmed

- **The 400 on follow-ups.** It is derived from the preserved-thinking docs plus Pi source, not observed. It depends on the API account's creation date, which I don't know. S6's real calls produced no thinking blocks, so they couldn't trigger it. The live stack's sessions (not touched) would show it as model errors on second prompts.
- **`supportsMidConvoToolChanges` and `supportsMidConvoEffort` on 0.87.1** with Gaffer's custom entry are untested. Only `supportsMidConvoSystemMessages` was spiked (S6). The 0.99.0+ catalogue sets all three for Sonnet 5.5.
- **OpenAI.** `openai.com/index/harness-engineering/` and the GPT-5.6 efficiency page returned 403, so OpenAI's harness-engineering claims come from InfoQ's summary. "Codex as a platform" shows no date.
- **Pasted-content tagging on Sonnet 5.5.** The section is in the Opus 5.5 guide only; its effect on Sonnet 5.5 is not documented.
- **Pi 1.0 post vs changelog.** The post lists mid-conversation system messages and cache warming as 1.0 features. The changelog dates both to 0.86.0, and I trusted the changelog.
- **Pi compaction thresholds** come from `ca/docs/settings.md @v0.87.1`; the Earendil post gives none. Arize's figures for Pi agree.
- **Papers.** SoL-Pi, Ecdysis and 2608.13608 were read as abstracts only. SoL-Pi's mechanisms are not described in the abstract.
- **marmelab figures** (Vercel's 80% tool removal, the −8% reviewer result, Microsoft's hand-off limit) are second-hand within that post.
- **Funding, AG-UI, Agent Executor and Managed Agents "Outcomes"** come from news or secondary write-ups, not primary pages.
- **Codemode and `tool_call` hooks.** Whether nested codemode calls pass through extension hooks is not in the docs (left to spike S4).
- **Haiku 5.5 for FPL.** No quality evidence for Gaffer's task; price only.
- **S6's README dates the stale price "since 2026-09-28".** The release notes date the price cut to 2026-10-07, so Gaffer's $0.20 was correct at Sonnet 5.5's launch and is stale only since 7 October.
- **Not read** (titles not harness-relevant): Earendil "Measuring the Sloppiness of Code" (10 Sep) and "There are many themes…" (9 Oct). Also unread: the tail of the release-notes page beyond 100k characters (entries before August).
- **Prompt injection.** No fetched page addressed instructions to me. The Opus/Sonnet guides contain sample system-prompt text, which I treated as documentation.
