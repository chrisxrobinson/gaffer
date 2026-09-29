/**
 * Immutable, content-hashed snapshot store under /data/snapshots (ADR 0002, FR-DAT-07).
 * The store is also the cache: an index maps each shared resource (and each team's last good
 * per-user fetch) to the snapshot that holds it. Snapshots are never modified or deleted in-season.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_DATA_DIR = "/data";

/** sha256 over each file's name and exact JSON text, in name order. */
export function contentHash(files: Record<string, unknown>): string {
	const h = createHash("sha256");
	for (const name of Object.keys(files).sort()) h.update(`${name}\n${JSON.stringify(files[name])}\n`);
	return h.digest("hex");
}

export interface IndexEntry {
	/** Snapshot id (relative to snapshots/). */
	snapshot: string;
	/** ms since epoch when the resource was fetched from upstream. */
	fetched_at: number;
}

export interface WrittenSnapshot {
	id: string;
	dir: string;
	hash: string;
}

export class SnapshotStore {
	readonly root: string;
	constructor(root: string = process.env.GAFFER_DATA_DIR ?? DEFAULT_DATA_DIR) {
		this.root = root;
	}

	get snapshotsDir(): string {
		return join(this.root, "snapshots");
	}

	private get indexPath(): string {
		return join(this.root, "cache", "index.json");
	}

	write(input: { season: string; gw: number; files: Record<string, unknown>; manifest: Record<string, unknown>; now?: Date }): WrittenSnapshot {
		const hash = contentHash(input.files);
		const ts = (input.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
		const id = `${input.season}/${input.gw}/${ts}-${hash.slice(0, 12)}`;
		const dir = join(this.snapshotsDir, id);
		const parent = join(this.snapshotsDir, input.season, String(input.gw));
		mkdirSync(parent, { recursive: true });
		if (existsSync(dir)) return { id, dir, hash }; // same second, same content: already stored
		// Write into a temp dir, then rename, so a snapshot is never seen half-written.
		const tmp = join(parent, `.tmp-${ts}-${process.pid}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tmp);
		const names = Object.keys(input.files).sort();
		for (const name of names) writeFileSync(join(tmp, `${name}.json`), JSON.stringify(input.files[name]), { mode: 0o444 });
		const manifest = { ...input.manifest, id, hash, files: names.map((n) => `${n}.json`) };
		writeFileSync(join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o444 });
		renameSync(tmp, dir);
		chmodSync(dir, 0o555); // after the rename: moving a directory needs write access to it
		return { id, dir, hash };
	}

	read<T = unknown>(id: string, name: string): T {
		return JSON.parse(readFileSync(join(this.snapshotsDir, id, `${name}.json`), "utf8")) as T;
	}

	dir(id: string): string {
		return join(this.snapshotsDir, id);
	}

	private loadIndex(): Record<string, IndexEntry> {
		try {
			return JSON.parse(readFileSync(this.indexPath, "utf8"));
		} catch {
			return {};
		}
	}

	lookup(key: string): IndexEntry | undefined {
		return this.loadIndex()[key];
	}

	/** Point index keys at snapshots. The index is derived and rebuildable; it is not itself a snapshot. */
	index(entries: Record<string, IndexEntry>): void {
		const next = { ...this.loadIndex(), ...entries };
		mkdirSync(join(this.root, "cache"), { recursive: true });
		const tmp = `${this.indexPath}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(next, null, 2));
		renameSync(tmp, this.indexPath);
	}
}
