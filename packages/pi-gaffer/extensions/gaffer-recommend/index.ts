/**
 * gaffer-recommend: the validated final answer and the user's preferences (ADR 0003, ADR 0004).
 *
 * - `submit_recommendation` is the single enforcement point: schema, `gaffer_lib validate` in the
 *   sandbox against the snapshot the run used, every number recomputed, at most 2 retries. A valid
 *   recommendation is stored (`gaffer.recommendation`, the ledger index), rendered, and ends the run
 *   with no further model turn. After 3 failures the user gets a clear failure, never a plan.
 * - `set_preferences` persists risk mode, chips to save, players to keep or avoid and max hits.
 */
import { defineTool, type ExtensionAPI, type ExtensionContext, type Theme, VERSION } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { dataDir } from "../../src/config.ts";
import { describePrefs } from "../../src/prefs.ts";
import { appendLedger, type GateError, MAX_ATTEMPTS, rejectionText, runGate } from "../../src/recommend.ts";
import { failureLines, type Paint, recommendationLines, type SubmitFailure, wrap } from "../../src/render.ts";
import { sharedSandboxSession } from "../../src/sandbox.ts";
import { Chip, type Recommendation, Risk, Submission } from "../../src/schema/recommendation.ts";
import { fplState, latestCustom, type SnapshotEntry } from "../../src/session.ts";
import { savePreferences } from "../../src/team-prefs.ts";

export type SubmitDetails = { recommendation: Recommendation } | SubmitFailure;

const themed = (theme: Theme): Paint => ({
	title: (s) => theme.bold(theme.fg("accent", s)),
	label: (s) => theme.bold(theme.fg("accent", s)),
	dim: (s) => theme.fg("muted", s),
	good: (s) => theme.fg("success", s),
	warn: (s) => theme.fg("warning", s),
	bad: (s) => theme.fg("error", s),
});

/**
 * Lines for a submit_recommendation result in the TUI. A rejected attempt has no details (Pi builds
 * the error result), so anything that isn't a recommendation or a final failure is shown as its
 * text; and nothing here may throw, because an exception in a renderer ends the Pi process.
 */
export function submitResultLines(result: { content?: unknown[]; details?: unknown }, width: number, paint: Paint): string[] {
	const text = () => (result.content ?? []).flatMap((c) => (typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text.split("\n") : [])).flatMap((l) => wrap(l, Math.max(20, width)));
	try {
		const d = result.details as Partial<{ recommendation: Recommendation }> & Partial<SubmitFailure> | undefined;
		if (d?.recommendation) return recommendationLines(d.recommendation, width, paint);
		if (d?.failed) return failureLines(d as SubmitFailure, width, paint);
		return text().map((l) => paint.warn(l));
	} catch (e) {
		return [paint.bad(`(could not draw the recommendation: ${(e as Error).message}; the text follows)`), ...text()];
	}
}

/** The snapshot the run used: the latest one for the session's team. */
function runSnapshot(ctx: ExtensionContext): SnapshotEntry | undefined {
	const branch = ctx.sessionManager.getBranch();
	const snap = latestCustom<SnapshotEntry>(branch, "gaffer.snapshot");
	return snap && snap.team_id === fplState(branch).teamId ? snap : undefined;
}

