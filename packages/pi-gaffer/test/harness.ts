/**
 * Headless Gaffer for tests: the real extensions in an SDK session driven by Pi's fauxProvider,
 * a real sandboxd (host python) and a mock FPL API. Mirrors the S1 spike's setup.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type FauxResponseStep, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, type ExtensionAPI, type ExtensionFactory, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import gafferBudget from "../extensions/gaffer-budget/index.ts";
import gafferCore from "../extensions/gaffer-core/index.ts";
import gafferData from "../extensions/gaffer-data/index.ts";
import gafferSandbox from "../extensions/gaffer-sandbox/index.ts";
import { GAFFER_TOOLS } from "../src/config.ts";
import { MockFpl } from "./mock-fpl.ts";

const SANDBOXD = resolve(import.meta.dirname, "../../../sandbox/sandboxd.py");

async function freePort(): Promise<number> {
	return new Promise((r) => {
		const s = createServer().listen(0, "127.0.0.1", () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => r(p));
		});
	});
}

export interface GafferTestEnv {
	fpl: MockFpl;
	sandboxWork: string;
	dataDir: string;
	sessionsDir: string;
	stop(): Promise<void>;
}

/** Start the mock FPL API and a real sandboxd, and point Gaffer's env at them. */
export async function startEnv(): Promise<GafferTestEnv> {
	const root = mkdtempSync(join(tmpdir(), "gaffer-it-"));
	const sandboxWork = join(root, "work");
	const dataDir = join(root, "data");
	const sessionsDir = join(root, "sessions");
	for (const d of [sandboxWork, dataDir, sessionsDir]) mkdirSync(d);
	const fpl = await new MockFpl().start();
	const port = await freePort();
	const sbx: ChildProcess = spawn("python3", [SANDBOXD, "--host", "127.0.0.1", "--port", String(port), "--work", sandboxWork], { stdio: "ignore" });
	Object.assign(process.env, {
		FPL_BASE_URL: fpl.base,
		SANDBOX_URL: `http://127.0.0.1:${port}`,
		GAFFER_DATA_DIR: dataDir,
		GAFFER_ID_SALT: "test-salt",
		ANTHROPIC_API_KEY: "sk-ant-test-harness-secret",
	});
	return {
		fpl,
		sandboxWork,
		dataDir,
		sessionsDir,
		async stop() {
			sbx.kill();
			await fpl.stop();
		},
	};
}

export interface Notification {
	message: string;
	type?: string;
}

export async function startGaffer(env: GafferTestEnv, opts: { responses: FauxResponseStep[]; skillsDir?: string; extra?: ExtensionFactory[]; cost?: { input: number; output: number }; bind?: boolean }) {
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "faux-1", cost: { input: opts.cost?.input ?? 0, output: opts.cost?.output ?? 0, cacheRead: 0, cacheWrite: 0 } }],
	});
	faux.setResponses(opts.responses);
	const agentDir = mkdtempSync(join(tmpdir(), "gaffer-agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "gaffer-cwd-")); // empty, as in the harness image
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const factories: ExtensionFactory[] = [
		(pi: ExtensionAPI) => pi.registerProvider(faux.provider as never),
		gafferCore,
		gafferSandbox,
		gafferData,
		gafferBudget,
		...(opts.extra ?? []),
	];
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: factories,
		noExtensions: true,
		noContextFiles: true,
		additionalSkillPaths: opts.skillsDir ? [opts.skillsDir] : [],
	} as never);
	await loader.reload();
	const sessionManager = SessionManager.create(cwd, env.sessionsDir);
	const { session } = await createAgentSession({ cwd, agentDir, model: faux.getModel() as never, resourceLoader: loader, sessionManager, settingsManager, tools: GAFFER_TOOLS });
	const notifications: Notification[] = [];
	// A plain object: Pi spreads the UI context ({...ui}), so a Proxy would lose its methods.
	const noop = () => undefined;
	const uiContext: Record<string, unknown> = { notify: (message: string, type?: string) => notifications.push({ message, type }) };
	for (const m of ["select", "confirm", "input", "editor", "custom", "onTerminalInput", "setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader", "setTitle", "pasteToEditor", "setEditorText", "getEditorText", "addAutocompleteProvider", "setEditorComponent", "getEditorComponent", "getAllThemes", "getTheme", "setTheme", "getToolsExpanded", "setToolsExpanded"]) uiContext[m] = noop;
	// S1 gotcha: SDK hosts must bind extensions or session_start (and setActiveTools) never runs.
	const bind = () => session.bindExtensions({ uiContext: uiContext as never, mode: "tui" });
	if (opts.bind !== false) await bind();

	const toolResults: { name: string; isError: boolean; text: string; details: unknown }[] = [];
	session.subscribe((e: { type: string; toolName?: string; isError?: boolean; result?: { content?: { text?: string }[]; details?: unknown } }) => {
		if (e.type === "tool_execution_end") {
			toolResults.push({ name: e.toolName!, isError: !!e.isError, text: e.result?.content?.map((c) => c.text ?? "").join("") ?? "", details: e.result?.details });
		}
	});
	// This session's own JSONL file, as persisted.
	const sessionEntries = () => {
		const file = session.sessionManager.getSessionFile();
		if (!file || !existsSync(file)) return []; // Pi creates the file lazily
		return readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	};
	return { session, faux, notifications, toolResults, sessionEntries, bind };
}
