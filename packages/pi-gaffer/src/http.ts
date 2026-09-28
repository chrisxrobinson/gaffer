/**
 * FPL HTTP client (ADR 0002): GET-only allowlist, per-user cache-busting with a CDN-age check,
 * exponential backoff with full jitter, a process-wide 2 req/s limiter and at most 8 requests in flight.
 */
import { checkFplRequest } from "./guard.ts";

export const FPL_BASE_URL = "https://fantasy.premierleague.com/api/";
export const USER_AGENT = "Gaffer/0.1 (personal non-commercial FPL advisor; read-only)";
export const MAX_TRIES = 4;
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 8000;
/** A per-user response older than this (CDN `age` header) is rejected (FR-DAT-02). */
export const MAX_USER_AGE_S = 60;
export const MAX_IN_FLIGHT = 8;

/** Full-jitter delay before retry n (0-based): uniform in [0, min(cap, base·2^n)]. */
export function backoffDelayMs(n: number, random: () => number = Math.random): number {
	return random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** n);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serialises request starts so they are at least 1/rate seconds apart. */
export class RateLimiter {
	private next = 0;
	private readonly perSecond: number;
	constructor(perSecond: number) {
		this.perSecond = perSecond;
	}
	async acquire(): Promise<void> {
		const now = Date.now();
		const slot = Math.max(now, this.next);
		this.next = slot + 1000 / this.perSecond;
		if (slot > now) await sleep(slot - now);
	}
}

class Semaphore {
	private waiting: (() => void)[] = [];
	private active = 0;
	private readonly max: number;
	constructor(max: number) {
		this.max = max;
	}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
		this.active++;
		try {
			return await fn();
		} finally {
			this.active--;
			this.waiting.shift()?.();
		}
	}
}

/** Process-wide limiter and concurrency cap. Pi loads each extension with its own module cache, so share via globalThis. */
function shared<T>(key: string, make: () => T): T {
	const g = globalThis as unknown as Record<symbol, T>;
	const sym = Symbol.for(key);
	return (g[sym] ??= make());
}
export const sharedLimiter = () => shared("gaffer.fpl.limiter", () => new RateLimiter(2));
const sharedSemaphore = () => shared("gaffer.fpl.semaphore", () => new Semaphore(MAX_IN_FLIGHT));

export type UnavailableReason = "fpl_updating" | "cdn_stale" | "network" | "rate_limited";

export class FplUnavailableError extends Error {
	override name = "FplUnavailableError";
	readonly reason: UnavailableReason;
	readonly attempts: number;
	constructor(message: string, reason: UnavailableReason, attempts: number) {
		super(message);
		this.reason = reason;
		this.attempts = attempts;
	}
}
export class FplNotFoundError extends Error {
	override name = "FplNotFoundError";
}
export class FplGuardError extends Error {
	override name = "FplGuardError";
}

export interface FplResponse<T = unknown> {
	path: string;
	url: string;
	status: number;
	json: T;
	/** CDN `age` header in seconds, if present. */
	age: number | undefined;
	latencyMs: number;
	attempts: number;
	retries: number;
	fetchedAt: string;
}

export interface FplClientOptions {
	baseUrl?: string;
	limiter?: RateLimiter;
	random?: () => number;
	fetch?: typeof fetch;
	onBackoff?: (ms: number, attempt: number) => void;
	timeoutMs?: number;
}

type Attempt =
	| { kind: "ok"; status: number; json: unknown; age: number | undefined; url: string }
	| { kind: "retry"; reason: UnavailableReason; detail: string }
	| { kind: "fatal"; error: Error };

export class FplClient {
	private readonly baseUrl: string;
	private readonly limiter: RateLimiter;
	private readonly random: () => number;
	private readonly fetchImpl: typeof fetch;
	private readonly semaphore = sharedSemaphore();
	private readonly opts: FplClientOptions;

