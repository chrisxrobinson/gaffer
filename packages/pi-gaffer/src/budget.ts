/** Spend accounting from Pi's per-message usage and its `usage` entries (ADR 0008, ADR 0010). */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BudgetConfig } from "./config.ts";

interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
	timestamp?: string;
	message?: { role?: string; timestamp?: number; usage?: { cost?: { total?: number } } };
	usage?: { cost?: { total?: number } };
}

/** An assistant message's cost, or a `usage` entry's: what Pi spends outside the conversation (cache warming, summaries; NFR-COST-05). */
const costOf = (e: EntryLike) =>
	e.type === "message" && e.message?.role === "assistant" ? (e.message.usage?.cost?.total ?? 0) : e.type === "usage" ? (e.usage?.cost?.total ?? 0) : 0;

/** Total cost of every assistant message and `usage` entry in the session file, on all branches: money spent on an abandoned branch is still spent. */
export function sessionCost(entries: readonly EntryLike[]): number {
	return entries.reduce((sum, e) => sum + costOf(e), 0);
}

function sameUtcDay(ms: number, day: Date): boolean {
	return new Date(ms).toISOString().slice(0, 10) === day.toISOString().slice(0, 10);
}

/** Cost of assistant messages and `usage` entries timestamped on `day` (UTC) across every session file under dir. */
export function dayCost(dir: string, day: Date): number {
	let files: string[];
	try {
		files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return 0;
	}
	let sum = 0;
	for (const f of files) {
		let text: string;
		try {
			text = readFileSync(join(dir, f), "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (!line.includes('"assistant"') && !line.startsWith('{"type":"usage"')) continue;
			try {
				const e = JSON.parse(line) as EntryLike;
				const ms = e.message?.timestamp ?? (e.timestamp ? Date.parse(e.timestamp) : Number.NaN);
				if (Number.isFinite(ms) && sameUtcDay(ms, day)) sum += costOf(e);
			} catch {
				/* partial line while being written */
			}
		}
	}
	return sum;
}

/** Whether this session has already been steered at the soft cap (recorded in a gaffer.budget entry). */
export function softCapSteered(entries: readonly EntryLike[]): boolean {
	return entries.some((e) => e.type === "custom" && e.customType === "gaffer.budget" && (e.data as { steered?: boolean } | undefined)?.steered === true);
}

/** The steer message the model gets once the session passes GAFFER_BUDGET_SOFT (FR-BUD-02, ADR 0008). */
export function steerText(session: number, cfg: Pick<BudgetConfig, "soft" | "hard">): string {
	return (
		`Gaffer budget note: this session has cost $${session.toFixed(2)}, past the $${cfg.soft.toFixed(2)} soft cap (GAFFER_BUDGET_SOFT). ` +
		"Wrap up now. If you have the golden path's plan, submit the recommendation with submit_recommendation as your next step; " +
		`if you can't, tell the user briefly where you got to. The run is stopped at $${cfg.hard.toFixed(2)}.`
	);
}
