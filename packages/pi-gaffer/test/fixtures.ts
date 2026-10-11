/** Small, internally consistent FPL API fixtures (shape verified against the live API on 2026-09-28). */

export const DEADLINE_GW6 = "2026-10-10T10:00:00Z";

export function bootstrap(overrides: { nextDeadline?: string } = {}) {
	const teams = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `Team ${i + 1}`, short_name: `T${String(i + 1).padStart(2, "0")}` }));
	// 4 players per position per team is plenty for a legal 15.
	const elements: Record<string, unknown>[] = [];
	let id = 1;
	for (const team of teams) {
		for (const element_type of [1, 2, 3, 4]) {
			for (let k = 0; k < 4; k++) {
				elements.push({
					id,
					web_name: `P${id}`,
					first_name: "First",
					second_name: `P${id}`,
					team: team.id,
					element_type,
					now_cost: 45 + (id % 60),
					status: "a",
					news: "",
					chance_of_playing_next_round: null,
					ep_next: "3.1",
					form: "2.0",
					total_points: 10,
					selected_by_percent: "1.0",
				});
				id++;
			}
		}
	}
	const events = Array.from({ length: 38 }, (_, i) => {
		const gw = i + 1;
		const deadline = new Date(Date.parse(overrides.nextDeadline ?? DEADLINE_GW6) + (gw - 6) * 7 * 86400_000).toISOString().replace(".000Z", "Z");
		return { id: gw, name: `Gameweek ${gw}`, deadline_time: deadline, finished: gw <= 5, data_checked: gw <= 5, is_previous: gw === 4, is_current: gw === 5, is_next: gw === 6 };
	});
	const chips = [
		["wildcard", 2, 19, "transfer"],
		["wildcard", 20, 38, "transfer"],
		["freehit", 2, 19, "transfer"],
		["bboost", 1, 19, "team"],
		["3xc", 1, 19, "team"],
		["freehit", 20, 38, "transfer"],
		["bboost", 20, 38, "team"],
		["3xc", 20, 38, "team"],
	].map(([name, start_event, stop_event, chip_type], i) => ({ id: i + 1, name, number: i < 2 ? i + 1 : 1, start_event, stop_event, chip_type }));
	return {
		events,
		teams,
		elements,
		chips,
		element_types: [
			{ id: 1, singular_name_short: "GKP", squad_select: 2, squad_min_play: 1, squad_max_play: 1 },
			{ id: 2, singular_name_short: "DEF", squad_select: 5, squad_min_play: 3, squad_max_play: 5 },
			{ id: 3, singular_name_short: "MID", squad_select: 5, squad_min_play: 2, squad_max_play: 5 },
			{ id: 4, singular_name_short: "FWD", squad_select: 3, squad_min_play: 1, squad_max_play: 3 },
		],
		game_settings: { squad_squadsize: 15, squad_team_limit: 3, squad_total_spend: 1000, max_extra_free_transfers: 4 },
		game_config: { settings: { price_change_deadlines: [] as string[] }, scoring: { goals_scored: { "1": 10, "2": 6, "3": 5, "4": 4 } }, rules: {}, status: {} },
		total_players: 12_000_000,
	};
}

export function fixtures() {
	const out: Record<string, unknown>[] = [];
	let id = 1;
	for (let gw = 1; gw <= 38; gw++) {
		for (let m = 0; m < 10; m++) {
			const h = ((m * 2 + gw) % 20) + 1;
			const a = ((m * 2 + 1 + gw) % 20) + 1;
			out.push({ id: id++, event: gw, team_h: h, team_a: a, kickoff_time: "2026-10-10T14:00:00Z", finished: gw <= 5, team_h_difficulty: 3, team_a_difficulty: 3 });
		}
	}
	return out;
}

/** Element id for the k-th player of a position (1 GK .. 4 FWD) at a team, matching bootstrap(). */
export const pid = (team: number, type: number, k = 0) => (team - 1) * 16 + (type - 1) * 4 + k + 1;

