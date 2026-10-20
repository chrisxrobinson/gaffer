// M1.1-4's browser evidence for the Gaffer App, with no stack, model or spend: headless Chrome over the DevTools
// protocol against `gaffer-web --replay` of the recorded faux run and the states derived from it
// (packages/gaffer-web/test/fixtures/states.mjs), the Scorecard from its fixture (scorecard.mjs).
// For every screen, in light and dark, at 1280 and 375 px:
//   - a screenshot (screenshots/<theme>-<width>-<screen>.jpg);
//   - axe-core 4.13.0 (served by replay mode at /dev/axe.min.js): violations by impact, and the colour-contrast
//     checks it could not decide ("needs review");
// and a keyboard walk: Tab through Start, a Result and the drawer, recording each stop, whether it is in DOM order
// and whether its focus is visible. Results in results/a11y.json and results/keyboard.json; exit 1 on a serious or
// critical violation, a stop with no visible focus, or a control Tab never reached.
//   node deploy/compose/m114/pages.mjs [--only <screen substring>] [--no-shots]
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({ options: { only: { type: "string" }, "no-shots": { type: "boolean" }, themes: { type: "string", default: "light,dark" }, widths: { type: "string", default: "1280,375" } } });
const HERE = import.meta.dirname;
const REPO = resolve(HERE, "../../..");
const WEB = join(REPO, "packages/gaffer-web");
const OUT = join(HERE, "screenshots");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
mkdirSync(join(HERE, "results"), { recursive: true });
const states = mkdtempSync(join(tmpdir(), "gaffer-states-"));
execFileSync("node", [join(WEB, "test/fixtures/states.mjs"), states]);
const data = mkdtempSync(join(tmpdir(), "gaffer-data-"));
execFileSync("node", [join(WEB, "test/fixtures/scorecard.mjs"), data]);

let port = 17900;
const servers = new Set();
async function replay(name, speed = 40) {
	const p = port++;
	const file = name.endsWith(".jsonl") ? name : join(states, `${name}.jsonl`);
	const child = spawn("node", [join(WEB, "server.ts"), "--replay", file, "--speed", String(speed), "--port", String(p), "--data", data], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, GAFFER_ID_SALT: "test-salt" } });
	await new Promise((r) => child.stdout.once("data", r));
	servers.add(child);
	return { url: `http://127.0.0.1:${p}`, stop: () => (servers.delete(child), child.kill()) };
}

// ---- Chrome and the DevTools protocol -------------------------------------------------------------------------
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9334", `--user-data-dir=${mkdtempSync(join(tmpdir(), "gaffer-chrome-"))}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 50 && !target; i++) {
	await sleep(200);
	target = await fetch("http://127.0.0.1:9334/json/list").then((r) => r.json()).then((l) => l.find((t) => t.type === "page")).catch(() => undefined);
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
const js = async (expression) => {
	const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (r.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
	return r.result.value;
};
await cdp("Page.enable");
await cdp("Runtime.enable");

/** Rewrite the bridge's JSON answers: [urlPattern, (json) => json]. */
let rewrites = [];
handlers.push(async (msg) => {
	if (msg.method !== "Fetch.requestPaused") return;
	const { requestId, request, responseStatusCode } = msg.params;
	const rule = rewrites.find(([pat]) => request.url.includes(pat));
	try {
		if (!rule || responseStatusCode === undefined) return void (await cdp("Fetch.continueRequest", { requestId }));
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
	if (rules.length) await cdp("Fetch.enable", { patterns: rules.map(([pat]) => ({ urlPattern: `*${pat}*`, requestStage: "Response" })) });
}
async function view(width, theme) {
	await cdp("Emulation.setDeviceMetricsOverride", { width, height: width < 600 ? 812 : 900, deviceScaleFactor: 1, mobile: width < 600 });
	await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
}
const go = async (url, wait = 1500) => {
	await cdp("Page.navigate", { url });
	await sleep(wait);
};
const reload = async (wait = 1800) => {
	await js("location.reload(); true");
	await sleep(wait);
};
const key = async (k, mods = 0) => {
	const codes = { Tab: [9, "Tab"], Enter: [13, "Enter"], Escape: [27, "Escape"], " ": [32, "Space"], "/": [191, "Slash"] };
	const [code, name] = codes[k];
	for (const type of ["rawKeyDown", "keyUp"]) await cdp("Input.dispatchKeyEvent", { type, key: k, code: name, windowsVirtualKeyCode: code, modifiers: mods, ...(type === "rawKeyDown" && (k === "Enter" || k === " " || k === "/") ? { text: k === "Enter" ? "\r" : k } : {}) });
	await sleep(60);
};
const typeText = (text) => cdp("Input.insertText", { text });
/** Set a form control's value as a user would (Preact listens for input and change). */
const setValue = (sel, value) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error("no ${sel}"); const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(String(value))}); el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); return true; })()`);
const click = (sel) => js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel.replace(/:text\(.*\)$/, ""))})].find((e) => ${/:text\((.*)\)$/.test(sel) ? `e.textContent.includes(${JSON.stringify(/:text\((.*)\)$/.exec(sel)[1])})` : "true"}); if (!el) throw new Error("nothing to click: ${sel.replace(/"/g, "'")}"); el.click(); return true; })()`);
/** Start a replayed run from the page and open it. */
const startRun = (spec = { team_id: 1, options: { risk: "balanced", max_hits_per_gw: 1, save_chips: ["wildcard"], keep: [], save: false } }) =>
	js(`fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "shot-" + Date.now(), ...${JSON.stringify(spec)} }) }).then((r) => r.json()).then((b) => { location.hash = "#/s/" + b.id; return b.id; })`);

