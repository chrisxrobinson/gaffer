// FR-UI-06 / NFR-SEC-09 / ADR 0013, the TUI half (spike S5's run-s5.sh as a test), run inside the harness container:
//   docker compose exec -T gaffer node --input-type=module - < tests/commands.mjs
// The image's own pi, agent settings and keybindings (a copy of /opt/pi-agent), tmux.conf and gaffer-pi's launch
// line, in a detached 100×40 tmux pane on its own socket, with a scripted faux model (no key, no network call).
// It types every Pi built-in and hidden command in full, /skill:*, `/model <arg>` and the unbound shortcuts, and
// checks the screen: Gaffer's one-line refusal and nothing else happens. Also: only Gaffer's commands in the `/`
// list, the header and strip with no Pi furniture, the /resume selector can't delete, /copy reaches the clipboard
// (OSC 52 → tmux), and the branding survives /new. The refusal rests on an undocumented Pi seam (the editor's
// onSubmit), so this runs in the upgrade gate (ADR 0009). Nothing outside a temporary directory is written.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GAFFER = ["gw", "whatif", "explain", "team", "prefs", "scorecard", "usage", "export-rec", "new", "resume", "copy", "help"];
// Pi 1.3.0's 24 built-ins minus the four Gaffer keeps, the three it runs but doesn't list, and its built-in extensions'.
const REFUSED = ["settings", "model", "tree", "thinking", "scoped-models", "export", "import", "share", "bug", "name", "session", "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "compact", "reload", "quit", "debug", "arminsayshi", "dementedelves", "mcp", "llama"];
// What a built-in leaves on screen when it runs (spike S5's baseline captures).
const RAN = [/Type to search/, /Enter to select/, /Esc(ape)? to cancel/i, /Session Tree/, /Error:/, /Bug report/, /GitHub CLI/, /Exported|Session exported/, /Logged (in|out)/, /Reloaded/, /Keyboard shortcuts/i, /Only showing models/];

const root = mkdtempSync(join(tmpdir(), "gaffer-commands-"));
const [agent, work, sessions, data] = ["agent", "work", "sessions", "data"].map((d) => join(root, d));
for (const d of [agent, work, sessions, data]) mkdirSync(d, { recursive: true });
for (const f of readdirSync("/opt/pi-agent")) if (f.endsWith(".json")) cpSync(`/opt/pi-agent/${f}`, join(agent, f));
symlinkSync("/opt/pi-gaffer", join(root, "pi-gaffer")); // settings.json names the package as ../pi-gaffer
const faux = join(root, "faux.ts");
writeFileSync(faux, `import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
export default function (pi) {
  const f = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: true }, { id: "faux-2", reasoning: true }] });
  f.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage(fauxText("Gaffer test answer 4242."))));
  pi.registerProvider(f.provider);
}
`);
// The terminal's launch line, printed by gaffer-pi itself with this run's session dir.
const line = execFileSync("/opt/gaffer/gaffer-pi", { env: { ...process.env, GAFFER_PI_PRINT: "1", GAFFER_SESSIONS_DIR: sessions, GAFFER_MODEL: "", GAFFER_PROVIDER: "", GAFFER_THINKING: "" }, encoding: "utf8" }).trim().split("\n");
const args = [...line, "--provider", "faux", "--model", "faux-1", "--thinking", "medium", "-e", faux];
const run = join(root, "run.sh");
const env = { PI_CODING_AGENT_DIR: agent, GAFFER_SESSIONS_ROOT: sessions, GAFFER_DATA_DIR: data, ANTHROPIC_API_KEY: "sk-ant-commands-dummy" };
writeFileSync(run, `#!/bin/sh\ncd ${work}\nexec env ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ")} pi ${args.join(" ")}\n`);
chmodSync(run, 0o755);
console.log(`pi ${args.join(" ").replaceAll(root, "$TMP")} (tmux 100x40)`);

const sock = `gaffer-commands-${process.pid}`;
const tmux = (...a) => execFileSync("tmux", ["-L", sock, ...a], { encoding: "utf8" });
const screen = () => tmux("capture-pane", "-p", "-t", "t");
const keys = (...k) => tmux("send-keys", "-t", "t", ...k);
const type = (text) => tmux("send-keys", "-t", "t", "-l", text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 15_000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const s = screen();
		if (pred(s)) return s;
		await sleep(200);
	}
	return screen();
};
const pid = () => tmux("display", "-p", "-t", "t", "#{pane_pid}").trim();
// Pi still running and not stopped (Ctrl+Z): the pane is alive and the process state is R, S or D, not T.
const alive = () => tmux("display", "-p", "-t", "t", "#{pane_dead}").trim() === "0" && /^\d+ \(.*\) [RSD] /.test(readFileSync(`/proc/${pid()}/stat`, "utf8"));