/** A legal 15 (2 GK, 5 DEF, 5 MID, 3 FWD), at most 2 per club. */
export const SQUAD = [
	pid(1, 1), pid(2, 1),
	pid(3, 2), pid(4, 2), pid(5, 2), pid(6, 2), pid(7, 2),
	pid(8, 3), pid(9, 3), pid(10, 3), pid(11, 3), pid(12, 3),
	pid(13, 4), pid(14, 4), pid(15, 4),
];

export function picks(gw = 5, squad = SQUAD, active_chip: string | null = null, bank = 5) {
	return {
		active_chip,
		automatic_subs: [],
		entry_history: { event: gw, points: 55, total_points: 335, rank: 1, overall_rank: 1, bank, value: 1015, event_transfers: 0, event_transfers_cost: 0, points_on_bench: 3 },
		picks: squad.map((element, i) => ({ element, position: i + 1, multiplier: i === 2 ? 2 : i < 11 ? 1 : 0, is_captain: i === 2, is_vice_captain: i === 3 })),
	};
}

export function entry(id = 1) {
	return { id, name: "Test XI", player_first_name: "Pat", player_last_name: "Manager", started_event: 1, current_event: 5, summary_overall_points: 335, last_deadline_bank: 5, last_deadline_value: 1015 };
}

export function history() {
	return {
		current: [1, 2, 3, 4, 5].map((event) => ({ event, points: 60, total_points: 60 * event, rank: 1, overall_rank: 1, bank: 5, value: 1000 + event, event_transfers: 0, event_transfers_cost: 0, points_on_bench: 2 })),
		past: [],
		chips: [] as { name: string; time: string; event: number }[],
	};
}

export function transfers() {
	return [] as Record<string, unknown>[];
}

/** event/{gw}/live: every player started and played 90 minutes; `explain` is the part the snapshot drops. */
export function live(gw: number) {
	return {
		elements: (bootstrap().elements as { id: number }[]).map((e) => ({
			id: e.id,
			stats: { minutes: 90, starts: 1, goals_scored: 0, assists: 0, total_points: 2, expected_goals: "0.10", in_dreamteam: false },
			explain: [{ fixture: gw, stats: [{ identifier: "minutes", points: 2, value: 90 }] }],
		})),
	};
}

/** football-data.co.uk files: a header with the columns Gaffer reads among others, then rows. */
const FD_HEADER = "Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,Referee,HxG,AxG,B365H,B365D,B365A,AvgH,AvgD,AvgA,B365>2.5,B365<2.5,Avg>2.5,Avg<2.5";

export function oddsFixturesCsv() {
	return [
		`﻿${FD_HEADER}`,
		"E0,10/10/2026,12:30,Arsenal,Tottenham,,,,A Taylor,,,1.6,4.2,5.5,1.62,4.15,5.4,1.7,2.15,1.72,2.12",
		'E0,10/10/2026,15:00,"Nott\'m Forest",Hull,,,,"Smith, J",,,2.1,3.4,3.6,2.08,3.45,3.65,2.0,1.8,2.02,1.79',
		"E1,10/10/2026,15:00,Leicester,Norwich,,,,B Jones,,,2.0,3.5,3.7,2.0,3.5,3.7,1.9,1.9,1.9,1.9",
		"",
	].join("\r\n");
}

export function resultsCsv(season: "prev" | "current") {
	const rows =
		season === "prev"
			? ["E0,15/08/2025,20:00,Liverpool,Bournemouth,4,2,H,A Taylor,,,1.3,6,8.5,1.3,5.9,8.6,1.4,3,1.42,2.9", "E0,16/08/2025,15:00,Spurs,Burnley,3,0,H,B Jones,,,1.4,5,7,1.41,4.9,7.1,1.5,2.6,1.52,2.55"]
			: ["E0,21/08/2026,20:00,Arsenal,Coventry,3,0,H,T Bramall,1.88,0.2,1.2,7,13,1.19,6.77,14.19,1.57,2.38,1.55,2.38", "E0,10/10/2026,12:30,Arsenal,Tottenham,,,,A Taylor,,,1.6,4.2,5.5,1.62,4.15,5.4,1.7,2.15,1.72,2.12"];
	return [FD_HEADER, ...rows, ""].join("\n");
}
