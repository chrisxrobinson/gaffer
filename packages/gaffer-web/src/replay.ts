/**
 * `--replay events.jsonl`: the bridge serves a recorded run instead of Pi, so UI work needs no model, sandbox or
 * spend (ADR 0014). A recording is one JSON line per record, `{t, rec}` with t in ms (spike S7's log adds `phase`
 * and `dir`; its first fixture). The run replayed is the first one that ends in a recommendation, played at
 * its recorded pace (`speed` > 1 is faster). Each Go starts a new replayed session.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pi } from "./bridge.ts";

interface Rec {
	t: number;
	phase?: string;
	dir?: string;
	rec: Record<string, any>;
}

export function loadRecording(file: string): { events: Rec[]; rec: Record<string, any> | undefined; team: { id: number; name: string } | undefined } {
	const all = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec)
		.filter((r) => (r.dir ?? "out") === "out" && (!r.phase || r.phase === "A") && r.rec.type !== "response");
	const end = (i: number) => all.findIndex((r, j) => j > i && r.rec.type === "agent_settled");
	const done = all.findIndex((r) => r.rec.type === "tool_execution_end" && r.rec.toolName === "submit_recommendation" && r.rec.result?.details?.recommendation);
	let start = done < 0 ? 0 : all.findLastIndex((r, j) => j < done && r.rec.type === "agent_start");
	while (start > 0 && ["entry_appended", "extension_ui_request"].includes(all[start - 1].rec.type)) start--;
	const last = done < 0 ? all.length - 1 : end(done);
	const events = all.slice(start, last + 1).map((r) => ({ ...r, t: r.t - all[start].t }));
	const rec = done < 0 ? undefined : all[done].rec.result.details.recommendation;
	const teamEntry = events.find((r) => r.rec.type === "entry_appended" && r.rec.entry?.customType === "gaffer.team")?.rec.entry.data;
	return { events, rec, team: teamEntry ? { id: teamEntry.team_id, name: teamEntry.team_name } : undefined };
}

export function replaySource(file: string, speed = 1) {
	const { events, rec, team } = loadRecording(file);
	const spawn = (): Pi => {
		const listeners: ((e: unknown) => void)[] = [];
		const timers: NodeJS.Timeout[] = [];
		const id = randomUUID();
		const emit = (e: unknown) => {
			for (const l of [...listeners]) l(e);
		};
		const stop = async () => {
			for (const t of timers) clearTimeout(t);
		};
		return {
			start: async () => {},
			stop,
			onEvent: (l) => {
				listeners.push(l as (e: unknown) => void);
				return () => listeners.splice(listeners.indexOf(l as (e: unknown) => void), 1);
			},
			getState: async () => ({ sessionId: id, sessionFile: join(tmpdir(), `gaffer-replay-${id}.jsonl`) }) as never,
			prompt: async () => {
				for (const r of events) timers.push(setTimeout(() => emit(r.rec), r.t / speed));
				return "handled" as never;
			},
			steer: async () => "queued" as never,
			abort: async () => {
				await stop();
				emit({ type: "agent_settled", aborted: true });
			},
			setSessionName: async () => {},
			cancelDialog: () => {},
		};
	};
	const players = rec ? [...rec.starting_xi, ...rec.bench].map((p: number) => ({ id: p, name: rec.players[p].name, team: rec.players[p].team, position: rec.players[p].position })) : [];
	return {
		spawn,
		api: {
			home: () => ({ gw: rec ? { current: rec.gw - 1, next: rec.gw, deadline: rec.deadline, season: rec.season } : null, now: Date.now(), spend: { today: 0, daily: 5, soft: 0.75, hard: 1.5 }, busy: null, sessions: [] }),
			team: (tid: number) => ({ id: tid, name: team?.name ?? "Replay XI", squad: players, prefs: rec?.preferences ?? null, ft: rec ? { value: rec.assumptions.free_transfers, source: rec.assumptions.ft_source, gw: rec.gw } : null }),
		},
	};
}
