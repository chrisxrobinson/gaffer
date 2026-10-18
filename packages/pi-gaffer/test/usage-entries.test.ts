/**
 * NFR-COST-05: spend counts Pi's `usage` entries (cache warming, summaries), not only assistant messages.
 * A session written by Pi's own SessionManager: one assistant message ($0.05, one bash call) and a
 * synthetic `cache_warm` usage entry ($0.10). The budget, /usage and gaffer admin each count $0.15, and
 * the per-tool costs still add up to it.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildAdmin } from "../src/admin.ts";
import { dayCost, sessionCost } from "../src/budget.ts";
import { dayTotals, PI_CALLS, parseEntries, scanSessions, sessionUsage, usageLines } from "../src/usage.ts";

const usage = (cost: { input: number; output: number; cacheRead: number; cacheWrite: number }, tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }) => ({
	...tokens,
	totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
	cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite },
});

function writeSession() {
	const dir = mkdtempSync(join(tmpdir(), "gaffer-usage-"));
	const sm = SessionManager.create("/work", dir);
	const now = Date.now();
	sm.appendMessage({ role: "user", content: "go", timestamp: now } as never);
	sm.appendMessage({
		role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-5-5", stopReason: "toolUse", timestamp: now,
		content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo hi" } }],
		usage: usage({ input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0.02 }, { input: 5000, output: 2000, cacheRead: 0, cacheWrite: 8000 }),
	} as never);
	sm.appendUsage("cache_warm", "anthropic", "claude-sonnet-5-5", usage({ input: 0, output: 0, cacheRead: 0.1, cacheWrite: 0 }, { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }) as never);
	const file = sm.getSessionFile()!;
	return { dir, file, entries: parseEntries(readFileSync(file, "utf8")) };
}

describe("Pi's usage entries count as spend (NFR-COST-05)", () => {
	const { dir, file, entries } = writeSession();
	const today = new Date();

	it("Pi writes the cache_warm entry as a top-level `usage` line", () => {
		expect(readFileSync(file, "utf8").split("\n").some((l) => l.startsWith('{"type":"usage"') && l.includes('"kind":"cache_warm"'))).toBe(true);
	});

	it("the budget: session and day cost include it", () => {
		expect(sessionCost(entries)).toBeCloseTo(0.15, 9);
		expect(dayCost(dir, today)).toBeCloseTo(0.15, 9);
	});

	it("/usage: in the session and today's totals, and as its own row", () => {
		const s = sessionUsage(entries, file);
		const text = usageLines(s, { day: today.toISOString().slice(0, 10), ...dayTotals([s], today) }, { soft: 0.75, hard: 1.5, daily: 5, maxTurns: 40 }).join("\n");
		expect(text).toContain("This session: 1 model call (anthropic/claude-sonnet-5-5), $0.1500");
		expect(text).toContain("tokens: input 5,000, output 2,000, cache read 1,000,000, cache write 8,000");
		expect(text).toContain("tools: bash 1\n");
		expect(text).toContain(`${PI_CALLS}: 1, $0.1000`);
		expect(text).toMatch(/Today \(UTC [\d-]+\): \$0\.1500 across 1 session/);
		expect(s.runs.map((r) => Number(r.cost.toFixed(4)))).toEqual([0.05]); // a run's cost is its own model calls
	});

	it("gaffer admin: in the totals, by model and by day, and per-tool costs add up to the total", () => {
		const r = buildAdmin({ sessions: scanSessions(dir), ledger: [], outcomes: [], generatedAt: today, sources: { sessions: dir, data: "/data" } });
		expect(r.totals.cost).toBeCloseTo(0.15, 9);
		expect(r.totals.today).toBeCloseTo(0.15, 9);
		expect(r.totals.calls).toBe(1);
		expect(r.byModel["anthropic/claude-sonnet-5-5"]).toMatchObject({ calls: 1, cacheRead: 1_000_000 });
		expect(r.byModel["anthropic/claude-sonnet-5-5"].cost).toBeCloseTo(0.15, 9);
		expect(r.byTool[PI_CALLS]).toMatchObject({ calls: 1 });
		expect(r.byTool[PI_CALLS].cost).toBeCloseTo(0.1, 9);
		expect(Object.values(r.byTool).reduce((n, t) => n + t.cost, 0)).toBeCloseTo(0.15, 9);
		expect(r.html).toContain("<td>(cache warming and other Pi calls)</td><td class=\"n\">1</td>");
	});
});
