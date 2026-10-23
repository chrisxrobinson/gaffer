// The Run view (docs/ui §5.2): the brief, summarised thinking, one collapsible step per tool call in Gaffer's words
// with a summary from the tool's `details`, validation as a step, and the run's time and cost. Labels come from a
// table by tool name; summaries from structured details and gaffer.* entries; never from the model's prose.
import { html } from "./html.js";
import { CHIP, ICON, money, RISK, secs, usd } from "./format.js";
import { markdown } from "./md.js";

const MAX_ATTEMPTS = 3;
const skillOf = (path) => /skills\/([^/]+)\/SKILL\.md$/.exec(String(path ?? ""))?.[1];

/** One step in Gaffer's words: its label, a one-line summary, the expanded detail, and whether it is minor. */
export function describeStep(step) {
	const d = step.details ?? {};
	const running = step.status === "running" || step.status === "pending";
	const failed = step.status === "err";
	switch (step.tool) {
		case "fpl_snapshot": {
			if (running) return { label: "Fetching your team and FPL data", summary: step.stage ? `fetching ${step.stage}` : "", detail: [] };
			if (failed) return { label: "Couldn't fetch your team and FPL data", summary: "", detail: [step.text] };
			const ft = d.free_transfers;
			const summary = [
				d.stale ? `stale data (${String(d.stale_reason ?? "FPL unavailable").replace(/_/g, " ")})` : "fresh",
				Array.isArray(d.squad) ? `${d.squad.length} players` : null,
				typeof d.bank === "number" ? `bank ${money(d.bank)}` : null,
				ft && ft.value !== null && ft.value !== undefined ? `${ft.unlimited ? "unlimited" : ft.value} FT (${ft.source === "user" ? "yours" : "derived"})` : null,
				d.odds?.requested && (!d.odds.available || !d.odds.fixtures) ? "no bookmaker odds yet" : null,
			].filter(Boolean).join(" · ");
			const chips = (d.chips ?? []).filter((c) => c.available).map((c) => CHIP[c.name] ?? c.name);
			const detail = [
				`Snapshot ${d.snapshot_id ?? "–"}`,
				d.gw ? `GW${d.gw.current ?? "–"} current · GW${d.gw.next ?? "–"} next · deadline ${d.gw.deadline ?? "–"}` : null,
				d.team_name ? `Team: ${d.team_name}` : null,
				chips.length ? `Chips left: ${chips.join(", ")}` : null,
				d.odds ? (d.odds.available && d.odds.fixtures ? `Odds: ${d.odds.fixtures} fixtures priced` : `Odds: none for the next round${d.odds.reason ? ` (${d.odds.reason})` : ""}: team strength from Dixon-Coles`) : null,
				...(d.warnings ?? []).map((w) => `Warning: ${w}`),
			].filter(Boolean);
			return { label: "Fetched your team and FPL data", summary, detail };
		}
		case "bash": {
			if (d.step === "plan") {
				const s = d.solver ?? {};
				const summary = d.error
					? `plan file unreadable (${d.error})`
					: [`${d.plans} plan${d.plans === 1 ? "" : "s"}`, s.status ? `solver ${s.status}${typeof s.gap === "number" ? `, gap ${(s.gap * 100).toFixed(2)}%` : ""}` : null, d.scenarios ? `chip scenarios ${d.scenarios.evaluated} of ${d.scenarios.total}` : null].filter(Boolean).join(" · ");
				return { label: failed ? "Projecting points and solving failed" : "Projected points and solved a 6-GW plan", summary, detail: [step.text], plan: true };
			}
			if (running && step.progress) return { label: "Projecting points and solving", summary: step.progress, detail: [step.partial], plan: true };
			if (running) return { label: "Running code in the sandbox", summary: "", detail: [step.partial], minor: true };
			return { label: failed ? "Code in the sandbox failed" : "Ran code in the sandbox", summary: typeof step.exit === "number" && step.exit !== 0 ? `exit ${step.exit}` : "", detail: [step.text], minor: true };
		}
		case "read": {
			const skill = skillOf(step.args?.path);
			return { label: skill ? "Read playbook" : running ? "Reading a file" : "Read a file", summary: skill ?? String(step.args?.path ?? ""), detail: [], minor: true };
		}
		case "write":
		case "edit":
			return { label: step.tool === "write" ? "Wrote a file" : "Edited a file", summary: String(step.args?.path ?? ""), detail: [], minor: true };
		case "set_preferences":
			return { label: running ? "Saving your preferences" : "Saved your preferences", summary: "", detail: [step.text] };
		case "submit_recommendation": {
			const c = step.check;
			const rec = d.recommendation;
			if (running && !c) return { label: "Checking the plan", summary: "rules, your preferences, the solver's best", detail: [] };
			if (rec) {
				const v = rec.validation ?? {};
				const fixed = v.drift?.length ? ` · ${v.drift.length} of the model's figures corrected` : "";
				return { label: "Submitted the recommendation", summary: `valid on attempt ${v.attempts ?? c?.attempt ?? 1} · every number recomputed${fixed}`, detail: [`rec ${rec.rec_id}`], check: "passed" };
			}
			if (d.failed) return { label: "No valid recommendation", summary: `${d.attempts} submissions failed the check`, detail: [], errors: d.errors ?? [], check: "failed" };
			const attempt = c?.attempt ?? null;
			const rule = c?.errors?.[0];
			return {
				label: "Submitted the recommendation",
				summary: `rejected${rule ? `: ${rule.code}` : ""}${attempt ? `, attempt ${attempt} of ${MAX_ATTEMPTS}` : ""}${attempt && attempt < MAX_ATTEMPTS ? " · the model will retry" : ""}`,
				detail: [], errors: c?.errors ?? [], check: "failed",
			};
		}
		default:
			return { label: running ? `Running ${step.tool}` : `Ran ${step.tool}`, summary: "", detail: [step.text], minor: true };
	}
}

