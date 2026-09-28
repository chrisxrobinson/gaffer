/**
 * gaffer-core: turns the coding agent into an FPL agent (ARCHITECTURE §1).
 * Replaces the coding preamble while keeping skills, injects fpl_context and user_preferences
 * sections, restricts the active tools, blocks the user's `!` shell, and adds /team.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dataDir, GAFFER_TOOLS, idSalt } from "../../src/config.ts";
import { FplClient, FplNotFoundError } from "../../src/http.ts";
import { fplContextSection, GAFFER_PREAMBLE, userPreferencesSection } from "../../src/prompt.ts";
import { fplState, type TeamEntry } from "../../src/session.ts";
import { hashTeamId } from "../../src/snapshot.ts";
import { SnapshotStore } from "../../src/store.ts";

export const USER_SHELL_BLOCKED = "Shell commands are disabled in Gaffer: the harness holds credentials. Ask Gaffer instead; its code runs in the sandbox.";

export default function gafferCore(pi: ExtensionAPI) {
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
			fpl_context: fplContextSection(state, new SnapshotStore(dataDir()), Date.now()),
			user_preferences: userPreferencesSection(dataDir(), teamHash),
		};
	});

	// `!cmd` / `!!cmd` would be a shell in the harness container, next to the LLM key.
	pi.on("user_bash", async (_event, ctx) => {
		ctx.ui.notify(USER_SHELL_BLOCKED, "warning");
		return { result: { output: USER_SHELL_BLOCKED, exitCode: 1, cancelled: false, truncated: false } };
	});

	pi.registerCommand("team", {
		description: "Set your FPL team ID for this session: /team <id>",
		handler: async (args, ctx) => {
			const raw = args.trim().split(/\s+/)[0] ?? "";
			if (!/^\d{1,10}$/.test(raw)) {
				ctx.ui.notify("Usage: /team <id> — your FPL team ID is the number in the URL of your Points page.", "warning");
				return;
			}
			const teamId = Number(raw);
			let name: string | undefined;
			let unreachable: string | undefined;
			try {
				const r = await new FplClient({ timeoutMs: 8000 }).get<{ name?: string }>(`entry/${teamId}/`, { fresh: true, signal: AbortSignal.timeout(9500) });
				name = r.json.name;
			} catch (e) {
				if (e instanceof FplNotFoundError) {
					ctx.ui.notify(`FPL team ${teamId} not found. Check the ID (the number in the URL of your Points page).`, "error");
					return;
				}
				unreachable = (e as Error).message; // keep the ID; fpl_snapshot will report any problem
			}
			pi.appendEntry("gaffer.team", { team_id: teamId, team_name: name } satisfies TeamEntry);
			if (unreachable) ctx.ui.notify(`Team ID ${teamId} set, but FPL could not be reached to confirm it (${unreachable}).`, "warning");
			else ctx.ui.notify(`Team set: ${name ?? "?"} (ID ${teamId}).`, "info");
		},
	});
}
