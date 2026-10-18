# Spike S2 — Does Gaffer run unchanged on Pi 1.3.0?

**Date:** 2026-10-17 · **Pi:** 0.87.1 → 1.3.0 (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`; npm, released 2026-10-15) · **Base:** Gaffer `f884c33` · **Branch:** `spike/s2-pi-1x-upgrade` (commits `000ae2a` bump, `fb269b3` test fix, `28d7800` this spike dir; the scratchpad worktree it ran in is gone, the branch remains) · **Spend:** $0 (faux model only; the s2 stack had an empty API-key secret) · **Result: yes. The only breakage was one test that hard-coded `"0.87.1"`. No extension or `src/` change was needed.** Two non-breaking changes still need action (see Impact).

## Question
Does Gaffer run unchanged on Pi 1.3.0, and if not, what is the minimal change?

## Method
1. A git worktree of Gaffer at `f884c33` on a new branch, `spike/s2-pi-1x-upgrade`.
2. **Before:** `npx pnpm@12.6.0 install --frozen-lockfile && npx pnpm@12.6.0 test` at 0.87.1.
3. Bump `packages/pi-gaffer/package.json` (pi-ai, pi-coding-agent, pi-tui), `evals/package.json` (pi-ai, pi-coding-agent) and `harness/Dockerfile` (`npm install -g …@1.3.0`) to `1.3.0`. Run `npx pnpm@12.6.0 install`, which updates the lockfile, then `npx pnpm@12.6.0 test`.
4. Fix what broke, one commit per fix.
5. TypeScript check of `extensions/`, `src/`, `test/`, `scripts/` and `evals/runner` with `tsc 5.9.3 --noEmit` (strict, `allowImportingTsExtensions`), against 0.87.1 and against 1.3.0. Gaffer has no typecheck in CI, so this looks for type-level breaks the tests can't see.
6. Build both images from the worktree as Compose project **`gaffer-s2`** (`docker-compose.s2.yml`):
   - tags `gaffer-harness:s2` and `gaffer-sandbox:s2`
   - host port 17681 and its own volumes
   - an empty `anthropic_api_key` and a throwaway salt
   - the live `gaffer` project (port 7681) was not touched
7. Against `gaffer-s2`:
   - `run-faux-eval.sh`: `pnpm eval --model faux`'s steps, on the cases already built in `var/evals/cases`
   - `verify-s2.sh`: `deploy/compose/tests/verify.sh` with `-p gaffer-s2` and port 17681 substituted by sed
   - `pi --version` and `pi --help`, and the TUI started under tmux exactly as `harness/gaffer-pi` starts it (screen captured)
   - the same TUI capture from the 0.87.1 image, for comparison
8. `sandbox/tests` with pytest, and `test/s1.test.ts` (S1's eight checks) on its own.
9. `docker compose -p gaffer-s2 down -v`.

Re-run (from a fresh worktree, e.g. under `var/phase11/`; `var/` is the main repo's `var/`, linked read-only for the history cases):
```sh
git -C <gaffer> worktree add <dir> -b spike/s2-pi-1x-upgrade f884c33 && cd <dir>
git apply spikes/s2-pi-1x-upgrade/upgrade.patch   # or check out the branch
ln -s <gaffer>/var var
npx pnpm@12.6.0 install
GAFFER_TEST_ANALYTICS_PYTHON=<gaffer>/node_modules/.cache/gaffer-analytics-venv/bin/python npx pnpm@12.6.0 test
mkdir -p spikes/s2-pi-1x-upgrade/secrets && : > spikes/s2-pi-1x-upgrade/secrets/anthropic_api_key && openssl rand -hex 16 > spikes/s2-pi-1x-upgrade/secrets/gaffer_id_salt
docker compose -f spikes/s2-pi-1x-upgrade/docker-compose.s2.yml -p gaffer-s2 up -d --build
./spikes/s2-pi-1x-upgrade/run-faux-eval.sh      # ~25 min
./spikes/s2-pi-1x-upgrade/verify-s2.sh          # ~4 min; calls the real FPL API and football-data.co.uk
docker compose -p gaffer-s2 exec -T gaffer pi --version
docker compose -p gaffer-s2 -f spikes/s2-pi-1x-upgrade/docker-compose.s2.yml down -v
```

## Result

### Tests
| Suite | 0.87.1 (before) | 1.3.0, bump only | 1.3.0 + fix |
|---|---|---|---|
| `packages/pi-gaffer` vitest | **227/227** | 226/227 | **227/227** |
| `evals` vitest (with `var/evals/cases` present) | **10/10** (8 + 2 skipped without the cases) | 10/10 | **10/10** |
| `test/s1.test.ts` (S1-1 … S1-7, S1-3/8, gotcha) | 8/8 | 8/8 | **8/8** |
| `sandbox/tests` pytest (no Pi dependency) | — | — | 8/8 |
| `tsc --noEmit` errors | 17 | 17 (the same files, lines and codes) | 17 |

The 17 type errors exist on 0.87.1 too: ajv default-import typing, `ExtensionFactory` return types in tests, `JsonObject` casts, and an unexported `Preferences` type in `src/recommend.ts:20`. **None comes from Pi 1.x.**

### What broke, and the fix
| # | What broke | Error | Fix | Pi citation |
|---|---|---|---|---|
| 1 | `test/recommend.test.ts` "a valid submission is recomputed, stored…" | `expected … to match object …: - "pi": "0.87.1" + "pi": "1.3.0"` | Compare with the installed `VERSION` (`import { VERSION } from "@earendil-works/pi-coding-agent"`). The extension already records `VERSION` (`gaffer-recommend/index.ts:91`); only the test hard-coded it. Commit `fb269b3` | `packages/coding-agent/src/config.ts:582` @v1.3.0 |

Commit `000ae2a` holds the version bump (two `package.json` files, `pnpm-lock.yaml`, `harness/Dockerfile`). Lockfile delta: `pi-*` 0.87.1 → 1.3.0; removes `@earendil-works/chord`; adds `pi-codemode`, `pi-mcp` and `quickjs-wasi`; `@anthropic-ai/sdk` 0.124 → 0.129; `openai` 6.40 → 7.19. No new build-script approvals were needed. `upgrade.patch` is `git diff f884c33 fb269b3`.

### Images and stack (`gaffer-s2`)
- Both images built (harness 549 MB, against 952 MB for `gaffer-harness:local`). `npm install -g …@1.3.0` added 118 packages, with no shrinkwrap since 1.0.1.
- `pi install /opt/pi-gaffer` and the `theme: "gaffer"` settings step work unchanged.
- The Dockerfile's `/opt/node_modules` symlinks to `pi-ai` and `typebox` resolve.
- `pi --version` → `1.3.0`.
- **verify-s2.sh passed every check:**
  - NFR-SEC-04: bound to 127.0.0.1 only; ttyd answers 200
  - NFR-SEC-01/02: all isolation checks PASS
  - live `fpl_snapshot` with odds, and the golden path in the sandbox, in 47.2 s
  - FR-DAT-09: the odds source down, golden path in 49 s
  - M4: gate rejection then acceptance, `pi 1.3.0` recorded, `/export-rec`, replay "REPRODUCED, 137 numbers identical", privacy, schema-valid
  - M5: `gaffer admin`, `gaffer-eval`, privacy

### Faux eval (`run-faux-eval.sh`; `results/2026-10-17-faux-s2.summary.json`)
| | 0.87.1 (`evals/results/2026-10-16-faux.summary.json`) | 1.3.0 (gaffer-s2) |
|---|---|---|
| Valid recommendations | 30/30 (30 within two retries) | **30/30** (30 within two retries) |
| Points vs G0 (28 scored) | 1764 vs 1764, diff 0 | **1764 vs 1764, diff 0** |
| Preferences / injection / expectations | 2/2 · 2/2 · 1/1 | **2/2 · 2/2 · 1/1** |
| Schema-invalid recommendations (ajv) | 0 | **0** |
| Latency p50 / p95 / max | 51.7 s / 59.5 s / 59.6 s | **51.7 s / 59.5 s / 59.8 s** |
| Wall time | 24 min 0 s | 24 min 10 s |
| Tool sequence | `fpl_snapshot,bash,bash,submit_recommendation` ×30 | the same ×30 |
| Errors | none | none |

### TUI startup (tmux capture, no API key)
| | 0.87.1 image | 1.3.0 image |
|---|---|---|
| Header | `pi v0.87.1` | Pi logo + `v1.3.0` |
| Skills / prompts / extensions | 6 / 3 / 5 (all Gaffer's) | the same |
| `[Themes] gaffer` section | shown | gone (removed from the banner in 0.99.0); the Gaffer palette is still applied (`#9ccc65`, `#f2c14e` in the capture) |
| Warnings | fd and ripgrep not found (offline); "No models available" | fd and ripgrep not found (offline). No theme, extension or models.json warning |
| Footer | `unknown` model | `claude-sonnet-5-5 • medium` |
| `/mc` autocomplete | — | **`mcp  Manage MCP servers…`**: the built-in MCP extension is loaded. With `"extensions": ["-builtin:mcp","-builtin:codemode","-builtin:tool-search","-builtin:llama.cpp"]` in `settings.json`, `/mcp` is gone and all 5 Gaffer extensions still load (`tui-builtins-disabled-1.3.0.txt`) |

Session files written by 1.3.0 (an eval session):
- header `{"type":"session","version":3,…}`
- entry types `session, model_change, thinking_level_change, custom, message`
- assistant messages now carry `durationMs` and `thinkingLevel`; tool results carry `durationMs`
- the system prompt is a `message` entry with `role: "system"`, `sections` and `toolsAdded`, as on 0.87.1

Gaffer's readers handle all of this unchanged (the `gaffer admin` run in M5 read 31 sessions, 122 calls).

## Impact on the design
1. **Upgrade cost is low.** The minimal change is S2's two commits. Extension points and SDK calls are unchanged at runtime and in type, and S1's eight checks still pass. No core assumption fails.
2. **Two things the tests can't see need deciding at the upgrade.** Both are in `docs/MIGRATION-PI-1X.md`:
   - **`harness/models.json` now shadows Pi's own Sonnet 5.5 entry.** A same-id `models` entry replaces the catalogue entry (`packages/coding-agent/src/core/provider-composer.ts:331-336` @v1.3.0). Keeping the file keeps 0.87.1's request shape (no mid-conversation system messages; cache read priced at $0.20). Deleting it switches on mid-conversation system messages, inline tool changes and mid-conversation effort, which S6 has not tested together with a real model.
   - **The TUI now loads the built-in `mcp`, `codemode`, `tool-search` and `llama.cpp` extensions** (`packages/coding-agent/src/main.ts:578` @v1.3.0). SDK hosts (tests, evals) don't. Disable them in `settings.json` so the shipped TUI matches what is tested.
3. **The image install is no longer pinned past the top-level package**: Pi removed `npm-shrinkwrap.json` in 1.0.1. Pin with a lockfile.
4. The faux eval and the stack checks can't tell 0.87.1 from 1.3.0. The real-model check (cost per session with a follow-up, reasoning display, the effort beta) is the remaining gate, and it belongs to the `models.json` decision, not to the bump.

Files:
- `docker-compose.s2.yml`, `run-faux-eval.sh`, `verify-s2.sh`: the s2 stack and runners
- `results/`: the faux run, `.jsonl` and summary
- `upgrade.patch`
- `tui-*.txt`, `pi-help-1.3.0.txt`: startup captures
