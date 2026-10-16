/**
 * FR-ADM-01: `gaffer admin` writes admin.html from /sessions and /data only, and its totals match a
 * hand count over 3 sessions to within $0.01.
 *
 * The fixture (test/fixtures/sessions/{a,b,c}.jsonl), counted by hand:
 *   a  3 model calls: $0.0201 (fpl_snapshot + read), $0.0103 (bash), $0.0150 (submit) = $0.0454; one
 *      recommendation, 63.0 s from the user's message; 2026-10-16
 *   b  2 model calls: $0.0300 (bash, which fails), $0.0050 (another model, stopReason error) = $0.0350;
 *      a refused submission (CLUB_LIMIT), steered at the soft cap; 2026-10-16
 *   c  3 model calls: $0.0012 (text), $0.0400 (two bash calls), $0.0044 (submit) = $0.0456; two runs,
 *      the second's recommendation 90.0 s after its message; 2026-10-15
 *   all: $0.1260, 8 calls, 2 recommendations, 3 errors; on 2026-10-16: $0.0804
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAdmin } from "../src/admin.ts";
import { maskError, scanSessions } from "../src/usage.ts";

const FIXTURES = resolve(import.meta.dirname, "fixtures/sessions");
const NOW = new Date("2026-10-16T12:00:00Z");

describe("gaffer admin (FR-ADM-01)", () => {
	const sessions = scanSessions(FIXTURES);
	const r = buildAdmin({ sessions, ledger: [], outcomes: [], generatedAt: NOW, sources: { sessions: FIXTURES, data: "/data" } });

	it("totals match the hand count to within $0.01 (here exactly)", () => {
		expect(sessions.map((s) => [s.file, s.calls, Number(s.cost.toFixed(4))])).toEqual([["a.jsonl", 3, 0.0454], ["b.jsonl", 2, 0.035], ["c.jsonl", 3, 0.0456]]);
		expect(Math.abs(r.totals.cost - 0.126)).toBeLessThan(0.01);
		expect(r.totals.cost).toBeCloseTo(0.126, 9);
		expect(r.totals).toMatchObject({ sessions: 3, calls: 8, recommendations: 2, errors: 3, runs: 4 });
		expect(r.totals.today).toBeCloseTo(0.0804, 9);
		expect(r.totals.tokens).toEqual({ input: 174, output: 3047, cacheRead: 23467, cacheWrite: 24018 });
	});

	it("cost per model and per tool add up to the total", () => {
		expect(r.byModel["anthropic/claude-sonnet-5-5"].calls).toBe(7);
		expect(r.byModel["anthropic/claude-sonnet-5-5"].cost).toBeCloseTo(0.121, 9);
		expect(r.byModel["openai/gpt-5.4"].cost).toBeCloseTo(0.005, 9);
		const cost = Object.fromEntries(Object.entries(r.byTool).map(([k, v]) => [k, Number(v.cost.toFixed(5))]));
		expect(cost).toEqual({ fpl_snapshot: 0.01005, read: 0.01005, bash: 0.0803, submit_recommendation: 0.0194, "(text)": 0.0062 });
		expect(Object.values(r.byTool).reduce((n, t) => n + t.cost, 0)).toBeCloseTo(r.totals.cost, 9);
		expect(r.byTool.bash).toMatchObject({ calls: 4, errors: 1 });
	});

	it("latency: tools from the end of the calling message, runs from the user's message to the recommendation", () => {
		expect(r.byTool.fpl_snapshot.maxMs).toBe(2000);
		expect(r.byTool.read.maxMs).toBe(50);
		expect(r.byTool.bash.maxMs).toBe(46_000); // a's golden path; c's second bash
		expect(r.byTool.bash.totalMs).toBe(46_000 + 1000 + 2000 + 46_000);
		expect(r.totals.runLatency).toEqual({ p50: 63_000, p95: 90_000, n: 2 });
		const a = sessions[0];
		expect(a.modelMs).toBe(4990 + 1900 + 6900);
	});

	it("errors and budget events, with digits masked", () => {
		const b = sessions[1];
		expect(b.errors.map((e) => [e.kind, e.message])).toEqual([["tool", "Command failed: team # not found"], ["model", "# overloaded"], ["validation", "CLUB_LIMIT"]]);
		expect(b.budget.steered).toBe(true);
		expect(b.runs).toEqual([expect.objectContaining({ outcome: "no recommendation", recommendation: null, validationAttempts: 1 })]);
		expect(maskError("x".repeat(300)).length).toBe(160);
	});

	it("data-source health from the snapshot entries", () => {
		expect(r.endpoints["fpl: bootstrap-static"]).toMatchObject({ requests: 1, fromCache: 0, failures: 0, totalMs: 300 });
		expect(r.endpoints["fpl: fixtures"]).toMatchObject({ requests: 0, fromCache: 1 });
		expect(r.endpoints["fpl: entry"]).toMatchObject({ requests: 1, retries: 1, maxAge: 3 });
		expect(r.endpoints["football-data.co.uk"]).toMatchObject({ requests: 1, maxMs: 500 });
	});

	it("the page has the totals and no raw team id or prompt text (NFR-PRIV-01)", () => {
		expect(r.html).toContain("$0.1260");
		expect(r.html).toContain("$0.0804");
		expect(r.html).toContain("63.0 s / 90.0 s");
		for (const leak of ["1234567", "7654321", "My FPL team", "What should I do"]) expect(r.html).not.toContain(leak);
		expect(r.html).not.toMatch(/<script|https?:\/\/(?!www\.w3\.org)/);
	});

	it("the command writes admin.html and prints the totals it wrote", () => {
		const dir = mkdtempSync(join(tmpdir(), "gaffer-admin-"));
		const out = execFileSync(process.execPath, [resolve(import.meta.dirname, "../../../tools/gaffer-admin/main.ts"), "--sessions", FIXTURES, "--data", dir, "--now", NOW.toISOString()], { encoding: "utf8" });
		expect(out).toMatch(/sessions 3; model calls 8; cost \$0\.1260 \(today \$0\.0804\)/);
		const html = readFileSync(join(dir, "admin", "admin.html"), "utf8");
		expect(html).toContain("$0.1260");
		expect(html.replace(dir, "/data")).toBe(r.html);
	});
});
