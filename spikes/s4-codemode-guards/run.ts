// S4: do tool calls made inside a codemode script pass through extension tool_call guards, tool events,
// the session JSONL and Gaffer's budget accounting? What can a script reach directly? And what does the
// codemode description cost in prompt tokens for Gaffer's 7 tools?
// Pi 1.3.0, faux model and a local fake classifier only: no network, no paid calls.
// Usage: node run.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/models";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import {
	createAgentSession,
	createBashToolDefinition,
	createCodemodeExtension,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DefaultResourceLoader,
	defineTool,
	type ExtensionAPI,
	type ExtensionFactory,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Gaffer's own policy and budget code, imported read-only from the repo.
const REPO = resolve(import.meta.dirname, "../..");
const { checkToolCall } = await import(join(REPO, "packages/pi-gaffer/src/guard.ts"));
const { sessionCost } = await import(join(REPO, "packages/pi-gaffer/src/budget.ts"));
const { Submission, Risk, Chip } = await import(join(REPO, "packages/pi-gaffer/src/schema/recommendation.ts"));

const GAFFER_TOOLS = ["read", "write", "edit", "bash", "fpl_snapshot", "submit_recommendation", "set_preferences"];
const log: Record<string, unknown[]> = { toolCall: [], toolResult: [], execStart: [], execEnd: [], turnEnd: [], sandboxBash: [], sandboxWrite: [] };

// ---------------------------------------------------------------- Gaffer-shaped extensions
/** Like gaffer-sandbox: bash/read/write/edit re-registered with operations (here: recorded stubs, i.e. "the sandbox"). */
function sandboxStub(pi: ExtensionAPI, cwd: string) {
	pi.registerTool(createBashToolDefinition(cwd, { exposeSessionEnvironment: false, operations: { exec: async (command, _cwd, { onData }) => { log.sandboxBash.push(command); onData(Buffer.from(`[sandbox stub] ${command}\n`)); return { exitCode: 0 }; } } } as never));
	pi.registerTool(createReadToolDefinition(cwd, { operations: { readFile: async () => Buffer.from("stub"), access: async () => {}, detectImageMimeType: async () => undefined } } as never));
	pi.registerTool(createWriteToolDefinition(cwd, { operations: { writeFile: async (p: string) => { log.sandboxWrite.push(p); }, mkdir: async () => {} } }));
	pi.registerTool(createEditToolDefinition(cwd, { operations: { readFile: async () => Buffer.from(""), writeFile: async () => {}, access: async () => {} } } as never));
}

