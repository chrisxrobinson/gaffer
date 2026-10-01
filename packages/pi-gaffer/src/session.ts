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
	/** User-stated free transfers for the next GW (FR-INP-04), overriding the derived count. */
	ft?: number;
	/** User-declared pending transfers for the next GW, e.g. "Salah>Palmer". */
	pending?: string;
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
	/** Free transfers used for this snapshot and where they came from (FR-INP-04). */
	free_transfers?: number | null;
	ft_source?: "derived" | "user" | null;
	pending_transfers?: [number, number][];
	/** The odds source's state in this snapshot (FR-DAT-09). */
	odds?: { requested: boolean; available: boolean; fixtures: number; reason: string | null };
	/** The official ep_next this snapshot recorded (FR-DAT-10). */
	ep_next?: { gw: number | null; players: number; before_deadline: boolean };
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
		ft: team?.team_id === teamId ? team?.ft : undefined,
		pending: team?.team_id === teamId ? team?.pending : undefined,
		snapshot: snap && snap.team_id === teamId ? snap : undefined,
	};
}
