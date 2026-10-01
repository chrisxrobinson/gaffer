import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkOddsRequest } from "../src/guard.ts";
import { FplClient, RateLimiter, USER_AGENT } from "../src/http.ts";
import { fetchOdds, ODDS_MAX_TRIES, type OddsFile, parseCsv, parseOddsFixtures, parseResults, previousSeason, seasonCode } from "../src/odds.ts";
import { epNextRecorded, runCommand, takeSnapshot, type SnapshotDeps } from "../src/snapshot.ts";
import { SnapshotStore } from "../src/store.ts";
import * as fx from "./fixtures.ts";
import { MockFpl } from "./mock-fpl.ts";

const HOUR = 3_600_000;
const deadline = Date.parse(fx.DEADLINE_GW6);

/** A stand-in for football-data.co.uk. */
class MockOdds {
	server!: Server;
	base = "";
	hits: { path: string; method: string; ua: string | undefined; t: number }[] = [];
	down = false;
	files: Record<string, string> = { "/fixtures.csv": fx.oddsFixturesCsv(), "/mmz4281/2526/E0.csv": fx.resultsCsv("prev"), "/mmz4281/2627/E0.csv": fx.resultsCsv("current") };
	async start(): Promise<this> {
		this.server = createServer((req, res) => {
			const path = req.url ?? "";
			this.hits.push({ path, method: req.method ?? "", ua: req.headers["user-agent"], t: Date.now() });
			if (this.down) return void res.writeHead(503, { "content-type": "text/html" }).end("<html>Service Unavailable</html>");
			const body = this.files[path];
			if (body === undefined) return void res.writeHead(404).end("not found");
			res.writeHead(200, { "content-type": "text/csv" }).end(body);
		});
		await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
		this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`;
		return this;
	}
	count(path: string) {
		return this.hits.filter((h) => h.path === path).length;
	}
	stop(): Promise<void> {
		return new Promise((r) => this.server.close(() => r()));
	}
}

describe("football-data CSV parsing", () => {
	it("reads quoted fields, a BOM and CRLF line ends", () => {
		const rows = parseCsv('﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n\r\n2,,z\r\n');
		expect(rows).toEqual([
			{ a: "1", b: "x, y", c: 'say "hi"' },
			{ a: "2", b: "", c: "z" },
		]);
		expect(parseCsv("")).toEqual([]);
	});

	it("keeps Premier League fixtures and only the price columns Gaffer uses", () => {
		const f = parseOddsFixtures(fx.oddsFixturesCsv());
		expect(f).toHaveLength(2); // the E1 row is dropped
		expect(f[0]).toEqual({
			date: "10/10/2026", time: "12:30", home: "Arsenal", away: "Tottenham",
			odds: { AvgH: 1.62, AvgD: 4.15, AvgA: 5.4, "Avg>2.5": 1.72, "Avg<2.5": 2.12, B365H: 1.6, B365D: 4.2, B365A: 5.5, "B365>2.5": 1.7, "B365<2.5": 2.15 },
		});
		expect(f[1].home).toBe("Nott'm Forest");
		expect(JSON.stringify(f)).not.toMatch(/Referee|Smith/); // nothing else from the file is stored
		expect(() => parseOddsFixtures("<html>blocked</html>\n1,2")).toThrow(/no Div/);
	});

	it("keeps finished matches of a season file, with xG where the file has it", () => {
		const r = parseResults(fx.resultsCsv("current"));
		expect(r).toEqual([{ date: "21/08/2026", time: "20:00", home: "Arsenal", away: "Coventry", hg: 3, ag: 0, hxg: 1.88, axg: 0.2 }]); // the unplayed row is dropped
		expect(parseResults(fx.resultsCsv("prev"))[0]).toMatchObject({ home: "Liverpool", hg: 4, ag: 2, hxg: null, axg: null });
	});

	it("maps FPL seasons to football-data directories", () => {
		expect(seasonCode("2026-27")).toBe("2627");
		expect(previousSeason("2026-27")).toBe("2025-26");
		expect(previousSeason("2000-01")).toBe("1999-00");
	});
});

describe("checkOddsRequest: the read-only guard allows one extra host (FR-DAT-09, FR-ACC-01)", () => {
	it.each(["https://football-data.co.uk/fixtures.csv", "https://football-data.co.uk/mmz4281/2627/E0.csv", "http://127.0.0.1:9999/fixtures.csv"])("allows GET %s", (url) => {
		expect(checkOddsRequest("GET", url)).toEqual({ ok: true });
	});

	it.each([
		"https://www.football-data.co.uk/fixtures.csv", // not the allowlisted host
		"http://football-data.co.uk/fixtures.csv", // not HTTPS
		"https://football-data.co.uk.evil.example/fixtures.csv",
		"https://example.com/fixtures.csv",
		"https://football-data.co.uk/mmz4281/2627/E1.csv",
		"https://football-data.co.uk/mmz4281/2627/../../fixtures.csv?x=1",
		"https://football-data.co.uk/fixtures.csv?team=123",
		"https://football-data.co.uk/englandm.php",
		"https://fantasy.premierleague.com/api/my-team/1/",
		"not a url",
	])("blocks GET %s", (url) => {
		const r = checkOddsRequest("GET", url);
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.reason).toMatch(/read-only/);
	});

	it.each(["POST", "PUT", "DELETE"])("blocks %s", (method) => {
		expect(checkOddsRequest(method, "https://football-data.co.uk/fixtures.csv").ok).toBe(false);
	});
});

describe("fetchOdds", () => {
	let odds: MockOdds;
	let store: SnapshotStore;
	const base = () => ({ baseUrl: odds.base, limiter: new RateLimiter(1000), random: () => 0, sleep: async () => undefined });
	/** Store a fetched odds file the way takeSnapshot does, so the next call can use it as cache. */
	const remember = (r: Awaited<ReturnType<typeof fetchOdds>>, at: number) => {
		const w = store.write({ season: "2026-27", gw: 6, files: { odds: r.file }, manifest: {}, now: new Date(at) });
		store.index(Object.fromEntries(r.fresh.map((k) => [k, { snapshot: w.id, fetched_at: at }])));
	};

	beforeEach(async () => {
		odds = await new MockOdds().start();
		store = new SnapshotStore(mkdtempSync(join(tmpdir(), "gaffer-odds-")));
	});
	afterEach(() => odds.stop());

	it("fetches next-round odds and both seasons' results, politely", async () => {
		const now = deadline - 48 * HOUR;
		const r = await fetchOdds({ season: "2026-27", deadline }, { ...base(), store, now: () => now });
		expect(r.file).toMatchObject({ schema: "gaffer.odds/1", source: "football-data.co.uk", available: true, reason: null });
		expect(r.file.fixtures).toHaveLength(2);
		expect(Object.keys(r.file.results)).toEqual(["2025-26", "2026-27"]);
		expect(r.file.results["2025-26"]).toHaveLength(2);
		expect(odds.hits.map((h) => h.path)).toEqual(["/fixtures.csv", "/mmz4281/2526/E0.csv", "/mmz4281/2627/E0.csv"]);
		expect(odds.hits.every((h) => h.method === "GET" && h.ua === USER_AGENT)).toBe(true);
		expect(r.endpoints.map((e) => [e.path, e.status, e.from_cache])).toEqual([
			["football-data:fixtures.csv", 200, false],
			["football-data:mmz4281/2526/E0.csv", 200, false],
			["football-data:mmz4281/2627/E0.csv", 200, false],
		]);
		expect(r.warnings).toEqual([]);
		expect(JSON.stringify(r.file)).not.toMatch(/fetched_at/); // no run time in the file: the snapshot hash stays stable
	});

	it("caches each part: odds for 6 h (30 min inside the deadline window), results for a day, last season for a month", async () => {
		const t0 = deadline - 72 * HOUR;
		remember(await fetchOdds({ season: "2026-27", deadline }, { ...base(), store, now: () => t0 }), t0);
		const again = await fetchOdds({ season: "2026-27", deadline }, { ...base(), store, now: () => t0 + 5 * HOUR });
		expect(odds.hits).toHaveLength(3); // nothing refetched
		expect(again.endpoints.every((e) => e.from_cache)).toBe(true);
		expect(again.file.fixtures).toHaveLength(2);

		const later = await fetchOdds({ season: "2026-27", deadline }, { ...base(), store, now: () => t0 + 7 * HOUR });
		expect(odds.count("/fixtures.csv")).toBe(2);
		expect(odds.count("/mmz4281/2627/E0.csv")).toBe(1);
		remember(later, t0 + 7 * HOUR);

		await fetchOdds({ season: "2026-27", deadline }, { ...base(), store, now: () => t0 + 26 * HOUR });
		expect(odds.count("/mmz4281/2627/E0.csv")).toBe(2);
		expect(odds.count("/mmz4281/2526/E0.csv")).toBe(1); // last season's file doesn't change

		// Inside T−6h the odds are refreshed after 30 minutes.
		const inWindow = deadline - 2 * HOUR;
		const before = odds.count("/fixtures.csv");
		remember(await fetchOdds({ season: "2026-27", deadline }, { ...base(), store, now: () => inWindow }), inWindow);
		await fetchOdds({ season: "2026-27", deadline }, { ...base(), store, now: () => inWindow + 20 * 60_000 });
		expect(odds.count("/fixtures.csv")).toBe(before + 1);
		await fetchOdds({ season: "2026-27", deadline }, { ...base(), store, now: () => inWindow + 40 * 60_000 });
		expect(odds.count("/fixtures.csv")).toBe(before + 2);
	});

	it("with the source down and no cache, reports unavailable with the reason and does not throw", async () => {
		odds.down = true;
		const r = await fetchOdds({ season: "2026-27", deadline }, { ...base(), store, now: () => deadline - 48 * HOUR });
		expect(r.file).toEqual({ schema: "gaffer.odds/1", source: "football-data.co.uk", available: false, reason: "football-data.co.uk unavailable: HTTP 503", fixtures: [], results: {} });
		expect(r.warnings).toEqual(["Odds unavailable (football-data.co.uk unavailable: HTTP 503): the golden path will take team strength from Dixon-Coles alone."]);
		expect(odds.count("/fixtures.csv")).toBe(ODDS_MAX_TRIES); // bounded retries
		expect(r.endpoints[0]).toMatchObject({ path: "football-data:fixtures.csv", status: 503, retries: ODDS_MAX_TRIES - 1, error: "HTTP 503" });
		expect(r.fresh).toEqual([]);
	});

	it("with the source down, falls back to a recent cached copy and says so; an old copy is not used", async () => {
		const t0 = deadline - 72 * HOUR;
		remember(await fetchOdds({ season: "2026-27", deadline }, { ...base(), store, now: () => t0 }), t0);
		odds.down = true;
		const recent = await fetchOdds({ season: "2026-27", deadline }, { ...base(), store, now: () => t0 + 30 * HOUR });
		expect(recent.file.available).toBe(true);
		expect(recent.file.fixtures).toHaveLength(2);
		expect(recent.file.results["2026-27"]).toHaveLength(1); // results come from the cache too
		expect(recent.warnings[0]).toMatch(/could not be reached \(HTTP 503\); using odds fetched/);
		const old = await fetchOdds({ season: "2026-27", deadline }, { ...base(), store, now: () => t0 + 60 * HOUR });
		expect(old.file.available).toBe(false);
		expect(old.file.results["2025-26"]).toHaveLength(2); // last season's results are still good
	});

	it("an HTML page instead of the CSV counts as unavailable", async () => {
		odds.files["/fixtures.csv"] = "<html>Checking your browser</html>";
		const r = await fetchOdds({ season: "2026-27", deadline }, { ...base(), store, now: () => deadline - 48 * HOUR });
		expect(r.file.available).toBe(false);
		expect(r.file.reason).toMatch(/not a football-data CSV/);
		expect(r.file.results["2026-27"]).toHaveLength(1);
	});

	it("refuses a base URL that is not the allowlisted host", async () => {
		const r = await fetchOdds({ season: "2026-27", deadline }, { ...base(), baseUrl: "https://example.com/", store, now: () => deadline - 48 * HOUR });
		expect(r.file.available).toBe(false);
		expect(r.file.reason).toMatch(/not on the allowlist/);
		expect(odds.hits).toHaveLength(0);
	});
});

describe("takeSnapshot with the odds source, recent GW stats and ep_next", () => {
	let fpl: MockFpl;
	let odds: MockOdds;
	let deps: SnapshotDeps;

	beforeEach(async () => {
		fpl = await new MockFpl().start();
		odds = await new MockOdds().start();
		deps = {
			client: new FplClient({ baseUrl: fpl.base, limiter: new RateLimiter(1000), random: () => 0 }),
			store: new SnapshotStore(mkdtempSync(join(tmpdir(), "gaffer-snap-"))),
			salt: "test-salt",
			now: () => deadline - 48 * HOUR,
			odds: { baseUrl: odds.base, limiter: new RateLimiter(1000), random: () => 0, sleep: async () => undefined },
		};
	});
	afterEach(async () => {
		await fpl.stop();
		await odds.stop();
	});
	const read = <T>(id: string, name: string) => JSON.parse(readFileSync(join(deps.store.dir(id), `${name}.json`), "utf8")) as T;

	it('include: ["odds"] writes odds.json into the snapshot and reports it', async () => {
		const { details, text } = await takeSnapshot({ teamId: 1, include: ["odds"] }, deps);
		expect(details.odds).toEqual({ requested: true, available: true, fixtures: 2, reason: null });
		const file = read<OddsFile>(details.snapshot_id, "odds");
		expect(file.fixtures.map((f) => `${f.home} v ${f.away}`)).toEqual(["Arsenal v Tottenham", "Nott'm Forest v Hull"]);
		expect(text).toContain("Odds (football-data.co.uk): 2 Premier League fixture(s) priced.");
		expect(details.endpoints.filter((e) => e.path.startsWith("football-data:")).map((e) => e.status)).toEqual([200, 200, 200]); // NFR-OBS-02
		expect(read<{ files: string[] }>(details.snapshot_id, "manifest").files).toContain("odds.json");
	});

	it("without include, no request goes to the odds host and the summary says how to get them", async () => {
		const { details, text } = await takeSnapshot({ teamId: 1 }, deps);
		expect(odds.hits).toHaveLength(0);
		expect(details.odds).toEqual({ requested: false, available: false, fixtures: 0, reason: null });
		expect(read<{ files: string[] }>(details.snapshot_id, "manifest").files).not.toContain("odds.json");
		expect(text).toContain('call fpl_snapshot with include: ["odds"]');
	});

	it("FR-DAT-09: with the odds source down the snapshot still completes and odds.json says why", async () => {
		odds.down = true;
		const { details, text } = await takeSnapshot({ teamId: 1, include: ["odds"] }, deps);
		expect(details.stale).toBe(false); // FPL data is fine; only the odds are missing
		expect(details.odds).toEqual({ requested: true, available: false, fixtures: 0, reason: "football-data.co.uk unavailable: HTTP 503" });
		// This is the file gaffer_lib reads: it then warns "odds unavailable — team strength from Dixon-Coles".
		expect(read<OddsFile>(details.snapshot_id, "odds")).toEqual({
			schema: "gaffer.odds/1", source: "football-data.co.uk", available: false, reason: "football-data.co.uk unavailable: HTTP 503", fixtures: [], results: {},
		});
		expect(text).toContain("Odds: unavailable (football-data.co.uk unavailable: HTTP 503); team strength will come from Dixon-Coles.");
		expect(details.warnings.join("\n")).toMatch(/Odds unavailable/);
		expect(details.squad).toHaveLength(15);
	});

	it("identical upstream data gives an identical hash with odds included (FR-DAT-07)", async () => {
		const a = await takeSnapshot({ teamId: 1, include: ["odds"], forceFresh: true }, deps);
		const b = await takeSnapshot({ teamId: 1, include: ["odds"], forceFresh: true }, { ...deps, now: () => deadline - 47 * HOUR });
		expect(a.details.snapshot_hash).toBe(b.details.snapshot_hash);
	});

	it("stores the last finished GWs' player stats, trimmed, and fetches each GW once", async () => {
		const { details } = await takeSnapshot({ teamId: 1 }, deps);
		expect(details.recent_gws).toEqual([1, 2, 3, 4, 5]);
		const live = read<{ elements: { id: number; stats: Record<string, unknown>; explain?: unknown }[] }>(details.snapshot_id, "live-5");
		expect(live.elements).toHaveLength(320);
		expect(live.elements[0]).toEqual({ id: 1, stats: { minutes: 90, starts: 1, goals_scored: 0, assists: 0, expected_goals: "0.10", total_points: 2 } });
		await takeSnapshot({ teamId: 1, forceFresh: false }, { ...deps, now: () => deadline - 20 * HOUR });
		expect(fpl.count("event/5/live/")).toBe(1); // a checked GW never changes
		expect(fpl.hits.find((h) => h.path === "event/5/live/")?.url).not.toMatch(/\?_=/); // shared data: not cache-busted
	});

	it("a GW that is not data-checked yet is left out, and a failed stats fetch is a warning, not an error", async () => {
		const b = fpl.data["bootstrap-static/"] as ReturnType<typeof fx.bootstrap>;
		b.events[4].data_checked = false;
		fpl.overrides.set("event/3/live/", { status: 404 });
		const { details } = await takeSnapshot({ teamId: 1 }, deps);
		expect(details.recent_gws).toEqual([1, 2, 4]);
		expect(details.warnings.join("\n")).toMatch(/GW3 player stats could not be fetched/);
		expect(fpl.count("event/5/live/")).toBe(0);
	});

	it("rejects malformed GW stats rather than storing them (FR-DAT-06)", async () => {
		fpl.data["event/4/live/"] = { elements: [{ id: 1, stats: { minutes: "ninety" } }] };
		const { details } = await takeSnapshot({ teamId: 1 }, deps);
		expect(details.recent_gws).toEqual([1, 2, 3, 5]);
		expect(details.warnings.join("\n")).toMatch(/GW4 player stats could not be fetched \(FPL data failed validation/);
	});

	it("FR-DAT-10: a snapshot before the deadline records the official ep_next for the next GW", async () => {
		expect(epNextRecorded(deps.store, "2026-27", [6])).toEqual([{ gw: 6, snapshot: null, fetched_at: null }]);
		const { details } = await takeSnapshot({ teamId: 1 }, deps);
		expect(details.ep_next).toEqual({ gw: 6, players: 320, before_deadline: true });
		const rec = epNextRecorded(deps.store, "2026-27", [5, 6, 7]);
		expect(rec[1]).toEqual({ gw: 6, snapshot: details.snapshot_id, fetched_at: new Date(deadline - 48 * HOUR).toISOString() });
		expect(rec[0].snapshot).toBeNull();
		expect(rec[2].snapshot).toBeNull();
		expect(Date.parse(rec[1].fetched_at!)).toBeLessThan(deadline);
		const boot = read<{ elements: { ep_next: string }[] }>(rec[1].snapshot!, "bootstrap-static");
		expect(boot.elements.every((e) => e.ep_next === "3.1")).toBe(true);
		// A later pre-deadline snapshot replaces it; one taken after the deadline does not.
		const later = await takeSnapshot({ teamId: 1 }, { ...deps, now: () => deadline - HOUR });
		expect(epNextRecorded(deps.store, "2026-27", [6])[0].snapshot).toBe(later.details.snapshot_id);
		const after = await takeSnapshot({ teamId: 1, forceFresh: true }, { ...deps, now: () => deadline + HOUR });
		expect(after.details.ep_next.before_deadline).toBe(false);
		expect(epNextRecorded(deps.store, "2026-27", [6])[0].snapshot).toBe(later.details.snapshot_id);
	});

	it("the summary gives the golden-path command with the user's overrides", async () => {
		const { details, text } = await takeSnapshot({ teamId: 1, ft: 2, pending: "P1>P65" }, deps);
		expect(details.run_command).toBe(`python -m gaffer_lib run --snapshot '${details.snapshot_path}' --out /work/plan.json --ft 2 --pending 'P1>P65'`);
		expect(text).toContain(details.run_command);
		expect(runCommand("/data/snapshots/x", {})).toBe("python -m gaffer_lib run --snapshot '/data/snapshots/x' --out /work/plan.json");
		expect(text.length).toBeLessThan(6000);
	});
});
