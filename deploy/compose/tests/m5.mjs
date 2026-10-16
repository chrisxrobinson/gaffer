// M5 through the installed tools inside the harness container:
//   gaffer admin  → /data/admin/admin.html from /sessions and /data, with its totals
//   gaffer-eval   → /data/ledger/outcomes.jsonl for every finished, data-checked GW (one-shot, idempotent)
//   NFR-PRIV-01   → no raw team id, team name or manager name under ledger/, users/, exports/ or admin/
// Every team id and name is collected from the session logs and the snapshots, which hold them by design.
//   docker compose exec -T gaffer node --input-type=module - < tests/m5.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DATA = process.env.GAFFER_DATA_DIR ?? "/data";
const fail = (m) => {
	console.error(`FAIL: ${m}`);
	process.exit(1);
};
const node = (script, args = []) => execFileSync("node", [script, ...args], { encoding: "utf8", env: process.env, maxBuffer: 1 << 26 });

console.log("--- gaffer admin");
const admin = node("/opt/tools/gaffer-admin/main.ts", ["--sessions", "/sessions", "--data", DATA]);
console.log(admin.split("\n").filter((l) => !l.startsWith("  ")).join("\n").trim());
const html = readFileSync(join(DATA, "admin", "admin.html"), "utf8");
if (!/<h1>Gaffer admin<\/h1>/.test(html) || /<script/i.test(html)) fail("admin.html is not the static report");

console.log("\n--- gaffer-eval");
console.log(node("/opt/tools/gaffer-eval/main.ts", ["--data", DATA, "--sessions", "/sessions"]).trim());

// Every team id and name Gaffer has seen.
const ids = new Set();
const names = new Set();
const walk = (dir, f) => existsSync(dir) && readdirSync(dir, { recursive: true }).forEach((p) => f(join(dir, p)));
walk("/sessions", (file) => {
	if (!file.endsWith(".jsonl")) return;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.includes('"gaffer.team"') && !line.includes('"gaffer.snapshot"')) continue;
		try {
			const d = JSON.parse(line).data ?? {};
			if (Number.isInteger(d.team_id)) ids.add(d.team_id);
			if (d.team_name) names.add(d.team_name);
		} catch {}
	}
});
walk(join(DATA, "snapshots"), (file) => {
	if (!file.endsWith("/entry.json")) return;
	try {
		const e = JSON.parse(readFileSync(file, "utf8"));
		if (Number.isInteger(e.id)) ids.add(e.id);
		for (const n of [e.name, e.player_first_name && `${e.player_first_name} ${e.player_last_name}`]) if (n) names.add(n);
	} catch {}
});
let scanned = 0;
for (const sub of ["ledger", "users", "exports", "admin"]) {
	walk(join(DATA, sub), (file) => {
		let text;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			return;
		}
		scanned++;
		for (const id of ids) {
			if (new RegExp(`"(team_id|entry|team|id)":\\s*${id}\\b`).test(text) || file.includes(`/${id}/`) || new RegExp(`\\b(team|ID|entry) ${id}\\b`).test(text)) fail(`${file} holds the raw team id ${id}`);
		}
		for (const n of names) if (n.length >= 4 && text.includes(n)) fail(`${file} holds a team or manager name`);
	});
}
console.log(`\nprivacy: ${scanned} file(s) under ledger/, users/, exports/ and admin/ hold none of the ${ids.size} team id(s) or ${names.size} name(s) seen in /sessions and the snapshots`);
console.log("M5 stack check passed");
