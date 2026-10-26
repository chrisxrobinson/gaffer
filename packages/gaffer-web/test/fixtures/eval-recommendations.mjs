// Writes eval-recommendations.json from a faux eval run's results (gitignored): every recommendation, with the
// team hash replaced, so the renderer test (FR-UI-10) has all of them in CI.
//   node test/fixtures/eval-recommendations.mjs ../../evals/results/<run>-faux.jsonl
import { readFileSync, writeFileSync } from "node:fs";

const [file] = process.argv.slice(2);
const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.schema === "gaffer.evalresult/1" && r.recommendation);
const out = rows.map((r) => ({ case: r.case, run_id: r.run_id, recommendation: { ...r.recommendation, team_id_hash: `hmac-sha256:${"0".repeat(64)}` } }));
writeFileSync(new URL("./eval-recommendations.json", import.meta.url), `${JSON.stringify(out)}\n`);
console.log(`${out.length} recommendations from ${file}`);
