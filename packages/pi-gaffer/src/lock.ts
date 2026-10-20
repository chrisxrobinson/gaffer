/**
 * The two locks of ADR 0014 (NFR-REL-03): Pi doesn't lock session files, and the Compose sandbox and its /work
 * are shared by every Pi process in the harness.
 *
 * - The session lock, `<session file>.lock`: one writer per session. Taken on session_start, released on
 *   shutdown or switch; a second process opens the session read-only.
 * - The run lock, `<sessions root>/.gaffer-run.lock`: one run at a time per harness (Phase 1.1 only; per-session
 *   sandboxes retire it in Phase 2). The Compose provider clears /work only while holding it.
 *
 * A lock is a file created with O_EXCL holding its owner's pid, host, process start time and a heartbeat that the
 * owner rewrites every few seconds. It is stale when its heartbeat is older than STALE_MS, or when it names a
 * process on this host that is gone (the start time catches a pid reused after a container restart); a stale lock
 * is taken over by renaming it aside first, so two processes can't both take it over.
 */
import { randomBytes } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export const HEARTBEAT_MS = 5_000;
export const STALE_MS = 30_000;

export interface LockOwner {
	pid: number;
	host: string;
	/** The owner's start time in clock ticks since boot (Linux /proc), so a reused pid isn't mistaken for it. */
	start: string | null;
	/** Which UI holds it: "terminal", "app" or "headless". */
	ui: string;
	token: string;
	acquired_at: string;
	heartbeat: string;
}

