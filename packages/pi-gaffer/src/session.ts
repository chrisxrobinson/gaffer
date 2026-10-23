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
	/** The FPL team's name and bank (£m, as of the last deadline), for the TUI's status strip (FR-UI-05). */
	team_name?: string;
	bank?: number | null;
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
	odds?: { requested: boolean; available: boolean; fixtures: number; listed?: number; reason: string | null };
	/** Whether transfers may be finalised on this snapshot (FR-DAT-05); the submit gate checks again at submit time. */
	finalise_transfers?: { allowed: boolean; reason?: string };
	/** The official ep_next this snapshot recorded (FR-DAT-10). */
	ep_next?: { gw: number | null; players: number; before_deadline: boolean };
	endpoints: unknown[];
}

type ChipName = "wildcard" | "freehit" | "bboost" | "3xc";
/** A player as `/run` resolved it from FPL's bootstrap: the page sends only the id. */
export interface RunPlayer {
	id: number;
	name: string;
	team?: string;
}

export interface RecommendOptions {
	risk: "safe" | "balanced" | "aggressive";
	max_hits_per_gw: number | null;
	save_chips: ChipName[];
	keep: RunPlayer[];
	ft?: number;
	pending?: string;
	/** Saved as the team's preferences; otherwise they apply to this session only (`prefs_file`). */
	save: boolean;
}
export type WhatIfOptions = { kind: "transfer"; out: RunPlayer; in: RunPlayer; gw: number } | { kind: "chip"; chip: ChipName; gw: number } | { kind: "keep"; player: RunPlayer };
export interface ExplainOptions {
	player: RunPlayer;
	against: "recommendation" | "squad";
	/** Where the player stands in the team's latest recommendation, when explained against it. */
	rec?: { rec_id: string; gw: number; role: string } | null;
}
export interface ChipsOptions {
	from_gw: number;
	to_gw: number;
}
export interface PreferencesOptions {
	risk: "safe" | "balanced" | "aggressive";
	max_hits_per_gw: number | null;
	save_chips: ChipName[];
	keep: RunPlayer[];
	clear: boolean;
}

/** `gaffer.run`: a structured start from the Gaffer App (`/run {json}`, ADR 0014): what the run is for, as data. */
export interface RunEntry {
	action: "recommend" | "whatif" | "explain" | "chips" | "preferences";
	/** The session's title in both UIs' lists until it is renamed: "Recommend GW8", "What-if: keep Watkins". */
	title?: string;
	team_id: number;
	team_id_hash: string;
	/** The next GW when the run was asked for, from FPL; null if FPL couldn't be reached. */
	gw: number | null;
	options: RecommendOptions | WhatIfOptions | ExplainOptions | ChipsOptions | PreferencesOptions;
	/** The session's own preferences file when the options weren't saved (prefs.ts `runPrefsPath`). */
	prefs_file: string | null;
	source: "app";
	started_at: string;
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
