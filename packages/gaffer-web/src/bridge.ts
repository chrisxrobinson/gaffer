/**
 * gaffer-web: the Gaffer App's bridge (ADR 0014). Plain Node and Pi's RpcClient, in the harness container.
 *
 * - The page never speaks RPC. It calls this bridge's small API; the bridge builds every Pi command itself and
 *   sends Pi only ADR 0014's allowlist: `prompt` (a bridge-built `/run {json}`, or follow-up text of at most 280
 *   characters not starting with `/` or `!`), `steer`, `abort`, `get_state`, `set_session_name` (capped), and
 *   `extension_ui_response` (a cancel, only for a dialog that process asked). get_messages, get_entries and
 *   get_session_stats are allowed but not needed: history is read from the session file.
 * - One `gaffer-pi --mode rpc [--session PATH]` per open session, through RpcClient, stopped after 15 idle
 *   minutes. Sessions are addressed by id and resolved to a path here: no client path reaches Pi.
 * - Server-sent events with sequence ids; the current run's events are kept per session, so a reconnect replays
 *   from Last-Event-ID and then follows live (FR-UI-03). Commands are POSTs with request ids, answered once.
 * - Every request must come from the App's own origin on a loopback host name (DNS rebinding, cross-site).
 * - Read-only calls into Gaffer's src/ for the session list, the next GW, the team check, preferences and spend.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { checkTeam, fplBootstrap, gwInfo, listSessions, type SessionSummary, teamSquad } from "../../pi-gaffer/src/app-data.ts";
import { dayCost } from "../../pi-gaffer/src/budget.ts";
import { budgetConfig, fplNow, idSalt } from "../../pi-gaffer/src/config.ts";
import { FplClient } from "../../pi-gaffer/src/http.ts";
import { lockHolder, runLockPath, sessionLockPath } from "../../pi-gaffer/src/lock.ts";
import { readPrefs } from "../../pi-gaffer/src/prefs.ts";
import { hashTeamId } from "../../pi-gaffer/src/team-hash.ts";
import { SnapshotStore } from "../../pi-gaffer/src/store.ts";
import { parseEntries } from "../../pi-gaffer/src/usage.ts";

export const ASK_MAX = 280;
export const NAME_MAX = 80;
const IDLE_MS = 15 * 60_000;
const BODY_MAX = 16_384;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;

/** What the bridge needs of a Pi process: RpcClient's allowlisted methods, and a way to cancel a dialog. */
export type Pi = Pick<RpcClient, "start" | "stop" | "onEvent" | "prompt" | "steer" | "abort" | "getState" | "setSessionName"> & {
	cancelDialog(id: string): void;
};

/** `harness/gaffer-pi --mode rpc [--session PATH]`: the launcher prints Pi's arguments, RpcClient runs Pi with them. */
export function gafferPi(sessionPath?: string, launcher = process.env.GAFFER_PI ?? "/opt/gaffer/gaffer-pi", cli = process.env.GAFFER_PI_CLI ?? "/usr/local/bin/pi"): Pi {
	const args = execFileSync(launcher, ["--mode", "rpc", ...(sessionPath ? ["--session", sessionPath] : [])], { env: { ...process.env, GAFFER_PI_PRINT: "1" }, encoding: "utf8" }).trim().split("\n");
	const client = new RpcClient({ cliPath: cli, cwd: "/work", args });
	// RpcClient has no method for an extension_ui_response; its child's stdin is the RPC channel.
	const stdin = () => (client as unknown as { process: { stdin?: NodeJS.WritableStream } | null }).process?.stdin;
	return Object.assign(client, { cancelDialog: (id: string) => void stdin()?.write(`${JSON.stringify({ type: "extension_ui_response", id, cancelled: true })}\n`) });
}

export interface BridgeOptions {
	sessionsDir: string;
	dataDir: string;
	publicDir: string;
	spawnPi?: (sessionPath?: string) => Pi;
	idleMs?: number;
	fpl?: FplClient;
	/** Replay mode: the home and team answers come from the recording, not FPL (replay.ts). */
	replay?: { home(): Record<string, unknown>; team(id: number): unknown };
	/** Extra files by URL path (replay mode's dev tools). */
	devFiles?: Record<string, string>;
}

