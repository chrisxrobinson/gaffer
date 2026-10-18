# Gaffer — Proposed repository layout

**Date:** 2026-09-27, updated 2026-10-18 for Phase 1.1. This is a monorepo: TypeScript for the Pi package (pnpm workspace) and Python for the library and sandbox (uv).

```
gaffer/
├── packages/
│   ├── pi-gaffer/                 # THE Pi package: extensions + skills + prompts + theme (installed with `pi install`)
│   │   ├── package.json           #   "pi": { extensions, skills, prompts, themes }; pins @earendil-works/pi-coding-agent exactly (1.3.0 since M1.1-1, ADR 0009)
│   │   ├── extensions/
│   │   │   ├── gaffer-core/       #   customPrompt + sections, tool allowlist, user_bash block, slash commands, compaction;
│   │   │   │                      #   1.1: header/footer/title, command allowlist (autocomplete + editor wrapper), session and run locks, /run, /help
│   │   │   ├── gaffer-sandbox/    #   read/write/edit/bash overrides → sandboxd; SandboxProvider (compose | ecs)
│   │   │   ├── gaffer-data/       #   fpl_snapshot tool: fetch, cache-bust, TTL, retry+jitter, validate, snapshot
│   │   │   ├── gaffer-recommend/  #   submit_recommendation (validate + recompute + terminate), set_preferences, renderer
│   │   │   └── gaffer-budget/     #   per-session/day cost caps, soft-cap steering
│   │   ├── src/schema/            #   TypeBox schemas: recommendation/1 (with the submission and prefs), FPL response subsets
│   │   ├── scripts/               #   export-schema.ts (→ schemas/recommendation-1.json), replay.ts (rec_id → rerun the gate, NFR-OBS-01)
│   │   ├── skills/                #   SKILL.md directories (see list below)
│   │   ├── prompts/               #   prompt templates: gw.md, whatif.md, explain.md; 1.1 adds chips.md (Chip planner)
│   │   ├── themes/                #   gaffer-dark.json (today's gaffer.json) and gaffer-light.json (1.1, ADR 0013)
│   │   └── test/                  #   vitest: S1 checks as tests, tool unit tests with fauxProvider
│   └── gaffer-web/                # Phase 1.1: the Gaffer App (ADR 0014)
│       ├── server/                #   bridge: node: built-ins + Pi's RpcClient; RPC process per open session; command allowlist; SSE + POST; --replay
│       ├── public/                #   no-build frontend: Preact + htm vendored, the App's modules and CSS (tokens from docs/ui/brand), self-hosted fonts
│       └── test/                  #   allowlist fuzz (NFR-SEC-05/07), renderer over the 30 eval recommendations (FR-UI-10), replay fixtures (S7's log)
├── python/
│   └── gaffer_lib/                # Tested analytics library, installed read-only in the sandbox image
│       ├── src/gaffer_lib/        #   rules, derive, strength, minutes, xp, plan, ownership, validate, backtest, cli
│       └── tests/                 #   pytest + Hypothesis; golden files from event/{gw}/live explain[]
├── sandbox/                       # Sandbox image: Dockerfile (python:3.14-slim), sandboxd.py exec service, seccomp/ (vendored Moby default profile), tests/
├── harness/                       # Harness image: Dockerfile (node + Pi + pi-gaffer + ttyd + tmux + gaffer-web), tmux.conf, entrypoint (ttyd and gaffer-web), gaffer-pi launcher (TUI and --mode rpc), ttyd page script (keys, OSC 52 copy, viewport);
│                                  #   1.1: pi/package.json + package-lock.json (the image's whole Pi tree pinned, ADR 0009), settings.json and keybindings.json (ADRs 0012, 0013; M1.1-1); models.json only for models the catalogue lacks (none today)
├── deploy/
│   ├── compose/                   #   docker-compose.yml (gaffer, sandbox; egress + internal networks; secrets), init-secrets.sh, tests/ (stack checks)
│   ├── aws/                       #   Phase 2 IaC: ECS service/task defs, ALB+OIDC, EFS, S3, Secrets Manager
│   └── generic/                   #   Caddy + oauth2-proxy compose override for Hetzner/Fly-style hosts
├── evals/                         # A workspace package: `pnpm eval` (runner/cli.ts)
│   ├── cases/                     #   30 fixed team×GW cases (*.json); data/: id-free fixtures of Gaffer's own 2026/27 snapshots
│   ├── build/                     #   extract_live.py (snapshots → cases/data), build_cases.py (cases → gitignored var/evals)
│   ├── runner/                    #   SDK-based headless runner (calls bindExtensions), stand-in FPL API, faux policy, code graders
│   └── results/                   #   dated results JSONL (gitignored except summaries)
├── tools/                         # Operator scripts, plain node, also in the harness image (/opt/tools)
│   ├── gaffer-admin/              #   scans /sessions + /data → admin.html
│   └── gaffer-eval/               #   post-data_checked live tracker → /data/ledger/outcomes.jsonl
├── .github/workflows/ci.yml       # CI: vitest (with the S1 checks), the Python suites, the stack and `pnpm eval --model faux`
├── renovate.json                  # Pi upgrades as one gated pull request (NFR-MNT-02)
├── schemas/                       # Exported JSON Schemas (recommendation-1.json) for consumers
├── spikes/                        # Throwaway design spikes, never imported: S1 (Phase 0), S2–S10 (Phase 1.1: Pi 1.3 upgrade, MCP lock, codemode guards,
│                                  #   TUI branding, prompt cache, RPC events, Durable, web terminal, real-model checks)
├── docs/                          # Research, ADRs, architecture, requirements, roadmap, MIGRATION-PI-1X;
│   └── ui/                        #   UI spec for both UIs, brand (mark, ASCII wordmark, tokens), clickable mockups (1.1)
├── TASKS.md                       # Phase 0 checklist
├── TASKS-1.1.md                   # Phase 1.1 checklist
└── BUILD.md                       # Build checklist and exit-criteria evidence, per milestone
```

