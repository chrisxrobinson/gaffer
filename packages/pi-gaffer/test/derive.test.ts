/**
 * fpl_snapshot + gaffer_lib derive through a real (host) sandboxd, against the mock FPL API.
 * The derivation logic itself is tested in python/gaffer_lib/tests; this covers the wiring.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deriveCommand, sandboxDerive } from "../src/derive.ts";
import { FplClient, RateLimiter } from "../src/http.ts";
import { ComposeSandboxProvider, SandboxSession } from "../src/sandbox.ts";
import { type SnapshotDeps, takeSnapshot } from "../src/snapshot.ts";
import { SnapshotStore } from "../src/store.ts";
import * as fx from "./fixtures.ts";
import { hostGafferLibCommand } from "./harness.ts";
import { MockFpl } from "./mock-fpl.ts";

const SANDBOXD = resolve(import.meta.dirname, "../../../sandbox/sandboxd.py");
let sbx: ChildProcess;
let sandbox: SandboxSession;
let fpl: MockFpl;
let deps: SnapshotDeps;

beforeAll(async () => {
	const work = join(mkdtempSync(join(tmpdir(), "gaffer-derive-")), "work");
	mkdirSync(work);
	const port = await new Promise<number>((r) => {
		const s = createServer().listen(0, "127.0.0.1", () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => r(p));
		});
	});
	sbx = spawn("python3", [SANDBOXD, "--host", "127.0.0.1", "--port", String(port), "--work", work, "--max-procs", "0"], { stdio: "ignore" });
	process.env.GAFFER_LIB_CMD = hostGafferLibCommand();
	sandbox = new SandboxSession(new ComposeSandboxProvider(`http://127.0.0.1:${port}`));
});
afterAll(() => void sbx.kill());

beforeEach(async () => {
	fpl = await new MockFpl().start();
	deps = {
		client: new FplClient({ baseUrl: fpl.base, limiter: new RateLimiter(1000), random: () => 0 }),
		store: new SnapshotStore(mkdtempSync(join(tmpdir(), "gaffer-snap-"))),
		salt: "test-salt",
		now: () => Date.parse(fx.DEADLINE_GW6) - 48 * 3_600_000,
		derive: sandboxDerive(sandbox),
	};
});
afterEach(() => fpl.stop());

describe("fpl_snapshot runs gaffer_lib derive in the sandbox (ARCHITECTURE §2.2)", () => {
	it("derives free transfers and selling prices and puts them in the summary", async () => {
		const { details, text } = await takeSnapshot({ teamId: 1 }, deps);
		expect(details.derived_by).toMatch(/^gaffer_lib /);
		// Mock history: GW1-5, no transfers, no chips → 1, 2, 3, 4, then 5 FT for GW6.
		expect(details.free_transfers).toMatchObject({ value: 5, source: "derived", confidence: "high" });
		expect(details.assumptions).toEqual({ free_transfers: 5, ft_source: "derived", pending_transfers: [] });
		expect(details.squad.map((p) => p.id)).toEqual(fx.SQUAD);
		expect(details.squad.every((p) => p.selling_price === p.price)).toBe(true); // no price changes in the mock
		expect(details.budget).toBeCloseTo(0.5 + details.squad.reduce((a, p) => a + p.price, 0), 5);
		expect(text).toMatch(/Free transfers for GW6: 5 \(ASSUMED/);
		expect(text).toMatch(/price {3}sell/);
		expect(text.length).toBeLessThan(6000);
	});

	it("a user FT override is used and recorded as ft_source user (FR-INP-04)", async () => {
		const { details, text } = await takeSnapshot({ teamId: 1, ft: 3 }, deps);
		expect(details.free_transfers).toMatchObject({ value: 3, source: "user", derived: 5 });
		expect(details.assumptions).toMatchObject({ free_transfers: 3, ft_source: "user" });
		expect(text).toMatch(/Free transfers for GW6: 3 \(set by the user; public data suggests 5\)/);
	});

	it("pending transfers are applied to the derived state", async () => {
		// P1 (a £4.6m GK of team 1) out, P65 (a £5.0m GK of team 5) in; bank £0.5m → £0.1m.
		const { details, text } = await takeSnapshot({ teamId: 1, pending: "P1>P65" }, deps);
		expect(details.pending).toMatchObject({ count: 1, hits: 0, ft_remaining: 4, bank_after: 1, violations: [] });
		expect(details.assumptions?.pending_transfers).toEqual([[1, 65]]);
		expect(text).toMatch(/Pending transfers declared by the user .*P1 → P65/);
	});

	it("bad pending transfers are reported and derivation still happens without them", async () => {
		const { details } = await takeSnapshot({ teamId: 1, pending: "Nobody>P33" }, deps);
		expect(details.free_transfers?.value).toBe(5);
		expect(details.pending).toBeNull();
		expect(details.warnings.join(" ")).toMatch(/could not be applied: no player called 'Nobody' in the squad/);
	});

	it("after a Free Hit, the derived squad and bank are the previous GW's", async () => {
		fpl.data["entry/1/event/5/picks/"] = fx.picks(5, [...fx.SQUAD].reverse(), "freehit", 0);
		fpl.data["entry/1/event/4/picks/"] = fx.picks(4, fx.SQUAD, null, 12);
		(fpl.data["entry/1/history/"] as ReturnType<typeof fx.history>).chips = [{ name: "freehit", time: "2026-09-18T16:00:00Z", event: 5 }];
		const { details } = await takeSnapshot({ teamId: 1 }, deps);
		expect(details.squad_basis_gw).toBe(4);
		expect(details.bank).toBe(1.2);
		expect(details.squad.map((p) => p.id)).toEqual(fx.SQUAD);
		expect(details.free_transfers?.value).toBe(4); // FH keeps GW5's 4
		expect(details.warnings.join(" ")).toMatch(/Free Hit was played in GW5/);
	});

	it("if the sandbox is down, the snapshot is still returned with FT unknown and a warning", async () => {
		const dead = new SandboxSession(new ComposeSandboxProvider("http://127.0.0.1:9", { timeoutMs: 300 }));
		const { details, text } = await takeSnapshot({ teamId: 1 }, { ...deps, derive: sandboxDerive(dead) });
		expect(details.derived_by).toBeNull();
		expect(details.free_transfers).toBeNull();
		expect(details.squad.map((p) => p.id)).toEqual(fx.SQUAD);
		expect(text).toMatch(/Free transfers: unknown/);
		expect(details.warnings.join(" ")).toMatch(/could not be derived/);
	});
});

describe("deriveCommand", () => {
	it("quotes user input for the shell", () => {
		expect(deriveCommand("/data/snapshots/x", { ft: 2, pending: "O'Reilly>Egan; rm -rf /" }, "python -m gaffer_lib")).toBe(
			`python -m gaffer_lib derive --snapshot '/data/snapshots/x' --ft 2 --pending 'O'\\''Reilly>Egan; rm -rf /'`,
		);
	});
});
