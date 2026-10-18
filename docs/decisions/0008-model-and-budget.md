# ADR 0008 — Default model, provider swap and hard budget caps

**Status:** Accepted, amended by [ADR 0010](0010-context-as-section-patches.md) (prices, model config) · **Date:** 2026-09-27

## Context
- **Prices** in Pi 0.87.1's model catalogue (`pi-ai/dist/models.generated.js`), per million tokens:

  | Model | Input | Output | Cache read |
  |---|---|---|---|
  | `claude-sonnet-5` | $2 | $10 | $0.20 |
  | `claude-sonnet-5-5` (not in the 0.87.1 catalogue, so added via `harness/models.json` until Pi 1.3.0; from M1.1-1 Pi's catalogue entry, checked by `test/default-model.test.ts`; ID and limits verified with the Models API on 2026-09-28) | $2 | $10 | $0.20 until 2026-10-07, **$0.10 since** (Anthropic release notes; ADR 0010) |
  | `claude-haiku-5-5` (launched 2026-10-07; in Pi's catalogue from 1.1.0; prompts ≤ 100k tokens) | $0.10 | $0.50 | $0.01 |
  | `claude-opus-5-5` | $4 | $20 | — |
  | `claude-haiku-4-5` | $1 | $5 | — |
  | `claude-fable-5-1` | $10 | $50 | — |
- **Cost calculation:** Pi computes it on the client from the catalogue, including tiered prices (`calculateCost`, `pi-ai/dist/models.js:533`). It records usage and cost on every assistant message.
- **Providers:** they are added or overridden through `pi.registerProvider()` or `models.json` ([research 01 §2](../research/01-pi-internals.md)).

## Options considered
- A single hard-coded model: rejected, because it goes against the provider-swap requirement.
- A cheap model for data work and a strong one for strategy (routing): premature.
- **One configurable model, a sensible default, and budget enforcement in an extension: chosen.**

## Decision
- **Default model:** `anthropic/claude-sonnet-5-5` (switched from `claude-sonnet-5` on 2026-09-28 when Sonnet 5.5 was released at the same price), thinking `medium`, set by `GAFFER_MODEL` and `GAFFER_THINKING`. It can be swapped for any Pi provider or model (`--provider/--model`, or `models.json` for OpenAI-compatible or local endpoints) with no code change. The eval suite ([ARCHITECTURE §6](../ARCHITECTURE.md)) is what qualifies a model.
- **Cost estimate per recommendation** (Sonnet 5, about 12 turns, heavy prompt caching): about 250k cache-read, 40k cache-write, 20k uncached input and 15k output tokens, which comes to **≈ $0.35**. The target is under $0.50 median.
- **Hard caps** are enforced by the `gaffer-budget` extension:
  - On each `turn_end`, it sums `usage.cost.total` over every assistant message in the session file (all branches: spend on an abandoned branch is still spend) and appends a `gaffer.budget` entry.
  - Above `GAFFER_BUDGET_SOFT` (default $0.75), it adds a steering message telling the model to wrap up and submit: once per session (recorded as `steered` in that turn's `gaffer.budget` entry), delivered before the model's next call, and not on a turn that ends the run (no tool calls, or the submission), where a steer would start another model call.
  - Above `GAFFER_BUDGET_HARD` (default $1.50 per session), it calls `ctx.abort()` and emits a partial-result notice.
  - A daily cap (`GAFFER_BUDGET_DAILY`, default $5) is checked against the day's (UTC) session files in the `input` event, which can refuse a prompt before any LLM call (`before_agent_start` can't cancel a run), and again on each `turn_end`. It sums every session under `GAFFER_SESSIONS_ROOT` (the image sets `/sessions`), so headless and eval runs, which keep their sessions in subdirectories, share the cap with the TUI.
  - Separately, turns are capped at 40 per run (`GAFFER_MAX_TURNS`).
- **Price drift:** a `GAFFER_PRICE_OVERRIDES` JSON lets an operator correct catalogue prices through `registerProvider` overrides without upgrading Pi.

## Consequences
- The caps depend on Pi's cost numbers being right. Spike S1 used Pi's test ("faux") model provider, which reports $0, so real-provider cost reporting needs checking in the first MVP milestone (ROADMAP M1 exit criterion).
- The per-message usage data is also what the admin centre reads, so there is one source for spend.

## Amendments
- **2026-10-17 ([ADR 0010](0010-context-as-section-patches.md)):** the Sonnet 5.5 cache-read price fell to $0.10/MTok on 2026-10-07 and `harness/models.json` is corrected (on Pi 1.3.0, from M1.1-1, the file is deleted and the catalogue entry used). The model entry also gains `supportsMidConvoSystemMessages`, so per-prompt sections don't re-bill the history. Spend now includes Pi's `usage` entries (cache warming, summaries), which the caps previously missed. Prices are checked against the provider's price list and release notes at each Pi upgrade.
- **2026-10-18 ([spike S10](../../spikes/s10-real-model-1x/README.md)):** Claude Haiku 5.5 ($0.10/$0.50) was qualified against the full suite on Pi 1.3.0 and **not adopted**. It was valid 30/30 and cost $0.0086 median per recommendation, but its latency p50 was 101 s (NFR-LAT-01: ≤ 90 s), only 9/30 cases passed on the first submission (6 used the last of three attempts), and five cases scored worse than the golden path. Sonnet 5.5 stays the default; Haiku is reconsidered if cost becomes the constraint (Phase 3), after a prompt pass. The same spike ran six Sonnet 5.5 cases on Pi 1.3.0 with the catalogue entry: identical points and attempts to the 0.87.1 run.
