/**
 * The frozen real snapshot and its golden-path plan (python/gaffer_lib/tests/data), for tests of
 * the submit gate: a session is seeded with a `gaffer.snapshot` entry pointing at the snapshot,
 * and a scripted model submits. No solver is needed; `gaffer_lib validate` runs on the host
 * sandboxd with the pinned numpy and scipy (test/harness.ts: analyticsPython).
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SnapshotEntry, TeamEntry } from "../src/session.ts";
import { hashTeamId } from "../src/snapshot.ts";
import type { GafferTestEnv } from "./harness.ts";

const DATA = resolve(import.meta.dirname, "../../../python/gaffer_lib/tests/data");
/** A team id that appears nowhere else, so a leak into a ledger, prefs file or export is unmistakable. */
export const TEAM_ID = 7654321;
export const MANAGER = "Pat Manager";

export interface PlanStep {
	gw: number;
	transfers: { out: number; in: number }[];
	chip: string | null;
	xi: number[];
	bench: number[];
	captain: number;
	vice_captain: number;
	expected_points: number;
}
export interface PlanDoc {
	gaffer_lib: string;
	plans: { rank: number; score: number; expected_points_gw: number; transfers: { out: { id: number; name: string }; in: { id: number; name: string }; xp_gain_4gw: number; xp_gain_6gw_decayed: number }[]; gws: PlanStep[] }[];
	players: Record<string, { name: string; team: string; xp: number[] }>;
	prefs_resolved: Record<string, unknown>;
	[k: string]: unknown;
}

export const planDoc = (): PlanDoc => JSON.parse(readFileSync(join(DATA, "plan-model.json"), "utf8"));

/** Put the frozen snapshot in the test data dir (optionally marked stale) and the plan in the sandbox's work dir. */
export function installModelSnapshot(env: GafferTestEnv, opts: { stale?: boolean; plan?: unknown } = {}) {
	const dir = join(env.dataDir, "snapshots", opts.stale ? "snapshot-model-stale" : "snapshot-model");
	mkdirSync(join(env.dataDir, "snapshots"), { recursive: true });
	cpSync(join(DATA, "snapshot-model"), dir, { recursive: true });
	if (opts.stale) writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id: "snapshot-model", stale: true, stale_reason: "fpl_updating" }));
	const planFile = join(env.sandboxWork, "plan.json");
	writeFileSync(planFile, JSON.stringify(opts.plan ?? planDoc()));
	return { dir, planFile };
}

export function snapshotEntry(dir: string, opts: { stale?: boolean; deadlineInMs?: number; ft?: number } = {}): SnapshotEntry {
	return {
		snapshot_id: "snapshot-model",
		snapshot_path: dir,
		snapshot_hash: "0".repeat(64),
		team_id: TEAM_ID,
		team_id_hash: hashTeamId(TEAM_ID, "test-salt"),
		fetched_at: new Date().toISOString(),
		stale: !!opts.stale,
		stale_reason: opts.stale ? "fpl_updating" : null,
		season: "2026/27",
		gw: { current: 5, next: 6, deadline: new Date(Date.now() + (opts.deadlineInMs ?? 2 * 86_400_000)).toISOString() },
		free_transfers: opts.ft ?? 3,
		ft_source: opts.ft === undefined ? "derived" : "user",
		pending_transfers: [],
		endpoints: [],
	};
}

/** `/seed`: put the team and snapshot entries in the session, as /team and fpl_snapshot would. */
export const seed = (snapshot: SnapshotEntry) => (pi: ExtensionAPI) =>
	pi.registerCommand("seed", {
		description: "test: seed the session",
		handler: async () => {
			pi.appendEntry("gaffer.team", { team_id: TEAM_ID, team_name: "Test XI" } satisfies TeamEntry);
			pi.appendEntry("gaffer.snapshot", snapshot);
		},
	});

/** What a model that follows the golden path submits: plan `rank` of the plan file. */
export function submission(doc: PlanDoc, planFile: string, rank = 1) {
	const d = doc.plans[rank - 1];
	const g0 = d.gws[0];
	return {
		plan_file: planFile,
		transfers: d.transfers.map((t) => ({ out: { id: t.out.id }, in: { id: t.in.id }, rationale: "Better fixtures and more secure minutes.", xp_gain_4gw: t.xp_gain_4gw, xp_gain_6gw_decayed: t.xp_gain_6gw_decayed })),
		captain: { id: g0.captain },
		vice_captain: { id: g0.vice_captain },
		starting_xi: [...g0.xi],
		bench: [...g0.bench],
		expected_points_gw: g0.expected_points,
		chip: { play: null as string | null, rationale: "No chip beats holding this week." },
		plan: d.gws.slice(0, 4).map((s) => ({ gw: s.gw, transfers: s.transfers.map((t) => ({ out: { id: t.out }, in: { id: t.in } })), chip: s.chip, captain: s.captain })),
		summary: "Make the three moves and give the armband to the best fixture.",
	};
}
