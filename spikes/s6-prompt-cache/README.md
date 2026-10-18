# Spike S6 — Does rewriting `fpl_context` on every prompt defeat prompt caching?

**Date:** 2026-10-17 · **Pi:** 0.87.1 and 1.3.0 · **Model:** `anthropic/claude-sonnet-5-5`, thinking medium (real API) · **Spend:** $0.1967 over 6 runs · **Result: yes for follow-up prompts, and a one-line model-config change fixes it on both versions.**

## Question
`gaffer-core` rebuilds two system-prompt sections in `before_agent_start` on every prompt. `fpl_context` always changes, because it carries `now: <ISO time>` and a countdown to the deadline (`packages/pi-gaffer/src/prompt.ts:59-95`). Does that defeat Anthropic prompt caching? Would mid-conversation system messages (in Pi since 0.86.0, not 1.0 as the brief assumed) carry the deadline-aware context more cheaply?

## How Pi sends a changed section (source, v1.3.0)
- `before_agent_start` sections become `SystemMessage.sections`. When they change, Pi appends a **section patch** to the transcript (`packages/coding-agent/src/core/system-prompt.ts:212-226`, `diffSystemPromptSections`; type `packages/ai/src/types.ts:546-562`).
- The provider decides what to do with it. The Anthropic adapter calls `resolveTranscript(context, compat.supportsMidConvoSystemMessages)` (`packages/ai/src/api/anthropic-messages.ts:581`). If the flag is **true**, the patch is sent in place as a `role: "system"` message ("Updated system prompt section …"). If it is **false or absent** (the default, `anthropic-messages.ts:230`), `collapseSystemMessages` rebuilds the leading system prompt from the replayed state (`packages/ai/src/utils/transcript.ts:105-119`). The prompt cache is a prefix match in the order tools → system → messages, so a rebuilt system prompt invalidates the cached history behind it.
- Breakpoints: the last tool, the system block, and the last user or system message (`anthropic-messages.ts:1229-1250, 1529-1551, 1659`). Retention is "short" (5 min) unless `PI_CACHE_RETENTION=long` and the model has `supportsLongCacheRetention` (`anthropic-messages.ts:69-92`).
- **Gaffer's `harness/models.json` entry for `claude-sonnet-5-5` has no `supportsMidConvoSystemMessages`.** On 0.87.1 the catalogue has no Sonnet 5.5, so that entry is the whole model. On 1.3.0 the catalogue has one with `supportsMidConvoSystemMessages: true`, `supportsMidConvoToolChanges: true` and `supportsMidConvoEffort: true`, but **a `models.json` entry with the same id replaces it; it does not merge** (variant A below runs on 1.3.0 with only the two flags from `models.json`).

## Method
`s6.ts` builds a Gaffer-shaped session through the SDK:
- Gaffer's real preamble and `fplContextSection` (imported read-only from `packages/pi-gaffer/src/prompt.ts`), a `user_preferences` section and Gaffer's six skills
- a stub `fpl_snapshot` that returns a fixed summary of about 1.4k tokens; tools `read` and `fpl_snapshot`
- three prompts in one session: a snapshot plus squad table (2 model calls), then two one-line follow-ups with no tools
- `cacheWarming: "off"` so no extra requests are made
- a random synthetic team id per run, so runs don't share a system-prompt cache (they do share the tool block, 665 tokens)
- a `before_provider_request` hook that records where `fpl_context` went

Variants:
- **A:** the `models.json` entry exactly as Gaffer ships it
- **B:** the same entry plus `compat.supportsMidConvoSystemMessages: true`

Both use the live cache-read price, $0.10/MTok (see "Price" below).

```
cd spikes/s6-prompt-cache/v1.3.0 && npm ci && cp ../s6.ts . && ANTHROPIC_API_KEY=… node s6.ts --variant A --label A-1.3.0-r1
# likewise --variant B, and in v0.87.1/
```

## Result
| Run | Pi | Call 3 (follow-up 1): cache read / write | Call 4 (follow-up 2): cache read / write | Both follow-ups | Session |
|---|---|---|---|---|---|
| A-1.3.0-r1 | 1.3.0 | 665 / 4,085 | 665 / 4,196 | $0.0225 | $0.0397 |
| B-1.3.0-r1 | 1.3.0 | 4,130 / 816 | 4,782 / 437 | $0.0057 | $0.0216 |
| A-0.87.1-r1 | 0.87.1 | 665 / 4,056 | 665 / 4,165 | $0.0223 | $0.0375 |
| B-0.87.1-r1 | 0.87.1 | 4,132 / 820 | 4,788 / 444 | $0.0057 | $0.0217 |

- **Within one run, nothing is lost.** The system prompt is built once per prompt, so the 2–5 calls of a recommendation run all read the cache (call 2: 3,054 read in every variant). The eval suite's one-prompt cases, and so NFR-COST-01, are unaffected.
- **Across prompts, A re-writes everything.** On every follow-up, A reads only the tool block from cache and writes the whole system prompt plus history again at 1.25× input price. The request log shows the leading system prompt's `now:` changing on every prompt in A, and staying at the first prompt's value in B, with one `role: "system"` message per later prompt holding the updated `fpl_context`.
- **B cuts follow-up cost by 75%** at this history size (about 4k tokens) and the gap grows with history. A real recommendation run ends with a prefix of about 12–16k tokens (BUILD.md M4: 9–13k cache-write, 29–53k cache-read over 4–5 calls). By arithmetic, a follow-up then costs about $0.035 in A (16k × $2.50/MTok re-written) against about $0.003 in B (16k × $0.10/MTok read plus a few hundred tokens written). In the TUI, follow-up questions after a recommendation are the normal case ("why not Saka?", "what if I keep Palmer?"), so A roughly doubles the cost of a typical session.
- **0.87.1 and 1.3.0 behave identically.** The fix doesn't need the upgrade.
- **Behaviour:** in B every answer used the current context. The model sees the original section in the leading prompt and the update after it. Each later prompt adds about 250 tokens (one more copy of `fpl_context`), which is negligible at Gaffer's session lengths.
- **Thinking:** no thinking blocks in any S6 call (short prompts; adaptive thinking chose not to think). Pi requests `display: "summarized"` by default and supports only `"summarized" | "omitted"` (`anthropic-messages.ts:192, 1287, 1294`): it never asks for Sonnet 5.5's `display: "updates"` progress notes. In the live stack's sessions (read-only count, 2026-10-17), 69 of 201 Sonnet 5.5 calls carry a thinking block, all non-empty, about 200 characters each.

