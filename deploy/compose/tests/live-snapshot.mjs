// Drive the installed Gaffer package end to end inside the harness container, with a scripted (faux) model:
// /team <id> → fpl_snapshot with odds against the real FPL API and football-data.co.uk (gaffer_lib derive in
// the sandbox) → read the snapshot from the sandbox and try to write it → run the golden path
// (python -m gaffer_lib run) in the sandbox and time it.
//   docker compose exec -T -e TEAM_ID=1 [-e TEAM_ARGS="--ft 2"] [-e RUN_ARGS="--time-limit 1"] gaffer node --input-type=module - < tests/live-snapshot.mjs
// FR-DAT-09 with the odds source down: add -e FOOTBALL_DATA_BASE_URL=http://127.0.0.1:9/ (nothing listens there).
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent";
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(`${PI}/dist/index.js`);
const { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } = await import(`${PI}/node_modules/@earendil-works/pi-ai/dist/index.js`);

const teamId = Number(process.env.TEAM_ID ?? 1);
const agentDir = "/opt/pi-agent"; // the real install: pi-gaffer comes from settings.json
const cwd = "/work";
const GOLDEN_LIMIT_S = 60; // NFR-LAT-03
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
let snapshotPath = "";
let runCmd = "";
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("fpl_snapshot", { include: ["odds"] })),
	(ctx) => {
		const last = ctx.messages.at(-1);
		const text = (last.content ?? []).map((c) => c.text ?? "").join("");
		snapshotPath = /Path \(read-only in the sandbox\): (\S+)/.exec(text)?.[1] ?? "";
		runCmd = /run in the sandbox: (python -m gaffer_lib run .*)$/m.exec(text)?.[1] ?? "echo no-run-command";
		return fauxAssistantMessage(
			fauxToolCall("bash", {
				command: `cd ${snapshotPath} && ls && python -c "import json; p=json.load(open('picks.json')); print('picks', len(p['picks']), 'bank', p['entry_history']['bank']/10)" && echo tamper >> picks.json; echo append_exit=$?`,
			}),
		);
	},
	// The golden path, exactly as the snapshot summary gives it, timed inside the sandbox.
	() =>
		fauxAssistantMessage(
			fauxToolCall("bash", {
				command: `S=$(date +%s.%N); ${runCmd} ${process.env.RUN_ARGS ?? ""}; echo run_exit=$?; python -c "import time,sys; print('run_seconds=%.1f' % (time.time()-float(sys.argv[1])))" $S; echo cpus=$(cat /sys/fs/cgroup/cpu.max)`,
				timeout: 115,
			}),
		),
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
await session.prompt(`/team ${teamId} ${process.env.TEAM_ARGS ?? ""}`.trim());
console.log("/team:", notes.at(-1), `(${Date.now() - t0} ms)`);
await session.prompt("What should I do this week?");
for (const r of results) console.log(`\n--- ${r.tool}${r.isError ? " (ERROR)" : ""}\n${r.text}`);

const entries = readFileSync(session.sessionManager.getSessionFile(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const snap = entries.filter((e) => e.customType === "gaffer.snapshot").at(-1)?.data;
console.log("\n--- gaffer.snapshot entry (endpoint health)");
for (const ep of snap?.endpoints ?? []) console.log(`${ep.path.padEnd(36)} status=${ep.status} age=${ep.age} busted=${ep.cache_busted} cache=${ep.from_cache} retries=${ep.retries} ${ep.latency_ms}ms${ep.error ? ` error=${ep.error}` : ""}`);
session.dispose();

const fail = (msg) => {
	console.error(`FAIL: ${msg}`);
	process.exit(1);
};

// M2: the summary's free transfers and selling prices come from gaffer_lib derive in the sandbox.
console.log("\n--- derived:", JSON.stringify({ free_transfers: snap?.free_transfers, ft_source: snap?.ft_source, pending_transfers: snap?.pending_transfers }));
const summary = results.find((r) => r.tool === "fpl_snapshot")?.text ?? "";
if (!snap?.ft_source || !/Free transfers for GW\d+: /.test(summary) || /could not be derived/.test(summary)) fail("gaffer_lib derive did not run in the sandbox");

// M3: odds and ep_next in the snapshot entry, then the golden path through the real sandbox.
console.log("--- odds:", JSON.stringify(snap.odds), "ep_next:", JSON.stringify(snap.ep_next));
const index = JSON.parse(readFileSync(`${process.env.GAFFER_DATA_DIR ?? "/data"}/cache/index.json`, "utf8"));
const recorded = Object.entries(index)
	.filter(([k]) => k.startsWith("ep_next:"))
	.map(([k, v]) => `${k} -> ${v.snapshot} @ ${new Date(v.fetched_at).toISOString()}`);
console.log(`--- ep_next recorded before the deadline (FR-DAT-10):\n${recorded.join("\n")}`);
const run = results.filter((r) => r.tool === "bash").at(-1)?.text ?? "";
const seconds = Number(/run_seconds=([\d.]+)/.exec(run)?.[1] ?? Number.NaN);
if (!snap.odds?.requested) fail("the snapshot did not include the odds source");
if (!snap.ep_next?.before_deadline || !(snap.ep_next.players > 0) || !recorded.length) fail("ep_next was not recorded before the deadline (FR-DAT-10)");
if (!/^Gaffer plan for GW\d+/m.test(run) || !/run_exit=0/.test(run) || /\[INVALID/.test(run)) fail("the golden path did not produce a valid plan in the sandbox");
if (!(seconds <= GOLDEN_LIMIT_S)) fail(`the golden path took ${seconds} s (NFR-LAT-03 limit ${GOLDEN_LIMIT_S} s)`);
if (!snap.odds.available && !/odds unavailable — team strength from Dixon-Coles/.test(run)) fail("odds were unavailable but the plan has no FR-DAT-09 warning");
if (process.env.EXPECT && !new RegExp(process.env.EXPECT).test(run)) fail(`the run output does not match ${process.env.EXPECT}`);
console.log(`\n--- golden path: ${seconds} s in the sandbox (limit ${GOLDEN_LIMIT_S} s); odds ${snap.odds.available ? `available, ${snap.odds.fixtures} PL fixture(s) priced` : `unavailable (${snap.odds.reason})`}`);
