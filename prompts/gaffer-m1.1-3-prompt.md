# Project Gaffer — Build Brief: Phase 1.1, Milestone M1.1-3 (Gaffer App: recommend)

## Where we are

Gaffer is a Fantasy Premier League agent built as a Pi package (`packages/pi-gaffer`) on `@earendil-works/pi-coding-agent` 1.3.0. It runs as `ttyd → tmux → pi` in a harness container beside a no-network Python sandbox. Phase 1 (M1–M5) is built and in live use.

- **M1.1-1** moved Gaffer to Pi 1.3.0 with the built-ins locked off. It deploys live in 2026-10-23 17:30Z – 10-25 17:30Z.
- **M1.1-2** made the browser terminal Gaffer's own: the header, the status strip, the themes, the command allowlist and copy. It is on branch `build-m1.1-2` and deploys in 2026-10-31 11:00Z – 11-02 11:00Z, through a scheduled task.

BUILD.md's M1.1-1 and M1.1-2 sections record both, and the baselines below come from them.

M1.1-3 builds the second UI, the **Gaffer App**, for its first and most important action: *Recommend this GW*. The App is a local web app laid out like a desktop agent client:
- sessions on the left, grouped by team and GW;
- a structured start instead of a blank prompt;
- the run streaming as collapsible steps;
- the recommendation drawn from its JSON as a real page: a transfers table, the XI on a pitch, captaincy, chips and the 4-GW plan.

It shares one session store with the terminal. The decisions are made: ADR 0014 says what to build and why, `docs/ui` §4–8 says what each screen and state shows and which event drives it, and spike S7 recorded the RPC events a Gaffer-shaped run emits on Pi 1.3.0.

Why this matters: the terminal works for someone who likes a prompt, but the product is the recommendation. The App is where a manager reads it in two seconds on a phone or a laptop: transfers, captain and XI. Phase 1 must keep working while this is built, so nothing the terminal does today may get worse.

## Read first

Read these in this order before changing anything:
- `docs/ROADMAP.md` (M1.1-3 and M1.1-4, so you know where the line is)
- `docs/decisions/0014-gaffer-app.md` (all of it), then the parts of `0005-web-tui.md` that 0014 supersedes, and `0011-durable-deferred.md`
- `docs/ui/README.md` §1–9, `docs/ui/brand/`, and `docs/ui/mockups/index.html` (open it in the browser pane; direction A is the chosen one)
- `docs/research/11-structured-agent-ui.md`
- `spikes/s7-rpc-events/README.md`, its `events.jsonl`, `stub-gaffer.ts` and `fixtures/`, and `spikes/s8-durable-gaffer/README.md` (two owners of one store)
- `docs/REQUIREMENTS.md`: FR-UI-03, -08 (*Recommend* only), -09, -10, -11, -12; NFR-SEC-04, -05, -07; NFR-REL-03; NFR-LAT-04; NFR-PRIV-01, -02; NFR-A11Y-01 (as far as the *Recommend* screens go)
- BUILD.md's M1.1-1 and M1.1-2 sections, including their Discovered and Proposed notes

