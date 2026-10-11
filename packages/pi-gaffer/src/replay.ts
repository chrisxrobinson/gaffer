/**
 * Replay a recommendation (NFR-OBS-01): find it in the session logs by rec_id, rerun
 * `gaffer_lib validate` on the stored request against the stored snapshot, and compare every
 * recomputed field with what was stored. No Pi or TypeBox imports: plain `node` runs this.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gateCommand } from "./derive.ts";
import { lastJsonLine, type SandboxSession, sandboxRun } from "./sandbox.ts";

/** Fields the harness adds around gaffer_lib's answer; everything else must be reproduced. */
const HARNESS_FIELDS = ["schema", "rec_id", "created_at", "team_id_hash", "model", "gaffer_lib", "pi", "snapshot", "validation"];

export interface StoredRun {
	file: string;
	recommendation: Record<string, unknown>;
	validation: { rec_id: string; snapshot_path: string; ft: number | null; pending: [number, number][]; request: unknown };
}

/** Scan the session JSONL files for the `gaffer.recommendation` and passing `gaffer.validation` entries of `recId`. */
export function findRun(sessionsDir: string, recId: string): StoredRun | undefined {
	const files = (readdirSync(sessionsDir, { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl"));
	for (const f of files) {
		const text = readFileSync(join(sessionsDir, f), "utf8");
		if (!text.includes(recId)) continue;
		let recommendation: StoredRun["recommendation"] | undefined;
		let validation: StoredRun["validation"] | undefined;
		for (const line of text.split("\n")) {
			if (!line.includes(recId)) continue;
			const e = JSON.parse(line) as { type?: string; customType?: string; data?: Record<string, unknown> };
			if (e.type !== "custom" || e.data?.rec_id !== recId) continue;
			if (e.customType === "gaffer.recommendation") recommendation = e.data;
			if (e.customType === "gaffer.validation" && e.data.passed === true) validation = e.data as unknown as StoredRun["validation"];
		}
		if (recommendation && validation) return { file: join(sessionsDir, f), recommendation, validation };
	}
	return undefined;
}

/** Leaf paths at which two JSON values differ. */
export function differences(a: unknown, b: unknown, path = ""): string[] {
	if (Object.is(a, b)) return [];
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return [`${path || "/"}: stored ${JSON.stringify(a)} ≠ replayed ${JSON.stringify(b)}`];
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	return [...keys].flatMap((k) => differences((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}/${k}`));
}

function countNumbers(v: unknown): number {
	if (typeof v === "number") return 1;
	if (typeof v !== "object" || v === null) return 0;
	return Object.values(v).reduce((n: number, x) => n + countNumbers(x), 0);
}

export interface ReplayResult {
	reproduced: boolean;
	/** How many numbers in the recommendation and its validation block were compared. */
	numbers: number;
	differences: string[];
	gaffer_lib: { stored: unknown; now: unknown };
}

export async function replay(run: StoredRun, sandbox: SandboxSession): Promise<ReplayResult> {
	const v = run.validation;
	const { exitCode, output } = await sandboxRun(sandbox, gateCommand(v.snapshot_path, { ft: v.ft, pending: v.pending }), { timeoutS: 90, stdin: JSON.stringify(v.request) });
	const doc = lastJsonLine(output) as { valid?: boolean; gaffer_lib?: string; recommendation?: Record<string, unknown>; validation?: Record<string, unknown>; error?: string } | undefined;
	if (!doc?.valid || !doc.recommendation) throw new Error(`gaffer_lib validate did not reproduce a valid recommendation (exit ${exitCode}): ${doc?.error ?? JSON.stringify((doc as { errors?: unknown })?.errors) ?? output.slice(-300)}`);
	const stored = Object.fromEntries(Object.entries(run.recommendation).filter(([k]) => !HARNESS_FIELDS.includes(k)));
	const { attempts: _a, ...storedValidation } = run.recommendation.validation as Record<string, unknown>;
	const diffs = [...differences(stored, doc.recommendation), ...differences(storedValidation, doc.validation, "/validation")];
	return { reproduced: diffs.length === 0, numbers: countNumbers(stored) + countNumbers(storedValidation), differences: diffs, gaffer_lib: { stored: run.recommendation.gaffer_lib, now: doc.gaffer_lib } };
}
