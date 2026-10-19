// M1.1-3's screenshots of the Gaffer App: Start, a run streaming, the Result and each state of docs/ui §6 a
// Recommend run reaches, in light and dark, at 1280 and 375 px. Headless Chrome over the DevTools protocol (Node's
// own WebSocket), against `gaffer-web --replay` of the states derived from the recorded faux run
// (packages/gaffer-web/test/fixtures/states.mjs), so it needs no stack, model or spend. Page-level states (daily
// cap, a run in the terminal, reconnecting, open in the terminal) are made by rewriting the bridge's answers.
//   node deploy/compose/m113/screenshots.mjs [out dir]
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../../..");
const WEB = join(REPO, "packages/gaffer-web");
const OUT = resolve(process.argv[2] ?? join(import.meta.dirname, "screenshots"));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
const states = mkdtempSync(join(tmpdir(), "gaffer-states-"));
execFileSync("node", [join(WEB, "test/fixtures/states.mjs"), states]);

let port = 17800;
async function replay(file, speed = 30) {
	const p = port++;
	const child = spawn("node", [join(WEB, "server.ts"), "--replay", file, "--speed", String(speed), "--port", String(p)], { stdio: ["ignore", "pipe", "inherit"] });
	await new Promise((r) => child.stdout.once("data", r));
	return { url: `http://127.0.0.1:${p}`, stop: () => child.kill() };
}

const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${mkdtempSync(join(tmpdir(), "gaffer-chrome-"))}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 50 && !target; i++) {
	await sleep(200);
	target = await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json()).then((l) => l.find((t) => t.type === "page")).catch(() => undefined);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const waiting = new Map();
const handlers = [];
ws.addEventListener("message", (m) => {
	const msg = JSON.parse(m.data);
	if (msg.id && waiting.has(msg.id)) {
		waiting.get(msg.id)(msg);
		waiting.delete(msg.id);
	} else for (const h of handlers) h(msg);
});
const cdp = (method, params = {}) =>
	new Promise((ok, fail) => {
		const n = ++id;
		waiting.set(n, (msg) => (msg.error ? fail(new Error(`${method}: ${msg.error.message}`)) : ok(msg.result)));
		ws.send(JSON.stringify({ id: n, method, params }));
	});
