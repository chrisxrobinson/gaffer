// The run states docs/ui §6 lists, as event streams derived from the recorded faux run (faux-run.jsonl): those a
// Recommend run reaches, the text answers of What-if, Explain and Chip planner (M1.1-4) with the states they reach,
// and a follow-up asked about the result. For the states test and for `--replay` screenshots.
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
		if (r.toolCallId && n > 1) r.toolCallId = `${r.toolCallId}-${n}`;
		if (r.entry?.customType === "gaffer.validation") r.entry.data.attempt = n;
		return { t: e.t + t, rec: r };
	});
	const last = again(3, 2600).map((e) => (e.rec.type === "tool_execution_end" ? { ...e, rec: { ...e.rec, isError: false, result: { content: "", details: { failed: true, attempts: 3, errors: e.rec.result?.details?.errors ?? [{ code: "CAPTAIN_IS_VICE", message: "The vice-captain can't be the captain." }] } } } } : e));
	out.novalid = [...ev.slice(0, firstSubmit), ...again(1, 0), ...again(2, 1300), ...last,
		{ t: last.at(-1).t + 5, rec: { type: "extension_ui_request", id: "n2", method: "notify", notifyType: "error", message: "Gaffer could not produce a valid recommendation: 3 submissions failed validation, so no plan is shown." } },
		{ t: last.at(-1).t + 10, rec: { type: "agent_settled", aborted: false } }];
	// Stopped by the user during the golden path.
	out.stopped = [...ev.slice(0, bashStart + 8), { t: ev[bashStart + 8].t + 100, rec: { type: "agent_settled", aborted: true } }];

	// The text answers (M1.1-4): the same snapshot and golden-path steps, then an answer in Markdown, no submission.
	const bashEnd = at(ev, isEnd("bash"));
	for (const [name, run, answer] of TEXT_RUNS) {
		const head = ev.slice(0, bashEnd + 1).map((e) => (e.rec.entry?.customType === "gaffer.run" ? { ...e, rec: { ...e.rec, entry: { ...e.rec.entry, data: { ...e.rec.entry.data, ...run, prefs_file: null } } } } : e));
		out[name] = [...head, ...said(ev[bashEnd].t + 400, answer, 0.0123)];
	}
	// A text run still streaming its answer, and one stopped at the hard cap before it answered.
	out["whatif-running"] = out.whatif.slice(0, out.whatif.findLastIndex((e) => e.rec.assistantMessageEvent?.type === "text_delta"));
	out["whatif-hardcap"] = [...out.whatif.slice(0, bashEnd + 1), budget(ev[bashEnd].t, { session_cost: 1.52, capped: "session" }),
		{ t: ev[bashEnd].t + 10, rec: { type: "extension_ui_request", id: "n3", method: "notify", notifyType: "error", message: "Gaffer stopped this run: this session has cost $1.52, over the $1.50 cap (GAFFER_BUDGET_HARD). Anything above is a partial result." } },
		{ t: ev[bashEnd].t + 50, rec: { type: "agent_settled", aborted: true } }];
	// A follow-up about the result (FR-UI-13): the question, then its answer in the same session.
	const end = ev.at(-1).t;
	out.followup = [...ev, { t: end + 1000, rec: { type: "agent_start" } }, { t: end + 1000, rec: { type: "message_start", message: { role: "user", content: FOLLOW_UP } } }, ...said(end + 1500, FOLLOW_UP_ANSWER, 0.0141)];
	return out;
}

/** An assistant message streaming `text` (a few deltas), ending the run: the events Pi sends for a text answer. */
function said(t, text, cost) {
	const parts = text.match(/[\s\S]{1,80}/g) ?? [];
	const ev = (dt, rec) => ({ t: t + dt, rec });
	return [
		ev(0, { type: "message_start", message: { role: "assistant", content: [], usage: { cost: { total: 0 } } } }),
		ev(10, { type: "message_update", usage: { cost: { total: cost / 2 } }, assistantMessageEvent: { type: "text_start", contentIndex: 0 } }),
		...parts.map((d, i) => ev(20 + i * 30, { type: "message_update", usage: { cost: { total: cost / 2 } }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: d } })),
		ev(30 + parts.length * 30, { type: "message_update", usage: { cost: { total: cost } }, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text } }),
		ev(40 + parts.length * 30, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { cost: { total: cost } }, stopReason: "stop" } }),
		ev(50 + parts.length * 30, { type: "agent_end" }),
		ev(60 + parts.length * 30, { type: "agent_settled", aborted: false }),
	];
}

export const FOLLOW_UP = "Why Haaland as captain rather than Salah?";
export const FOLLOW_UP_ANSWER = "**Haaland's 7.9 xP against Salah's 6.4** decides it: City are at home to the weakest attack-adjusted defence in GW8, and his P(start) is 0.96.\n\n- Salah's fixture is away to a top-four defence.\n- The gap is 1.5 xP, doubled to 3.0 as captain.";
const TABLE = "| Plan | xP 4 GW | xP 6 GW | Hit |\n|---|---|---|---|\n| Best plan | 214.6 | 318.2 | 0 |\n| With the move | 211.9 | 316.0 | −4 |";
const TEXT_RUNS = [
	["whatif", { action: "whatif", title: "What-if: Watkins → Isak", options: { kind: "transfer", out: { id: 506, name: "Watkins", team: "AVL" }, in: { id: 661, name: "Isak", team: "NEW" }, gw: 8 } },
		`**Not worth it this week.** Selling Watkins for Isak in GW8 costs a hit and gives back 2.7 xP over 4 GWs.\n\n${TABLE}\n\n- It is legal: the bank stays at £0.4m.\n- It uses your one free transfer, so a second move would cost −4.\n\nPlan 1 stays ahead; nothing was saved.`],
	["explain", { action: "explain", title: "Explain Saka", options: { player: { id: 12, name: "Saka", team: "ARS" }, against: "recommendation", rec: { rec_id: "01M5CQS9CC8HCWMQV7HHCC37EW", gw: 8, role: "in the starting XI" } } },
		"**Saka: 6.1 xP in GW8**, from 0.92 P(start) and 84 expected minutes.\n\n| GW | Fixture | xP |\n|---|---|---|\n| 8 | BOU (H) | 6.1 |\n| 9 | che (A) | 4.4 |\n| 10 | WOL (H) | 5.8 |\n\nFPL's own ep_next is 5.6. A knock or a rotation in the cup week would change the picture."],
	["chips", { action: "chips", title: "Chip planner GW8–GW13", options: { from_gw: 8, to_gw: 13 } },
		"**Keep all four for now.** No blank or double GW is announced before GW13.\n\n| Chip | Best GW | xP added | Next-best GW |\n|---|---|---|---|\n| Bench Boost | 11 | +6.8 | 9 |\n| Triple Captain | 10 | +7.4 | 8 |\n| Free Hit | 12 | +3.1 | 13 |\n| Wildcard | not evaluated | – | – |\n\nWildcard wasn't evaluated in the time budget. First-half chips expire at the GW19 deadline."],
];

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
	const dir = process.argv[2];
	mkdirSync(dir, { recursive: true });
	for (const [name, events] of Object.entries(states())) writeFileSync(join(dir, `${name}.jsonl`), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
	console.log(`wrote ${Object.keys(states()).length} states to ${dir}`);
}