// ---- One screen: a screenshot, and axe-core on what it shows ---------------------------------------------------
const a11y = [];
let tag = "";
async function screen(name, { scrollTo, full = false } = {}) {
	if (args.only && !name.includes(args.only)) return;
	if (scrollTo) await js(`(document.querySelector(${JSON.stringify(scrollTo)})?.scrollIntoView({ block: "start" }), window.scrollBy(0, -70), true)`);
	else await js("window.scrollTo(0, 0); true");
	await sleep(250);
	if (!args["no-shots"]) {
		const params = { format: "jpeg", quality: 72 };
		if (full) {
			const { cssContentSize } = await cdp("Page.getLayoutMetrics");
			Object.assign(params, { captureBeyondViewport: true, clip: { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 } });
		}
		const { data: img } = await cdp("Page.captureScreenshot", params);
		writeFileSync(join(OUT, `${tag}-${name}.jpg`), Buffer.from(img, "base64"));
	}
	const r = await js(`(async () => {
		if (!window.axe) await new Promise((ok, fail) => { const s = document.createElement("script"); s.src = "/dev/axe.min.js"; s.onload = ok; s.onerror = fail; document.head.append(s); });
		const res = await axe.run(document, { resultTypes: ["violations", "incomplete"] });
		const wide = document.documentElement.scrollWidth > innerWidth + 1;
		return { violations: res.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) })),
			contrastNeedsReview: (res.incomplete.find((i) => i.id === "color-contrast")?.nodes ?? []).map((n) => ({ target: n.target.join(" "), why: n.any?.[0]?.message ?? "" })),
			scrollsSideways: wide, width: document.documentElement.scrollWidth };
	})()`);
	a11y.push({ screen: `${tag}-${name}`, ...r });
	const serious = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
	console.log(`${tag}-${name}: axe ${r.violations.length ? r.violations.map((v) => `${v.id}(${v.impact})`).join(", ") : "no violations"}${r.contrastNeedsReview.length ? `; contrast to review ${r.contrastNeedsReview.length}` : ""}${r.scrollsSideways ? `; SCROLLS SIDEWAYS (${r.width})` : ""}${serious.length ? "  <-- SERIOUS" : ""}`);
}

// ---- The keyboard walk ---------------------------------------------------------------------------------------
/** Tab from the top of the page `n` times: each stop, in DOM order or not, with its focus visible or not. */
async function walk(name, n) {
	await js("document.activeElement?.blur(); window.scrollTo(0, 0); true");
	await js("(document.body.tabIndex = -1, document.body.focus(), document.body.removeAttribute('tabindex'), true)");
	const stops = [];
	for (let i = 0; i < n; i++) {
		await key("Tab");
		stops.push(await js(`(() => {
			const el = document.activeElement;
			if (!el || el === document.body) return null;
			const cs = getComputedStyle(el);
			const visible = el.matches(":focus-visible") && ((cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none");
			const all = [...document.querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex='-1'])")].filter((e) => !e.disabled && e.checkVisibility({ visibilityProperty: true }) && !e.closest("[inert]"));
			const label = (el.getAttribute("aria-label") || el.labels?.[0]?.textContent || el.textContent || el.placeholder || el.id || el.tagName).trim().replace(/\\s+/g, " ").slice(0, 60);
			return { tag: el.tagName.toLowerCase(), label, index: all.indexOf(el), of: all.length, visible };
		})()`));
	}
	const real = stops.filter(Boolean);
	const inOrder = real.every((s, i) => i === 0 || s.index > real[i - 1].index || s.index === 0);
	const reached = new Set(real.map((s) => s.index)).size;
	const seen = new Set(real.map((s) => s.index));
	const missed = (await js(`[...document.querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex='-1'])")].filter((e) => !e.disabled && e.checkVisibility({ visibilityProperty: true }) && !e.closest("[inert]")).map((e) => (e.getAttribute("aria-label") || e.textContent || e.id || e.tagName).trim().replace(/\\s+/g, " ").slice(0, 50))`)).filter((_, i) => !seen.has(i));
	const result = { walk: `${tag}-${name}`, stops: real, inOrder, allVisible: real.every((s) => s.visible), reached, focusable: real[0]?.of ?? 0, missed };
	console.log(`${tag}-${name}: ${real.length} Tab stops, ${reached} of ${result.focusable} controls, in order ${inOrder}, focus visible on all ${result.allVisible}${missed.length ? `; not reached: ${missed.join(" | ")}` : ""}`);
	return result;
}

