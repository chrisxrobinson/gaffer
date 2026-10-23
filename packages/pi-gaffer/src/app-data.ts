/**
 * What the Gaffer App shows before or outside a run (ADR 0014, "What Gaffer adds" 4), for `gaffer-web` and `/run`:
 * the next GW and its deadline, a team's name and squad, and the session list. Read-only: nothing here writes
 * a file; FPL is read through the same client and guard as fpl_snapshot.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type FplClient, FplNotFoundError } from "./http.ts";
import { isTestRow, type LedgerRow } from "./ledger.ts";
import { lockHolder, type LockOwner, sessionLockPath } from "./lock.ts";
import type { Recommendation } from "./schema/recommendation.ts";
import type * as S from "./schema/fpl.ts";
import type { RunEntry, SnapshotEntry, TeamEntry } from "./session.ts";
import type { SnapshotStore } from "./store.ts";
import { parseEntries, sessionUsage } from "./usage.ts";

/** A cached bootstrap older than this is fetched again, even before its next deadline. */
const BOOTSTRAP_MAX_AGE_MS = 6 * 3_600_000;

export interface GwInfo {
	current: number | null;
	next: number | null;
	deadline: string | null;
	season: string | null;
}

/**
 * FPL's bootstrap-static: the snapshot store's cached copy while it still names a future deadline and is under
 * six hours old, else a fresh fetch (not written to the store; fpl_snapshot does that on the next run).
 */
export async function fplBootstrap(store: SnapshotStore, client: FplClient, now: number, signal?: AbortSignal): Promise<S.Bootstrap> {
	const cached = store.lookup("bootstrap-static/");
	if (cached && now - cached.fetched_at < BOOTSTRAP_MAX_AGE_MS) {
		try {
			const b = store.read<S.Bootstrap>(cached.snapshot, "bootstrap-static");
			const next = b.events.find((e) => e.is_next);
			if (next && Date.parse(next.deadline_time) > now) return b;
		} catch {
			/* unreadable: fetch */
		}
	}
	return (await client.get<S.Bootstrap>("bootstrap-static/", { signal })).json;
}

export function gwInfo(b: S.Bootstrap): GwInfo {
	const cur = b.events.find((e) => e.is_current);
	const next = b.events.find((e) => e.is_next);
	const y = b.events.length ? new Date(b.events[0].deadline_time).getUTCFullYear() : Number.NaN;
	return { current: cur?.id ?? null, next: next?.id ?? null, deadline: next?.deadline_time ?? null, season: Number.isFinite(y) ? `${y}/${String((y + 1) % 100).padStart(2, "0")}` : null };
}

export type TeamCheck = { ok: true; name: string } | { ok: false; reason: "not_found" | "unreachable"; message: string };

/** FR-INP-01: does the team exist, and what is it called. */
export async function checkTeam(client: FplClient, teamId: number, signal?: AbortSignal): Promise<TeamCheck> {
	try {
		const r = await client.get<{ name?: string }>(`entry/${teamId}/`, { fresh: true, signal });
		return { ok: true, name: r.json.name ?? `Team ${teamId}` };
	} catch (e) {
		if (e instanceof FplNotFoundError) return { ok: false, reason: "not_found", message: `FPL team ${teamId} not found` };
		return { ok: false, reason: "unreachable", message: (e as Error).message };
	}
}

export interface SquadPlayer {
	id: number;
	name: string;
	team: string;
	position: string;
}