	constructor(opts: FplClientOptions = {}) {
		this.opts = opts;
		this.baseUrl = opts.baseUrl ?? process.env.FPL_BASE_URL ?? FPL_BASE_URL;
		this.limiter = opts.limiter ?? sharedLimiter();
		this.random = opts.random ?? Math.random;
		this.fetchImpl = opts.fetch ?? fetch;
	}

	get<T = unknown>(path: string, options: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<FplResponse<T>> {
		return this.request<T>("GET", path, options);
	}

	async request<T = unknown>(method: string, path: string, options: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<FplResponse<T>> {
		const guard = checkFplRequest(method, path);
		if (!guard.ok) throw new FplGuardError(guard.reason);
		const started = Date.now();
		let last: Extract<Attempt, { kind: "retry" }> | undefined;
		for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
			if (attempt > 1) {
				const ms = backoffDelayMs(attempt - 2, this.random);
				this.opts.onBackoff?.(ms, attempt - 1);
				await sleep(ms);
			}
			const r = await this.semaphore.run(async () => {
				await this.limiter.acquire();
				return this.attempt(path, !!options.fresh, options.signal);
			});
			if (r.kind === "ok") {
				return {
					path,
					url: r.url,
					status: r.status,
					json: r.json as T,
					age: r.age,
					latencyMs: Date.now() - started,
					attempts: attempt,
					retries: attempt - 1,
					fetchedAt: new Date().toISOString(),
				};
			}
			if (r.kind === "fatal") throw r.error;
			last = r;
		}
		throw new FplUnavailableError(`FPL ${path} unavailable after ${MAX_TRIES} tries: ${last?.detail}`, last?.reason ?? "network", MAX_TRIES);
	}

	private async attempt(path: string, fresh: boolean, signal?: AbortSignal): Promise<Attempt> {
		// A unique query parameter makes the CDN go to origin (per-user data is otherwise served days stale).
		const url = `${this.baseUrl}${path}${fresh ? `?_=${Date.now()}${Math.floor(this.random() * 1e6)}` : ""}`;
		let res: Response;
		try {
			res = await this.fetchImpl(url, {
				headers: { "user-agent": USER_AGENT, accept: "application/json" },
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.opts.timeoutMs ?? 20_000)]) : AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
			});
		} catch (e) {
			if (signal?.aborted) return { kind: "fatal", error: e as Error };
			return { kind: "retry", reason: "network", detail: (e as Error).message };
		}
		const ageHeader = res.headers.get("age");
		const age = ageHeader === null ? undefined : Number(ageHeader);
		if (res.status === 404) {
			await res.body?.cancel();
			return { kind: "fatal", error: new FplNotFoundError(`FPL ${path} not found (404)`) };
		}
		if (res.status === 429) {
			await res.body?.cancel();
			return { kind: "retry", reason: "rate_limited", detail: "HTTP 429" };
		}
		if (res.status >= 500) {
			await res.body?.cancel();
			return { kind: "retry", reason: "fpl_updating", detail: `HTTP ${res.status}` };
		}
		if (res.status !== 200) {
			await res.body?.cancel();
			return { kind: "fatal", error: new Error(`FPL ${path} returned HTTP ${res.status}`) };
		}
		const text = await res.text();
		let json: unknown;
		try {
			if (!(res.headers.get("content-type") ?? "").includes("json")) throw new Error("not JSON");
			json = JSON.parse(text);
		} catch {
			// The FPL site serves an HTML "the game is being updated" page during updates.
			return { kind: "retry", reason: "fpl_updating", detail: `non-JSON body (${res.headers.get("content-type")})` };
		}
		if (fresh && age !== undefined && age > MAX_USER_AGE_S) {
			return { kind: "retry", reason: "cdn_stale", detail: `per-user data served from CDN cache with age ${age} s (max ${MAX_USER_AGE_S})` };
		}
		return { kind: "ok", status: res.status, json, age, url };
	}
}
