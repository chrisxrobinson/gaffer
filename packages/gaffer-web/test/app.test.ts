/**
 * The App's M1.1-4 screens, rendered from the same reducer and views the browser runs:
 * - the text answers of What-if, Explain a pick and Chip planner (FR-UI-08), and the docs/ui §6 states they reach;
 * - the follow-up box and its answers under the result, with their cost (FR-UI-13);
 * - the Markdown renderer: model text stays text, never HTML;
 * - the Scorecard against a fixture outcomes.jsonl (FR-EVL-04);
 * - the page-level states (empty, daily cap, a run in the other UI, deadline passed, reconnecting, open elsewhere),
 *   which M1.1-3 checked in the browser only.
 */
import { renderToString } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { scorecard } from "../../pi-gaffer/src/outcomes.ts";
import { waitingGws } from "../../pi-gaffer/src/app-data.ts";
// @ts-ignore: a browser module (no build step, no types)
import { html } from "../public/app/html.js";
// @ts-ignore: a browser module (no build step, no types)
import { AskBox, FollowUps, suggestions } from "../public/app/followup.js";
// @ts-ignore: a browser module (no build step, no types)
import { markdown } from "../public/app/md.js";
// @ts-ignore: a browser module (no build step, no types)
import { EmptyState, NameEditor, SessionBanners, titleOf } from "../public/app/parts.js";
// @ts-ignore: a browser module (no build step, no types)
import { initialState, reduce } from "../public/app/reduce.js";
// @ts-ignore: a browser module (no build step, no types)
import { ResultView } from "../public/app/result.js";
// @ts-ignore: a browser module (no build step, no types)
import { RunView } from "../public/app/run.js";
// @ts-ignore: a browser module (no build step, no types)
import { Scorecard } from "../public/app/screens.js";
// @ts-ignore: a browser module (no build step, no types)
import { goState, StartView } from "../public/app/start.js";
// @ts-ignore: a fixture module
import { HASH, LEDGER, OUTCOMES, TOTALS } from "./fixtures/scorecard.mjs";
// @ts-ignore: a fixture module
import { FOLLOW_UP, states } from "./fixtures/states.mjs";

const S = states() as Record<string, { t: number; rec: unknown }[]>;
const text = (page: string) => page.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
const stateOf = (name: string) => S[name].map((e) => e.rec).reduce(reduce, initialState());
const session = (name: string) => {
	const s: any = stateOf(name);
	const page = renderToString(html`<${RunView} s=${s} now=${Date.now()} canStop=${true} />${s.result ? html`<${ResultView} rec=${s.result} terminal="http://127.0.0.1:7681/" /><${FollowUps} s=${s} /><${AskBox} rec=${s.result} onAsk=${() => ({ ok: true })} />` : null}`);
	return { s, page, text: text(page) };
};

describe("FR-UI-08: What-if, Explain a pick and Chip planner answer in text", () => {
	it.each([
		["whatif", "What-if: Watkins → Isak", "Watkins (AVL) out, Isak (NEW) in, in GW8 · against the best plan, over 4 and 6 GWs", "Not worth it this week."],
		["explain", "Explain Saka", "Saka (ARS) · against the GW8 recommendation, where he is in the starting XI", "Saka: 6.1 xP in GW8"],
		["chips", "Chip planner GW8–GW13", "the chips left, GW8 to GW13", "Keep all four for now."],
	])("%s: the brief, the steps, the answer as Markdown with its table; no recommendation", (name, title, brief, opening) => {
		const { s, page, text: t } = session(name);
		expect(s.result).toBeNull();
		expect(t).toContain(title);
		expect(t).toContain(brief);
		expect(page).toMatch(new RegExp(`<div class="say md"><p><strong>${opening.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</strong>`));
		expect(page).toContain('<table class="md">');
		expect(t).toMatch(/Answered in \d+ s · \$0\.012/);
		expect(t).toContain("Fetched your team and FPL data");
		expect(t).toContain("Projected points and solved a 6-GW plan");
		expect(page).not.toContain('data-tool="submit_recommendation"');
		expect(t).not.toContain("Starting XI");
		expect(page).not.toContain('id="ask"'); // the follow-up box belongs to a recommendation
	});

	it("the chips table: numbers right-aligned, every row and the not-evaluated chip shown", () => {
		const { page, text: t } = session("chips");
		expect(page).toMatch(/<th class="n">xP added<\/th>/);
		for (const row of ["Bench Boost 11 +6.8 9", "Triple Captain 10 +7.4 8", "Free Hit 12 +3.1 13", "Wildcard not evaluated – –"]) expect(t).toContain(row);
	});

	it("a text run streaming its answer: running, Stop offered, the answer so far", () => {
		const { s, text: t } = session("whatif-running");
		expect(s.running).toBe(true);
		expect(t).toMatch(/Running · \d+ s · \$\d\.\d{3} so far/);
		expect(t).toContain("Stop run");
		expect(t).toContain("Not worth it this week.");
	});

	it("a text run stopped at the hard cap: the banner, and nothing answered", () => {
		const { s, text: t } = session("whatif-hardcap");
		expect(s.aborted).toBe(true);
		expect(t).toContain("Run stopped at $1.52, over the $1.50 session cap. No plan was saved.");
		expect(t).toMatch(/Stopped after \d+ s · \$\d\.\d{3} · nothing was saved/);
	});

	it("the rail lists each by its run's title until it is renamed", () => {
		expect(titleOf({ name: null, title: "What-if: keep Watkins", action: "whatif", gw: 8 })).toBe("What-if: keep Watkins");
		expect(titleOf({ name: "My plan", title: "Chip planner GW8–GW13", action: "chips", gw: 8 })).toBe("My plan");
		expect(titleOf({ name: null, title: null, action: "recommend", gw: 8 })).toBe("Recommend GW8");
	});
});

