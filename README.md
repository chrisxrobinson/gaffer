# Gaffer

A Fantasy Premier League advisor built as a [Pi](https://pi.dev) package. Pi's agent loop runs unchanged. Everything FPL-specific lives in Gaffer's extensions, skills and theme, a tested Python library, and a sandbox with no network where the model's code runs. You use it through the Pi terminal UI in your browser.

**Status: ROADMAP milestone M1.** Gaffer can load your team from the public FPL API and answer questions about it: squad, bank, chips, deadline, player news. Transfer, captain and chip recommendations arrive in M2–M4. See [docs/ROADMAP.md](docs/ROADMAP.md) and [BUILD.md](BUILD.md).

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
2. Ask something, for example "What's my squad and bank?" or "Who in my team is injured?".

To stop the stack, run `docker compose down`. Your sessions and snapshots are kept in Docker volumes. To wipe them as well, run `docker compose down -v`.

### Using the terminal UI

- It behaves like the Pi CLI. `/` lists commands, Up and Down browse history, Shift+Enter inserts a newline, Escape interrupts a run, and Ctrl+C clears the input (press it twice to exit).
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
                                   │  fpl_snapshot ──> fantasy.premierleague.com (GET only)
                                   │  bash/read/write/edit ──HTTP──> sandboxd  (sandbox container:
                                   │                                  no network, no secrets,
                                   └─ /sessions, /data (snapshots) ──ro──>  non-root, read-only root)
```

- **Harness (`harness/`):** Node 24, Pi 0.87.1 from npm, the `pi-gaffer` package installed with `pi install`, and ttyd with tmux.
- **Package (`packages/pi-gaffer/`):** four extensions.
  - `gaffer-core`: the prompt, the tool allowlist, the `!` shell block and `/team`.
  - `gaffer-sandbox`: Pi's four file and shell tools, routed to the sandbox.
  - `gaffer-data`: the `fpl_snapshot` tool and the read-only guard.
  - `gaffer-budget`: the cost caps.
- **Sandbox (`sandbox/`):** Python 3.14 with the analytics stack and `gaffer_lib`, driven by `sandboxd`, a small HTTP exec service.
- **Snapshots:** each `fpl_snapshot` call writes an immutable, content-hashed snapshot under `/data/snapshots/`. The sandbox can read it, but not write to it.

The design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), with decisions in [docs/decisions/](docs/decisions/) and requirements in [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

## Develop

You need Node ≥ 22.19 (24 LTS recommended), [uv](https://docs.astral.sh/uv/) for the Python tests, and Docker for the stack. pnpm runs through `npx`, so it doesn't need a global install.

```bash
npx pnpm@12.6.0 install        # workspace dependencies (versions pinned exactly)
npx pnpm@12.6.0 test           # vitest: unit tests, S1 extension checks, extension behaviour
```

The TypeScript tests run the real extensions in a headless Pi session. The model is Pi's scripted `fauxProvider`, the sandbox is a real `sandboxd` on your host's Python, and the FPL API is a local mock. They don't need an API key or network access.

```bash
# sandboxd protocol tests
uv run --no-project --with pytest==9.1.1 pytest sandbox/tests

# gaffer_lib (Python 3.14)
PYTHONPATH=python/gaffer_lib/src uv run --no-project --python 3.14 --with pytest==9.1.1 pytest python/gaffer_lib/tests

# checks against the running stack: port binding, 17 sandbox isolation checks,
# and a live fpl_snapshot round trip (scripted model, real FPL API)
cd deploy/compose && ./tests/verify.sh
```

After changing the extensions, the harness or the sandbox, rebuild the images with `docker compose up -d --build`.

Conventions:
- Pin versions exactly: Pi, base images by digest, and npm and PyPI packages. Don't fork or patch Pi.
- Extensions are loaded by Pi with separate module caches, so they share state through session entries (`gaffer.team`, `gaffer.snapshot`, `gaffer.budget`), not through module variables.
- Pi resolves tool paths against the session's working directory, so the harness runs Pi from `/work` to match the sandbox.
- Source files use erasable TypeScript only (no parameter properties or enums), so plain `node` can run them.

## Troubleshooting

**"Press ⏎ to Reconnect" and nothing happens.** Another browser tab, or an embedded browser pane, is already connected. ttyd allows one client (`--max-clients 1`). Close the other tab and reload. To confirm, run `docker compose logs gaffer | grep max-clients`: a refused connection logs `refuse to serve WS client due to the --max-clients option`. If there are no refusals in the log, check that the container is up with `docker compose ps`.

**"Your credit balance is too low to access the Anthropic API".** The key is valid but its account has no credit. Add credit under Plans & Billing in the Anthropic Console.

**Changed the API key and nothing happened.** The key is read when the container starts. Run `docker compose up -d --force-recreate gaffer`.

**"No API key found for anthropic".** `secrets/anthropic_api_key` is empty, or the container was started before you filled it in. Fill it in and recreate the container, as above.

**The FPL API is down or "the game is being updated".** Gaffer serves the last good snapshot marked stale, and says so. Near a deadline, it won't present transfers as final while data is stale.