const js = async (expression) => (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
await cdp("Page.enable");
await cdp("Runtime.enable");

/** Rewrite the bridge's answers: [urlPattern, (json) => json] for responses, or "fail" to break a request. */
let rewrites = [];
handlers.push(async (msg) => {
	if (msg.method !== "Fetch.requestPaused") return;
	const { requestId, request, responseStatusCode } = msg.params;
	const rule = rewrites.find(([pat]) => request.url.includes(pat));
	try {
		if (!rule) return void (await cdp("Fetch.continueRequest", { requestId }));
		if (rule[1] === "fail") return void (await cdp("Fetch.failRequest", { requestId, errorReason: "ConnectionReset" }));
		if (responseStatusCode === undefined) return void (await cdp("Fetch.continueRequest", { requestId }));
		const { body, base64Encoded } = await cdp("Fetch.getResponseBody", { requestId });
		const json = rule[1](JSON.parse(base64Encoded ? Buffer.from(body, "base64").toString() : body));
		await cdp("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify(json)).toString("base64") });
	} catch {
		/* the page moved on */
	}
});
async function setRewrites(rules) {
	rewrites = rules;
	await cdp("Fetch.disable");
	if (rules.length) await cdp("Fetch.enable", { patterns: rules.flatMap(([pat, f]) => (f === "fail" ? [{ urlPattern: `*${pat}*`, requestStage: "Request" }] : [{ urlPattern: `*${pat}*`, requestStage: "Response" }])) });
}

async function view(width, theme) {
	await cdp("Emulation.setDeviceMetricsOverride", { width, height: width < 600 ? 812 : 900, deviceScaleFactor: 1, mobile: width < 600 });
	await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
}
async function go(url, wait = 1500) {
	await cdp("Page.navigate", { url });
	await sleep(wait);
}
async function shot(name, { full = false, scrollTo } = {}) {
	if (scrollTo) await js(`document.querySelector(${JSON.stringify(scrollTo)})?.scrollIntoView({ block: "start" }); window.scrollBy(0, -70); true`);
	else await js("window.scrollTo(0, 0); true");
	await sleep(200);
	const params = { format: "jpeg", quality: 72 };
	if (full) {
		const { cssContentSize } = await cdp("Page.getLayoutMetrics");
		Object.assign(params, { captureBeyondViewport: true, clip: { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 } });
	}
	const { data } = await cdp("Page.captureScreenshot", params);
	writeFileSync(join(OUT, `${name}.jpg`), Buffer.from(data, "base64"));
	console.log(name);
}
/** Start a replayed run from the page and open it. */
const startRun = () => js(`fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "shot-" + Date.now(), team_id: 1, options: { risk: "balanced", max_hits_per_gw: 1, save_chips: ["wildcard"], keep: [], save: false } }) }).then((r) => r.json()).then((b) => { location.hash = "#/s/" + b.id; return b.id; })`);

const STATES = [
	["running", "details.step[data-status=running]", 2500],
	["thinking", ".think[aria-live]", 2500],
	["softcap", ".banner", 4000],
	["hardcap", ".banner", 3000],
	["stale", ".banner", 4000],
	["oddsdown", ".banner", 4000],
	["novalid", ".banner", 4000],
	["stopped", ".runbar", 3000],
];
try {
	for (const theme of ["light", "dark"]) {
		for (const width of [1280, 375]) {
			const tag = `${theme}-${width}`;
			await view(width, theme);
			const done = await replay(join(states, "done.jsonl"), 1);
			// Start: empty state, the team checked, the options. And the page-level states on it.
			await setRewrites([]);
			await go(`${done.url}/#/`);
			await js(`localStorage.setItem("gaffer.team", "1"); location.reload(); true`);
			await sleep(1800);
			await shot(`${tag}-01-start`);
			await shot(`${tag}-02-start-options`, { scrollTo: "#opts-h" });
			await setRewrites([["/api/home", (h) => ({ ...h, spend: { ...h.spend, today: 5.02 } })]]);
			await js("location.reload(); true");
			await sleep(1800);
			await shot(`${tag}-03-state-daily-cap`);
			await setRewrites([["/api/home", (h) => ({ ...h, busy: { ui: "terminal" } })]]);
			await js("location.reload(); true");
			await sleep(1800);
			await shot(`${tag}-04-state-run-in-terminal`);
			// A run streaming at its recorded pace, then the result.
			await setRewrites([]);
			await js(`location.hash = "#/"; location.reload(); true`);
			await sleep(1000);
			await startRun();
			await sleep(11_000); // the golden path is running: progress lines arrive
			await shot(`${tag}-05-run-streaming`, { scrollTo: "details.step[data-status=running]" });
			done.stop();
			const fast = await replay(join(states, "done.jsonl"), 40);
			await go(`${fast.url}/#/`);
			await startRun();
			await sleep(3500);
			await shot(`${tag}-06-run-done`);
			await shot(`${tag}-07-result`, { scrollTo: ".result" });
			await shot(`${tag}-08-result-full`, { full: true });
			// The same session, open in the terminal (read-only here), and reconnecting.
			const sid = await js("location.hash.slice(4)");
			await setRewrites([[`/api/sessions/${sid}`, (v) => (v.history ? { ...v, lock: { ui: "terminal" } } : v)]]);
			await js("location.reload(); true");
			await sleep(1800);
			await shot(`${tag}-09-state-open-in-terminal`);
			fast.stop();
			const slow = await replay(join(states, "running.jsonl"), 1);
			await setRewrites([]);
			await go(`${slow.url}/#/`);
			await startRun();
			await sleep(2000);
			await setRewrites([["/events", "fail"]]);
			await js("location.reload(); true");
			await sleep(2500);
			await shot(`${tag}-10-state-reconnecting`);
			slow.stop();
			await setRewrites([]);
			for (const [name, sel, wait] of STATES) {
				const r = await replay(join(states, `${name}.jsonl`), 20);
				await go(`${r.url}/#/`);
				await startRun();
				await sleep(wait);
				await shot(`${tag}-state-${name}`, { scrollTo: sel });
				r.stop();
			}
			// Deadline passed: spike S7's 2024 run.
			const old = await replay(join(REPO, "spikes/s7-rpc-events/events.jsonl"), 5);
			await go(`${old.url}/#/`);
			await startRun();
			await sleep(2500);
			await shot(`${tag}-state-deadline-passed`, { scrollTo: ".result" });
			old.stop();
		}
	}
} finally {
	ws.close();
	chrome.kill();
}
