# Gaffer — Proposed repository layout

**Date:** 2026-09-27. This is a monorepo: TypeScript for the Pi package (pnpm workspace) and Python for the library and sandbox (uv).

```
gaffer/
├── packages/
│   ├── pi-gaffer/                 # THE Pi package: extensions + skills + prompts + theme (installed with `pi install`)
│   │   ├── package.json           #   "pi": { extensions, skills, prompts, themes }; pins @earendil-works/pi-coding-agent 0.87.1
│   │   ├── extensions/
│   │   │   ├── gaffer-core/       #   customPrompt + sections, tool allowlist, user_bash block, slash commands, compaction
│   │   │   ├── gaffer-sandbox/    #   read/write/edit/bash overrides → sandboxd; SandboxProvider (compose | ecs)
│   │   │   ├── gaffer-data/       #   fpl_snapshot tool: fetch, cache-bust, TTL, retry+jitter, validate, snapshot
│   │   │   ├── gaffer-recommend/  #   submit_recommendation (validate + recompute + terminate), set_preferences, renderer
│   │   │   └── gaffer-budget/     #   per-session/day cost caps, soft-cap steering
│   │   ├── src/schema/            #   TypeBox schemas: recommendation/1, FPL response subsets, prefs
│   │   ├── skills/                #   SKILL.md directories (see list below)
│   │   ├── prompts/               #   prompt templates: gw.md, whatif.md, explain.md
│   │   ├── themes/gaffer.json     #   TUI theme
│   │   └── test/                  #   vitest: S1 checks as tests, tool unit tests with fauxProvider
│   └── gaffer-web/                # Phase 3 only: RPC bridge + terminal-styled HTML frontend
├── python/
│   └── gaffer_lib/                # Tested analytics library, installed read-only in the sandbox image
│       ├── src/gaffer_lib/        #   rules, derive, strength, minutes, xp, plan, ownership, validate, backtest, cli
│       └── tests/                 #   pytest + Hypothesis; golden files from event/{gw}/live explain[]
├── sandbox/                       # Sandbox image: Dockerfile (python:3.14-slim), sandboxd.py exec service, seccomp notes
├── harness/                       # Harness image: Dockerfile (node + Pi + pi-gaffer + ttyd + tmux), tmux.conf, entrypoint
├── deploy/
│   ├── compose/                   #   docker-compose.yml (gaffer, sandbox; egress + internal networks; secrets)
│   ├── aws/                       #   Phase 2 IaC: ECS service/task defs, ALB+OIDC, EFS, S3, Secrets Manager
│   └── generic/                   #   Caddy + oauth2-proxy compose override for Hetzner/Fly-style hosts
├── evals/
│   ├── cases/                     #   ~30 fixed team×GW cases (snapshot refs + expectations)
│   ├── runner/                    #   SDK-based headless runner (calls bindExtensions), code graders
│   └── results/                   #   dated results JSONL (gitignored except summaries)
├── tools/
│   ├── gaffer-admin/              #   scans /sessions + /data → admin.html
│   └── gaffer-eval/               #   post-data_checked live tracker → /data/ledger/outcomes.jsonl
├── schemas/                       # Exported JSON Schemas (recommendation-1.json) for consumers
├── spikes/                        # Throwaway design spikes (S1 lives here); never imported
├── docs/                          # Research, ADRs, architecture, requirements, roadmap
└── TASKS.md                       # Working checklist
```

## Top-level folders

| Folder | One-line purpose |
|---|---|
| `packages/` | Everything that runs inside Pi, published as one Pi package, plus the phase-3 web bridge |
| `python/` | `gaffer_lib`: the deterministic FPL rules, projections, optimiser wrapper, validator and backtester |
| `sandbox/` | The no-network Python execution environment and its `sandboxd` exec service |
| `harness/` | The Pi + Gaffer + ttyd container image (the "brain") |
| `deploy/` | Compose for local, IaC for AWS, overrides for generic hosts |
| `evals/` | LLM-in-the-loop evaluation cases, runner and results |
| `tools/` | Operator scripts: admin report and live outcome tracker |
| `schemas/` | Published JSON Schemas for machine-readable output |
| `spikes/` | Design spikes that prove or disprove assumptions |
| `docs/` | Design documentation |

## What to build

### Pi package (1)
- **`pi-gaffer`** bundles all extensions, skills, prompts and the theme. Installed with `pi install` in the harness image. **Justification:** Pi's native distribution unit, so Gaffer stays "Pi + a package".

### Pi extensions (5)
| Extension | Tools / commands / hooks | Justification |
|---|---|---|
| `gaffer-core` | `before_agent_start` (customPrompt, `fpl_context`, `user_preferences`), `session_start` (`setActiveTools`), `user_bash` (block), `session_before_compact` (FPL summary); `/team`, `/prefs`, `/export`, `/usage`, `/scorecard` | Turns the coding agent into an FPL agent |
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

### Prompt templates (3)
`/gw` (full recommendation), `/whatif <scenario>`, `/explain <player>`.

### Services and images (2 in MVP, +1 in phase 3)
`harness` (gaffer), `sandbox` (sandboxd); phase 3 adds `gaffer-web`.
