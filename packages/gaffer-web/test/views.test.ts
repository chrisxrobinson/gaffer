/**
 * The App's views, rendered in Node with the vendored Preact (vitest.config.ts):
 * - FR-UI-10: the Result view over every eval recommendation the faux suite produced; the JSON is its only input.
 * - FR-UI-11: the JSON export is the stored entry byte for byte (as Pi writes it) and valid; the CSV parses.
 * - FR-UI-09: a scripted run with one rejected submission becomes the steps in order, from data alone.
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse } from "csv-parse/sync";
import { renderToString } from "preact-render-to-string";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-ignore: a browser module (no build step, no types)
import { CHIP, money, sign, xp } from "../public/app/format.js";
// @ts-ignore: a browser module (no build step, no types)
import { html } from "../public/app/html.js";
// @ts-ignore: a browser module (no build step, no types)
import { historyEvents, initialState, reduce } from "../public/app/reduce.js";
// @ts-ignore: a browser module (no build step, no types)
import { exportCsv, exportJson, ResultView } from "../public/app/result.js";
// @ts-ignore: a browser module (no build step, no types)
import { describeStep, RunView } from "../public/app/run.js";
import { historyOf } from "../src/bridge.ts";

const REPO = resolve(import.meta.dirname, "../../..");
const SCHEMA = JSON.parse(readFileSync(join(REPO, "schemas/recommendation-1.json"), "utf8"));
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(SCHEMA);

/**
 * Every recommendation of a faux eval run: the committed fixture (eval-recommendations.json, 31 cases since
 * M1.1-0), plus any faux run's results kept locally under deploy/compose/m11*\/results (gitignored).
 */
function evalRecommendations(): { file: string; case: string; rec: any }[] {
	const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures/eval-recommendations.json"), "utf8")) as { case: string; run_id: string; recommendation: any }[];
	const out = fixture.map((r) => ({ file: `fixture ${r.run_id}`, case: r.case, rec: r.recommendation }));
	for (const d of readdirSync(join(REPO, "deploy/compose")).filter((x) => /^m11\d$/.test(x))) {
		const dir = join(REPO, "deploy/compose", d, "results");
		let files: string[] = [];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith("-faux.jsonl"));
		} catch {
			continue;
		}
		for (const f of files) {
			for (const line of readFileSync(join(dir, f), "utf8").trim().split("\n")) {
				const r = JSON.parse(line);
				if (r.schema === "gaffer.evalresult/1" && r.recommendation) out.push({ file: `${d}/${f}`, case: r.case, rec: r.recommendation });
			}
		}
	}
	return out;
}
const RECS = evalRecommendations();
const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const textOf = (h: string) => decode(h.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
/** The rendered text of the element carrying one data attribute value (its whole subtree). */
function within(h: string, attr: string, value: string): string {
	const i = h.indexOf(`${attr}="${value}"`);
	expect(i, `${attr}=${value} rendered`).toBeGreaterThan(-1);
	const start = h.lastIndexOf("<", i);
	const tag = /^<(\w+)/.exec(h.slice(start))![1];
	const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, "g");
	re.lastIndex = start + 1;
	let depth = 1;
	for (let m = re.exec(h); m; m = re.exec(h)) {
		depth += m[0].startsWith("</") ? -1 : 1;
		if (!depth) return textOf(h.slice(start, m.index + m[0].length));
	}
	throw new Error(`unbalanced <${tag}>`);
}

