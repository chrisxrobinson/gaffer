/**
 * FR-UI-07: Gaffer's theme pair. Both files pass the validation Pi runs at start-up and load as Pi loads
 * them; the image selects them as a pair; ttyd's palette is the brand's; and every text colour is at least
 * 4.5:1 against the background it is drawn on, computed from the theme files and docs/ui/brand/tokens.json.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const piTheme = (f: string) => import(pathToFileURL(join(piDist, "modes/interactive/theme", f)).href);
const repo = join(import.meta.dirname, "../../..");
const json = (p: string) => JSON.parse(readFileSync(join(repo, p), "utf8"));
const piDark = JSON.parse(readFileSync(join(piDist, "modes/interactive/theme/dark.json"), "utf8"));
const tokens = json("docs/ui/brand/tokens.json");
const THEMES = { dark: "gaffer-dark", light: "gaffer-light" } as const;
const file = (name: string) => join(repo, "packages/pi-gaffer/themes", `${name}.json`);

/** WCAG 2 contrast ratio of two #RRGGBB colours. */
export function contrast(a: string, b: string): number {
	const lum = (hex: string) => {
		const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

// Colours that draw lines and markers, not text (WCAG's text contrast doesn't apply to them).
const NON_TEXT = new Set(["border", "borderAccent", "borderMuted", "scrollbarTrack", "scrollbarThumb", "mdCodeBlockBorder", "mdQuoteBorder", "mdHr", "bashMode", "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax"]);
const TOOL_BGS = ["toolPendingBg", "toolSuccessBg", "toolErrorBg"];

describe.each(Object.entries(THEMES))("%s theme", (mode, name) => {
	const theme = JSON.parse(readFileSync(file(name), "utf8"));
	const resolve = (v: string): string => (v in (theme.vars ?? {}) ? resolve(theme.vars[v]) : v);
	const colour = (role: string) => resolve(theme.colors[role]);
	const ground = tokens.terminal[mode].background as string;

	it(`is named ${name}, says it is for a ${mode} background, and passes Pi's start-up validation`, async () => {
		expect(theme.name).toBe(name);
		expect(theme.appearance).toBe(mode);
		const { validateThemeJson } = await piTheme("theme-schema.js");
		expect(() => validateThemeJson(name, theme)).not.toThrow();
		const { loadThemeFromPath } = await piTheme("theme.js");
		expect(loadThemeFromPath(file(name), "truecolor").name).toBe(name);
	});

	it("defines every colour role Pi's dark theme does, each as a hex colour", () => {
		expect(Object.keys(theme.colors).sort()).toEqual(Object.keys(piDark.colors).sort());
		for (const role of Object.keys(theme.colors)) expect(colour(role), role).toMatch(/^#[0-9a-fA-F]{6}$/);
	});

	it("every text colour is ≥ 4.5:1 on the terminal background and on the backgrounds Pi draws it on", () => {
		const text = Object.keys(theme.colors).filter((r) => !r.endsWith("Bg") && !NON_TEXT.has(r));
		const pairs: [string, string | null][] = text.flatMap((r) => [null, ...TOOL_BGS].map((bg): [string, string | null] => [r, bg]));
		pairs.push(["userMessageText", "userMessageBg"], ["customMessageText", "customMessageBg"], ["customMessageLabel", "customMessageBg"], ["searchMatchText", "searchMatchBg"], ["text", "selectedBg"], ["accent", "selectedBg"]);
		const low = pairs.map(([fg, bg]) => ({ fg, bg: bg ?? "terminal background", ratio: contrast(colour(fg), bg ? colour(bg) : ground) })).filter((p) => p.ratio < 4.5);
		expect(low).toEqual([]);
		expect(pairs.length).toBeGreaterThan(100);
	});
});

describe("the image's theme setting and terminal palette", () => {
	it("selects gaffer-light/gaffer-dark as a pair, which Pi resolves by the terminal's background", async () => {
		expect(json("harness/settings.json").theme).toBe("gaffer-light/gaffer-dark");
		const { resolveThemeSetting } = await piTheme("theme.js");
		expect(resolveThemeSetting("gaffer-light/gaffer-dark", "dark")).toBe("gaffer-dark");
		expect(resolveThemeSetting("gaffer-light/gaffer-dark", "light")).toBe("gaffer-light");
	});

	it("gives ttyd the brand's xterm.js palette, whose background each theme is checked against", () => {
		const entrypoint = readFileSync(join(repo, "harness/entrypoint.sh"), "utf8");
		expect(entrypoint).toMatch(/-t "theme=\$THEME"/);
		expect(entrypoint).toMatch(/require\("\/opt\/gaffer\/tokens\.json"\)\.terminal\[/);
		expect(readFileSync(join(repo, "harness/Dockerfile"), "utf8")).toMatch(/COPY docs\/ui\/brand\/tokens\.json \/opt\/gaffer\/tokens\.json/);
		for (const mode of ["dark", "light"]) {
			const p = tokens.terminal[mode];
			expect(contrast(p.foreground, p.background), mode).toBeGreaterThanOrEqual(12);
			expect(Object.keys(p)).toEqual(expect.arrayContaining(["background", "foreground", "cursor", "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightWhite"]));
		}
	});
});
