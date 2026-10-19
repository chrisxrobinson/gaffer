// The run states docs/ui §6 lists that a Recommend run can reach, as event streams derived from the recorded faux
// run (faux-run.jsonl): for the states test and for `--replay` screenshots.
//   node test/fixtures/states.mjs <out dir>   writes one <state>.jsonl per state (replay format {t, rec})
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const base = () => readFileSync(new URL("./faux-run.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const at = (events, pred) => events.findIndex((e) => pred(e.rec));
const isEnd = (tool) => (r) => r.type === "tool_execution_end" && r.toolName === tool;
const budget = (t, data) => ({ t, rec: { type: "entry_appended", entry: { type: "custom", customType: "gaffer.budget", data: { day_cost: 0.9, turn: 2, soft: 0.75, hard: 1.5, daily: 5, max_turns: 40, capped: false, ...data } } } });

export function states() {
	const ev = base();
	const bashStart = at(ev, (r) => r.type === "tool_execution_start" && r.toolName === "bash");
	const snapEnd = at(ev, isEnd("fpl_snapshot"));
	const out = {};
	// Running, with the golden path's progress (the tool step open, the spinner, "main solve … s of … s").
	out.running = ev.slice(0, bashStart + 12);
	// Streaming thinking: the second model call's thinking half-way through.
	out.thinking = ev.slice(0, ev.findIndex((e, i) => i > snapEnd && e.rec.assistantMessageEvent?.type === "thinking_end") - 2);
	// The finished run, as recorded.
	out.done = ev;
	// Budget soft cap: the steer after the snapshot step.
	const soft = ev.slice();
	soft.splice(snapEnd + 2, 0, budget(ev[snapEnd].t, { session_cost: 0.76, steered: true }), { t: ev[snapEnd].t, rec: { type: "message_start", message: { role: "custom", customType: "gaffer.steer", content: "Gaffer budget note: …" } } });
	out.softcap = soft;
	// Budget hard cap: stopped during the golden path, no plan.
	out.hardcap = [...ev.slice(0, bashStart + 6), budget(ev[bashStart + 6].t, { session_cost: 1.52, capped: "session" }),
		{ t: ev[bashStart + 6].t, rec: { type: "extension_ui_request", id: "n1", method: "notify", notifyType: "error", message: "Gaffer stopped this run: this session has cost $1.52, over the $1.50 cap (GAFFER_BUDGET_HARD). Anything above is a partial result." } },
		{ t: ev[bashStart + 6].t + 50, rec: { type: "agent_settled", aborted: true } }];
	// FPL updating: the snapshot fell back to stale data.
	const staleSnap = (r) => {
		if (r.type === "entry_appended" && r.entry?.customType === "gaffer.snapshot") return { ...r, entry: { ...r.entry, data: { ...r.entry.data, stale: true, stale_reason: "fpl_updating", fetched_at: new Date(Date.parse(r.entry.data.fetched_at) - 2 * 3600_000).toISOString() } } };
		if (r.type === "tool_execution_end" && r.toolName === "fpl_snapshot") return { ...r, result: { ...r.result, details: { ...r.result.details, stale: true, stale_reason: "fpl_updating" } } };
		return r;
	};
	out.stale = ev.map((e) => ({ ...e, rec: staleSnap(e.rec) }));
	// The odds source down: team strength from Dixon-Coles.
	const noOdds = (r) => {
		if (r.type === "entry_appended" && r.entry?.customType === "gaffer.snapshot") return { ...r, entry: { ...r.entry, data: { ...r.entry.data, odds: { requested: true, available: false, fixtures: 0, reason: "football-data.co.uk unavailable" } } } };
		if (r.type === "tool_execution_end" && r.toolName === "fpl_snapshot") return { ...r, result: { ...r.result, details: { ...r.result.details, odds: { requested: true, available: false, fixtures: 0, reason: "football-data.co.uk unavailable" } } } };
		return r;
	};
	out.oddsdown = ev.map((e) => ({ ...e, rec: noOdds(e.rec) }));
	// No valid plan: three submissions fail the check; the gate gives up.
	const firstSubmit = at(ev, (r) => r.type === "tool_execution_start" && r.toolName === "submit_recommendation");
	const reject = ev.slice(firstSubmit, at(ev, isEnd("submit_recommendation")) + 1);
	const again = (n, t) => reject.map((e) => {
		const r = structuredClone(e.rec);
		if (r.toolCallId) r.toolCallId = `${r.toolCallId}-${n}`;
		if (r.entry?.customType === "gaffer.validation") r.entry.data.attempt = n;
		return { t: e.t + t, rec: r };
	});
	const last = again(3, 2600).map((e) => (e.rec.type === "tool_execution_end" ? { ...e, rec: { ...e.rec, isError: false, result: { content: "", details: { failed: true, attempts: 3, errors: e.rec.result?.details?.errors ?? [{ code: "CAPTAIN_IS_VICE", message: "The vice-captain can't be the captain." }] } } } } : e));
	out.novalid = [...ev.slice(0, firstSubmit), ...again(1, 0), ...again(2, 1300), ...last,
		{ t: last.at(-1).t + 5, rec: { type: "extension_ui_request", id: "n2", method: "notify", notifyType: "error", message: "Gaffer could not produce a valid recommendation: 3 submissions failed validation, so no plan is shown." } },
		{ t: last.at(-1).t + 10, rec: { type: "agent_settled", aborted: true } }];
	// Stopped by the user during the golden path.
	out.stopped = [...ev.slice(0, bashStart + 8), { t: ev[bashStart + 8].t + 100, rec: { type: "agent_settled", aborted: true } }];
	return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
	const dir = process.argv[2];
	mkdirSync(dir, { recursive: true });
	for (const [name, events] of Object.entries(states())) writeFileSync(join(dir, `${name}.jsonl`), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
	console.log(`wrote ${Object.keys(states()).length} states to ${dir}`);
}