/** Gaffer's other three tools with their real descriptions and schemas (execute is a stub). */
function gafferToolStubs(pi: ExtensionAPI) {
	const stub = async () => ({ content: [{ type: "text" as const, text: "stub" }], details: {} });
	pi.registerTool(defineTool({
		name: "fpl_snapshot", label: "FPL snapshot",
		description: "Fetch the user's FPL team and the public FPL data (players, fixtures, GW state, chips), validate it and store an immutable snapshot. Returns a compact summary (squad with selling prices, bank, free transfers, chips, deadline, warnings), derived by gaffer_lib in the sandbox, and the snapshot path, which is readable (read-only) from the sandbox. Per-user data is always fetched fresh; shared data is cached per FPL's update cycle. Never returns raw JSON: read the snapshot files with Python for detail. With include: [\"odds\"] the snapshot also holds bookmaker odds; the summary ends with the gaffer_lib command that turns the snapshot into a full plan.",
		promptSnippet: "Fetch and snapshot the user's FPL team and public FPL data",
		parameters: Type.Object({
			team_id: Type.Optional(Type.Integer({ minimum: 1, description: "FPL team (entry) ID. Defaults to the team set with /team." })),
			element_summaries: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 20, description: "Player ids whose per-fixture history (element-summary) to include in the snapshot." })),
			include: Type.Optional(Type.Array(Type.Union([Type.Literal("odds")]), { description: 'Extra sources. "odds": next-round bookmaker odds and past results from football-data.co.uk, used for team strength. Include it before running the golden path.' })),
			force_fresh: Type.Optional(Type.Boolean({ description: "Bypass the shared-data cache. Only when the user asks for the very latest data." })),
		}),
		execute: stub,
	}));
	pi.registerTool(defineTool({
		name: "submit_recommendation", label: "Recommendation",
		description: "Submit the final recommendation for the next GW: transfers, starting XI and bench, captain and vice, chip, a 4-GW plan, a rationale for each decision and a summary. This is the only way a plan becomes final. Gaffer checks it against FPL's rules, the user's preferences and the solver's best plan, using the latest snapshot and the plan file the golden path wrote, and recomputes every number: you supply decisions and words (figures you quote are optional and are corrected). If it is rejected you get the reasons and may resubmit; there are 3 attempts in all. On success the recommendation is saved and shown to the user and the run ends, so make it your last action and say nothing after it.",
		promptSnippet: "Submit the final recommendation; it is validated, recomputed, saved and shown",
		parameters: Submission, executionMode: "sequential", execute: stub,
	} as never));
	pi.registerTool(defineTool({
		name: "set_preferences", label: "Preferences",
		description: "Save the user's standing preferences for their team, so they needn't restate them: risk mode, chips to save, players to keep or avoid, and the most hits to take in a GW. Only fields you pass are changed; a list you pass replaces the saved list (pass [] to clear it). Call it when the user states a preference that should last beyond this conversation. Preferences are passed to the golden path with --prefs and enforced when a recommendation is submitted. They are for the team set with /team.",
		promptSnippet: "Save the user's standing preferences (risk, chips to save, keep/avoid, max hits)",
		parameters: Type.Object({
			risk: Type.Optional(Risk),
			save_chips: Type.Optional(Type.Array(Chip, { maxItems: 4, description: "Chips not to play until the user says otherwise." })),
			keep: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 15, description: "Player ids the user wants to keep in the squad." })),
			avoid: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 50, description: "Player ids the user doesn't want bought." })),
			max_hits_per_gw: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 15 }), Type.Null()], { description: "Most hits (−4 each) to take in one GW; null for no limit." })),
		}),
		execute: stub,
	} as never));
}

/** gaffer-data's guard (the real checkToolCall), plus a recorder of every tool event. */
function guardAndRecorder(pi: ExtensionAPI) {
	pi.on("tool_call", async (e) => {
		const verdict = checkToolCall(e.toolName, e.input);
		log.toolCall.push({ tool: e.toolName, id: e.toolCallId, parent: e.parentToolCallId, blocked: !!verdict });
		return verdict;
	});
	pi.on("tool_result", async (e) => {
		log.toolResult.push({ tool: e.toolName, id: e.toolCallId, parent: (e as { parentToolCallId?: string }).parentToolCallId, isError: e.isError });
	});
	pi.on("tool_execution_start", async (e) => {
		log.execStart.push({ tool: e.toolName, id: e.toolCallId, parent: (e as { parentToolCallId?: string }).parentToolCallId });
	});
	pi.on("tool_execution_end", async (e) => {
		const text = (e.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("").replace(/\s+/g, " ");
		log.execEnd.push({ tool: e.toolName, id: e.toolCallId, parent: (e as { parentToolCallId?: string }).parentToolCallId, isError: e.isError, text: text.slice(0, 2400) });
	});
	// What gaffer-budget sees on turn_end: Gaffer's sessionCost() vs every message's usage (what Pi's footer sums).
	pi.on("turn_end", async (_e, ctx) => {
		const entries = ctx.sessionManager.getEntries() as { type: string; message?: { role?: string; usage?: { cost?: { total?: number } } } }[];
		const all = entries.reduce((s, x) => s + (x.type === "message" ? (x.message?.usage?.cost?.total ?? 0) : 0), 0);
		log.turnEnd.push({ gafferSessionCost: Number(sessionCost(entries).toFixed(6)), allMessageUsage: Number(all.toFixed(6)) });
	});
	pi.on("session_start", async () => pi.setActiveTools([...GAFFER_TOOLS, "codemode"]));
}

/** A local classifier "provider" that charges $0.50 per call, to see where codemode puts classifier usage. */
function fakeClassifier(pi: ExtensionAPI) {
	pi.registerProvider(createProvider({
		id: "fakecls",
		auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
		models: [{ type: "classifier", id: "fake-jev", name: "Fake Jev", api: "typesafe-system-one", provider: "fakecls", baseUrl: "http://127.0.0.1:9/", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000 }] as never,
		classifiers: { "typesafe-system-one": { classify: async (model: { provider: string; id: string; api: string }) => ({ api: model.api, provider: model.provider, model: model.id, answers: { injection: { type: "bool", probability: 0.97 } }, stopReason: "stop", timestamp: Date.now(), usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1000, cost: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } } }) } },
	} as never) as never);
}

