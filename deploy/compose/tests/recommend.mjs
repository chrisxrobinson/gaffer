// M4 through the installed package inside the harness container, with a scripted (faux) model and the
// real FPL API, sandbox and solver:
//   /team <id> → fpl_snapshot with odds → the golden path in the sandbox → submit_recommendation
//   (schema, gaffer_lib validate in the sandbox, recompute) → gaffer.recommendation + ledger →
//   /export-rec → replay → /prefs.
// The scripted model submits plan 1 of /work/plan.json, as the gaffer-workflow skill describes; first with
// a deliberately wrong figure and an illegal captaincy, so the rejection path runs against real data too.
//   docker compose exec -T -e TEAM_ID=1 gaffer node --input-type=module - < tests/recommend.mjs
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PI = "/opt/pi/node_modules/@earendil-works/pi-coding-agent";
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(`${PI}/dist/index.js`);
const { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } = await import("/opt/pi/node_modules/@earendil-works/pi-ai/dist/index.js");
const { findRun, replay } = await import("/opt/pi-gaffer/src/replay.ts");
const { providerFromEnv, SandboxSession } = await import("/opt/pi-gaffer/src/sandbox.ts");

const SANDBOX = process.env.SANDBOX_URL ?? "http://sandbox:8080";
const DATA = process.env.GAFFER_DATA_DIR ?? "/data";
const teamId = Number(process.env.TEAM_ID ?? 1);
const agentDir = "/opt/pi-agent";
const cwd = "/work";
const fail = (msg) => {
	console.error(`FAIL: ${msg}`);
	process.exit(1);
};
const sh = async (command, timeout_s = 110) => {
	const r = await fetch(`${SANDBOX}/exec`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command, timeout_s }) });
	let out = "";
	for (const line of (await r.text()).split("\n").filter(Boolean)) {
		const m = JSON.parse(line);
		if (m.data) out += Buffer.from(m.data, "base64").toString();
	}
	return out;
};

