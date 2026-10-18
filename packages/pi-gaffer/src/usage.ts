/**
 * Usage from Pi's session files (ADR 0004, ARCHITECTURE §9): what `/usage` shows for the current
 * session and today, and what `gaffer admin` reports across every session. No parallel store: every
 * figure is read from the JSONL that Pi and the Gaffer extensions already write.
 *
 * - Cost and tokens: each assistant message's `usage` (Pi's own figures, ADR 0008), plus Pi's `usage`
 *   entries: cache warming and other calls outside the conversation (NFR-COST-05).
 * - Cost per tool: the cost of the assistant message that called it, split evenly between the calls it
 *   made, so the per-tool costs add up to the session's. Messages that call no tool count as "(text)",
 *   and `usage` entries as "(cache warming and other Pi calls)".
 * - Latency: an assistant message's `timestamp` is when it started and its entry's when it was written,
 *   so a model call takes entry − message time, a tool call takes its result's time − the calling
 *   message's entry time, and a run takes its user message → the `gaffer.recommendation` entry.
 * - Errors: assistant messages with stopReason "error", tool results with isError, failed
 *   `gaffer.validation` attempts. Texts are shortened and their digits masked, so no team id survives.
 * - Data-source health: the per-endpoint records in `gaffer.snapshot` entries (NFR-OBS-02).
 *
 * Nothing here reads a user's prompt or a tool's output, except an error's first line.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number };
}
interface Message {
	role?: string;
	provider?: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: Usage;
	timestamp?: number;
	content?: { type: string; name?: string; id?: string; text?: string }[];
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}
export interface Entry {
	type: string;
	customType?: string;
	data?: unknown;
	timestamp?: string;
	message?: Message;
	content?: unknown;
	/** On a `usage` entry: what the call was for ("cache_warm", …), and its model and usage. */
	kind?: string;
	provider?: string;
	model?: string;
	usage?: Usage;
}

/** The row that holds Pi's `usage` entries in the per-tool costs. */
export const PI_CALLS = "(cache warming and other Pi calls)";

export interface Tokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}
export interface ToolStat {
	calls: number;
	errors: number;
	/** Summed and longest tool latency, ms; calls whose result has no timestamp are left out of both. */
	totalMs: number;
	maxMs: number;
	timed: number;
	/** USD attributed from the calling assistant messages. */
	cost: number;
}
export interface RunStat {
	start: string;
	/** ms from the user message to the recommendation, or to the run's last entry if there was none. */
	ms: number | null;
	recommendation: string | null;
	/** "recommendation", "no recommendation" (the gate refused three times or the run stopped) or "answer". */
	outcome: "recommendation" | "no recommendation" | "answer";
	cost: number;
	calls: number;
	validationAttempts: number;
}
export interface ErrorStat {
	at: string | null;
	kind: "model" | "tool" | "validation";
	source: string;
	message: string;
}
export interface EndpointStat {
	source: string;
	requests: number;
	fromCache: number;
	failures: number;
	retries: number;
	totalMs: number;
	maxMs: number;
	maxAge: number | null;
}
export interface SessionUsage {
	file: string;
	id: string;
	started: string | null;
	ended: string | null;
	models: string[];
	calls: number;
	tokens: Tokens;
	cost: number;
	/** Model call time, ms (entry time − message start), summed and longest. */
	modelMs: number;
	maxModelMs: number;
	byModel: Record<string, { calls: number; cost: number; tokens: Tokens }>;
	tools: Record<string, ToolStat>;
	runs: RunStat[];
	recommendations: string[];
	validations: { attempts: number; failed: number };
	errors: ErrorStat[];
	budget: { steered: boolean; capped: string | null };
	snapshots: { count: number; stale: number; endpoints: Record<string, EndpointStat> };
	/** The team hashes the session's snapshots were for (never the raw id). */
	teams: string[];
	/** Cost by UTC day (assistant message start times; a `usage` entry's own time). */
	byDay: Record<string, number>;
}

const emptyTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const addTokens = (t: Tokens, u: Usage | undefined) => {
	t.input += u?.input ?? 0;
	t.output += u?.output ?? 0;
	t.cacheRead += u?.cacheRead ?? 0;
	t.cacheWrite += u?.cacheWrite ?? 0;
};
const ms = (iso: string | undefined) => (iso ? Date.parse(iso) : Number.NaN);
const isoOf = (t: number) => (Number.isFinite(t) ? new Date(t).toISOString() : null);

/** The first line of an error, shortened, with every run of digits masked (team ids, amounts). */
export function maskError(text: string | undefined, max = 160): string {
	const line = (text ?? "").split("\n").find((l) => l.trim()) ?? "";
	const masked = line.replace(/\d+/g, "#").trim();
	return masked.length > max ? `${masked.slice(0, max - 1)}…` : masked;
}

