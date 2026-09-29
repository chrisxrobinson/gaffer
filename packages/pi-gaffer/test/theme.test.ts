import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const dark = JSON.parse(readFileSync(join(piDist, "modes/interactive/theme/dark.json"), "utf8"));
const gaffer = JSON.parse(readFileSync(join(import.meta.dirname, "../themes/gaffer.json"), "utf8"));

describe("Gaffer theme", () => {
	it("is named gaffer and defines every colour role Pi's dark theme does", () => {
		expect(gaffer.name).toBe("gaffer");
		expect(Object.keys(gaffer.colors).sort()).toEqual(Object.keys(dark.colors).sort());
	});
	it("resolves every colour to a hex value, palette index, var or terminal default", () => {
		for (const [role, v] of Object.entries(gaffer.colors)) {
			const ok = typeof v === "number" || v === "" || /^#[0-9a-fA-F]{6}$/.test(String(v)) || String(v) in gaffer.vars;
			expect(ok, `${role}=${v}`).toBe(true);
		}
	});
});
