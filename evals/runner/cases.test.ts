/**
 * Built eval cases go through the real fpl_snapshot: the stand-in API serves them, the FPL schema and
 * invariant checks pass (FR-DAT-06), and gaffer_lib derive works out the team (free transfers, bank,
 * chips) at the case's clock. Needs the built cases (evals/build/build_cases.py); skipped without them.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GafferTestEnv, hostGafferLibCommand, startEnv, startGaffer } from "../../packages/pi-gaffer/test/harness.ts";
import { CaseApi } from "./mock.ts";

const BUILT = resolve(import.meta.dirname, "../../var/evals/cases");
const built = (id: string) => existsSync(join(BUILT, id, "case.json"));
const caseOf = (id: string) => JSON.parse(readFileSync(join(BUILT, id, "case.json"), "utf8"));

describe.skipIf(!built("l6-a-fh-revert") || !built("h2425-gw33-dgw"))("built cases through fpl_snapshot", () => {
	let env: GafferTestEnv;
	beforeAll(async () => {
		env = await startEnv();
		process.env.GAFFER_LIB_CMD = hostGafferLibCommand({ analytics: true });
	}, 240_000);
	afterAll(async () => {
		delete process.env.GAFFER_CLOCK_OFFSET_MS;
		await env.stop();
	});

	async function snapshot(id: string) {
		const c = caseOf(id);
		const api = await new CaseApi(join(BUILT, id), c.team_id).start();
		process.env.FPL_BASE_URL = api.fplBase;
		process.env.FOOTBALL_DATA_BASE_URL = api.footballDataBase;
		process.env.GAFFER_DATA_DIR = join(env.dataDir, id);
		process.env.GAFFER_CLOCK_OFFSET_MS = String(Date.parse(c.as_of) - Date.now());
		const g = await startGaffer(env, { responses: [fauxAssistantMessage(fauxToolCall("fpl_snapshot", { team_id: c.team_id, include: ["odds"] })), fauxAssistantMessage(fauxText("ok"))] });
		await g.session.prompt("go");
		const result = g.toolResults.find((r) => r.name === "fpl_snapshot")!;
		g.session.dispose();
		await api.stop();
		process.env.GAFFER_DATA_DIR = env.dataDir;
		return { c, result, details: result.details as Record<string, any>, api };
	}

	it("a live case: Free Hit in GW5, so GW6 starts from the GW4 squad, with 3 FT", async () => {
		const { result, details, api } = await snapshot("l6-a-fh-revert");
		expect(result.isError, result.text).toBe(false);
		expect(details).toMatchObject({ season: "2026/27", gw: { current: 5, next: 6, deadline: "2026-10-10T10:00:00Z" }, stale: false, squad_basis_gw: 4 });
		expect(details.free_transfers).toMatchObject({ value: 3, source: "derived" });
		expect(details.snapshot_id).toMatch(/^2026-27\/6\/20261001T2050/); // taken at the case's clock
		expect(details.recent_gws).toEqual([1, 2, 3, 4, 5]);
		expect(api.hits.some((h) => h.path === "api/event/6/live/")).toBe(false);
		expect(result.text).toMatch(/run in the sandbox: python -m gaffer_lib run --snapshot/);
	}, 120_000);

	it("a history case: 2024/25 GW33 with four doubles, odds for the round, 2 FT and every chip", async () => {
		const { result, details } = await snapshot("h2425-gw33-dgw");
		expect(result.isError, result.text).toBe(false);
		expect(details).toMatchObject({ season: "2024/25", gw: { current: 32, next: 33 }, stale: false });
		expect(details.free_transfers).toMatchObject({ value: 2, source: "derived" });
		expect(details.flags.doubles[33]).toHaveLength(4);
		expect(details.odds).toMatchObject({ requested: true, available: true });
		expect(details.odds.fixtures).toBeGreaterThanOrEqual(10);
		expect(details.chips.filter((c: { available: boolean }) => c.available).map((c: { name: string }) => c.name).sort()).toEqual(["3xc", "bboost", "freehit", "wildcard"]);
	}, 120_000);
});
