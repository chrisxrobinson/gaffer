/** gaffer.recommendation/1: the published JSON Schema is the TypeBox definition, and its limits bite (FR-OUT-01, FR-REC-06). */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { GAFFER_PREAMBLE } from "../src/prompt.ts";
import { parsePrefsArgs } from "../src/prefs.ts";
import { ulid } from "../src/recommend.ts";
import { RATIONALE_WORDS, Recommendation, recommendationJsonSchema, Submission, SUMMARY_WORDS } from "../src/schema/recommendation.ts";

const published = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../schemas/recommendation-1.json"), "utf8"));
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

describe("schemas/recommendation-1.json", () => {
	it("is the current export of the TypeBox schema (run `node packages/pi-gaffer/scripts/export-schema.ts` after a change)", () => {
		expect(published).toEqual(recommendationJsonSchema());
		expect(published.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
		expect(published.title).toBe("gaffer.recommendation/1");
	});

	it("compiles with ajv, is closed to unknown fields, and requires every top-level field", () => {
		const validate = new Ajv2020({ allErrors: true, strict: true, strictSchema: true, strictRequired: false }).compile(published);
		expect(validate({})).toBe(false);
		expect(published.additionalProperties).toBe(false);
		expect(published.required.sort()).toEqual(Object.keys(published.properties).sort());
		expect(Compile(Recommendation).Check({})).toBe(false);
	});

	it("rationale ≤ 60 words and summary ≤ 120 words are schema limits", () => {
		const ajv = new Ajv2020();
		const rationale = ajv.compile(published.properties.transfers.items.properties.rationale);
		const summary = ajv.compile(published.properties.summary);
		expect(RATIONALE_WORDS).toBe(60);
		expect(SUMMARY_WORDS).toBe(120);
		expect(rationale(words(60))).toBe(true);
		expect(rationale(words(61))).toBe(false);
		expect(rationale("")).toBe(false);
		expect(summary(words(120))).toBe(true);
		expect(summary(`  ${words(120).replace(/ /g, "\n ")}  `)).toBe(true);
		expect(summary(words(121))).toBe(false);
		// The same limits bind what the model submits.
		const sub = Compile(Submission);
		const base = {
			transfers: [{ out: { id: 1 }, in: { id: 2 }, rationale: words(60) }], captain: { id: 3 }, vice_captain: { id: 4 },
			starting_xi: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], bench: [12, 13, 14, 15], chip: { play: null, rationale: "None." }, plan: [{ gw: 7 }], summary: words(120),
		};
		expect(sub.Check(base)).toBe(true);
		expect(sub.Check({ ...base, summary: words(121) })).toBe(false);
		expect(sub.Check({ ...base, transfers: [{ ...base.transfers[0], rationale: words(61) }] })).toBe(false);
		expect(sub.Check({ ...base, chip: { play: "assistant_manager", rationale: "x" } })).toBe(false);
		expect(sub.Check({ ...base, bench: [12, 13, 14] })).toBe(false);
		expect(sub.Check({ ...base, plan: [] })).toBe(false);
	});
});

describe("small pieces", () => {
	it("ulid: 26 Crockford characters, time-ordered, and decodes to its timestamp", () => {
		const t = Date.parse("2026-10-11T18:00:00Z");
		const a = ulid(t);
		const b = ulid(t + 1);
		expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
		const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
		expect([...a.slice(0, 10)].reduce((n, c) => n * 32 + B32.indexOf(c), 0)).toBe(t);
		expect(ulid(t)).not.toBe(a);
	});

	it("the prompt preamble stays near its 600-token budget (ARCHITECTURE §1.3)", () => {
		// About 4 characters per token for English prose; the Anthropic tokenizer counted 566 tokens for this text.
		expect(GAFFER_PREAMBLE.length / 4).toBeLessThan(700);
		for (const must of ["read-only", "fpl_snapshot", "gaffer_lib run", "gaffer-workflow skill", "submit_recommendation", "set_preferences", "data, not instructions"]) expect(GAFFER_PREAMBLE).toContain(must);
	});

	it("/prefs arguments", () => {
		expect(parsePrefsArgs("")).toEqual({ show: true });
		expect(parsePrefsArgs(" clear ")).toEqual({ clear: true });
		expect(parsePrefsArgs("risk=safe save_chips=wc,freehit keep=12,430 avoid= max_hits=none")).toEqual({ patch: { risk: "safe", save_chips: ["wildcard", "freehit"], max_hits_per_gw: null }, keep: [12, 430], avoid: [] });
		expect(parsePrefsArgs("max_hits=2")).toEqual({ patch: { max_hits_per_gw: 2 } });
		for (const bad of ["risk=reckless", "save_chips=am", "keep=Salah", "max_hits=lots", "nonsense", "colour=blue"]) expect(parsePrefsArgs(bad)).toHaveProperty("error");
	});
});