export default function gafferRecommend(pi: ExtensionAPI) {
	// Failed submissions in the current run, and which calls reached execute (the rest failed Pi's own
	// argument check). One extension instance per session, so plain variables are enough.
	let failures = 0;
	const executed = new Set<string>();
	pi.on("agent_start", async () => {
		failures = 0;
		executed.clear();
	});

	const giveUp = (ctx: ExtensionContext, errors: GateError[]): SubmitFailure => {
		ctx.ui.notify(`Gaffer could not produce a valid recommendation: ${MAX_ATTEMPTS} submissions failed validation, so no plan is shown. Last error: ${errors[0]?.message ?? "unknown"}`, "error");
		return { failed: true, attempts: failures, errors };
	};

	pi.registerTool(
		defineTool({
			name: "submit_recommendation",
			label: "Recommendation",
			description:
				"Submit the final recommendation for the next GW: transfers, starting XI and bench, captain and vice, chip, a 4-GW plan, a rationale for each decision and a summary. " +
				"This is the only way a plan becomes final. Gaffer checks it against FPL's rules, the user's preferences and the solver's best plan, using the latest snapshot and the plan file the golden path wrote, " +
				"and recomputes every number: you supply decisions and words (figures you quote are optional and are corrected). " +
				`If it is rejected you get the reasons and may resubmit; there are ${MAX_ATTEMPTS} attempts in all. On success the recommendation is saved and shown to the user and the run ends, so make it your last action and say nothing after it.`,
			promptSnippet: "Submit the final recommendation; it is validated, recomputed, saved and shown",
			parameters: Submission,
			executionMode: "sequential",
			async execute(toolCallId, params, signal, _onUpdate, ctx) {
				executed.add(toolCallId);
				const attempt = failures + 1;
				const snapshot = runSnapshot(ctx);
				const outcome = await runGate(params, snapshot, attempt, {
					sandbox: sharedSandboxSession(),
					dataDir: dataDir(),
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
					piVersion: VERSION,
					signal,
				});
				if (outcome.ok) {
					const rec = outcome.recommendation;
					pi.appendEntry("gaffer.validation", { rec_id: rec.rec_id, attempt, passed: true, stage: "validate", errors: [], ...outcome.inputs, validation: rec.validation });
					pi.appendEntry("gaffer.recommendation", rec);
					appendLedger(dataDir(), rec, ctx.sessionManager.getSessionFile());
					return { content: [{ type: "text", text: recommendationLines(rec).join("\n") }], details: { recommendation: rec } satisfies SubmitDetails, terminate: true };
				}
				failures = attempt;
				pi.appendEntry("gaffer.validation", { attempt, passed: false, stage: outcome.stage, errors: outcome.errors, snapshot_id: snapshot?.snapshot_id ?? null, ...outcome.inputs });
				if (attempt < MAX_ATTEMPTS) throw new Error(rejectionText(outcome.errors, attempt));
				const failure = giveUp(ctx, outcome.errors);
				return { content: [{ type: "text", text: failureLines(failure).join("\n") }], details: failure satisfies SubmitDetails, terminate: true };
			},
			renderResult(result, _options, theme) {
				return { invalidate() {}, render: (width: number) => submitResultLines(result, width, themed(theme)) };
			},
		}),
	);

	// A submission that fails Pi's own argument check never reaches execute, but it is still a failed
	// attempt (FR-REC-08): count it, record it, and stop the run at the third.
	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName !== "submit_recommendation" || !event.isError || executed.has(event.toolCallId)) return;
		failures++;
		const text = (event.result as { content?: { text?: string }[] } | undefined)?.content?.map((c) => c.text ?? "").join("") ?? "";
		const errors: GateError[] = [{ code: "SCHEMA", message: text.split("\n\nReceived arguments:")[0].slice(0, 1500) }];
		pi.appendEntry("gaffer.validation", { attempt: failures, passed: false, stage: "schema", errors, snapshot_id: runSnapshot(ctx)?.snapshot_id ?? null });
		if (failures >= MAX_ATTEMPTS) {
			giveUp(ctx, errors);
			ctx.abort();
		}
	});

	pi.registerTool(
		defineTool({
			name: "set_preferences",
			label: "Preferences",
			description:
				"Save the user's standing preferences for their team, so they needn't restate them: risk mode, chips to save, players to keep or avoid, and the most hits to take in a GW. " +
				"Only fields you pass are changed; a list you pass replaces the saved list (pass [] to clear it). Call it when the user states a preference that should last beyond this conversation. " +
				"Preferences are passed to the golden path with --prefs and enforced when a recommendation is submitted. They are for the team set with /team.",
			promptSnippet: "Save the user's standing preferences (risk, chips to save, keep/avoid, max hits)",
			parameters: Type.Object({
				risk: Type.Optional(Risk),
				save_chips: Type.Optional(Type.Array(Chip, { maxItems: 4, description: "Chips not to play until the user says otherwise." })),
				keep: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 15, description: "Player ids the user wants to keep in the squad." })),
				avoid: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 50, description: "Player ids the user doesn't want bought." })),
				max_hits_per_gw: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 15 }), Type.Null()], { description: "Most hits (−4 each) to take in one GW; null for no limit." })),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const saved = savePreferences(ctx, params);
				return { content: [{ type: "text", text: `Preferences saved for this team:\n${describePrefs(saved.prefs)}\nFile (readable in the sandbox): ${saved.path}\nThe golden path must be run with these preferences: use the command from the fpl_snapshot summary exactly, adding only \` --prefs ${saved.path}\` if it isn't already there (never add --ft or --pending yourself), then plan from the new /work/plan.json.` }], details: saved.prefs };
			},
		}),
	);
}
