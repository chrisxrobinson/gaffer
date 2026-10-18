# ADR 0007 — Single agent, no orchestrator/worker split

**Status:** Accepted · **Date:** 2026-09-27 · **Reaffirmed** 2026-10-17 ([research 12](../research/12-harness-patterns-update.md) §11)

## Context
The brief suggests a possible split into a data worker, a modelling worker and a strategy lead. The research says otherwise ([research 02](../research/02-harness-patterns.md)):
- Cognition argues that actions carry implicit decisions, and that conflicting decisions produce bad results.
- Anthropic's multi-agent research post says the pattern fits poorly when all agents need the same context. It also reports token use of roughly 15× chat.
- Pi deliberately ships no sub-agents, because they make it hard to see what is happening ([research 01 §9](../research/01-pi-internals.md)).

Gaffer's decisions are tightly coupled. A transfer changes the captain options, which change the chip value. Each run takes minutes and about 10–20 tool calls.

## Options considered
1. Orchestrator plus data, modelling and strategy workers
2. Parallel "critic" sub-agent reviewing the final recommendation
3. **One agent, with deterministic tools for the correctness-critical steps.** **Chosen.**

## Decision
- One Pi agent session per recommendation run.
- **The "data worker" is a tool.** `fpl_snapshot` is deterministic code, not a model.
- **The "modelling worker" is a library call.** `gaffer_lib` projection plus the optimiser, run in the sandbox.
- **The "strategy lead" is the agent itself,** guided by skills.
- A critic pass (option 2) is **deferred**. It gets added only if evals show errors that the deterministic validator doesn't catch ([ARCHITECTURE §6](../ARCHITECTURE.md)). *Added 2026-10-17:* if one is built, it reads the structured recommendation in an **isolated** context (a separate session), not a fork of the agent's, so the agent's reasoning doesn't anchor it (research 12 §11).

## Consequences
- Cost and latency stay low, and there is one readable transcript.
- **Parallelism happens inside the sandbox** through ordinary Python (for example, optimiser scenarios), not through agents.
- **Revisit trigger:** if context use regularly goes above 60% of the window, or offline autoresearch needs parallel experiments ([ARCHITECTURE §6.5](../ARCHITECTURE.md)). Autoresearch runs are separate Pi sessions started by a script, not sub-agents of a user run.
- *Reaffirmed 2026-10-17 (research 12):* the period's evidence (Cognition's lead-plus-sidekick, LangChain on forked vs isolated workers, a reviewer agent lowering success in one study) supports delegation for long tasks; Gaffer's 4–5-call, $0.06 coupled runs are the short case where it "offered little to delegate". Pi Durable's subagent examples (research 08) don't change this.
