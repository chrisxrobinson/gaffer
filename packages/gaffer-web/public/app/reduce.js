// The App's one reducer (ADR 0011's seam, docs/ui §7): a session's state, built from Pi's event stream as the
// bridge forwards it, or from the session file's committed entries turned into the same events (historyEvents).
// Data only: the views decide the words. Nothing here reads text the model wrote, except to show it as text.

export function initialState() {
	return {
		brief: null, team: null, snapshot: null, budget: null, name: null, result: null, failure: null,
		items: [], steps: {}, validations: [], notices: [], queue: [], retry: null, compacting: false, readOnly: null,
		running: false, startedAt: null, endedAt: null, aborted: false, cost: 0, liveCost: 0, msg: 0, briefPending: false, errors: [],
	};
}

const PROGRESS = "progress: ";
const lastProgress = (text) => {
	const lines = String(text ?? "").split("\n").filter((l) => l.startsWith(PROGRESS));
	return lines.length ? lines[lines.length - 1].slice(PROGRESS.length) : null;
};
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x?.text === "string" ? x.text : "")).join("") : "");

function withStep(s, id, patch, at) {
	const prev = s.steps[id];
	const items = prev ? s.items : [...s.items, { kind: "step", id }];
	return { ...s, items, steps: { ...s.steps, [id]: { id, status: "pending", ...prev, ...patch, ...(prev ? {} : { createdAt: at }) } } };
}

function withItem(s, key, kind, f) {
	const i = s.items.findIndex((x) => x.key === key);
	if (i < 0) return { ...s, items: [...s.items, f({ kind, key, text: "", done: false })] };
	const items = s.items.slice();
	items[i] = f(items[i]);
	return { ...s, items };
}

/** The latest submit_recommendation step not yet given its check, for a gaffer.validation entry. */
function lastSubmit(s) {
	const ids = s.items.filter((x) => x.kind === "step" && s.steps[x.id]?.tool === "submit_recommendation").map((x) => x.id);
	return ids.reverse().find((id) => !s.steps[id].check) ?? ids[0];
}

function entry(s, en, at) {
	const d = en?.data;
	if (en?.type === "session_info") return { ...s, name: en.name ?? null };
	switch (en?.customType) {
		case "gaffer.run":
			return { ...s, brief: { ...d, at }, briefPending: true };
		case "gaffer.team":
			return { ...s, team: d };
		case "gaffer.snapshot":
			return { ...s, snapshot: d };
		case "gaffer.budget":
			return { ...s, budget: d };
		case "gaffer.recommendation":
			return { ...s, result: d, failure: null };
		case "gaffer.validation": {
			const next = { ...s, validations: [...s.validations, d] };
			const id = lastSubmit(next);
			return id ? withStep(next, id, { check: d }, at) : next;
		}
		default:
			return s;
	}
}