/** The team's 15 from its latest picks (the current GW's), for "players to keep"; [] before its first deadline. */
export async function teamSquad(client: FplClient, b: S.Bootstrap, teamId: number, signal?: AbortSignal): Promise<SquadPlayer[]> {
	const gw = gwInfo(b).current;
	if (!gw) return [];
	let picks: { element: number }[];
	try {
		picks = (await client.get<{ picks: { element: number }[] }>(`entry/${teamId}/event/${gw}/picks/`, { fresh: true, signal })).json.picks;
	} catch (e) {
		if (e instanceof FplNotFoundError) return [];
		throw e;
	}
	const elements = new Map(b.elements.map((e) => [e.id, e]));
	const teams = new Map(b.teams.map((t) => [t.id, t.short_name]));
	const pos = new Map(b.element_types.map((t) => [t.id, t.singular_name_short]));
	return picks.flatMap((p) => {
		const e = elements.get(p.element);
		return e ? [{ id: e.id, name: e.web_name, team: teams.get(e.team) ?? "?", position: pos.get(e.element_type) ?? "?" }] : [];
	});
}

/** Player names by id from a bootstrap; undefined for an id FPL doesn't know. */
export function playerNames(b: S.Bootstrap, ids: readonly number[]): ({ id: number; name: string } | undefined)[] {
	const byId = new Map(b.elements.map((e) => [e.id, e.web_name]));
	return ids.map((id) => (byId.has(id) ? { id, name: byId.get(id)! } : undefined));
}

export interface ListedPlayer extends SquadPlayer {
	price: number;
}

