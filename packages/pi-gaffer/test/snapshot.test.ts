import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FplClient, RateLimiter } from "../src/http.ts";
import { hashTeamId, takeSnapshot, TeamNotFoundError, type SnapshotDeps } from "../src/snapshot.ts";
import { SnapshotStore } from "../src/store.ts";
import { FplDataError } from "../src/validate.ts";
import * as fx from "./fixtures.ts";
import { MockFpl } from "./mock-fpl.ts";

const SALT = "test-salt";
const deadline = Date.parse(fx.DEADLINE_GW6);
const HOUR = 3_600_000;
let fpl: MockFpl;
let deps: SnapshotDeps;

beforeEach(async () => {
	fpl = await new MockFpl().start();
	deps = {
		client: new FplClient({ baseUrl: fpl.base, limiter: new RateLimiter(1000), random: () => 0 }),
		store: new SnapshotStore(mkdtempSync(join(tmpdir(), "gaffer-snap-"))),
		salt: SALT,
		now: () => deadline - 48 * HOUR,
	};
});
afterEach(() => fpl.stop());

describe("takeSnapshot: data (FR-DAT-01)", () => {
	it("returns squad, bank, chips and GW state matching the upstream responses", async () => {
		const r = await takeSnapshot({ teamId: 1 }, deps);
		const d = r.details;
		expect(d.gw).toEqual({ current: 5, next: 6, deadline: fx.DEADLINE_GW6 });
		expect(d.squad.map((p) => p.id)).toEqual(fx.SQUAD);
		expect(d.bank).toBe(0.5);
		expect(d.squad_basis_gw).toBe(5);
		expect(d.chips.find((c) => c.name === "wildcard" && c.half === 1)).toMatchObject({ used_in: null, available: true });
		expect(d.stale).toBe(false);
		// The files in the snapshot are exactly what upstream served
		const dir = deps.store.dir(d.snapshot_id);
		expect(JSON.parse(readFileSync(join(dir, "picks.json"), "utf8"))).toEqual(fpl.data["entry/1/event/5/picks/"]);
		expect(JSON.parse(readFileSync(join(dir, "history.json"), "utf8"))).toEqual(fpl.data["entry/1/history/"]);
		expect(r.text).toContain("Bank: £0.5m");
		expect(r.text.length).toBeLessThan(6000); // ≈ 1.5k tokens
	});

	it("marks chips used in the matching half and unavailable", async () => {
		(fpl.data["entry/1/history/"] as ReturnType<typeof fx.history>).chips = [{ name: "wildcard", time: "2026-09-01T10:00:00Z", event: 3 }];
		const { details } = await takeSnapshot({ teamId: 1 }, deps);
		expect(details.chips.find((c) => c.name === "wildcard" && c.half === 1)).toMatchObject({ used_in: 3, available: false });
		expect(details.chips.find((c) => c.name === "wildcard" && c.half === 2)).toMatchObject({ used_in: null, available: false }); // window not open yet
	});

	it("after a Free Hit week the squad and bank revert to the previous GW", async () => {
		fpl.data["entry/1/event/5/picks/"] = fx.picks(5, [...fx.SQUAD].reverse().map((x) => x), "freehit", 0);
		fpl.data["entry/1/event/4/picks/"] = fx.picks(4, fx.SQUAD, null, 12);
		const { details, text } = await takeSnapshot({ teamId: 1 }, deps);
		expect(details.squad_basis_gw).toBe(4);
		expect(details.bank).toBe(1.2);
		expect(details.squad.map((p) => p.id)).toEqual(fx.SQUAD);
		expect(text).toMatch(/Free Hit/);
	});

	it("an unknown team is a clear 'team not found' error", async () => {
		const t0 = Date.now();
		await expect(takeSnapshot({ teamId: 999999999 }, deps)).rejects.toBeInstanceOf(TeamNotFoundError);
		await expect(takeSnapshot({ teamId: 999999999 }, deps)).rejects.toThrow(/team 999999999 not found/i);
		expect(Date.now() - t0).toBeLessThan(10_000);
	});
});

