/**
 * `/run {json}`: the Gaffer App's structured start (ADR 0014). The bridge builds the JSON; the terminal never
 * offers it (it isn't in the command allowlist). It validates the JSON, sets the team (as /team does), records a
 * `gaffer.run` entry, and starts the run with the template the terminal uses, so both UIs exercise one workflow
 * and the evals cover both:
 * - recommend → `/gw`, after writing the options as the team's preferences or as this session's own;
 * - whatif → `/whatif`, explain → `/explain`, chips → `/chips`, with an argument written here from FPL's names:
 *   the page sends player ids, never text;
 * - preferences → no template and no model call: the team's preferences file is written (or cleared).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { budgetConfig, dataDir, fplNow, idSalt, sessionsRoot } from "../../src/config.ts";
import { dayCost } from "../../src/budget.ts";
import { fplBootstrap, gwInfo, latestRecommendation, playerNames, roleIn, runTitle, teamSquad } from "../../src/app-data.ts";
import { FplClient } from "../../src/http.ts";
import { DEFAULT_PREFS, describePrefs, runPrefsPath, writePrefs, writePrefsFile } from "../../src/prefs.ts";
import { Chip, type Preferences, Risk } from "../../src/schema/recommendation.ts";
import type * as S from "../../src/schema/fpl.ts";
import type { RunEntry, RunPlayer } from "../../src/session.ts";
import { hashTeamId } from "../../src/snapshot.ts";
import { SnapshotStore } from "../../src/store.ts";
import type { SessionGuard } from "./locks.ts";

const Id = Type.Integer({ minimum: 1, maximum: 99_999 });
const Gw = Type.Integer({ minimum: 1, maximum: 38 });
const TeamId = Type.Integer({ minimum: 1, maximum: 9_999_999_999 });
const MaxHits = Type.Union([Type.Integer({ minimum: 0, maximum: 15 }), Type.Null()]);
const closed = { additionalProperties: false } as const;
/** The longest chip-planner range: GW8 to GW19, the rest of a half. */
export const CHIP_RANGE_MAX = 12;
/** A what-if transfer or chip is planned within the golden path's horizon. */
const HORIZON = 6;

export const RunSpec = Type.Union([
	Type.Object({
		action: Type.Literal("recommend"),
		team_id: TeamId,
		options: Type.Object({
			risk: Risk,
			max_hits_per_gw: MaxHits,
			save_chips: Type.Array(Chip, { maxItems: 4 }),
			keep: Type.Array(Id, { maxItems: 15 }),
			ft: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
			pending: Type.Optional(Type.String({ minLength: 3, maxLength: 200, pattern: "^[^>,;]+>[^>,;]+(\\s*[,;]\\s*[^>,;]+>[^>,;]+)*$" })),
			save: Type.Boolean(),
		}, closed),
	}, closed),
	Type.Object({
		action: Type.Literal("whatif"),
		team_id: TeamId,
		options: Type.Union([
			Type.Object({ kind: Type.Literal("transfer"), out: Id, in: Id, gw: Gw }, closed),
			Type.Object({ kind: Type.Literal("chip"), chip: Chip, gw: Gw }, closed),
			Type.Object({ kind: Type.Literal("keep"), player: Id }, closed),
		]),
	}, closed),
	Type.Object({ action: Type.Literal("explain"), team_id: TeamId, options: Type.Object({ player: Id, against: Type.Union([Type.Literal("recommendation"), Type.Literal("squad")]) }, closed) }, closed),
	Type.Object({ action: Type.Literal("chips"), team_id: TeamId, options: Type.Object({ from_gw: Gw, to_gw: Gw }, closed) }, closed),
	Type.Object({
		action: Type.Literal("preferences"),
		team_id: TeamId,
		options: Type.Object({ risk: Risk, max_hits_per_gw: MaxHits, save_chips: Type.Array(Chip, { maxItems: 4 }), keep: Type.Array(Id, { maxItems: 15 }), clear: Type.Boolean() }, closed),
	}, closed),
]);
export type RunSpec = Static<typeof RunSpec>;
const check = Compile(RunSpec);

const CHIP_NAME: Record<string, string> = { wildcard: "Wildcard", freehit: "Free Hit", bboost: "Bench Boost", "3xc": "Triple Captain" };

/** /team's effect (gaffer-core): a `gaffer.team` entry, after checking the team exists. */
export type SetTeam = (ctx: ExtensionContext, team: { teamId: number; ft?: number; pending?: string }) => Promise<{ name?: string; unreachable?: string } | { error: string }>;

/** What a spec turns into: the template to send (none for preferences), the entry's options, and the preferences to write. */
interface Planned {
	template?: string;
	options: RunEntry["options"];
	prefs?: Partial<Preferences>;
}