/** Every player in FPL's list, for the App's player pickers (what-if, explain): id, name, club, position, price. */
export function allPlayers(b: S.Bootstrap): ListedPlayer[] {
	const teams = new Map(b.teams.map((t) => [t.id, t.short_name]));
	const pos = new Map(b.element_types.map((t) => [t.id, t.singular_name_short]));
	return b.elements
		.map((e) => ({ id: e.id, name: e.web_name, team: teams.get(e.team) ?? "?", position: pos.get(e.element_type) ?? "?", price: e.now_cost / 10 }))
		.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

export interface ChipLeft {
	name: string;
	half: 1 | 2;
	window: [number, number];
	/** The deadline of the window's last GW: the chip can't be played after it. */
	expires: string | null;
	used_in: number | null;
	available: boolean;
}

/** The team's chips from its public history, as fpl_snapshot works them out (snapshot.ts), with each one's expiry. */
export async function teamChips(client: FplClient, b: S.Bootstrap, teamId: number, signal?: AbortSignal): Promise<ChipLeft[]> {
	let history: S.History | undefined;
	try {
		history = (await client.get<S.History>(`entry/${teamId}/history/`, { fresh: true, signal })).json;
	} catch (e) {
		if (!(e instanceof FplNotFoundError)) throw e;
	}
	const next = gwInfo(b).next;
	const deadline = new Map(b.events.map((e) => [e.id, e.deadline_time]));
	return b.chips.map((c) => {
		const used = history?.chips.find((h) => h.name === c.name && h.event >= c.start_event && h.event <= c.stop_event);
		const open = next !== null && next >= c.start_event && next <= c.stop_event;
		return { name: c.name, half: c.stop_event <= 19 ? 1 : 2, window: [c.start_event, c.stop_event], expires: deadline.get(c.stop_event) ?? null, used_in: used?.event ?? null, available: !used && open };
	});
}

/** The team's latest recommendation in the session store, or undefined. */
export function latestRecommendation(dir: string, teamId: number): Recommendation | undefined {
	const s = listSessions(dir).filter((x) => x.team?.id === teamId && x.rec).sort((a, b) => b.updated.localeCompare(a.updated))[0];
	if (!s) return undefined;
	const recs = (parseEntries(readFileSync(s.file, "utf8")) as RawEntry[]).filter((e) => e.type === "custom" && e.customType === "gaffer.recommendation");
	return recs.at(-1)?.data as Recommendation | undefined;
}

/** Where a player stands in a recommendation, in words: "the captain", "a new signing", "on the bench", "not in it". */
export function roleIn(rec: Recommendation, id: number): string {
	if (rec.captain.id === id) return "the captain";
	if (rec.vice_captain.id === id) return "the vice-captain";
	if (rec.transfers.some((t) => t.in.id === id)) return "a new signing";
	if (rec.transfers.some((t) => t.out.id === id)) return "sold";
	if (rec.starting_xi.includes(id)) return "in the starting XI";
	if (rec.bench.includes(id)) return "on the bench";
	return "not in it";
}

export interface WaitingGw {
	gw: number;
	recommendations: number;
	/** "after its last match, once FPL checks the data (before the GW9 deadline, …)", "waiting for FPL's data check", … */
	when: string;
	/** The deadline of the GW after, before which FPL has always checked the data. */
	by: string | null;
}

/**
 * The team's real ledgered recommendations that outcomes.jsonl has no row for yet, by GW (the Scorecard's
 * "waiting" list, FR-EVL-04), with when gaffer-eval can score them, from the bootstrap's events.
 */
export function waitingGws(ledger: readonly LedgerRow[], outcomes: readonly { rec_id: string }[], teamHash: string, b: S.Bootstrap | undefined): WaitingGw[] {
	const scored = new Set(outcomes.map((o) => o.rec_id));
	const byGw = new Map<number, number>();
	for (const r of ledger) if (r.team_id_hash === teamHash && !isTestRow(r) && !scored.has(r.rec_id)) byGw.set(r.gw, (byGw.get(r.gw) ?? 0) + 1);
	return [...byGw.entries()].sort((a, b) => a[0] - b[0]).map(([gw, n]) => {
		const ev = b?.events.find((e) => e.id === gw);
		const by = b?.events.find((e) => e.id === gw + 1)?.deadline_time ?? null;
		const when = !ev ? "once FPL marks it finished and checked"
			: ev.data_checked ? "at gaffer-eval's next run (FPL has checked the data)"
			: ev.finished ? "once FPL checks the data (usually within a day of the last match)"
			: `after its last match, once FPL checks the data${by ? ` (before the GW${gw + 1} deadline)` : ""}`;
		return { gw, recommendations: n, when, by };
	});
}

/** A `gaffer.run`'s title: what both UIs list the session as until it is renamed (docs/ui §4). */
export function runTitle(run: Pick<RunEntry, "action" | "gw" | "options">): string {
	const o = run.options as Record<string, any>;
	const chip = (c: string) => ({ wildcard: "Wildcard", freehit: "Free Hit", bboost: "Bench Boost", "3xc": "Triple Captain" })[c] ?? c;
	switch (run.action) {
		case "whatif":
			return o.kind === "transfer" ? `What-if: ${o.out.name} → ${o.in.name}` : o.kind === "chip" ? `What-if: ${chip(o.chip)} in GW${o.gw}` : `What-if: keep ${o.player.name}`;
		case "explain":
			return `Explain ${o.player.name}`;
		case "chips":
			return `Chip planner GW${o.from_gw}–GW${o.to_gw}`;
		case "preferences":
			return "Preferences";
		default:
			return `Recommend GW${run.gw ?? "?"}`;
	}
}

export interface SessionSummary {
	id: string;
	file: string;
	name: string | null;
	started: string | null;
	updated: string;
	team: { id: number; name: string | null } | null;
	gw: number | null;
	action: string | null;
	/** The latest gaffer.run's title ("What-if: keep Watkins"); the rail shows it unless the session has a name. */
	title: string | null;
	/** "done": a recommendation; "failed": the gate gave up; "answer": a run with no recommendation asked of it. */
	outcome: "done" | "failed" | "answer" | "empty";
	rec: { rec_id: string; gw: number } | null;
	cost: number;
	/** The latest snapshot's free transfers for the team, to pre-fill the next run's FT box. */
	ft: { value: number | null; source: string | null; gw: number | null } | null;
	lock: Pick<LockOwner, "ui" | "pid"> | null;
}

interface RawEntry {
	type: string;
	id?: string;
	cwd?: string;
	timestamp?: string;
	customType?: string;
	data?: unknown;
	name?: string;
	message?: { role?: string };
}

const summaries = new Map<string, { key: string; summary: Omit<SessionSummary, "lock"> }>();

/** One session file, summarised for the App's rail; cached by size and mtime. */
export function summariseSession(file: string): Omit<SessionSummary, "lock"> | undefined {
	let st: ReturnType<typeof statSync>;
	try {
		st = statSync(file);
	} catch {
		return undefined;
	}
	const key = `${st.size}:${st.mtimeMs}`;
	const hit = summaries.get(file);
	if (hit?.key === key) return hit.summary;
	const entries = parseEntries(readFileSync(file, "utf8")) as RawEntry[];
	const header = entries[0]?.type === "session" ? entries[0] : undefined;
	if (!header?.id) return undefined;
	const custom = <T>(t: string) => entries.filter((e) => e.type === "custom" && e.customType === t).map((e) => e.data as T);
	const team = custom<TeamEntry>("gaffer.team").at(-1);
	const snap = custom<SnapshotEntry>("gaffer.snapshot").at(-1);
	const run = custom<RunEntry>("gaffer.run").at(-1);
	const rec = custom<Recommendation>("gaffer.recommendation").at(-1);
	const failed = custom<{ passed: boolean; attempt: number }>("gaffer.validation").some((v) => !v.passed && v.attempt >= 3);
	const teamId = team?.team_id ?? snap?.team_id ?? run?.team_id;
	const summary: Omit<SessionSummary, "lock"> = {
		id: header.id,
		file,
		name: entries.filter((e) => e.type === "session_info").at(-1)?.name ?? null,
		started: header.timestamp ?? null,
		updated: new Date(st.mtimeMs).toISOString(),
		team: teamId ? { id: teamId, name: team?.team_name ?? snap?.team_name ?? null } : null,
		gw: rec?.gw ?? run?.gw ?? snap?.gw.next ?? null,
		action: run?.action ?? null,
		title: run ? (run.title ?? runTitle(run)) : null,
		outcome: rec ? "done" : failed ? "failed" : entries.some((e) => e.message?.role === "user") ? "answer" : "empty",
		rec: rec ? { rec_id: rec.rec_id, gw: rec.gw } : null,
		cost: Math.round(sessionUsage(entries as never, file).cost * 1e6) / 1e6,
		ft: snap ? { value: snap.free_transfers ?? null, source: snap.ft_source ?? null, gw: snap.gw.next } : null,
	};
	summaries.set(file, { key, summary });
	return summary;
}

/**
 * The sessions both UIs share (FR-UI-12): Pi's session files directly in `dir` whose header cwd is `cwd`, as Pi's
 * own /resume lists them, newest first, each with its lock holder if one is live.
 */
export function listSessions(dir: string, cwd = "/work"): SessionSummary[] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return [];
	}
	const out: SessionSummary[] = [];
	for (const n of names) {
		const file = join(dir, n);
		const s = summariseSession(file);
		if (!s || !headerCwdIs(file, cwd)) continue;
		const owner = lockHolder(sessionLockPath(file));
		out.push({ ...s, lock: owner ? { ui: owner.ui, pid: owner.pid } : null });
	}
	return out.sort((a, b) => b.updated.localeCompare(a.updated));
}

function headerCwdIs(file: string, cwd: string): boolean {
	try {
		const first = readFileSync(file, "utf8").split("\n", 1)[0];
		return (JSON.parse(first) as RawEntry).cwd === cwd;
	} catch {
		return false;
	}
}

/**
 * The newest session in `dir` that no live process holds, as Pi's `--continue` would pick it but skipping
 * sessions another UI has open (NFR-REL-03); undefined when there is none.
 */
export function newestFreeSession(dir: string, cwd = "/work"): string | undefined {
	let names: string[];
	try {
		names = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return undefined;
	}
	const files = names.map((n) => join(dir, n)).map((f) => ({ f, m: mtime(f) })).sort((a, b) => b.m - a.m);
	return files.find(({ f }) => headerCwdIs(f, cwd) && !lockHolder(sessionLockPath(f)))?.f;
}

function mtime(f: string): number {
	try {
		return statSync(f).mtimeMs;
	} catch {
		return 0;
	}
}