/** Which data source an endpoint record belongs to (NFR-OBS-02's per-source aggregation). */
export function endpointSource(path: string): string {
	if (path.startsWith("football-data:")) return "football-data.co.uk";
	if (path.startsWith("bootstrap-static")) return "fpl: bootstrap-static";
	if (path.startsWith("fixtures")) return "fpl: fixtures";
	if (/^event\/\d+\/live/.test(path)) return "fpl: event live";
	if (path.startsWith("element-summary")) return "fpl: element-summary";
	if (/^entry\/\d+\/event\/\d+\/picks/.test(path)) return "fpl: entry picks";
	if (/^entry\/\d+\/history/.test(path)) return "fpl: entry history";
	if (/^entry\/\d+\/transfers/.test(path)) return "fpl: entry transfers";
	if (/^entry\/\d+\/?$/.test(path)) return "fpl: entry";
	return `fpl: ${path.replace(/\d+/g, "#")}`;
}

export function parseEntries(text: string): Entry[] {
	const out: Entry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as Entry);
		} catch {
			/* a partial last line while Pi is writing */
		}
	}
	return out;
}

/** Usage of one session from its entries (every branch: money spent on an abandoned branch is still spent). */
export function sessionUsage(entries: readonly Entry[], file = ""): SessionUsage {
	const header = entries.find((e) => e.type === "session") as (Entry & { id?: string }) | undefined;
	const u: SessionUsage = {
		file, id: header?.id ?? basename(file, ".jsonl"), started: null, ended: null, models: [], calls: 0, tokens: emptyTokens(), cost: 0, modelMs: 0, maxModelMs: 0,
		byModel: {}, tools: {}, runs: [], recommendations: [], validations: { attempts: 0, failed: 0 }, errors: [], budget: { steered: false, capped: null },
		snapshots: { count: 0, stale: 0, endpoints: {} }, teams: [], byDay: {},
	};
	const times = entries.map((e) => ms(e.timestamp)).filter(Number.isFinite);
	u.started = times.length ? isoOf(Math.min(...times)) : null;
	u.ended = times.length ? isoOf(Math.max(...times)) : null;

	// Tool calls by id: the tool's name, when its caller finished, and its share of the caller's cost.
	const calls = new Map<string, { name: string; at: number }>();
	let run: RunStat | null = null;
	let runStart = Number.NaN;
	let lastAt = Number.NaN;
	const closeRun = () => {
		if (!run) return;
		if (run.ms === null && Number.isFinite(lastAt) && Number.isFinite(runStart)) run.ms = lastAt - runStart;
		u.runs.push(run);
		run = null;
	};
	for (const e of entries) {
		const at = ms(e.timestamp);
		const m = e.message;
		if (e.type === "message" && m?.role === "user") {
			closeRun();
			run = { start: e.timestamp ?? "", ms: null, recommendation: null, outcome: "answer", cost: 0, calls: 0, validationAttempts: 0 };
			runStart = at;
		}
		if (Number.isFinite(at)) lastAt = at;
		if (e.type === "message" && m?.role === "assistant") {
			const cost = m.usage?.cost?.total ?? 0;
			const model = `${m.provider ?? "?"}/${m.model ?? "?"}`;
			u.calls++;
			u.cost += cost;
			addTokens(u.tokens, m.usage);
			const bm = (u.byModel[model] ??= { calls: 0, cost: 0, tokens: emptyTokens() });
			bm.calls++;
			bm.cost += cost;
			addTokens(bm.tokens, m.usage);
			if (!u.models.includes(model)) u.models.push(model);
			const startMs = m.timestamp ?? Number.NaN;
			if (Number.isFinite(startMs)) {
				const day = new Date(startMs).toISOString().slice(0, 10);
				u.byDay[day] = (u.byDay[day] ?? 0) + cost;
				if (Number.isFinite(at) && at >= startMs) {
					u.modelMs += at - startMs;
					u.maxModelMs = Math.max(u.maxModelMs, at - startMs);
				}
			}
			const toolCalls = (m.content ?? []).filter((c) => c.type === "toolCall");
			const share = toolCalls.length ? cost / toolCalls.length : cost;
			for (const c of toolCalls.length ? toolCalls : [{ type: "text", name: "(text)" }]) {
				const t = (u.tools[c.name ?? "?"] ??= { calls: 0, errors: 0, totalMs: 0, maxMs: 0, timed: 0, cost: 0 });
				t.cost += share;
				if (c.type === "toolCall") {
					t.calls++;
					if (c.id) calls.set(c.id, { name: c.name ?? "?", at });
				}
			}
			if (m.stopReason === "error") u.errors.push({ at: e.timestamp ?? null, kind: "model", source: model, message: maskError(m.errorMessage ?? "model error") });
			if (run) {
				run.cost += cost;
				run.calls++;
			}
		}
		// Pi's own calls outside the conversation: in the session's cost, tokens, model and day, not in a run or the call count.
		if (e.type === "usage") {
			const cost = e.usage?.cost?.total ?? 0;
			const model = `${e.provider ?? "?"}/${e.model ?? "?"}`;
			u.cost += cost;
			addTokens(u.tokens, e.usage);
			const bm = (u.byModel[model] ??= { calls: 0, cost: 0, tokens: emptyTokens() });
			bm.cost += cost;
			addTokens(bm.tokens, e.usage);
			const t = (u.tools[PI_CALLS] ??= { calls: 0, errors: 0, totalMs: 0, maxMs: 0, timed: 0, cost: 0 });
			t.calls++;
			t.cost += cost;
			if (Number.isFinite(at)) {
				const day = new Date(at).toISOString().slice(0, 10);
				u.byDay[day] = (u.byDay[day] ?? 0) + cost;
			}
		}
		if (e.type === "message" && m?.role === "toolResult") {
			const call = m.toolCallId ? calls.get(m.toolCallId) : undefined;
			const name = call?.name ?? m.toolName ?? "?";
			const t = (u.tools[name] ??= { calls: 0, errors: 0, totalMs: 0, maxMs: 0, timed: 0, cost: 0 });
			if (m.isError) {
				t.errors++;
				u.errors.push({ at: e.timestamp ?? null, kind: "tool", source: name, message: maskError(m.content?.map((c) => c.text ?? "").join("")) });
			}
			const done = m.timestamp ?? at;
			if (call && Number.isFinite(call.at) && Number.isFinite(done) && done >= call.at) {
				t.totalMs += done - call.at;
				t.maxMs = Math.max(t.maxMs, done - call.at);
				t.timed++;
			}
		}
		if (e.type !== "custom") continue;
		const d = (e.data ?? {}) as Record<string, unknown>;
		if (e.customType === "gaffer.recommendation") {
			const id = String(d.rec_id ?? "");
			u.recommendations.push(id);
			if (run) {
				run.recommendation = id;
				run.outcome = "recommendation";
				run.ms = at - runStart;
			}
		} else if (e.customType === "gaffer.validation") {
			u.validations.attempts++;
			if (run) run.validationAttempts++;
			if (d.passed === false) {
				u.validations.failed++;
				const codes = ((d.errors as { code?: string }[] | undefined) ?? []).map((x) => x.code).filter(Boolean);
				u.errors.push({ at: e.timestamp ?? null, kind: "validation", source: `submit attempt ${d.attempt ?? "?"} (${d.stage ?? "?"})`, message: codes.join(", ") || "rejected" });
				if (run && run.outcome !== "recommendation") run.outcome = "no recommendation";
			}
		} else if (e.customType === "gaffer.budget") {
			if (d.steered === true) u.budget.steered = true;
			if (d.capped) u.budget.capped = String(d.capped);
		} else if (e.customType === "gaffer.snapshot") {
			u.snapshots.count++;
			if (d.stale) u.snapshots.stale++;
			if (typeof d.team_id_hash === "string" && !u.teams.includes(d.team_id_hash)) u.teams.push(d.team_id_hash);
			for (const ep of (d.endpoints as { path?: string; status?: number | null; latency_ms?: number; retries?: number; age?: number | null; from_cache?: boolean; error?: string }[] | undefined) ?? []) {
				const src = endpointSource(ep.path ?? "");
				const s = (u.snapshots.endpoints[src] ??= { source: src, requests: 0, fromCache: 0, failures: 0, retries: 0, totalMs: 0, maxMs: 0, maxAge: null });
				if (ep.from_cache && !ep.error) {
					s.fromCache++;
					continue;
				}
				s.requests++;
				s.retries += ep.retries ?? 0;
				if (ep.error || (typeof ep.status === "number" && ep.status >= 400)) s.failures++;
				s.totalMs += ep.latency_ms ?? 0;
				s.maxMs = Math.max(s.maxMs, ep.latency_ms ?? 0);
				if (typeof ep.age === "number") s.maxAge = Math.max(s.maxAge ?? 0, ep.age);
			}
		}
	}
	closeRun();
	return u;
}

