import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contentHash, SnapshotStore } from "../src/store.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "gaffer-store-"));
const files = () => ({ "bootstrap-static": { events: [{ id: 6 }], x: [1, 2] }, fixtures: [{ id: 1 }] });

describe("contentHash", () => {
	it("is stable for identical content and independent of file insertion order", () => {
		const a = files();
		const b = { fixtures: [{ id: 1 }], "bootstrap-static": { events: [{ id: 6 }], x: [1, 2] } };
		expect(contentHash(a)).toBe(contentHash(b));
		expect(contentHash(a)).toMatch(/^[0-9a-f]{64}$/);
	});
	it("changes when any content changes", () => {
		const b = files();
		b.fixtures[0].id = 2;
		expect(contentHash(files())).not.toBe(contentHash(b));
	});
});

describe("SnapshotStore (FR-DAT-07)", () => {
	it("two runs with identical upstream data share a hash", () => {
		const store = new SnapshotStore(tmp());
		const s1 = store.write({ season: "2026-27", gw: 6, files: files(), manifest: { fetched_at: "2026-09-28T20:00:00Z" } });
		const s2 = store.write({ season: "2026-27", gw: 6, files: files(), manifest: { fetched_at: "2026-09-28T20:05:00Z" } });
		expect(s1.hash).toBe(s2.hash);
		expect(s1.id).toMatch(/^2026-27\/6\/\d{8}T\d{6}Z-[0-9a-f]{12}$/);
	});

	it("writes files and directory read-only; a write attempt fails", () => {
		const store = new SnapshotStore(tmp());
		const s = store.write({ season: "2026-27", gw: 6, files: files(), manifest: {} });
		const f = join(s.dir, "fixtures.json");
		expect(JSON.parse(readFileSync(f, "utf8"))).toEqual([{ id: 1 }]);
		expect(statSync(f).mode & 0o222).toBe(0);
		expect(statSync(s.dir).mode & 0o222).toBe(0);
		expect(() => writeFileSync(f, "tampered")).toThrow(/EACCES|EPERM/);
		expect(() => writeFileSync(join(s.dir, "new.json"), "{}")).toThrow(/EACCES|EPERM/);
	});

	it("the manifest records the hash and is not part of it", () => {
		const store = new SnapshotStore(tmp());
		const s = store.write({ season: "2026-27", gw: 6, files: files(), manifest: { fetched_at: "t" } });
		const m = JSON.parse(readFileSync(join(s.dir, "manifest.json"), "utf8"));
		expect(m.hash).toBe(s.hash);
		expect(m.id).toBe(s.id);
		expect(m.files).toEqual(["bootstrap-static.json", "fixtures.json"]);
	});

	it("indexes shared resources for cache lookups and per-team last-good snapshots", () => {
		const store = new SnapshotStore(tmp());
		const s = store.write({ season: "2026-27", gw: 6, files: files(), manifest: {} });
		store.index({ "bootstrap-static": { snapshot: s.id, fetched_at: 1000 }, "team:abc": { snapshot: s.id, fetched_at: 1000 } });
		expect(store.lookup("bootstrap-static")).toEqual({ snapshot: s.id, fetched_at: 1000 });
		expect(store.read(s.id, "bootstrap-static")).toEqual(files()["bootstrap-static"]);
		expect(store.lookup("fixtures")).toBeUndefined();
		// a fresh store instance sees the persisted index
		expect(new SnapshotStore(store.root).lookup("team:abc")?.snapshot).toBe(s.id);
	});
});
