/**
 * gaffer-budget: cost caps (ADR 0008). Per session and per UTC day, from the cost Pi records on every
 * assistant message; plus a turn cap per run (FR-BUD-01). Above the soft cap the model is steered,
 * once per session, to wrap up and submit (FR-BUD-02).
 */
import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { budgetConfig, sessionsRoot } from "../../src/config.ts";
import { dayCost, sessionCost, softCapSteered, steerText } from "../../src/budget.ts";

export const STEER_TYPE = "gaffer.steer";

/** Whether the run goes on after this turn: it called tools, and none of them was the final submission. */
function runContinues(event: TurnEndEvent): boolean {
	const content = (event.message as { content?: { type: string; name?: string }[] }).content ?? [];
	const calls = content.filter((c) => c.type === "toolCall");
	return calls.length > 0 && !calls.some((c) => c.name === "submit_recommendation");
}

export default function gafferBudget(pi: ExtensionAPI) {
	let turns = 0;
	let aborted = false;

	const record = (ctx: ExtensionContext, capped: false | "session" | "daily" | "turns", extra: { steered?: true } = {}) => {
		const cfg = budgetConfig();
		const data = {
			session_cost: round(sessionCost(ctx.sessionManager.getEntries())),
			day_cost: round(dayCost(sessionsRoot(ctx.sessionManager.getSessionDir()), new Date())),
			turn: turns,
			soft: cfg.soft,
			hard: cfg.hard,
			daily: cfg.daily,
			max_turns: cfg.maxTurns,
			capped,
			...extra,
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
		const spent = dayCost(sessionsRoot(ctx.sessionManager.getSessionDir()), new Date());
		if (spent < daily) return { action: "continue" };
		record(ctx, "daily");
		ctx.ui.notify(`Daily budget reached: $${spent.toFixed(2)} of $${daily.toFixed(2)} spent today (UTC). Gaffer will not start a new run until tomorrow, or raise GAFFER_BUDGET_DAILY.`, "error");
		return { action: "handled" };
	});

	pi.on("turn_end", async (event, ctx) => {
		turns++;
		const cfg = budgetConfig();
		const entries = ctx.sessionManager.getEntries();
		const session = sessionCost(entries);
		const day = dayCost(sessionsRoot(ctx.sessionManager.getSessionDir()), new Date());
		const capped = session >= cfg.hard ? "session" : day >= cfg.daily ? "daily" : turns >= cfg.maxTurns ? "turns" : false;
		// FR-BUD-02: one steer per session, delivered before the model's next call. Not when the run is
		// ending anyway (no tool calls, or the submission), where a steer would start another turn.
		const steer = !capped && session >= cfg.soft && !softCapSteered(entries) && runContinues(event);
		record(ctx, capped, steer ? { steered: true } : {});
		if (steer) pi.sendMessage({ customType: STEER_TYPE, content: steerText(session, cfg), display: true }, { deliverAs: "steer" });
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