## Variant C: Pi 1.3.0's own catalogue entry (the M1.1-1 configuration)
On 1.3.0, with no `models.json` entry at all, Sonnet 5.5 resolves from Pi's catalogue, which sets `supportsMidConvoSystemMessages`, `supportsMidConvoToolChanges` and `supportsMidConvoEffort`. That changes the request shape in three ways S6's variant B didn't test (research 07): `thinking: {type: "adaptive", display: "summarized", block_binding: {prefix_mismatch_behavior: "drop_block"}}`, `output_config.effort` plus a per-request effort marker sent as a `role: "system"` message, and the inline-tools beta. Run `C-1.3.0-think` ($0.0330, thinking `high`, a reasoning first prompt and two follow-ups):

| Call | Cache read / write | Thinking | Result |
|---|---|---|---|
| 1 (snapshot) | 0 / 3,187 | 165 chars | tool call |
| 2 (answer) | 3,187 / 1,207 | 590 chars | stop |
| 3 (follow-up 1) | 4,394 / 1,357 | — | stop |
| 4 (follow-up 2) | 5,751 / 289 | 229 chars | stop |

The API accepted every request; follow-ups read the cache as in variant B; summarized thinking arrived. The request log shows the effort markers and the `fpl_context` updates as mid-conversation system messages (`usausaussauss` by the fourth request). This pre-checks MIGRATION-PI-1X step 4; spike S10 runs the eval cases on the same configuration.

## Price (found on the way)
Anthropic lowered Sonnet 5.5 cache reads from $0.20 to **$0.10/MTok** on **2026-10-07** (release notes: "0.05x the base input price instead of 0.1x"; the pricing page fetched 2026-10-17 agrees, and so does Pi 1.3.0's catalogue). Gaffer's `harness/models.json` still says $0.20, which was right when it was written (2026-09-28) and has been stale since 2026-10-07. So Gaffer's figures for M4 (2026-10-11), M5 and the eval summaries (2026-10-16) overstate cache-read cost by 2×. A typical recommendation (BUILD.md M4: about 40k cache-read, 11k cache-write and 2k output tokens, about $0.055) carries $0.008 of cache reads at $0.20 but $0.004 at the true price, so Gaffer's figure is about 7% too high. That alone would fail NFR-COST-03's 2% check against the Console for any window after 2026-10-07. (The bundled API reference in this session still says $0.20; the release notes and the live price list win because they are primary and dated.)

## Follow-ups after thinking (preserved thinking)
Anthropic's API binds each Sonnet 5.5 thinking block to the conversation prefix that produced it, including the top-level `system` prompt. Rebuilding `system` between requests invalidates every earlier thinking block, and for accounts created on or after 2026-08-31 the API rejects such a request with a 400 unless it opts into `drop_block` (Claude API docs, "preserved thinking"). Pi 0.87.1 only sends `drop_block` for models with `supportsMidConvoEffort` (`packages/ai/src/api/anthropic-messages.ts:1151-1158 @v0.87.1`); Gaffer's entry doesn't set it.

One more run tested this on Gaffer's own account: variant A on 0.87.1, thinking `high`, a first prompt that makes the model reason (one thinking block, 761 characters), then two follow-ups with the rebuilt system prompt (`A-0.87.1-think`, $0.0432). **No error:** both follow-ups returned normally. This account predates the enforcement, so the invalidated blocks are passed through and billed. The live stack has had no session with a follow-up after a thinking block (read-only count over 75 sessions), so nothing has failed yet. **Any account created after 2026-08-31** (a new deployment, a second user's key in Phase 3) would get a 400 on such a follow-up with today's config. Variant B removes the cause, because the leading system prompt never changes.

## Impact on the design
1. **Adopt mid-conversation system messages for `fpl_context` now (ADR 0010, roadmap M1.1-0):** on 0.87.1, add `"supportsMidConvoSystemMessages": true` to the Sonnet 5.5 compat block in `harness/models.json` and correct `cacheRead` to 0.1. On 1.3.0, drop the override and use the catalogue entry, which has both. No extension code changes, and `before_agent_start` stays the mechanism.
2. **Keep the volatile lines inside `fpl_context`** (`now:`, the countdown). With the patch mechanism they cost about 250 tokens per prompt. Moving them out would only matter for a provider without mid-conversation system support, where a model-swap eval (NFR-PORT-01) should check cost per session.
3. **Add a cost-per-session eval case with a follow-up prompt**, because the one-prompt suite can't see this class of regression (REQUIREMENTS NFR-COST-04).
4. **The UIs render summarized thinking only.** Pi can't request `display: "updates"`; a custom request hook could, but it isn't worth owning (research 07).
