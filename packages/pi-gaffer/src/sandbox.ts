/**
 * Sandbox access for Pi's built-in tools (ADR 0001): bash/read/write/edit operations that run in the
 * no-network sandbox through sandboxd, behind a SandboxProvider (compose now, ecs in phase 2).
 */
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

export interface SandboxHandle {
	url: string;
}

export interface SandboxProvider {
	provision(): Promise<SandboxHandle>;
	release(): Promise<void>;
}

/** Local Compose: the sandbox container is long-lived; provisioning waits for sandboxd, releasing clears /work. */
export class ComposeSandboxProvider implements SandboxProvider {
	private readonly url: string;
	private readonly timeoutMs: number;
	constructor(url: string, opts: { timeoutMs?: number } = {}) {
		this.url = url.replace(/\/$/, "");
		this.timeoutMs = opts.timeoutMs ?? 5000;
	}

	async provision(): Promise<SandboxHandle> {
		const until = Date.now() + this.timeoutMs;
		let last = "";
		while (Date.now() < until) {
			try {
				const r = await fetch(`${this.url}/healthz`, { signal: AbortSignal.timeout(1000) });
				if (r.ok) return { url: this.url };
				last = `HTTP ${r.status}`;
			} catch (e) {
				last = (e as Error).message;
			}
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error(`sandbox at ${this.url} not reachable (${last})`);
	}

	async release(): Promise<void> {
		await fetch(`${this.url}/reset`, { method: "POST" }).catch(() => undefined);
	}
}

export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxProvider {
	const kind = env.SANDBOX_PROVIDER ?? "compose";
	if (kind === "compose") return new ComposeSandboxProvider(env.SANDBOX_URL ?? "http://sandbox:8080");
	throw new Error(`SANDBOX_PROVIDER=${kind} is not implemented yet (ecs lands in ROADMAP phase 2)`);
}

/** One sandbox per Pi session: provisioned lazily on first use, released after idleMs without use. */
export class SandboxSession {
	private handle: Promise<SandboxHandle> | undefined;
	private idleTimer: NodeJS.Timeout | undefined;
	private readonly provider: SandboxProvider;
	private readonly idleMs: number;

	constructor(provider: SandboxProvider, opts: { idleMs?: number } = {}) {
		this.provider = provider;
		this.idleMs = opts.idleMs ?? 15 * 60_000;
	}

	async url(): Promise<string> {
		clearTimeout(this.idleTimer);
		this.handle ??= this.provider.provision().catch((e) => {
			this.handle = undefined; // try again next time (ARCHITECTURE §10: one re-provision attempt per call)
			throw e;
		});
		const { url } = await this.handle;
		this.idleTimer = setTimeout(() => void this.release(), this.idleMs);
		this.idleTimer.unref();
		return url;
	}

	async release(): Promise<void> {
		clearTimeout(this.idleTimer);
		if (!this.handle) return;
		this.handle = undefined;
		await this.provider.release();
	}
}

function fsError(status: number, path: string, detail: string): Error {
	const code = status === 404 ? "ENOENT" : status === 403 ? "EACCES" : status === 400 ? "EISDIR" : "EIO";
	return Object.assign(new Error(`${code}: ${detail || "sandbox error"}, ${path}`), { code });
}

export interface SandboxOperations {
	bash: {
		exec(command: string, cwd: string, options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv }): Promise<{ exitCode: number | null }>;
	};
	read: { readFile(p: string): Promise<Buffer>; access(p: string): Promise<void> };
	write: { writeFile(p: string, content: string): Promise<void>; mkdir(dir: string): Promise<void> };
	edit: { readFile(p: string): Promise<Buffer>; writeFile(p: string, content: string): Promise<void>; access(p: string): Promise<void> };
	isLocalRead(p: string): boolean;
}

export const MAX_EXEC_TIMEOUT_S = 120;

export function createSandboxOperations(session: SandboxSession, opts: { localReadRoots: string[] }): SandboxOperations {
	const roots = opts.localReadRoots.map((r) => resolve(r));
	const isLocalRead = (p: string) => {
		const abs = resolve(p);
		return roots.some((r) => abs === r || abs.startsWith(r + sep));
	};

	const readRemote = async (p: string): Promise<Buffer> => {
		const r = await fetch(`${await session.url()}/files?path=${encodeURIComponent(p)}`);
		if (!r.ok) throw fsError(r.status, p, await r.text());
		return Buffer.from(await r.arrayBuffer());
	};
	const writeRemote = async (p: string, content: string): Promise<void> => {
		const r = await fetch(`${await session.url()}/files?path=${encodeURIComponent(p)}`, { method: "PUT", body: content });
		if (!r.ok) throw fsError(r.status, p, await r.text());
	};
	const accessRemote = (mode: "r" | "rw") => async (p: string): Promise<void> => {
		const r = await fetch(`${await session.url()}/access?path=${encodeURIComponent(p)}&mode=${mode}`);
		if (!r.ok) throw fsError(r.status, p, await r.text());
	};

	return {
		isLocalRead,
		bash: {
			// The harness env (options.env: API keys, PI_* session vars) is deliberately never forwarded.
			async exec(command, cwd, { onData, signal, timeout }) {
				if (signal?.aborted) throw new Error("aborted");
				const timeout_s = Math.min(timeout ?? MAX_EXEC_TIMEOUT_S, MAX_EXEC_TIMEOUT_S);
				let res: Response;
				try {
					res = await fetch(`${await session.url()}/exec`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ command, cwd, timeout_s }),
						signal,
					});
				} catch (e) {
					if (signal?.aborted) throw new Error("aborted");
					throw e;
				}
				if (!res.ok || !res.body) throw new Error(`sandbox exec failed: HTTP ${res.status} ${await res.text()}`);
				let end: { exit?: number | null; timed_out?: boolean } | undefined;
				let buf = "";
				try {
					for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
						buf += Buffer.from(chunk).toString("utf8");
						let nl: number;
						while ((nl = buf.indexOf("\n")) >= 0) {
							const line = buf.slice(0, nl);
							buf = buf.slice(nl + 1);
							if (!line) continue;
							const msg = JSON.parse(line) as { data?: string; exit?: number | null; timed_out?: boolean };
							if (msg.data !== undefined) onData(Buffer.from(msg.data, "base64"));
							else end = msg;
						}
					}
				} catch (e) {
					if (signal?.aborted) throw new Error("aborted");
					throw e;
				}
				if (signal?.aborted) throw new Error("aborted");
				if (end?.timed_out) throw new Error(`timeout:${timeout ?? timeout_s}`);
				if (!end) throw new Error("sandbox exec ended without an exit status");
				return { exitCode: end.exit ?? null };
			},
		},
		read: {
			readFile: (p) => (isLocalRead(p) ? readFile(p) : readRemote(p)),
			access: (p) => (isLocalRead(p) ? readFile(p).then(() => undefined) : accessRemote("r")(p)),
		},
		write: {
			writeFile: writeRemote,
			// sandboxd creates parent directories on write.
			mkdir: async () => {},
		},
		edit: { readFile: readRemote, writeFile: writeRemote, access: accessRemote("rw") },
	};
}
