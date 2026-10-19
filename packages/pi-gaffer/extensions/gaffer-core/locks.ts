/**
 * One writer per session and one run per harness (ADR 0014, NFR-REL-03), in every Pi process that loads Gaffer:
 * the terminal, the App's RPC processes, the eval runner and the stack checks.
 *
 * - The session lock is taken on session_start. If another process holds it, this one is read-only: prompts,
 *   /team and /run are refused with a notice, and nothing is written (no cache warming either). When the other
 *   process lets go, the next prompt takes the lock, provided the file hasn't changed since it was opened;
 *   otherwise the user reopens it to see the other UI's work first.
 * - The run lock is checked before a prompt starts a run (refused with a notice; headless callers may wait,
 *   GAFFER_RUN_LOCK_WAIT_MS), taken at agent_start and released when the run settles.
 *
 * The App's bridge reads the status key below to know a process it spawned came up read-only.
 */
import { statSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionsRoot } from "../../src/config.ts";
import { FileLock, holderName, lockHolder, type LockOwner, processRunLock, sessionLockPath, uiName } from "../../src/lock.ts";

export const LOCK_STATUS_KEY = "gaffer-lock";

export interface SessionGuard {
	/** Why this process can't write to its session now, or undefined if it can. */
	refusal(ctx: ExtensionContext): string | undefined;
	/** Why a run can't start now (another process's run holds the sandbox), or undefined. */
	runBusy(ctx: ExtensionContext): string | undefined;
}

const size = (file: string | undefined) => {
	try {
		return file ? statSync(file).size : -1;
	} catch {
		return -1;
	}
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function gafferLocks(pi: ExtensionAPI): SessionGuard {
	let lock: FileLock | undefined;
	let heldBy: Pick<LockOwner, "ui"> | undefined;
	let openedSize = -1;
	let runLock: FileLock | undefined;

	const runLockFor = (ctx: ExtensionContext) => (runLock ??= processRunLock(sessionsRoot(ctx.sessionManager.getSessionDir()), uiName(ctx)));

	const refusal = (ctx: ExtensionContext): string | undefined => {
		if (!heldBy || !lock) return undefined;
		const file = ctx.sessionManager.getSessionFile();
		// The other UI let go and nothing was written meanwhile: this process can carry on as the writer.
		if (!lockHolder(lock.path) && size(file) === openedSize && lock.tryAcquire()) {
			heldBy = undefined;
			ctx.ui.setStatus(LOCK_STATUS_KEY, undefined);
			return undefined;
		}
		const where = holderName(heldBy);
		return lockHolder(lock.path)
			? `This session is open in ${where}, so it is read-only here: only one can send a prompt at a time. Start a new session, or come back when it's closed there.`
			: `This session changed in ${where} after you opened it. Open it again to see the latest before you continue.`;
	};

	const runBusy = (ctx: ExtensionContext): string | undefined => {
		const r = runLockFor(ctx);
		if (r.held) return undefined;
		const owner = lockHolder(r.path);
		return owner ? `A run is in progress in ${holderName(owner)}. Gaffer runs one at a time here; try again when it has finished.` : undefined;
	};

	pi.on("session_start", async (_event, ctx) => {
		lock?.release();
		lock = undefined;
		heldBy = undefined;
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return; // an in-memory session
		lock = new FileLock(sessionLockPath(file), uiName(ctx));
		lock.onLost = () => {
			heldBy = { ui: "headless" };
			openedSize = Number.NaN; // never take it back without reopening
		};
		if (lock.tryAcquire()) {
			ctx.ui.setStatus(LOCK_STATUS_KEY, undefined);
			return;
		}
		heldBy = lockHolder(lock.path) ?? { ui: "headless" };
		openedSize = size(file);
		const where = holderName(heldBy);
		ctx.ui.setStatus(LOCK_STATUS_KEY, `read-only: open in ${where}`);
		ctx.ui.notify(`This session is open in ${where}, so it is read-only here: only one can send a prompt at a time.`, "warning");
	});

	pi.on("session_shutdown", async () => {
		lock?.release();
		lock = undefined;
		runLock?.release();
	});

	pi.on("input", async (event, ctx) => {
		const why = refusal(ctx);
		if (why) {
			ctx.ui.notify(why, "warning");
			return { action: "handled" };
		}
		if (event.streamingBehavior) return { action: "continue" }; // a steer or follow-up joins this process's run
		let busy = runBusy(ctx);
		const until = Date.now() + Number(process.env.GAFFER_RUN_LOCK_WAIT_MS ?? 0);
		while (busy && Date.now() < until) {
			await sleep(500);
			busy = runBusy(ctx);
		}
		if (busy) {
			ctx.ui.notify(busy, "warning");
			return { action: "handled" };
		}
		return { action: "continue" };
	});

	// The authoritative take: a run that loses a race for the lock stops before its first model call.
	pi.on("agent_start", async (_event, ctx) => {
		if (runLockFor(ctx).tryAcquire()) return;
		ctx.ui.notify(runBusy(ctx) ?? "Another run holds the sandbox. Try again when it has finished.", "error");
		ctx.abort();
	});

	pi.on("agent_settled", async () => {
		runLock?.release();
	});

	// An idle session open read-only must not write either: no cache-warming `usage` entries.
	pi.on("cache_warming_decision", async () => (heldBy ? { action: "stop" as const } : undefined));

	return { refusal, runBusy };
}