describe("FR-UI-10: the Result view from gaffer.recommendation/1 only", () => {
	it("has every eval recommendation: at least the 31 of one faux run", () => {
		const byFile = new Map<string, number>();
		for (const r of RECS) byFile.set(r.file, (byFile.get(r.file) ?? 0) + 1);
		expect([...byFile.values()].every((n) => n >= 31)).toBe(true);
		expect(byFile.size).toBeGreaterThanOrEqual(1);
	});

	it.each(RECS.map((r) => [`${r.file} ${r.case}`, r.rec]))("%s", (_name, rec) => {
		const h = renderToString(html`<${ResultView} rec=${rec} now=${Date.parse(rec.created_at)} />`);
		const t = textOf(h);
		// Headline, summary, confidence and warnings.
		expect(t).toContain(`GW${rec.gw}`);
		expect(t).toContain(xp(rec.expected_points_gw));
		expect(t).toContain(sign(rec.net_xp_gain_4gw));
		expect(t).toContain(rec.summary.trim().replace(/\s+/g, " "));
		for (const w of rec.warnings) expect(t).toContain(w.replace(/\s+/g, " ").trim());
		// Every transfer with its prices, gains, confidence and rationale.
		for (const tr of rec.transfers) {
			const row = within(h, "data-transfer", `${tr.out.id}>${tr.in.id}`);
			for (const part of [tr.out.name, tr.in.name, money(tr.in.price), money(tr.out.sell_price), sign(tr.xp_gain_4gw), sign(tr.xp_gain_6gw_decayed), tr.confidence, tr.rationale.trim().replace(/\s+/g, " ")]) expect(row).toContain(part);
		}
		// The captain and vice with their xP and P(start).
		for (const [r, mark] of [[rec.captain, "C"], [rec.vice_captain, "V"]] as const) {
			const role = within(h, "data-role", mark);
			for (const part of [r.name, xp(r.xp), r.p_start.toFixed(2)]) expect(role).toContain(part);
		}
		// All 15 players: the XI on the pitch (captain doubled) and the bench in order, goalkeeper first.
		for (const id of rec.starting_xi) {
			const p = rec.players[String(id)];
			const counter = within(h, "data-player", String(id));
			expect(counter).toContain(p.name);
			expect(counter).toContain(p.team);
			expect(counter).toContain(xp(id === rec.captain.id ? p.xp * 2 : p.xp));
		}
		const benchHtml = h.slice(h.indexOf('class="bench"'));
		rec.bench.forEach((id: number, i: number) => {
			const slot = within(benchHtml, "data-player", String(id));
			expect(slot).toContain(i === 0 ? "GK" : String(i));
			expect(slot).toContain(rec.players[String(id)].name);
		});
		expect(new Set([...h.matchAll(/data-player="(\d+)"/g)].map((m) => m[1])).size).toBe(15);
		// Every chip scenario: the chip, its GW and its value, or why it wasn't evaluated.
		for (const s of rec.chip.scenarios) {
			const cellText = within(h, "data-scenario", s.evaluated ? `${s.chip}:${s.gw}` : `${s.chip}:-`);
			expect(cellText).toContain(CHIP[s.chip]);
			if (s.evaluated) expect(t).toContain(sign(s.delta_xp));
			else expect(t).toContain(s.reason);
		}
		// Every plan GW: its moves, captain, FT and xP.
		for (const g of rec.plan) {
			const row = within(h, "data-gw", String(g.gw));
			for (const part of [String(g.gw), xp(g.expected_points), rec.players[String(g.captain)]?.name ?? String(g.captain), String(g.free_transfers)]) expect(row).toContain(part);
			for (const m of g.transfers) expect(row).toContain(`${m.out.name} → ${m.in.name}`);
			if (!g.transfers.length) expect(row).toContain("Roll");
		}
		// Model-written text is text: nothing it holds becomes markup.
		expect(h).not.toMatch(/<script|on\w+="/i);
	});

	it("renders an injected rationale as text, never as HTML", () => {
		const rec = structuredClone(RECS[0].rec);
		rec.summary = '<img src=x onerror="alert(1)"> <b>bold</b>';
		if (rec.transfers[0]) rec.transfers[0].rationale = "<script>alert(1)</script>";
		const h = renderToString(html`<${ResultView} rec=${rec} />`);
		expect(h).not.toContain("<img");
		expect(h).not.toContain("<script>");
		expect(h).toContain("&lt;img src=x onerror=");
	});
});

describe("FR-UI-11: export", () => {
	it("the JSON equals the session's gaffer.recommendation entry byte for byte, and validates", () => {
		const dir = mkdtempSync(join(tmpdir(), "gaffer-export-"));
		const sm = SessionManager.create("/work", dir);
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "recommend" }], timestamp: Date.now() } as never); // Pi writes the file from the first message
		for (const { rec } of RECS) sm.appendCustomEntry("gaffer.recommendation", rec);
		const text = readFileSync(sm.getSessionFile()!, "utf8");
		const lines = text.trim().split("\n").filter((l) => l.includes('"gaffer.recommendation"'));
		expect(lines).toHaveLength(RECS.length);
		// What the page has is the bridge's history of that file (historyOf): the export is built from it.
		const fromHistory = historyOf(text).filter((e) => e.customType === "gaffer.recommendation").map((e) => e.data);
		fromHistory.forEach((rec, i) => {
			const out = exportJson(rec);
			expect(lines[i]).toContain(`"data":${out},"id"`);
			expect(validate(JSON.parse(out)), JSON.stringify(validate.errors)).toBe(true);
		});
	});

	it.each(RECS.slice(0, 31).map((r) => [r.case, r.rec]))("the CSV of %s parses with a standard reader: one row per transfer, captain, vice and plan GW", (_c, rec) => {
		const rows = parse(exportCsv(rec), { columns: true, skip_empty_lines: true }) as Record<string, string>[];
		expect(rows.map((r) => r.kind)).toEqual([...rec.transfers.map(() => "transfer"), "captain", "vice_captain", ...rec.plan.map(() => "plan")]);
		rec.transfers.forEach((t: any, i: number) => expect(rows[i]).toMatchObject({ gw: String(rec.gw), out: t.out.name, in: t.in.name, price: String(t.in.price), xp_gain_4gw: String(t.xp_gain_4gw), confidence: t.confidence }));
		expect(rows.find((r) => r.kind === "captain")).toMatchObject({ in: rec.captain.name, expected_points: String(rec.captain.xp) });
		expect(rows.filter((r) => r.kind === "plan").map((r) => Number(r.gw))).toEqual(rec.plan.map((g: any) => g.gw));
	});

	it("CSV cells with commas, quotes and formula characters survive a round trip safely", () => {
		const rec = structuredClone(RECS[0].rec);
		rec.captain.name = 'O"Neil, =HYPERLINK("x")';
		const rows = parse(exportCsv(rec), { columns: true }) as Record<string, string>[];
		expect(rows.find((r) => r.kind === "captain")!.in).toBe(`'O"Neil, =HYPERLINK("x")`.replace(/^'/, "")); // starts with O: no prefix
		rec.captain.name = "=1+1";
		expect((parse(exportCsv(rec), { columns: true }) as Record<string, string>[]).find((r) => r.kind === "captain")!.in).toBe("'=1+1");
	});
});

