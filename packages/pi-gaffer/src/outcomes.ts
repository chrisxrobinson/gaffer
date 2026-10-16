/**
 * `/data/ledger/outcomes.jsonl` (ADR 0004, ARCHITECTURE §6.4): one row per ledgered recommendation of
 * a finished GW, written by tools/gaffer-eval; read by `/scorecard` and `gaffer admin`. Every point in
 * a row was computed by `python -m gaffer_lib score` (or read from FPL's own totals): nothing here
 * computes one.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const OUTCOME_SCHEMA = "gaffer.outcome/1";

export interface Scored {
	points: number;
	gross: number;
	hit_cost: number;
	chip: string | null;
	armband: number | null;
	autosubs: number[][];
}

export interface OutcomeRow {
	schema: typeof OUTCOME_SCHEMA;
	rec_id: string;
	team_id_hash: string;
	season: string;
	gw: number;
	deadline: string;
	created_at: string;
	model: string;
	snapshot_id: string;
	/**
	 * The one recommendation per team and GW that counts in season totals: the latest made before the
	 * deadline (the one the user saw last). Earlier ones for the same GW are scored but not counted.
	 */
	counted: boolean;
	status: "scored" | "unscorable";
	reason?: string;
	/** The recommended XI, captain and chip, after auto-subs, minus the recommendation's hits. */
	recommended?: Scored & { expected_points: number };
	/** The user's actual GW points from FPL (entry history: points − transfer cost), and the same recomputed from their picks. */
	actual?: { points: number; gross: number; hit_cost: number; chip: string | null; recomputed: number; matches: boolean };
	/** B0 and B1 from the same pre-deadline squad, with the official ep_next (gaffer_lib.outcomes). */
	baselines?: { B0: Scored & { transfers: number[][] }; B1: Scored & { transfers: number[][] } };
	/** Gaffer's xP and the official ep_next against the points (both recorded before the deadline). */
	projection?: { players: number; mae_gaffer?: number; mae_official?: number; rmse_gaffer?: number; rmse_official?: number; bias_gaffer?: number; bias_official?: number };
	gaffer_lib: string;
	/** sha256 of the event/{gw}/live response the points came from. */
	live_sha256?: string;
}

export function outcomesPath(dataDir: string): string {
	return join(dataDir, "ledger", "outcomes.jsonl");
}

export function readOutcomes(dataDir: string): OutcomeRow[] {
	const file = outcomesPath(dataDir);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.flatMap((l) => {
			try {
				return [JSON.parse(l) as OutcomeRow];
			} catch {
				return [];
			}
		});
}

export interface ScorecardGw {
	gw: number;
	rec_id: string;
	gaffer: number;
	actual: number;
	b0: number;
	b1: number;
	expected: number;
}

export interface Scorecard {
	season: string | null;
	gws: ScorecardGw[];
	totals: { gaffer: number; actual: number; b0: number; b1: number; expected: number };
	/** Mean absolute error of Gaffer's xP and of the official ep_next over the counted rows' players. */
	projection: { players: number; mae_gaffer: number | null; mae_official: number | null };
	/** Rows for this team that are scored but not counted (earlier recommendations for the same GW), and unscorable ones. */
	notCounted: number;
	unscorable: { gw: number; rec_id: string; reason: string }[];
}