/** Every `*.jsonl` session file under `dir` (recursively), parsed. Unreadable files are skipped. */
export function scanSessions(dir: string): SessionUsage[] {
	let files: string[];
	try {
		files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return [];
	}
	const out: SessionUsage[] = [];
	for (const f of files.sort()) {
		const full = join(dir, f);
		try {
			if (!statSync(full).isFile()) continue;
			const entries = parseEntries(readFileSync(full, "utf8"));
			if (!entries.some((e) => e.type === "session")) continue; // not a Pi session file
			out.push(sessionUsage(entries, relative(dir, full)));
		} catch {
			/* unreadable */
		}
	}
	return out;
}

export interface Totals {
	sessions: number;
	calls: number;
	tokens: Tokens;
	cost: number;
	runs: number;
	recommendations: number;
	errors: number;
}

export function totals(sessions: readonly SessionUsage[]): Totals {
	const t: Totals = { sessions: sessions.length, calls: 0, tokens: emptyTokens(), cost: 0, runs: 0, recommendations: 0, errors: 0 };
	for (const s of sessions) {
		t.calls += s.calls;
		t.cost += s.cost;
		t.runs += s.runs.length;
		t.recommendations += s.recommendations.length;
		t.errors += s.errors.length;
		for (const k of Object.keys(t.tokens) as (keyof Tokens)[]) t.tokens[k] += s.tokens[k];
	}
	return t;
}

