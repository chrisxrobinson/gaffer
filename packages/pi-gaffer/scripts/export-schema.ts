/**
 * Write the published JSON Schema for consumers (FR-OUT-01):
 *   node packages/pi-gaffer/scripts/export-schema.ts   →   schemas/recommendation-1.json
 * `test/schema.test.ts` fails if the file is out of date.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { recommendationJsonSchema } from "../src/schema/recommendation.ts";

const out = resolve(import.meta.dirname, "../../../schemas/recommendation-1.json");
writeFileSync(out, `${JSON.stringify(recommendationJsonSchema(), null, 2)}\n`);
console.log(out);
