/**
 * The states of docs/ui §6 that a Recommend run can reach, as the Run view shows them (fixtures/states.mjs derives
 * each from the recorded faux run). The page-level ones (empty, daily cap, a run in the other UI, reconnecting,
 * open elsewhere) are in main.js and start.js and are checked in the browser (BUILD.md, M1.1-3).
 */
import { renderToString } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
// @ts-ignore: a browser module (no build step, no types)
import { html } from "../public/app/html.js";
// @ts-ignore: a browser module (no build step, no types)
import { initialState, reduce } from "../public/app/reduce.js";
// @ts-ignore: a browser module (no build step, no types)
import { ResultView } from "../public/app/result.js";
// @ts-ignore: a browser module (no build step, no types)
import { RunView } from "../public/app/run.js";
// @ts-ignore: a fixture module
import { states } from "./fixtures/states.mjs";

const S = states() as Record<string, { t: number; rec: unknown }[]>;
const view = (name: string) => {
	const s = S[name].map((e) => e.rec).reduce(reduce, initialState());
	const page = renderToString(html`<${RunView} s=${s} now=${Date.now()} canStop=${true} />${s.result ? html`<${ResultView} rec=${s.result} />` : null}`);
	return { s, page, text: page.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ") };
};

describe("docs/ui §6: the states a Recommend run reaches", () => {
	it("running: the live step open with a spinner and the golden path's progress; Stop offered", () => {
		const { s, page, text } = view("running");
		expect(s.running).toBe(true);
		expect(page).toMatch(/<details class="step" open[^>]*data-tool="bash" data-status="running"/);
		expect(text).toMatch(/Projecting points and solving · (main solve|projected points|projecting points)/);
		expect(text).toMatch(/Running · \d+ s · \$\d\.\d{3} so far/);
		expect(text).toContain("Stop run");
	});

	it("streaming thinking: muted text growing with a cursor", () => {
		const { page } = view("thinking");
		expect(page).toMatch(/<div class="think" aria-live="polite"><span class="lbl">Thinking<\/span>[^<]+<span class="cursor"/);
	});

	it("done: every step finished and the recommendation drawn", () => {
		const { s, text } = view("done");
		expect(s.running).toBe(false);
		expect(text).toMatch(/Done in \d+ s/);
		expect(text).toContain("Starting XI");
	});

	it("budget soft cap: the banner, and the steer as a note", () => {
		const { text } = view("softcap");
		expect(text).toContain("This run has cost $0.76. Gaffer has asked the model to wrap up and submit. The hard stop is $1.50.");
		expect(text).toContain("Budget soft cap: Gaffer asked the model to wrap up.");
	});

	it("budget hard cap: stopped, over the cap, no plan saved", () => {
		const { s, text } = view("hardcap");
		expect(s.result).toBeNull();
		expect(text).toContain("Run stopped at $1.52, over the $1.50 session cap. No plan was saved.");
		expect(text).toMatch(/Stopped after \d+ s · \$\d\.\d{3} · nothing was saved/);
	});

	it("FPL updating: the stale-data banner, and the step says so", () => {
		const { text } = view("stale");
		expect(text).toMatch(/FPL is updating: using data from \d\d:\d\d UTC/);
		expect(text).toContain("stale data (fpl updating)");
	});

	it("odds source down: the Dixon-Coles line", () => {
		expect(view("oddsdown").text).toContain("Team strength comes from the Dixon-Coles model instead.");
	});

	it("error, no valid plan: the last rule that failed, and Try again", () => {
		const { s, page, text } = view("novalid");
		expect(s.result).toBeNull();
		expect(text).toMatch(/No recommendation\. 3 submissions failed the rules check, so nothing is shown or saved\. Last error: CAPTAIN_IS_VICE/);
		expect(text).toContain("No valid recommendation · 3 submissions failed the check");
		expect(page).toMatch(/data-tool="submit_recommendation" data-status="err"><summary><span class="ico err">[\s\S]*No valid recommendation/);
		expect(page).not.toMatch(/data-status="(pending|running)"/);
	});

	it("stopped by the user: what ran, and that nothing was saved", () => {
		const { s, text } = view("stopped");
		expect(s.aborted).toBe(true);
		expect(text).toMatch(/Stopped after \d+ s · \$\d\.\d{3} · nothing was saved/);
		expect(text).not.toContain("Stop run");
	});
});
