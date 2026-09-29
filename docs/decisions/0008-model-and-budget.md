# ADR 0008 — Default model, provider swap and hard budget caps

**Status:** Accepted · **Date:** 2026-09-27

## Context
- **Prices** in Pi 0.87.1's model catalogue (`pi-ai/dist/models.generated.js`), per million tokens:

  | Model | Input | Output | Cache read |
  |---|---|---|---|
  | `claude-sonnet-5` | $2 | $10 | $0.20 |
  | `claude-sonnet-5-5` (not in the 0.87.1 catalogue; added via `harness/models.json`, prices from Anthropic's published rates, ID and limits verified with the Models API on 2026-09-28) | $2 | $10 | $0.20 |
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
  - Above `GAFFER_BUDGET_SOFT` (default $0.75), it adds a steering message telling the model to wrap up and submit.
  - Above `GAFFER_BUDGET_HARD` (default $1.50 per session), it calls `ctx.abort()` and emits a partial-result notice.
  - A daily cap (`GAFFER_BUDGET_DAILY`, default $5) is checked against the day's (UTC) session files in the `input` event, which can refuse a prompt before any LLM call (`before_agent_start` can't cancel a run), and again on each `turn_end`.
  - Separately, turns are capped at 40 per run (`GAFFER_MAX_TURNS`).
- **Price drift:** a `GAFFER_PRICE_OVERRIDES` JSON lets an operator correct catalogue prices through `registerProvider` overrides without upgrading Pi.

## Consequences
- The caps depend on Pi's cost numbers being right. Spike S1 used Pi's test ("faux") model provider, which reports $0, so real-provider cost reporting needs checking in the first MVP milestone (ROADMAP M1 exit criterion).
- The per-message usage data is also what the admin centre reads, so there is one source for spend.
