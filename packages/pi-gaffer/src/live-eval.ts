/**
 * gaffer-eval, live tracking (FR-EVL-03, ARCHITECTURE §6.4): once FPL marks a GW's data as checked,
 * score every real ledgered recommendation for it and write `/data/ledger/outcomes.jsonl`.
 *
 * For each recommendation: (a) the recommended XI, captain and chip after auto-subs, minus its hits;
 * (b) the user's actual points, from the public entry endpoints, and the same recomputed from their
 * picks as a check; (c) B0 and B1 from the same pre-deadline squad; (d) Gaffer's xP vs the official
 * ep_next against the points. All arithmetic is `python -m gaffer_lib score` in the sandbox, on the
 * snapshot the recommendation was made on.
 *
 * Idempotent and rebuildable: a recommendation already scored is skipped (unless `rebuild`), an
 * unscorable one is retried, and the file is rewritten whole, sorted, with no timestamps of its own,
 * so the same inputs give the same bytes. A one-shot command: whatever runs it (cron, a compose
 * service, a scheduled `docker compose run`) only has to call it after `data_checked`.
 *
 * No Pi or TypeBox imports: plain `node` runs this (tools/gaffer-eval/main.ts).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gafferLibCommand } from "./derive.ts";
import type { FplClient } from "./http.ts";
import { isTestRow, type LedgerRow, readLedger } from "./ledger.ts";
import { OUTCOME_SCHEMA, type OutcomeRow, outcomesPath, readOutcomes, type Scored } from "./outcomes.ts";
import { findRun } from "./replay.ts";
import { lastJsonLine, type SandboxSession, sandboxRun, shellQuote } from "./sandbox.ts";
import { hashTeamId } from "./team-hash.ts";
import { parseEntries } from "./usage.ts";

export interface TrackDeps {
	dataDir: string;
	sessionsDir: string;
	salt: string;
	client: FplClient;
	sandbox: SandboxSession;
	log?: (line: string) => void;
}

export interface TrackOptions {
	/** Only this GW. */
	gw?: number;
	/** Rescore everything from scratch. */
	rebuild?: boolean;
}

export interface TrackSummary {
	finished: number[];
	scored: { rec_id: string; gw: number; status: OutcomeRow["status"]; reason?: string }[];
	skippedTest: number;
	alreadyScored: number;
	waiting: { gw: number; recommendations: number }[];
	rows: number;
}

/** What a recommendation needs to be scored, from its session (or its export). */
interface Found {
	rec: Record<string, any>;
	snapshotPath: string;
	ft: number | null;
	pending: [number, number][];
	teamId: number | null;
}

function fromSessionFile(file: string, recId: string): Found | undefined {
	if (!existsSync(file)) return undefined;
	const entries = parseEntries(readFileSync(file, "utf8"));
	const data = (type: string) => entries.filter((e) => e.type === "custom" && e.customType === type).map((e) => e.data as Record<string, any>);
	const rec = data("gaffer.recommendation").find((d) => d.rec_id === recId);
	if (!rec) return undefined;
	const v = data("gaffer.validation").find((d) => d.rec_id === recId && d.passed === true);
	const snap = data("gaffer.snapshot").filter((d) => d.snapshot_id === rec.snapshot?.id).at(-1);
	return { rec, snapshotPath: v?.snapshot_path ?? snap?.snapshot_path ?? "", ft: v?.ft ?? null, pending: v?.pending ?? [], teamId: typeof snap?.team_id === "number" ? snap.team_id : null };
}

function locate(row: LedgerRow, deps: TrackDeps): Found | undefined {
	const found = (row.session_file && fromSessionFile(row.session_file, row.rec_id)) || undefined;
	if (found) return found;
	const run = existsSync(deps.sessionsDir) ? findRun(deps.sessionsDir, row.rec_id) : undefined;
	if (run) return fromSessionFile(run.file, row.rec_id);
	const exp = join(deps.dataDir, "exports", `${row.rec_id}.json`);
	if (!existsSync(exp)) return undefined;
	const rec = JSON.parse(readFileSync(exp, "utf8"));
	const a = rec.assumptions ?? {};
	return { rec, snapshotPath: "", ft: a.ft_source === "user" ? a.free_transfers : null, pending: a.pending_transfers ?? [], teamId: null };
}

