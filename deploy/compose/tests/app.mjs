// The Gaffer App's bridge in the built image (ADR 0014, M1.1-3), run inside the harness container:
//   docker compose exec -T gaffer node --input-type=module - < tests/app.mjs
// 1. NFR-SEC-05/07 against the running gaffer-web (port 7682): RPC commands, paths, origins and prompts refused,
//    with no Pi process started and no session written.
// 2. A Recommend run through a bridge over gaffer-pi --mode rpc, with a scripted (faux) model and the real FPL
//    API, sandbox, golden path and gate: FR-UI-08 (the /gw template; save_chips and keep in the result; no
//    wildcard), FR-UI-09's events in order (snapshot, tagged plan step, a rejected and a passed check), FR-UI-11
//    (the export is the stored entry), NFR-LAT-04 (bridge → client p95), the run lock while it runs, and the
//    session lock against a second Pi (NFR-REL-03, FR-UI-12), with the terminal's --continue pick.
// 3. M1.1-4: the fuzz over the other actions' fields (unknown actions, names or markup for ids, GWs and ranges
//    outside the season); a follow-up in the Recommend run's session (FR-UI-13); a What-if that answers in text
//    through the /whatif template (FR-UI-08); a Preferences save through Pi with no model call, read back by the
//    team check; the scorecard endpoint.
// Scratch dirs under /data (the sandbox reads snapshots there), removed afterwards. RECORD=<dir> also writes the
// run's event stream and session file there (the App's test fixtures).
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";

