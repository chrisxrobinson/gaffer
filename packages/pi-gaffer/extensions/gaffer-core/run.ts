/**
 * `/run {json}`: the Gaffer App's structured start (ADR 0014). The bridge builds the JSON; the terminal never
 * offers it (it isn't in the command allowlist). It validates the JSON, sets the team (as /team does, with the
 * FT count and transfers already made), writes the options as the team's preferences or as this session's own,
 * records a `gaffer.run` entry, and starts the run with the same /gw template the terminal uses, so both UIs
 * exercise one workflow and the evals cover both.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { budgetConfig, dataDir, fplNow, idSalt, sessionsRoot } from "../../src/config.ts";
import { dayCost } from "../../src/budget.ts";
import { fplBootstrap, gwInfo, playerNames } from "../../src/app-data.ts";
import { FplClient } from "../../src/http.ts";
import { runPrefsPath, writePrefs, writePrefsFile } from "../../src/prefs.ts";
import { Chip, Risk } from "../../src/schema/recommendation.ts";
import type { RunEntry } from "../../src/session.ts";
import { hashTeamId } from "../../src/snapshot.ts";
import { SnapshotStore } from "../../src/store.ts";
import type { SessionGuard } from "./locks.ts";

export const RunSpec = Type.Object(
	{
		action: Type.Literal("recommend"),
		team_id: Type.Integer({ minimum: 1, maximum: 9_999_999_999 }),
		options: Type.Object(
			{
				risk: Risk,
				max_hits_per_gw: Type.Union([Type.Integer({ minimum: 0, maximum: 15 }), Type.Null()]),
				save_chips: Type.Array(Chip, { maxItems: 4 }),
				keep: Type.Array(Type.Integer({ minimum: 1, maximum: 99_999 }), { maxItems: 15 }),
				ft: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
				pending: Type.Optional(Type.String({ minLength: 3, maxLength: 200, pattern: "^[^>,;]+>[^>,;]+(\\s*[,;]\\s*[^>,;]+>[^>,;]+)*$" })),
				save: Type.Boolean(),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
const check = Compile(RunSpec);

/** /team's effect (gaffer-core): a `gaffer.team` entry, after checking the team exists. */
export type SetTeam = (ctx: ExtensionContext, team: { teamId: number; ft?: number; pending?: string }) => Promise<{ name?: string; unreachable?: string } | { error: string }>;

export function registerRun(pi: ExtensionAPI, guard: SessionGuard, setTeam: SetTeam) {
	pi.registerCommand("run", {
		description: "The Gaffer App's structured start: /run {\"action\":\"recommend\",\"team_id\":N,\"options\":{…}}",
		handler: async (args, ctx) => {
			const fail = (why: string) => ctx.ui.notify(`Run not started: ${why}`, "error");
			let spec: unknown;
			try {
				spec = JSON.parse(args);
			} catch {
				return fail("the request isn't valid JSON.");
			}
			if (!check.Check(spec)) {
				const e = [...check.Errors(spec)][0];
				return fail(`${e?.instancePath || "/"} ${e?.message ?? "is invalid"}.`);
			}
			const why = guard.refusal(ctx) ?? guard.runBusy(ctx);
			if (why) return fail(why);
			const { daily } = budgetConfig();
			const spent = dayCost(sessionsRoot(ctx.sessionManager.getSessionDir()), new Date());
			if (spent >= daily) return fail(`today's spend is $${spent.toFixed(2)} of the $${daily.toFixed(2)} daily cap. New runs can start after midnight UTC.`);

			const o = spec.options;
			let gw: number | null = null;
			let keep: { id: number; name: string }[] = [];
			try {
				const b = await fplBootstrap(new SnapshotStore(dataDir()), new FplClient({ timeoutMs: 8000 }), fplNow(), AbortSignal.timeout(9500));
				gw = gwInfo(b).next;
				const named = playerNames(b, o.keep);
				const unknown = o.keep.filter((_, i) => !named[i]);
				if (unknown.length) return fail(`FPL has no player with id ${unknown.join(", ")}.`);
				keep = named.filter((p) => p !== undefined);
			} catch (e) {
				if (o.keep.length) return fail(`FPL could not be reached to check the players to keep (${(e as Error).message}).`);
			}
			const pending = o.pending?.split(/[,;]/).map((x) => x.trim()).filter(Boolean).join(", ");
			const team = await setTeam(ctx, { teamId: spec.team_id, ft: o.ft, pending });
			if ("error" in team) return fail(team.error);

			const hash = hashTeamId(spec.team_id, idSalt());
			const prefs = { risk: o.risk, save_chips: [...new Set(o.save_chips)], keep, max_hits_per_gw: o.max_hits_per_gw };
			let prefsFile: string | null = null;
			try {
				if (o.save) writePrefs(dataDir(), hash, prefs);
				else writePrefsFile((prefsFile = runPrefsPath(dataDir(), hash, ctx.sessionManager.getSessionId())), prefs);
			} catch (e) {
				return fail(`the preferences could not be written (${(e as Error).message}).`);
			}
			pi.appendEntry("gaffer.run", {
				action: spec.action, team_id: spec.team_id, team_id_hash: hash, gw, options: { ...o, ...(pending && { pending }), keep }, prefs_file: prefsFile, source: "app", started_at: new Date().toISOString(),
			} satisfies RunEntry);
			// The same template as the terminal's /gw, expanded by Pi.
			pi.sendUserMessage("/gw", { expandPromptTemplates: true });
		},
	});
}
