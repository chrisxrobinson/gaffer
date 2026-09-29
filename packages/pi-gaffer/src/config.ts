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

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.GAFFER_DATA_DIR ?? "/data";
}

function num(value: string | undefined, fallback: number): number {
	const n = value === undefined || value === "" ? Number.NaN : Number(value);
	return Number.isFinite(n) ? n : fallback;
}

export interface BudgetConfig {
	/** USD per session. */
	hard: number;
	/** USD per UTC day, across all sessions. */
	daily: number;
	/** Turns per run. */
	maxTurns: number;
}

export function budgetConfig(env: NodeJS.ProcessEnv = process.env): BudgetConfig {
	return {
		hard: num(env.GAFFER_BUDGET_HARD, 1.5),
		daily: num(env.GAFFER_BUDGET_DAILY, 5),
		maxTurns: num(env.GAFFER_MAX_TURNS, 40),
	};
}

/** Tools the model may see (ARCHITECTURE §1.2). submit_recommendation and set_preferences arrive in M4. */
export const GAFFER_TOOLS = ["read", "write", "edit", "bash", "fpl_snapshot", "submit_recommendation", "set_preferences"];

/** The sandbox's working directory, used as cwd for the retargeted built-in tools. */
export const SANDBOX_CWD = "/work";
