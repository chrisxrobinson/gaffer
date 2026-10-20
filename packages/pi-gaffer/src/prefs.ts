/**
 * Per-team preferences (FR-INP-02, FR-INP-03, ADR 0004): a small JSON file the harness owns, at
 * /data/users/<hmac of the team id>/prefs.json. It outlives sessions and container restarts (the
 * data volume), is injected into the prompt, is passed to the golden path with --prefs (the sandbox
 * reads /data read-only) and is enforced by the submit gate. The path never contains the raw team id.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Compile } from "typebox/compile";
import { Preferences } from "./schema/recommendation.ts";

export const PREFS_SCHEMA = "gaffer.prefs/1";
export const DEFAULT_PREFS: Preferences = { risk: "balanced", save_chips: [], keep: [], avoid: [], max_hits_per_gw: null };
export const CHIP_ALIASES: Record<string, Preferences["save_chips"][number]> = {
	wildcard: "wildcard", wc: "wildcard", freehit: "freehit", free_hit: "freehit", fh: "freehit",
	bboost: "bboost", bench_boost: "bboost", bb: "bboost", "3xc": "3xc", triple_captain: "3xc", tc: "3xc",
};
const CHIP_LABEL: Record<string, string> = { wildcard: "Wildcard", freehit: "Free Hit", bboost: "Bench Boost", "3xc": "Triple Captain" };

export interface StoredPrefs extends Preferences {
	schema: typeof PREFS_SCHEMA;
	updated_at: string;
}

const check = Compile(Preferences);

export function prefsPath(dataDir: string, teamIdHash: string): string {
	return join(dataDir, "users", teamIdHash.replace(/^hmac-sha256:/, ""), "prefs.json");
}

/**
 * Preferences for one session's runs, from the Gaffer App's options when they aren't saved as the team's
 * (`/run`): the same format, beside the team's file. The golden path, the prompt and the gate read this file
 * instead of the saved one for the rest of that session (team-prefs.ts `activePrefsFile`).
 */
export function runPrefsPath(dataDir: string, teamIdHash: string, sessionId: string): string {
	if (!/^[0-9A-Za-z._-]{1,80}$/.test(sessionId)) throw new Error(`invalid session id for a preferences file: ${sessionId}`);
	return join(dirname(prefsPath(dataDir, teamIdHash)), "runs", `${sessionId}.json`);
}

/** The saved preferences, or undefined when none are saved (or the file is unreadable). */
export function readPrefs(dataDir: string, teamIdHash: string): StoredPrefs | undefined {
	return readPrefsFile(prefsPath(dataDir, teamIdHash));
}

/** A preferences file (the team's, or a session's run file), or undefined when it is missing or unreadable. */
export function readPrefsFile(file: string): StoredPrefs | undefined {
	if (!existsSync(file)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as StoredPrefs;
		const { schema: _s, updated_at: _u, ...prefs } = raw;
		return check.Check(prefs) ? raw : undefined;
	} catch {
		return undefined;
	}
}

/** Merge `patch` into the saved preferences (each field given replaces the saved one) and write the file. */
export function writePrefs(dataDir: string, teamIdHash: string, patch: Partial<Preferences>, now: Date = new Date()): StoredPrefs {
	return writePrefsFile(prefsPath(dataDir, teamIdHash), patch, now);
}

/** Merge `patch` into a preferences file, as `writePrefs` does for the team's. */
export function writePrefsFile(file: string, patch: Partial<Preferences>, now: Date = new Date()): StoredPrefs {
	const current = readPrefsFile(file);
	const { schema: _s, updated_at: _u, ...saved } = current ?? { schema: PREFS_SCHEMA, updated_at: "", ...DEFAULT_PREFS };
	const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
	const next = { ...saved, ...defined } as Preferences;
	next.save_chips = [...new Set(next.save_chips)];
	if (!check.Check(next)) {
		const e = [...check.Errors(next)][0];
		throw new Error(`invalid preferences: ${e?.instancePath || "/"} ${e?.message ?? ""}`.trim());
	}
	mkdirSync(dirname(file), { recursive: true });
	const stored: StoredPrefs = { schema: PREFS_SCHEMA, updated_at: now.toISOString(), ...next };
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`);
	renameSync(tmp, file);
	return stored;
}

export function describePrefs(p: Preferences | undefined): string {
	if (!p) return "No preferences saved for this team (defaults: risk balanced, no chips saved, no players kept or avoided, hits allowed).";
	const players = (xs: Preferences["keep"]) => (xs.length ? xs.map((x) => `${x.name} (${x.id})`).join(", ") : "none");
	return [
		`risk: ${p.risk}`,
		`save chips: ${p.save_chips.length ? p.save_chips.map((c) => CHIP_LABEL[c]).join(", ") : "none"}`,
		`keep: ${players(p.keep)}`,
		`avoid: ${players(p.avoid)}`,
		`max hits per GW: ${p.max_hits_per_gw ?? "no limit"}`,
	].join("\n");
}

export const PREFS_USAGE =
	"Usage: /prefs shows your saved preferences. To change them: /prefs risk=safe|balanced|aggressive save_chips=wildcard,freehit keep=<player ids> avoid=<player ids> max_hits=<n|none> (any subset; each one given replaces the saved value), or /prefs clear. You can also just tell Gaffer in words.";

export type PrefsArgs = { show: true } | { clear: true } | { error: string } | { patch: Partial<Omit<Preferences, "keep" | "avoid">>; keep?: number[]; avoid?: number[] };

/** `/prefs`, `/prefs clear`, `/prefs risk=safe save_chips=wc,fh keep=123,456 avoid= max_hits=1`. */
export function parsePrefsArgs(args: string): PrefsArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (!tokens.length) return { show: true };
	if (tokens.length === 1 && tokens[0] === "clear") return { clear: true };
	const out: Extract<PrefsArgs, { patch: unknown }> = { patch: {} };
	for (const t of tokens) {
		const eq = t.indexOf("=");
		if (eq < 1) return { error: `"${t}" isn't key=value. ${PREFS_USAGE}` };
		const key = t.slice(0, eq).toLowerCase();
		const value = t.slice(eq + 1);
		const list = value.split(",").map((x) => x.trim()).filter(Boolean);
		if (key === "risk") {
			if (value !== "safe" && value !== "balanced" && value !== "aggressive") return { error: `risk must be safe, balanced or aggressive, got "${value}".` };
			out.patch.risk = value;
		} else if (key === "save_chips" || key === "save") {
			const chips = list.map((c) => CHIP_ALIASES[c.toLowerCase()]);
			if (chips.some((c) => !c)) return { error: `save_chips takes wildcard, freehit, bboost and 3xc (or wc, fh, bb, tc), got "${value}".` };
			out.patch.save_chips = chips;
		} else if (key === "keep" || key === "avoid") {
			if (list.some((x) => !/^\d{1,5}$/.test(x))) return { error: `${key} takes player ids separated by commas (the id column of the squad table), got "${value}". For names, tell Gaffer in words.` };
			out[key] = list.map(Number);
		} else if (key === "max_hits" || key === "max_hits_per_gw") {
			if (value === "none" || value === "") out.patch.max_hits_per_gw = null;
			else if (/^\d{1,2}$/.test(value)) out.patch.max_hits_per_gw = Number(value);
			else return { error: `max_hits takes a number or "none", got "${value}".` };
		} else {
			return { error: `Unknown preference "${key}". ${PREFS_USAGE}` };
		}
	}
	return out;
}
