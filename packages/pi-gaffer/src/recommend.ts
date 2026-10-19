/**
 * The single enforcement point (ADR 0003, ARCHITECTURE §2.2 step 4): what `submit_recommendation`
 * does with a submission.
 *
 * 1. The TypeBox schema (Pi checks the tool arguments; this checks again, for hosts that don't).
 * 2. `python -m gaffer_lib validate --request -` in the sandbox, against the snapshot the run used,
 *    with the `--ft` and `--pending` that snapshot was taken with: the rules, the user's
 *    preferences, the finalise flag, the distance from the solver's best plan, and every number
 *    recomputed. The request goes in on stdin, never through a file in /work.
 * 3. The harness adds what only it knows (rec_id, time, team hash, model, snapshot), checks the
 *    result against the `gaffer.recommendation/1` schema, and stores it.
 *
 * The FPL arithmetic all lives in gaffer_lib; nothing here computes a point or a price.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Compile } from "typebox/compile";
import { gateCommand } from "./derive.ts";
import { type Preferences, readPrefs, readPrefsFile } from "./prefs.ts";
import { lastJsonLine, type SandboxSession, sandboxReadFile, sandboxRun } from "./sandbox.ts";
import { Recommendation, SCHEMA_ID, Submission } from "./schema/recommendation.ts";
import type { SnapshotEntry } from "./session.ts";
import { FINALISE_WINDOW_MS } from "./snapshot.ts";

/** One submission plus 2 retries (FR-REC-08). */
export const MAX_ATTEMPTS = 3;
export const DEFAULT_PLAN_FILE = "/work/plan.json";
const MAX_PLAN_BYTES = 2_000_000;

export interface GateError {
	code: string;
	message: string;
	gw?: number;
}

/** What `gaffer_lib validate --request` is given: everything needed to replay it (NFR-OBS-01). */
export interface GateRequest {
	submission: Submission;
	plan: unknown;
	prefs: Preferences | null;
	finalise_blocked: string | null;
}

export interface GateInputs {
	snapshot_id: string;
	snapshot_path: string;
	ft: number | null;
	pending: [number, number][];
	request: GateRequest;
}

export type GateOutcome =
	| { ok: true; recommendation: Recommendation; inputs: GateInputs }
	| { ok: false; stage: "schema" | "snapshot" | "plan_file" | "validate" | "internal"; errors: GateError[]; inputs?: GateInputs };

const checkSubmission = Compile(Submission);
const checkRecommendation = Compile(Recommendation);

/** A ULID: 48 bits of time and 80 of randomness in Crockford base32, sortable by creation time. */
export function ulid(now: number = Date.now(), random: Uint8Array = randomBytes(10)): string {
	const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	let time = "";
	for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = B32[t % 32] + time;
	let bits = 0n;
	for (const b of random) bits = (bits << 8n) | BigInt(b);
	let rand = "";
	for (let i = 0; i < 16; i++, bits >>= 5n) rand = B32[Number(bits & 31n)] + rand;
	return time + rand;
}

/** Inside T−1h on stale data, transfers are discussed but not submitted (FR-DAT-05). */
export function finaliseBlocked(snap: Pick<SnapshotEntry, "stale" | "stale_reason" | "gw">, now: number): string | null {
	const deadline = snap.gw.deadline ? Date.parse(snap.gw.deadline) : Number.NaN;
	if (!snap.stale || !Number.isFinite(deadline) || deadline <= now || deadline - now > FINALISE_WINDOW_MS) return null;
	return `FPL data is stale (${snap.stale_reason ?? "unknown"}) and the GW${snap.gw.next ?? "?"} deadline is under an hour away, so transfers can't be finalised on it.`;
}

function schemaErrors(check: ReturnType<typeof Compile>, value: unknown, code: string): GateError[] {
	return [...check.Errors(value)].slice(0, 8).map((e) => {
		const missing = (e.params as { requiredProperties?: string[] })?.requiredProperties;
		return { code, message: `${e.instancePath || "/"}: ${e.message}${missing ? ` (${missing.join(", ")})` : ""}` };
	});
}

export interface GateDeps {
	sandbox: SandboxSession;
	dataDir: string;
	/** provider/model of the LLM making the submission. */
	model: string;
	piVersion: string;
	now?: () => number;
	signal?: AbortSignal;
	/** The preferences file the run used (team-prefs.ts `activePrefsFile`); the team's saved file if left out. */
	prefsFile?: string;
}

/**
 * Run the gate on one submission. `snapshot` is the latest `gaffer.snapshot` entry for the session's
 * team: the snapshot the run used. Never throws for a bad submission: the outcome says what failed.
 */
