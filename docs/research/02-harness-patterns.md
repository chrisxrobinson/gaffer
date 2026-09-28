# R2 — Agent Harness Patterns (2025–2026) and What Gaffer Should Take

_Researched 2026-09-27 from live sources. Paraphrased; quotes kept under 15 words._

## Gaffer workload, restated (the lens for every verdict)

- **Input:** one FPL team ID. **Output:** transfers, captain, chip advice and a 4-gameweek plan.
- **Run shape:** minutes, not hours. One linear task, invoked once or a few times per gameweek.
- **Execution:** fetch live FPL data, write and run Python analysis in a sandbox, then synthesise.
- **Later need:** compare the advice with the points actually scored, and improve the model through backtests.
- **Harness:** Pi (pi.dev). It has 4 core tools (read/write/edit/bash), a system prompt under 1k tokens, JSONL tree sessions, TypeScript extensions and an SDK/RPC/JSON mode. It deliberately leaves out sub-agents, MCP, plan mode and to-dos.

The Pi and Anthropic sources share one theme: **every harness component encodes an assumption about what the model can't do on its own**, and those assumptions go stale as models improve (Anthropic, Mar 2026 and Apr 2026). The default for Gaffer should therefore be to build the minimum and add a component only when a failure shows it is needed.

---

## 1. Long-running harness: initializer agent + progress file + feature checklist

**What it is.** Anthropic (Nov 26, 2025) splits multi-session coding into two roles:
- An **initializer agent** runs once. It writes `init.sh`, a `claude-progress.txt` log and an initial git commit.
- A **coding agent** handles every later session and implements one feature at a time.

A JSON **feature list** starts with every item marked "failing". This stops the agent from declaring victory too early, and JSON is harder for the model to casually rewrite than Markdown. Each session ends in a "clean state": a git commit plus a progress note. Features are checked end to end, not just with unit tests.

A follow-up (Mar 24, 2026, "Harness design for long-running application development") adds planner → generator → evaluator agents and "sprint contracts". It reports that **context resets with structured hand-offs beat compaction** on multi-hour builds. It also shows that newer models (Opus 4.6) let the harness drop scaffolding such as sprint decomposition. The full harness cost was about $200 over 6 hours, against $9 over 20 minutes for a solo agent.

**Verdict: REJECT (keep one idea).** A Gaffer run takes minutes and fits in one context window, so there is no multi-session hand-off for an initializer or progress file to bridge. The idea worth keeping is the **"all items start failing" checklist**. Gaffer should have a fixed, machine-checkable list of required outputs (squad valid, budget ≤ bank, ≤3 per club, captain chosen, chip decision stated, GW+1..+4 plan present). The run is not "done" until a deterministic validator passes every item. That belongs in #8, not in a separate agent.

## 2. Managed agents: brain / hands / session separation

**What it is.** Anthropic "Scaling Managed Agents" (Apr 8, 2026) separates three pieces:
- **Session:** a durable, append-only event log that lives *outside* the context window.
- **Harness ("brain"):** a stateless loop that can crash and resume with `wake(sessionId)` / `getEvents()`.
- **Sandbox ("hands"):** a stateless tool, `execute(name, input) → string`.

Containers are provisioned **lazily**, only when the model first calls a tool. This cut time-to-first-token by about 60% at p50 and over 90% at p95. **Credentials never enter the sandbox** that runs model-written code. Tokens are either bundled into resources at init, or held in a vault behind a proxy.

**Verdict: ADAPT.**
- **Keep the credential rule and the "sandbox as a tool" boundary as hard requirements.** Gaffer runs LLM-written Python, so the sandbox should hold only data files and a Python runtime. No API keys, and no network except perhaps an allow-listed FPL endpoint (or none, if the harness pre-fetches the data).
- **Adopt lazy provisioning cheaply.** Start the sandbox on the first `run_python` call.
- **Treat the session log as durable:** it is Pi's JSONL file (see #3).
- **Skip wake/resume orchestration and multi-brain scaling.** A minutes-long run can simply be re-run.

## 3. Append-only event logs / event sourcing for agent sessions

