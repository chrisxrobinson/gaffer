import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { backoffDelayMs, FplClient, FplNotFoundError, FplUnavailableError, RateLimiter } from "../src/http.ts";

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

type Reply = { status: number; body?: string; type?: string; age?: number };
async function mockFpl(replies: Reply[] | ((n: number, url: string) => Reply)) {
	const hits: { t: number; url: string }[] = [];
	server = createServer((req, res) => {
		hits.push({ t: Date.now(), url: req.url ?? "" });
		const r = typeof replies === "function" ? replies(hits.length - 1, req.url ?? "") : (replies[hits.length - 1] ?? replies.at(-1)!);
		const headers: Record<string, string> = { "content-type": r.type ?? "application/json" };
		if (r.age !== undefined) headers.age = String(r.age);
		res.writeHead(r.status, headers).end(r.body ?? "{}");
	});
	await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/`;
	return { base, hits };
}

describe("backoffDelayMs (full jitter)", () => {
	it("is uniform in [0, 0.5·2^n] s, capped at 8 s", () => {
		for (let n = 0; n < 8; n++) {
			const cap = Math.min(8000, 500 * 2 ** n);
			expect(backoffDelayMs(n, () => 0)).toBe(0);
			expect(backoffDelayMs(n, () => 0.999999)).toBeLessThanOrEqual(cap);
			expect(backoffDelayMs(n, () => 0.999999)).toBeGreaterThan(cap * 0.99);
		}
	});
});

describe("RateLimiter", () => {
	it("spaces acquisitions at least 500 ms apart (2 req/s)", async () => {
		const rl = new RateLimiter(2);
		const ts: number[] = [];
		await Promise.all([0, 1, 2, 3].map(async () => { await rl.acquire(); ts.push(Date.now()); }));
		ts.sort((a, b) => a - b);
		for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1]).toBeGreaterThanOrEqual(490);
	});
});

describe("FplClient retries (FR-DAT-04)", () => {
	it("429, 503, 503 then 200: 4 attempts, jittered delays within bounds, ≤ 2 req/s", async () => {
		const { base, hits } = await mockFpl([{ status: 429 }, { status: 503 }, { status: 503 }, { status: 200, body: '{"ok":1}' }]);
		const delays: number[] = [];
		const client = new FplClient({ baseUrl: base, limiter: new RateLimiter(2), random: Math.random, onBackoff: (ms) => delays.push(ms) });
		const res = await client.get("bootstrap-static/");
		expect(res.json).toEqual({ ok: 1 });
		expect(res.attempts).toBe(4);
		expect(res.retries).toBe(3);
		expect(hits).toHaveLength(4);
		delays.forEach((d, n) => {
			expect(d).toBeGreaterThanOrEqual(0);
			expect(d).toBeLessThanOrEqual(Math.min(8000, 500 * 2 ** n));
		});
		// ≤ 2 requests in any 1-second window (small tolerance for loopback arrival jitter)
		for (let i = 2; i < hits.length; i++) expect(hits[i].t - hits[i - 2].t).toBeGreaterThanOrEqual(980);
	}, 15_000);

	it("gives up after 4 tries with FplUnavailableError(fpl_updating) on persistent 503", async () => {
		const { base, hits } = await mockFpl([{ status: 503 }]);
		const client = new FplClient({ baseUrl: base, limiter: new RateLimiter(100), random: () => 0 });
		await expect(client.get("fixtures/")).rejects.toMatchObject({ name: "FplUnavailableError", reason: "fpl_updating" });
		expect(hits).toHaveLength(4);
	});

	it("treats an HTML body as 'game updating' and retries it", async () => {
		const { base, hits } = await mockFpl([{ status: 200, type: "text/html", body: "<html>The game is being updated.</html>" }]);
		const client = new FplClient({ baseUrl: base, limiter: new RateLimiter(100), random: () => 0 });
		const err = await client.get("bootstrap-static/").catch((e) => e);
		expect(err).toBeInstanceOf(FplUnavailableError);
		expect(err.reason).toBe("fpl_updating");
		expect(hits).toHaveLength(4);
	});

	it("does not retry a 404 and reports not-found", async () => {
		const { base, hits } = await mockFpl([{ status: 404, body: '{"detail":"Not found."}' }]);
		const client = new FplClient({ baseUrl: base, limiter: new RateLimiter(100), random: () => 0 });
		await expect(client.get("entry/999999999/")).rejects.toBeInstanceOf(FplNotFoundError);
		expect(hits).toHaveLength(1);
	});
});

describe("FplClient per-user freshness (FR-DAT-02)", () => {
	it("cache-busts per-user endpoints with a unique ?_= parameter and records the CDN age", async () => {
		const { base, hits } = await mockFpl([{ status: 200, age: 0 }]);
		const client = new FplClient({ baseUrl: base, limiter: new RateLimiter(100), random: () => 0 });
		const a = await client.get("entry/1/history/", { fresh: true });
		const b = await client.get("entry/1/history/", { fresh: true });
		expect(hits[0].url).toMatch(/^\/api\/entry\/1\/history\/\?_=\d+/);
		expect(hits[0].url).not.toBe(hits[1].url);
		expect(a.age).toBe(0);
		expect(b.url).toContain("?_=");
	});

	it("rejects a per-user response the CDN serves with age 700000", async () => {
		const { base, hits } = await mockFpl([{ status: 200, age: 700000 }]);
		const client = new FplClient({ baseUrl: base, limiter: new RateLimiter(100), random: () => 0 });
		const err = await client.get("entry/1/transfers/", { fresh: true }).catch((e) => e);
		expect(err).toBeInstanceOf(FplUnavailableError);
		expect(err.reason).toBe("cdn_stale");
		expect(err.message).toMatch(/age 700000/);
		expect(hits).toHaveLength(4);
	});

	it("accepts age ≤ 60 s for per-user data", async () => {
		const { base } = await mockFpl([{ status: 200, age: 60 }]);
		const client = new FplClient({ baseUrl: base, limiter: new RateLimiter(100), random: () => 0 });
		expect((await client.get("entry/1/", { fresh: true })).age).toBe(60);
	});

	it("does not cache-bust shared endpoints", async () => {
		const { base, hits } = await mockFpl([{ status: 200, age: 250 }]);
		const client = new FplClient({ baseUrl: base, limiter: new RateLimiter(100), random: () => 0 });
		await client.get("bootstrap-static/");
		expect(hits[0].url).toBe("/api/bootstrap-static/");
	});

	it("sends a descriptive User-Agent", async () => {
		let ua = "";
		server = createServer((req, res) => { ua = String(req.headers["user-agent"]); res.writeHead(200, { "content-type": "application/json" }).end("{}"); });
		await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
		const client = new FplClient({ baseUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/`, limiter: new RateLimiter(100) });
		await client.get("fixtures/");
		expect(ua).toMatch(/^Gaffer\//);
	});
});

describe("FplClient read-only guard (FR-ACC-01)", () => {
	it("refuses my-team/, me/ and non-GET before any request is made", async () => {
		const { base, hits } = await mockFpl([{ status: 200 }]);
		const client = new FplClient({ baseUrl: base, limiter: new RateLimiter(100) });
		await expect(client.get("my-team/1/")).rejects.toThrow(/read-only/);
		await expect(client.get("me/")).rejects.toThrow(/read-only/);
		await expect(client.request("POST", "entry/1/")).rejects.toThrow(/read-only/);
		expect(hits).toHaveLength(0);
	});
});
