/**
 * FR-EVL-03: gaffer-eval writes a row in outcomes.jsonl for every real ledgered recommendation of a
 * GW once its data is checked: recommended points, the user's actual points, B0 and B1 from the same
 * pre-deadline squad, and Gaffer's xP vs ep_next. Rebuildable and idempotent.
 *
 * A recommendation is made through the real gate on the frozen GW6 snapshot (plan 1 of plan-model.json)
 * and scored against GW6's real results (python/gaffer_lib/tests/data/result-2026-27-gw6.json) by
 * `gaffer_lib score` on a host sandboxd. The user's actual GW6 is a real manager's picks (59 points, no
 * hit). Expected numbers were counted by hand in python/gaffer_lib/tests/test_outcomes.py: Gaffer 55,
 * B0 62, B1 57.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FplClient } from "../src/http.ts";
import { type LedgerRow, readLedger } from "../src/ledger.ts";
import { track } from "../src/live-eval.ts";
import { type OutcomeRow, outcomesPath, readOutcomes, scorecard } from "../src/outcomes.ts";
import { ComposeSandboxProvider, SandboxSession } from "../src/sandbox.ts";
import { hashTeamId } from "../src/team-hash.ts";
import { type GafferTestEnv, hostGafferLibCommand, startEnv, startGaffer } from "./harness.ts";
import { installModelSnapshot, planDoc, seed, snapshotEntry, submission, TEAM_ID } from "./model-fixtures.ts";

const DATA = resolve(import.meta.dirname, "../../../python/gaffer_lib/tests/data");
const LIVE6 = JSON.parse(readFileSync(join(DATA, "result-2026-27-gw6.json"), "utf8"));
const PICKS6 = JSON.parse(readFileSync(join(DATA, "picks-2026-27-gw6.json"), "utf8"));
const BOOT = JSON.parse(readFileSync(join(DATA, "snapshot-model", "bootstrap-static.json"), "utf8"));

let env: GafferTestEnv;
let rec: Record<string, any>;
const ledgerFile = () => join(env.dataDir, "ledger", "recommendations.jsonl");
const run = (opts: { gw?: number; rebuild?: boolean } = {}) =>
	track(opts, { dataDir: env.dataDir, sessionsDir: env.sessionsDir, salt: "test-salt", client: new FplClient(), sandbox: new SandboxSession(new ComposeSandboxProvider(process.env.SANDBOX_URL!)) });

beforeAll(async () => {
	env = await startEnv();
	process.env.GAFFER_LIB_CMD = hostGafferLibCommand({ analytics: true });
	// A real recommendation through the gate (the scripted model submits plan 1).
	const { dir, planFile } = installModelSnapshot(env);
	const g = await startGaffer(env, { extra: [seed(snapshotEntry(dir))], responses: [fauxAssistantMessage(fauxToolCall("submit_recommendation", submission(planDoc(), planFile) as never))] });
	await g.session.prompt("/seed");
	await g.session.prompt("What should I do this week?");
	rec = g.sessionEntries().find((e) => e.customType === "gaffer.recommendation").data;
	g.session.dispose();
	// The gate's row is the scripted model's (a test row). Make it a real one made before the GW6 deadline,
	// add an earlier real recommendation that can't be found, a GW7 one, and keep the faux row.
	const [row] = readLedger(env.dataDir) as LedgerRow[];
	const real = { ...row, model: "anthropic/claude-sonnet-5-5", created_at: "2026-10-09T12:00:00.000Z" };
	const lost = { ...real, rec_id: "01M5LOST000000000000000000", created_at: "2026-10-08T12:00:00.000Z", session_file: "/nonexistent.jsonl" };
	const gw7 = { ...real, rec_id: "01M5GW7000000000000000000A", gw: 7, deadline: "2026-10-17T10:00:00Z" };
	writeFileSync(ledgerFile(), [row, real, lost, gw7].map((r) => JSON.stringify(r)).join("\n") + "\n");
	// FPL now: GW6 finished and checked, GW7 not; the user's real GW6.
	env.fpl.data["bootstrap-static/"] = { ...BOOT, events: BOOT.events.map((e: { id: number }) => ({ ...e, finished: e.id <= 6, data_checked: e.id <= 6, is_current: e.id === 6, is_next: e.id === 7 })) };
	env.fpl.data["event/6/live/"] = LIVE6;
	env.fpl.data[`entry/${TEAM_ID}/event/6/picks/`] = PICKS6[0];
}, 240_000);
afterAll(() => env.stop());

describe("gaffer-eval (FR-EVL-03)", () => {
	let rows: OutcomeRow[];
	let first: string;

	it("scores every real recommendation of a checked GW, and only those", async () => {
		const s = await run();
		expect(s.finished).toEqual([1, 2, 3, 4, 5, 6]);
		expect(s.skippedTest).toBe(1);
		expect(s.waiting).toEqual([{ gw: 7, recommendations: 1 }]);
		rows = readOutcomes(env.dataDir);
		first = readFileSync(outcomesPath(env.dataDir), "utf8");
		expect(rows.map((r) => [r.rec_id === rec.rec_id ? "real" : r.rec_id, r.status, r.counted])).toEqual([
			["01M5LOST000000000000000000", "unscorable", false],
			["real", "scored", true],
		]);
	}, 120_000);

	it("the row: recommended, actual, B0, B1 and the projection error", () => {
		const r = rows.find((x) => x.rec_id === rec.rec_id)!;
		expect(r).toMatchObject({ schema: "gaffer.outcome/1", team_id_hash: hashTeamId(TEAM_ID, "test-salt"), season: "2026/27", gw: 6, model: "anthropic/claude-sonnet-5-5", snapshot_id: "snapshot-model", gaffer_lib: "0.5.0" });
		expect(r.recommended).toMatchObject({ points: 55, hit_cost: 0, armband: 426, autosubs: [[368, 31]], expected_points: rec.expected_points_gw });
		expect(r.actual).toEqual({ points: 59, gross: 59, hit_cost: 0, chip: null, recomputed: 59, matches: true });
		expect(r.baselines!.B0).toMatchObject({ points: 62, transfers: [] });
		expect(r.baselines!.B1).toMatchObject({ points: 57, transfers: [[387, 330]] });
		expect(r.projection!.players).toBeGreaterThan(15);
		expect(r.live_sha256).toBe(createHash("sha256").update(JSON.stringify(LIVE6)).digest("hex"));
		const lost = rows.find((x) => x.status === "unscorable")!;
		expect(lost.reason).toMatch(/neither the session logs nor \/data\/exports/);
	});

	it("is idempotent and rebuildable: the same inputs give the same bytes", async () => {
		const s = await run();
		expect(s.alreadyScored).toBe(1);
		expect(s.scored.map((x) => x.status)).toEqual(["unscorable"]); // retried, still missing
		expect(readFileSync(outcomesPath(env.dataDir), "utf8")).toBe(first);
		rmSync(outcomesPath(env.dataDir));
		await run({ rebuild: true });
		expect(readFileSync(outcomesPath(env.dataDir), "utf8")).toBe(first);
		await run({ rebuild: true, gw: 6 });
		expect(readFileSync(outcomesPath(env.dataDir), "utf8")).toBe(first);
	}, 240_000);

	it("/scorecard's totals are this file's counted row", () => {
		const c = scorecard(readOutcomes(env.dataDir), hashTeamId(TEAM_ID, "test-salt"));
		expect(c.totals).toMatchObject({ gaffer: 55, actual: 59, b0: 62, b1: 57 });
		expect(c.unscorable).toHaveLength(1);
	});

	it("outcomes.jsonl holds no raw team id or name (NFR-PRIV-01)", () => {
		const text = readFileSync(outcomesPath(env.dataDir), "utf8");
		expect(text).not.toMatch(new RegExp(`\\b${TEAM_ID}\\b`));
		expect(text).not.toContain("Test XI");
		expect(existsSync(join(env.dataDir, "ledger"))).toBe(true);
	});

	it("a GW whose data isn't checked yet scores nothing", async () => {
		mkdirSync(join(env.dataDir, "ledger"), { recursive: true });
		env.fpl.data["bootstrap-static/"] = { ...BOOT, events: BOOT.events.map((e: { id: number }) => ({ ...e, finished: e.id <= 6, data_checked: e.id <= 5 })) };
		const s = await run({ rebuild: true });
		expect(s.finished).toEqual([1, 2, 3, 4, 5]);
		expect(s.scored).toEqual([]);
		expect(readOutcomes(env.dataDir)).toEqual([]);
	});
});