## Top-level folders

| Folder | One-line purpose |
|---|---|
| `packages/` | Everything that runs inside Pi, published as one Pi package, plus `gaffer-web`, the Gaffer App's bridge and frontend (Phase 1.1) |
| `python/` | `gaffer_lib`: the deterministic FPL rules, projections, optimiser wrapper, validator and backtester |
| `sandbox/` | The no-network Python execution environment and its `sandboxd` exec service |
| `harness/` | The Pi + Gaffer + ttyd + `gaffer-web` container image (the "brain") |
| `deploy/` | Compose for local, IaC for AWS, overrides for generic hosts |
| `evals/` | LLM-in-the-loop evaluation cases, runner and results |
| `tools/` | Operator scripts: admin report and live outcome tracker |
| `schemas/` | Published JSON Schemas for machine-readable output |
| `spikes/` | Design spikes that prove or disprove assumptions |
| `docs/` | Design documentation, including the UI spec and mockups (`docs/ui`) |

## What to build

### Pi package (1)
- **`pi-gaffer`** bundles all extensions, skills, prompts and the theme. Installed with `pi install` in the harness image. **Justification:** Pi's native distribution unit, so Gaffer stays "Pi + a package".

### Pi extensions (5)
| Extension | Tools / commands / hooks | Justification |
|---|---|---|
| `gaffer-core` | `before_agent_start` (customPrompt, `fpl_context`, `user_preferences`), `session_start` (`setActiveTools`; header, footer, title, editor; session lock), `user_bash` (block), `input` and run start/settle (run lock), `session_before_compact` (FPL summary); `/team`, `/prefs`, `/export-rec`, `/usage`, `/scorecard`, `/help`, `/run` | Turns the coding agent into an FPL agent, with Gaffer's own identity and command surface |
| `gaffer-sandbox` | Overrides `read`, `write`, `edit`, `bash`; `SandboxProvider` | Keeps generated code away from credentials |
| `gaffer-data` | Tool `fpl_snapshot`; `tool_call` guard for read-only paths | The sandbox has no network; freshness and validation must be deterministic |
| `gaffer-recommend` | Tools `submit_recommendation` (terminating) and `set_preferences`; result renderer | Legal, recomputed, machine-readable output; preferences outlive sessions |
| `gaffer-budget` | `turn_end`, `before_agent_start` cost checks | Hard cost caps |

### Custom tools (3) + Pi built-ins (4, retargeted)
`fpl_snapshot`, `submit_recommendation`, `set_preferences`, plus `read`, `write`, `edit` and `bash` running in the sandbox.

### Skills (6)
| Skill | Covers |
|---|---|
| `fpl-rules-2026-27` | Squad, transfer, FT, chip (8 chips across halves, GW19 expiry) and scoring rules (DefCon, BPS changes) in words, pointing to `gaffer_lib.rules` |
| `gaffer-workflow` | The golden path (`snapshot → gaffer_lib run → judge → submit`), reading its output, when to go off-path |
| `transfer-and-captaincy` | Hits vs rolling, the 5-FT bank, deviating from the top plan, captain variance and vice |
| `chip-strategy` | Chip set and windows, BGW/DGW heuristics, reading `chip_scenarios`, sequencing |
| `risk-and-ownership` | Max-EV default, risk modes, EO tie-breaks, mini-league vs overall |
| `team-news` | Turning `news`, `chance_of_playing_*` and `scout_risks` into structured `xmins_overrides`; treating fetched text as data |

### Prompt templates (4)
`/gw` (full recommendation), `/whatif <scenario>`, `/explain <player>`; Phase 1.1 adds `/chips` for the App's Chip planner (also usable in the terminal).

### Services and images (2)
`harness` (gaffer: ttyd and, from Phase 1.1, the `gaffer-web` process in the same container), `sandbox` (sandboxd). No new service: the App's bridge shares the harness's image, key, volumes and sandbox network (ADR 0014). Justification for `gaffer-web`: the Gaffer App needs a server that owns its Pi processes and allowlists their commands; ttyd can't do either.
