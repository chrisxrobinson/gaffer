/**
 * The odds source (ADR 0002, FR-DAT-09): football-data.co.uk, the one supplementary data source.
 * - `fixtures.csv`: bookmaker 1X2 and over/under 2.5 prices for the next round of matches.
 * - `mmz4281/<season>/E0.csv`: Premier League results for the previous and current season, which
 *   gaffer_lib's Dixon-Coles model is fitted on (the FPL API serves the current season only).
 *
 * The sandbox has no network, so fpl_snapshot fetches these in the harness and writes `odds.json`
 * into the snapshot. Only Premier League rows and the columns Gaffer uses are kept. The source's
 * terms are unconfirmed (NFR-SEC-06): requests are GET-only to this one host, rate-limited, cached
 * in the snapshot store and never republished. When the source is down the snapshot still
 * completes: gaffer_lib then falls back to Dixon-Coles alone and says so.
 */
import { checkOddsRequest } from "./guard.ts";
import { backoffDelayMs, type RateLimiter, sharedLimiter, USER_AGENT } from "./http.ts";
import type { EndpointHealth } from "./snapshot.ts";
import type { SnapshotStore } from "./store.ts";

export const FOOTBALL_DATA_BASE_URL = "https://football-data.co.uk/";
export const ODDS_MAX_TRIES = 3;
const HOUR = 3_600_000;
/** fixtures.csv follows the fixtures TTL (ADR 0002): 6 h, and 30 min inside the deadline window. */
export const ODDS_TTL_MS = { fixtures: 6 * HOUR, fixturesInWindow: HOUR / 2, currentSeason: 24 * HOUR, previousSeason: 30 * 24 * HOUR };
/** A cached fixtures.csv older than this is not used as a fallback: its prices describe an earlier round. */
export const ODDS_FALLBACK_MAX_AGE_MS = 48 * HOUR;

/** The price columns gaffer_lib.strength reads: the market average first, then Bet365. */
export const ODDS_COLUMNS = ["AvgH", "AvgD", "AvgA", "Avg>2.5", "Avg<2.5", "B365H", "B365D", "B365A", "B365>2.5", "B365<2.5"] as const;

export interface OddsFixture {
	date: string;
	time: string | null;
	home: string;
	away: string;
	odds: Record<string, number>;
}
export interface OddsResult {
	date: string;
	time: string | null;
	home: string;
	away: string;
	hg: number;
	ag: number;
	hxg: number | null;
	axg: number | null;
}
export interface OddsFile {
	schema: "gaffer.odds/1";
	source: "football-data.co.uk";
	/** Whether next-round odds could be fetched (or served from a recent cache). */
	available: boolean;
	reason: string | null;
	fixtures: OddsFixture[];
	/** Season ("2025-26") → finished Premier League matches. */
	results: Record<string, OddsResult[]>;
}

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF. Returns rows keyed by the header. */
export function parseCsv(text: string): Record<string, string>[] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	const src = text.replace(/^﻿/, "");
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (quoted) {
			if (c === '"' && src[i + 1] === '"') {
				field += '"';
				i++;
			} else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"') quoted = true;
		else if (c === ",") {
			row.push(field);
			field = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && src[i + 1] === "\n") i++;
			row.push(field);
			field = "";
			if (row.some((x) => x !== "")) rows.push(row);
			row = [];
		} else field += c;
	}
	row.push(field);
	if (row.some((x) => x !== "")) rows.push(row);
	const header = rows.shift();
	if (!header) return [];
	return rows.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