const scored = (s: Record<string, any>): Scored => ({ points: s.points, gross: s.gross, hit_cost: s.hit_cost, chip: s.chip ?? null, armband: s.armband ?? null, autosubs: s.autosubs ?? [] });

async function scoreOne(row: LedgerRow, live: unknown, liveSha: string, deps: TrackDeps): Promise<OutcomeRow> {
	const base = {
		schema: OUTCOME_SCHEMA, rec_id: row.rec_id, team_id_hash: row.team_id_hash, season: row.season, gw: row.gw, deadline: row.deadline,
		created_at: row.created_at, model: row.model, snapshot_id: row.snapshot_id, counted: false,
	} as const;
	const unscorable = (reason: string): OutcomeRow => ({ ...base, status: "unscorable", reason, gaffer_lib: "" });
	const found = locate(row, deps);
	if (!found) return unscorable("the recommendation is in neither the session logs nor /data/exports");
	const snapshotPath = found.snapshotPath || join(deps.dataDir, "snapshots", row.snapshot_id);
	if (!existsSync(join(snapshotPath, "bootstrap-static.json"))) return unscorable(`its snapshot ${row.snapshot_id} is missing`);
	let teamId = found.teamId;
	if (teamId === null) {
		try {
			teamId = Number(JSON.parse(readFileSync(join(snapshotPath, "entry.json"), "utf8")).id) || null;
		} catch {
			teamId = null;
		}
	}
	if (teamId === null || hashTeamId(teamId, deps.salt) !== row.team_id_hash) return unscorable("the team id for the recommendation's hash could not be found");

	// (b) The user's actual GW, from the public entry endpoints (fresh: per-user data is cached on the CDN).
	let picks: unknown = null;
	try {
		picks = (await deps.client.get(`entry/${teamId}/event/${row.gw}/picks/`, { fresh: true })).json;
	} catch (e) {
		deps.log?.(`  ${row.rec_id}: the user's GW${row.gw} picks could not be fetched (${(e as Error).message.split("\n")[0]})`);
	}

	const rec = found.rec;
	const lineups: Record<string, unknown> = {
		recommended: { xi: rec.starting_xi, bench: rec.bench, captain: rec.captain.id, vice_captain: rec.vice_captain.id, chip: rec.chip?.play ?? null, hit_cost: rec.hit_cost ?? 0 },
	};
	if (picks) lineups.actual = { picks };
	const xp = Object.fromEntries(Object.entries((rec.players ?? {}) as Record<string, { xp: number }>).map(([k, v]) => [k, v.xp]));
	const request = { gw: row.gw, live, lineups, baselines: true, ft: found.ft, pending: found.pending.length ? found.pending : null, xp };
	const { exitCode, output } = await sandboxRun(deps.sandbox, `${gafferLibCommand()} score --snapshot ${shellQuote(snapshotPath)} --request -`, { timeoutS: 110, stdin: JSON.stringify(request) });
	const doc = lastJsonLine(output) as Record<string, any> | undefined;
	if (!doc || doc.error || !doc.lineups?.recommended) return unscorable(`gaffer_lib score failed (exit ${exitCode}): ${doc?.error ?? output.trim().slice(-200)}`);
	const a = doc.lineups.actual;
	return {
		...base,
		status: "scored",
		recommended: { ...scored(doc.lineups.recommended), expected_points: rec.expected_points_gw },
		...(a ? { actual: { points: a.fpl_points ?? a.points, gross: a.gross, hit_cost: a.hit_cost, chip: a.chip ?? null, recomputed: a.points, matches: a.matches_fpl === true } } : { reason: "the user's actual picks could not be fetched" }),
		baselines: {
			B0: { ...scored(doc.baselines.B0), transfers: doc.baselines.B0.decision.transfers },
			B1: { ...scored(doc.baselines.B1), transfers: doc.baselines.B1.decision.transfers },
		},
		projection: doc.projection,
		gaffer_lib: doc.gaffer_lib,
		live_sha256: liveSha,
	};
}