/** The first JSON-schema error of a spec, in a line ("/options/gw must be <= 38"). */
function firstError(spec: unknown): string {
	// A union reports every branch's errors; the useful ones are the branch the spec names (its action, and a
	// what-if's kind), so the schema is narrowed to that branch first.
	const s = spec as { action?: unknown; options?: { kind?: unknown } };
	const branch = RunSpec.anyOf.find((b) => b.properties.action.const === s?.action);
	if (!branch) return "/action is not an action Gaffer runs.";
	const opts = branch.properties.options as { anyOf?: { properties: { kind: { const: string } } }[] };
	const kind = opts.anyOf?.find((k) => k.properties.kind.const === s.options?.kind);
	const narrowed = opts.anyOf ? { ...branch, properties: { ...branch.properties, options: kind ?? Type.Object({ kind: Type.Union(opts.anyOf.map((k) => Type.Literal(k.properties.kind.const))) }) } } : branch;
	const errors = [...Compile(narrowed as never).Errors(spec)];
	const e = errors.find((x) => x.instancePath) ?? errors[0];
	return `${e?.instancePath || "/"} ${e?.message ?? "is invalid"}.`;
}

export function registerRun(pi: ExtensionAPI, guard: SessionGuard, setTeam: SetTeam) {
	pi.registerCommand("run", {
		description: "The Gaffer App's structured start: /run {\"action\":\"recommend\"|\"whatif\"|\"explain\"|\"chips\"|\"preferences\",\"team_id\":N,\"options\":{…}}",
		handler: async (args, ctx) => {
			const fail = (why: string) => ctx.ui.notify(`${spec?.action === "preferences" ? "Preferences not saved" : "Run not started"}: ${why}`, "error");
			let spec: RunSpec | undefined;
			let raw: unknown;
			try {
				raw = JSON.parse(args);
			} catch {
				return fail("the request isn't valid JSON.");
			}
			if (!check.Check(raw)) return fail(firstError(raw));
			spec = raw;
			const model = spec.action !== "preferences";
			const why = guard.refusal(ctx) ?? (model ? guard.runBusy(ctx) : undefined);
			if (why) return fail(why);
			if (model) {
				const { daily } = budgetConfig();
				const spent = dayCost(sessionsRoot(ctx.sessionManager.getSessionDir()), new Date());
				if (spent >= daily) return fail(`today's spend is $${spent.toFixed(2)} of the $${daily.toFixed(2)} daily cap. New runs can start after midnight UTC.`);
			}

			// Every player id, and the next GW, from FPL's own list. Only Recommend without players may go ahead
			// without it (fpl_snapshot reports FPL being down); everything else needs names for its prompt.
			const fpl = new FplClient({ timeoutMs: 8000 });
			let b: S.Bootstrap | undefined;
			try {
				b = await fplBootstrap(new SnapshotStore(dataDir()), fpl, fplNow(), AbortSignal.timeout(9500));
			} catch (e) {
				const needs = spec.action !== "recommend" || spec.options.keep.length;
				if (needs) return fail(`FPL could not be reached to check the request (${(e as Error).message}).`);
			}
			const gw = b ? gwInfo(b).next : null;
			const teams = new Map(b?.teams.map((t) => [t.id, t.short_name]) ?? []);
			const club = new Map(b?.elements.map((e) => [e.id, teams.get(e.team) ?? "?"]) ?? []);
			const resolve = (ids: readonly number[]): RunPlayer[] | string => {
				const named = b ? playerNames(b, ids) : [];
				const unknown = ids.filter((_, i) => !named[i]);
				if (unknown.length) return `FPL has no player with id ${unknown.join(", ")}.`;
				return named.map((p) => ({ id: p!.id, name: p!.name, team: club.get(p!.id) }));
			};
			const label = (p: RunPlayer) => `${p.name} (${p.team}, id ${p.id})`;
			const squad = async () => (b ? (await teamSquad(fpl, b, spec!.team_id, AbortSignal.timeout(9500)).catch(() => [])).map((p) => p.id) : []);
			const inWindow = (g: number) => gw === null || (g >= gw && g < gw + HORIZON);

			let plan: Planned;
			const hash = hashTeamId(spec.team_id, idSalt());
			switch (spec.action) {
				case "recommend": {
					const o = spec.options;
					const keep = resolve(o.keep);
					if (typeof keep === "string") return fail(keep);
					const pending = o.pending?.split(/[,;]/).map((x) => x.trim()).filter(Boolean).join(", ");
					const prefs = { risk: o.risk, save_chips: [...new Set(o.save_chips)], keep: keep.map(({ id, name }) => ({ id, name })), max_hits_per_gw: o.max_hits_per_gw };
					plan = { template: "/gw", options: { ...o, ...(pending && { pending }), keep: prefs.keep }, prefs };
					break;
				}
				case "whatif": {
					const o = spec.options;
					if (o.kind === "chip") {
						if (!inWindow(o.gw)) return fail(`GW${o.gw} is outside the next ${HORIZON} gameweeks (from GW${gw}).`);
						plan = { template: `/whatif I play the ${CHIP_NAME[o.chip]} in GW${o.gw}.`, options: { kind: "chip", chip: o.chip, gw: o.gw } };
						break;
					}
					const players = resolve(o.kind === "transfer" ? [o.out, o.in] : [o.player]);
					if (typeof players === "string") return fail(players);
					const mine = await squad();
					const own = o.kind === "transfer" ? o.out : o.player;
					if (mine.length && !mine.includes(own)) return fail(`${players[0].name} isn't in your squad.`);
					if (o.kind === "keep") {
						plan = { template: `/whatif I keep ${label(players[0])} in my squad over the next ${HORIZON} gameweeks.`, options: { kind: "keep", player: players[0] } };
						break;
					}
					if (o.out === o.in) return fail("the player in is the player out.");
					if (mine.includes(o.in)) return fail(`${players[1].name} is already in your squad.`);
					if (!inWindow(o.gw)) return fail(`GW${o.gw} is outside the next ${HORIZON} gameweeks (from GW${gw}).`);
					plan = { template: `/whatif I sell ${label(players[0])} for ${label(players[1])} in GW${o.gw}.`, options: { kind: "transfer", out: players[0], in: players[1], gw: o.gw } };
					break;
				}
				case "explain": {
					const o = spec.options;
					const players = resolve([o.player]);
					if (typeof players === "string") return fail(players);
					const p = players[0];
					let context: string;
					let rec: { rec_id: string; gw: number; role: string } | null = null;
					if (o.against === "recommendation") {
						const latest = latestRecommendation(ctx.sessionManager.getSessionDir(), spec.team_id);
						rec = latest ? { rec_id: latest.rec_id, gw: latest.gw, role: roleIn(latest, p.id) } : null;
						context = rec ? `In my latest recommendation (GW${rec.gw}, rec ${rec.rec_id}) he is ${rec.role}.` : "There is no earlier recommendation for my team, so explain it against my squad.";
					} else {
						const mine = await squad();
						context = mine.length ? `Against my current squad: he is ${mine.includes(p.id) ? "in it" : "not in it"}.` : "Against my current squad.";
					}
					plan = { template: `/explain ${label(p)}. ${context}`, options: { player: p, against: o.against, rec } };
					break;
				}
				case "chips": {
					const o = spec.options;
					if (o.to_gw < o.from_gw) return fail(`the range ends (GW${o.to_gw}) before it starts (GW${o.from_gw}).`);
					if (o.to_gw - o.from_gw + 1 > CHIP_RANGE_MAX) return fail(`a range is at most ${CHIP_RANGE_MAX} gameweeks.`);
					if (gw !== null && o.from_gw < gw) return fail(`the range starts before the next gameweek, GW${gw}.`);
					plan = { template: `/chips GW${o.from_gw} to GW${o.to_gw}`, options: { from_gw: o.from_gw, to_gw: o.to_gw } };
					break;
				}
				case "preferences": {
					const o = spec.options;
					const keep = resolve(o.keep);
					if (typeof keep === "string") return fail(keep);
					const save_chips = [...new Set(o.save_chips)];
					// "Clear all" is /prefs clear. Otherwise the Recommend fields; avoid is left as saved.
					const prefs = o.clear ? DEFAULT_PREFS : { risk: o.risk, max_hits_per_gw: o.max_hits_per_gw, save_chips, keep: keep.map(({ id, name }) => ({ id, name })) };
					plan = { options: { risk: o.risk, max_hits_per_gw: o.max_hits_per_gw, save_chips, keep, clear: o.clear }, prefs };
					break;
				}
			}

			const pending = spec.action === "recommend" ? (plan.options as { pending?: string }).pending : undefined;
			const team = await setTeam(ctx, { teamId: spec.team_id, ft: spec.action === "recommend" ? spec.options.ft : undefined, pending });
			if ("error" in team) return fail(team.error);

			// The team's file is the one set_preferences and /prefs write (writePrefs); an unsaved Recommend's options
			// are this session's own file instead.
			let prefsFile: string | null = null;
			let saved = "";
			try {
				if (spec.action === "recommend" && !spec.options.save) writePrefsFile((prefsFile = runPrefsPath(dataDir(), hash, ctx.sessionManager.getSessionId())), plan.prefs!);
				else if (plan.prefs) saved = describePrefs(writePrefs(dataDir(), hash, plan.prefs));
			} catch (e) {
				return fail(`the preferences could not be written (${(e as Error).message}).`);
			}
			const entry: RunEntry = {
				action: spec.action, title: "", team_id: spec.team_id, team_id_hash: hash, gw, options: plan.options, prefs_file: prefsFile, source: "app", started_at: new Date().toISOString(),
			};
			entry.title = runTitle(entry);
			pi.appendEntry("gaffer.run", entry);
			if (!plan.template) return ctx.ui.notify(`Preferences ${spec.action === "preferences" && spec.options.clear ? "cleared" : "saved"} for ${team.name ?? `team ${spec.team_id}`}:\n${saved}`, "info");
			// The terminal's own template, expanded by Pi.
			pi.sendUserMessage(plan.template, { expandPromptTemplates: true });
		},
	});
}