describe("takeSnapshot: freshness (FR-DAT-02, FR-DAT-03)", () => {
	it("cache-busts every per-user request and records CDN age per endpoint", async () => {
		const { details } = await takeSnapshot({ teamId: 1 }, deps);
		const userHits = fpl.hits.filter((h) => h.path.startsWith("entry/"));
		expect(userHits.length).toBeGreaterThanOrEqual(4);
		for (const h of userHits) expect(h.url).toMatch(/\?_=\d+/);
		const manifest = JSON.parse(readFileSync(join(deps.store.dir(details.snapshot_id), "manifest.json"), "utf8"));
		for (const e of manifest.endpoints.filter((x: { path: string }) => x.path.startsWith("entry/"))) {
			expect(e.cache_busted).toBe(true);
			expect(e.age).toBeLessThanOrEqual(60);
			expect(e).toHaveProperty("latency_ms");
			expect(e).toHaveProperty("retries");
			expect(e.status).toBe(200);
		}
	});

	it("a CDN serving per-user data with age 700000 fails the freshness check", async () => {
		fpl.overrides.set("entry/1/transfers/", { age: 700000 });
		const err = await takeSnapshot({ teamId: 1 }, deps).catch((e) => e);
		expect(String(err.message)).toMatch(/age 700000/);
	});

	it("serves shared endpoints from the snapshot cache within TTL, never per-user ones", async () => {
		await takeSnapshot({ teamId: 1 }, deps);
		await takeSnapshot({ teamId: 1 }, { ...deps, now: () => deadline - 48 * HOUR + 10 * 60_000 });
		expect(fpl.count("bootstrap-static/")).toBe(1);
		expect(fpl.count("fixtures/")).toBe(1);
		expect(fpl.count("entry/1/history/")).toBe(2);
	});

	it("inside the deadline window bootstrap is refetched after 5 minutes", async () => {
		const inWindow = deadline - 2 * HOUR;
		await takeSnapshot({ teamId: 1 }, { ...deps, now: () => inWindow });
		await takeSnapshot({ teamId: 1 }, { ...deps, now: () => inWindow + 6 * 60_000 });
		expect(fpl.count("bootstrap-static/")).toBe(2);
		expect(fpl.count("fixtures/")).toBe(1);
	});

	it("force_fresh bypasses the cache", async () => {
		await takeSnapshot({ teamId: 1 }, deps);
		await takeSnapshot({ teamId: 1, forceFresh: true }, deps);
		expect(fpl.count("bootstrap-static/")).toBe(2);
	});
});

describe("takeSnapshot: downtime (FR-DAT-05)", () => {
	it("503 or HTML from FPL serves the last good snapshot marked stale, with a warning", async () => {
		await takeSnapshot({ teamId: 1 }, deps);
		fpl.overrides.set("*", { status: 200, type: "text/html", body: "<html>The game is being updated.</html>" });
		const r = await takeSnapshot({ teamId: 1, forceFresh: true }, deps);
		expect(r.details.stale).toBe(true);
		expect(r.details.stale_reason).toBe("fpl_updating");
		expect(r.details.warnings.join(" ")).toMatch(/stale/i);
		expect(r.details.finalise_transfers.allowed).toBe(true); // not near the deadline
		expect(r.details.squad.map((p) => p.id)).toEqual(fx.SQUAD);
	});

	it("at T-30min with stale per-user data, transfers must not be finalised and the reason is given", async () => {
		const near = deadline - 30 * 60_000;
		await takeSnapshot({ teamId: 1 }, { ...deps, now: () => near - HOUR });
		fpl.overrides.set("*", { status: 503 });
		const r = await takeSnapshot({ teamId: 1 }, { ...deps, now: () => near });
		expect(r.details.stale).toBe(true);
		expect(r.details.finalise_transfers).toEqual({ allowed: false, reason: expect.stringMatching(/deadline/) });
		expect(r.text).toMatch(/do not finalise transfers/i);
	});

	it("with no last good snapshot, downtime is an error", async () => {
		fpl.overrides.set("*", { status: 503 });
		await expect(takeSnapshot({ teamId: 1 }, deps)).rejects.toThrow(/unavailable/);
	});
});

describe("takeSnapshot: validation and storage (FR-DAT-06, FR-DAT-07)", () => {
	it("invalid upstream data is a hard error naming the check, and nothing is written", async () => {
		(fpl.data["entry/1/event/5/picks/"] as ReturnType<typeof fx.picks>).picks.pop();
		const err = await takeSnapshot({ teamId: 1 }, deps).catch((e) => e);
		expect(err).toBeInstanceOf(FplDataError);
		expect(err.message).toMatch(/picks.count/);
		expect(() => readdirSync(deps.store.snapshotsDir)).toThrow();
	});

	it("two runs with identical upstream data share a hash", async () => {
		const a = await takeSnapshot({ teamId: 1, forceFresh: true }, deps);
		const b = await takeSnapshot({ teamId: 1, forceFresh: true }, { ...deps, now: () => deadline - 47 * HOUR });
		expect(a.details.snapshot_hash).toBe(b.details.snapshot_hash);
	});

	it("never stores the raw team id outside the upstream payloads", async () => {
		const { details } = await takeSnapshot({ teamId: 1 }, deps);
		const manifest = readFileSync(join(deps.store.dir(details.snapshot_id), "manifest.json"), "utf8");
		expect(manifest).toContain(hashTeamId(1, SALT));
		expect(JSON.parse(manifest)).not.toHaveProperty("team_id");
		expect(details.team_id_hash).toBe(hashTeamId(1, SALT));
	});
});

describe("hashTeamId", () => {
	it("is an HMAC-SHA256 that depends on the salt", () => {
		expect(hashTeamId(1, "a")).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
		expect(hashTeamId(1, "a")).not.toBe(hashTeamId(1, "b"));
		expect(hashTeamId(1, "a")).toBe(hashTeamId(1, "a"));
	});
});
