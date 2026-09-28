# Project Gaffer — Research & Architecture Brief

## The task

I'm starting a project to test a theory: that a minimal coding-agent harness like **Pi** (https://pi.dev/docs/latest) can be extended into a domain agent for something other than coding, while keeping the principles that make Pi good — a small core, few tools, the model writing and running its own code, and extensibility through packages rather than built-in features.

The test case is **Gaffer**, a Fantasy Premier League (FPL) agent. A user enters their FPL team ID; Gaffer pulls live data, runs its own analysis in a sandbox, applies FPL rules and strategy, and returns structured transfer, captaincy and chip recommendations with a 4-gameweek plan. The single objective is to maximise the user's total FPL points over the season.

FPL is a good test because it needs all three things a coding harness is built around: tools and APIs to fetch data, a sandbox to write and run analysis code, and skills to apply domain reasoning.

Your job is **research, then architecture**. Do not write application code in this run, apart from small throwaway spikes that prove or disprove a design assumption (e.g. "does a Pi extension hook allow X?"). Spikes live in `spikes/` and are noted in the decision log.

## What "done" looks like

Done means all of the following exist in `docs/` and are consistent with each other:

1. `docs/research/` — one note per research area below, each ending with a **Sources** list and an **Unconfirmed** list (anything you couldn't verify, and where you looked).
2. `docs/ARCHITECTURE.md` — the full design, covering every section under "Design areas", with at least one component diagram (Mermaid) and one sequence diagram for the core "team ID → recommendations" flow.
3. `docs/REQUIREMENTS.md` — functional and non-functional requirements, each with an ID (FR-01, NFR-01…) and an acceptance criterion someone could test.
4. `docs/decisions/` — one short ADR per significant choice (context, options considered, decision, consequences). Minimum: sandbox approach, data-source access (tool vs MCP), analytics-as-tools vs analytics-as-skills, session/log storage, web TUI approach, deployment topology.
5. `docs/ROADMAP.md` — phased build plan: an MVP a single user can run locally in Docker, then cloud deployment, then multi-user. Each phase lists its scope and exit criteria.
6. `docs/REPO_LAYOUT.md` — proposed directory tree for the code project with a one-line purpose per top-level folder, plus the list of Pi extensions/packages/skills to build.

Stop and ask me only if: a core assumption turns out to be false (e.g. Pi can't be extended in a way this design needs, or the FPL API is unusable), or two sources conflict in a way that changes the architecture. Otherwise keep going, and put status notes in the same message as your next action.

Keep your working checklist in `TASKS.md`. Tick items as you finish them and add anything new you discover. End the run with three headings: **Blocked on me**, **Produced**, **Found** (the most important or surprising findings).

## Working method

- **Read Pi first.** Before designing anything, read the Pi docs and source (extensions, custom providers, containerisation, packages, sessions, the SDK/RPC modes if present). The design must use Pi's real extension points, not assumed ones. Cite the doc page or source file for each extension point you rely on.
- **Split research across subagents.** Give each research area below its own subagent. When a subagent reports back, check its evidence before you accept it. Then synthesise the architecture yourself — don't delegate the architecture.
- **Current information only.** It's the 2026/27 season. Verify current FPL rules, chip rules, API endpoints and library versions from live sources rather than memory. FPL rules change between seasons (chips, assistant manager, etc.) — flag anything that did.
- **Stay minimal.** For every tool, service or feature you propose, state in one line why the agent can't do without it. If you can't justify it, cut it. Prefer "the model writes Python in the sandbox" over a bespoke tool wherever the result is equally reliable.
- **Mark what you couldn't confirm**, and say where you looked.

## Research areas

1. **Pi internals and philosophy** — extension API, custom providers, packages, session format and storage, containerisation, how tools and skills are defined, TUI architecture. Also read the author's reasoning for its minimal design (references below) so the design stays faithful to it.
2. **Agent harness patterns (latest)** — long-running agent harnesses, initializer/progress-file patterns, managed agents (brain/hands/session separation), append-only event logs, orchestrator/worker delegation, context compaction, autoresearch-style loops. For each pattern, say whether Gaffer needs it and why.
3. **FPL data sources** — the official FPL API (bootstrap-static, fixtures, element-summary, entry/{id}, entry/{id}/history, picks, live GW endpoints, event status), its rate-limit behaviour and terms, and whether to access it via a Pi tool, an MCP server, or existing packages. Then free/cheap supplementary sources: expected stats (xG/xA), set-piece and penalty takers, injury/team news, predicted line-ups, price-change predictions, historical season data (e.g. vaastav/Fantasy-Premier-League), betting-odds-derived probabilities. For each: access method, licence/terms, freshness, reliability, and whether it needs a key.
4. **FPL analytics** — what actually works: expected-points projection models, minutes prediction, fixture difficulty (and better alternatives to official FDR), team-strength models (e.g. Dixon-Coles / odds-implied), multi-GW optimisation via integer programming (e.g. open-source FPL optimisers using PuLP/HiGHS), transfer-hit valuation, captaincy EV, chip timing (blank/double GWs), effective ownership and risk. Include the linked Medium algo article and other published FPL data-science work. Recommend a baseline model for MVP and an upgrade path.
5. **Web-based TUI** — options for running a terminal-style UI in the browser that talks to a containerised agent (e.g. xterm.js over WebSocket to Pi's TUI, vs. a web frontend over Pi's RPC/SDK mode that mimics the CLI look). Trade-offs for security, multi-user and streaming.
6. **Deployment** — cloud-agnostic Docker/Compose topology that maps cleanly to AWS (ECS/Fargate) and elsewhere; per-session sandbox isolation; secrets; managed-agents-style separation of harness, sandbox and session store.

## Design areas for ARCHITECTURE.md

**1. Turning Pi into Gaffer.** How extensions, a custom system prompt, skills, custom tools, slash commands and TUI theming make it feel like an FPL agent, while the core loop, session model and package system stay untouched. What Gaffer removes or disables from the default coding setup, and why.

**2. Functional behaviour.** At minimum:
- Input: FPL team ID (plus optional preferences: risk appetite, chips to save, players to keep).
- Fetch the user's squad, bank, free transfers, chips used/remaining, and current GW status, fresh at request time — never from stale cache when a deadline is near.
- Understand GWs, deadlines, blank/double GWs, price changes, the 15-man squad rules (budget, max 3 per club, positions), transfers and hits, captaincy and vice, bench order, auto-subs and every chip in the current season's rules.
- Output a structured recommendation: this GW's transfers (with expected-points gain vs. hit cost), captain/vice, starting XI and bench order, chip advice, and a 4-GW rolling plan — each with a short rationale and confidence.
- Output must be machine-readable (JSON schema) as well as human-readable in the TUI.
- Gaffer only advises; it never logs into or changes the user's FPL account.

**3. Data layer.** Tool vs MCP decision; caching strategy with TTLs tied to FPL's update cycle (and bypassed near deadlines); rate limiting, retries with backoff and jitter; handling API downtime during GW updates; data validation; where historical snapshots are stored for backtesting.

**4. Analytics: tools vs skills vs sandbox.** Decide the split. My starting view: deterministic, correctness-critical logic (squad-rule validation, the optimiser, points calculation) should be tested tools or a library the sandbox imports; strategy and judgement (chip timing, risk, narrative) should be skills; exploratory analysis should be free-form code in the sandbox. Challenge this if the research says otherwise. Define the sandbox (language, preinstalled libraries, resource limits, network policy, lifetime).

**5. Harness features.** Which to adopt and why: append-only session/decision log, persisted recommendations so Gaffer can later compare advice against actual points, per-user memory of preferences, orchestrator/worker split (e.g. a data worker, a modelling worker, a strategy lead), compaction behaviour. Justify each against the "no pointless features" rule.

**6. Evaluation (don't skip this).** How we'll know Gaffer is good: backtesting against past seasons, comparison with baseline strategies (e.g. "no transfers", official FPL projections, template team), tracking recommendation quality week by week, and regression tests for the rules engine. This is how the theory in the first paragraph gets tested.

**7. Usage — web TUI.** Browser UI that looks and behaves like the Pi CLI. Chosen approach, how it connects to the agent, streaming, reconnects.

**8. Deployment.** Docker services and their responsibilities, how they map to AWS and to a generic host, config and secrets, scaling path. Single-user first, with the seams for multi-user (auth, tenancy, per-user sandboxes, per-user budgets) identified but not built.

**9. Admin centre.** Sessions, token usage and cost per session/model/tool, latency, errors, data-source health. First find what Pi already records in its session files; build only what's missing, reading from those files rather than adding a parallel store where possible.

**10. Non-functional requirements.** Cost per recommendation target and hard budget caps, latency target, security (sandbox escape, prompt injection from scraped web content, secrets handling), privacy of team IDs, observability, model/provider swap via Pi's custom providers, and failure behaviour when a data source is down.

## References

- https://pi.dev/docs/latest
- https://pi.dev/docs/latest/extensions
- https://pi.dev/docs/latest/custom-provider
- https://pi.dev/docs/latest/containerization
- https://pi.dev/packages
- https://earendil.com/posts/there-are-many-agent-harnesses-but-this-one-is-mine/
- https://earendil.com/posts/pi-autoresearch-and-databricks/
- https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- https://www.anthropic.com/engineering/managed-agents — I especially like this for the deployment approach.
- https://medium.datadriveninvestor.com/fantasy-epl-gw26-recap-and-gw27-algo-recommendations-d11ac0e8304a
- Any other current FPL data-science and optimisation work you can find.
