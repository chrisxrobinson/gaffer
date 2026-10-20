/** Saving preferences for the session's team: shared by the set_preferences tool and /prefs. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dataDir, idSalt } from "./config.ts";
import { prefsPath, readPrefsFile, type StoredPrefs, writePrefs, writePrefsFile } from "./prefs.ts";
import type * as S from "./schema/fpl.ts";
import type { Preferences } from "./schema/recommendation.ts";
import { fplState, latestCustom, type RunEntry, type SnapshotEntry } from "./session.ts";

interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

/**
 * The preferences file this session's runs use for a team: the session's own (a Gaffer App run whose options
 * weren't saved, `gaffer.run.prefs_file`), else the team's saved file, else none.
 */
export function activePrefsFile(branch: readonly EntryLike[], data: string, teamIdHash: string): string | undefined {
	const run = latestCustom<RunEntry>(branch, "gaffer.run");
	if (run?.prefs_file && run.team_id_hash === teamIdHash && readPrefsFile(run.prefs_file)) return run.prefs_file;
	const saved = prefsPath(data, teamIdHash);
	return readPrefsFile(saved) ? saved : undefined;
}
import { hashTeamId } from "./snapshot.ts";
import { SnapshotStore } from "./store.ts";

export interface PrefsPatch {
	risk?: Preferences["risk"];
	save_chips?: Preferences["save_chips"];
	keep?: number[];
	avoid?: number[];
	max_hits_per_gw?: number | null;
}

/** The HMAC hash of the session's team, or undefined when no team is set. */
export function sessionTeamHash(ctx: ExtensionContext): string | undefined {
	const { teamId } = fplState(ctx.sessionManager.getBranch());
	return teamId ? hashTeamId(teamId, idSalt()) : undefined;
}

/** Resolve player ids against the session's latest snapshot and write the team's prefs file. */
export function savePreferences(ctx: ExtensionContext, patch: PrefsPatch): { prefs: StoredPrefs; path: string } {
	const branch = ctx.sessionManager.getBranch();
	const state = fplState(branch);
	if (!state.teamId) throw new Error("No FPL team is set, so there is nothing to save preferences for. Ask the user for their team ID, or they can run /team <id>.");
	const hash = hashTeamId(state.teamId, idSalt());
	const players = (ids: number[] | undefined) => {
		if (ids === undefined) return undefined;
		if (!ids.length) return [];
		const snap = latestCustom<SnapshotEntry>(branch, "gaffer.snapshot");
		if (!snap) throw new Error("Take a snapshot first (fpl_snapshot): players to keep or avoid are checked against FPL's player list.");
		const elements = new Map(new SnapshotStore(dataDir()).read<S.Bootstrap>(snap.snapshot_id, "bootstrap-static").elements.map((e) => [e.id, e.web_name]));
		const unknown = ids.filter((id) => !elements.has(id));
		if (unknown.length) throw new Error(`Unknown player id(s): ${unknown.join(", ")}. Use the ids from the snapshot.`);
		return [...new Set(ids)].map((id) => ({ id, name: elements.get(id)! }));
	};
	const resolved = { risk: patch.risk, save_chips: patch.save_chips, keep: players(patch.keep), avoid: players(patch.avoid), max_hits_per_gw: patch.max_hits_per_gw };
	const prefs = writePrefs(dataDir(), hash, resolved);
	// A session with its own preferences (an App run's options) keeps using its file: the change goes there too.
	const active = activePrefsFile(branch, dataDir(), hash);
	if (active && active !== prefsPath(dataDir(), hash)) return { prefs: writePrefsFile(active, resolved), path: active };
	return { prefs, path: prefsPath(dataDir(), hash) };
}
