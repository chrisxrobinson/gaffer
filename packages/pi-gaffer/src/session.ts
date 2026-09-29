/**
 * Session-derived state. Pi loads each extension with its own module cache, so extensions share state
 * through the session log (the system of record, ADR 0004) rather than through module variables.
 */
import type { SessionFplState } from "./prompt.ts";

interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface TeamEntry {
	team_id: number;
	team_name?: string;
}

export interface SnapshotEntry {
	snapshot_id: string;
	snapshot_path: string;
	snapshot_hash: string;
	team_id: number;
	team_id_hash: string;
	fetched_at: string;
	stale: boolean;
	stale_reason: string | null;
	season: string;
	gw: { current: number | null; next: number | null; deadline: string | null };
	endpoints: unknown[];
}

export function latestCustom<T>(entries: readonly EntryLike[], customType: string): T | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "custom" && e.customType === customType) return e.data as T;
	}
	return undefined;
}

/** Team set by /team, else the team of the latest snapshot on this branch. */
export function fplState(branch: readonly EntryLike[]): SessionFplState {
	const team = latestCustom<TeamEntry>(branch, "gaffer.team");
	const snap = latestCustom<SnapshotEntry>(branch, "gaffer.snapshot");
	const teamId = team?.team_id ?? snap?.team_id;
	return {
		teamId,
		teamName: team?.team_name,
		snapshot: snap && snap.team_id === teamId ? snap : undefined,
	};
}
