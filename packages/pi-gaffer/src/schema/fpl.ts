/**
 * TypeBox schemas for the FPL API fields Gaffer relies on (ADR 0002). Unknown extra fields are allowed;
 * a missing or mistyped consumed field is a hard error.
 */
import { Type, type Static } from "typebox";

const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) => Type.Union([t, Type.Null()]);

export const Event = Type.Object({
	id: Type.Integer(),
	deadline_time: Type.String(),
	finished: Type.Boolean(),
	data_checked: Type.Boolean(),
	is_previous: Type.Boolean(),
	is_current: Type.Boolean(),
	is_next: Type.Boolean(),
});

export const Team = Type.Object({ id: Type.Integer(), name: Type.String(), short_name: Type.String() });

export const Element = Type.Object({
	id: Type.Integer(),
	web_name: Type.String(),
	team: Type.Integer(),
	element_type: Type.Integer(),
	now_cost: Type.Integer(),
	status: Type.String(),
	news: Type.String(),
	chance_of_playing_next_round: Nullable(Type.Integer()),
	ep_next: Nullable(Type.String()),
	selected_by_percent: Type.String(),
});

export const ElementType = Type.Object({
	id: Type.Integer(),
	singular_name_short: Type.String(),
	squad_select: Type.Integer(),
	squad_min_play: Type.Integer(),
	squad_max_play: Type.Integer(),
});

export const Chip = Type.Object({ id: Type.Integer(), name: Type.String(), start_event: Type.Integer(), stop_event: Type.Integer(), chip_type: Type.String() });

export const Bootstrap = Type.Object({
	events: Type.Array(Event),
	teams: Type.Array(Team),
	elements: Type.Array(Element),
	element_types: Type.Array(ElementType),
	chips: Type.Array(Chip),
	game_settings: Type.Object({
		squad_squadsize: Type.Integer(),
		squad_team_limit: Type.Integer(),
		squad_total_spend: Type.Integer(),
		max_extra_free_transfers: Type.Integer(),
	}),
	game_config: Type.Object({
		settings: Type.Object({ price_change_deadlines: Type.Optional(Type.Array(Type.String())) }),
		scoring: Type.Record(Type.String(), Type.Unknown()),
	}),
});

export const Fixture = Type.Object({
	id: Type.Integer(),
	event: Nullable(Type.Integer()),
	team_h: Type.Integer(),
	team_a: Type.Integer(),
	kickoff_time: Nullable(Type.String()),
	finished: Type.Boolean(),
	team_h_difficulty: Type.Integer(),
	team_a_difficulty: Type.Integer(),
});
export const Fixtures = Type.Array(Fixture);

export const Entry = Type.Object({
	id: Type.Integer(),
	name: Type.String(),
	player_first_name: Type.String(),
	player_last_name: Type.String(),
	started_event: Type.Integer(),
	current_event: Nullable(Type.Integer()),
	summary_overall_points: Nullable(Type.Integer()),
});

const GwHistory = Type.Object({
	event: Type.Integer(),
	points: Type.Integer(),
	total_points: Type.Integer(),
	bank: Type.Integer(),
	value: Type.Integer(),
	event_transfers: Type.Integer(),
	event_transfers_cost: Type.Integer(),
});

export const History = Type.Object({
	current: Type.Array(GwHistory),
	chips: Type.Array(Type.Object({ name: Type.String(), event: Type.Integer() })),
});

export const Transfers = Type.Array(
	Type.Object({ element_in: Type.Integer(), element_in_cost: Type.Integer(), element_out: Type.Integer(), element_out_cost: Type.Integer(), event: Type.Integer() }),
);

export const Picks = Type.Object({
	active_chip: Nullable(Type.String()),
	entry_history: Type.Object({ event: Type.Integer(), bank: Type.Integer(), value: Type.Integer(), event_transfers: Type.Integer(), event_transfers_cost: Type.Integer() }),
	picks: Type.Array(
		Type.Object({ element: Type.Integer(), position: Type.Integer(), multiplier: Type.Integer(), is_captain: Type.Boolean(), is_vice_captain: Type.Boolean() }),
	),
});

/** event/{gw}/live: per-player stats for one GW (the model reads minutes and starts; ADR 0002). */
export const Live = Type.Object({
	elements: Type.Array(Type.Object({ id: Type.Integer(), stats: Type.Object({ minutes: Type.Integer(), starts: Type.Integer() }) })),
});

export type Live = Static<typeof Live>;
export type Bootstrap = Static<typeof Bootstrap>;
export type Fixtures = Static<typeof Fixtures>;
export type Entry = Static<typeof Entry>;
export type History = Static<typeof History>;
export type Transfers = Static<typeof Transfers>;
export type Picks = Static<typeof Picks>;
