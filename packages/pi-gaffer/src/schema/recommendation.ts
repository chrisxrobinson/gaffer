/**
 * `gaffer.recommendation/1` (ARCHITECTURE §2.4): what `submit_recommendation` stores, renders and
 * exports, and `Submission`, the part of it the model writes.
 *
 * The model supplies decisions and words. Every number in a stored recommendation is computed by
 * `gaffer_lib` at submit (ADR 0003): numbers in a submission are optional, and exist only so the
 * gate can report how far the model's figures were from the recomputed ones.
 *
 * The JSON Schema export for consumers is `schemas/recommendation-1.json`
 * (`node packages/pi-gaffer/scripts/export-schema.ts`); a test fails if it is out of date.
 */
import { type Static, Type } from "typebox";

export const SCHEMA_ID = "gaffer.recommendation/1";
export const RATIONALE_WORDS = 60;
export const SUMMARY_WORDS = 120;

/** A string of 1 to `n` words. The limit is part of the schema, not a request (FR-REC-06). */
const words = (n: number, description: string) => Type.String({ pattern: `^\\s*\\S+(?:\\s+\\S+){0,${n - 1}}\\s*$`, maxLength: n * 24, description: `${description} At most ${n} words.` });
const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) => Type.Union([t, Type.Null()]);

export const Level = Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]);
export const Chip = Type.Union([Type.Literal("wildcard"), Type.Literal("freehit"), Type.Literal("bboost"), Type.Literal("3xc")], {
	description: "wildcard, freehit, bboost (Bench Boost) or 3xc (Triple Captain)",
});
export const Risk = Type.Union([Type.Literal("safe"), Type.Literal("balanced"), Type.Literal("aggressive")]);
const PlayerId = Type.Integer({ minimum: 1, description: "FPL player (element) id" });

// ---------------------------------------------------------------------------------------------------
// Preferences (FR-INP-02), stored per team in /data/users/<hmac>/prefs.json

const PlayerRef = Type.Object({ id: PlayerId, name: Type.String({ maxLength: 60 }) }, { additionalProperties: false });

export const Preferences = Type.Object(
	{
		risk: Risk,
		save_chips: Type.Array(Chip, { maxItems: 4 }),
		keep: Type.Array(PlayerRef, { maxItems: 15 }),
		avoid: Type.Array(PlayerRef, { maxItems: 50 }),
		max_hits_per_gw: Nullable(Type.Integer({ minimum: 0, maximum: 15 })),
	},
	{ additionalProperties: false },
);
export type Preferences = Static<typeof Preferences>;

// ---------------------------------------------------------------------------------------------------
// The submission: submit_recommendation's parameters

const optionalNumber = (description: string) => Type.Optional(Type.Number({ description: `${description} Optional: recomputed at submit; a gap from your figure is reported.` }));

export const Submission = Type.Object({
	plan_file: Type.Optional(Type.String({ maxLength: 300, description: "Path in the sandbox of the plan JSON the golden path wrote for the latest snapshot. Default /work/plan.json." })),
	transfers: Type.Array(
		Type.Object({
			out: Type.Object({ id: PlayerId }),
			in: Type.Object({ id: PlayerId }),
			rationale: words(RATIONALE_WORDS, "Why this move."),
			confidence: Type.Optional(Level),
			xp_gain_4gw: optionalNumber("xP gained over the 4 GWs shown."),
			xp_gain_6gw_decayed: optionalNumber("Decayed xP gained over the 6-GW horizon."),
		}),
		{ maxItems: 15, description: "This GW's transfers (not ones the user has already made). Empty to roll." },
	),
	captain: Type.Object({ id: PlayerId, xp: optionalNumber("His xP this GW.") }),
	vice_captain: Type.Object({ id: PlayerId, xp: optionalNumber("His xP this GW.") }),
	starting_xi: Type.Array(PlayerId, { minItems: 11, maxItems: 11, description: "The 11 starters after this GW's transfers." }),
	bench: Type.Array(PlayerId, { minItems: 4, maxItems: 4, description: "The 4 on the bench. The order is set at submit by the auto-sub simulator." }),
	expected_points_gw: optionalNumber("The XI's expected points this GW, captain doubled, before hits."),
	chip: Type.Object({
		play: Nullable(Chip),
		rationale: words(RATIONALE_WORDS, "Why this chip now, or why none."),
		confidence: Type.Optional(Level),
	}),
	plan: Type.Array(
		Type.Object({
			gw: Type.Integer({ minimum: 1, maximum: 38 }),
			transfers: Type.Optional(Type.Array(Type.Object({ out: Type.Object({ id: PlayerId }), in: Type.Object({ id: PlayerId }) }), { maxItems: 15 })),
			chip: Type.Optional(Nullable(Chip)),
			captain: Type.Optional(PlayerId),
			expected_points: optionalNumber("That GW's expected points."),
			note: Type.Optional(words(RATIONALE_WORDS, "What this GW is for.")),
		}),
		{ minItems: 1, maxItems: 4, description: "The rolling plan: this GW and the next 3, in order (fewer only when the season ends sooner). Entry 0 is this GW; its transfers, chip and captain may be left out." },
	),
	warnings: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 5, description: "Things the user should know that the computed warnings won't say (e.g. a press conference still to come)." })),
	summary: words(SUMMARY_WORDS, "The advice in plain words."),
	confidence: Type.Optional(
		Type.Object({
			overall: Level,
			drivers: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 3 })),
		}, { description: "Only to LOWER the computed confidence, with your reason. You can't raise it." }),
	),
});
export type Submission = Static<typeof Submission>;

