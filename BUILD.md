# Gaffer — M1 build checklist

Branch `build-m1-claude`. Scope and exit criteria from [ROADMAP M1](docs/ROADMAP.md#m1--skeleton-pi--gaffer-sandbox-data-target-before-gw7-deadline). Evidence is recorded inline as each item is verified.

## Scope
- [ ] Repo scaffold (REPO_LAYOUT): pnpm workspace, `packages/pi-gaffer`, `python/gaffer_lib` skeleton, `sandbox/`, `harness/`, `deploy/compose/`
- [ ] `gaffer-core`: prompt `customPrompt` + sections (`fpl_context`, `user_preferences`), tool allowlist (`setActiveTools`), `user_bash` block, `/team`
- [ ] `gaffer-sandbox`: `bash`/`read`/`write`/`edit` overrides → `sandboxd`; `SandboxProvider` (`compose`); lazy provision, idle release; skills read locally
- [ ] `gaffer-budget`: per-session hard cap (`turn_end` → abort + `gaffer.budget`), daily cap, 40-turn cap
- [ ] `sandboxd` + hardened sandbox image
- [ ] `gaffer-data` / `fpl_snapshot`: fetch, cache-bust, TTL, retry+jitter, rate limit, validation, snapshot writing, stale fallback, read-only guard
- [ ] Gaffer theme
- [ ] ttyd + tmux in the harness image
- [ ] Compose file (egress + internal network, volumes, secrets)
- [ ] S1 checks as automated tests (`packages/pi-gaffer/test`)

## Exit criteria
| ID | Status | Evidence |
|---|---|---|
| FR-INP-01 | | |
| FR-DAT-01 | | |
| FR-DAT-02 | | |
| FR-DAT-03 | | |
| FR-DAT-04 | | |
| FR-DAT-05 | | |
| FR-DAT-06 | | |
| FR-DAT-07 | | |
| FR-UI-01 | | |
| FR-UI-02 | | |
| FR-UI-03 | | |
| FR-ACC-01 | | |
| FR-BUD-01 | | |
| NFR-SEC-01 | | |
| NFR-SEC-02 | | |
| NFR-SEC-04 | | |
| NFR-PRIV-02 | | |
| NFR-MNT-01 | | |
| NFR-COST-03 | | |
| "What's my squad and bank?" | | |

## Discovered

## Proposed (not built; outside M1 docs)