export function reduce(s, e) {
	const at = e.at ?? Date.now();
	switch (e.type) {
		case "entry_appended":
			return entry(s, e.entry, at);
		case "agent_start":
			return { ...s, running: true, startedAt: at, endedAt: null, aborted: false, retry: null };
		case "agent_settled":
			return { ...s, running: false, endedAt: at, aborted: !!e.aborted, retry: null, queue: [] };
		case "message_start": {
			const m = e.message ?? {};
			if (m.role === "assistant") return { ...s, msg: s.msg + 1, liveCost: 0 };
			if (m.role === "user") {
				// A run the App started shows its brief, not the template text it was sent as.
				if (s.briefPending) return { ...s, briefPending: false };
				return { ...s, items: [...s.items, { kind: "user", key: `u${s.items.length}`, text: textOf(m.content) }] };
			}
			if (m.role === "custom" && m.customType === "gaffer.steer") return { ...s, items: [...s.items, { kind: "note", key: `n${s.items.length}`, note: "steer" }] };
			return s;
		}
		case "message_end": {
			const m = e.message ?? {};
			if (m.role !== "assistant") return s;
			const errors = m.stopReason === "error" && m.errorMessage ? [...s.errors, m.errorMessage] : s.errors;
			return { ...s, cost: s.cost + (m.usage?.cost?.total ?? 0), liveCost: 0, errors };
		}
		case "message_update": {
			const a = e.assistantMessageEvent ?? {};
			const live = { ...s, liveCost: e.usage?.cost?.total ?? s.liveCost };
			const key = `${s.msg}:${a.contentIndex}`;
			const kind = a.type?.startsWith("thinking") ? "think" : a.type?.startsWith("text") ? "say" : null;
			if (kind && a.type.endsWith("_start")) return withItem(live, key, kind, (x) => x);
			if (kind && a.type.endsWith("_delta")) return withItem(live, key, kind, (x) => ({ ...x, text: x.text + (a.delta ?? "") }));
			if (kind && a.type.endsWith("_end")) {
				const text = typeof a.content === "string" ? a.content : null;
				// A redacted block carries no words: it is not shown (research 11 §6).
				if (kind === "think" && (a.redacted || text === "[Reasoning redacted]")) return { ...live, items: live.items.filter((x) => x.key !== key) };
				const next = withItem(live, key, kind, (x) => ({ ...x, text: text ?? x.text, done: true }));
				return next.items.find((x) => x.key === key)?.text.trim() ? next : { ...next, items: next.items.filter((x) => x.key !== key) };
			}
			if (a.type === "toolcall_start") return withStep(live, a.id, { tool: a.toolName }, at);
			return live;
		}
		case "tool_execution_start":
			return withStep(s, e.toolCallId, { tool: e.toolName, status: "running", args: e.args, startedAt: at }, at);
		case "tool_execution_update": {
			const text = textOf(e.partialResult?.content);
			const progress = lastProgress(text);
			const prev = s.steps[e.toolCallId];
			return withStep(s, e.toolCallId, { tool: e.toolName, status: "running", partial: text, stage: e.partialResult?.details?.stage ?? prev?.stage, progress: progress ?? prev?.progress ?? null }, at);
		}
		case "tool_execution_end": {
			const r = e.result ?? {};
			const exit = r.structuredContent?.exit_code;
			const failed = !!e.isError || (typeof exit === "number" && exit !== 0);
			const prev = s.steps[e.toolCallId];
			let next = withStep(s, e.toolCallId, {
				tool: e.toolName, status: failed ? "err" : "ok", text: textOf(r.content), details: r.details ?? null, exit: exit ?? null, partial: undefined,
				durationMs: e.durationMs ?? (prev?.startedAt ? at - prev.startedAt : undefined), endedAt: at,
			}, at);
			if (e.toolName === "submit_recommendation" && r.details?.recommendation) next = { ...next, result: r.details.recommendation, failure: null };
			if (e.toolName === "submit_recommendation" && r.details?.failed) next = { ...next, failure: { attempts: r.details.attempts, errors: r.details.errors ?? [] } };
			return next;
		}
		case "extension_ui_request":
			if (e.method === "notify") return { ...s, notices: [...s.notices, { type: e.notifyType ?? "info", message: String(e.message ?? ""), at }] };
			if (e.method === "setStatus" && e.statusKey === "gaffer-lock") return { ...s, readOnly: e.statusText || null };
			return s;
		case "queue_update":
			return { ...s, queue: [...(e.steering ?? []), ...(e.followUp ?? [])] };
		case "auto_retry_start":
			return { ...s, retry: { attempt: e.attempt, maxAttempts: e.maxAttempts, delayMs: e.delayMs, errorMessage: e.errorMessage } };
		case "auto_retry_end":
			return { ...s, retry: null };
		case "compaction_start":
			return { ...s, compacting: true };
		case "compaction_end":
			return { ...s, compacting: false };
		case "extension_error":
			return { ...s, errors: [...s.errors, String(e.error ?? "an extension failed")] };
		default:
			return s;
	}
}

/** A session file's committed entries (the bridge's history) as the events the reducer takes. */
export function historyEvents(entries) {
	const out = [];
	let assistantAt = null;
	for (const e of entries ?? []) {
		const at = Date.parse(e.timestamp) || 0;
		if (e.type === "custom") out.push({ type: "entry_appended", entry: { type: "custom", customType: e.customType, data: e.data }, at });
		else if (e.type === "session_info") out.push({ type: "entry_appended", entry: { type: "session_info", name: e.name }, at });
		else if (e.type === "message") {
			const m = e.message ?? {};
			if (m.role === "user" || m.role === "custom") out.push({ type: "message_start", message: m, at });
			else if (m.role === "assistant") {
				out.push({ type: "message_start", message: { role: "assistant" }, at });
				(m.content ?? []).forEach((c, i) => {
					if (c.type === "thinking") out.push({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: i, content: c.thinking, redacted: c.redacted }, at });
					else if (c.type === "text") out.push({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: i, content: c.text }, at });
					else if (c.type === "toolCall") {
						out.push({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: i, id: c.id, toolName: c.name }, at });
						out.push({ type: "tool_execution_start", toolCallId: c.id, toolName: c.name, args: c.arguments, at });
					}
				});
				out.push({ type: "message_end", message: { role: "assistant", usage: m.usage, stopReason: m.stopReason, errorMessage: m.errorMessage }, at });
				assistantAt = at;
			} else if (m.role === "toolResult") {
				out.push({ type: "tool_execution_end", toolCallId: m.toolCallId, toolName: m.toolName, isError: m.isError, durationMs: assistantAt ? Math.max(0, at - assistantAt) : undefined, result: { content: m.content, details: m.details, structuredContent: m.structuredContent }, at });
			}
		}
	}
	return out;
}

export const replayAll = (events, s = initialState()) => events.reduce(reduce, s);
