/**
 * FR-OUT-01: validate recommendation JSON files (exports, or `gaffer.recommendation` entries pulled
 * from a session) against the published schema with ajv.
 *   node packages/pi-gaffer/scripts/check-schema.ts <file.json|session.jsonl> [...]
 * A .jsonl file is read as a Pi session: every gaffer.recommendation entry in it is checked.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

const schema = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../schemas/recommendation-1.json"), "utf8"));
const validate = new Ajv2020({ allErrors: true }).compile(schema);
let checked = 0;
let failed = 0;
for (const file of process.argv.slice(2)) {
	const text = readFileSync(file, "utf8");
	const docs = file.endsWith(".jsonl")
		? text.split("\n").filter((l) => l.includes('"gaffer.recommendation"')).map((l) => JSON.parse(l)).filter((e) => e.customType === "gaffer.recommendation").map((e) => e.data)
		: [JSON.parse(text)];
	for (const doc of docs) {
		checked++;
		if (validate(doc)) {
			console.log(`ok   ${doc.rec_id} (GW${doc.gw}, ${doc.model}) validates against schemas/recommendation-1.json — ${file}`);
		} else {
			failed++;
			console.log(`FAIL ${doc.rec_id ?? "?"} — ${file}`);
			for (const e of validate.errors ?? []) console.log(`     ${e.instancePath || "/"} ${e.message}`);
		}
	}
}
if (!checked) console.log("no recommendations found");
process.exit(failed || !checked ? 1 : 0);