describe("FR-UI-13: the follow-up box", () => {
	it("the box: 280 characters at most, three suggested questions from the recommendation, / to focus it", () => {
		const { s, page, text: t } = session("done");
		expect(page).toMatch(/<textarea id="ask"[^>]*maxlength="280"/);
		expect(t).toContain("Ask about this plan");
		const qs = suggestions(s.result);
		expect(qs).toHaveLength(3);
		expect(qs[0]).toBe(`Why ${s.result.captain.name} as captain rather than ${s.result.vice_captain.name}?`);
		for (const q of qs) expect(t).toContain(q);
		expect(t).toContain("Press / to type here.");
		expect(t).toContain("0/280");
	});

	it("a faux follow-up's answer is drawn under the result, in the same session, with its cost; the run above is unchanged", () => {
		const { s, page, text: t } = session("followup");
		expect(s.asks).toHaveLength(1);
		const result = page.indexOf('<article class="result"');
		const answer = page.indexOf('<article class="answer"');
		expect(result).toBeGreaterThan(0);
		expect(answer).toBeGreaterThan(result);
		const below = text(page.slice(answer));
		expect(below).toContain(`You asked ${FOLLOW_UP}`);
		expect(below).toContain("Haaland's 7.9 xP against Salah's 6.4 decides it");
		expect(below).toContain("This answer cost $0.014");
		expect(page.slice(answer)).toMatch(/<ul><li>Salah's fixture is away/);
		// The run's own transcript doesn't carry the question; its cost line is the run's alone.
		expect(text(page.slice(0, result))).not.toContain(FOLLOW_UP);
		expect(t).toMatch(/Done in \d+ s · \$0\.000/);
	});

	it("while it is being answered: Answering, with the cost so far", () => {
		const events = S.followup.slice(0, -4).map((e) => e.rec);
		const s: any = events.reduce(reduce, initialState());
		const page = renderToString(html`<${FollowUps} s=${s} /><${AskBox} rec=${s.result} busy=${s.running} onAsk=${() => ({ ok: true })} />`);
		expect(text(page)).toMatch(/Answering · \$0\.00\d so far/);
		expect(text(page)).toContain("Answering…");
	});

	it("read-only when the other UI holds the session", () => {
		const { s } = session("done");
		const page = renderToString(html`<${AskBox} rec=${s.result} disabled=${true} onAsk=${() => ({ ok: true })} />`);
		expect(page).toMatch(/<textarea id="ask"[^>]*disabled/);
		expect(text(page)).toContain("Read-only here: this session is open in the browser terminal.");
	});
});

describe("the Markdown renderer: model text stays text", () => {
	const md = (s: string) => renderToString(html`<div>${markdown(s)}</div>`);
	it("paragraphs, bold, lists, tables and headings, as elements", () => {
		const out = md("# Verdict\n\nKeep **Watkins**.\nIt holds.\n\n- one\n- two **bold**\n\n1. first\n2. second\n\n| a | b |\n|---|--:|\n| x | 1.5 |");
		expect(out).toBe('<div><p class="md-h"><strong>Verdict</strong></p><p>Keep <strong>Watkins</strong>. It holds.</p><ul><li>one</li><li>two <strong>bold</strong></li></ul><ol><li>first</li><li>second</li></ol><div class="scroll-x"><table class="md"><thead><tr><th>a</th><th class="n">b</th></tr></thead><tbody><tr><td>x</td><td class="n">1.5</td></tr></tbody></table></div></div>');
	});
	it("markup and links in the text are shown as characters, never run or followed", () => {
		const out = md('<img src=x onerror=alert(1)> **<script>alert(2)</script>** [a](javascript:alert(3)) ![i](http://evil.example/x.png)\n\n| <b>x</b> |\n|---|\n| <iframe src="http://evil.example"> |');
		expect(out).not.toMatch(/<(img|script|iframe|a|b)\b/);
		expect(out).toContain("&lt;img src=x onerror=alert(1)>");
		expect(out).toContain("<strong>&lt;script>alert(2)&lt;/script></strong>");
		expect(out).toContain("[a](javascript:alert(3))");
	});
	it("streaming text that stops mid-table or mid-bold still renders", () => {
		expect(md("| a | b |\n|---|")).toContain("<table");
		expect(md("**half")).toBe("<div><p>**half</p></div>");
		expect(md("")).toBe("<div></div>");
	});
});

describe("FR-EVL-04: the Scorecard against outcomes.jsonl", () => {
	const card = { ...scorecard(OUTCOMES, HASH), waiting: waitingGws(LEDGER, OUTCOMES, HASH, undefined) };
	const page = renderToString(html`<${Scorecard} card=${card} teamName="Test XI" />`);
	it("the season totals equal the file's counted rows", () => {
		expect(card.totals).toEqual(TOTALS);
		for (const [k, v] of Object.entries({ gaffer: 126, actual: 99, b0: 107, b1: 101 })) expect(page).toMatch(new RegExp(`data-total="${k}"><div class="lbl">.*?</div><div class="fig">${v}</div>`));
		expect(text(page)).toContain("Gaffer against you +27 · against holding +19 · against the best swap +25");
		expect(text(page)).toMatch(/All 126 99 107 101 122\.7/);
	});
	it("one bar group per scored GW, with a table as its text equivalent", () => {
		expect(page.match(/class="sc-gw"/g)).toHaveLength(2);
		expect(page).toMatch(/<div class="sc-bars" aria-hidden="true">/);
		expect(text(page)).toMatch(/6 55 48 62 57 60\.2 .*7 71 51 45 44 62\.5/);
		expect(text(page)).toContain("1 earlier recommendation was scored but not counted");
	});
	it("GWs waiting to be scored, with when; test rows and other teams left out", () => {
		expect(card.waiting).toEqual([{ gw: 8, recommendations: 2, when: "once FPL marks it finished and checked", by: null }]);
		expect(text(page)).toContain("Waiting to be scored GW8 · 2 recommendations · scored once FPL marks it finished and checked");
		const events = [{ id: 8, deadline_time: "2026-10-23T17:30:00Z", finished: false, data_checked: false }, { id: 9, deadline_time: "2026-10-31T11:00:00Z", finished: false, data_checked: false }];
		const b = { events } as never;
		expect(waitingGws(LEDGER, OUTCOMES, HASH, b)[0]).toMatchObject({ when: "after its last match, once FPL checks the data (before the GW9 deadline)", by: "2026-10-31T11:00:00Z" });
		events[0].finished = true;
		expect(waitingGws(LEDGER, OUTCOMES, HASH, b)[0].when).toBe("once FPL checks the data (usually within a day of the last match)");
	});
	it("no scored GW yet", () => {
		const empty = renderToString(html`<${Scorecard} card=${{ ...scorecard([], HASH), waiting: [] }} />`);
		expect(text(empty)).toContain("No finished GW has been scored for this team yet.");
	});
});

describe("docs/ui §6: the page-level states", () => {
	const home = (patch: Record<string, unknown> = {}) => ({ gw: { current: 7, next: 8, deadline: new Date(Date.now() + 3 * 86_400_000).toISOString(), season: "2026/27" }, now: Date.now(), fetchedAt: Date.now(), spend: { today: 0.12, daily: 5, soft: 0.75, hard: 1.5 }, busy: null, sessions: [], ...patch });
	const start = (h: Record<string, unknown>) => text(renderToString(html`<${StartView} home=${h} api=${{ get: async () => ({ ok: false, status: 0, body: {} }), post: async () => ({ ok: false }) }} onStarted=${() => {}} onOpen=${() => {}} />`));

	it("empty: the mark, No sessions yet, the next deadline", () => {
		const t = text(renderToString(html`<${EmptyState} home=${home()} />`));
		expect(t).toContain("No sessions yet");
		expect(t).toContain("for GW8");
		expect(t).toContain("Deadline ");
	});

	it("daily cap reached: the banner, and Go unavailable for every action that runs (not Scorecard or Preferences)", () => {
		const h = home({ spend: { today: 5.02, daily: 5, soft: 0.75, hard: 1.5 } });
		expect(start(h)).toContain("Today's spend is $5.02 of the $5.00 daily cap. New runs can start after midnight UTC.");
		expect(goState({ home: h, teamOk: true, complete: true, runs: true })).toMatchObject({ ready: false, blocked: "capped" });
		expect(goState({ home: h, teamOk: true, complete: true, runs: false })).toMatchObject({ ready: true, blocked: null });
	});

	it("a run in the other UI: the banner, and Go waits", () => {
		const h = home({ busy: { ui: "terminal" } });
		expect(start(h)).toContain("A run is in progress in the browser terminal. Gaffer runs one at a time here; Go is available when it finishes.");
		expect(goState({ home: h, teamOk: true, complete: true, runs: true })).toMatchObject({ ready: false, blocked: "busy" });
	});

	it("deadline passed, on Start: the banner, and no run for the old GW", () => {
		const h = home({ gw: { current: 7, next: 8, deadline: new Date(Date.now() - 60_000).toISOString(), season: "2026/27" } });
		expect(start(h)).toMatch(/The GW8 deadline has passed \(.+\)\. Gaffer plans GW9 once FPL has moved on to it/);
		expect(goState({ home: h, teamOk: true, complete: true, runs: true })).toMatchObject({ ready: false, blocked: "passed" });
		// The page's clock moves on from the home answer: a deadline a second away has passed a minute later.
		const soon = home({ gw: { current: 7, next: 8, deadline: new Date(Date.now() + 1000).toISOString() } });
		expect(goState({ home: soon, teamOk: true, complete: true, runs: true, now: Date.now() + 60_000 }).blocked).toBe("passed");
		expect(goState({ home: home(), teamOk: true, complete: true, runs: true })).toMatchObject({ ready: true, blocked: null });
	});

	it("deadline passed, on Result: the plan waits to be scored", () => {
		const s: any = stateOf("done");
		const t = text(renderToString(html`<${ResultView} rec=${s.result} now=${Date.parse(s.result.deadline) + 1000} />`));
		expect(t).toContain(`The GW${s.result.gw} deadline has passed`);
		expect(t).toContain("This plan waits to be scored; a new run plans the next GW.");
	});

	it("reconnecting: while loading and over a shown transcript", () => {
		expect(text(renderToString(html`<${SessionBanners} conn="reconnecting" loading />`))).toContain("Reconnecting… The App's server can't be reached yet");
		expect(text(renderToString(html`<${SessionBanners} conn="reconnecting" />`))).toContain("Reconnecting… The run continues on the server; the transcript fills in from where it left off.");
		expect(renderToString(html`<${SessionBanners} conn="ok" />`)).toBe("");
	});

	it("open elsewhere: the notice, and the run's line says where it runs", () => {
		const banner = text(renderToString(html`<${SessionBanners} conn="ok" lock=${{ ui: "terminal", running: true }} />`));
		expect(banner).toContain("This session is also open in the browser terminal.");
		expect(banner).toContain("only one can send a prompt at a time, so it is read-only here");
		const run = text(renderToString(html`<${RunView} s=${stateOf("running")} now=${Date.now()} canStop=${false} elsewhere="running" />`));
		expect(run).toMatch(/Running in the browser terminal · \$\d\.\d{3} so far/);
		expect(run).not.toContain("Stop run");
	});

	it("rename: an inline editor, 80 characters at most, with how to save and cancel", () => {
		const page = renderToString(html`<${NameEditor} initial="Recommend GW8" onSave=${async () => ({ ok: true })} onDone=${() => {}} />`);
		expect(page).toMatch(/<input class="input" aria-label="Session name" maxlength="80" value="Recommend GW8"/);
		expect(text(page)).toContain("Enter to save, Esc to cancel");
	});

	it("Open in terminal is a link to the terminal's own page, not a terminal in the App", () => {
		const { page } = session("done");
		expect(page).toMatch(/<a class="btn small" href="http:\/\/127\.0\.0\.1:7681\/" target="_blank" rel="noopener noreferrer">Open in terminal<\/a>/);
		expect(text(page)).toContain("this session is under /resume there. The App itself has no terminal.");
	});
});