export async function runGate(submission: unknown, snapshot: SnapshotEntry | undefined, attempt: number, deps: GateDeps): Promise<GateOutcome> {
	const now = (deps.now ?? Date.now)();
	if (!checkSubmission.Check(submission)) return { ok: false, stage: "schema", errors: schemaErrors(checkSubmission, submission, "SCHEMA") };
	if (!snapshot) {
		return { ok: false, stage: "snapshot", errors: [{ code: "NO_SNAPSHOT", message: 'There is no snapshot for this team in the session. Call fpl_snapshot with include: ["odds"], run the golden path it names, then submit.' }] };
	}
	const deadline = snapshot.gw.deadline ? Date.parse(snapshot.gw.deadline) : Number.NaN;
	if (Number.isFinite(deadline) && deadline <= now) {
		return { ok: false, stage: "snapshot", errors: [{ code: "SNAPSHOT_OUT_OF_DATE", message: `The GW${snapshot.gw.next} deadline (${snapshot.gw.deadline}) has passed since the snapshot was taken. Call fpl_snapshot again, re-run the golden path and submit for the next GW.` }] };
	}

	const planFile = submission.plan_file ?? DEFAULT_PLAN_FILE;
	let plan: unknown = null;
	try {
		const text = await sandboxReadFile(deps.sandbox, planFile);
		if (text.length > MAX_PLAN_BYTES) throw new Error(`it is ${text.length} bytes; a plan file is under ${MAX_PLAN_BYTES}`);
		plan = JSON.parse(text);
	} catch (e) {
		const message = `The golden path's plan file could not be read from ${planFile} (${(e as Error).message.split("\n")[0]}). Run the golden-path command from the fpl_snapshot summary (it writes /work/plan.json), then submit; pass plan_file if you wrote it elsewhere.`;
		return { ok: false, stage: "plan_file", errors: [{ code: "PLAN_FILE_UNREADABLE", message }] };
	}

	const { plan_file: _p, ...model } = submission;
	const prefs = "prefsFile" in deps ? (deps.prefsFile ? readPrefsFile(deps.prefsFile) : undefined) : readPrefs(deps.dataDir, snapshot.team_id_hash);
	const { schema: _s, updated_at: _u, ...savedPrefs } = prefs ?? { schema: "", updated_at: "" };
	const inputs: GateInputs = {
		snapshot_id: snapshot.snapshot_id,
		snapshot_path: snapshot.snapshot_path,
		ft: snapshot.ft_source === "user" ? (snapshot.free_transfers ?? null) : null,
		pending: snapshot.pending_transfers ?? [],
		request: { submission: model as Submission, plan, prefs: prefs ? (savedPrefs as Preferences) : null, finalise_blocked: finaliseBlocked(snapshot, now) },
	};

	let exitCode: number | null;
	let output: string;
	try {
		({ exitCode, output } = await sandboxRun(deps.sandbox, gateCommand(inputs.snapshot_path, inputs), { timeoutS: 90, signal: deps.signal, stdin: JSON.stringify(inputs.request) }));
	} catch (e) {
		return { ok: false, stage: "internal", inputs, errors: [{ code: "SANDBOX_UNAVAILABLE", message: `The validator could not run in the sandbox (${(e as Error).message.split("\n")[0]}). This is not a problem with the plan; submit again.` }] };
	}
	const doc = lastJsonLine(output) as { valid?: boolean; errors?: GateError[]; error?: string; gaffer_lib?: string; recommendation?: Record<string, unknown>; validation?: Record<string, unknown> } | undefined;
	if (!doc || doc.error || typeof doc.valid !== "boolean") {
		const why = doc?.error ?? output.trim().slice(-300) ?? `exit ${exitCode}`;
		return { ok: false, stage: "internal", inputs, errors: [{ code: "VALIDATOR_ERROR", message: `gaffer_lib validate could not process the submission (exit ${exitCode}): ${why}` }] };
	}
	if (!doc.valid || !doc.recommendation) return { ok: false, stage: "validate", inputs, errors: doc.errors ?? [] };

	const recommendation = {
		schema: SCHEMA_ID,
		rec_id: ulid(now),
		created_at: new Date(now).toISOString(),
		team_id_hash: snapshot.team_id_hash,
		model: deps.model,
		gaffer_lib: doc.gaffer_lib,
		pi: deps.piVersion,
		snapshot: { id: snapshot.snapshot_id, fetched_at: snapshot.fetched_at, stale: snapshot.stale, stale_reason: snapshot.stale_reason },
		...doc.recommendation,
		validation: { ...doc.validation, attempts: attempt },
	};
	// Fail closed: a recommendation that doesn't match its own schema is a Gaffer bug, and isn't shown.
	if (!checkRecommendation.Check(recommendation)) {
		return { ok: false, stage: "internal", inputs, errors: schemaErrors(checkRecommendation, recommendation, "OUTPUT_SCHEMA") };
	}
	return { ok: true, recommendation: recommendation as Recommendation, inputs };
}

/** One line per recommendation in /data/ledger/recommendations.jsonl: a rebuildable index (ADR 0004). */
export function appendLedger(dataDir: string, rec: Recommendation, sessionFile: string | undefined): void {
	const dir = join(dataDir, "ledger");
	mkdirSync(dir, { recursive: true });
	const row = {
		rec_id: rec.rec_id, created_at: rec.created_at, team_id_hash: rec.team_id_hash, season: rec.season, gw: rec.gw, deadline: rec.deadline,
		snapshot_id: rec.snapshot.id, model: rec.model, gaffer_lib: rec.gaffer_lib, confidence: rec.confidence.overall,
		transfers: rec.transfers.map((t) => [t.out.id, t.in.id]), captain: rec.captain.id, chip: rec.chip.play, expected_points_gw: rec.expected_points_gw,
		session_file: sessionFile ?? null,
	};
	appendFileSync(join(dir, "recommendations.jsonl"), `${JSON.stringify(row)}\n`);
}

export function rejectionText(errors: GateError[], attempt: number): string {
	return [
		`Recommendation rejected (attempt ${attempt} of ${MAX_ATTEMPTS}). Nothing was saved or shown to the user. Fix every point and call submit_recommendation again:`,
		...errors.slice(0, 12).map((e) => `- [${e.code}] ${e.message}`),
	].join("\n");
}