const icon = (status) => (status === "ok" ? html`<span class="ico ok">${ICON.ok}<span class="sr">done</span></span>` : status === "err" ? html`<span class="ico err">${ICON.err}<span class="sr">failed</span></span>` : status === "running" ? html`<span class="ico run">${ICON.run}<span class="sr">running</span></span>` : html`<span class="ico wait">${ICON.wait}<span class="sr">waiting</span></span>`);

function Step({ step, open }) {
	const v = describeStep(step);
	const t = step.durationMs !== undefined ? secs(step.durationMs) : step.status === "running" && step.startedAt ? "…" : "";
	const body = v.detail.filter((x) => typeof x === "string" && x.trim());
	return html`<details class=${`step${v.minor ? " minor" : ""}`} open=${open} data-tool=${step.tool} data-status=${step.status}>
		<summary>${icon(step.status)}<span class="what"><b>${v.label}</b>${v.summary ? ` · ${v.summary}` : ""}</span><span class="mono muted">${t}</span></summary>
		<div class="body">
			${v.errors?.length ? html`<ul class="errs">${v.errors.map((e) => html`<li><span class="mono">[${e.code}]</span> ${e.message}</li>`)}</ul>` : null}
			${step.status === "running" && v.plan ? html`<div class="progress" aria-hidden="true"><i style=${`width:${progressPct(step.progress)}%`}></i></div>` : null}
			${body.length ? html`<pre>${body.join("\n").slice(-6000)}</pre>` : null}
			${step.args ? html`<details class="raw"><summary>The call</summary><pre>${JSON.stringify(step.args, null, 2).slice(0, 4000)}</pre></details>` : null}
		</div>
	</details>`;
}

/** "main solve 31 s of 43 s" → 72. */
function progressPct(p) {
	const m = /(\d+) s of (\d+) s/.exec(p ?? "");
	return m ? Math.min(100, Math.round((100 * Number(m[1])) / Math.max(1, Number(m[2])))) : 15;
}

function Thinking({ item, live }) {
	if (live) return html`<div class="think"><span class="lbl">Thinking</span>${item.text}<span class="cursor" aria-hidden="true">▍</span></div>`;
	return html`<details class="think"><summary><span class="lbl">Thinking</span>${item.text}</summary></details>`;
}

const who = (p) => (p ? `${p.name}${p.team ? ` (${p.team})` : ""}` : "?");

