// S3, SDK half: the two SDK hosts Gaffer has (packages/pi-gaffer/test/harness.ts and
// evals/runner/run.ts) rebuilt on Pi 1.3.0, with the same mcp.json files present. Built-ins are only
// added by the CLI's main.ts, so they should be absent unless a host adds them itself.
// Usage: node run-sdk.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension, DefaultResourceLoader, type ExtensionFactory, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { GAFFER_TOOLS, makeFaux, resetReport, spikeExtension } from "./spike-ext.ts";
import extMcp from "./ext-mcp.ts";

const HERE = import.meta.dirname;
const SERVER = resolve(HERE, "pwn-server.mjs");

async function run(name: string, opts: { noExtensions?: boolean; extra?: ExtensionFactory[]; tools?: string[] }) {
	const root = mkdtempSync(join(tmpdir(), "s3sdk-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "work");
	const markers = join(root, "markers");
	for (const d of [agentDir, join(cwd, ".pi"), markers]) mkdirSync(d, { recursive: true });
	const srv = (n: string, exposure?: string) => ({ command: "node", args: [SERVER, n, markers], ...(exposure ? { exposure } : {}) });
	writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { ucm: srv("ucm"), udir: srv("udir", "direct"), udef: srv("udef", "deferred") } }));
	writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { pdir: srv("pdir", "direct") } }));
	const out = join(root, "report.json");
	Object.assign(process.env, { SPIKE_OUT: out, SPIKE_MARKERS: markers, ANTHROPIC_API_KEY: "sk-ant-spike-dummy", PI_OFFLINE: "1" });

	resetReport();
	const faux = makeFaux();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const factories: ExtensionFactory[] = [(pi) => pi.registerProvider(faux.provider as never), (pi) => spikeExtension(pi, { faux: false }), extMcp, ...(opts.extra ?? [])];
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: factories, noContextFiles: true, ...(opts.noExtensions ? { noExtensions: true } : {}) } as never);
	await loader.reload();
	const { session } = await createAgentSession({ cwd, agentDir, model: faux.getModel() as never, resourceLoader: loader, sessionManager: SessionManager.create(cwd, join(root, "sessions")), settingsManager, ...(opts.tools ? { tools: opts.tools } : {}) });
	const errors: string[] = [];
	await session.bindExtensions({ uiContext: { notify: (m: string) => errors.push(m) } as never, mode: "tui", onError: (e: { error: string }) => errors.push(e.error) } as never);
	await session.prompt("go");
	await new Promise((r) => setTimeout(r, 500));
	const rep = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
	const files = readdirSync(markers);
	const row = {
		config: name,
		spawned: files.filter((f) => f.endsWith(".spawned")).map((f) => f.replace(".spawned", "")).sort(),
		called: files.filter((f) => f.endsWith(".called")).map((f) => f.replace(".called", "")).sort(),
		offered: [...new Set((rep.offered ?? []).flatMap((o: { tools: string[] }) => o.tools))].filter((t) => /^mcp__|codemode|tool_search/.test(t as string)),
		registered: (rep.atEnd?.registered ?? []).filter((t: string) => /^mcp__|^codemode|^tool_search/.test(t)),
		commands: rep.atStart?.commands,
		notices: errors.filter((e) => /MCP|mcp/.test(e)).map((e) => e.slice(0, 160)),
	};
	session.dispose();
	return row;
}

const rows = [
	await run("harness.ts pattern (noExtensions, tools=GAFFER_TOOLS)", { noExtensions: true, tools: GAFFER_TOOLS }),
	await run("eval runner installed pattern (no noExtensions, tools=GAFFER_TOOLS)", { tools: GAFFER_TOOLS }),
	await run("SDK host that adds createMcpExtension() (tools=GAFFER_TOOLS)", { tools: GAFFER_TOOLS, extra: [createMcpExtension()] }),
	await run("SDK host that adds MCP+codemode+tool_search, no tools option", { extra: [createMcpExtension(), createCodemodeExtension(), createToolSearchExtension()] }),
];
for (const r of rows) console.log(JSON.stringify(r));
writeFileSync(join(HERE, "results-sdk.json"), JSON.stringify(rows, null, 2));
process.exit(0);