function startTime(pid: number): string | null {
	try {
		// Field 22 of /proc/<pid>/stat; the command name (field 2) may contain spaces, so count from its ")".
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
	} catch {
		return null;
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readRaw(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function parseOwner(raw: string | undefined): LockOwner | undefined {
	try {
		return raw ? (JSON.parse(raw) as LockOwner) : undefined;
	} catch {
		return undefined;
	}
}

const readOwner = (path: string) => parseOwner(readRaw(path));

/** A lock file that can't be parsed is one caught between create and write, unless it is older than STALE_MS. */
function unreadableIsStale(path: string, now: number): boolean {
	try {
		return now - statSync(path).mtimeMs > STALE_MS;
	} catch {
		return true;
	}
}

/** Whether the owner recorded in a lock file still holds it. */
export function isLive(owner: LockOwner, now: number = Date.now()): boolean {
	const beat = Date.parse(owner.heartbeat);
	if (!Number.isFinite(beat) || now - beat > STALE_MS) return false;
	if (owner.host !== hostname()) return true; // another host's process: only its heartbeat can tell
	if (!alive(owner.pid)) return false;
	return owner.start === null || startTime(owner.pid) === null || startTime(owner.pid) === owner.start;
}

/** The live owner of the lock at `path`, or undefined when it is free or stale. */
export function lockHolder(path: string): LockOwner | undefined {
	const raw = readRaw(path);
	if (raw === undefined) return undefined;
	const owner = parseOwner(raw);
	if (owner) return isLive(owner) ? owner : undefined;
	return unreadableIsStale(path, Date.now()) ? undefined : { pid: 0, host: "", start: null, ui: "headless", token: "", acquired_at: "", heartbeat: "" };
}

export class FileLock {
	readonly path: string;
	private readonly ui: string;
	private owner: LockOwner | undefined;
	private timer: NodeJS.Timeout | undefined;
	/** Called once if another process took the lock over (this process was frozen past STALE_MS). */
	onLost: (() => void) | undefined;

	constructor(path: string, ui: string) {
		this.path = path;
		this.ui = ui;
	}

	get held(): boolean {
		return this.owner !== undefined;
	}

	/** Take the lock if it is free or stale. Never waits. */
	tryAcquire(): boolean {
		if (this.owner) return true;
		const now = new Date().toISOString();
		const owner: LockOwner = { pid: process.pid, host: hostname(), start: startTime(process.pid), ui: this.ui, token: randomBytes(8).toString("hex"), acquired_at: now, heartbeat: now };
		for (let attempt = 0; attempt < 2; attempt++) {
			if (this.create(owner)) {
				this.owner = owner;
				this.timer = setInterval(() => this.beat(), HEARTBEAT_MS);
				this.timer.unref();
				return true;
			}
			const raw = readRaw(this.path);
			if (raw === undefined) continue; // released meanwhile
			const current = parseOwner(raw);
			if (current ? isLive(current) : !unreadableIsStale(this.path, Date.now())) return false;
			if (!this.takeAway(raw)) return false;
		}
		return false;
	}

	release(): void {
		clearInterval(this.timer);
		this.timer = undefined;
		if (!this.owner) return;
		const mine = readOwner(this.path)?.token === this.owner.token;
		this.owner = undefined;
		if (mine) {
			try {
				unlinkSync(this.path);
			} catch {
				/* already gone */
			}
		}
	}

	private create(owner: LockOwner): boolean {
		mkdirSync(dirname(this.path), { recursive: true });
		let fd: number;
		try {
			fd = openSync(this.path, "wx", 0o644);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw e;
		}
		try {
			writeSync(fd, JSON.stringify(owner));
		} finally {
			closeSync(fd);
		}
		return true;
	}

	/** Move a stale lock aside; if it turns out someone else took it over meanwhile, put theirs back. */
	private takeAway(staleRaw: string): boolean {
		const aside = join(dirname(this.path), `.${randomBytes(6).toString("hex")}.stale-lock`);
		try {
			renameSync(this.path, aside);
		} catch {
			return true; // gone already: try to create it again
		}
		if (readRaw(aside) !== staleRaw) {
			try {
				linkSync(aside, this.path); // atomic: fails if a lock exists again, which is then the real one
			} catch {
				/* someone holds it now */
			}
			unlinkSync(aside);
			return false;
		}
		unlinkSync(aside);
		return true;
	}

	private beat(): void {
		if (!this.owner) return;
		if (readOwner(this.path)?.token !== this.owner.token) {
			clearInterval(this.timer);
			this.timer = undefined;
			this.owner = undefined;
			this.onLost?.();
			return;
		}
		this.owner = { ...this.owner, heartbeat: new Date().toISOString() };
		const tmp = `${this.path}.${process.pid}.tmp`;
		try {
			writeFileSync(tmp, JSON.stringify(this.owner));
			renameSync(tmp, this.path);
		} catch {
			/* the next beat tries again */
		}
	}
}

/** The run lock's file for a sessions root. */
export function runLockPath(sessionsRoot: string): string {
	return join(sessionsRoot, ".gaffer-run.lock");
}

/**
 * This process's run lock for a sessions root. Pi loads each extension with its own module cache, so the
 * instance is shared through globalThis: gaffer-core takes it for a run and gaffer-sandbox checks it before
 * clearing /work.
 */
export function processRunLock(sessionsRoot: string, ui: string): FileLock {
	const g = globalThis as { __gafferRunLocks?: Map<string, FileLock> };
	g.__gafferRunLocks ??= new Map();
	const path = runLockPath(sessionsRoot);
	let lock = g.__gafferRunLocks.get(path);
	if (!lock) g.__gafferRunLocks.set(path, (lock = new FileLock(path, ui)));
	return lock;
}

/** The session lock's file for a session file. */
export function sessionLockPath(sessionFile: string): string {
	return `${sessionFile}.lock`;
}

/** Which UI this process is, for the lock files: the App's RPC processes, the terminal, or GAFFER_UI. */
export function uiName(ctx: { mode: string }): string {
	return process.env.GAFFER_UI || (ctx.mode === "rpc" ? "app" : "terminal");
}

/** Which UI a lock owner is, in words. */
export function holderName(owner: Pick<LockOwner, "ui">): string {
	return owner.ui === "app" ? "the Gaffer App" : owner.ui === "terminal" ? "the browser terminal" : "another Gaffer process";
}