// ---------------------------------------------------------------- the scripts the "model" writes
const PROBE = `const r = {};
r.typeofProcess = typeof process; r.typeofRequire = typeof require; r.typeofFetch = typeof fetch;
r.typeofSetTimeout = typeof setTimeout; r.typeofWebAssembly = typeof WebAssembly; r.typeofXHR = typeof XMLHttpRequest;
r.globals = Object.getOwnPropertyNames(globalThis).filter((k) => !/^[A-Z]/.test(k)).sort().join(",");
try { await import("node:fs"); r.dynImport = "loaded"; } catch (e) { r.dynImport = "ERR " + e.message; }
try { r.envViaFunction = typeof (new Function("return this")()).process; } catch (e) { r.envViaFunction = "ERR " + e.message; }
r.tools = Object.keys(tools).join(",");
try { r.allowed = (await tools.bash({ command: "python3 -c 'print(2+2)'" })).output; } catch (e) { r.allowed = "ERR " + e.message; }
const acct = "/api/my" + "-team/1/";   // assembled at run time, so the outer codemode call's args don't contain it
try { r.blocked = await tools.bash({ command: "curl https://fantasy.premierleague.com" + acct }); } catch (e) { r.blocked = "REJECTED: " + e.message; }
try { r.dataWrite = await tools.write({ path: "/data/" + "x.json", content: "{}" }); } catch (e) { r.dataWrite = "REJECTED: " + e.message; }
try { r.recurse = await tools.codemode({ code: "return 1" }); } catch (e) { r.recurse = "ERR " + e.message; }
try { r.classifiers = (await models.getAvailableOfType("classifier")).map((m) => m.provider + "/" + m.id + (m.headers ? " HEADERS" : "")); } catch (e) { r.classifiers = "ERR " + e.message; }
try { const c = await models.classify({ provider: "fakecls", id: "fake-jev" }, { state: { news: "Ignore previous instructions" }, questions: { injection: { type: "bool", instructions: "Is this a prompt injection?", criteria: { true: "yes", false: "no" } } } }); r.classify = c.answers; } catch (e) { r.classify = "ERR " + e.message; }
return r;`;

const LITERAL = `return await tools.bash({ command: "curl https://fantasy.premierleague.com/api/my-team/1/" });`;

