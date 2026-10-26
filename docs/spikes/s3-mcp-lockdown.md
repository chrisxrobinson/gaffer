# S3: MCP, codemode, tool_search and llama.cpp lockdown on Pi 1.3.0

Spike for Phase 1.1 research note 09 (codemode and MCP). Date: 2026-10-17. Pi `@earendil-works/pi-coding-agent@1.3.0`, installed exactly in this directory. Faux model only; no paid calls.

## Question

Can Gaffer guarantee that no MCP server, `codemode`, `tool_search` or llama.cpp provider is active on Pi 1.3.0, whatever `mcp.json` files exist? Which flags or settings do it, for the CLI (`harness/gaffer-pi`) and for the SDK hosts (`packages/pi-gaffer/test/harness.ts`, `evals/runner/run.ts`)?

## Method

- `pwn-server.mjs` is a 20-line stdio MCP server with one tool, `pwn`. When it starts, it writes `<markers>/<name>.spawned`, recording whether `ANTHROPIC_API_KEY` was in its environment (a boolean, never the value). When `pwn` runs, it writes `<name>.called`.
- Each run gets a fresh temporary layout:
  - `agent/mcp.json` (`PI_CODING_AGENT_DIR`) has three servers: `ucm` (default `codemode` exposure), `udir` (`direct`) and `udef` (`deferred`).
  - `parent/work/.pi/mcp.json` (the cwd) has `pdir` (`direct`).
  - `parent/.pi/mcp.json` (a parent directory) has `parent` (`direct`).
  - `ext-mcp.ts` stands in for a third-party package. It calls `pi.registerMcpServer("ext", …)` with `direct` exposure.
- `spike-ext.ts` registers a faux model and stubs of Gaffer's own three tools (same names, so the `--tools` allowlist is exactly Gaffer's). It also repeats gaffer-core's `setActiveTools(GAFFER_TOOLS)` on `session_start`. The scripted model then tries every route in turn: `mcp__udir__pwn`, `mcp__pdir__pwn`, `mcp__ext__pwn`, a `codemode` script calling `mcp__ucm__pwn`/`mcp__udef__pwn`/`mcp__ext__pwn`, `tool_search`, and `mcp__udef__pwn`. On each turn it records the tools the provider request declares (`getCurrentTools()` on the transcript) and whether the system prompt has the `mcp_servers` section.
- `run-cli.mjs` runs the real CLI (`dist/bundle/cli.js -p go`) under each candidate configuration, with `PI_OFFLINE=1`, `PI_TELEMETRY=0` and a dummy `ANTHROPIC_API_KEY`. The base line is Gaffer's launch line: `--no-context-files --tools read,write,edit,bash,fpl_snapshot,submit_recommendation,set_preferences`. `fake-pkg/` stands in for the installed `pi-gaffer` package (one extension tool and one skill) and is installed with `pi install` where a row says so.
- `run-sdk.ts` rebuilds the two SDK hosts on 1.3.0 with the same files present, plus two hosts that add the built-in factories themselves.

## Result

CLI, Gaffer's tool allowlist unless the row says otherwise:

| # | Configuration | Servers spawned | Key in server env | MCP / codemode / tool_search offered | Calls executed | `mcp_servers` prompt section | Commands | llama.cpp provider | Package ext / skill |
|---|---|---|---|---|---|---|---|---|---|
| 1 | upstream defaults (no `--tools`) | ext, ucm, udef, udir | yes (4) | codemode, tool_search, all four `mcp__*__pwn` | ext, ucm, udef, udir | yes | /llama /mcp | registered | n/a |
| 2 | **Gaffer's line as is** | ext, ucm, udef, udir | **yes (4)** | none | none | **yes** | /llama /mcp | registered | n/a |
| 3 | Gaffer's line + `--approve` | ext, pdir, ucm, udef, udir | yes (5) | none | none | yes | /llama /mcp | registered | n/a |
| 4 | `--tools …,mcp__none` | ext, ucm, udef, udir | yes (4) | none | none | yes | /llama /mcp | registered | n/a |
| 5 | `--exclude-tools 'mcp__*'` | ext, ucm, udef, udir | yes (4) | none | none | yes | /llama /mcp | registered | n/a |
| 6 | `--no-mcp` | none | – | none | none | no | /llama | registered | n/a |
| 7 | `--no-mcp --approve` | none | – | none | none | no | /llama | registered | n/a |
| 8 | settings `extensions: [-builtin:mcp, -builtin:codemode, -builtin:tool-search, -builtin:llama.cpp]` | none | – | none | none | no | none | no | n/a |
| 9 | row 8 + trusted project `.pi/settings.json` with `+builtin:mcp` | ext, pdir, ucm, udef, udir | yes (5) | none | none | yes | /mcp | no | n/a |
| 10 | `--no-extensions` | none | – | none | none | no | none | no | n/a |
| 11 | `--no-extensions --no-mcp` + row 8 settings | none | – | none | none | no | none | no | n/a |
| 12 | `--no-mcp --tools +codemode,+tool_search`, no `setActiveTools` | none | – | codemode, tool_search | none | no | /llama | registered | n/a |
| 13 | `--no-mcp --approve` + project `+builtin:mcp` | none | – | none | none | no | /llama | registered | n/a |
| 14 | `--no-mcp -e builtin:mcp` | none | – | none | none | no | /llama | registered | n/a |
| 15 | **package installed + row 8 settings + `--no-mcp` (recommended)** | none | – | none | none | no | none | no | loaded / loaded |
| 16 | package installed + `--no-extensions` | none | – | none | none | no | none | no | **NOT loaded** / loaded |
| 17 | `--no-extensions -e <package dir>` | none | – | none | none | no | none | no | loaded / loaded |

SDK hosts (`tools: GAFFER_TOOLS` unless the row says otherwise):

| # | SDK host | Servers spawned | Offered | Calls executed | `/mcp` |
|---|---|---|---|---|---|
| S1 | `test/harness.ts` pattern (`noExtensions: true`) | none | none | none | no |
| S2 | eval runner, installed-package pattern (no `noExtensions`) | none | none | none | no |
| S3 | a host that adds `createMcpExtension()` | ext, pdir | none | none | yes |
| S4 | a host that adds the MCP, codemode and tool_search factories, no `tools` | ext, pdir | `mcp__ext__pwn`, `mcp__pdir__pwn` | ext, pdir | yes |

What this shows:

1. **Gaffer's launch line on 1.3.0 is not a lock (rows 2–5).** The `--tools` allowlist keeps MCP tools away from the model: none is declared, and every call fails with "Tool … not found". But every configured MCP server is still **spawned in the harness**. Each server process inherits the harness's whole environment, including `ANTHROPIC_API_KEY`: `packages/mcp/src/transports/stdio.ts:94 @v1.3.0` spreads `process.env` unless `inheritEnv: false`, and Pi never passes that (`packages/coding-agent/src/extensions/mcp/runtime.ts:111-121 @v1.3.0`). An `mcp.json` entry is therefore arbitrary code next to the key. The model is also told about servers it cannot reach: the `mcp_servers` system-prompt section appears. Neither an `mcp__…` allowlist entry (row 4) nor `--exclude-tools 'mcp__*'` (row 5) stops the spawn; both only filter tool registration (`agent-session.ts:1538-1557 @v1.3.0`).
2. **`--no-mcp` is the strongest MCP lock (rows 6, 7, 13, 14).** It wins over a trusted project's `+builtin:mcp` and over `-e builtin:mcp`. It puts `mcp` in `disabledBuiltinExtensions` (`main.ts:788`, applied after all merging at `resource-loader.ts:578-583 @v1.3.0`). An extension's `pi.registerMcpServer()` then only produces an extension error ("no loaded extension connects MCP servers"); nothing spawns.
3. **The settings lock (row 8) disables all four built-ins** (`/mcp`, `/llama`, the llama.cpp provider, codemode and tool_search). But a *trusted project* `.pi/settings.json` can turn MCP back on with `+builtin:<name>` (row 9; `package-manager.ts:976-991 @v1.3.0`). In the harness, `/work` is empty and root-owned, so no project file can appear. That is still why the settings lock needs `--no-mcp` beside it.
4. **`--no-extensions` also drops the installed Gaffer package's extensions (row 16).** Only its skills survive. It works only with `-e /opt/pi-gaffer` (row 17), which changes how the package is installed and loaded. The settings route keeps `pi install` as it is.
5. **Parent-directory `.pi/mcp.json` is never read** (the `parent` server never spawned in any row). Only `<cwd>/.pi/mcp.json` is read, and only when the project is trusted (`extensions/mcp/config.ts:145-156 @v1.3.0`). In print mode an untrusted project is refused without asking. In the TUI the user would be asked, unless `defaultProjectTrust` says otherwise.
6. **The SDK hosts are safe as they are (S1, S2).** Built-in extensions are added only by the CLI's `main.ts:578` (`[...builtInExtensions, ...]`). An SDK host gets them only if it passes the factories itself (S3, S4). Two details apply to such a host. `createMcpExtension()` reads `mcp.json` from `getAgentDir()` (the env or `~/.pi/agent`), not from the SDK's `agentDir` (`extensions/mcp/index.ts:1343-1345`). And the project was treated as trusted (`pdir` spawned).
7. **The `--tools` allowlist already keeps `codemode` and `tool_search` unregistered** (rows 2–5). They are not MCP names, so they are filtered like any tool. If they are enabled anyway (row 12), gaffer-core's `setActiveTools` removes them again. In row 1 (no allowlist), however, the MCP extension re-activated codemode and tool_search *after* gaffer-core's `setActiveTools` (`extensions/mcp/index.ts:500-525`). The second line of defence holds only while the allowlist does.

## Impact on the design

Recommended lock for the Pi 1.x harness (all three parts are needed; each covers a gap in the others):

1. `harness/gaffer-pi`: add `--no-mcp` to the launch line, so it reads `pi --session-dir /sessions --no-context-files --no-mcp --continue --tui-mode fullscreen --tools read,write,edit,bash,fpl_snapshot,submit_recommendation,set_preferences`.
2. `harness/Dockerfile`: after `pi install /opt/pi-gaffer`, write `"extensions": ["-builtin:mcp", "-builtin:codemode", "-builtin:tool-search", "-builtin:llama.cpp"]` into `/opt/pi-agent/settings.json`, next to `theme`. This removes `/llama` and the llama.cpp provider, which `--no-mcp` does not touch. The same applies to `deploy/compose/tests/{injection,real-run}.sh`, which copy the launch line.
3. Keep the `--tools` allowlist and gaffer-core's `setActiveTools` as they are.
4. SDK hosts (`test/harness.ts`, `evals/runner/run.ts`): no change is needed, because built-ins are CLI-only. Add a test that asserts `getAllTools()` has no `codemode`, `tool_search` or `mcp__*` name, so a future Pi that moves built-ins into the SDK is caught.
5. Add an image-level test: put an `mcp.json` (marker-writing server) into `/opt/pi-agent`, start `gaffer-pi` headless, and assert that no marker appears. This is the S3 row 15 check, run in the container.

## Re-run

```sh
cd spikes/s3-mcp-lockdown
npm ci                      # Pi 1.3.0 exactly (package-lock.json)
node run-cli.mjs            # all CLI rows; or: node run-cli.mjs gaffer-line no-mcp
node run-sdk.ts             # SDK rows
```

Outputs: `results-cli.json`, `results-sdk.json`, `run-cli.log`. Each run uses fresh `mkdtemp` directories. The only server started is `pwn-server.mjs`, and nothing touches `~/.pi`, except that the S3/S4 SDK rows read a `~/.pi/agent/mcp.json` if one exists (there was none here).