**What it is.** The session is an immutable sequence of typed events. Model context, transcripts, replay, forks and telemetry are all *projections* of that log. Managed Agents does this (see #2). Pi already does it natively: its sessions are **JSONL**, and every entry carries `id`/`parentId`, which forms a tree. Pi's entry types include:
- message, model-change, compaction, `ContextEditEntry` (append-only edits that change only future context), branch-summary and label entries;
- `CustomEntry` (extension state, not sent to the model) and `CustomMessageEntry` (injected into context).

Compaction "does not delete the original session entries". Several 2026 open-source harnesses (harnless, conducto-ai, c-daly/harness) take the same approach: the log is the source of truth and the message history is derived from it.

**Verdict: ADOPT, using Pi's native JSONL.** This is the backbone of "compare advice vs actual points".
- At the end of each run, write a `CustomEntry` (e.g. `customType: "gaffer.recommendation"`) holding the validated recommendation JSON, the gameweek, the FPL data snapshot hash, the model version and the tool/code versions.
- A later scorer fills in actual points by reading those entries.
- Do not build a separate event store for the MVP. Consider copying recommendation entries into a small table (SQLite) only when cross-user queries are needed.

## 4. Orchestrator/worker (sub-agent) delegation, and the arguments against it

**The case for it.** Anthropic's research system (Jun 13, 2025) uses a lead agent that fans out to parallel sub-agents. It scored 90.2% better than single-agent Opus 4 on an internal research eval, at roughly 15× the tokens of chat (a single agent uses about 4×). Sub-agents store artifacts externally and pass back lightweight references. Anthropic says this setup is a **poor fit** when agents "share the same context" or have many dependencies, and for most coding work.

**The case against it.** Cognition's "Don't Build Multi-Agents" (Jun 12, 2025) gives two principles: share full traces, and remember that "actions carry implicit decisions". Parallel agents make conflicting decisions, so Cognition recommends a single-threaded linear agent. Pi also omits sub-agents on purpose; Zechner says you have "zero visibility" into them and suggests spawning pi via bash when needed.

**Verdict: REJECT for the MVP.** Gaffer's reasoning is tightly coupled. The transfer choice depends on the captain, which depends on the chip, which depends on fixtures and the budget. Splitting it would scatter decisions across agents, multiply tokens, and give no benefit from parallel research.

**Possible later exception:** a *separate evaluator/critic pass* (#9), because Anthropic (Mar 2026) found that self-evaluation is biased toward praise.

## 5. Context compaction strategies

**What they are.**
- **Compaction** (summarise, then restart with the summary). Pi auto-compacts near the context limit, keeps recent messages and can be customised through extensions.
- **Tool-result clearing.** Anthropic's server-side `clear_tool_uses_20250919` defaults to triggering at 100k input tokens and keeping 3 recent tool uses. It has `exclude_tools`, and it invalidates the prompt cache when it fires.
- **Structured note-taking / memory files.** Described in Anthropic's context-engineering post (Sep 29, 2025), which also recommends "just-in-time" retrieval by identifier.
- **Context resets with hand-off files.** Anthropic (Mar 2026) found these beat compaction on multi-hour builds.
- Cognition suggests a dedicated compression model.

**Verdict: ADAPT (prevention over cure).** A minutes-long run should never need compaction if tools keep the context small.
- Python analysis should write large tables to files in the sandbox and return only **short summaries plus file paths** to the model.
- The fetch tool should return a digest, not raw JSON. `bootstrap-static` alone is large.
- Leave Pi's auto-compaction on as a safety net, and log it as an anomaly metric if it ever fires.
- No memory-file machinery is needed for in-run state.

## 6. Autoresearch-style loops (propose → run → keep if better)

**What it is.** Karpathy's `autoresearch` works like this:
- An agent reads `program.md` and edits only `train.py`.
- Each run trains for a fixed 5 minutes and is scored on `val_bpb`.
- Improvements are git-committed and failures reset, with results logged to `results.tsv`.
- `prepare.py` and the evaluation are off-limits.

Earendil reports Pi's autoresearch adoption (Aug 4, 2026). Shopify saw large speedups, for example unit tests running "300 times faster".

Known failure modes:
- **Goodhart / metric gaming.** An arXiv paper (2607.18064) found an agent that drove its score down by "memorizing answers". Adding a held-out set removed the gaming.
- **Objective drift under loose scoping.** Cerebras, Mar 19, 2026.
- Mode collapse (arXiv 2609.00077).

**Verdict: ADAPT, offline only, never in the user-facing run.** This fits the goal of improving Gaffer's model with backtests well.
- Define a frozen scorer on past gameweeks, e.g. expected-points error or the regret of the recommended transfers against hindsight-optimal ones.
- Let an offline Pi session edit only the projection/model module.
- Keep the scorer and data prep read-only, and give each experiment a fixed budget.
- **Hold out whole seasons, or a block of late gameweeks,** that the loop never sees. Accept a change only if it also holds up on the holdout.
- Log every experiment in an append-only TSV/JSONL.

## 7. Persistent memory (per-user preference files)

**What it is.** Anthropic's memory tool (beta `context-management-2025-06-27`) lets the model read and write a file directory that persists across conversations. Anthropic reported +39% on an internal eval for memory plus context editing, and +29% for context editing alone. Pi's convention is file-based: AGENTS.md / SYSTEM.md / skills, plus TODO.md-style files instead of built-in state.

**Verdict: ADAPT (harness-owned, structured, small).**
- Store per-user preferences as a **typed JSON file keyed by team ID**, owned by the harness and not the model. Examples: risk appetite, "never sell Salah", hit tolerance, chip plans already committed.
- Inject it at the start of each run as one short block.
- Update it only through an explicit tool or user confirmation.
- Do not use free-form model-written memory. It risks drift and prompt-injection, and a run that happens a few times per gameweek doesn't need it.

## 8. Structured output / schema-validated final answers

**What it is.** The Claude API has **JSON outputs** (`output_config.format`) and **strict tool use** (`strict: true`). Both compile a JSON Schema into a grammar for constrained decoding, with limits on schema complexity (e.g. a total count of optional parameters). Pi exposes a JSON event stream and SDK/RPC modes, so a host can consume events programmatically.

**Verdict: ADOPT.** The final answer must be a machine-readable `Recommendation` object. It is scored later (#3/#6) and possibly rendered in a web UI.
- Have the model finish by calling a strict `submit_recommendation` tool (Pi extension tool).
- Then run a **deterministic Python validator** on FPL rules: squad of 15 with 2/5/5/3 positions, ≤3 per club, budget and selling prices, free transfers and hits, chip availability, deadlines.
- On failure, return the errors to the model for one repair turn.
- The human-readable explanation is rendered *from* the object, not written separately.

## 9. Other patterns that clearly matter

**9a. Deterministic tools for correctness-critical steps — ADOPT.** FPL legality and budget arithmetic are exact constraint problems. The community already solves transfer and chip planning with MILP solvers (sertalpbilal/solioanalytics `open-fpl-solver`, `lisovoy7/fpl-solver`). The LLM should frame the problem, pick objectives and explain trade-offs. A solver or validator should enforce constraints and compute optimal squads. This follows Anthropic's "workflows vs agents" point: use predefined code paths where the steps are known (Dec 2024).

**9b. Evals in the loop — ADOPT.** Anthropic's evals guide (Jan 9, 2026) recommends:
- Start with "20-50 simple tasks drawn from real failures".
- Prefer code-based graders where possible, and "grade what the agent produced, not the path".
- Read the transcripts.
- Use pass^k when consistency matters.

For Gaffer this means:
- A fixed set of historical team IDs × gameweeks with frozen data snapshots.
- Code graders for validity and points, plus an optional LLM-judge rubric for the quality of explanations.
- Run the set on every prompt, tool or model change.

**9c. Tool-result caching / data snapshots — ADOPT.**
- Fetch FPL endpoints once per run, or per gameweek for the shared `bootstrap-static` and `fixtures`, and store them as content-hashed snapshot files.
- Mount the snapshot read-only into the sandbox.
- Record the hash in the recommendation entry.

This gives reproducibility for backtests and replay, lighter load on FPL's API, and a sandbox with no network (#2).

**9d. Tool design / ACI — ADOPT.** Anthropic's "Writing tools for agents" (Sep 11, 2025):
- Consolidate operations into a few purposeful tools.
- Return human-readable fields (player names, not only IDs).
- Paginate or truncate with sensible defaults, and offer a concise response format.
- Namespace tools.

This fits Pi's minimal-tool stance: a handful of tools such as `fpl_fetch`, `run_python`, `solve_squad`, `validate`, `submit_recommendation`, plus a tool allow-list rather than full coding tools.

**9e. Separate critic/evaluator pass — ADAPT (optional, post-MVP).** Anthropic (Mar 2026) saw generators "confidently praising" mediocre work. A cheap single critic call over the structured recommendation could catch reasoning errors that the rule validator can't, such as ignoring a blank gameweek. Add it only if evals show those errors happen.

**9f. Harness minimalism / stress-test assumptions — ADOPT as a principle.** Both the Managed Agents and harness-design posts say to remove components as models improve. Pi's philosophy is the same. Re-run evals with components ablated at each model upgrade.

---

## Verdict table

| # | Pattern | Verdict | Reason (Gaffer-specific) |
|---|---|---|---|
| 1 | Initializer + progress file + feature list | REJECT (keep checklist idea) | Runs take minutes in one context, so there is no cross-session hand-off; the "all-failing checklist" becomes the output validator |
| 2 | Brain/hands/session separation, lazy sandbox, creds out of sandbox | ADAPT | The sandbox runs LLM-written Python, so creds-out and sandbox-as-tool are mandatory; resume/multi-brain scaling is unnecessary for re-runnable jobs |
| 3 | Append-only event-sourced session log | ADOPT (Pi JSONL) | Pi already has it; `CustomEntry` recommendations make advice-vs-actual scoring easy |
| 4 | Orchestrator/worker sub-agents | REJECT | Transfer, captain and chip decisions are tightly coupled; splitting adds ~15× tokens and conflicting decisions |
| 5 | Compaction / tool-result clearing / memory files | ADAPT | Prevent with compact tool outputs and file handles; keep Pi auto-compaction only as a safety net |
| 6 | Autoresearch loop | ADAPT (offline) | Good for improving projections via backtests, but only with a frozen scorer and a held-out season against Goodhart |
| 7 | Persistent per-user memory | ADAPT | A small harness-owned JSON of preferences per team ID; no free-form model-written memory |
| 8 | Structured / schema-validated output | ADOPT | Advice must be scored and rendered later; strict tool plus deterministic FPL-rules validator |
| 9a | Deterministic tools (solver/validator) | ADOPT | FPL legality and optimisation are exact constraint problems; the LLM explains, the solver decides |
| 9b | Evals in the loop | ADOPT | A fixed historical team×GW set with code graders on every change |
| 9c | Data snapshots / caching | ADOPT | Reproducible backtests, a no-network sandbox, polite API use |
| 9d | ACI tool design | ADOPT | A few consolidated, token-efficient tools match Pi's minimalism |
| 9e | Separate critic pass | ADAPT (later) | Only if evals show reasoning errors the validator misses |

## Sources

- https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents (Nov 26, 2025)
- https://www.anthropic.com/engineering/managed-agents (Apr 8, 2026)
- https://www.anthropic.com/engineering/harness-design-long-running-apps (Mar 24, 2026)
- https://www.anthropic.com/engineering/building-effective-agents (Dec 19, 2024)
- https://www.anthropic.com/engineering/multi-agent-research-system (Jun 13, 2025)
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents (Sep 29, 2025)
- https://www.anthropic.com/engineering/writing-tools-for-agents (Sep 11, 2025)
- https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents (Jan 9, 2026)
- https://cognition.com/blog/dont-build-multi-agents (Jun 12, 2025)
- https://earendil.com/posts/there-are-many-agent-harnesses-but-this-one-is-mine/ (Sep 1, 2026)
- https://earendil.com/posts/pi-autoresearch-and-databricks/ (Aug 4, 2026)
- https://pi.dev , https://pi.dev/docs/latest , https://pi.dev/docs/latest/sessions , https://pi.dev/docs/latest/session-format
- https://mariozechner.at/posts/2025-11-30-pi-coding-agent/ (Nov 30, 2025)
- https://github.com/earendil-works/pi
- https://github.com/karpathy/autoresearch
- https://www.cerebras.ai/blog/how-to-stop-your-autoresearch-loop-from-cheating (Mar 19, 2026)
- https://arxiv.org/abs/2607.18064 (Autoresearch with coding agents: generalizers and metric-maximizers)
- https://platform.claude.com/docs/en/build-with-claude/context-editing
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use
- https://github.com/sertalpbilal/FPL-Optimization-Tools (redirects to solioanalytics/open-fpl-solver)
- https://github.com/lisovoy7/fpl-solver
- Event-sourced harness examples (search results, not read in depth): https://github.com/Undernapse/harnless/issues/5 , https://github.com/malcmiller/conducto-ai/issues/156 , https://github.com/c-daly/harness

## Unconfirmed

- **Earendil "many harnesses" post:** the fetched text is a user-experience piece by an Earendil associate. It has no technical detail on Pi internals, so every Pi technical claim here comes from pi.dev docs and Zechner's Nov 2025 post instead.
- **Earendil autoresearch post:** the fetch showed no link to Karpathy and no description of the Databricks methodology. I couldn't confirm how Pi's autoresearch extension logs experiments or what its interface is. Looked at: the Earendil post only. Pi's package registry and GitHub were not searched.
- **Pi compaction status:** Zechner's Nov 2025 post said compaction was not implemented. Current pi.dev docs describe auto-compaction and compaction entries. I'm assuming it has since shipped, but I didn't confirm its default trigger threshold.
- **Pi structured output:** I found no native "final answer must match schema" feature in Pi. The strict-tool approach assumes a Pi extension can register a tool with a JSON Schema and pass `strict` through to the Anthropic provider. Not verified; this should be checked in spike S1.
- **Memory tool figures:** the "+39% / +29%" figures come from search-result snippets citing Anthropic, not from a page I read directly.
- **Overfitting size:** the "half to two-thirds of in-loop gains fail on held-out" figure appeared only in a search snippet. I could not tie it to a specific source; the arXiv abstract I read supports the qualitative claim (memorisation that disappears once a held-out set exists).
- **Karpathy autoresearch release date:** not confirmed; the README summary mentioned a tongue-in-cheek "March 2026" note.
- **Harness-design post details:** the Mar 2026 post was fetched, but the specific cost/duration numbers are from the fetch model's summary and were not checked line by line.
- **Managed Agents credential mechanism:** vault/proxy details are summarised from the fetch and not verified against the Managed Agents API docs.
