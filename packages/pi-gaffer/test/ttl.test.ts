import { describe, expect, it } from "vitest";
import { isFresh, ttlMs } from "../src/ttl.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const deadline = Date.parse("2026-10-10T10:00:00Z");
const outside = deadline - 24 * HOUR; // T-24h
const inside = deadline - 2 * HOUR; // T-2h
const clock = { deadline, priceChangeDeadlines: [] as number[] };

describe("ttlMs (FR-DAT-03, frozen clocks)", () => {
	it("bootstrap-static: 30 min outside the window, 5 min inside", () => {
		expect(ttlMs("bootstrap-static", { ...clock, now: outside })).toBe(30 * MIN);
		expect(ttlMs("bootstrap-static", { ...clock, now: inside })).toBe(5 * MIN);
	});
	it("fixtures: 6 h outside, 30 min inside", () => {
		expect(ttlMs("fixtures", { ...clock, now: outside })).toBe(6 * HOUR);
		expect(ttlMs("fixtures", { ...clock, now: inside })).toBe(30 * MIN);
	});
	it("element-summary: 12 h outside, 1 h inside", () => {
		expect(ttlMs("element-summary", { ...clock, now: outside })).toBe(12 * HOUR);
		expect(ttlMs("element-summary", { ...clock, now: inside })).toBe(1 * HOUR);
	});
	it("per-user entry endpoints are never cached", () => {
		expect(ttlMs("entry", { ...clock, now: outside })).toBe(0);
		expect(ttlMs("entry", { ...clock, now: inside })).toBe(0);
	});
	it("the window starts at exactly T-6h and ends at the deadline", () => {
		expect(ttlMs("fixtures", { ...clock, now: deadline - 6 * HOUR - 1 })).toBe(6 * HOUR);
		expect(ttlMs("fixtures", { ...clock, now: deadline - 6 * HOUR })).toBe(30 * MIN);
		expect(ttlMs("fixtures", { ...clock, now: deadline - 1 })).toBe(30 * MIN);
		expect(ttlMs("fixtures", { ...clock, now: deadline })).toBe(6 * HOUR);
	});
	it("no known deadline means the outside-window TTL", () => {
		expect(ttlMs("bootstrap-static", { now: outside, deadline: undefined, priceChangeDeadlines: [] })).toBe(30 * MIN);
	});
});

describe("isFresh", () => {
	it("a cached bootstrap within its TTL is fresh", () => {
		expect(isFresh("bootstrap-static", outside - 29 * MIN, { ...clock, now: outside })).toBe(true);
		expect(isFresh("bootstrap-static", outside - 31 * MIN, { ...clock, now: outside })).toBe(false);
	});
	it("bootstrap is force-refreshed once a price-change deadline passes after it was fetched", () => {
		const pcd = outside - 1 * MIN;
		const c = { ...clock, now: outside, priceChangeDeadlines: [pcd] };
		expect(isFresh("bootstrap-static", outside - 10 * MIN, c)).toBe(false);
		expect(isFresh("bootstrap-static", pcd + 1, c)).toBe(true);
		// a future price-change deadline doesn't expire it
		expect(isFresh("bootstrap-static", outside - 10 * MIN, { ...c, priceChangeDeadlines: [outside + HOUR] })).toBe(true);
	});
	it("price-change deadlines only affect bootstrap", () => {
		const c = { ...clock, now: outside, priceChangeDeadlines: [outside - MIN] };
		expect(isFresh("fixtures", outside - 10 * MIN, c)).toBe(true);
	});
	it("entry data is never fresh from cache", () => {
		expect(isFresh("entry", outside, { ...clock, now: outside })).toBe(false);
	});
});
