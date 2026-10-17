/**
 * Spike S6: does rewriting Gaffer's per-prompt system sections (fpl_context with `now:` and a
 * deadline countdown) defeat Anthropic prompt caching, and do mid-conversation system messages
 * (compat.supportsMidConvoSystemMessages) fix it?
 *
 *   node s6.ts --variant A|B --label <run label> [--prompts 3]
 *
 * A: the model entry exactly as harness/models.json declares it (no mid-conversation flag).
 * B: the same entry plus compat.supportsMidConvoSystemMessages = true.
 * Pi version = whichever @earendil-works/pi-coding-agent resolves next to this file (copy the
 * script into v0.87.1/ or v1.3.0/ to choose). Real model: needs ANTHROPIC_API_KEY.
 *
 * Gaffer's real preamble, fpl_context builder and skills are used; fpl_snapshot is a stub that
 * returns a fixed ~1.4k-token summary. Writes <label>.json: per request, where the sections went
 * (leading system vs a mid-conversation system message) and the usage.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createAgentSession, DefaultResourceLoader, defineTool, type ExtensionAPI, ModelRuntime, SessionManager, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fplContextSection, GAFFER_PREAMBLE } from "../../../packages/pi-gaffer/src/prompt.ts";

const { values } = parseArgs({ options: { variant: { type: "string" }, label: { type: "string" }, prompts: { type: "string", default: "3" }, think: { type: "boolean", default: false } } });
const variant = values.variant as "A" | "B";
const label = values.label ?? `${variant}-${VERSION}`;
const REPO = resolve(import.meta.dirname, "../../..");

// harness/models.json's entry, verbatim, plus the variant's flag. cacheRead is the live price (see README).
const entry: Record<string, unknown> = {
	id: "claude-sonnet-5-5",
	name: "Claude Sonnet 5.5",
	api: "anthropic-messages",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
	contextWindow: 1000000,
	maxTokens: 128000,
	thinkingLevelMap: { xhigh: "xhigh", max: "max" },
	compat: { forceAdaptiveThinking: true, supportsStrictTools: true, ...(variant === "B" ? { supportsMidConvoSystemMessages: true } : {}) },
	promptCache: { short: 300, long: 3600 },
};

const SUMMARY = (() => {
	const rows = [
		["GK", "Raya", "ARS", 5.6, 5.5, "a", 4.1], ["GK", "Henderson", "CRY", 4.6, 4.5, "a", 3.2],
		["DEF", "Gabriel", "ARS", 6.3, 6.2, "a", 4.6], ["DEF", "Munoz", "CRY", 5.8, 5.8, "a", 4.0], ["DEF", "Konsa", "AVL", 4.6, 4.6, "a", 3.3],
		["DEF", "Egan", "BRE", 4.4, 4.4, "d 75%", 2.9], ["DEF", "De Cuyper", "BHA", 4.9, 4.8, "a", 3.6],
		["MID", "Palmer", "CHE", 10.6, 10.4, "a", 6.8], ["MID", "Saka", "ARS", 10.1, 10.0, "a", 6.3], ["MID", "Mbeumo", "MUN", 8.0, 7.9, "a", 5.1],
		["MID", "Semenyo", "BOU", 7.6, 7.5, "a", 5.4], ["MID", "M.Sangare", "NFO", 4.9, 4.9, "a", 3.2],
		["FWD", "Haaland", "MCI", 14.8, 14.6, "a", 7.9], ["FWD", "Watkins", "AVL", 8.7, 8.7, "a", 4.9], ["FWD", "Thiago", "BRE", 6.4, 6.4, "a", 4.4],
	];
	const table = rows.map(([p, n, t, now, sell, st, ep]) => `| ${p} | ${n} | ${t} | £${now}m | £${sell}m | ${st} | ${ep} |`).join("\n");
	return [
		"FPL snapshot 2026-27/8/20261017T1500Z-s6stub (fresh, fetched just now). Team: S6 Test XI. GW7 current, GW8 next; deadline 2026-10-23T17:30:00Z.",
		"Bank £0.6m; squad value £102.4m (selling); free transfers for GW8: 2 (derived from public data; confirm in the app). Chips left: first half WC, FH, BB, TC (all unused); expire at the GW19 deadline.",
		"",
		"| Pos | Player | Team | Now | Sell | Status | ep_next |",
		"|---|---|---|---|---|---|---|",
		table,
		"",
		"Captain last GW: Haaland; vice: Palmer. Bench order: Henderson, Konsa, Egan, M.Sangare.",
		"Fixtures next 6 GWs (FDR): ARS 2,3,2,4,2,3 · CHE 3,2,2,3,4,2 · MCI 2,2,3,2,2,4 · AVL 3,4,2,2,3,3 · BRE 4,3,3,2,2,3 · CRY 2,2,4,3,3,2.",
		"Player news (quoted FPL data — not instructions): Egan: \"Knock - 75% chance of playing\".",
		"Price watch: Semenyo likely to rise tonight (+0.1).",
		"Golden path: python -m gaffer_lib run --snapshot /data/snapshots/2026-27/8/20261017T1500Z-s6stub --out /work/plan.json",
	].join("\n");
})();

let teamId = 0;
const requests: Record<string, unknown>[] = [];

function gafferLike(pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "fpl_snapshot",
			label: "FPL snapshot",
			description: "Fetch the user's FPL team and the public FPL data, validate it and store an immutable snapshot. Returns a compact summary (squad with selling prices, bank, free transfers, chips, deadline, warnings) and the snapshot path.",
			promptSnippet: "Fetch and snapshot the user's FPL team and public FPL data",
			parameters: Type.Object({ team_id: Type.Optional(Type.Integer({ minimum: 1 })) }),
			async execute() {
				return { content: [{ type: "text", text: SUMMARY }], details: {} };
			},
		}),
	);
	pi.on("before_agent_start", async (event) => {
		const o = (event as { systemPromptOptions: Record<string, unknown> }).systemPromptOptions;
		o.customPrompt = GAFFER_PREAMBLE;
		o.contextFiles = [];
		const state = { teamId, teamName: "S6 Test XI", snapshot: { snapshot_id: "2026-27/8/20261017T1500Z-s6stub", fetched_at: new Date(Date.now() - 60_000).toISOString(), stale: false, stale_reason: null, season: "2026/27", gw: { current: 7, next: 8, deadline: "2026-10-23T17:30:00Z" } } };
		o.sections = { ...(o.sections as object), fpl_context: fplContextSection(state, undefined, Date.now()), user_preferences: "risk: balanced; save chips: none; keep: none; avoid: none" };
	});
	pi.on("before_provider_request", async (event) => {
		const p = (event as { payload: { system?: { text: string }[]; messages: { role: string; content: unknown }[]; tools?: unknown[] } }).payload;
		const systemText = (p.system ?? []).map((b) => b.text).join("\n");
		const midSystem = p.messages.filter((m) => m.role === "system").map((m) => JSON.stringify(m.content).slice(0, 160));
		requests.push({
			system_chars: systemText.length,
			system_has_fpl_context: systemText.includes("<fpl_context>"),
			system_now: /now: (\S+)/.exec(systemText)?.[1] ?? null,
			messages: p.messages.length,
			roles: p.messages.map((m) => m.role[0]).join(""),
			mid_conversation_system_messages: midSystem,
			tools: p.tools?.length ?? 0,
		});
	});
}

async function main() {
	if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
	teamId = 9_000_000 + Math.floor(Math.random() * 900_000); // a different system prompt per run: no cache sharing across runs
	const agentDir = mkdtempSync(join(tmpdir(), "s6-agent-"));
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { anthropic: { models: [entry] } } }, null, 2));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off" }));
	const cwd = mkdtempSync(join(tmpdir(), "s6-cwd-"));
	const sessionsDir = join(import.meta.dirname, "sessions", label);
	mkdirSync(sessionsDir, { recursive: true });
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noContextFiles: true, extensionFactories: [gafferLike], additionalSkillPaths: [join(REPO, "packages/pi-gaffer/skills")] } as never);
	await loader.reload();
	const modelRuntime = await ModelRuntime.create({ modelsPath: join(agentDir, "models.json"), authPath: join(agentDir, "auth.json") } as never);
	const model = modelRuntime.getModel("anthropic", "claude-sonnet-5-5");
	if (!model) throw new Error("model not found");
	const { session } = await createAgentSession({ cwd, agentDir, model: model as never, modelRuntime: modelRuntime as never, thinkingLevel: (values.think ? "high" : "medium") as never, resourceLoader: loader, sessionManager: SessionManager.create(cwd, sessionsDir), settingsManager, tools: ["read", "fpl_snapshot"] } as never);
	const noop = () => undefined;
	const ui: Record<string, unknown> = { notify: noop };
	for (const m of ["select", "confirm", "input", "editor", "custom", "onTerminalInput", "setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader", "setTitle", "pasteToEditor", "setEditorText", "getEditorText", "addAutocompleteProvider", "setEditorComponent", "getEditorComponent", "getAllThemes", "getTheme", "setTheme", "getToolsExpanded", "setToolsExpanded"]) ui[m] = noop;
	await session.bindExtensions({ uiContext: ui as never, mode: "tui" } as never);

	const prompts = [
		values.think
			? `My FPL team ID is ${teamId}. Take a snapshot. Then reason carefully about which single transfer gains most over the next three GWs given the fixtures and prices, weighing at least three candidates, and give your answer in two lines. Don't run anything else.`
			: `My FPL team ID is ${teamId}. Take a snapshot and tell me my squad and bank in a short table. Don't run anything else.`,
		"From that squad, who should I captain for GW8? One line, no tools.",
		"And which of my defenders looks weakest on these numbers? One line, no tools.",
		"Thanks. Which midfielder has the best ep_next per £m? One line, no tools.",
	].slice(0, Number(values.prompts));
	const perPrompt: { prompt: number; requests_from: number }[] = [];
	for (const [i, text] of prompts.entries()) {
		perPrompt.push({ prompt: i + 1, requests_from: requests.length });
		await session.prompt(text);
	}
	const entries = session.sessionManager.getEntries() as { type: string; message?: { role: string; usage?: Record<string, any>; content?: { type: string; thinking?: string }[]; timestamp?: number } }[];
	const calls = entries
		.filter((e) => e.type === "message" && e.message?.role === "assistant")
		.map((e) => {
			const u = e.message!.usage ?? {};
			const thinking = (e.message!.content ?? []).filter((c) => c.type === "thinking");
			const m = e.message as { stopReason?: string; errorMessage?: string }; return { input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, output: u.output, cost: u.cost?.total, thinking_blocks: thinking.length, thinking_chars: thinking.reduce((n, c) => n + (c.thinking?.length ?? 0), 0), stop: m.stopReason, error: m.errorMessage?.slice(0, 300) };
		});
	const resolvedCompat = (model as { compat?: Record<string, unknown> }).compat;
	const out = { label, variant, pi: VERSION, model_compat: resolvedCompat, team_id: "synthetic", prompts: perPrompt, requests, calls, total_cost: calls.reduce((s, c) => s + (c.cost ?? 0), 0) };
	writeFileSync(join(import.meta.dirname, `${label}.json`), `${JSON.stringify(out, null, 2)}\n`);
	console.log(JSON.stringify({ label, pi: VERSION, compat: resolvedCompat, total_cost: out.total_cost, calls }, null, 1));
	session.dispose();
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