const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
const settingsManager = SettingsManager.create(cwd, agentDir);
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true, extensionFactories: [(pi) => pi.registerProvider(faux.provider)] });
await loader.reload();
const sessionDir = mkdtempSync(join(tmpdir(), "gaffer-m4-"));
const { session } = await createAgentSession({
	cwd, agentDir, model: faux.getModel(), resourceLoader: loader, sessionManager: SessionManager.create(cwd, sessionDir), settingsManager,
	tools: ["read", "write", "edit", "bash", "fpl_snapshot", "submit_recommendation", "set_preferences"],
});
const notes = [];
const ui = { notify: (m, t) => notes.push(`${t}: ${m}`) };
for (const m of ["select", "confirm", "input", "editor", "custom", "setStatus", "setWidget", "setTitle", "setWorkingMessage", "setWorkingVisible", "setHeader", "setFooter", "addAutocompleteProvider", "setEditorComponent"]) ui[m] = () => undefined;
await session.bindExtensions({ uiContext: ui, mode: "tui" });
const results = [];
session.subscribe((e) => {
	if (e.type === "tool_execution_end") results.push({ tool: e.toolName, isError: e.isError, text: e.result?.content?.map((c) => c.text).join("") ?? "", details: e.result?.details });
});
const entries = () => readFileSync(session.sessionManager.getSessionFile(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const custom = (type) => entries().filter((e) => e.customType === type).map((e) => e.data);

console.log("active tools:", session.getActiveToolNames().join(", "));
if (session.getActiveToolNames().length !== 7) fail("expected exactly 7 tools");
const skills = /<available_skills>[\s\S]*<\/available_skills>/.exec(session.systemPrompt ?? "")?.[0] ?? "";

// 1. Snapshot and golden path.
let runCmd = "";
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("fpl_snapshot", { include: ["odds"] })),
	(ctx) => {
		const text = (ctx.messages.at(-1).content ?? []).map((c) => c.text ?? "").join("");
		runCmd = /run in the sandbox: (python -m gaffer_lib run .*)$/m.exec(text)?.[1] ?? "echo no-run-command";
		return fauxAssistantMessage(fauxToolCall("bash", { command: `${runCmd} ${process.env.RUN_ARGS ?? ""}; echo run_exit=$?`, timeout: 115 }));
	},
	fauxAssistantMessage(fauxText("planned")),
]);
await session.prompt(`/team ${teamId} ${process.env.TEAM_ARGS ?? ""}`.trim());
console.log("/team:", notes.at(-1)?.replace(/Team set: .* \(ID/, "Team set: <name> (ID"));
let t0 = Date.now();
await session.prompt("What should I do this week?");
const golden = results.filter((r) => r.tool === "bash").at(-1)?.text ?? "";
console.log(`\n--- golden path (${((Date.now() - t0) / 1000).toFixed(1)} s for snapshot + run): ${runCmd}`);
console.log(golden.split("\n").filter((l) => /^(Gaffer plan|Start:|Solver:|Confidence:|Plan \d|Chip scenarios|  (Wildcard|Free Hit|Bench Boost|Triple Captain)|run_exit)/.test(l)).join("\n"));
if (!/run_exit=0/.test(golden)) fail("the golden path did not produce a valid plan");

// 2. The submission a model following the workflow makes: plan 1 of /work/plan.json.
const plan = await fetch(`${SANDBOX}/files?path=/work/plan.json`).then((r) => r.json());
const p1 = plan.plans[0];
const g0 = p1.gws[0];
const good = {
	transfers: p1.transfers.map((t) => ({ out: { id: t.out.id }, in: { id: t.in.id }, rationale: "The solver's best move on fixtures and minutes.", xp_gain_4gw: t.xp_gain_4gw, xp_gain_6gw_decayed: t.xp_gain_6gw_decayed })),
	captain: { id: g0.captain, xp: 99 }, // a deliberately wrong figure (FR-REC-07)
	vice_captain: { id: g0.vice_captain },
	starting_xi: g0.xi, bench: g0.bench, expected_points_gw: g0.expected_points,
	chip: { play: null, rationale: "No chip is recommended this week." },
	plan: p1.gws.slice(0, 4).map((s) => ({ gw: s.gw, transfers: s.transfers.map((t) => ({ out: { id: t.out }, in: { id: t.in } })), chip: s.chip, captain: s.captain })),
	summary: "Stack check: plan 1 of the golden path, submitted by a scripted model.",
	confidence: { overall: "high" }, // the model can't raise confidence (FR-REC-06)
};
const illegal = { ...good, vice_captain: { id: g0.captain } };
// The model's code can write to /work. A gaffer_lib left there must not be what the gate runs.
await sh("mkdir -p /work/gaffer_lib && printf 'raise SystemExit(\"SHADOWED: the gate imported gaffer_lib from /work\")\\n' > /work/gaffer_lib/__init__.py && cp /work/gaffer_lib/__init__.py /work/gaffer_lib/__main__.py");
const shadowed = await sh("cd /work && python -m gaffer_lib derive --snapshot /nonexistent 2>&1 | tail -1");
console.log(`\n--- /work/gaffer_lib planted; a non-isolated run from /work prints: ${shadowed.trim()}`);
if (!/SHADOWED/.test(shadowed)) fail("the shadow package was not picked up by a non-isolated run, so the check proves nothing");

faux.setResponses([
	fauxAssistantMessage(fauxToolCall("submit_recommendation", illegal)),
	fauxAssistantMessage(fauxToolCall("submit_recommendation", good)),
	fauxAssistantMessage(fauxText("SHOULD NOT BE REACHED")),
]);
t0 = Date.now();
await session.prompt("Submit it.");
const submitMs = Date.now() - t0;
await sh("rm -rf /work/gaffer_lib");
const subs = results.filter((r) => r.tool === "submit_recommendation");
console.log(`\n--- submit attempt 1 (illegal on purpose)\n${subs[0]?.text}`);
if (!subs[0]?.isError || !/\[CAPTAIN_IS_VICE\]/.test(subs[0].text)) fail("the illegal submission was not rejected with CAPTAIN_IS_VICE");
if (subs.length !== 2 || subs[1].isError) fail(`the valid submission was not accepted: ${subs[1]?.text}`);
if (faux.getPendingResponseCount() !== 1) fail("the run did not terminate on the successful submit");
console.log(`\n--- submit attempt 2 (accepted; both attempts took ${(submitMs / 1000).toFixed(1)} s)\n${subs[1].text}`);

const rec = custom("gaffer.recommendation").at(-1);
if (!rec) fail("no gaffer.recommendation entry");
const snap = custom("gaffer.snapshot").at(-1);
const wide = Math.max(...subs[1].text.split("\n").map((l) => [...l].length));
console.log(`\n--- checks`);
console.log(`rec_id ${rec.rec_id}; GW${rec.gw}; snapshot ${rec.snapshot.id}; gaffer_lib ${rec.gaffer_lib}; pi ${rec.pi}; model ${rec.model}`);
console.log(`widest rendered line: ${wide} columns`);
console.log(`validation: ${JSON.stringify(rec.validation)}`);
console.log(`confidence: ${rec.confidence.overall} (${rec.confidence.drivers.join("; ")})`);
console.log(`chip scenarios: ${rec.chip.scenarios.map((s) => `${s.chip}${s.gw ? `@GW${s.gw}` : ""}:${s.evaluated ? `+${s.delta_xp}` : `not evaluated (${s.reason})`}`).join(" | ")}`);
if (rec.snapshot.id !== snap.snapshot_id || rec.team_id_hash !== snap.team_id_hash) fail("the recommendation does not refer to the run's snapshot");
if (rec.validation.attempts !== 2 || rec.validation.max_model_number_drift < 50 || !rec.validation.drift.some((d) => d.path === "captain.xp")) fail("the wrong captain.xp was not corrected and reported");
if (rec.captain.xp > 20) fail("the model's captain.xp survived");
if (rec.confidence.overall === "high" && !(rec.validation.margin >= 2)) fail("the model raised the confidence");
if (wide > 100) fail("the rendering is wider than 100 columns");
if (rec.plan.length !== 4) fail("the plan does not have 4 GWs");
const chips = new Set(rec.chip.scenarios.map((s) => s.chip));
if (!["wildcard", "freehit", "bboost", "3xc"].every((c) => chips.has(c))) fail("a chip type has no scenario entry");
const ledger = readFileSync(`${DATA}/ledger/recommendations.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
if (ledger.at(-1).rec_id !== rec.rec_id) fail("the ledger index has no row for the recommendation");
console.log(`ledger: ${ledger.length} row(s), last ${JSON.stringify(ledger.at(-1))}`);

// 3. /export-rec, replay, /prefs.
await session.prompt("/export-rec");
const file = /exported to (\S+)/.exec(notes.at(-1) ?? "")?.[1];
console.log(`\n/export-rec: ${notes.at(-1)}`);
if (!file || JSON.stringify(JSON.parse(readFileSync(file, "utf8"))) !== JSON.stringify(rec)) fail("the export is not identical to the session entry");
console.log(`EXPORT_FILE=${file}`);

const stored = findRun(sessionDir, rec.rec_id);
const r = await replay(stored, new SandboxSession(providerFromEnv()));
console.log(`replay: ${r.reproduced ? `REPRODUCED, ${r.numbers} numbers identical` : `NOT REPRODUCED: ${r.differences.slice(0, 5).join("; ")}`}`);
if (!r.reproduced) fail("replay did not reproduce the recommendation");

await session.prompt("/prefs");
console.log(`/prefs: ${notes.at(-1)?.replace(/\n/g, " | ")}`);

// NFR-PRIV-01: no raw team id (as a JSON value or in a path) or team name under ledger, users or exports.
const teamName = custom("gaffer.team").at(-1)?.team_name;
let scanned = 0;
for (const sub of ["ledger", "users", "exports"]) {
	if (!existsSync(`${DATA}/${sub}`)) continue;
	for (const f of readdirSync(`${DATA}/${sub}`, { recursive: true })) {
		const full = `${DATA}/${sub}/${f}`;
		let text;
		try {
			text = readFileSync(full, "utf8");
		} catch {
			continue;
		}
		scanned++;
		if (new RegExp(`"(team_id|entry|team)":\\s*${teamId}\\b`).test(text) || (teamName && text.includes(teamName)) || full.includes(`/${teamId}/`)) fail(`${full} holds the raw team id or the team name`);
	}
}
console.log(`privacy: ${scanned} file(s) under ledger/, users/ and exports/ hold no raw team id or team name`);
console.log(`skills offered: ${[...skills.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1]).join(", ")}`);
session.dispose();
console.log("\nM4 stack check passed");
