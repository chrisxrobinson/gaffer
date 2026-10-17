/**
 * gaffer admin (FR-ADM-01, ARCHITECTURE §9): writes a static admin.html from /sessions and /data only.
 *
 *   node tools/gaffer-admin/main.ts [--sessions /sessions] [--data /data] [--out /data/admin/admin.html]
 *
 * In the stack: docker compose exec gaffer node /opt/tools/gaffer-admin/main.ts
 * then: docker compose exec gaffer cat /data/admin/admin.html > admin.html
 * It prints the totals it wrote, so a hand count can be compared with them.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { buildAdmin } from "../../packages/pi-gaffer/src/admin.ts";
import { readLedger } from "../../packages/pi-gaffer/src/ledger.ts";
import { readOutcomes } from "../../packages/pi-gaffer/src/outcomes.ts";
import { scanSessions } from "../../packages/pi-gaffer/src/usage.ts";

const { values } = parseArgs({
	options: { sessions: { type: "string", default: "/sessions" }, data: { type: "string", default: process.env.GAFFER_DATA_DIR ?? "/data" }, out: { type: "string" }, now: { type: "string" } },
});
const data = values.data!;
const out = values.out ?? join(data, "admin", "admin.html");
const sessions = scanSessions(values.sessions!);
const report = buildAdmin({
	sessions, ledger: readLedger(data), outcomes: readOutcomes(data), generatedAt: values.now ? new Date(values.now) : new Date(), sources: { sessions: values.sessions!, data },
});
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, report.html);
const t = report.totals;
console.log(`admin.html written to ${out}`);
console.log(`sessions ${t.sessions}; model calls ${t.calls}; cost $${t.cost.toFixed(4)} (today $${t.today.toFixed(4)}); tokens input ${t.tokens.input}, output ${t.tokens.output}, cache read ${t.tokens.cacheRead}, cache write ${t.tokens.cacheWrite}`);
console.log(`runs ${t.runs}; recommendations ${t.recommendations}; prompt → recommendation p50 ${t.runLatency.p50 === null ? "–" : `${(t.runLatency.p50 / 1000).toFixed(1)} s`}, p95 ${t.runLatency.p95 === null ? "–" : `${(t.runLatency.p95 / 1000).toFixed(1)} s`} (n ${t.runLatency.n}); errors ${t.errors}`);
for (const s of sessions) console.log(`  ${s.file}: ${s.calls} calls, $${s.cost.toFixed(4)}, ${s.recommendations.length} rec(s)`);