/** One recommendation per team and GW counts: the latest made before the deadline. */
export function markCounted(rows: OutcomeRow[], ledger: readonly LedgerRow[]): OutcomeRow[] {
	const latest = new Map<string, LedgerRow>();
	for (const r of ledger) {
		if (isTestRow(r) || Date.parse(r.created_at) > Date.parse(r.deadline)) continue;
		const key = `${r.team_id_hash}|${r.season}|${r.gw}`;
		const cur = latest.get(key);
		const t = Date.parse(r.created_at);
		const c = cur ? Date.parse(cur.created_at) : Number.NEGATIVE_INFINITY;
		if (t > c || (t === c && cur && r.rec_id > cur.rec_id)) latest.set(key, r);
	}
	return rows.map((o) => ({ ...o, counted: latest.get(`${o.team_id_hash}|${o.season}|${o.gw}`)?.rec_id === o.rec_id }));
}

export function writeOutcomes(dataDir: string, rows: OutcomeRow[]): void {
	const file = outcomesPath(dataDir);
	mkdirSync(dirname(file), { recursive: true });
	const sorted = [...rows].sort((a, b) => a.season.localeCompare(b.season) || a.gw - b.gw || a.created_at.localeCompare(b.created_at) || a.rec_id.localeCompare(b.rec_id));
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, sorted.map((r) => JSON.stringify(r)).join("\n") + (sorted.length ? "\n" : ""));
	renameSync(tmp, file);
}

export async function track(opts: TrackOptions, deps: TrackDeps): Promise<TrackSummary> {
	const log = deps.log ?? (() => undefined);
	const boot = (await deps.client.get<{ events: { id: number; finished: boolean; data_checked: boolean }[] }>("bootstrap-static/")).json;
	const finished = boot.events.filter((e) => e.finished && e.data_checked).map((e) => e.id);
	const ledger = readLedger(deps.dataDir);
	const real = ledger.filter((r) => !isTestRow(r));
	const existing = opts.rebuild ? [] : readOutcomes(deps.dataDir).filter((o) => !isTestRow(o));
	const done = new Set(existing.filter((o) => o.status === "scored").map((o) => o.rec_id));
	const todo = real.filter((r) => finished.includes(r.gw) && (opts.gw === undefined || r.gw === opts.gw) && !done.has(r.rec_id));
	const summary: TrackSummary = {
		finished, scored: [], skippedTest: ledger.length - real.length, alreadyScored: real.filter((r) => done.has(r.rec_id)).length, waiting: [], rows: 0,
	};
	for (const gw of [...new Set(real.filter((r) => !finished.includes(r.gw)).map((r) => r.gw))].sort((a, b) => a - b)) {
		summary.waiting.push({ gw, recommendations: real.filter((r) => r.gw === gw).length });
	}

	const byRec = new Map(existing.map((o) => [o.rec_id, o]));
	for (const gw of [...new Set(todo.map((r) => r.gw))].sort((a, b) => a - b)) {
		const liveRes = await deps.client.get(`event/${gw}/live/`);
		const liveSha = createHash("sha256").update(JSON.stringify(liveRes.json)).digest("hex");
		log(`GW${gw}: data checked; scoring ${todo.filter((r) => r.gw === gw).length} recommendation(s)`);
		for (const row of todo.filter((r) => r.gw === gw)) {
			let out: OutcomeRow;
			try {
				out = await scoreOne(row, liveRes.json, liveSha, deps);
			} catch (e) {
				out = { schema: OUTCOME_SCHEMA, rec_id: row.rec_id, team_id_hash: row.team_id_hash, season: row.season, gw: row.gw, deadline: row.deadline, created_at: row.created_at, model: row.model, snapshot_id: row.snapshot_id, counted: false, status: "unscorable", reason: (e as Error).message.split("\n")[0], gaffer_lib: "" };
			}
			byRec.set(row.rec_id, out);
			summary.scored.push({ rec_id: row.rec_id, gw, status: out.status, ...(out.reason ? { reason: out.reason } : {}) });
			log(`  ${row.rec_id}: ${out.status === "scored" ? `Gaffer ${out.recommended!.points}, actual ${out.actual?.points ?? "?"}${out.actual && !out.actual.matches ? " (recomputed differs!)" : ""}, B0 ${out.baselines!.B0.points}, B1 ${out.baselines!.B1.points}` : `not scored: ${out.reason}`}`);
		}
	}
	const rows = markCounted([...byRec.values()], ledger);
	writeOutcomes(deps.dataDir, rows);
	summary.rows = rows.length;
	return summary;
}
