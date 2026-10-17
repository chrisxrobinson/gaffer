/**
 * FR-EVL-04: /scorecard shows season-to-date totals that match outcomes.jsonl; and /usage (ARCHITECTURE §9).
 *
 * Outcomes fixture for team 1, summed by hand (counted rows only: the last recommendation per GW):
 *   GW  Gaffer  You  B0  B1  Gaffer xP
 *    6      55   48  62  57       60.2
 *    7      71   51  45  44       62.5   (an earlier GW7 recommendation scored 40: not counted)
 *    8      38   42  50  39       55.0
 *   All    164  141 157 140      177.7   Gaffer vs you +23, vs B0 +7, vs B1 +24
 * Projection MAE over 23 + 20 player-GWs: Gaffer (3.167·23 + 2.5·20)/43 = 2.857, FPL (3.03·23 + 2.8·20)/43 = 2.923.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type OutcomeRow, outcomesPath, readOutcomes, scorecard, scorecardLines } from "../src/outcomes.ts";
import { hashTeamId } from "../src/snapshot.ts";
import { type GafferTestEnv, startEnv, startGaffer } from "./harness.ts";

const T1 = hashTeamId(1, "test-salt");
const OTHER = hashTeamId(2, "test-salt");
const pts = (points: number, transfers = false) => ({ points, gross: points, hit_cost: 0, chip: null, armband: 1, autosubs: [], ...(transfers ? { transfers: [] } : {}) });
const row = (gw: number, rec: string, counted: boolean, g: number, a: number, b0: number, b1: number, x: number, projection?: OutcomeRow["projection"], team = T1): OutcomeRow => ({
	schema: "gaffer.outcome/1", rec_id: rec.padEnd(26, "0"), team_id_hash: team, season: "2026/27", gw, deadline: "2026-10-17T10:00:00Z", created_at: "2026-10-16T10:00:00Z",
	model: "anthropic/claude-sonnet-5-5", snapshot_id: "s", counted, status: "scored",
	recommended: { ...pts(g), expected_points: x }, actual: { points: a, gross: a, hit_cost: 0, chip: null, recomputed: a, matches: true },
	baselines: { B0: pts(b0, true) as never, B1: pts(b1, true) as never }, ...(projection ? { projection } : {}), gaffer_lib: "0.5.0",
});
const ROWS: OutcomeRow[] = [
	row(6, "A6", true, 55, 48, 62, 57, 60.2, { players: 23, mae_gaffer: 3.167, mae_official: 3.03 }),
	row(7, "A7EARLY", false, 40, 51, 45, 44, 58),
	row(7, "A7", true, 71, 51, 45, 44, 62.5, { players: 20, mae_gaffer: 2.5, mae_official: 2.8 }),
	row(8, "A8", true, 38, 42, 50, 39, 55),
	{ schema: "gaffer.outcome/1", rec_id: "A9".padEnd(26, "0"), team_id_hash: T1, season: "2026/27", gw: 9, deadline: "", created_at: "", model: "m", snapshot_id: "s", counted: true, status: "unscorable", reason: "the recommendation's session file is missing", gaffer_lib: "0.5.0" },
	row(6, "B6", true, 99, 10, 10, 10, 50, undefined, OTHER),
];

describe("/scorecard (FR-EVL-04)", () => {
	it("totals are the hand-summed counted rows of outcomes.jsonl", () => {
		const c = scorecard(ROWS, T1);
		expect(c.season).toBe("2026/27");
		expect(c.gws.map((g) => [g.gw, g.gaffer, g.actual, g.b0, g.b1])).toEqual([[6, 55, 48, 62, 57], [7, 71, 51, 45, 44], [8, 38, 42, 50, 39]]);
		expect(c.totals).toEqual({ gaffer: 164, actual: 141, b0: 157, b1: 140, expected: 177.7 });
		expect(c.projection).toEqual({ players: 43, mae_gaffer: 2.857, mae_official: 2.923 });
		expect(c.notCounted).toBe(1);
		expect(c.unscorable).toEqual([{ gw: 9, rec_id: "A9".padEnd(26, "0"), reason: "the recommendation's session file is missing" }]);
		const lines = scorecardLines(c);
		expect(lines).toContain("All      164     141     157     140      177.7");
		expect(lines).toContain("Gaffer vs you +23 · vs B0 +7 · vs B1 +24");
		expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(100);
	});

	it("a team with nothing scored is told why", () => {
		expect(scorecardLines(scorecard(ROWS, hashTeamId(3, "test-salt")))[1]).toMatch(/No finished GW has been scored/);
	});

	describe("in a session", () => {
		let env: GafferTestEnv;
		beforeAll(async () => {
			env = await startEnv();
		});
		afterAll(() => env.stop());

		it("/scorecard reads outcomes.jsonl for the session's team", async () => {
			mkdirSync(join(env.dataDir, "ledger"), { recursive: true });
			writeFileSync(outcomesPath(env.dataDir), ROWS.map((r) => JSON.stringify(r)).join("\n") + "\n");
			expect(readOutcomes(env.dataDir)).toHaveLength(ROWS.length);
			const g = await startGaffer(env, { responses: [] });
			await g.session.prompt("/scorecard");
			expect(g.notifications.at(-1)?.message).toMatch(/Set your team first/);
			await g.session.prompt("/team 1");
			await g.session.prompt("/scorecard");
			const text = g.notifications.at(-1)!.message;
			expect(text).toContain("GAFFER · scorecard 2026/27 — 3 GWs scored");
			expect(text).toContain("All      164     141     157     140      177.7");
			expect(text).not.toContain("99");
			expect(g.faux.state.callCount).toBe(0);
			g.session.dispose();
		});

		it("/usage shows this session's calls, tokens and cost, and today's spend against the caps", async () => {
			const cost = (pi: ExtensionAPI) =>
				pi.on("message_end", (event) => {
					const m = event.message as { role: string; usage?: { cost: Record<string, number> } };
					if (m.role !== "assistant" || !m.usage) return;
					return { message: { ...m, usage: { ...m.usage, cost: { ...m.usage.cost, total: 0.0125 } } } as never };
				});
			const g = await startGaffer(env, { extra: [cost], responses: [fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" })), fauxAssistantMessage(fauxText("done"))] });
			await g.session.prompt("go");
			await g.session.prompt("/usage");
			const text = g.notifications.at(-1)!.message;
			expect(text).toContain("This session: 2 model calls (faux/faux-1), $0.0250");
			expect(text).toMatch(/runs: 1, 0 with a recommendation; last run \d+ s/);
			expect(text).toContain("tools: bash 1");
			expect(text).toMatch(/budget: soft \$0\.75 \(not reached\) · hard \$1\.50 · 40 turns a run/);
			expect(text).toMatch(/Today \(UTC \d{4}-\d{2}-\d{2}\): \$0\.0250 across 1 session; daily cap \$5\.00 \(\$4\.9750 left\)/);
			expect(Math.max(...text.split("\n").map((l) => l.length))).toBeLessThanOrEqual(100);
			g.session.dispose();
		});
	});
});
