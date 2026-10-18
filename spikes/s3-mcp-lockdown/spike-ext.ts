/**
 * S3 spike extension: a faux model that tries every MCP/codemode/tool_search route, stubs of Gaffer's
 * three own tools (same names, so the --tools allowlist is Gaffer's), gaffer-core's setActiveTools
 * second line of defence, and a report of what the model was offered and what ran.
 * Loaded with `-e` by the CLI runs and as a factory by the SDK runs.
 */
import { writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const GAFFER_TOOLS = ["read", "write", "edit", "bash", "fpl_snapshot", "submit_recommendation", "set_preferences"];

let report: Record<string, unknown> = { offered: [] as unknown[], results: [] as unknown[], notices: [] as string[] };
export const resetReport = () => {
	report = { offered: [], results: [], notices: [] };
};
const save = () => process.env.SPIKE_OUT && writeFileSync(process.env.SPIKE_OUT, JSON.stringify(report, null, 2));

const SCRIPT = `const out = [];
for (const n of ["mcp__ucm__pwn", "mcp__udef__pwn", "mcp__ext__pwn"]) {
  try { out.push(n + ": " + (await tools[n]({}))); } catch (e) { out.push(n + ": ERR " + e.message); }
}
return out;`;

const steps: [string, Record<string, unknown>][] = [
	["mcp__udir__pwn", {}], // user mcp.json, exposure direct
	["mcp__pdir__pwn", {}], // project .pi/mcp.json, exposure direct
	["mcp__ext__pwn", {}], // pi.registerMcpServer() from an extension, exposure direct
	["codemode", { code: SCRIPT }], // codemode-exposed and deferred MCP tools from a script
	["tool_search", { query: "pwn spike tool" }],
	["mcp__udef__pwn", {}], // deferred: only after tool_search loaded it
];

export function makeFaux() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const record = (i: number) => (ctx: { messages: unknown[] }) => {
		const tools = getCurrentTools(ctx.messages as never).map((t) => t.name);
		const sp = getCurrentSystemPrompt(ctx.messages as never);
		(report.offered as unknown[]).push({ turn: i, tools, mcpServersSection: sp.includes("MCP servers whose tools"), fakeSkill: sp.includes("fake-skill") });
		save();
	};
	faux.setResponses([
		...steps.map(([name, args], i) => (ctx: never) => {
			record(i)(ctx);
			return fauxAssistantMessage(fauxToolCall(name, args));
		}),
		(ctx: never) => {
			record(steps.length)(ctx);
			return fauxAssistantMessage(fauxText("done"));
		},
	]);
	return faux;
}

export function spikeExtension(pi: ExtensionAPI, opts: { faux?: boolean } = { faux: true }) {
	if (opts.faux !== false) pi.registerProvider(makeFaux().provider as never);
	for (const name of ["fpl_snapshot", "submit_recommendation", "set_preferences"]) {
		pi.registerTool(defineTool({ name, label: name, description: `stub ${name}`, parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "stub" }], details: {} }) }));
	}
	pi.on("session_start", async (_e, ctx) => {
		// gaffer-core's second line of defence.
		const available = new Set(pi.getAllTools().map((t) => t.name));
		if (!process.env.SPIKE_NO_SET_ACTIVE) pi.setActiveTools([...GAFFER_TOOLS, "fake_tool"].filter((t) => available.has(t)));
		report.atStart = {
			registered: pi.getAllTools().map((t) => `${t.name}:${t.exposure}`),
			active: pi.getActiveTools(),
			commands: pi.getCommands().map((c) => c.name).filter((n) => ["mcp", "llama"].includes(n)),
			providers: [...(ctx.modelRegistry as unknown as { getRegisteredProviderIds(): string[] }).getRegisteredProviderIds()],
		};
		save();
	});
	pi.on("tool_execution_end", async (e) => {
		const text = (e.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("").replace(/\s+/g, " ").slice(0, 220);
		(report.results as unknown[]).push({ tool: e.toolName, parent: (e as { parentToolCallId?: string }).parentToolCallId, isError: e.isError, text });
		save();
	});
	pi.on("agent_end", async () => {
		report.atEnd = { registered: pi.getAllTools().map((t) => `${t.name}:${t.exposure}`), active: pi.getActiveTools() };
		save();
	});
}

export default function (pi: ExtensionAPI) {
	spikeExtension(pi);
}