/** Spend and calls on one UTC day across sessions (the same accounting as the daily cap). */
export function dayTotals(sessions: readonly SessionUsage[], day: Date): { sessions: number; cost: number } {
	const key = day.toISOString().slice(0, 10);
	const active = sessions.filter((s) => key in s.byDay);
	return { sessions: active.length, cost: active.reduce((n, s) => n + (s.byDay[key] ?? 0), 0) };
}

/**
 * This session and today (UTC), as `/usage` and the TUI's footer show them. This session from memory (Pi
 * writes its file lazily, from the first user message), the others from disk under the sessions root.
 */
export function usageNow(sm: { getSessionDir(): string; getSessionFile(): string | undefined; getEntries(): unknown[] }, root: string, now = new Date()) {
	const file = sm.getSessionFile();
	const session = sessionUsage(sm.getEntries() as Entry[], file ?? "");
	const others = scanSessions(root).filter((s) => !file || join(root, s.file) !== file);
	return { session, today: { day: now.toISOString().slice(0, 10), ...dayTotals([...others, session], now) } };
}

/** The nearest-rank percentile of `xs` (p in 0..100), or null for none. */
export function percentile(xs: readonly number[], p: number): number | null {
	if (!xs.length) return null;
	const sorted = [...xs].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const usd = (x: number) => `$${x.toFixed(4)}`;
const cap = (x: number) => `$${x.toFixed(2)}`;
const n = (x: number) => x.toLocaleString("en-GB");
const secs = (x: number | null) => (x === null ? "?" : `${Math.round(x / 1000)} s`);

/** The /usage text for the current session and today (UTC), at most 100 columns. */
export function usageLines(session: SessionUsage, today: { day: string; sessions: number; cost: number }, cfg: { soft: number; hard: number; daily: number; maxTurns: number }): string[] {
	const t = session.tokens;
	const tools = Object.entries(session.tools)
		.filter(([name]) => name !== "(text)" && name !== PI_CALLS)
		.map(([name, s]) => `${name} ${s.calls}${s.errors ? ` (${s.errors} failed)` : ""}`);
	const recs = session.runs.filter((r) => r.recommendation);
	const last = session.runs.at(-1);
	const softState = session.budget.steered ? "reached; the model was told to wrap up" : session.cost >= cfg.soft ? "reached" : "not reached";
	const lines = [
		"GAFFER · usage",
		`This session: ${session.calls} model call${session.calls === 1 ? "" : "s"}${session.models.length ? ` (${session.models.join(", ")})` : ""}, ${usd(session.cost)}`,
		`  tokens: input ${n(t.input)}, output ${n(t.output)}, cache read ${n(t.cacheRead)}, cache write ${n(t.cacheWrite)}`,
		`  runs: ${session.runs.length}, ${recs.length} with a recommendation` + (last ? `; last run ${secs(last.ms)}${last.recommendation ? " to its recommendation" : ""}` : ""),
	];
	if (tools.length) lines.push(`  tools: ${tools.join(" · ")}`);
	const pi = session.tools[PI_CALLS];
	if (pi) lines.push(`  ${PI_CALLS}: ${pi.calls}, ${usd(pi.cost)}`);
	if (session.validations.failed) lines.push(`  submissions refused by the gate: ${session.validations.failed} of ${session.validations.attempts}`);
	lines.push(`  budget: soft ${cap(cfg.soft)} (${softState}) · hard ${cap(cfg.hard)}${session.budget.capped ? ` (stopped: ${session.budget.capped})` : ""} · ${cfg.maxTurns} turns a run`);
	lines.push(`Today (UTC ${today.day}): ${usd(today.cost)} across ${today.sessions} session${today.sessions === 1 ? "" : "s"}; daily cap ${cap(cfg.daily)} (${usd(Math.max(cfg.daily - today.cost, 0))} left)`);
	return lines;
}
