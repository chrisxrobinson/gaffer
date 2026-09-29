/** Spend accounting from Pi's per-message usage (ADR 0008). */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface EntryLike {
	type: string;
	timestamp?: string;
	message?: { role?: string; timestamp?: number; usage?: { cost?: { total?: number } } };
}

const costOf = (e: EntryLike) => (e.type === "message" && e.message?.role === "assistant" ? (e.message.usage?.cost?.total ?? 0) : 0);

/** Total cost of every assistant message in the session file, on all branches: money spent on an abandoned branch is still spent. */
export function sessionCost(entries: readonly EntryLike[]): number {
	return entries.reduce((sum, e) => sum + costOf(e), 0);
}

function sameUtcDay(ms: number, day: Date): boolean {
	return new Date(ms).toISOString().slice(0, 10) === day.toISOString().slice(0, 10);
}

/** Cost of assistant messages timestamped on `day` (UTC) across every session file under dir. */
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
			if (!line.includes('"assistant"')) continue;
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