const PI = "/opt/pi/node_modules/@earendil-works/pi-coding-agent";
const { RpcClient } = await import(`${PI}/dist/index.js`);
const { createBridge, historyOf } = await import("/opt/packages/gaffer-web/src/bridge.ts");
const results = [];
const check = (ok, what, detail = "") => {
	results.push(ok);
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${!ok && detail ? `\n     ${String(detail).slice(0, 600)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Pi processes in RPC mode in this container (the image has no ps). */
const piProcs = () =>
	readdirSync("/proc").filter((p) => /^\d+$/.test(p)).filter((p) => {
		try {
			return readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0").join(" ").includes("--mode rpc");
		} catch {
			return false;
		}
	}).length;

// ---------------------------------------------------------------------------------------------------------
// 1. The running bridge refuses everything outside its API, before anything runs.
const ip = execFileSync("node", ["/opt/gaffer/egress-ip.mjs"], { encoding: "utf8" }).trim();
const live = (method, path, body = "", headers = {}) =>
	new Promise((ok) => {
		const req = request({ host: ip, port: 7682, method, path, headers: { host: "127.0.0.1:7682", "content-type": "application/json", ...headers } }, (res) => {
			let data = "";
			res.on("data", (c) => (data += c));
			res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body: data }));
		});
		req.on("error", (e) => ok({ status: 0, body: e.message }));
		req.end(body);
	});
const origin = { origin: "http://127.0.0.1:7682" };
const sessionsBefore = readdirSync("/sessions").length;
const procsBefore = piProcs();
const page = await live("GET", "/");
check(page.status === 200 && /script-src 'self' 'sha256-/.test(page.headers["content-security-policy"] ?? "") && /frame-ancestors 'none'/.test(page.headers["content-security-policy"] ?? ""), "the App's page is served with its content security policy", page.status);
const RPC = ["bash", "export_html", "switch_session", "new_session", "fork", "clone", "compact", "set_model", "set_thinking_level", "get_commands", "abort_bash", "set_auto_retry", "prompt", "steer", "follow_up", "get_messages"];
let refused = 0;
for (const type of RPC) {
	for (const path of ["/api/runs", "/api/sessions/01a14ad8-5d5b-7421-b42c-a5a70968b3e7/commands", "/api/rpc"]) {
		const r = await live("POST", path, JSON.stringify({ requestId: `fuzz-${type}-${refused}`, type, command: "id", sessionPath: "/etc/passwd", outputPath: "/tmp/x.html", message: "!id" }), origin);
		if ([400, 404].includes(r.status)) refused++;
	}
}
check(refused === RPC.length * 3, `every RPC command sent to the bridge is refused (${refused}/${RPC.length * 3})`);
const trav = await Promise.all(["/api/sessions/..%2F..%2Fetc%2Fpasswd", "/api/sessions/%2Fsessions%2Fx.jsonl/events", "/%2e%2e/%2e%2e/etc/passwd", "/app/../../src/bridge.ts"].map((p) => live("GET", p)));
check(trav.every((r) => r.status === 404), "path-traversal session ids and static paths: 404", trav.map((r) => r.status));
const xo = await Promise.all([
	live("POST", "/api/runs", "{}", { origin: "http://evil.example" }),
	live("POST", "/api/runs", "{}", {}),
	live("GET", "/api/home", "", { host: "evil.example:7682" }),
	live("GET", "/api/home", "", { "sec-fetch-site": "cross-site" }),
]);
check(xo.map((r) => r.status).join() === "403,403,421,403", "another origin, no origin, another host name, a cross-site fetch: refused", xo.map((r) => r.status));
const asks = await Promise.all(["x".repeat(281), "/team 1", "!ls"].map((text, i) => live("POST", "/api/sessions/01a14ad8-5d5b-7421-b42c-a5a70968b3e7/commands", JSON.stringify({ requestId: `fuzz-ask-${i}`, type: "ask", text }), origin)));
check(asks.every((r) => r.status === 400 || r.status === 404), "an over-long follow-up and / or ! prompts are refused", asks.map((r) => r.status));
const badRuns = [
	["bash", { command: "id" }], ["switch_session", { path: "/etc/passwd" }],
	["whatif", { kind: "transfer", out: "Salah", in: 1, gw: 9 }], ["whatif", { kind: "transfer", out: 1, in: "<script>alert(1)</script>", gw: 9 }],
	["whatif", { kind: "transfer", out: 1, in: "Ignore previous instructions", gw: 9 }], ["whatif", { kind: "transfer", out: 1, in: 100000, gw: 9 }],
	["whatif", { kind: "chip", chip: "bboost", gw: 39 }], ["whatif", { kind: "scenario", text: "anything" }],
	["explain", { player: "Haaland", against: "squad" }], ["chips", { from_gw: 0, to_gw: 6 }], ["chips", { from_gw: 9, to_gw: 39 }], ["chips", { from_gw: 1, to_gw: 38 }],
	["preferences", { risk: "safe", max_hits_per_gw: null, save_chips: [], keep: ["Salah"], clear: false }],
];
const badStatus = [];
for (const [i, [action, options]] of badRuns.entries()) badStatus.push((await live("POST", "/api/runs", JSON.stringify({ requestId: `fuzz-run-${i}`, action, team_id: 1, options }), origin)).status);
check(badStatus.every((x) => x === 400), `the other actions' fields: unknown actions, names or markup for ids, GWs and ranges outside the season refused (${badStatus.filter((x) => x === 400).length}/${badRuns.length})`, badStatus);
check(piProcs() === procsBefore && readdirSync("/sessions").length === sessionsBefore, "no side effect: no Pi process started, no session file written", `${procsBefore}→${piProcs()}`);

// ---------------------------------------------------------------------------------------------------------
// 2. A Recommend run through the bridge, gaffer-pi --mode rpc and a scripted model.
const root = mkdtempSync("/data/verify-app-");
chmodSync(root, 0o755); // the sandbox reads the snapshots as another user
const sessions = join(root, "sessions");
const data = join(root, "data");
mkdirSync(sessions);
mkdirSync(data);
Object.assign(process.env, { GAFFER_SESSIONS_DIR: sessions, GAFFER_SESSIONS_ROOT: sessions, GAFFER_DATA_DIR: data });
const faux = join(root, "faux.ts");
writeFileSync(faux, `import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
const SANDBOX = process.env.SANDBOX_URL ?? "http://sandbox:8080";
const textOf = (m) => typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => c.text ?? "").join("");
async function submission(liar) {
	const plan = await fetch(SANDBOX + "/files?path=/work/plan.json").then((r) => r.json());
	const p1 = plan.plans[0], g0 = p1.gws[0];
	return {
		transfers: p1.transfers.map((t) => ({ out: { id: t.out.id }, in: { id: t.in.id }, rationale: "The solver's best move on fixtures and minutes." })),
		captain: { id: g0.captain }, vice_captain: { id: liar ? g0.captain : g0.vice_captain },
		starting_xi: g0.xi, bench: g0.bench, chip: { play: null, rationale: "No chip this week: keep them for better weeks." },
		plan: p1.gws.slice(0, 4).map((s) => ({ gw: s.gw, transfers: s.transfers.map((t) => ({ out: { id: t.out }, in: { id: t.in } })), chip: s.chip, captain: s.captain })),
		summary: "Stack check: plan 1 of the golden path, from a scripted model.",
	};
}
const brain = async (ctx) => {
	const last = ctx.messages.at(-1);
	const users = ctx.messages.filter((m) => m.role === "user").map(textOf);
	// A follow-up about the result: answered in text, no tools (FR-UI-13).
	if (last?.role === "user" && users.length > 1) return fauxAssistantMessage([fauxText("**Because his 7.9 xP is the highest.** The vice is next at 6.4.")]);
	// A what-if (the /whatif template): the snapshot and the golden path, then an answer in text, never a submission.
	if (users[0]?.startsWith("What if:") && last?.role === "toolResult" && last.toolName === "bash") return fauxAssistantMessage([fauxText("**Not worth it.**\\n\\n| Plan | xP 4 GW |\\n|---|---|\\n| Best | 214.6 |\\n| With it | 211.9 |")]);
	if (last?.role === "toolResult" && last.toolName === "fpl_snapshot") {
		const cmd = /run in the sandbox: (python -m gaffer_lib run .*)$/m.exec(textOf(last))?.[1] ?? "echo no-run-command";
		return fauxAssistantMessage([fauxThinking("The snapshot is fresh. Next the golden path, exactly as the summary gives it."), fauxText("Projecting points and solving."), fauxToolCall("bash", { command: cmd, timeout: 115 })]);
	}
	if (last?.role === "toolResult" && last.toolName === "bash") return fauxAssistantMessage([fauxThinking("Plan 1 it is. Submitting."), fauxToolCall("submit_recommendation", await submission(true))]);
	if (last?.role === "toolResult" && last.toolName === "submit_recommendation" && last.isError) return fauxAssistantMessage([fauxThinking("Rejected: the vice can't be the captain. Fixing that and resubmitting."), fauxToolCall("submit_recommendation", await submission(false))]);
	if (last?.role === "toolResult") return fauxAssistantMessage([fauxText("(done)")]);
	return fauxAssistantMessage([fauxThinking("A recommendation: snapshot with odds first."), fauxText("Fetching your team and this week's data."), fauxToolCall("fpl_snapshot", { include: ["odds"] })]);
};
export default function (pi) {
	const f = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: true, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }], tokensPerSecond: 300 });
	f.setResponses(Array.from({ length: 20 }, () => brain));
	pi.registerProvider(f.provider);
}
`);
const launch = (sessionPath) =>
	execFileSync("/opt/gaffer/gaffer-pi", ["--mode", "rpc", ...(sessionPath ? ["--session", sessionPath] : [])], { env: { ...process.env, GAFFER_PI_PRINT: "1", GAFFER_MODEL: "", GAFFER_PROVIDER: "" }, encoding: "utf8" }).trim().split("\n");
const rpc = (sessionPath, env = {}) => {
	const client = new RpcClient({ cliPath: "/usr/local/bin/pi", cwd: "/work", args: [...launch(sessionPath), "--provider", "faux", "--model", "faux-1", "-e", faux], env });
	return Object.assign(client, { cancelDialog: (id) => client.process?.stdin?.write(`${JSON.stringify({ type: "extension_ui_response", id, cancelled: true })}\n`) });
};
const bridge = createBridge({ sessionsDir: sessions, dataDir: data, publicDir: "/opt/packages/gaffer-web/public", spawnPi: (p) => rpc(p) });
await new Promise((r) => bridge.server.listen(0, "127.0.0.1", r));
const host = `127.0.0.1:${bridge.server.address().port}`;
const apiOn = (b, method, path, body) =>
	new Promise((ok) => {
		const h = `127.0.0.1:${b.server.address().port}`;
		const req = request({ host: "127.0.0.1", port: b.server.address().port, method, path, headers: { host: h, origin: `http://${h}`, "content-type": "application/json" } }, (res) => {
			let d = "";
			res.on("data", (c) => (d += c));
			res.on("end", () => {
				let json;
				try {
					json = JSON.parse(d);
				} catch {
					json = d;
				}
				ok({ status: res.statusCode, body: json });
			});
		});
		req.end(body ? JSON.stringify(body) : "");
	});
const api = (method, path, body) => apiOn(bridge, method, path, body);

try {
	const teamId = Number(process.env.TEAM_ID ?? 1);
	const home = await api("GET", "/api/home");
	check(home.status === 200 && Number.isInteger(home.body.gw?.next), `home: next GW ${home.body.gw?.next}, deadline ${home.body.gw?.deadline}`, JSON.stringify(home.body).slice(0, 300));
	let t0 = Date.now();
	const missing = await api("GET", "/api/team/999999999");
	check(missing.status === 404 && missing.body.error === "not found" && Date.now() - t0 < 10_000, `FR-UI-08: a team that doesn't exist is "not found" in ${Date.now() - t0} ms`, JSON.stringify(missing));
	const team = await api("GET", `/api/team/${teamId}`);
	check(team.status === 200 && team.body.squad?.length === 15, `the team check: ${team.body.squad?.length} players in the squad`, JSON.stringify(team.body).slice(0, 300));
	const keep = team.body.squad.find((p) => p.position === "MID") ?? team.body.squad[5];

	// The run, its stream and the latency of every event (NFR-LAT-04).
	t0 = Date.now();
	const started = await api("POST", "/api/runs", { requestId: "verify-app-run-1", team_id: teamId, options: { risk: "balanced", max_hits_per_gw: 1, save_chips: ["wildcard"], keep: [keep.id], save: false } });
	check(started.status === 201 && /^[0-9a-f-]{36}$/.test(started.body.id), `POST /api/runs → ${started.status} in ${Date.now() - t0} ms (the run has started)`, JSON.stringify(started.body));
	const id = started.body.id;
	const events = [];
	const lat = [];
	let settled = false;
	const stream = request({ host: "127.0.0.1", port: bridge.server.address().port, path: `/api/sessions/${id}/events?after=0`, headers: { host } }, (res) => {
		let buf = "";
		res.on("data", (c) => {
			buf += c;
			let k;
			while ((k = buf.indexOf("\n\n")) >= 0) {
				const frame = buf.slice(0, k);
				buf = buf.slice(k + 2);
				const d = /^data: (.*)$/m.exec(frame)?.[1];
				if (!d) continue;
				const e = JSON.parse(d);
				lat.push(Date.now() - e.at);
				events.push({ t: Date.now() - t0, rec: e });
				if (e.type === "agent_settled") settled = true;
			}
		});
	});
	stream.end();
	// While it runs, the run lock refuses a second run (one per harness), and says who holds it.
	await sleep(1500);
	const busy = await api("GET", "/api/home");
	const second = await api("POST", "/api/runs", { requestId: "verify-app-run-2", team_id: teamId, options: { risk: "safe", max_hits_per_gw: null, save_chips: [], keep: [], save: false } });
	check(busy.body.busy?.ui === "app" && second.status === 409 && /A run is in progress in the Gaffer App/.test(second.body.error), "the run lock: a second run is refused while the first runs", `${JSON.stringify(busy.body.busy)} ${second.status} ${second.body.error}`);
	for (let i = 0; i < 480 && !settled; i++) await sleep(500);
	stream.destroy();
	check(settled, `the run settled in ${((Date.now() - t0) / 1000).toFixed(1)} s with ${events.length} events`);

	const order = [];
	for (const e of events) {
		const r = e.rec;
		if (r.type === "tool_execution_end" && r.toolName === "fpl_snapshot" && !r.isError) order.push("snapshot");
		if (r.type === "tool_execution_end" && r.toolName === "bash" && r.result?.details?.step === "plan") order.push(`plan:${r.result.details.plans}`);
		if (r.type === "entry_appended" && r.entry?.customType === "gaffer.validation") order.push(r.entry.data.passed ? "check:passed" : `check:failed:${r.entry.data.errors?.[0]?.code}`);
		if (r.type === "tool_execution_end" && r.toolName === "submit_recommendation") order.push(r.isError ? "submit:err" : "submit:ok");
	}
	const bashEnd = events.find((e) => e.rec.type === "tool_execution_end" && e.rec.toolName === "bash")?.rec;
	check(/^snapshot,plan:\d,(check:failed:CAPTAIN_IS_VICE,submit:err|submit:err,check:failed:CAPTAIN_IS_VICE),check:passed,submit:ok$/.test(order.join()), `FR-UI-09 on the wire: ${order.join(" → ")}`, JSON.stringify(bashEnd?.result?.details) + " " + String(bashEnd?.result?.content).slice(-400));
	const progress = events.filter((e) => e.rec.type === "tool_execution_update" && /^progress: main solve \d+ s of \d+ s$/m.test(e.rec.partialResult?.content ?? ""));
	check(progress.length > 0, `golden-path progress streamed (${progress.length} updates with "main solve … s of … s")`);
	const sorted = [...lat].sort((a, b) => a - b);
	const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
	check(p95 <= 500, `NFR-LAT-04: ${lat.length} events, bridge → client p50 ${sorted[Math.floor(sorted.length / 2)]} ms, p95 ${p95} ms, max ${sorted.at(-1)} ms`);

	// The stored session: the /gw template, the preferences, the export, no progress lines for the model.
	const file = readdirSync(sessions).filter((f) => f.endsWith(".jsonl")).map((f) => join(sessions, f))[0];
	const lines = readFileSync(file, "utf8").trim().split("\n");
	const entries = lines.map((l) => JSON.parse(l));
	const template = readFileSync("/opt/pi-gaffer/prompts/gw.md", "utf8").split("---\n")[2].replace(/\n$/, "").replace("$@", "");
	const users = entries.filter((e) => e.type === "message" && e.message.role === "user").map((e) => e.message.content.map((c) => c.text).join(""));
	check(users.length === 1 && users[0] === template, "FR-UI-08: the run's prompt is the /gw template", users[0]?.slice(0, 120));
	const recLine = lines.find((l) => l.includes('"customType":"gaffer.recommendation"')) ?? "{}";
	const rec = JSON.parse(recLine).data ?? { preferences: { save_chips: [], keep: [] }, starting_xi: [], bench: [], chip: {} };
	check(rec.preferences.save_chips.includes("wildcard") && rec.preferences.keep.some((k) => k.id === keep.id) && rec.chip.play !== "wildcard" && rec.starting_xi.concat(rec.bench).includes(keep.id), `FR-UI-08: the recommendation lists save_chips [wildcard] and keeps ${keep.name}, plays no wildcard`, JSON.stringify(rec.preferences));
	const fromStream = events.find((e) => e.rec.type === "tool_execution_end" && e.rec.result?.details?.recommendation)?.rec.result.details.recommendation;
	// While its Pi is open the page has the run from the stream (the history stops where the run began).
	const view = await api("GET", `/api/sessions/${id}`);
	check(recLine.includes(`"data":${JSON.stringify(fromStream)},`) && view.body.live && !view.body.history.some((e) => e.customType === "gaffer.recommendation"), "FR-UI-11: the JSON export from the live stream is the stored entry byte for byte");
	check(!lines.some((l) => l.includes('"role":"toolResult"') && l.includes("progress: ")), "the progress lines are not in what the model read");
	check(existsSync(join(data, "users")) && !readdirSync(join(data, "users")).some((d) => existsSync(join(data, "users", d, "prefs.json"))), "options not saved as preferences: only this session's own file");

	// NFR-REL-03 / FR-UI-12: the App's Pi still holds the session; a second Pi (the terminal) opens it read-only.
	const before = readFileSync(file);
	const pick = execFileSync("node", ["/opt/pi-gaffer/scripts/continue-session.ts", sessions], { encoding: "utf8" }).trim();
	check(pick === "", "the terminal's --continue does not pick the session the App holds", pick);
	const term = rpc(file, { GAFFER_UI: "terminal" });
	const seen = [];
	term.onEvent((e) => seen.push(e));
	await term.start();
	await term.getState();
	await term.prompt("Hello from the terminal").catch((e) => seen.push({ type: "error", message: e.message }));
	await sleep(500);
	await term.stop();
	const notice = seen.find((e) => e.method === "notify" && /read-only here/.test(e.message ?? ""));
	check(seen.some((e) => e.method === "setStatus" && e.statusKey === "gaffer-lock" && /open in the Gaffer App/.test(e.statusText ?? "")) && notice && !seen.some((e) => e.type === "agent_start"), "a second writer is refused with a notice and never starts a run", notice?.message ?? JSON.stringify(seen.slice(0, 5)));
	check(Buffer.compare(before, readFileSync(file)) === 0, "the session file is unchanged by the second process (never interleaves)");
	const renamed = await api("POST", `/api/sessions/${id}/commands`, { requestId: "verify-app-rename", type: "rename", text: "Recommend (verify)" });
	await sleep(300);
	check(renamed.status === 200 && readFileSync(file, "utf8").includes('"name":"Recommend (verify)"'), "rename from the App, as the writer");

	// Released (the App's process stops, as after 15 idle minutes): the terminal can have it.
	await bridge.close();
	const released = execFileSync("node", ["/opt/pi-gaffer/scripts/continue-session.ts", sessions], { encoding: "utf8" }).trim();
	check(released === file && !existsSync(`${file}.lock`), "released: the lock file is gone, and --continue picks the session");
	// Reopened later, the page has it from the session file (the bridge's history).
	const fromHistory = historyOf(readFileSync(file, "utf8")).find((e) => e.customType === "gaffer.recommendation")?.data;
	check(recLine.includes(`"data":${JSON.stringify(fromHistory)},`), "FR-UI-11: the JSON export from the history is the stored entry byte for byte");

	// FR-UI-13: a follow-up in the same session (its Pi spawned again for the ask), answered under the result.
	const bridge2 = createBridge({ sessionsDir: sessions, dataDir: data, publicDir: "/opt/packages/gaffer-web/public", spawnPi: (p) => rpc(p) });
	await new Promise((r) => bridge2.server.listen(0, "127.0.0.1", r));
	const api2 = (method, path, body) => apiOn(bridge2, method, path, body);
	const asked = await api2("POST", `/api/sessions/${id}/commands`, { requestId: "verify-app-ask", type: "ask", text: "Why that captain rather than the vice?" });
	for (let i = 0; i < 80 && (bridge2.live.get(id)?.running ?? true); i++) await sleep(250);
	const after = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const msgs = after.filter((e) => e.type === "message").map((e) => e.message);
	const lastUser = msgs.filter((m) => m.role === "user").at(-1);
	const lastSaid = msgs.filter((m) => m.role === "assistant").at(-1);
	check(asked.status === 200 && after[0].id === id && lastUser?.content?.[0]?.text === "Why that captain rather than the vice?" && lastSaid?.content?.some((c) => c.text?.includes("Because his 7.9 xP")), "FR-UI-13: a follow-up runs in the same session and its answer is stored after the result", `${asked.status} ${JSON.stringify(asked.body)}`);
	await bridge2.close();

	// FR-UI-08 for What-if: the /whatif template with FPL's names, an answer in text, no submission.
	const bridge3 = createBridge({ sessionsDir: sessions, dataDir: data, publicDir: "/opt/packages/gaffer-web/public", spawnPi: (p) => rpc(p) });
	await new Promise((r) => bridge3.server.listen(0, "127.0.0.1", r));
	const api3 = (method, path, body) => apiOn(bridge3, method, path, body);
	const players = await api3("GET", "/api/players");
	const outP = team.body.squad.find((p) => p.position === "FWD") ?? team.body.squad[14];
	const inP = players.body.find((p) => p.position === outP.position && !team.body.squad.some((q) => q.id === p.id));
	check(players.status === 200 && players.body.length > 500 && outP && inP, `the player list for the pickers: ${players.body.length} players`);
	const wi = await api3("POST", "/api/runs", { requestId: "verify-app-whatif", action: "whatif", team_id: teamId, options: { kind: "transfer", out: outP.id, in: inP.id, gw: home.body.gw.next } });
	for (let i = 0; wi.status === 201 && i < 480 && (bridge3.live.get(wi.body.id)?.running ?? true); i++) await sleep(500);
	const wiFile = readdirSync(sessions).map((f) => join(sessions, f)).find((f) => f.endsWith(".jsonl") && readFileSync(f, "utf8").includes('"action":"whatif"'));
	const wiEntries = wiFile ? readFileSync(wiFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
	const wiUsers = wiEntries.filter((e) => e.type === "message" && e.message.role === "user").map((e) => e.message.content.map((c) => c.text).join(""));
	const whatifTemplate = readFileSync("/opt/pi-gaffer/prompts/whatif.md", "utf8").split("---\n")[2].replace(/\n$/, "");
	const expected = whatifTemplate.replace(/\$\{@:-[^}]*\}/, `I sell ${outP.name} (${outP.team}, id ${outP.id}) for ${inP.name} (${inP.team}, id ${inP.id}) in GW${home.body.gw.next}.`);
	const wiRun = wiEntries.find((e) => e.customType === "gaffer.run")?.data;
	check(wi.status === 201 && wiUsers.length === 1 && wiUsers[0] === expected && wiRun?.title === `What-if: ${outP.name} → ${inP.name}`, "FR-UI-08 What-if: the run's prompt is the /whatif template with FPL's names, titled for the rail", wiUsers[0]?.slice(0, 160));
	check(!wiEntries.some((e) => e.customType === "gaffer.recommendation") && !wiEntries.some((e) => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "submit_recommendation") && wiEntries.some((e) => e.type === "message" && e.message.content?.some?.((c) => c.text?.includes("Not worth it."))), "the What-if answered in text, with no submission");

	// Preferences through Pi (no model call), read back by the team check; and the scorecard endpoint.
	const procs = piProcs();
	const files = readdirSync(sessions).length;
	const saved = await api3("POST", "/api/runs", { requestId: "verify-app-prefs", action: "preferences", team_id: teamId, options: { risk: "safe", max_hits_per_gw: 0, save_chips: ["bboost"], keep: [keep.id], clear: false } });
	const back = await api3("GET", `/api/team/${teamId}`);
	check(saved.status === 200 && /^Preferences saved for /.test(saved.body.message) && back.body.prefs?.risk === "safe" && back.body.prefs?.save_chips?.join() === "bboost" && back.body.prefs?.keep?.[0]?.id === keep.id && piProcs() === procs && readdirSync(sessions).length === files, "Preferences: saved through /run with no model call and no session left behind; the team check reads them back", JSON.stringify(saved.body));
	const cleared = await api3("POST", "/api/runs", { requestId: "verify-app-prefs-clear", action: "preferences", team_id: teamId, options: { risk: "balanced", max_hits_per_gw: null, save_chips: [], keep: [], clear: true } });
	const back2 = await api3("GET", `/api/team/${teamId}`);
	check(cleared.status === 200 && back2.body.prefs?.risk === "balanced" && back2.body.prefs?.keep?.length === 0, "Preferences: Clear all empties them");
	const sc = await api3("GET", `/api/team/${teamId}/scorecard`);
	check(sc.status === 200 && Array.isArray(sc.body.gws) && Array.isArray(sc.body.waiting) && typeof sc.body.totals?.gaffer === "number", `the scorecard endpoint: ${sc.body.gws?.length} scored GWs, ${sc.body.waiting?.length} waiting (a scratch ledger)`);
	check(Array.isArray(back.body.chips) && back.body.chips.every((c) => typeof c.available === "boolean" && "expires" in c), `the team check lists the chips with their expiry (${back.body.chips?.filter((c) => c.available).length} available)`);
	await bridge3.close();

	if (process.env.RECORD) {
		mkdirSync(process.env.RECORD, { recursive: true });
		writeFileSync(join(process.env.RECORD, "faux-run.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
		cpSync(file, join(process.env.RECORD, "faux-run.session.jsonl"));
		console.log(`recorded: ${events.length} events and the session file in ${process.env.RECORD}`);
	}
} finally {
	await bridge.close().catch(() => {});
	execFileSync("sh", ["-c", `chmod -R u+w '${root}' 2>/dev/null; rm -rf '${root}'`]);
}
const failed = results.filter((x) => !x).length;
console.log(failed ? `FAIL: ${failed} of ${results.length} App checks` : `App stack check passed (${results.length} checks)`);
process.exit(failed ? 1 : 0);
