# ADR 0010 — Per-prompt FPL context as mid-conversation system messages; prices from the live price list

**Status:** Accepted · **Date:** 2026-10-17 · **Amends:** [ADR 0008](0008-model-and-budget.md) (prices, `models.json`) · **Evidence:** [spike S6](../../spikes/s6-prompt-cache/README.md), [research 07](../research/07-pi-1x-migration.md)

## Context
`gaffer-core` sets two system-prompt sections in `before_agent_start` on every prompt: `fpl_context` (team, GW, deadline, a countdown and `now:`) and `user_preferences` (ARCHITECTURE §1.3). `fpl_context` changes on every prompt by design, because the model must know how close the deadline is.

Since 0.86.0, Pi records changed sections as patches in the transcript. Each provider then either sends a patch in place as a mid-conversation `role: "system"` message, or rebuilds the leading system prompt from all the patches. The Anthropic adapter does the first only when the model's `compat.supportsMidConvoSystemMessages` is true (`packages/ai/src/api/anthropic-messages.ts:230, 581 @v1.3.0`). Anthropic's cache is a prefix match in the order tools → system → messages, so a rebuilt system prompt invalidates the cached history behind it.

Gaffer declares Sonnet 5.5 itself in `harness/models.json` (0.87.1's catalogue predates the model), and that entry has no such flag. Spike S6 measured the effect with a real model on 0.87.1 and 1.3.0:
- Within one run nothing is lost: the system prompt is built once per prompt, and the 4–5 calls of a recommendation all read the cache.
- **On every later prompt in the same session, the whole system prompt and history are re-written to the cache** at 1.25× input price. With the flag set, the same follow-ups read the cache and write only the new part: −75% at a 4k-token history, and about $0.035 → $0.003 per follow-up after a real recommendation (about 16k tokens of prefix).
- On 1.3.0 a `models.json` entry with the same id **replaces** the catalogue entry; it doesn't merge. The 1.3.0 catalogue entry has the flag, so keeping Gaffer's override keeps the problem.

Two more findings bear on the same config:
- **A follow-up after thinking can fail outright on newer accounts.** Anthropic binds each Sonnet 5.5 thinking block to the prefix that produced it, including `system`. A rebuilt `system` invalidates earlier blocks, and accounts created on or after 2026-08-31 get a 400 unless the request opts into `drop_block`, which Pi 0.87.1 only does for models with `supportsMidConvoEffort`. Gaffer's own account predates the enforcement: S6's thinking run followed up without error. A new deployment's key would not.
- **Gaffer's Sonnet 5.5 cache-read price is stale.** Anthropic cut it from $0.20 to $0.10/MTok on 2026-10-07 (release notes; 0.05× input). `harness/models.json` and ADR 0008 still say $0.20, so Gaffer's cost figures since 2026-10-07 overstate cache reads 2×, about 7% of a typical recommendation. That alone would fail NFR-COST-03's 2% check.
- Research 12 found one more gap in "one source for spend": Pi logs cache-warming refreshes and summarisation as `usage` entries, which `src/budget.ts` and `src/usage.ts` don't count. None exist in the live sessions yet (warming only fires when Pi estimates ≥ $0.05 of avoided cost), but the caps should not depend on that.

## Options considered
1. **Keep rebuilding the system prompt.** It costs nothing for one-prompt sessions (the eval suite, NFR-COST-01) but roughly doubles the cost of the normal TUI pattern of a recommendation plus follow-up questions. Rejected.
2. **Move the volatile lines out of the system prompt** into a hidden custom message per prompt (`before_agent_start` returning `message`). It works on any provider, but it's an extension change, it puts operator context in the user's turn where it carries less authority, and it duplicates what Pi already does natively. Rejected while the provider supports option 3.
3. **Turn on mid-conversation system messages for the model** and leave the extension as it is. **Chosen.**

## Decision
- **Now, on Pi 0.87.1 (milestone M1.1-0):** in `harness/models.json`, add `"supportsMidConvoSystemMessages": true` to the Sonnet 5.5 `compat` block and set `cost.cacheRead` to `0.1`. No extension code changes.
- **On Pi 1.3.0 and later:** delete the `anthropic` provider override from `harness/models.json`, so the catalogue entry is used: it has the flag (plus `supportsMidConvoToolChanges` and `supportsMidConvoEffort`) and the right price. `models.json` keeps only models the catalogue lacks. Each Pi upgrade checks the catalogue entry of the default model against the live price list (a test in the upgrade gate, ADR 0009).
- **Prices come from the provider's live price list and release notes, checked at each Pi upgrade and when a new default model is chosen.** ADR 0008's price table is corrected: Sonnet 5.5 cache read $0.10/MTok from 2026-10-07.
- **Spend includes Pi's `usage` entries.** `gaffer-budget`, `/usage` and `gaffer admin` add `type: "usage"` entries (cache warming, summaries) to assistant-message usage, so the caps hold whatever Pi spends on Gaffer's behalf (NFR-COST-05).
- **The `fpl_context` section keeps its volatile lines** (`now:`, the countdown). With patches each later prompt costs about 250 tokens for its copy of the section.
- **Regression guard:** a new eval case with a follow-up prompt measures cost per session, not just per recommendation (NFR-COST-04), because the one-prompt suite can't see this class of regression.
- **Model swaps:** a model without mid-conversation system messages falls back to rebuilding the system prompt. The model-swap qualification (NFR-PORT-01) reports cost per session, so the effect is visible before a swap.

## Consequences
- Follow-up prompts in the TUI and the Gaffer App cost about a tenth of what they do today, and can't hit the preserved-thinking 400 on newer accounts. A one-prompt recommendation costs the same.
- The leading system prompt keeps the first prompt's `fpl_context`. Later prompts see "Updated system prompt section…" messages after it. In S6 the model always used the latest values; the eval case above keeps checking it.
- Cost figures recorded after 2026-10-07 (BUILD.md M4 and M5, the eval summaries, the admin report) overstate cache reads. They are not rewritten: the session files hold token counts, so `gaffer admin` can recompute them with corrected prices if wanted. NFR-COST-03's Console comparison should use the corrected price.
- Pi's Anthropic adapter only asks for `thinking.display` `"summarized"` or `"omitted"`; Sonnet 5.5's `"updates"` progress notes are never requested. Gaffer does not add a request hook for them (research 07): both UIs show the summarized thinking Pi already records.