// ---------------------------------------------------------------------------------------------------
// The stored recommendation

const strict = { additionalProperties: false } as const;
const Named = Type.Object({ id: PlayerId, name: Type.String() }, strict);
const Role = Type.Object({ id: PlayerId, name: Type.String(), xp: Type.Number(), p_start: Type.Number({ minimum: 0, maximum: 1 }) }, strict);

export const Recommendation = Type.Object(
	{
		schema: Type.Literal(SCHEMA_ID),
		rec_id: Type.String({ pattern: "^[0-9A-HJKMNP-TV-Z]{26}$", description: "ULID" }),
		created_at: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$" }),
		season: Type.String(),
		gw: Type.Integer({ minimum: 1, maximum: 38 }),
		deadline: Nullable(Type.String()),
		team_id_hash: Type.String({ pattern: "^hmac-sha256:[0-9a-f]{64}$", description: "HMAC of the FPL team id; the raw id is never stored here (NFR-PRIV-01)" }),
		model: Type.String({ description: "provider/model id of the LLM that made the submission" }),
		gaffer_lib: Type.String(),
		pi: Type.String(),
		snapshot: Type.Object({ id: Type.String(), fetched_at: Type.String(), stale: Type.Boolean(), stale_reason: Nullable(Type.String()) }, strict),
		assumptions: Type.Object(
			{
				free_transfers: Nullable(Type.Integer()),
				ft_source: Type.Union([Type.Literal("derived"), Type.Literal("user")]),
				bank: Type.Number({ description: "£m, after any pending transfers" }),
				pending_transfers: Type.Array(Type.Array(Type.Integer(), { minItems: 2, maxItems: 2 })),
			},
			strict,
		),
		preferences: Type.Object({ risk: Risk, save_chips: Type.Array(Chip), keep: Type.Array(Named), avoid: Type.Array(Named), max_hits_per_gw: Nullable(Type.Integer()) }, strict),
		transfers: Type.Array(
			Type.Object(
				{
					out: Type.Object({ id: PlayerId, name: Type.String(), sell_price: Type.Number() }, strict),
					in: Type.Object({ id: PlayerId, name: Type.String(), price: Type.Number() }, strict),
					xp_gain_4gw: Type.Number(),
					xp_gain_6gw_decayed: Type.Number(),
					rationale: words(RATIONALE_WORDS, "Why this move."),
					confidence: Level,
				},
				strict,
			),
		),
		hits: Type.Integer({ minimum: 0 }),
		hit_cost: Type.Integer({ minimum: 0 }),
		net_xp_gain_4gw: Type.Number({ description: "Σ transfers[].xp_gain_4gw − hit_cost" }),
		captain: Role,
		vice_captain: Role,
		starting_xi: Type.Array(PlayerId, { minItems: 11, maxItems: 11 }),
		bench: Type.Array(PlayerId, { minItems: 4, maxItems: 4, description: "Goalkeeper first, then the order the auto-sub simulator values most" }),
		expected_points_gw: Type.Number(),
		chip: Type.Object(
			{
				play: Nullable(Chip),
				rationale: words(RATIONALE_WORDS, "Why this chip now, or why none."),
				confidence: Level,
				scenarios: Type.Array(
					Type.Object(
						{
							chip: Chip,
							gw: Nullable(Type.Integer()),
							evaluated: Type.Boolean(),
							delta_xp: Type.Optional(Type.Number({ description: "Decayed objective with the chip forced in `gw`, minus the chip-free plan's" })),
							delta_xp_gw: Type.Optional(Type.Number({ description: "That GW's expected points net of hits, minus the chip-free plan's" })),
							reason: Type.Optional(Type.String({ description: "Why the scenario was not evaluated" })),
						},
						strict,
					),
					{ description: "At least one entry per chip type: an evaluated scenario, or the reason there is none" },
				),
			},
			strict,
		),
		plan: Type.Array(
			Type.Object(
				{
					gw: Type.Integer(),
					transfers: Type.Array(Type.Object({ out: Named, in: Named }, strict)),
					roll_ft: Type.Boolean(),
					chip: Nullable(Chip),
					captain: PlayerId,
					free_transfers: Type.Integer({ description: "Free transfers available in that GW" }),
					hits: Type.Integer(),
					hit_cost: Type.Integer(),
					expected_points: Type.Number({ description: "Before hits" }),
					note: Type.String(),
				},
				strict,
			),
			{ minItems: 1, maxItems: 4, description: "Consecutive GWs from the next deadline: exactly 4 unless the season ends sooner" },
		),
		xmins_overrides: Type.Array(
			Type.Object(
				{ player: PlayerId, name: Type.String(), gw: Nullable(Type.Integer()), xmins: Type.Number({ minimum: 0, maximum: 90 }), quote: Type.String({ minLength: 1 }), source: Type.Union([Type.Literal("news"), Type.Literal("user")]) },
				strict,
			),
			{ description: "Minutes the model set from team news, each with the quoted text (FR-REC-10)" },
		),
		players: Type.Record(
			Type.String({ pattern: "^[0-9]+$" }),
			Type.Object({ name: Type.String(), team: Type.String(), position: Type.String(), xp: Type.Number(), p_start: Type.Number() }, strict),
			{ description: "Every player the recommendation mentions, by id, with this GW's xP" },
		),
		warnings: Type.Array(Type.String()),
		summary: words(SUMMARY_WORDS, "The advice in plain words."),
		confidence: Type.Object({ overall: Level, drivers: Type.Array(Type.String()) }, strict),
		validation: Type.Object(
			{
				passed: Type.Literal(true),
				recomputed: Type.Literal(true),
				max_model_number_drift: Type.Number({ minimum: 0, description: "Largest gap between a figure the model submitted and the recomputed one" }),
				numbers_checked: Type.Integer({ minimum: 0 }),
				drift: Type.Array(Type.Object({ path: Type.String(), model: Type.Number(), recomputed: Type.Number(), gap: Type.Number() }, strict), { description: "Gaps over 0.5" }),
				score: Type.Number({ description: "The plan's decayed objective (the solver's own, recomputed)" }),
				best_score: Type.Number(),
				gap_to_best: Type.Number(),
				margin: Nullable(Type.Number()),
				plans_compared: Type.Integer(),
				optimality_checked: Type.Boolean(),
				solver: Type.Object({ name: Nullable(Type.String()), commit: Nullable(Type.String()), status: Nullable(Type.String()), gap: Nullable(Type.Number()), timed_out: Nullable(Type.Boolean()) }, strict),
				attempts: Type.Integer({ minimum: 1, maximum: 3, description: "Submissions it took, including this one" }),
			},
			strict,
		),
	},
	{ ...strict, $id: "https://gaffer.invalid/schemas/recommendation-1.json", title: SCHEMA_ID },
);
export type Recommendation = Static<typeof Recommendation>;

/** The JSON Schema document published as schemas/recommendation-1.json. */
export function recommendationJsonSchema(): Record<string, unknown> {
	return { $schema: "https://json-schema.org/draft/2020-12/schema", ...(JSON.parse(JSON.stringify(Recommendation)) as Record<string, unknown>) };
}
