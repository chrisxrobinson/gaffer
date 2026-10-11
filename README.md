# Gaffer

A Fantasy Premier League advisor built as a [Pi](https://pi.dev) package. Pi's agent loop runs unchanged. Everything FPL-specific lives in Gaffer's extensions, skills and theme, a tested Python library, and a sandbox with no network where the model's code runs. You use it through the Pi terminal UI in your browser.

**Status: ROADMAP milestone M3.** Gaffer loads your team from the public FPL API and answers questions about it: squad, bank, chips, deadline, player news, and, derived by its rules engine, your free transfers and selling prices. It can now also project points and plan: its model (bookmaker odds and a Dixon-Coles team model, expected minutes, component expected points) feeds an optimiser that proposes transfers, XI, captain and a 4-GW plan, with chip scenarios, and every plan is checked against the rules. The final, validated recommendation format, preferences and skills arrive in M4. See [docs/ROADMAP.md](docs/ROADMAP.md) and [BUILD.md](BUILD.md).

Gaffer is read-only. It never logs in to FPL and never changes your team.

## Run it

You need Docker with Compose v2 (Docker Desktop on macOS, or Docker Engine on Linux) and an Anthropic API key with credit.

```bash
cd deploy/compose
./init-secrets.sh
```

Paste your API key into `deploy/compose/secrets/anthropic_api_key`. The script also creates a random `gaffer_id_salt`, which is used to hash team IDs before they are stored. The `secrets/` directory is gitignored. Then start the stack:

```bash
docker compose up -d --build
```

Open **http://127.0.0.1:7681**. You get the Pi terminal UI with Gaffer loaded. Then:

1. `/team <your FPL team ID>`. The ID is the number in the URL of your Points page on the FPL site, for example `/team 1234567`.
   FPL doesn't publish free transfers or transfers you've made for the next GW, so Gaffer derives the free-transfer count and shows it as assumed. If it's wrong, or you've already made transfers, say so: `/team 1234567 --ft 2 --pending "Salah>Palmer, Saka>Foden"` (names or player IDs, OUT>IN). Each `/team` replaces the last, so restate options you want to keep.
2. Ask something, for example "What's my squad and bank?", "Who in my team is injured?" or "What should I do this week?". For planning questions Gaffer takes a snapshot with bookmaker odds and runs its model and optimiser in the sandbox (up to a minute). Odds for the next round are only published a few days before a deadline; earlier in the week the plan says "odds unavailable — team strength from Dixon-Coles" and uses its own team model.

To stop the stack, run `docker compose down`. Your sessions and snapshots are kept in Docker volumes. To wipe them as well, run `docker compose down -v`.

### Using the terminal UI

- It behaves like the Pi CLI. Scroll with the mouse wheel or scrollbar to see earlier output (up to 10,000 lines per browser connection; after a reconnect, the history before it is shown again only when Pi redraws, e.g. on resume). `/` lists commands, Up and Down browse history, Shift+Enter inserts a newline, Escape interrupts a run, and Ctrl+C clears the input (press it twice to exit).
- `!` shell commands are disabled, because the harness container holds the API key. Gaffer's own code runs in the sandbox.
- Closing the tab doesn't stop anything: reopen the URL and you're back in the same session, including a run that was in progress. If the container restarts, Pi resumes the most recent session.
- **Only one browser tab can be connected at a time.** A second tab shows "Press ⏎ to Reconnect" and won't connect until the first tab is closed. See [Troubleshooting](#troubleshooting).

### Configuration

Set these in your shell or in a `deploy/compose/.env` file, then run `docker compose up -d`.

| Variable | Default | Meaning |
|---|---|---|
| `GAFFER_PROVIDER` | `anthropic` | Pi provider |
| `GAFFER_MODEL` | `claude-sonnet-5-5` | Model ID. Models newer than Pi 0.87.1's catalogue are declared in [`harness/models.json`](harness/models.json) |
| `GAFFER_THINKING` | `medium` | Pi thinking level |
| `GAFFER_BUDGET_HARD` | `1.50` | USD per session. The run is stopped when it crosses this |
| `GAFFER_BUDGET_DAILY` | `5` | USD per UTC day, across sessions. New prompts are refused once it's reached |
| `GAFFER_MAX_TURNS` | `40` | Turns per run |

To use another provider, set `GAFFER_PROVIDER` and `GAFFER_MODEL`, and add that provider's key to the harness environment. `docker-compose.yml` only wires up the Anthropic key.

On a Linux host with gVisor installed, you can run the sandbox under `runsc`:

```bash
docker compose -f docker-compose.yml -f docker-compose.gvisor.yml up -d
```

## How it fits together

```
browser ──ws──> ttyd ─> tmux ─> pi + pi-gaffer          (gaffer container: LLM key, FPL access)
                                   │  fpl_snapshot ──> fantasy.premierleague.com, football-data.co.uk (GET only)
                                   │  bash/read/write/edit ──HTTP──> sandboxd  (sandbox container:
                                   │                                  no network, no secrets,
                                   └─ /sessions, /data (snapshots) ──ro──>  non-root, read-only root)
```

- **Harness (`harness/`):** Node 24, Pi 0.87.1 from npm, the `pi-gaffer` package installed with `pi install`, and ttyd with tmux.
- **Package (`packages/pi-gaffer/`):** four extensions.
  - `gaffer-core`: the prompt, the tool allowlist, the `!` shell block and `/team`.
  - `gaffer-sandbox`: Pi's four file and shell tools, routed to the sandbox.
  - `gaffer-data`: the `fpl_snapshot` tool (FPL data, and bookmaker odds with `include: ["odds"]`) and the read-only guard.
  - `gaffer-budget`: the cost caps.
- **Sandbox (`sandbox/`):** Python 3.14 with the analytics stack, `gaffer_lib` and [open-fpl-solver](https://github.com/solioanalytics/open-fpl-solver) (pinned commit, HiGHS), driven by `sandboxd`, a small HTTP exec service.
- **Library (`python/gaffer_lib/`):** rules, `derive`, `validate`, and from M3 the model (`strength`, `minutes`, `xp`), the planner (`plan`), the one-command golden path (`python -m gaffer_lib run --snapshot … --out /work/plan.json`) and the `backtest`.
- **Snapshots:** each `fpl_snapshot` call writes an immutable, content-hashed snapshot under `/data/snapshots/`. The sandbox can read it, but not write to it.

The design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), with decisions in [docs/decisions/](docs/decisions/) and requirements in [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

## Develop

You need Node ≥ 22.19 (24 LTS recommended), [uv](https://docs.astral.sh/uv/) for the Python tests, and Docker for the stack. pnpm runs through `npx`, so it doesn't need a global install.

```bash
npx pnpm@12.6.0 install        # workspace dependencies (versions pinned exactly)
npx pnpm@12.6.0 test           # vitest: unit tests, S1 extension checks, extension behaviour
```

The TypeScript tests run the real extensions in a headless Pi session. The model is Pi's scripted `fauxProvider`, the sandbox is a real `sandboxd` on your host's Python, and the FPL API is a local mock. `fpl_snapshot` runs the repo's `gaffer_lib` on Python 3.14, found with `uv python find 3.14` (override with `GAFFER_TEST_PYTHON`). They don't need an API key or network access.

```bash
# sandboxd protocol tests
uv run --no-project --with pytest==9.1.1 pytest sandbox/tests

# gaffer_lib (Python 3.14): rules, derive, validate, the model, the planner and the backtest.
# The planner tests need open-fpl-solver at the pinned commit; without GAFFER_SOLVER_DIR they are skipped.
git clone https://github.com/solioanalytics/open-fpl-solver /tmp/open-fpl-solver
git -C /tmp/open-fpl-solver checkout ec65f5e2b2be34441cb4b2a9efafea1ec0fe3b79
PYTHONPATH=python/gaffer_lib/src GAFFER_SOLVER_DIR=/tmp/open-fpl-solver uv run --no-project --python 3.14 \
  --with pytest==9.1.1 --with hypothesis==6.168.3 --with numpy==2.5.3 --with pandas==3.0.6 --with scipy==1.18.1 \
  --with highspy==1.15.1 --with requests==2.34.2 --with fuzzywuzzy==0.18.0 pytest python/gaffer_lib/tests

# rebuild the golden fixtures from the live API and vaastav (about 300 polite requests);
# `... build_fixtures.py model` rebuilds only the frozen snapshot the model tests use
uv run --no-project --python 3.14 python python/gaffer_lib/tests/data/build_fixtures.py

# backtest (FR-EVL-01): fetch the history once into gitignored var/history, then replay three seasons
# (about 25 minutes; add the same PYTHONPATH, GAFFER_SOLVER_DIR and --with flags as above)
uv run --no-project --python 3.14 python tools/fetch_history.py
... python -m gaffer_lib backtest --seasons 2023-24,2024-25,2025-26 --out backtest.json

# checks against the running stack: port binding, 17 sandbox isolation checks, a live fpl_snapshot
# round trip with odds (scripted model, real FPL API), the golden path in the sandbox within 60 s,
# and the same with the odds source down
cd deploy/compose && ./tests/verify.sh
```

After changing the extensions, the harness or the sandbox, rebuild the images with `docker compose up -d --build`.

Conventions:
- Pin versions exactly: Pi, base images by digest, npm and PyPI packages, and open-fpl-solver by commit and checksum. Don't fork or patch Pi.
- Third-party datasets (vaastav seasons, odds files) are never committed: scripts fetch them into gitignored `var/`, and only small derived fixtures are in the repo.
- Extensions are loaded by Pi with separate module caches, so they share state through session entries (`gaffer.team`, `gaffer.snapshot`, `gaffer.budget`), not through module variables.
- Pi resolves tool paths against the session's working directory, so the harness runs Pi from `/work` to match the sandbox.
- Source files use erasable TypeScript only (no parameter properties or enums), so plain `node` can run them.

## Troubleshooting

**"Press ⏎ to Reconnect" and nothing happens.** Another browser tab, or an embedded browser pane, is already connected. ttyd allows one client (`--max-clients 1`). Close the other tab and reload. To confirm, run `docker compose logs gaffer | grep max-clients`: a refused connection logs `refuse to serve WS client due to the --max-clients option`. If there are no refusals in the log, check that the container is up with `docker compose ps`.

**"Your credit balance is too low to access the Anthropic API".** The key is valid but its account has no credit. Add credit under Plans & Billing in the Anthropic Console.

**Changed the API key and nothing happened.** The key is read when the container starts. Run `docker compose up -d --force-recreate gaffer`.

**"No API key found for anthropic".** `secrets/anthropic_api_key` is empty, or the container was started before you filled it in. Fill it in and recreate the container, as above.

**"odds unavailable — team strength from Dixon-Coles".** football-data.co.uk is unreachable, or (more often) hasn't published the next round's odds yet: it lists matches only a few days ahead. The plan is still made, from Gaffer's own team model. Ask again nearer the deadline for a plan that uses the market's odds.

**The FPL API is down or "the game is being updated".** Gaffer serves the last good snapshot marked stale, and says so. Near a deadline, it won't present transfers as final while data is stale.
