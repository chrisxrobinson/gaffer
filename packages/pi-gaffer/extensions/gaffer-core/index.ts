/**
 * gaffer-core: turns the coding agent into an FPL agent (ARCHITECTURE §1).
 * Replaces the coding preamble while keeping skills, injects fpl_context and user_preferences
 * sections, restricts the active tools, blocks the user's `!` shell, and adds /team, /prefs,
 * /export-rec, /usage and /scorecard. The terminal's identity and command surface are in ui.ts (ADR 0013);
 * the session and run locks in locks.ts, and the Gaffer App's /run in run.ts (ADR 0014).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { budgetConfig, dataDir, fplNow, GAFFER_TOOLS, idSalt, sessionsRoot } from "../../src/config.ts";
import { FplClient, FplNotFoundError } from "../../src/http.ts";
import { readOutcomes, scorecard, scorecardLines } from "../../src/outcomes.ts";
import { fplContextSection, GAFFER_PREAMBLE, userPreferencesSection } from "../../src/prompt.ts";
import { DEFAULT_PREFS, describePrefs, parsePrefsArgs, readPrefs, writePrefs } from "../../src/prefs.ts";
import type { Recommendation } from "../../src/schema/recommendation.ts";
import { fplState, latestCustom, type TeamEntry } from "../../src/session.ts";
import { activePrefsFile, savePreferences, sessionTeamHash } from "../../src/team-prefs.ts";
import { hashTeamId } from "../../src/snapshot.ts";
import { parseTeamArgs } from "../../src/team-args.ts";
import { SnapshotStore } from "../../src/store.ts";
import { usageLines, usageNow } from "../../src/usage.ts";
import { gafferLocks } from "./locks.ts";
import { registerRun, type SetTeam } from "./run.ts";
import { gafferUi } from "./ui.ts";

export const USER_SHELL_BLOCKED = "Shell commands are disabled in Gaffer: the harness holds credentials. Ask Gaffer instead; its code runs in the sandbox.";

export default function gafferCore(pi: ExtensionAPI) {
	gafferUi(pi);
	const guard = gafferLocks(pi);

	pi.on("session_start", async () => {
		// Second line of defence after the CLI --tools allowlist (S1: SDK hosts must bindExtensions for this to run).
		const available = new Set(pi.getAllTools().map((t) => t.name));
		pi.setActiveTools(GAFFER_TOOLS.filter((t) => available.has(t)));
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const o = event.systemPromptOptions;
		o.customPrompt = GAFFER_PREAMBLE;
		o.contextFiles = [];
		const state = fplState(ctx.sessionManager.getBranch());
		let teamHash: string | undefined;
		try {
			teamHash = state.teamId ? hashTeamId(state.teamId, idSalt()) : undefined;
		} catch {
			teamHash = undefined;
		}
		o.sections = {
			...o.sections,
			fpl_context: fplContextSection(state, new SnapshotStore(dataDir()), fplNow()),
			user_preferences: userPreferencesSection(dataDir(), teamHash, teamHash ? activePrefsFile(ctx.sessionManager.getBranch(), dataDir(), teamHash) : undefined),
		};
	});

	// `!cmd` / `!!cmd` would be a shell in the harness container, next to the LLM key.
	pi.on("user_bash", async (_event, ctx) => {
		ctx.ui.notify(USER_SHELL_BLOCKED, "warning");
		return { result: { output: USER_SHELL_BLOCKED, exitCode: 1, cancelled: false, truncated: false } };
	});

	// /team's effect, shared with /run: check the team exists, then record it (each one replaces the previous:
	// options not restated are cleared).
	const setTeam: SetTeam = async (ctx, { teamId, ft, pending }) => {
		const why = guard.refusal(ctx);
		if (why) return { error: why };
		let name: string | undefined;
		let unreachable: string | undefined;
		try {
			const r = await new FplClient({ timeoutMs: 8000 }).get<{ name?: string }>(`entry/${teamId}/`, { fresh: true, signal: AbortSignal.timeout(9500) });
			name = r.json.name;
		} catch (e) {
			if (e instanceof FplNotFoundError) return { error: `FPL team ${teamId} not found. Check the ID (the number in the URL of your Points page).` };
			unreachable = (e as Error).message; // keep the ID; fpl_snapshot will report any problem
		}
		pi.appendEntry("gaffer.team", { team_id: teamId, team_name: name, ...(ft !== undefined && { ft }), ...(pending && { pending }) } satisfies TeamEntry);
		return { name, unreachable };
	};

	pi.registerCommand("team", {
		description: "Set your FPL team for this session: /team <id> [--ft N] [--pending \"OUT>IN, ...\"]",
		handler: async (args, ctx) => {
			const parsed = parseTeamArgs(args);
			if ("error" in parsed) {
				ctx.ui.notify(parsed.error, "warning");
				return;
			}
			const { teamId, ft, pending } = parsed;
			const set = await setTeam(ctx, parsed);
			if ("error" in set) return ctx.ui.notify(set.error, "error");
			const extra = [ft !== undefined ? `free transfers ${ft} (yours)` : "", pending ? `pending ${pending}` : ""].filter(Boolean).join("; ");
			if (set.unreachable) ctx.ui.notify(`Team ID ${teamId} set${extra ? ` (${extra})` : ""}, but FPL could not be reached to confirm it (${set.unreachable}).`, "warning");
			else ctx.ui.notify(`Team set: ${set.name ?? "?"} (ID ${teamId})${extra ? `; ${extra}` : ""}.`, "info");
		},
	});

	registerRun(pi, guard, setTeam);

	pi.registerCommand("prefs", {
		description: "Show or change your saved preferences: /prefs [risk=… save_chips=… keep=… avoid=… max_hits=…] | /prefs clear",
		handler: async (args, ctx) => {
			const parsed = parsePrefsArgs(args);
			if ("error" in parsed) return ctx.ui.notify(parsed.error, "warning");
			let hash: string | undefined;
			try {
				hash = sessionTeamHash(ctx);
			} catch (e) {
				return ctx.ui.notify((e as Error).message, "error");
			}
			if (!hash) return ctx.ui.notify("Set your team first with /team <id>: preferences are saved per team.", "warning");
			try {
				if ("show" in parsed) return ctx.ui.notify(`Your saved preferences:\n${describePrefs(readPrefs(dataDir(), hash))}`, "info");
				const prefs = "clear" in parsed ? writePrefs(dataDir(), hash, DEFAULT_PREFS) : savePreferences(ctx, { ...parsed.patch, keep: parsed.keep, avoid: parsed.avoid }).prefs;
				ctx.ui.notify(`Preferences saved:\n${describePrefs(prefs)}`, "info");
			} catch (e) {
				ctx.ui.notify(`Preferences not saved: ${(e as Error).message}`, "error");
			}
		},
	});

	// Not "/export": that is Pi's own built-in (session to HTML), which the TUI handles before any extension command.
	pi.registerCommand("export-rec", {
		description: "Write the latest recommendation's JSON to /data/exports/ and print the path",
		handler: async (_args, ctx) => {
			const rec = latestCustom<Recommendation>(ctx.sessionManager.getBranch(), "gaffer.recommendation");
			if (!rec) return ctx.ui.notify("There is no recommendation in this session yet. Ask for one first (for example /gw).", "warning");
			const dir = join(dataDir(), "exports");
			const file = join(dir, `${rec.rec_id}.json`);
			try {
				mkdirSync(dir, { recursive: true });
				writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
			} catch (e) {
				return ctx.ui.notify(`Export failed: ${(e as Error).message}`, "error");
			}
			ctx.ui.notify(`GW${rec.gw} recommendation ${rec.rec_id} exported to ${file}`, "info");
		},
	});

	pi.registerCommand("usage", {
		description: "Tokens, cost, tools and latency for this session, and today's spend against the caps",
		handler: async (_args, ctx) => {
			try {
				const { session, today } = usageNow(ctx.sessionManager, sessionsRoot(ctx.sessionManager.getSessionDir()));
				ctx.ui.notify(usageLines(session, today, budgetConfig()).join("\n"), "info");
			} catch (e) {
				ctx.ui.notify(`Usage could not be read: ${(e as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("scorecard", {
		description: "Season to date: Gaffer's recommendations vs your actual points vs the B0/B1 baselines",
		handler: async (_args, ctx) => {
			let hash: string | undefined;
			try {
				hash = sessionTeamHash(ctx);
			} catch (e) {
				return ctx.ui.notify((e as Error).message, "error");
			}
			if (!hash) return ctx.ui.notify("Set your team first with /team <id>: the scorecard is per team.", "warning");
			try {
				ctx.ui.notify(scorecardLines(scorecard(readOutcomes(dataDir()), hash)).join("\n"), "info");
			} catch (e) {
				ctx.ui.notify(`The scorecard could not be read: ${(e as Error).message}`, "error");
			}
		},
	});
}
