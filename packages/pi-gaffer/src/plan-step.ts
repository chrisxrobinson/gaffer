/**
 * The golden-path step for the Gaffer App (docs/ui §7–8): the `bash` call that runs `gaffer_lib run` gets a
 * summary of the plan it wrote in its result's `details` (`{step: "plan", plans, solver, scenarios}`), so the App
 * can label and summarise the step without parsing its output; and the progress lines `gaffer_lib run` prints
 * while it works ("progress: main solve 31 s of 43 s"), which the UIs see streaming, are taken out of the result
 * the model reads, so its context is what it was before them.
 */

export const PROGRESS_PREFIX = "progress: ";

export function stripProgress(text: string): string {
	return text
		.split("\n")
		.filter((l) => !l.startsWith(PROGRESS_PREFIX))
		.join("\n");
}

/** The plan file a golden-path command writes (its --out), or undefined if the command isn't `gaffer_lib run`. */
export function goldenPathOut(command: string): string | undefined {
	if (!/\bgaffer_lib run\b/.test(command)) return undefined;
	const m = /--out[ =](?:'([^']*)'|"([^"]*)"|(\S+))/.exec(command);
	return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

export interface PlanStep {
	step: "plan";
	file: string;
	gw: number | null;
	snapshot_id: string | null;
	plans: number;
	valid_plans: number;
	solver: { status: string | null; gap: number | null; time_s: number | null; timed_out: boolean | null };
	scenarios: { evaluated: number; total: number };
	expected_points_gw: number | null;
	transfers: number | null;
	odds_available: boolean | null;
}

interface PlanDoc {
	schema?: string;
	gw?: number;
	snapshot_id?: string;
	solver?: { status?: string; gap?: number | null; time_s?: number; timed_out?: boolean };
	plans?: { validation?: { valid?: boolean }; expected_points_gw?: number; transfers?: unknown[] }[];
	chip_scenarios?: { evaluated?: boolean }[];
	team_strength?: { odds_available?: boolean };
}

/** The tag for a `gaffer.plan/1` document, or undefined if it isn't one. */
export function planStep(file: string, doc: unknown): PlanStep | undefined {
	const d = doc as PlanDoc;
	if (d?.schema !== "gaffer.plan/1" || !Array.isArray(d.plans)) return undefined;
	const first = d.plans[0];
	return {
		step: "plan",
		file,
		gw: d.gw ?? null,
		snapshot_id: d.snapshot_id ?? null,
		plans: d.plans.length,
		valid_plans: d.plans.filter((p) => p.validation?.valid).length,
		solver: { status: d.solver?.status ?? null, gap: d.solver?.gap ?? null, time_s: d.solver?.time_s ?? null, timed_out: d.solver?.timed_out ?? null },
		scenarios: { evaluated: (d.chip_scenarios ?? []).filter((c) => c.evaluated).length, total: (d.chip_scenarios ?? []).length },
		expected_points_gw: first?.expected_points_gw ?? null,
		transfers: Array.isArray(first?.transfers) ? first.transfers.length : null,
		odds_available: d.team_strength?.odds_available ?? null,
	};
}
