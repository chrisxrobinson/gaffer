/** Gaffer configuration: environment variables only (ARCHITECTURE §8). */
import { readFileSync } from "node:fs";

/** Read VAR, or the file named by VAR_FILE (Compose `secrets:`). */
export function envOrFile(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env[name]) return env[name];
	const file = env[`${name}_FILE`];
	if (!file) return undefined;
	try {
		return readFileSync(file, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

export function idSalt(env: NodeJS.ProcessEnv = process.env): string {
	const salt = envOrFile("GAFFER_ID_SALT", env);
	if (!salt) throw new Error("GAFFER_ID_SALT (or GAFFER_ID_SALT_FILE) must be set: team IDs are HMAC-hashed before they are stored.");
	return salt;
}

/**
 * The time Gaffer uses for FPL decisions: deadlines, cache lifetimes, the finalise window and the gate's
 * "deadline passed" check. It is the real time unless GAFFER_CLOCK_OFFSET_MS is set, which only the
 * eval runner does, so a past GW's frozen data can be replayed as if before its deadline
 * (ARCHITECTURE §6.3). Costs and the daily cap always use the real date.
 */
export function fplNow(env: NodeJS.ProcessEnv = process.env): number {
	const offset = Number(env.GAFFER_CLOCK_OFFSET_MS ?? 0);
	return Date.now() + (Number.isFinite(offset) ? offset : 0);
}

/**
 * Where every session lives, for the daily cap and /usage's "today": GAFFER_SESSIONS_ROOT (the image
 * sets /sessions), else the current session's own directory. Headless and eval runs keep their sessions
 * in subdirectories of the root, and their spend counts against the same daily cap as the TUI's.
 */
export function sessionsRoot(sessionDir: string, env: NodeJS.ProcessEnv = process.env): string {
	return env.GAFFER_SESSIONS_ROOT || sessionDir;
}

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.GAFFER_DATA_DIR ?? "/data";
}

function num(value: string | undefined, fallback: number): number {
	const n = value === undefined || value === "" ? Number.NaN : Number(value);
	return Number.isFinite(n) ? n : fallback;
}

export interface BudgetConfig {
	/** USD per session above which the model is steered, once, to wrap up and submit (FR-BUD-02). */
	soft: number;
	/** USD per session. */
	hard: number;
	/** USD per UTC day, across all sessions. */
	daily: number;
	/** Turns per run. */
	maxTurns: number;
}

export function budgetConfig(env: NodeJS.ProcessEnv = process.env): BudgetConfig {
	return {
		soft: num(env.GAFFER_BUDGET_SOFT, 0.75),
		hard: num(env.GAFFER_BUDGET_HARD, 1.5),
		daily: num(env.GAFFER_BUDGET_DAILY, 5),
		maxTurns: num(env.GAFFER_MAX_TURNS, 40),
	};
}

/** Tools the model may see (ARCHITECTURE §1.2). submit_recommendation and set_preferences arrive in M4. */
export const GAFFER_TOOLS = ["read", "write", "edit", "bash", "fpl_snapshot", "submit_recommendation", "set_preferences"];

/** The sandbox's working directory, used as cwd for the retargeted built-in tools. */
export const SANDBOX_CWD = "/work";