const keyboard = [];
try {
	for (const theme of args.themes.split(",")) {
		for (const width of args.widths.split(",").map(Number)) {
			tag = `${theme}-${width}`;
			await view(width, theme);
			const phone = width < 600;

			// Start and its actions, with the team remembered.
			const base = await replay("done", 40);
			await setRewrites([]);
			await go(`${base.url}/#/`, 500);
			await js(`localStorage.removeItem("gaffer.team"); true`);
			await reload();
			await screen("01-start-empty");
			if (phone) {
				await click("button.menu");
				await sleep(400);
				await screen("02-drawer-open");
				await key("Escape");
				await sleep(300);
				await screen("03-drawer-closed");
			}
			await js(`localStorage.setItem("gaffer.team", "1"); true`);
			await reload(2200);
			await screen("04-start-recommend", { scrollTo: "#act-h" });
			await click('.action[data-action="whatif"]');
			await sleep(800);
			const squad = await js(`[...document.querySelectorAll("#wi-out option")].map((o) => o.value).filter(Boolean)`);
			await setValue("#wi-out", squad[5]);
			await sleep(200);
			const ins = await js(`[...document.querySelectorAll("#wi-in option")].map((o) => o.value).filter(Boolean)`);
			if (ins[0]) await setValue("#wi-in", ins[0]);
			await sleep(200);
			await screen("05-start-whatif-transfer", { scrollTo: "#opts-h" });
			await click('.seg[aria-label="What-if kind"] button:text(A chip)');
			await sleep(200);
			await click('.seg[aria-label="Chip"] button').catch(() => {});
			await sleep(200);
			await screen("06-start-whatif-chip", { scrollTo: "#opts-h" });
			await click('.action[data-action="explain"]');
			await sleep(400);
			const ex = await js(`[...document.querySelectorAll("#ex-p option")].map((o) => o.value).filter(Boolean)`);
			await setValue("#ex-p", ex[0]);
			await sleep(200);
			await screen("07-start-explain", { scrollTo: "#opts-h" });
			await click('.action[data-action="chips"]');
			await sleep(300);
			await screen("08-start-chips", { scrollTo: "#opts-h" });
			if (!phone) keyboard.push(await walk("start-chips", 45));
			await setRewrites([["/api/home", (h) => ({ ...h, spend: { ...h.spend, today: 5.02 } })]]);
			await reload();
			await screen("09-state-daily-cap");
			await setRewrites([["/api/home", (h) => ({ ...h, busy: { ui: "terminal" } })]]);
			await reload();
			await screen("10-state-run-in-terminal");
			await setRewrites([["/api/home", (h) => ({ ...h, gw: { ...h.gw, deadline: new Date(Date.now() - 120_000).toISOString() } })]]);
			await reload();
			await screen("11-state-deadline-passed-start");
			await setRewrites([]);
			base.stop();

			// A Recommend run, its result, a follow-up and the ask box; the session open elsewhere; reconnecting.
			const fu = await replay("followup", 40);
			await go(`${fu.url}/#/`);
			await startRun();
			await sleep(3500);
			await screen("12-run-done");
			await screen("13-result", { scrollTo: ".result" });
			if (!phone) keyboard.push(await walk("result", 110));
			await js(`document.getElementById("ask").focus(); true`);
			await typeText("Why Haaland as captain rather than Salah?");
			await screen("14-ask-box", { scrollTo: ".composer" });
			await key("Enter");
			await sleep(2500);
			await screen("15-followup-answered", { scrollTo: ".answers" });
			await screen("16-result-full", { full: true });
			if (phone) {
				await js(`document.querySelector(".title button")?.click(); true`);
				await sleep(300);
				await screen("17-rename");
				await key("Escape");
			}
			const sid = await js("location.hash.slice(4)");
			await setRewrites([[`/api/sessions/${sid}`, (v) => (v.history ? { ...v, lock: { ui: "terminal" } } : v)]]);
			await reload();
			await screen("18-state-open-in-terminal");
			await setRewrites([]);
			fu.stop();
			const slow = await replay("running", 2);
			await go(`${slow.url}/#/`);
			await startRun();
			await sleep(5000);
			await screen("19-run-streaming", { scrollTo: "details.step[data-status=running]" });
			slow.stop();
			await sleep(3000);
			await screen("20-state-reconnecting");

			// The text answers and the states they reach.
			for (const [name, sel, wait, speed] of [["whatif", ".say.md:last-of-type", 4000, 40], ["explain", ".say.md:last-of-type", 4000, 40], ["chips", ".say.md:last-of-type", 4000, 40], ["whatif-running", ".runbar", 4000, 40], ["whatif-hardcap", ".banner", 4000, 40]]) {
				const r = await replay(name, speed);
				await go(`${r.url}/#/`);
				await startRun();
				await sleep(wait);
				await screen(`21-answer-${name}`, { scrollTo: sel });
				r.stop();
			}

			// Scorecard and Preferences.
			const sc = await replay("done", 40);
			await go(`${sc.url}/#/scorecard`, 500);
			await js(`localStorage.setItem("gaffer.team", "1"); true`);
			await reload(2500);
			await screen("22-scorecard");
			await go(`${sc.url}/#/prefs`, 2500);
			await screen("23-preferences");
			await click(".pf-actions .btn.primary");
			await sleep(800);
			await screen("24-preferences-saved");
			await click(".pf-actions .btn:text(Clear all)");
			await sleep(200);
			await screen("25-preferences-clear-confirm", { scrollTo: ".pf-actions" });
			sc.stop();

			// The run states docs/ui §6 lists.
			for (const [name, sel, wait] of [["running", "details.step[data-status=running]", 2500], ["thinking", ".think", 2500], ["softcap", ".banner", 4000], ["hardcap", ".banner", 3000], ["stale", ".banner", 4000], ["oddsdown", ".banner", 4000], ["novalid", ".banner", 4000], ["stopped", ".runbar", 3000]]) {
				const r = await replay(name, 20);
				await go(`${r.url}/#/`);
				await startRun();
				await sleep(wait);
				await screen(`30-state-${name}`, { scrollTo: sel });
				r.stop();
			}
			const old = await replay(join(REPO, "spikes/s7-rpc-events/events.jsonl"), 5);
			await go(`${old.url}/#/`);
			await startRun();
			await sleep(2500);
			await screen("31-state-deadline-passed-result", { scrollTo: ".result" });
			old.stop();
			if (phone && theme === "light") {
				// The drawer by keyboard: open, Tab inside it, Esc back to its button.
				const d = await replay("done", 40);
				await go(`${d.url}/#/`);
				await js(`document.querySelector("button.menu").focus(); true`);
				await key("Enter");
				await sleep(300);
				keyboard.push(await walk("drawer-open", 12));
				d.stop();
			}
		}
	}
} finally {
	for (const s of servers) s.kill();
	ws.close();
	chrome.kill();
}
writeFileSync(join(HERE, "results", "a11y.json"), `${JSON.stringify(a11y, null, 1)}\n`);
writeFileSync(join(HERE, "results", "keyboard.json"), `${JSON.stringify(keyboard, null, 1)}\n`);
const serious = a11y.flatMap((r) => r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${r.screen}: ${v.id} ${v.targets.join(", ")}`));
const sideways = a11y.filter((r) => r.scrollsSideways).map((r) => r.screen);
const keys = keyboard.filter((k) => !k.inOrder || !k.allVisible).map((k) => k.walk);
console.log(`\n${a11y.length} screens: ${serious.length} serious or critical violations, ${a11y.reduce((n, r) => n + r.contrastNeedsReview.length, 0)} contrast checks to review, ${sideways.length} scrolling sideways; ${keyboard.length} keyboard walks, ${keys.length} out of order or without visible focus`);
for (const s of [...serious, ...sideways.map((x) => `${x}: scrolls sideways`), ...keys.map((x) => `${x}: keyboard`)]) console.log(`  ${s}`);
process.exit(serious.length || sideways.length || keys.length ? 1 : 0);