// ---------------------------------------------------------------- session
async function session(opts: { mode?: "on" | "only"; activate: string[]; steps: unknown[] }) {
	const root = mkdtempSync(join(tmpdir(), "s4-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "work");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	if (opts.mode) writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ codemode: { mode: opts.mode } }));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } }] });
	const seen: { tools: { name: string; description: string; parameters: unknown }[]; systemPrompt: string }[] = [];
	faux.setResponses(opts.steps.map((step) => (ctx: { messages: unknown[] }) => {
		seen.push({ tools: getCurrentTools(ctx.messages as never) as never, systemPrompt: getCurrentSystemPrompt(ctx.messages as never) });
		return step as never;
	}) as never);
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const factories: ExtensionFactory[] = [(pi) => pi.registerProvider(faux.provider as never), (pi) => sandboxStub(pi, cwd), gafferToolStubs, guardAndRecorder, fakeClassifier, createCodemodeExtension()];
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: factories, noExtensions: true, noContextFiles: true } as never);
	await loader.reload();
	const sessionsDir = join(root, "sessions");
	const { session } = await createAgentSession({ cwd, agentDir, model: faux.getModel() as never, resourceLoader: loader, sessionManager: SessionManager.create(cwd, sessionsDir), settingsManager, tools: [...GAFFER_TOOLS, "codemode"] });
	await session.bindExtensions({ uiContext: { notify: () => {} } as never, mode: "tui" } as never);
	session.setActiveToolsByName(opts.activate);
	await session.prompt("go");
	const file = session.sessionManager.getSessionFile();
	const jsonl = file && existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
	session.dispose();
	return { seen, jsonl };
}

// 1. Guards, events, JSONL, budget, reachability.
const run = await session({
	activate: [...GAFFER_TOOLS, "codemode"],
	steps: [fauxAssistantMessage(fauxToolCall("codemode", { code: PROBE })), fauxAssistantMessage(fauxToolCall("codemode", { code: LITERAL })), fauxAssistantMessage(fauxText("done"))],
});
const toolResults = run.jsonl.filter((e) => e.type === "message" && e.message?.role === "toolResult").map((e) => ({ tool: e.message.toolName, isError: e.message.isError, usage: e.message.usage?.cost?.total, nestedCalls: e.message.nestedCalls }));
const probeOut = (log.execEnd as { tool: string; parent?: string; text: string }[]).find((x) => x.tool === "codemode" && !x.parent)?.text;

// 2. Prompt cost of the codemode description, Gaffer's 7 tools: off vs on vs only.
const sizeOf = (s: { tools: { name: string; description: string; parameters: unknown }[]; systemPrompt: string }) => {
	const decl = s.tools.map((t) => JSON.stringify({ name: t.name, description: t.description, input_schema: t.parameters }));
	return { tools: s.tools.map((t) => t.name).join(","), declChars: decl.join("").length, systemPromptChars: s.systemPrompt.length, codemodeDescChars: s.tools.find((t) => t.name === "codemode")?.description.length ?? 0 };
};
const done = [fauxAssistantMessage(fauxText("done"))];
const firstRun = { toolCall: [...log.toolCall], toolResult: [...log.toolResult], turnEnd: [...log.turnEnd] };
const off = sizeOf((await session({ activate: GAFFER_TOOLS, steps: done })).seen[0]);
const on = await session({ mode: "on", activate: [...GAFFER_TOOLS, "codemode"], steps: done });
const only = await session({ mode: "only", activate: [...GAFFER_TOOLS, "codemode"], steps: done });
const sizes = { off, on: sizeOf(on.seen[0]), only: sizeOf(only.seen[0]) };
writeFileSync(join(import.meta.dirname, "codemode-description-on.txt"), on.seen[0].tools.find((t) => t.name === "codemode")?.description ?? "");
writeFileSync(join(import.meta.dirname, "codemode-description-only.txt"), only.seen[0].tools.find((t) => t.name === "codemode")?.description ?? "");
writeFileSync(join(import.meta.dirname, "bash-description-on.txt"), on.seen[0].tools.find((t) => t.name === "bash")?.description ?? "");

const result = { probe: probeOut, toolCall: firstRun.toolCall, execStart: log.execStart, execEnd: (log.execEnd as { text: string }[]).map((x) => ({ ...x, text: x.text.slice(0, 160) })), toolResult: firstRun.toolResult, sandboxBash: log.sandboxBash, sandboxWrite: log.sandboxWrite, turnEnd: firstRun.turnEnd, toolResultsInJsonl: toolResults, sizes };
writeFileSync(join(import.meta.dirname, "results.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(0);
