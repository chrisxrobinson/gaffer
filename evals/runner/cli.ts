/**
 * `pnpm eval` (FR-EVL-02): run the eval suite through the real stack and write
 * evals/results/<date>-<model>.jsonl (one line per case, then a summary line) and a .summary.json.
 *
 *   pnpm eval                                   # the scripted faux model: free, what CI runs
 *   pnpm eval --model anthropic/claude-sonnet-5-5   # a real model: costs money (about $0.05 a case)
 *   pnpm eval --only l6-d,h2425-gw33-dgw --thinking medium
 *
 * Needs `docker compose up` (deploy/compose) and the built history (tools/fetch_history.py once).
 * 1. builds the cases into var/evals/cases (evals/build/build_cases.py, uv);
 * 2. copies them to /data/evals/cases in the harness container;
 * 3. runs evals/runner/run.ts there: the installed package, the real sandbox and solver, and for a real
 *    model the key from the Compose secret (never for faux). Sessions go to /sessions/evals/<run>, so
 *    they count against the daily cap and show in `gaffer admin`;
 * 4. copies the results back and checks every recommendation against schemas/recommendation-1.json
 *    with ajv (FR-OUT-01 over the suite).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";

const REPO = resolve(import.meta.dirname, "../..");
const COMPOSE = ["compose", "-f", join(REPO, "deploy/compose/docker-compose.yml")];
const { values } = parseArgs({
	options: {
		model: { type: "string", default: "faux" },
		thinking: { type: "string", default: "medium" },
		only: { type: "string" },
		"no-build": { type: "boolean", default: false },
		timeout: { type: "string", default: "300" },
	},
});
const model = values.model!;
const real = model !== "faux";

if (!values["no-build"]) {
	console.log("== building the cases (evals/build/build_cases.py)");
	const py = spawnSync("uv", ["run", "--no-project", "--python", "3.14", "--with", "numpy==2.5.3", "--with", "pandas==3.0.6", "--with", "scipy==1.18.1",
		"python", join(REPO, "evals/build/build_cases.py"), ...(values.only ? ["--only", values.only] : [])], { stdio: "inherit", env: { ...process.env, PYTHONPATH: join(REPO, "python/gaffer_lib/src") } });
	if (py.status !== 0) process.exit(py.status ?? 1);
}

console.log("== copying the cases into the harness container (/data/evals/cases)");
// COPYFILE_DISABLE: macOS's tar would otherwise add extended attributes that GNU tar warns about.
const tar = execFileSync("tar", ["-C", join(REPO, "var/evals"), "-cf", "-", "cases"], { maxBuffer: 1 << 30, env: { ...process.env, COPYFILE_DISABLE: "1" } });
execFileSync("docker", [...COMPOSE, "exec", "-T", "gaffer", "sh", "-c", "rm -rf /data/evals/cases && mkdir -p /data/evals/results && tar --warning=no-unknown-keyword -C /data/evals -xf -"], { input: tar, stdio: ["pipe", "inherit", "inherit"] });

const slug = model.replace(/[^A-Za-z0-9.-]+/g, "_");
const date = new Date().toISOString().slice(0, 10);
let name = `${date}-${slug}`;
for (let n = 2; existsSync(join(REPO, "evals/results", `${name}.jsonl`)); n++) name = `${date}-${slug}-${n}`;
const remote = `/data/evals/results/${name}.jsonl`;
console.log(`== running the suite with ${model}${real ? " (THIS COSTS MONEY)" : ""}`);
const script = [
	"set -eu",
	real ? 'ANTHROPIC_API_KEY="$(cat /run/secrets/anthropic_api_key)"; export ANTHROPIC_API_KEY' : "unset ANTHROPIC_API_KEY || true",
	"cd /work",
	`node /opt/evals/runner/run.ts --cases /data/evals/cases --model '${model}' --thinking '${values.thinking}' --out '${remote}' --sessions /sessions/evals --data /data/evals/runs --timeout '${values.timeout}'${values.only ? ` --only '${values.only}'` : ""}`,
].join("\n");
const run = spawnSync("docker", [...COMPOSE, "exec", "-T", "gaffer", "sh", "-c", script], { stdio: "inherit" });
if (run.status !== 0) {
	console.error(`the runner exited ${run.status}`);
	process.exit(run.status ?? 1);
}

const local = join(REPO, "evals/results", `${name}.jsonl`);
mkdirSync(join(REPO, "evals/results"), { recursive: true });
writeFileSync(local, execFileSync("docker", [...COMPOSE, "exec", "-T", "gaffer", "cat", remote], { maxBuffer: 1 << 28 }));
const rows = readFileSync(local, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const cases = rows.filter((r) => r.schema === "gaffer.evalresult/1");
const summary = rows.find((r) => r.schema === "gaffer.evalsummary/1");

// FR-OUT-01 over the suite: every stored recommendation against the published JSON Schema, with ajv.
const schema = JSON.parse(readFileSync(join(REPO, "schemas/recommendation-1.json"), "utf8"));
const check = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
const invalid = cases.filter((r) => r.recommendation && !check(r.recommendation)).map((r) => r.case);
summary.schema_check = { tool: "ajv 8.20.0", schema: "schemas/recommendation-1.json", recommendations: cases.filter((r) => r.recommendation).length, invalid };
writeFileSync(local.replace(/\.jsonl$/, ".summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

console.log(`\n== ${local}`);
console.log(`${"case".padEnd(28)} ${"valid".padEnd(6)} ${"pts".padStart(5)} ${"G0".padStart(5)} ${"diff".padStart(5)} ${"cost".padStart(8)} ${"secs".padStart(5)}  grades`);
for (const r of cases) {
	const g = Object.entries(r.grades as Record<string, { pass: boolean }>).filter(([k]) => k !== "valid").map(([k, v]) => `${k}:${v.pass ? "ok" : "FAIL"}`).join(" ");
	console.log(`${r.case.padEnd(28)} ${String(r.valid).padEnd(6)} ${String(r.points.recommended ?? "–").padStart(5)} ${String(r.points.g0 ?? "–").padStart(5)} ${String(r.points.diff ?? "–").padStart(5)} ${`$${r.cost.toFixed(4)}`.padStart(8)} ${r.latency_ms === null ? "    –" : String(Math.round(r.latency_ms / 1000)).padStart(5)}  ${g}${r.error ? ` error: ${r.error}` : ""}`);
}
const s = summary;
console.log(`\nvalidator pass ${s.validator_pass.passed}/${s.validator_pass.of}; points vs G0 ${s.points_vs_g0.diff >= 0 ? "+" : ""}${s.points_vs_g0.diff} over ${s.points_vs_g0.cases} scored case(s) (${s.points_vs_g0.better} better, ${s.points_vs_g0.same} same, ${s.points_vs_g0.worse} worse)`);
console.log(`preferences ${s.preferences.passed}/${s.preferences.cases}; injection ${s.injection.passed}/${s.injection.cases}; expectations ${s.expectations.passed}/${s.expectations.cases}; schema-invalid recommendations: ${invalid.length}`);
console.log(`cost $${s.cost.total.toFixed(4)} (median $${(s.cost.median_per_recommendation ?? 0).toFixed(4)} per recommendation); latency p50 ${((s.latency_ms.p50 ?? 0) / 1000).toFixed(0)} s, p95 ${((s.latency_ms.p95 ?? 0) / 1000).toFixed(0)} s; Wildcard/Free Hit not evaluated in ${s.wildcard_or_free_hit_not_evaluated.cases}/${s.wildcard_or_free_hit_not_evaluated.of}`);
process.exit(invalid.length ? 1 : 0);