/** A scripted (faux) Gaffer run as the bridge forwards it: recorded from the real stack (test/fixtures/README.md). */
const fixture = (f: string) => readFileSync(resolve(import.meta.dirname, "fixtures", f), "utf8");

describe("FR-UI-09: a run as it streams, as steps from data", () => {
	let RUN: any[] = [];
	beforeAll(() => {
		RUN = fixture("faux-run.jsonl").trim().split("\n").map((l) => JSON.parse(l).rec);
	});
	const state = (events: any[]) => events.reduce(reduce, initialState());
	const steps = (s: any) => s.items.filter((x: any) => x.kind === "step").map((x: any) => s.steps[x.id]).filter((st: any) => !describeStep(st).minor);

	it("shows the snapshot step, the plan step, a failed check naming the rule, then a passed check, in order", () => {
		const s = state(RUN);
		const v = steps(s).map((st: any) => [st.tool, st.status, describeStep(st)]);
		expect(v.map(([tool, status, d]: any) => `${tool}:${status}:${d.label}`)).toEqual([
			"fpl_snapshot:ok:Fetched your team and FPL data",
			"bash:ok:Projected points and solved a 6-GW plan",
			"submit_recommendation:err:Submitted the recommendation",
			"submit_recommendation:ok:Submitted the recommendation",
		]);
		const [snap, plan, rejected, passed] = v.map(([, , d]: any) => d);
		expect(snap.summary).toMatch(/^fresh · 15 players · bank £\d+\.\dm · \d+ FT \(derived\)/);
		expect(plan.summary).toMatch(/^\d plans? · solver \w+/);
		expect(rejected.summary).toMatch(/^rejected: [A-Z_]+, attempt 1 of 3 · the model will retry$/);
		expect(rejected.errors.length).toBeGreaterThan(0);
		expect(passed.summary).toMatch(/^valid on attempt 2 · every number recomputed/);
		expect(s.result?.schema).toBe("gaffer.recommendation/1");
		const page = textOf(renderToString(html`<${RunView} s=${s} now=${Date.now()} />`));
		const order = ["Fetched your team and FPL data", "Projected points and solved a 6-GW plan", `rejected: ${rejected.errors[0].code}`, "valid on attempt 2"].map((x) => page.indexOf(x));
		expect(order.every((i) => i >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	it("parses no text from the model: the steps are the same when every word the model wrote is changed", () => {
		const scramble = (e: any) => {
			const c = structuredClone(e);
			const a = c.assistantMessageEvent;
			if (a && typeof a.delta === "string") a.delta = a.delta.replace(/\S/g, "x");
			if (a && typeof a.content === "string") a.content = a.content.replace(/\S/g, "x");
			if (c.type === "message_end" && Array.isArray(c.message?.content)) c.message.content = c.message.content.map((b: any) => (b.text ? { ...b, text: "x" } : b.thinking ? { ...b, thinking: "x" } : b));
			return c;
		};
		const view = (events: any[]) => steps(state(events)).map((st: any) => {
			const d = describeStep(st);
			return [st.tool, st.status, d.label, d.summary];
		});
		expect(view(RUN.map(scramble))).toEqual(view(RUN));
	});

	it("rebuilds the same steps from the session file after the run (reconnect or reopen)", () => {
		// The fixture's session file, as the bridge's history serves it, gives the same steps as the live stream.
		const file = fixture("faux-run.session.jsonl");
		const fromFile = steps(state(historyEvents(historyOf(file)))).map((st: any) => [st.tool, st.status, describeStep(st).label]);
		const live = steps(state(RUN)).map((st: any) => [st.tool, st.status, describeStep(st).label]);
		expect(fromFile).toEqual(live);
	});
});