export function briefLine(b) {
	if (!b) return "";
	const o = b.options ?? {};
	if (b.action === "whatif") {
		if (o.kind === "transfer") return `${who(o.out)} out, ${who(o.in)} in, in GW${o.gw} · against the best plan, over 4 and 6 GWs`;
		if (o.kind === "chip") return `${CHIP[o.chip] ?? o.chip} in GW${o.gw} · against the chip-free plan`;
		return `keep ${who(o.player)} · against the best plan`;
	}
	if (b.action === "explain") return `${who(o.player)} · ${o.against === "recommendation" ? (o.rec ? `against the GW${o.rec.gw} recommendation, where he is ${o.rec.role}` : "no earlier recommendation, so against the squad") : "against the squad"}`;
	if (b.action === "chips") return `the chips left, GW${o.from_gw} to GW${o.to_gw}`;
	return [
		RISK[o.risk] ? `risk ${o.risk}` : null,
		o.max_hits_per_gw === null || o.max_hits_per_gw === undefined ? "hits: no limit" : `max ${o.max_hits_per_gw} hit${o.max_hits_per_gw === 1 ? "" : "s"}`,
		o.save_chips?.length ? `saving ${o.save_chips.map((c) => CHIP[c] ?? c).join(", ")}` : "no chips saved",
		o.keep?.length ? `keep ${o.keep.map((p) => p.name).join(", ")}` : null,
		Number.isInteger(o.ft) ? `${o.ft} FT (yours)` : null,
		o.pending ? `already made: ${o.pending}` : null,
		o.save ? "saved as preferences" : null,
	].filter(Boolean).join(" · ");
}

export const runTitle = (s) => s.name ?? (s.brief ? (s.brief.title || `Recommend GW${s.brief.gw ?? s.result?.gw ?? "?"}`) : s.result ? `GW${s.result.gw} recommendation` : s.snapshot?.gw?.next ? `GW${s.snapshot.gw.next} session` : "Session");

/** The items of the run itself: everything before the first follow-up (those are drawn under the result). */
export const runItems = (s) => {
	const first = s.items.findIndex((x) => x.ask);
	return first < 0 ? s.items : s.items.slice(0, first);
};

/** A step's state in words, for the screen reader's log: "Fetched your team and FPL data: done". */
export function stepWords(step) {
	const v = describeStep(step);
	const state = step.status === "ok" ? "done" : step.status === "err" ? "failed" : step.status === "running" ? "started" : "waiting";
	return `${v.label}${v.summary ? `, ${v.summary}` : ""}: ${state}`;
}

/** Model text as Markdown (paragraphs, lists, bold, tables), as text: never HTML. */
export const Said = ({ text, cls = "say" }) => html`<div class=${`${cls} md`}>${markdown(text)}</div>`;

/** Banners for the states docs/ui §6 lists that a Recommend run can reach. */
export function runBanners(s) {
	const out = [];
	const b = s.budget;
	if (b?.capped === "session") out.push({ kind: "bad", text: `Run stopped at ${usd(b.session_cost)}, over the ${usd(b.hard)} session cap. No plan was saved.` });
	else if (b?.capped === "daily") out.push({ kind: "bad", text: `Today's spend is ${usd(b.day_cost)} of the ${usd(b.daily)} daily cap. New runs can start after midnight UTC.` });
	else if (b?.capped === "turns") out.push({ kind: "bad", text: `Run stopped after ${b.max_turns} turns. Anything above is a partial result.` });
	else if (b && (b.steered || b.session_cost >= b.soft)) out.push({ kind: "warn", text: `This run has cost ${usd(b.session_cost)}. Gaffer has asked the model to wrap up and submit. The hard stop is ${usd(b.hard)}.` });
	if (s.snapshot?.stale) out.push({ kind: "warn", text: `FPL is updating: using data from ${s.snapshot.fetched_at?.slice(11, 16) ?? "earlier"} UTC. Confidence is capped at medium, and within an hour of the deadline Gaffer won't finalise transfers on old data.` });
	if (s.snapshot?.odds?.requested && (!s.snapshot.odds.available || !s.snapshot.odds.fixtures)) out.push({ kind: "info", text: "Bookmaker odds are unavailable (football-data.co.uk). Team strength comes from the Dixon-Coles model instead." });
	if (s.failure) out.push({ kind: "bad", text: `No recommendation. ${s.failure.attempts} submissions failed the rules check, so nothing is shown or saved. Last error: ${s.failure.errors?.[0] ? `${s.failure.errors[0].code}: ${s.failure.errors[0].message.replace(/\.$/, "")}` : "unknown"}.`, retry: true });
	for (const n of s.notices) if (n.type === "error" && !/could not produce a valid recommendation|Gaffer stopped this run/.test(n.message)) out.push({ kind: "bad", text: n.message });
	for (const e of s.errors) out.push({ kind: "bad", text: `The model call failed: ${e}` });
	if (s.retry) out.push({ kind: "info", text: `Model busy, retrying in ${secs(s.retry.delayMs)} (${s.retry.attempt} of ${s.retry.maxAttempts}).` });
	if (s.compacting) out.push({ kind: "info", text: "Summarising the earlier conversation…" });
	return out;
}

