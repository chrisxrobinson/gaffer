# Gaffer

A Fantasy Premier League advisor built as a [Pi](https://pi.dev) package. Pi's agent loop runs unchanged. Everything FPL-specific lives in Gaffer's extensions, skills and theme, a tested Python library, and a sandbox with no network where the model's code runs. You use it through the Pi terminal UI in your browser.

**Status: ROADMAP milestone M4.** Gaffer loads your team from the public FPL API and recommends what to do for the next gameweek: transfers, starting XI and bench, captain and vice-captain, chip, and a plan for the next four gameweeks. Its model (bookmaker odds and a Dixon-Coles team model, expected minutes, component expected points) feeds an optimiser; the language model reads the team news, chooses between the optimiser's plans and explains the choice. Nothing is shown as a recommendation until deterministic code has checked it against FPL's rules and your preferences and recomputed every number in it. Evaluation and the admin report arrive in M5. See [docs/ROADMAP.md](docs/ROADMAP.md) and [BUILD.md](BUILD.md).

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
2. `/gw` for the full recommendation (or just ask "What should I do this week?"). Gaffer takes a snapshot with bookmaker odds, runs its model and optimiser in the sandbox (up to a minute), reads the team news and submits a recommendation. You see it once it has passed validation: a transfers table, the XI and bench, captain and vice, the chip decision with its scenarios, the 4-GW plan, warnings and a summary, with a confidence level computed by rule. It takes a minute or two and has cost about $0.05 a time with the default model. Odds for the next round are only published a few days before a deadline; earlier in the week the plan says "odds unavailable — team strength from Dixon-Coles" and uses its own team model.
3. Other things to ask: "What's my squad and bank?", "Who in my team is injured?", `/whatif I sell Salah for Palmer and take a hit`, `/explain Haaland`. These are answered in text and change nothing.

Commands:

| Command | What it does |
|---|---|
| `/team <id> [--ft N] [--pending "OUT>IN, …"]` | Sets your team, and optionally your free transfers and transfers you've already made |
| `/gw [anything to take into account]` | The full recommendation for the next gameweek |
| `/whatif <scenario>` | Works a scenario through in numbers, without changing the recommendation |
| `/explain <player>` | Explains the projection for one player |
| `/prefs` | Shows your saved preferences. `/prefs risk=safe save_chips=wildcard,freehit keep=<player ids> avoid=<player ids> max_hits=1` changes them; `/prefs clear` resets them |
| `/export-rec` | Writes the latest recommendation's JSON to `/data/exports/<rec_id>.json` and prints the path |

Preferences are saved per team and survive restarts. You can also state them in words ("save my wildcard", "keep Haaland", "no hits") and Gaffer saves them. They constrain the optimiser and are enforced when a recommendation is validated: a saved chip isn't played, a kept player isn't sold. Risk mode (`safe`, `balanced`, `aggressive`) only breaks ties between plans within half a point of the best; Gaffer always maximises expected points.

The exported JSON follows [`schemas/recommendation-1.json`](schemas/recommendation-1.json). To copy an export out of the container: `docker compose exec gaffer cat /data/exports/<rec_id>.json > rec.json`.

`/export` (without `-rec`) is Pi's own command: it exports the whole conversation as HTML. Text after a template command such as `/gw` is parsed like a shell command line, so an apostrophe is taken as a quote mark and dropped ("can't" arrives as "cant").

To stop the stack, run `docker compose down`. Your sessions and snapshots are kept in Docker volumes. To wipe them as well, run `docker compose down -v`.

### Using the terminal UI

- It behaves like the Pi CLI in its fullscreen mode. To see earlier output, scroll with PageUp and PageDown (Home and End jump to the start and to the latest message) or the mouse wheel; a recommendation is usually taller than the window, so its transfers table is a PageUp away. `/` lists commands, Up and Down browse history, Shift+Enter inserts a newline, Escape interrupts a run, and Ctrl+C clears the input (press it twice to exit). To select text with the mouse, hold Shift while dragging.
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
- **Package (`packages/pi-gaffer/`):** five extensions, six skills and three prompt templates. The model sees seven tools: Pi's `read`, `write`, `edit` and `bash` (all running in the sandbox), `fpl_snapshot`, `submit_recommendation` and `set_preferences`.
  - `gaffer-core`: the prompt, the tool allowlist, the `!` shell block, `/team`, `/prefs` and `/export-rec`.
  - `gaffer-sandbox`: Pi's four file and shell tools, routed to the sandbox.
  - `gaffer-data`: the `fpl_snapshot` tool (FPL data, and bookmaker odds with `include: ["odds"]`) and the read-only guard.
  - `gaffer-recommend`: `submit_recommendation`, the gate every recommendation passes (schema, then `gaffer_lib validate` in the sandbox against the snapshot the run used, every number recomputed, at most two retries), the recommendation's rendering, and `set_preferences`.
  - `gaffer-budget`: the cost caps.
  - Skills (`skills/`), loaded by the model when it needs them: `gaffer-workflow`, `team-news`, `transfer-and-captaincy`, `chip-strategy`, `risk-and-ownership`, `fpl-rules-2026-27`. They hold judgement and procedure; the numbers come from code.
  - Prompt templates (`prompts/`): `/gw`, `/whatif`, `/explain`.
- **Sandbox (`sandbox/`):** Python 3.14 with the analytics stack, `gaffer_lib` and [open-fpl-solver](https://github.com/solioanalytics/open-fpl-solver) (pinned commit, HiGHS), driven by `sandboxd`, a small HTTP exec service.
- **Library (`python/gaffer_lib/`):** rules, `derive`, `validate`, the model (`strength`, `minutes`, `xp`), the planner (`plan`), the one-command golden path (`python -m gaffer_lib run --snapshot … --out /work/plan.json`), `recompute` (the second half of the gate: `python -m gaffer_lib validate --request`) and the `backtest`.
- **Snapshots:** each `fpl_snapshot` call writes an immutable, content-hashed snapshot under `/data/snapshots/`. The sandbox can read it, but not write to it.
- **Records:** every recommendation is a `gaffer.recommendation` entry in Pi's session log, next to a `gaffer.validation` entry holding exactly what the gate was given. `/data/ledger/recommendations.jsonl` indexes them, `/data/users/<hash>/prefs.json` holds preferences and `/data/exports/` the exports. Team IDs appear in those files only as an HMAC hash.

The design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), with decisions in [docs/decisions/](docs/decisions/) and requirements in [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

## Develop

You need Node ≥ 22.19 (24 LTS recommended), [uv](https://docs.astral.sh/uv/) for the Python tests, and Docker for the stack. pnpm runs through `npx`, so it doesn't need a global install.

```bash
npx pnpm@12.6.0 install        # workspace dependencies (versions pinned exactly)
npx pnpm@12.6.0 test           # vitest: unit tests, S1 extension checks, extension behaviour
```

The TypeScript tests run the real extensions in a headless Pi session. The model is Pi's scripted `fauxProvider`, the sandbox is a real `sandboxd` on your host's Python, and the FPL API is a local mock. `fpl_snapshot` runs the repo's `gaffer_lib` on Python 3.14, found with `uv python find 3.14` (override with `GAFFER_TEST_PYTHON`). They don't need an API key. The submit-gate tests run `gaffer_lib validate` with the sandbox image's numpy and scipy: the first run builds a small venv with uv under `node_modules/.cache/` (network needed once; override with `GAFFER_TEST_ANALYTICS_PYTHON`). They use a frozen real snapshot and its plan from `python/gaffer_lib/tests/data/`, so they don't need the solver.

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

# after changing the recommendation schema (a test fails if the export is out of date)
node packages/pi-gaffer/scripts/export-schema.ts

# after changing the model: regenerate the plan the gate tests use (needs GAFFER_SOLVER_DIR, as above)
... python -m gaffer_lib run --snapshot python/gaffer_lib/tests/data/snapshot-model --out python/gaffer_lib/tests/data/plan-model.json

# checks against the running stack: port binding, 17 sandbox isolation checks, a live fpl_snapshot
# round trip with odds (scripted model, real FPL API), the golden path in the sandbox within 60 s,
# the same with the odds source down, and a scripted model's recommendation through the submit gate
# (rejected, corrected, stored, exported, replayed). No API key needed.
cd deploy/compose && ./tests/verify.sh

# real-model sessions through the stack (these spend money on your key, about $0.05 each):
./tests/real-run.sh my-run "My FPL team ID is 1. What should I do this week?"
TEAM_ID=1 ./tests/injection.sh     # instructions planted in a player's news must change nothing

# replay a recommendation: rerun the gate on the stored request and compare every number
docker compose exec gaffer node /opt/pi-gaffer/scripts/replay.ts <rec_id>

# validate exported recommendations, or every one in a session file, against the schema with ajv
node packages/pi-gaffer/scripts/check-schema.ts rec.json
```

After changing the extensions, the harness or the sandbox, rebuild the images with `docker compose up -d --build`.

Conventions:
- Pin versions exactly: Pi, base images by digest, npm and PyPI packages, and open-fpl-solver by commit and checksum. Don't fork or patch Pi.
- Third-party datasets (vaastav seasons, odds files) are never committed: scripts fetch them into gitignored `var/`, and only small derived fixtures are in the repo.
- Extensions are loaded by Pi with separate module caches, so they share state through session entries (`gaffer.team`, `gaffer.snapshot`, `gaffer.validation`, `gaffer.recommendation`, `gaffer.budget`), not through module variables.
- FPL arithmetic lives only in `gaffer_lib`. The harness never computes a point or a price: it runs the library in the sandbox (in Python's isolated mode, so nothing in `/work` can shadow it) and checks schemas.
- Pi resolves tool paths against the session's working directory, so the harness runs Pi from `/work` to match the sandbox.
- Source files use erasable TypeScript only (no parameter properties or enums), so plain `node` can run them.

## Troubleshooting

**"Press ⏎ to Reconnect" and nothing happens.** Another browser tab, or an embedded browser pane, is already connected. ttyd allows one client (`--max-clients 1`). Close the other tab and reload. To confirm, run `docker compose logs gaffer | grep max-clients`: a refused connection logs `refuse to serve WS client due to the --max-clients option`. If there are no refusals in the log, check that the container is up with `docker compose ps`.

**"Your credit balance is too low to access the Anthropic API".** The key is valid but its account has no credit. Add credit under Plans & Billing in the Anthropic Console.

**Changed the API key and nothing happened.** The key is read when the container starts. Run `docker compose up -d --force-recreate gaffer`.

**"No API key found for anthropic".** `secrets/anthropic_api_key` is empty, or the container was started before you filled it in. Fill it in and recreate the container, as above.

**"odds unavailable — team strength from Dixon-Coles".** football-data.co.uk is unreachable, or (more often) hasn't published the next round's odds yet: it lists matches only a few days ahead. The plan is still made, from Gaffer's own team model. Ask again nearer the deadline for a plan that uses the market's odds.

**The FPL API is down or "the game is being updated".** Gaffer serves the last good snapshot marked stale, and says so, and the recommendation's confidence is low. Inside the last hour before a deadline it recommends no transfers on stale data, only a line-up from your current squad, and tells you why.

**"GAFFER · no recommendation".** The model's plan failed validation three times, so nothing was shown: Gaffer never presents a plan that breaks FPL's rules or whose numbers it couldn't recompute. The errors listed say what went wrong. Ask again; if it keeps happening, the errors are the bug report.

**The free-transfer count is wrong.** FPL doesn't publish it, so Gaffer derives it and every recommendation carries "Derived FT count — confirm in app". Correct it with `/team <id> --ft N` and ask again.

**A warning says a figure "was wrong and has been corrected".** The model quoted a number that differed from the recomputed one by more than half a point. The number you see is the recomputed one.
