/**
 * Read-only guards (FR-ACC-01, ARCHITECTURE §2.5).
 * Gaffer holds no FPL credentials and only issues GETs to an allowlist of public API paths.
 */
import { posix } from "node:path";
import { SANDBOX_CWD } from "./config.ts";

/** Public, unauthenticated FPL API paths Gaffer may GET (relative to /api/). */
const ALLOWED_PATHS = [
	/^bootstrap-static\/$/,
	/^fixtures\/$/,
	/^entry\/\d+\/$/,
	/^entry\/\d+\/history\/$/,
	/^entry\/\d+\/transfers\/$/,
	/^entry\/\d+\/event\/\d+\/picks\/$/,
	/^element-summary\/\d+\/$/,
	/^event\/\d+\/live\/$/,
];

export type GuardResult = { ok: true } | { ok: false; reason: string };

export function checkFplRequest(method: string, path: string): GuardResult {
	if (method.toUpperCase() !== "GET") {
		return { ok: false, reason: `Gaffer is read-only: ${method} requests to the FPL API are not allowed.` };
	}
	if (!ALLOWED_PATHS.some((re) => re.test(path))) {
		return { ok: false, reason: `Gaffer is read-only: FPL path "${path}" is not on the public allowlist.` };
	}
	return { ok: true };
}

/**
 * The one supplementary source (ADR 0002, FR-DAT-09): football-data.co.uk, GET only, and only the
 * next-round odds file and the Premier League season files. No other host is on the allowlist.
 */
export const ODDS_HOST = "football-data.co.uk";
const ALLOWED_ODDS_PATHS = [/^\/fixtures\.csv$/, /^\/mmz4281\/\d{4}\/E0\.csv$/];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function checkOddsRequest(method: string, url: string): GuardResult {
	if (method.toUpperCase() !== "GET") return { ok: false, reason: `Gaffer is read-only: ${method} requests to the odds source are not allowed.` };
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return { ok: false, reason: `Gaffer is read-only: "${url}" is not a URL.` };
	}
	// Loopback is the mock server in tests; anything else must be the real host over HTTPS.
	const official = u.protocol === "https:" && u.hostname === ODDS_HOST;
	if (!official && !LOOPBACK.has(u.hostname)) return { ok: false, reason: `Gaffer is read-only: host "${u.hostname}" is not on the allowlist (odds come from ${ODDS_HOST} only).` };
	if (u.search || !ALLOWED_ODDS_PATHS.some((re) => re.test(u.pathname))) return { ok: false, reason: `Gaffer is read-only: odds path "${u.pathname}${u.search}" is not on the allowlist.` };
	return { ok: true };
}

/** References to authenticated or state-changing FPL endpoints, wherever they appear in a tool call. */
const ACCOUNT_PATTERNS = [/\/api\/my-team\//i, /\/api\/me\//i, /accounts\/login/i, /\/api\/transfers\//i, /users\.premierleague\.com/i];

/** Paths the model must never write to; the sandbox mounts /data read-only as well. */
const READ_ONLY_ROOTS = ["/data"];

export interface ToolCallBlock {
	block: true;
	reason: string;
}

/** Policy for Pi's `tool_call` event. Returns a block result, or undefined to allow. */
export function checkToolCall(toolName: string, input: unknown): ToolCallBlock | undefined {
	const text = JSON.stringify(input ?? {});
	if (ACCOUNT_PATTERNS.some((re) => re.test(text))) {
		return { block: true, reason: "Gaffer is read-only and never touches the FPL account: authenticated FPL endpoints are blocked." };
	}
	if (toolName === "write" || toolName === "edit") {
		const raw = String((input as { path?: unknown })?.path ?? "");
		const abs = posix.resolve(SANDBOX_CWD, raw);
		if (READ_ONLY_ROOTS.some((root) => abs === root || abs.startsWith(`${root}/`))) {
			return { block: true, reason: `${abs} is read-only (snapshots and user data are managed by Gaffer). Write under ${SANDBOX_CWD} instead.` };
		}
	}
	return undefined;
}