export function Banner({ kind, text, children }) {
	return html`<div class=${`banner ${kind}`} role=${kind === "bad" ? "alert" : "status"}>${kind === "info" ? ICON.info : kind === "warn" ? ICON.warn : ICON.err}<p>${text}${children}</p></div>`;
}

export function RunView({ s, now, onStop, onRetry, canStop, elsewhere }) {
	const visible = runItems(s).filter((x) => x.kind !== "step" || s.steps[x.id]);
	// A text run's answer: what it said after its last step (What-if, Explain, Chip planner answer in text).
	const text = s.brief && s.brief.action !== "recommend";
	const lastStep = visible.findLastIndex((x) => x.kind === "step");
	const answer = text ? visible.filter((x, i) => i > lastStep && x.kind === "say") : [];
	// The step list as a live region: one line per step as it starts and ends, not the streaming text.
	const log = visible.filter((x) => x.kind === "step" && !describeStep(s.steps[x.id]).minor && s.steps[x.id].status !== "pending").map((x) => stepWords(s.steps[x.id]));
	const lastThink = [...visible].reverse().find((x) => x.kind === "think");
	// After a follow-up, this line is the run's own: its time and cost, not the follow-ups' (shown under the result).
	const r = s.run ?? { startedAt: s.startedAt, endedAt: s.endedAt, cost: s.cost + (s.running ? s.liveCost : 0), aborted: s.aborted, running: s.running };
	const elapsed = r.startedAt ? ((r.endedAt ?? now) - r.startedAt) / 1000 : null;
	const cost = r.cost;
	const meta = elsewhere
		? `${elsewhere === "running" ? "Running in the browser terminal" : "Open in the browser terminal"} · ${usd(cost, 3)} so far`
		: r.running
		? `Running · ${elapsed !== null ? `${Math.round(elapsed)} s` : "…"} · ${usd(cost, 3)} so far`
		: r.aborted
			? `Stopped${elapsed !== null ? ` after ${Math.round(elapsed)} s` : ""} · ${usd(cost, 3)}${s.result ? "" : " · nothing was saved"}`
			: `${s.result ? "Done" : s.brief && s.brief.action !== "recommend" ? "Answered" : "Finished"}${elapsed !== null ? ` in ${Math.round(elapsed)} s` : ""} · ${usd(cost, 3)}`;
	return html`<section class="transcript" aria-label="The run">
		<div class=${`brief${s.running ? " live" : ""}`}><strong>${runTitle(s)}</strong><span class="muted">${[s.team?.team_name, briefLine(s.brief)].filter(Boolean).join(" · ")}</span>${s.startedAt ? html`<span class="muted mono when">started ${new Date(s.startedAt).toLocaleTimeString()}</span>` : null}</div>
		${runBanners(s).map((b) => html`<${Banner} kind=${b.kind} text=${b.text}>${b.retry && onRetry ? html` <button type="button" class="btn small" onClick=${onRetry}>Try again</button>` : null}<//>`)}
		${visible.map((x) => {
			if (x.kind === "think") return html`<${Thinking} key=${x.key} item=${x} live=${s.running && !x.done && x === lastThink} />`;
			if (x.kind === "say" && answer.includes(x)) return x === answer[0] ? html`<section class="answer final" key=${x.key} aria-label="Gaffer's answer"><span class="lbl">Gaffer's answer</span>${answer.map((a) => html`<${Said} key=${a.key} text=${a.text} />`)}</section>` : null;
			if (x.kind === "say") return html`<${Said} key=${x.key} text=${x.text} />`;
			if (x.kind === "user") return html`<p class="you" key=${x.key}><span class="lbl">You</span> ${x.text}</p>`;
			if (x.kind === "note") return html`<p class="note" key=${x.key}>Budget soft cap: Gaffer asked the model to wrap up.</p>`;
			const step = s.steps[x.id];
			return html`<${Step} key=${x.id} step=${step} open=${step.status === "running" && !describeStep(step).minor} />`;
		})}
		${s.queue.length && !s.result ? html`<p class="muted">Queued: ${s.queue.join(" · ")}</p>` : null}
		<div class="sr" role="log" aria-label="Steps" aria-live="polite">${log.map((t, i) => html`<p key=${i}>${t}</p>`)}</div>
		<div class="runbar"><span class="muted" role="status">${meta}</span>${s.running && canStop ? html`<button type="button" class="btn small" onClick=${onStop}>${s.run ? "Stop the answer" : "Stop run"} <span class="muted">(Esc)</span></button>` : null}</div>
	</section>`;
}