/** Season to date for one team: the counted, scored rows of its latest season in outcomes.jsonl. */
export function scorecard(rows: readonly OutcomeRow[], teamHash: string): Scorecard {
	const mine = rows.filter((r) => r.team_id_hash === teamHash);
	const season = mine.map((r) => r.season).sort().at(-1) ?? null;
	const inSeason = mine.filter((r) => r.season === season);
	const counted = inSeason.filter((r) => r.counted && r.status === "scored" && r.recommended && r.actual && r.baselines).sort((a, b) => a.gw - b.gw);
	const gws = counted.map((r) => ({
		gw: r.gw, rec_id: r.rec_id, gaffer: r.recommended!.points, actual: r.actual!.points, b0: r.baselines!.B0.points, b1: r.baselines!.B1.points, expected: r.recommended!.expected_points,
	}));
	const sum = (k: keyof Omit<ScorecardGw, "gw" | "rec_id">) => round(gws.reduce((n, g) => n + g[k], 0));
	let players = 0;
	let g = 0;
	let o = 0;
	for (const r of counted) {
		const p = r.projection;
		if (!p?.players || p.mae_gaffer === undefined || p.mae_official === undefined) continue;
		players += p.players;
		g += p.mae_gaffer * p.players;
		o += p.mae_official * p.players;
	}
	return {
		season,
		gws,
		totals: { gaffer: sum("gaffer"), actual: sum("actual"), b0: sum("b0"), b1: sum("b1"), expected: sum("expected") },
		projection: { players, mae_gaffer: players ? round(g / players, 3) : null, mae_official: players ? round(o / players, 3) : null },
		notCounted: inSeason.filter((r) => r.status === "scored" && !r.counted).length,
		unscorable: inSeason.filter((r) => r.status === "unscorable").map((r) => ({ gw: r.gw, rec_id: r.rec_id, reason: r.reason ?? "unknown" })),
	};
}

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const signed = (x: number) => `${x >= 0 ? "+" : ""}${fmt(round(x, 1))}`;

/** The /scorecard text: one line per GW and the season totals, at most 72 columns. */
export function scorecardLines(card: Scorecard): string[] {
	if (!card.gws.length) {
		const lines = [
			"GAFFER · scorecard",
			"No finished GW has been scored for this team yet. gaffer-eval scores each recommendation",
			"once FPL marks the GW's data as checked.",
		];
		if (card.unscorable.length) lines.push(...card.unscorable.map((u) => `GW${u.gw} ${u.rec_id}: not scored (${u.reason})`));
		return lines;
	}
	const head = `${"GW".padEnd(4)}${"Gaffer".padStart(8)}${"You".padStart(8)}${"B0".padStart(8)}${"B1".padStart(8)}${"Gaffer xP".padStart(11)}`;
	const row = (gw: string, g: number, a: number, b0: number, b1: number, x: number) =>
		`${gw.padEnd(4)}${fmt(g).padStart(8)}${fmt(a).padStart(8)}${fmt(b0).padStart(8)}${fmt(b1).padStart(8)}${x.toFixed(1).padStart(11)}`;
	const t = card.totals;
	const lines = [
		`GAFFER · scorecard ${card.season ?? ""} — ${card.gws.length} GW${card.gws.length === 1 ? "" : "s"} scored`,
		"Gaffer: the recommended XI, captain and chip after auto-subs, minus its hits. You: your",
		"actual points. B0: hold, XI and captain by FPL's ep_next. B1: one free transfer on the",
		"best ep_next swap. All from the same pre-deadline squad.",
		"",
		head,
		...card.gws.map((g) => row(String(g.gw), g.gaffer, g.actual, g.b0, g.b1, g.expected)),
		"-".repeat(head.length),
		row("All", t.gaffer, t.actual, t.b0, t.b1, t.expected),
		"",
		`Gaffer vs you ${signed(t.gaffer - t.actual)} · vs B0 ${signed(t.gaffer - t.b0)} · vs B1 ${signed(t.gaffer - t.b1)}`,
	];
	if (card.projection.players) lines.push(`Projection error (mean absolute, ${card.projection.players} player-GWs): Gaffer ${card.projection.mae_gaffer} · FPL ep_next ${card.projection.mae_official}`);
	if (card.notCounted) lines.push(`Not counted: ${card.notCounted} earlier recommendation(s) for these GWs (the last before a deadline counts).`);
	for (const u of card.unscorable) lines.push(`GW${u.gw} ${u.rec_id}: not scored (${u.reason})`);
	return lines;
}
