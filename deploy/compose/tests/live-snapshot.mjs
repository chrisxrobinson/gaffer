// Drive the installed Gaffer package end to end inside the harness container, with a scripted (faux) model:
// /team <id> → fpl_snapshot against the real FPL API → read the snapshot from the sandbox → try to write it.
//   docker compose exec -T -e TEAM_ID=1 gaffer node --input-type=module - < tests/live-snapshot.mjs
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent";
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(`${PI}/dist/index.js`);
const { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } = await import(`${PI}/node_modules/@earendil-works/pi-ai/dist/index.js`);

const teamId = Number(process.env.TEAM_ID ?? 1);
const agentDir = "/opt/pi-agent"; // the real install: pi-gaffer comes from settings.json
const cwd = "/work";
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
let snapshotPath = "";
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("fpl_snapshot", {})),
	(ctx) => {
		const last = ctx.messages.at(-1);
		const text = (last.content ?? []).map((c) => c.text ?? "").join("");
		snapshotPath = /Path \(read-only in the sandbox\): (\S+)/.exec(text)?.[1] ?? "";
		return fauxAssistantMessage(
			fauxToolCall("bash", {
				command: `cd ${snapshotPath} && ls && python -c "import json; p=json.load(open('picks.json')); print('picks', len(p['picks']), 'bank', p['entry_history']['bank']/10)" && echo tamper >> picks.json; echo append_exit=$?`,
			}),
		);
	},
	fauxAssistantMessage(fauxText("done")),
]);

const settingsManager = SettingsManager.create(cwd, agentDir);
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true, extensionFactories: [(pi) => pi.registerProvider(faux.provider)] });
await loader.reload();
const sessionDir = mkdtempSync(join(tmpdir(), "gaffer-live-"));
const { session } = await createAgentSession({
	cwd,
	agentDir,
	model: faux.getModel(),
	resourceLoader: loader,
	sessionManager: SessionManager.create(cwd, sessionDir),
	settingsManager,
	tools: ["read", "write", "edit", "bash", "fpl_snapshot", "submit_recommendation", "set_preferences"],
});
const notes = [];
const noop = () => undefined;
const ui = { notify: (m, t) => notes.push(`${t}: ${m}`) };
for (const m of ["select", "confirm", "input", "editor", "custom", "setStatus", "setWidget", "setTitle", "setWorkingMessage", "setWorkingVisible"]) ui[m] = noop;
await session.bindExtensions({ uiContext: ui, mode: "tui" });
console.log("active tools:", session.getActiveToolNames().join(", "));

const results = [];
session.subscribe((e) => {
	if (e.type === "tool_execution_end") results.push({ tool: e.toolName, isError: e.isError, text: e.result?.content?.map((c) => c.text).join("") ?? "" });
});
const t0 = Date.now();
await session.prompt(`/team ${teamId}`);
console.log("/team:", notes.at(-1), `(${Date.now() - t0} ms)`);
await session.prompt("What's my squad and bank?");
for (const r of results) console.log(`\n--- ${r.tool}${r.isError ? " (ERROR)" : ""}\n${r.text}`);

const entries = readFileSync(session.sessionManager.getSessionFile(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const snap = entries.filter((e) => e.customType === "gaffer.snapshot").at(-1)?.data;
console.log("\n--- gaffer.snapshot entry (endpoint health)");
for (const ep of snap?.endpoints ?? []) console.log(`${ep.path.padEnd(28)} status=${ep.status} age=${ep.age} busted=${ep.cache_busted} cache=${ep.from_cache} retries=${ep.retries} ${ep.latency_ms}ms`);
session.dispose();