const num = (v: string | undefined): number | null => {
	if (v === undefined || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

/** Premier League rows of fixtures.csv with the price columns Gaffer uses. */
export function parseOddsFixtures(csv: string): OddsFixture[] {
	const rows = parseCsv(csv);
	if (rows.length && !("Div" in rows[0] && "HomeTeam" in rows[0] && "AwayTeam" in rows[0])) throw new Error("fixtures.csv has no Div/HomeTeam/AwayTeam columns");
	return rows
		.filter((r) => r.Div === "E0" && r.HomeTeam && r.AwayTeam)
		.map((r) => {
			const odds: Record<string, number> = {};
			for (const k of ODDS_COLUMNS) {
				const v = num(r[k]);
				if (v !== null && v > 1) odds[k] = v;
			}
			return { date: r.Date, time: r.Time || null, home: r.HomeTeam, away: r.AwayTeam, odds };
		});
}

/** Finished Premier League matches of a season file: the score, and match xG where the file has it. */
export function parseResults(csv: string): OddsResult[] {
	const rows = parseCsv(csv);
	if (rows.length && !("FTHG" in rows[0] && "HomeTeam" in rows[0])) throw new Error("season file has no FTHG/HomeTeam columns");
	const out: OddsResult[] = [];
	for (const r of rows) {
		const hg = num(r.FTHG);
		const ag = num(r.FTAG);
		if (r.Div !== "E0" || !r.HomeTeam || !r.AwayTeam || hg === null || ag === null) continue;
		out.push({ date: r.Date, time: r.Time || null, home: r.HomeTeam, away: r.AwayTeam, hg, ag, hxg: num(r.HxG), axg: num(r.AxG) });
	}
	return out;
}

/** football-data.co.uk's season directory: "2026-27" → "2627". */
export function seasonCode(season: string): string {
	return season.slice(2, 4) + season.slice(5, 7);
}

export function previousSeason(season: string): string {
	const y = Number(season.slice(0, 4)) - 1;
	return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

export interface OddsDeps {
	store: SnapshotStore;
	now: () => number;
	baseUrl?: string;
	fetch?: typeof fetch;
	limiter?: RateLimiter;
	random?: () => number;
	timeoutMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

type Part = { text: string; health: EndpointHealth } | { error: string; health: EndpointHealth };

async function getCsv(path: string, deps: OddsDeps, signal?: AbortSignal): Promise<Part> {
	const base = deps.baseUrl ?? process.env.FOOTBALL_DATA_BASE_URL ?? FOOTBALL_DATA_BASE_URL;
	const guard = checkOddsRequest("GET", `${base}${path}`);
	const label = `football-data:${path}`;
	const started = Date.now();
	const health = (status: number | null, retries: number, error?: string): EndpointHealth => ({
		path: label, status, latency_ms: Date.now() - started, retries, age: null, cache_busted: false, from_cache: false, fetched_at: new Date(deps.now()).toISOString(), ...(error ? { error } : {}),
	});
	if (!guard.ok) return { error: guard.reason, health: health(null, 0, guard.reason) };
	const limiter = deps.limiter ?? sharedLimiter();
	const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	let last = "no attempt";
	let status: number | null = null;
	for (let attempt = 1; attempt <= ODDS_MAX_TRIES; attempt++) {
		if (attempt > 1) await sleep(backoffDelayMs(attempt - 2, deps.random));
		await limiter.acquire();
		try {
			const timeout = AbortSignal.timeout(deps.timeoutMs ?? 15_000);
			// redirect: "error" keeps every request on the one allowlisted host.
			const res = await (deps.fetch ?? fetch)(`${base}${path}`, { headers: { "user-agent": USER_AGENT, accept: "text/csv" }, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
			status = res.status;
			if (res.status === 404) {
				await res.body?.cancel();
				return { error: "HTTP 404", health: health(404, attempt - 1, "HTTP 404") };
			}
			if (res.status !== 200) {
				await res.body?.cancel();
				last = `HTTP ${res.status}`;
				continue;
			}
			const text = await res.text();
			if (!/^﻿?Div,/.test(text)) {
				last = `not a football-data CSV (${res.headers.get("content-type")})`;
				continue;
			}
			return { text, health: health(200, attempt - 1) };
		} catch (e) {
			if (signal?.aborted) throw e;
			last = (e as Error).message;
		}
	}
	return { error: last, health: health(status, ODDS_MAX_TRIES - 1, last) };
}

export interface OddsRequest {
	/** FPL season directory, e.g. "2026-27". */
	season: string;
	/** Next deadline, ms since epoch: fixtures.csv is refreshed more often inside T−6h. */
	deadline?: number;
	forceFresh?: boolean;
	signal?: AbortSignal;
}

/**
 * Build `odds.json`, fetching what is not cached. Each part (next-round odds, each season's results)
 * is cached on its own under an index key; a part that can't be fetched falls back to its cached
 * copy, and `available` says whether next-round odds are usable.
 */
export async function fetchOdds(req: OddsRequest, deps: OddsDeps): Promise<{ file: OddsFile; endpoints: EndpointHealth[]; fresh: string[]; warnings: string[] }> {
	const now = deps.now();
	const endpoints: EndpointHealth[] = [];
	const warnings: string[] = [];
	const fresh: string[] = [];
	const inWindow = req.deadline !== undefined && now >= req.deadline - 6 * HOUR && now < req.deadline;
	const cachedFile = (key: string): { file: OddsFile; fetched_at: number } | undefined => {
		const hit = deps.store.lookup(key);
		if (!hit) return undefined;
		try {
			return { file: deps.store.read<OddsFile>(hit.snapshot, "odds"), fetched_at: hit.fetched_at };
		} catch {
			return undefined;
		}
	};
	const fromCache = (path: string, fetchedAt: number, error?: string) =>
		endpoints.push({ path: `football-data:${path}`, status: null, latency_ms: 0, retries: 0, age: null, cache_busted: false, from_cache: true, fetched_at: new Date(fetchedAt).toISOString(), ...(error ? { error } : {}) });

	// Next-round odds.
	let fixtures: OddsFixture[] = [];
	let available = false;
	let reason: string | null = null;
	const fxPath = "fixtures.csv";
	const fxKey = `football-data:${fxPath}`;
	const fxCached = cachedFile(fxKey);
	const fxTtl = inWindow ? ODDS_TTL_MS.fixturesInWindow : ODDS_TTL_MS.fixtures;
	if (fxCached?.file.available && !req.forceFresh && now - fxCached.fetched_at < fxTtl) {
		fixtures = fxCached.file.fixtures;
		available = true;
		fromCache(fxPath, fxCached.fetched_at);
	} else {
		const part = await getCsv(fxPath, deps, req.signal);
		let parsed: OddsFixture[] | undefined;
		let error = "error" in part ? part.error : undefined;
		if ("text" in part) {
			try {
				parsed = parseOddsFixtures(part.text);
			} catch (e) {
				error = (e as Error).message;
			}
		}
		if (parsed) {
			endpoints.push(part.health);
			fixtures = parsed;
			available = true;
			fresh.push(fxKey);
		} else if (fxCached?.file.available && now - fxCached.fetched_at < ODDS_FALLBACK_MAX_AGE_MS) {
			fixtures = fxCached.file.fixtures;
			available = true;
			fromCache(fxPath, fxCached.fetched_at, error);
			warnings.push(`football-data.co.uk could not be reached (${error}); using odds fetched ${new Date(fxCached.fetched_at).toISOString()}.`);
		} else {
			endpoints.push({ ...part.health, error });
			reason = `football-data.co.uk unavailable: ${error}`;
		}
	}

	// Results: the previous season (static) and the current one.
	const results: Record<string, OddsResult[]> = {};
	for (const [season, ttl] of [[previousSeason(req.season), ODDS_TTL_MS.previousSeason], [req.season, ODDS_TTL_MS.currentSeason]] as const) {
		const path = `mmz4281/${seasonCode(season)}/E0.csv`;
		const key = `football-data:${path}`;
		const cached = cachedFile(key);
		const cachedRows = cached?.file.results?.[season];
		if (cached && cachedRows && !req.forceFresh && now - cached.fetched_at < ttl) {
			results[season] = cachedRows;
			fromCache(path, cached.fetched_at);
			continue;
		}
		const part = await getCsv(path, deps, req.signal);
		let parsed: OddsResult[] | undefined;
		let error = "error" in part ? part.error : undefined;
		if ("text" in part) {
			try {
				parsed = parseResults(part.text);
			} catch (e) {
				error = (e as Error).message;
			}
		}
		if (parsed) {
			endpoints.push(part.health);
			results[season] = parsed;
			fresh.push(key);
		} else if (cached && cachedRows) {
			results[season] = cachedRows;
			fromCache(path, cached.fetched_at, error);
		} else {
			endpoints.push({ ...part.health, error });
		}
	}

	if (!available) warnings.push(`Odds unavailable (${reason}): the golden path will take team strength from Dixon-Coles alone.`);
	return {
		// No fetch time in the file: identical upstream data must give an identical snapshot hash (FR-DAT-07).
		file: { schema: "gaffer.odds/1", source: "football-data.co.uk", available, reason, fixtures, results },
		endpoints,
		fresh,
		warnings,
	};
}
