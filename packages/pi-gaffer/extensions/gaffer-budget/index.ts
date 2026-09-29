/**
 * gaffer-budget: hard cost caps (ADR 0008, FR-BUD-01). Per session and per UTC day, from the cost
 * Pi records on every assistant message; plus a turn cap per run. Soft-cap steering lands in M5.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { budgetConfig } from "../../src/config.ts";
import { dayCost, sessionCost } from "../../src/budget.ts";

export default function gafferBudget(pi: ExtensionAPI) {
	let turns = 0;
	let aborted = false;

	const record = (ctx: ExtensionContext, capped: false | "session" | "daily" | "turns") => {
		const cfg = budgetConfig();
		const data = {
			session_cost: round(sessionCost(ctx.sessionManager.getEntries())),
			day_cost: round(dayCost(ctx.sessionManager.getSessionDir(), new Date())),
			turn: turns,
			hard: cfg.hard,
			daily: cfg.daily,
			max_turns: cfg.maxTurns,
			capped,
		};
		pi.appendEntry("gaffer.budget", data);
		return data;
	};

	pi.on("agent_start", async () => {
		turns = 0;
		aborted = false;
	});

	// Refuse to start a run once the day's spend is at the cap.
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const { daily } = budgetConfig();
		const spent = dayCost(ctx.sessionManager.getSessionDir(), new Date());
		if (spent < daily) return { action: "continue" };
		record(ctx, "daily");
		ctx.ui.notify(`Daily budget reached: $${spent.toFixed(2)} of $${daily.toFixed(2)} spent today (UTC). Gaffer will not start a new run until tomorrow, or raise GAFFER_BUDGET_DAILY.`, "error");
		return { action: "handled" };
	});

	pi.on("turn_end", async (_event, ctx) => {
		turns++;
		const cfg = budgetConfig();
		const session = sessionCost(ctx.sessionManager.getEntries());
		const day = dayCost(ctx.sessionManager.getSessionDir(), new Date());
		const capped = session >= cfg.hard ? "session" : day >= cfg.daily ? "daily" : turns >= cfg.maxTurns ? "turns" : false;
		record(ctx, capped);
		if (capped && !aborted) {
			aborted = true;
			ctx.abort();
			const why =
				capped === "session"
					? `this session has cost $${session.toFixed(2)}, over the $${cfg.hard.toFixed(2)} cap (GAFFER_BUDGET_HARD)`
					: capped === "daily"
						? `today's spend is $${day.toFixed(2)}, over the $${cfg.daily.toFixed(2)} daily cap (GAFFER_BUDGET_DAILY)`
						: `the run reached ${cfg.maxTurns} turns`;
			ctx.ui.notify(`Gaffer stopped this run: ${why}. Anything above is a partial result.`, "error");
		}
	});
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;