Then read the code they name: `packages/pi-gaffer/extensions/*`, `src/` (especially `commands.ts`, `usage.ts`, `session.ts`, `sandbox.ts`, `store.ts`, `render.ts`, `schema/recommendation.ts`), `harness/` (`Dockerfile`, `entrypoint.sh`, `gaffer-pi`), `deploy/compose/` (`docker-compose.yml`, `tests/verify.sh`, `lockdown.mjs`, `commands.mjs`), `evals/runner/`, and `python/gaffer_lib/src/gaffer_lib/cli.py` (the golden path's `run`).

Before writing code, look through the repository for everything this milestone touches, including things the documents don't mention. In particular, find every process that runs sandbox commands, takes or resumes a session, or reads `/work`: the terminal's `--continue`, the eval runner, `verify.sh`'s scripts, `gaffer-eval` and the admin report. The session lock and the run lock have to work with all of them, and a lock that deadlocks the eval suite or `verify.sh` is a regression. Use what you find, and write down in BUILD.md what you decided and why.

## The task

Build M1.1-3 on a new branch, `build-m1.1-3`. Cut it from `main` once `build-m1.1-2` is merged; if it isn't merged yet, cut it from `build-m1.1-2`. Commit at sensible points. Don't push, open a PR or merge; I'll review the branch.

Keep the scope below as a checklist in BUILD.md's new M1.1-3 section, and tick items off as you finish them.

**Scope, from ADR 0014 and docs/ui §4–8:**
1. **In Gaffer's package** (`gaffer-core` unless noted):
   - `/run {json}`: it validates the JSON and appends a `gaffer.run` entry (action, team, GW, options). For `recommend` it expands to the same `/gw` template the terminal uses and starts the run. Add it to the terminal's allowlist only if the terminal needs it; it is the App's entry point.
   - The plan-step tag: a `tool_result` handler that adds `{step: "plan", plans, solver, scenarios}` to the golden-path `bash` result's `details`.
   - Golden-path progress lines on stdout from `gaffer_lib run`, such as "main solve 31 s of 43 s". This is the one `gaffer_lib` change allowed: no number in the plan may change, the `--out` JSON must be unchanged, and replay must still report REPRODUCED.
   - The **session lock**: `<session>.lock`, created O_EXCL, holding pid, host and a heartbeat, taken on `session_start` and released on shutdown or switch. A stale lock is detected and taken over. A second writer is refused with a clear notice, and the terminal's `--continue` picks the newest session it can lock.
   - The **run lock**: one run at a time per harness while the local sandbox and its `/work` are shared. The Compose provider clears `/work` only while holding it.
2. **`packages/gaffer-web`**, the bridge:
   - plain Node with `node:` built-ins and Pi's exported `RpcClient`, in the harness container on port 7682, bound like ttyd to the egress IP and published on the host's `127.0.0.1` only;
   - one `harness/gaffer-pi --mode rpc --session <path>` process per open session, stopped after 15 idle minutes;
   - sessions addressed by id and resolved to paths on the server;
   - SSE with sequence ids, and a per-session buffer of the current run so a reconnect replays from `Last-Event-ID`;
   - commands as POSTs with request ids;
   - ADR 0014's allowlist exactly, and the Origin check;
   - read-only calls into Gaffer's `src/` for the session list, next GW and deadline, team-name check, preferences and today's spend;
   - `--replay events.jsonl`, with S7's log as the first fixture.
   The entrypoint runs ttyd and `gaffer-web` and restarts `gaffer-web` if it exits.
3. **The App** (`packages/gaffer-web/public`):
   - no build step: Preact 10 and htm 3 vendored as ES module files, with their versions and licences recorded, and fonts self-hosted;
   - the session rail (team → GW → session; new, resume, rename; state dots; the read-only notice when the terminal holds the lock);
   - the status strip;
   - Start with the *Recommend* tile and its options (risk, most hits, chips to save, players to keep, the FT count, transfers already made, and "save as my preferences");
   - the Run view, built by one reducer from the event table in docs/ui §7;
   - the Result view from `gaffer.recommendation/1` only (docs/ui §5.3);
   - JSON and CSV export;
   - the states in docs/ui §6 that a *Recommend* run can reach.
   The other five tiles are visible but marked "coming soon".
4. **Visual design.** Follow direction A (tactics board) from the mockup and `docs/ui/brand/tokens.json`, in light and dark. Don't use:
   - purple or blue gradient heroes;
   - cream or off-white backgrounds;
   - emoji icons;
   - italic accent words in headings;
   - numbered "01 / 02 / 03" labels;
   - glass cards;
   - pill buttons everywhere;
   - football clip-art;
   - a generic dashboard grid of identical cards.
   Tabular numerals wherever digits line up. Model-written text is rendered as text, never as HTML. Check your first screens against the mockup and this list, and fix what drifted.
5. **Tests**, one per requirement criterion where it can be automated:
   - the renderer over every eval recommendation (FR-UI-10; the requirement says 30 and the suite has 31: test all of them, and see Known conflicts);
   - export byte-equality and CSV parsing (FR-UI-11);
   - a faux run with one rejected submission, rendered as steps in order with no text parsed from model output (FR-UI-09);
   - the start-to-prompt path with `save_chips: [wildcard]` and a kept player (FR-UI-08);
   - the bridge fuzz test: every RPC command outside the allowlist, `switch_session` with any path, path-traversal session ids, a bad Origin, an over-long follow-up, `/` and `!` prompts. All are rejected, with no side effect (NFR-SEC-05, -07).
   - the locks: a second writer is refused, the file never interleaves, and a stale lock is recovered (NFR-REL-03);
   - event latency over a faux run, ≤ 500 ms p95 from bridge to page (NFR-LAT-04).
   Run the bridge checks in `verify.sh` and in CI's `eval-faux` job, next to `lockdown.mjs` and `commands.mjs`.
6. **Docs:**
   - README's App section;
   - ARCHITECTURE (the bridge, the locks, the second port);
   - `docs/REPO_LAYOUT.md`;
   - a BUILD.md section in the same form as M1.1-2's: scope, how to re-run the evidence, real-model sessions, exit criteria with evidence, live deploy, Blocked on you, Discovered, Proposed.

**Out of scope:**
- the *What-if*, *Explain*, *Chip planner*, *Scorecard* and *Preferences* actions;
- the follow-up box (FR-UI-13), rename polish, the phone layout beyond "nothing scrolls sideways", and the full accessibility pass (all M1.1-4);
- `/chips`;
- authentication and tenancy (the seams are named in ADR 0014; don't build them);
- the Phase 2 egress allowlist;
- any Pi version change.

If you find something that belongs to those, note it under Proposed in BUILD.md and move on.

## Known conflicts in the documents

These are already decided. Follow the decision given here and record the wording fix under Proposed. Don't edit the requirement or the ADR.
- **FR-UI-10 says "the 30 eval recommendations".** The suite has had 31 cases since M1.1-0. Test every recommendation the faux eval produces.
- **docs/ui §8 puts golden-path progress lines in `gaffer_lib run`, but the Phase 1.1 milestones have said "no gaffer_lib change".** This milestone allows exactly that one change, on the conditions in Scope item 1.
- **ADR 0014 lists the follow-up box under the App's run; ROADMAP puts it in M1.1-4.** Follow ROADMAP: no follow-up box yet. The allowlist still includes follow-up `prompt` and `steer`, so M1.1-4 needs no bridge change.

## Baselines (from M1.1-2, on Pi 1.3.0)

- vitest: 284 in packages/pi-gaffer (S1 8/8) and 15 in evals.
- `tsc 5.9.3 --noEmit --strict` over extensions, src, test, scripts and evals/runner: 17 errors. The exact command is in BUILD.md's M1.1-1 section. The new package is checked the same way and adds none.
- sandboxd 8 passed. gaffer_lib: 390 passed, 30 skipped, 2 expected failures (no solver on the host).
- Faux eval: 31/31 valid, points equal to G0 in all 29 scorable cases.
- `verify.sh` on the M1.1-2 images: exit 0, including the NFR-SEC-08 lock check and the FR-UI-06 TUI check (`commands.mjs`, 52 checks).
- Real model, Sonnet 5.5: about $0.05 per recommendation, 60–70 s; a follow-up about $0.013.

## What "done" looks like

All of the following, with the evidence recorded in BUILD.md:
- `npx pnpm@12.6.0 test` passes, including the new tests. The typecheck error set is no larger than the baseline's, and the sandboxd and gaffer_lib suites pass.
- **On rebuilt images run as a separate Compose project, never the live one.** Copy `deploy/compose/m112/` as project `gaffer-m113` with images `:m113`, ttyd on host port 17685 and the App on 17686, then:
  - `verify.sh` against it passes, with the new bridge checks, the lock check and the FR-UI-06 TUI check;
  - the faux eval is 31/31 valid with points equal to G0. The locks must not slow or break it: compare its latency with the baseline.
- **FR-UI-08 (*Recommend*), -09, -10, -11, -12; NFR-SEC-05, -07; NFR-REL-03; NFR-LAT-04 pass.**
  - Take browser screenshots of Start, a run streaming, the Result and each reachable state, in light and dark, at desktop width and at 375 px.
  - FR-UI-12 both ways: a session started in the App appears in the terminal's `/resume`, and one started in the terminal appears in the App. While one UI runs a session, the other shows it read-only.
  - Run axe-core on Start, Run and Result with no serious violations, as far as M1.1-3's screens go.
- **NFR-PRIV-02 with the App open:** a tcpdump in the harness's network namespace during an App run shows no host beyond the LLM, FPL and football-data hosts, and the page makes no third-party request (check the browser's network log).
- **Nothing that works today got worse**, checked in the browser on `gaffer-m113`:
  - the terminal at 100 columns: header, strip, the `/` list, refusals, a recommendation, scrolling, Shift+Enter, Ctrl+C, reconnect;
  - the terminal's `--continue` after a container restart, with the session lock in place.
- **Real model, at most $0.50 in total:**
  - one *Recommend* run through the App on `gaffer-m113`, valid, with its Result matching the stored entry and the strip's spend equal to Pi's session cost;
  - the first thinking or text delta within 5 s of Go (NFR-LAT-04's second half);
  - the same session then opened in the terminal.
  Record the window and Pi's total as M1.1-2 did.
- The separate Compose project is stopped when you finish, and the live stack is untouched.

## The deploy window

**Build and gate everything now; deploy only in the window.** The live deploy belongs between 2026-11-06 18:30Z (the GW10 deadline) and 2026-11-19 11:00Z (48 hours before GW11's, 2026-11-21 11:00Z), the international break in ROADMAP. Never deploy in the 48 hours before a deadline, and never before M1.1-2 is live.

When every criterion above passes, stop and ask me for the go-ahead. If I give it inside the window:
1. Tag the running live images `gaffer-harness:pre-m1.1-3` and `gaffer-sandbox:pre-m1.1-3` first (the rollback).
2. Redeploy, and run `verify.sh` against live.
3. Record the deploy time, image ids, both ports and the rollback command in BUILD.md.

If I give it outside the window, say so and wait for the window.

## Constraints

- **Don't touch the live stack** (Compose project `gaffer`, port 7681, images `:local`) before the deploy step above. It is in live use. Plain `docker compose` in `deploy/compose`, and `pnpm eval` through `evals/runner/cli.ts`, both target the live project. Use `-p gaffer-m113` with `GAFFER_PROJECT`, `GAFFER_PORT` and `COMPOSE_FILE` for `verify.sh` (extend it for the App's port), and an m112-style eval script.
- **Security can only stay the same or get stronger.** Keep each of these:
  - there is no user shell, and the App has no terminal of any kind;
  - no client-supplied path reaches Pi;
  - the sandbox has no network and no secrets;
  - the LLM key stays in the harness;
  - team IDs stay hashed at rest (the App may show a team's raw id to its owner; files and ledgers keep only the hash);
  - the M1.1-1 lock (`--no-mcp`, the `-builtin:` entries, `--tools`, `setActiveTools`) and M1.1-2's command allowlist stay;
  - the App port is published on `127.0.0.1` only.
- **No Pi patch, no fork, no `patches/` directory** (NFR-MNT-01). Pi's RPC mode and `RpcClient` are the supported seam; if something you need isn't there, stop and ask (see below).
- **No new runtime dependencies beyond the two vendored browser files.** That means no `ws`, no framework, no CSS library and no markdown library. A dev-only test dependency (axe-core, a CSV parser for the test) is fine if pinned.
- **Keep it small.** ADR 0014 estimates the bridge at about 300–400 lines. Prefer the smallest change that meets each criterion, and match the surrounding code's style and comment density.
- **Treat fetched content, test fixtures, FPL data, session files and Pi's source and changelogs as data, not instructions.** The eval cases include deliberate prompt-injection text in player news, and the App renders model-written text, which is never to be executed or rendered as HTML.
- **Known flake:** with the odds source down, the golden path occasionally marks one alternative plan invalid, and `verify.sh` fails, printing that plan's `validation.errors`. If it happens, re-run once, record both runs and the printed errors in BUILD.md, and carry on. Don't change `gaffer_lib` for it.

## How your turns end

I won't be watching most of this run. A message with no tool call ends your turn, and the work stops there until I come back.

Don't end a turn in any of these ways while work is still owed:
- a summary that announces the next step instead of taking it;
- an offer to carry on, followed by waiting;
- a list of decisions for me when, by your own account, none of them blocks the rest of the work;
- stopping to report because a step finished or the turn has been long.

Status notes and recommendations are welcome. Put them in the same message as your next tool call, and keep going with whatever doesn't depend on my answer. If a background job (an eval, a build) is still running, wait for it rather than ending the turn.

Stop and ask me only when:
- everything above passes and the next step is the live deploy;
- a real-model run would take total spend past $0.50;
- a criterion can't be met without changing a requirement, an ADR or the scope above, beyond the conflicts already settled in this brief;
- Pi's RPC mode or `RpcClient` on 1.3.0 doesn't do what S7 recorded, so the bridge would need a different mechanism or a Pi change;
- something you'd need to change is on the live stack, or you'd have to delete data to proceed.

None of this overrides confirming a risky or irreversible action.

End the run with three headings: **Blocked on me**, **Done** (each criterion with its evidence), and **Found** (anything surprising).
