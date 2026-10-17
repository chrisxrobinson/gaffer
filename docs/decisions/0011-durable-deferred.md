# ADR 0011 — Pi Durable: stay on pi-coding-agent, build two seams, revisit on stated triggers

**Status:** Accepted · **Date:** 2026-10-17 · **Evidence:** [research 08](../research/08-pi-durable.md), [spike S8](../../spikes/s8-durable-gaffer/README.md)

## Context
Pi Durable (`@earendil-works/pi-durable`, harness since 1.0.0 on 2026-10-01) is a separate agent harness built on pi-ai. It commits conversations, model turns, tool calls and typed documents to storage (SQLite, JSONL, Durable Object SQLite) before showing them, resumes interrupted runs on reopen, forks a conversation at any entry, and lets clients `watch()` a conversation. Earendil's Cloudflare sample runs one Durable Object per session with a React UI over WebSockets.

The brief asked whether Durable should change Gaffer's core before Phase 2, and to test seven plausible fits rather than assume them. Research 08 and spike S8 found:
- **It is not part of `pi-coding-agent`** and none of its releases depends on it. Its README says "Experimental. The API changes without notice", and it made 14 breaking changes in its first 14 days.
- **Gaffer's agent core ports in about the same size** (S8: 68 lines for the sections, three tools and the guard; S1's equivalent was 68). **Everything around it is missing:** skills, prompt templates, Pi packages, themes, the TUI, slash commands, RPC mode, `models.json`/`auth.json`, and Pi's session JSONL. Hooks cannot abort or steer a run, so `gaffer-budget` would move into host code. About 60–80% of the 505 extension lines and 650 lines of session readers would change.
- **Crash resume works,** but Gaffer's loss today is small: after a restart mid-run, `pi --continue` reopens the session and the user prompts again (S8 baseline on 0.87.1). For a 75 s, $0.06 run, Durable saves one prompt.
- **`watch()` works within one process only.** A second process saw 0 updates. Two processes owning one store ran the same sandbox command twice and one failed (`Task 18 is already terminal`). The README says so: "One process owns a storage at a time; there is no cross-process locking". Sharing a live run between two UIs needs a host process and a transport either way.
- **There is no scheduler,** only a checkpointed `sleep(until)` inside a live process. `gaffer-eval` is an idempotent one-shot that cron or a scheduled task runs better.
- **Forks and typed documents fit well** (a what-if fork kept the snapshot document and left the parent's recommendation alone), but Pi's `/fork` and in-session `/whatif` already cover the need.
- **Cloudflare Durable Objects can't host Gaffer's sandbox** (a JS isolate, 128 MB; Python and HiGHS need a container), and UI 1's terminal can't live in one. ECS (ADR 0006) stays the Phase 2 topology.
- The experimental durable coding agent and vacation planner were removed in 1.2.0 with `pi-server`, `pi-client` and `pi-protocol`; nothing replaced them.

## Options considered
| Option | Effort | Risk | Minimalism | "Pi package, Pi core unchanged" |
|---|---|---|---|---|
| (a) Stay on `pi-coding-agent` 1.x; design seams | 0.5–1 day | Low | Best | Intact |
| (b) Durable as the backend for the Gaffer App only | 1.5–2.5k lines, 2–3 weeks | High: two runtimes and two session stores, so a session can't move between UIs | Poor | Split |
| (c) Move Gaffer entirely onto Durable | 3.5–5k lines, 4–6 weeks | Very high: unstable API, no TUI/skills/packages, every eval re-baselined | Poor | **Ends it** |
| (d) Defer with triggers | 0 | Low | Good | Intact |

## Decision
**(a) now, with (d)'s triggers.** Gaffer stays a Pi package on `pi-coding-agent`. Two seams are built in Phase 1.1 because Gaffer needs them anyway:
1. **One owner per session** (ADR 0014). The Gaffer App's host takes a lock before it runs Pi on a session file; the other UI shows that session read-only. Why Gaffer can't do without it: two writers on one session file double-run work and corrupt the log, on Pi as on Durable.
2. **A transport-independent event reducer** in the Gaffer App. It builds UI state from `message_*`, `tool_execution_*`, `turn_*` and `agent_*` events plus tool `details`. Why: those are the names both Pi's RPC mode and Durable's `watchEvents()` emit, so the App could change backend without a rewrite.

Not built: a resume notice for interrupted runs (about 15 lines on `session_start` with reason `resume`). It is the cheap part of Durable's crash safety and is adopted only if Phase 2 logs show mid-run restarts.

**Revisit Durable when any trigger holds** (checked at each Pi release and at Phase 3 planning):
- **T1, stability:** Durable drops "Experimental" and two consecutive minor releases have no breaking changes.
- **T2, transport:** Pi ships a supported cross-process attach to a live conversation, with auth.
- **T3, need:** Phase 2 shows ≥5% of runs interrupted by restarts; or Phase 3 needs agent work that outlives a user turn (deadline-day monitoring, background research); or per-user agents need hibernation economics.

## Consequences
- **For the theory:** the "Pi package, Pi core unchanged" thesis survives this test. Durable is a different harness, not a better base for Gaffer today, and nothing Gaffer needs requires leaving `pi-coding-agent`.
- Gaffer keeps Pi's JSONL as its system of record (ADR 0004), so the admin report, `/usage`, `/scorecard`, `replay` and `gaffer-eval` are untouched.
- A restart mid-run still costs the user one prompt. That is accepted at single-user scale and measured in Phase 2.
- `src/` stays free of Pi types where it is today (about 3,000 of 4,100 lines), so a later port would rewrite only the thin extensions.
- ROADMAP's "Pi API churn" checkpoint now includes the three triggers.
