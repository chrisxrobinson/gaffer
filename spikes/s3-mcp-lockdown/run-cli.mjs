#!/usr/bin/env node
// S3, CLI half: run Pi 1.3.0's real CLI (print mode, faux model) under each candidate lock, with a user
// mcp.json, a project .pi/mcp.json, a parent-dir .pi/mcp.json and an extension-registered server.
// Usage: node run-cli.mjs [config-name ...]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HERE = import.meta.dirname;
const PI = resolve(HERE, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const SERVER = resolve(HERE, "pwn-server.mjs");
const TOOLS = "read,write,edit,bash,fpl_snapshot,submit_recommendation,set_preferences";
const ALL_BUILTINS_OFF = ["-builtin:mcp", "-builtin:codemode", "-builtin:tool-search", "-builtin:llama.cpp"];

const CONFIGS = {
	"upstream-defaults": { args: [] },
	"gaffer-line": { args: ["--tools", TOOLS] },
	"gaffer-line+approve": { args: ["--tools", TOOLS, "--approve"] },
	"tools+mcp__none": { args: ["--tools", `${TOOLS},mcp__none`] },
	"exclude-mcp__*": { args: ["--tools", TOOLS, "--exclude-tools", "mcp__*"] },
	"no-mcp": { args: ["--tools", TOOLS, "--no-mcp"] },
	"no-mcp+approve": { args: ["--tools", TOOLS, "--no-mcp", "--approve"] },
	"settings -builtin:*": { args: ["--tools", TOOLS], settings: { extensions: ALL_BUILTINS_OFF } },
	"settings -builtin:* +approve +project +builtin:mcp": { args: ["--tools", TOOLS, "--approve"], settings: { extensions: ALL_BUILTINS_OFF }, projectSettings: { extensions: ["+builtin:mcp"] } },
	"no-extensions": { args: ["--tools", TOOLS, "--no-extensions"] },
	"no-extensions+no-mcp+settings": { args: ["--tools", TOOLS, "--no-extensions", "--no-mcp"], settings: { extensions: ALL_BUILTINS_OFF } },
	"no-mcp+default-tools(+codemode), no setActiveTools": { args: ["--no-mcp", "--tools", "+codemode,+tool_search"], env: { SPIKE_NO_SET_ACTIVE: "1" } },
	"no-mcp +approve +project +builtin:mcp": { args: ["--tools", TOOLS, "--no-mcp", "--approve"], projectSettings: { extensions: ["+builtin:mcp"] } },
	"no-mcp -e builtin:mcp": { args: ["--tools", TOOLS, "--no-mcp", "-e", "builtin:mcp"] },
	"pkg installed + settings -builtin:* + no-mcp (RECOMMENDED)": { args: ["--tools", `${TOOLS},fake_tool`, "--no-mcp"], settings: { extensions: ALL_BUILTINS_OFF }, installPkg: true },
	"pkg installed + no-extensions": { args: ["--tools", `${TOOLS},fake_tool`, "--no-extensions"], installPkg: true },
	"no-extensions + -e pkgdir": { args: ["--tools", `${TOOLS},fake_tool`, "--no-extensions", "-e", resolve(HERE, "fake-pkg")] },
};

function setup(cfg) {
	const root = mkdtempSync(join(tmpdir(), "s3-"));
	const agent = join(root, "agent");
	const parent = join(root, "parent");
	const cwd = join(parent, "work");
	const markers = join(root, "markers");
	for (const d of [agent, join(parent, ".pi"), join(cwd, ".pi"), markers, join(root, "sessions")]) mkdirSync(d, { recursive: true });
	const srv = (name, exposure) => ({ command: "node", args: [SERVER, name, markers], ...(exposure ? { exposure } : {}) });
	writeFileSync(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { ucm: srv("ucm"), udir: srv("udir", "direct"), udef: srv("udef", "deferred") } }));
	writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { pdir: srv("pdir", "direct") } }));
	writeFileSync(join(parent, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { parent: srv("parent", "direct") } }));
	if (cfg.settings) writeFileSync(join(agent, "settings.json"), JSON.stringify(cfg.settings));
	if (cfg.projectSettings) writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(cfg.projectSettings));
	if (cfg.installPkg) {
		const r = spawnSync(process.execPath, [PI, "install", resolve(HERE, "fake-pkg")], { cwd: root, encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0" } });
		if (r.status !== 0) throw new Error(`pi install failed: ${r.stderr}`);
	}
	return { root, agent, cwd, markers };
}

function run(name, cfg) {
	const { root, agent, cwd, markers } = setup(cfg);
	const out = join(root, "report.json");
	const args = [PI, "--session-dir", join(root, "sessions"), "--no-context-files", "--provider", "faux", "--model", "faux-1",
		"-e", resolve(HERE, "spike-ext.ts"), "-e", resolve(HERE, "ext-mcp.ts"), ...cfg.args, "-p", "go"];
	const r = spawnSync(process.execPath, args, {
		cwd, encoding: "utf8", timeout: 90_000,
		env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", ANTHROPIC_API_KEY: "sk-ant-spike-dummy", SPIKE_OUT: out, SPIKE_MARKERS: markers, ...(cfg.env ?? {}) },
	});
	const rep = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
	const files = readdirSync(markers);
	const spawned = files.filter((f) => f.endsWith(".spawned")).map((f) => f.replace(".spawned", ""));
	const called = files.filter((f) => f.endsWith(".called")).map((f) => f.replace(".called", ""));
	const keyInherited = spawned.filter((s) => JSON.parse(readFileSync(join(markers, `${s}.spawned`), "utf8")).inheritedAnthropicKey);
	const offered = [...new Set((rep.offered ?? []).flatMap((o) => o.tools))].filter((t) => /^mcp__|codemode|tool_search|mcp_resource/.test(t));
	const mcpSection = (rep.offered ?? []).some((o) => o.mcpServersSection);
	const registeredMcp = (rep.atEnd?.registered ?? rep.atStart?.registered ?? []).filter((t) => /^mcp__|^codemode|^tool_search/.test(t));
	return {
		config: name, exit: r.status, spawned: spawned.sort(), keyInherited: keyInherited.sort(), called: called.sort(), offered, mcpSection,
		registered: registeredMcp, packageLoaded: (rep.atStart?.registered ?? []).some((t) => t.startsWith("fake_tool")), packageSkill: (rep.offered ?? []).some((o) => o.fakeSkill), commands: rep.atStart?.commands, llamaProvider: (rep.atStart?.providers ?? []).includes("llama.cpp"),
		results: (rep.results ?? []).map((x) => `${x.tool}${x.parent ? `(<-${x.parent.split("/")[0].slice(-6)})` : ""}:${x.isError ? "ERR" : "ok"}:${x.text.slice(0, 90)}`),
		stderr: (r.stderr ?? "").split("\n").filter((l) => /mcp|MCP|extension|error/i.test(l)).slice(0, 6),
	};
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CONFIGS);
const rows = [];
for (const n of names) {
	const row = run(n, CONFIGS[n]);
	rows.push(row);
	console.log(JSON.stringify(row, null, 1));
}
writeFileSync(join(HERE, "results-cli.json"), JSON.stringify(rows, null, 2));