interface Frame {
	id: number;
	data: string;
}

interface Live {
	id: string;
	file: string;
	pi: Pi;
	seq: number;
	/** Events since the bridge last sent this process a prompt: the current (or last) run. */
	buffer: Frame[];
	/** The session file's size when that prompt was sent: history up to here, the buffer after. */
	historyBytes: number;
	running: boolean;
	readOnly?: string;
	clients: Set<ServerResponse>;
	idle?: NodeJS.Timeout;
	waiters: ((e: Record<string, any>) => void)[];
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
	".woff2": "font/woff2", ".json": "application/json", ".map": "application/json", ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon",
};

class HttpError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const sizeOf = (file: string) => {
	try {
		return statSync(file).size;
	} catch {
		return 0;
	}
};
const textOf = (content: unknown): string => (typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("") : "");
const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(-n)}` : s);

/** A gaffer.validation entry without its replay request (the whole plan file): what the App shows of it. */
const slimValidation = (d: Record<string, unknown>) => ({ attempt: d.attempt, passed: d.passed, stage: d.stage, errors: d.errors, rec_id: d.rec_id });

/**
 * What of Pi's event stream reaches the page: the events docs/ui §7 maps, without the system prompt, the
 * repeated whole-run payloads (agent_end.messages, turn_end), tool results' message copies, argument deltas,
 * and each validation's replay request. Dialogs never reach the page (Gaffer issues none): they are cancelled.
 */
export function forwardEvent(e: Record<string, any>, cancel: (id: string) => void): Record<string, unknown> | undefined {
	switch (e.type) {
		case "response":
			return undefined;
		case "message_start":
		case "message_end": {
			const m = e.message ?? {};
			if (m.role === "system" || m.role === "toolResult") return undefined;
			if (m.role === "assistant") {
				const content = e.type === "message_end" ? (m.content ?? []).map((c: Record<string, unknown>) => (c.type === "toolCall" ? { type: c.type, id: c.id, name: c.name } : c)) : [];
				return { type: e.type, message: { role: m.role, content, usage: m.usage, stopReason: m.stopReason, errorMessage: m.errorMessage, timestamp: m.timestamp } };
			}
			return { type: e.type, message: { role: m.role, customType: m.customType, content: textOf(m.content), timestamp: m.timestamp } };
		}
		case "message_update": {
			const a = e.assistantMessageEvent ?? {};
			if (a.type === "toolcall_delta") return undefined;
			const { partial: _p, ...rest } = a;
			if (rest.toolCall) rest.toolCall = { id: rest.toolCall.id, name: rest.toolCall.name };
			return { type: e.type, usage: e.usage, assistantMessageEvent: rest };
		}
		case "turn_end":
		case "agent_end":
			return { type: e.type };
		case "tool_execution_update":
			return { type: e.type, toolCallId: e.toolCallId, toolName: e.toolName, partialResult: { content: tail(textOf(e.partialResult?.content), 4000), details: e.partialResult?.details } };
		case "tool_execution_end": {
			const r = e.result ?? {};
			const sc = r.structuredContent;
			return {
				type: e.type, toolCallId: e.toolCallId, toolName: e.toolName, isError: e.isError, durationMs: e.durationMs,
				result: { content: tail(textOf(r.content), 20_000), details: r.details, structuredContent: sc && { exit_code: sc.exit_code, truncated: sc.truncated, wall_time_seconds: sc.wall_time_seconds } },
			};
		}
		case "entry_appended": {
			const en = e.entry ?? {};
			if (en.type === "session_info") return { type: e.type, entry: { type: en.type, id: en.id, name: en.name, timestamp: en.timestamp } };
			if (en.type !== "custom" || !String(en.customType).startsWith("gaffer.")) return undefined;
			const data = en.customType === "gaffer.validation" ? slimValidation(en.data ?? {}) : en.data;
			return { type: e.type, entry: { type: en.type, customType: en.customType, id: en.id, data, timestamp: en.timestamp } };
		}
		case "extension_ui_request":
			if (["notify", "setStatus", "setTitle", "setWidget"].includes(e.method)) return e;
			if (["select", "confirm", "input", "editor"].includes(e.method)) cancel(e.id);
			return undefined;
		default:
			return e;
	}
}

/** A session file's entries as the App renders them: no system prompt, no replay requests, outputs shortened. */
export function historyOf(text: string): Record<string, unknown>[] {
	return (parseEntries(text) as Record<string, any>[]).flatMap((e): Record<string, unknown>[] => {
		if (e.type === "session") return [{ type: e.type, id: e.id, timestamp: e.timestamp }];
		if (e.type === "session_info") return [{ type: e.type, name: e.name, timestamp: e.timestamp }];
		if (e.type === "custom" && String(e.customType).startsWith("gaffer.")) {
			return [{ type: e.type, customType: e.customType, timestamp: e.timestamp, data: e.customType === "gaffer.validation" ? slimValidation(e.data ?? {}) : e.data }];
		}
		if (e.type !== "message") return [];
		const m = e.message ?? {};
		if (m.role === "system") return [];
		if (m.role === "toolResult") {
			const sc = m.structuredContent;
			return [{ type: e.type, timestamp: e.timestamp, message: { role: m.role, toolCallId: m.toolCallId, toolName: m.toolName, isError: m.isError, timestamp: m.timestamp, content: tail(textOf(m.content), 8000), details: m.details, structuredContent: sc && { exit_code: sc.exit_code } } }];
		}
		if (m.role === "assistant") return [{ type: e.type, timestamp: e.timestamp, message: { role: m.role, content: m.content, usage: m.usage, stopReason: m.stopReason, errorMessage: m.errorMessage, timestamp: m.timestamp } }];
		return [{ type: e.type, timestamp: e.timestamp, message: { role: m.role, customType: m.customType, content: textOf(m.content), timestamp: m.timestamp } }];
	});
}

/** The page's Start options, checked field by field: the only input that reaches `/run`'s JSON. */
export function runSpec(body: Record<string, any>): Record<string, unknown> {
	const o = body.options ?? {};
	const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
	if (!int(body.team_id, 1, 9_999_999_999)) throw new HttpError(400, "team_id must be a whole number");
	if (!["safe", "balanced", "aggressive"].includes(o.risk)) throw new HttpError(400, "risk must be safe, balanced or aggressive");
	if (!(o.max_hits_per_gw === null || int(o.max_hits_per_gw, 0, 15))) throw new HttpError(400, "max_hits_per_gw must be 0-15 or null");
	if (!Array.isArray(o.save_chips) || o.save_chips.length > 4 || o.save_chips.some((c: unknown) => !["wildcard", "freehit", "bboost", "3xc"].includes(c as string))) throw new HttpError(400, "save_chips must list chips");
	if (!Array.isArray(o.keep) || o.keep.length > 15 || o.keep.some((p: unknown) => !int(p, 1, 99_999))) throw new HttpError(400, "keep must list player ids");
	if (o.ft !== undefined && o.ft !== null && !int(o.ft, 0, 5)) throw new HttpError(400, "ft must be 0-5");
	if (o.pending !== undefined && o.pending !== null && o.pending !== "" && (typeof o.pending !== "string" || o.pending.length > 200 || !/^[^>,;]+>[^>,;]+(\s*[,;]\s*[^>,;]+>[^>,;]+)*$/.test(o.pending))) {
		throw new HttpError(400, 'transfers already made look like "Salah>Palmer, Saka>Foden"');
	}
	if (typeof o.save !== "boolean") throw new HttpError(400, "save must be true or false");
	const options: Record<string, unknown> = { risk: o.risk, max_hits_per_gw: o.max_hits_per_gw, save_chips: [...new Set(o.save_chips)], keep: [...new Set(o.keep)], save: o.save };
	if (Number.isInteger(o.ft)) options.ft = o.ft;
	if (o.pending) options.pending = o.pending;
	return { action: "recommend", team_id: body.team_id, options };
}

/** Follow-up text (FR-UI-13's box, M1.1-4): plain words only, never a command or a shell line. */
export function askText(text: unknown): string {
	if (typeof text !== "string") throw new HttpError(400, "text is required");
	const t = text.trim();
	if (!t) throw new HttpError(400, "text is required");
	if (t.length > ASK_MAX) throw new HttpError(400, `at most ${ASK_MAX} characters`);
	if (/^[/!]/.test(t)) throw new HttpError(400, "questions can't start with / or !");
	if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(t)) throw new HttpError(400, "text has control characters");
	return t;
}

export function createBridge(opts: BridgeOptions): { server: Server; close(): Promise<void>; live: Map<string, Live> } {
	const spawnPi = opts.spawnPi ?? ((p?: string) => gafferPi(p));
	const idleMs = opts.idleMs ?? IDLE_MS;
	const fpl = opts.fpl ?? new FplClient({ timeoutMs: 8000 });
	const publicDir = resolve(opts.publicDir);
	const live = new Map<string, Live>();
	const done = new Map<string, { status: number; body: unknown }>();
	let gwCache: { at: number; value: Promise<unknown> } | undefined;

	const indexHtml = readFileSync(join(publicDir, "index.html"), "utf8");
	// The page's one inline script is its import map; the policy allows exactly that script by hash.
	const importMap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(indexHtml)?.[1] ?? "";
	const csp = [
		"default-src 'none'", `script-src 'self' 'sha256-${createHash("sha256").update(importMap).digest("base64")}'`, "style-src 'self'", "font-src 'self'", "img-src 'self' data:", "connect-src 'self'",
		"base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
	].join("; ");

	const send = (res: ServerResponse, status: number, body: unknown) => {
		res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
	};

	const sessions = () => listSessions(opts.sessionsDir);
	const resolveSession = (id: string): { id: string; file: string; summary?: SessionSummary } => {
		if (!SESSION_ID.test(id)) throw new HttpError(404, "no such session");
		const l = live.get(id);
		if (l) return { id, file: l.file };
		const s = sessions().find((x) => x.id === id);
		if (!s) throw new HttpError(404, "no such session");
		return { id, file: s.file, summary: s };
	};

	const broadcast = (l: Live, e: Record<string, unknown>) => {
		const frame = { id: ++l.seq, data: JSON.stringify({ ...e, at: Date.now() }) };
		l.buffer.push(frame);
		if (l.buffer.length > 20_000) l.buffer.splice(0, l.buffer.length - 20_000);
		for (const c of l.clients) c.write(`id: ${frame.id}\ndata: ${frame.data}\n\n`);
	};

	const armIdle = (l: Live) => {
		clearTimeout(l.idle);
		l.idle = setTimeout(() => {
			if (l.running) return armIdle(l);
			void stop(l, "idle");
		}, idleMs);
		l.idle.unref();
	};

	const stop = async (l: Live, why: string) => {
		clearTimeout(l.idle);
		live.delete(l.id);
		await l.pi.stop().catch(() => undefined);
		for (const c of l.clients) c.end(`event: closed\ndata: ${JSON.stringify({ why })}\n\n`);
	};

	/** Spawn a Pi for a session (or a new one), and wait until it has opened it; refuse if it opened read-only. */
	const open = async (file?: string): Promise<Live> => {
		const pi = spawnPi(file);
		const l: Live = { id: "", file: file ?? "", pi, seq: 0, buffer: [], historyBytes: 0, running: false, clients: new Set(), waiters: [] };
		pi.onEvent((raw) => {
			const e = raw as Record<string, any>;
			if (e.type === "extension_ui_request" && e.method === "setStatus" && e.statusKey === "gaffer-lock") l.readOnly = e.statusText || undefined;
			if (e.type === "agent_start") l.running = true;
			if (e.type === "agent_settled") {
				l.running = false;
				armIdle(l);
			}
			for (const w of [...l.waiters]) w(e);
			const out = forwardEvent(e, (id) => pi.cancelDialog(id));
			if (out && l.id) broadcast(l, out);
		});
		let state: Awaited<ReturnType<Pi["getState"]>>;
		try {
			await pi.start();
			state = await pi.getState();
		} catch (e) {
			await pi.stop().catch(() => undefined);
			throw new HttpError(502, `Gaffer could not start (${(e as Error).message.split("\n")[0]})`);
		}
		if (l.readOnly) {
			await pi.stop().catch(() => undefined);
			throw new HttpError(409, `This session is ${l.readOnly.replace(/^read-only: /, "")}. Only one can send a prompt at a time.`);
		}
		l.id = state.sessionId;
		l.file = state.sessionFile ?? l.file;
		live.set(l.id, l);
		armIdle(l);
		return l;
	};

	/** Send a prompt and wait for the run to start, or for Pi to say why it didn't (a warning or error notice). */
	const promptAndStart = (l: Live, text: string, ms = 30_000) =>
		new Promise<void>((ok, fail) => {
			l.historyBytes = sizeOf(l.file);
			l.buffer = [];
			let over = false;
			const finish = (err?: Error) => {
				if (over) return;
				over = true;
				clearTimeout(timer);
				l.waiters = l.waiters.filter((w) => w !== waiter);
				if (err) fail(err);
				else ok();
			};
			const timer = setTimeout(() => finish(new HttpError(504, "The run didn't start in time.")), ms);
			const waiter = (e: Record<string, any>) => {
				if (e.type === "agent_start") finish();
				else if (e.type === "extension_ui_request" && e.method === "notify" && (e.notifyType === "error" || e.notifyType === "warning")) finish(new HttpError(409, String(e.message)));
			};
			l.waiters.push(waiter);
			l.pi.prompt(text).catch((err: Error) => {
				// A Pi that has exited is no longer this session's writer: let the next command spawn another.
				if (/exited|not started|not writable/.test(err.message)) void stop(l, "exited");
				finish(new HttpError(502, err.message.split("\n")[0]));
			});
		});

	const once = async (req: IncomingMessage, res: ServerResponse, body: Record<string, any>, act: () => Promise<{ status: number; body: unknown }>) => {
		const key = typeof body.requestId === "string" && /^[A-Za-z0-9-]{8,64}$/.test(body.requestId) ? `${req.url}#${body.requestId}` : undefined;
		if (!key) throw new HttpError(400, "requestId is required");
		const prior = done.get(key);
		if (prior) return send(res, prior.status, prior.body);
		let out: { status: number; body: unknown };
		try {
			out = await act();
		} catch (e) {
			out = e instanceof HttpError ? { status: e.status, body: { error: e.message } } : { status: 500, body: { error: (e as Error).message.split("\n")[0] } };
		}
		done.set(key, out);
		if (done.size > 500) done.delete(done.keys().next().value!);
		send(res, out.status, out.body);
	};

	const pending = (listed = sessions()) => [...live.values()].filter((l) => !listed.some((s) => s.id === l.id)).map((l) => ({ id: l.id, live: l.running ? "running" : "open" }));
	const home = async () => {
		if (opts.replay) return { ...opts.replay.home(), pending: pending() };
		const cfg = budgetConfig();
		gwCache = gwCache && Date.now() - gwCache.at < 5 * 60_000 ? gwCache : { at: Date.now(), value: fplBootstrap(new SnapshotStore(opts.dataDir), fpl, fplNow()).then(gwInfo).catch(() => null) };
		const busy = lockHolder(runLockPath(opts.sessionsDir));
		const listed = sessions();
		return {
			gw: await gwCache.value,
			now: fplNow(),
			spend: { today: Math.round(dayCost(opts.sessionsDir, new Date()) * 1e6) / 1e6, daily: cfg.daily, soft: cfg.soft, hard: cfg.hard },
			busy: busy ? { ui: busy.ui } : null,
			sessions: listed.map(({ file: _f, ...s }) => ({ ...s, live: live.get(s.id)?.running ? "running" : live.has(s.id) ? "open" : null })),
			pending: pending(listed),
		};
	};

	const team = async (raw: string) => {
		if (!/^\d{1,10}$/.test(raw) || Number(raw) < 1) throw new HttpError(400, "Digits only, from your Points page address");
		const id = Number(raw);
		if (opts.replay) return opts.replay.team(id);
		const check = await checkTeam(fpl, id, AbortSignal.timeout(9500));
		if (!check.ok) throw new HttpError(check.reason === "not_found" ? 404 : 502, check.reason === "not_found" ? "not found" : `FPL could not be reached (${check.message})`);
		const b = await fplBootstrap(new SnapshotStore(opts.dataDir), fpl, fplNow()).catch(() => undefined);
		const squad = b ? await teamSquad(fpl, b, id).catch(() => []) : [];
		const next = b ? gwInfo(b).next : null;
		const hash = hashTeamId(id, idSalt());
		const ft = sessions().find((s) => s.team?.id === id && s.ft && s.ft.gw === next)?.ft ?? null;
		const { schema: _s, updated_at: _u, ...prefs } = readPrefs(opts.dataDir, hash) ?? { schema: "", updated_at: "" };
		return { id, name: check.name, squad, prefs: "risk" in prefs ? prefs : null, ft };
	};

	const sessionView = (id: string) => {
		const s = resolveSession(id);
		const l = live.get(id);
		let text = "";
		try {
			text = readFileSync(s.file, "utf8");
		} catch {
			/* a new session: its file appears with its first prompt */
		}
		if (l) text = text.slice(0, l.historyBytes);
		const owner = l ? undefined : lockHolder(sessionLockPath(s.file));
		return {
			id,
			history: historyOf(text),
			live: l ? { running: l.running, from: l.buffer[0]?.id ?? l.seq + 1, seq: l.seq } : null,
			lock: owner ? { ui: owner.ui } : null,
		};
	};

	const command = async (id: string, body: Record<string, any>) => {
		const s = resolveSession(id);
		let l = live.get(id);
		const needWriter = async () => {
			if (l) return l;
			const owner = lockHolder(sessionLockPath(s.file));
			if (owner) throw new HttpError(409, `This session is open in ${owner.ui === "terminal" ? "the browser terminal" : "another process"}. Only one can send a prompt at a time.`);
			return (l = await open(s.file));
		};
		switch (body.type) {
			case "stop":
				if (!l?.running) throw new HttpError(409, "Nothing is running.");
				await l.pi.abort();
				return { status: 200, body: { ok: true } };
			case "rename": {
				const name = typeof body.text === "string" ? body.text.trim() : "";
				if (!name || name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, `A name is 1 to ${NAME_MAX} characters.`);
				await (await needWriter()).pi.setSessionName(name);
				return { status: 200, body: { ok: true } };
			}
			case "ask": {
				const text = askText(body.text);
				const w = await needWriter();
				if (w.running) await w.pi.steer(text);
				else await promptAndStart(w, text);
				return { status: 200, body: { ok: true } };
			}
			default:
				throw new HttpError(400, "unknown command");
		}
	};

	const newRun = async (body: Record<string, any>) => {
		const spec = runSpec(body);
		const busy = lockHolder(runLockPath(opts.sessionsDir));
		if (busy) throw new HttpError(409, `A run is in progress in ${busy.ui === "terminal" ? "the browser terminal" : busy.ui === "app" ? "the Gaffer App" : "another Gaffer process"}. Gaffer runs one at a time here.`);
		const l = await open();
		try {
			await promptAndStart(l, `/run ${JSON.stringify(spec)}`);
		} catch (e) {
			await stop(l, "not started");
			throw e;
		}
		return { status: 201, body: { id: l.id } };
	};

	const events = (req: IncomingMessage, res: ServerResponse, id: string) => {
		resolveSession(id);
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
		res.write("retry: 2000\n\n");
		const after = Number(req.headers["last-event-id"] ?? new URL(req.url ?? "/", "http://x").searchParams.get("after") ?? 0);
		const l = live.get(id);
		if (l) {
			const first = l.buffer[0]?.id ?? l.seq + 1;
			// Events this page saw belong to an earlier run, or were never buffered: it reloads the session first.
			if (after && after < first - 1) res.write(`event: reset\ndata: {}\n\n`);
			else for (const f of l.buffer) if (f.id > after) res.write(`id: ${f.id}\ndata: ${f.data}\n\n`);
			l.clients.add(res);
		}
		const ping = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
		req.on("close", () => {
			clearInterval(ping);
			l?.clients.delete(res);
		});
	};

	const readBody = (req: IncomingMessage): Promise<Record<string, any>> =>
		new Promise((ok, fail) => {
			if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return fail(new HttpError(415, "JSON only"));
			let size = 0;
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => {
				size += c.length;
				if (size <= BODY_MAX) chunks.push(c); // past the limit the rest is read and dropped
			});
			req.on("end", () => {
				if (size > BODY_MAX) return fail(new HttpError(413, "request too large"));
				try {
					const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
					ok(v);
				} catch {
					fail(new HttpError(400, "invalid JSON"));
				}
			});
		});

	const serveStatic = (res: ServerResponse, path: string) => {
		const dev = opts.devFiles?.[path];
		if (dev) return void res.writeHead(200, { "content-type": CONTENT_TYPES[extname(dev)] }).end(readFileSync(dev));
		const rel = path === "/" ? "index.html" : decodeURIComponent(path.slice(1));
		const file = resolve(publicDir, rel);
		if (!file.startsWith(publicDir + sep) || !CONTENT_TYPES[extname(file)]) throw new HttpError(404, "not found");
		let body: Buffer;
		try {
			body = file.endsWith(`${sep}index.html`) ? Buffer.from(indexHtml) : readFileSync(file);
		} catch {
			throw new HttpError(404, "not found");
		}
		const html = extname(file) === ".html";
		res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)], "cache-control": "no-store", ...(html && { "content-security-policy": csp }) }).end(body);
	};

	const server = createServer(async (req, res) => {
		res.setHeader("x-content-type-options", "nosniff");
		res.setHeader("referrer-policy", "no-referrer");
		res.setHeader("x-frame-options", "DENY");
		try {
			// DNS rebinding: the page is only served under a loopback name. Cross-site: only from its own origin.
			const host = req.headers.host ?? "";
			if (!LOOPBACK.test(host)) throw new HttpError(421, "wrong host");
			const origin = req.headers.origin;
			const write = req.method !== "GET" && req.method !== "HEAD";
			if ((origin !== undefined || write) && origin !== `http://${host}`) throw new HttpError(403, "cross-origin request refused");
			const site = req.headers["sec-fetch-site"];
			if (site !== undefined && site !== "same-origin" && site !== "none") throw new HttpError(403, "cross-site request refused");
			const url = new URL(req.url ?? "/", `http://${host}`);
			const p = url.pathname;
			if (!p.startsWith("/api/")) {
				if (write) throw new HttpError(405, "method not allowed");
				return serveStatic(res, p);
			}
			let m: RegExpExecArray | null;
			if (req.method === "GET" && p === "/api/home") return send(res, 200, await home());
			if (req.method === "GET" && (m = /^\/api\/team\/([^/]+)$/.exec(p))) return send(res, 200, await team(m[1]));
			if (req.method === "GET" && (m = /^\/api\/sessions\/([^/]+)$/.exec(p))) return send(res, 200, sessionView(m[1]));
			if (req.method === "GET" && (m = /^\/api\/sessions\/([^/]+)\/events$/.exec(p))) return events(req, res, m[1]);
			if (req.method === "POST" && p === "/api/runs") {
				const body = await readBody(req);
				return await once(req, res, body, () => newRun(body));
			}
			if (req.method === "POST" && (m = /^\/api\/sessions\/([^/]+)\/commands$/.exec(p))) {
				const body = await readBody(req);
				const id = m[1];
				return await once(req, res, body, () => command(id, body));
			}
			throw new HttpError(404, "not found");
		} catch (e) {
			if (res.headersSent) return res.end();
			if (e instanceof HttpError) return send(res, e.status, { error: e.message });
			console.error("gaffer-web:", e);
			send(res, 500, { error: "internal error" });
		}
	});

	return {
		server,
		live,
		async close() {
			await Promise.all([...live.values()].map((l) => stop(l, "shutdown")));
			const closed = new Promise<void>((r) => server.close(() => r()));
			server.closeAllConnections(); // event streams stay open otherwise
			await closed;
		},
	};
}