const failures = [];
const check = (ok, what, detail = "") => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `\n${detail}`}`);
	if (!ok) failures.push(what);
};
const ran = (s) => RAN.find((re) => re.test(s));
const strip = (s) => s.trimEnd().split("\n").slice(-2).join("\n");

try {
	tmux("-f", "/opt/gaffer/tmux.conf", "new-session", "-d", "-s", "t", "-x", "100", "-y", "40", run);
	let s = await until((x) => x.includes("▄▀▀▀ ▄▀▀▄") && x.includes("No team yet"));
	check(s.includes("█ ▀█ █▀▀█ █▀▀  █▀▀  █▀▀  █▀▀▄") && s.includes("Advice only."), "header: Gaffer's wordmark and tagline", s);
	check(/^ No team yet: \/team <id> to start$/m.test(s) && /today \$0\.0000 of \$\d+\.\d\d · session \$0\.0000 of \$\d+\.\d\d .*faux-1 · thinking medium\s*$/m.test(s), "footer: the status strip and spend against the caps", strip(s));
	check(!/π|v1\.3\.0|ctrl\+o|\[Prompts\]|\[Skills\]|\[Extensions\]|\/work\b|0\.0%/.test(s), "no Pi logo, version, key hints, resource list, cwd or token counter", s);
	await sleep(300);
	check(tmux("display", "-p", "-t", "t", "#{pane_title}").trim() === "Gaffer", "title: Gaffer (no snapshot yet)");

	type("/");
	s = await until((x) => /^→ /m.test(x));
	const listed = [...s.matchAll(/^(?:→ | {2})([a-z][a-z-]*) {2,}/gm)].map((m) => m[1]);
	check(JSON.stringify([...listed].sort()) === JSON.stringify([...GAFFER].sort()), `"/" lists exactly Gaffer's ${GAFFER.length} commands`, `listed: ${listed.join(" ")}`);
	keys("Escape");
	keys("C-u");
	await sleep(300);

	// Every refused command, typed in full and submitted.
	for (const cmd of [...REFUSED, "skill:gaffer-workflow", "model faux-2", "thinking high", "export /data/x.html", "import /etc/passwd", "login anthropic"]) {
		const name = cmd.split(" ")[0];
		type(`/${cmd}`);
		await sleep(400);
		keys("Escape"); // close the autocomplete menu, as a user would before Enter
		await sleep(150);
		keys("Enter");
		s = await until((x) => x.includes(`/${name} is not available in Gaffer: `), 4000);
		const hit = ran(s);
		// One line: the refusal ends on the line it starts.
		const oneLine = new RegExp(`^ Warning: /${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not available in Gaffer: .+\\.$`, "m").test(s);
		check(oneLine && !hit && alive() && strip(s).includes("faux-1 · thinking medium"), `/${cmd}: refused, nothing ran`, hit ? `ran: ${hit}\n${s}` : s);
		keys("Escape");
		keys("C-u");
		await sleep(200);
	}

	// The shortcuts for the same actions (keybindings.json, doubleEscapeAction "none").
	for (const [k, what] of [["C-l", "model selector"], ["C-p", "model cycle"], ["BTab", "thinking cycle"], ["C-g", "external editor"], ["C-z", "suspend"]]) {
		keys(k);
		await sleep(900);
		s = screen();
		const hit = ran(s);
		check(!hit && alive() && strip(s).includes("faux-1 · thinking medium"), `${k} (${what}) does nothing`, hit ? `ran: ${hit}\n${s}` : strip(s));
		keys("Escape");
		await sleep(200);
	}
	keys("Escape");
	await sleep(100);
	keys("Escape");
	await sleep(900);
	s = screen();
	check(!ran(s) && alive(), "Esc Esc (tree) does nothing", s);

	// A message and its answer, then /copy: Pi writes OSC 52, tmux (set-clipboard on) keeps it as a buffer.
	type("Hello Gaffer");
	keys("Enter");
	s = await until((x) => x.includes("Gaffer test answer 4242."));
	check(s.includes("Gaffer test answer 4242."), "a plain message reaches the model");
	type("/copy");
	await sleep(400);
	keys("Escape");
	keys("Enter");
	await sleep(1200);
	let buffer = "";
	try {
		buffer = tmux("show-buffer");
	} catch {
		/* no buffer: nothing was copied */
	}
	check(buffer.includes("Gaffer test answer 4242."), "/copy sends the last answer to the terminal's clipboard (OSC 52)", `buffer: ${JSON.stringify(buffer)}`);

	// !cmd stays blocked (NFR-SEC-07).
	type("!ls /");
	keys("Enter");
	s = await until((x) => x.includes("Shell commands are disabled in Gaffer"), 4000);
	check(s.includes("Shell commands are disabled in Gaffer") && !/\bbin\b.*\betc\b/.test(s), "!ls is blocked");

	// /help is Gaffer's.
	type("/help");
	await sleep(400);
	keys("Escape");
	keys("Enter");
	s = await until((x) => x.includes("GAFFER · help"), 4000);
	check(s.includes("GAFFER · help") && s.includes("/export-rec"), "/help is Gaffer's");

	// /new keeps the branding; /resume opens the earlier session, and Ctrl+D (delete) and Ctrl+R (rename) do nothing.
	const files = () => readdirSync(sessions, { recursive: true }).filter((f) => String(f).endsWith(".jsonl")).length;
	const before = files();
	type("/new");
	await sleep(400);
	keys("Escape");
	keys("Enter");
	s = await until((x) => x.includes("New session started"), 6000);
	check(s.includes("▄▀▀▀ ▄▀▀▄") && /^ No team yet/m.test(s) && !s.includes("Gaffer test answer"), "/new: a fresh session with the wordmark and strip", s);
	type("/resume");
	await sleep(400);
	keys("Escape");
	keys("Enter");
	s = await until((x) => x.includes("Hello Gaffer"), 6000);
	check(s.includes("Hello Gaffer"), "/resume lists the earlier session", s);
	keys("C-d");
	await sleep(700);
	keys("C-r");
	await sleep(700);
	s = screen();
	// The selector's hints show the two actions with no key, and neither a confirmation nor a name prompt appears.
	check(/· {2}delete ·/.test(s) && /· {2}rename\b/.test(s) && !/Delete session\?|Are you sure|\(y\/n\)|New name|Rename session/i.test(s) && files() === before, "/resume: Ctrl+D and Ctrl+R neither delete nor rename", s);
	keys("Enter");
	s = await until((x) => x.includes("Gaffer test answer 4242.") && x.includes("No team yet"), 6000);
	check(s.includes("Gaffer test answer 4242.") && s.includes("▄▀▀▀ ▄▀▀▄") && /faux-1 · thinking medium\s*$/m.test(s), "/resume: the session reopens with the branding", s);
	check(alive(), "/quit and Ctrl+Z left Pi running");
} catch (e) {
	failures.push(`error: ${e.message}`);
	console.log(`FAIL ${e.stack}`);
	try {
		console.log(screen());
	} catch {
		/* no pane */
	}
} finally {
	try {
		tmux("kill-server");
	} catch {
		/* already gone */
	}
}
if (failures.length) {
	console.log(`FR-UI-06 TUI check FAILED: ${failures.length} — ${failures.join("; ")}`);
	process.exit(1);
}
console.log("FR-UI-06 TUI check passed");
