// "Ask about this plan" (docs/ui §5.3 item 9, FR-UI-13): a 280-character question about the result, sent with the
// bridge's `ask` command in the same session, and each answer drawn under the result with its cost. The bridge
// refuses anything starting with / or !; the box says so first.
import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "./html.js";
import { usd } from "./format.js";
import { Said } from "./run.js";

export const ASK_MAX = 280;

/** Three questions about this recommendation, from its own data. */
export function suggestions(rec) {
	const t = rec.transfers[0];
	return [
		`Why ${rec.captain.name} as captain rather than ${rec.vice_captain.name}?`,
		t ? `Why ${t.in.name} rather than keeping ${t.out.name}?` : "Why roll the free transfer this week?",
		rec.chip.play ? `Why play the chip now rather than later?` : "Explain the bench order.",
	];
}

/** The follow-ups asked so far, each with its answer as it streams and what it cost. */
export function FollowUps({ s }) {
	if (!s.asks.length) return null;
	const at = (key) => s.items.findIndex((x) => x.key === key);
	return html`<section class="answers" aria-label="Your questions about this plan">${s.asks.map((a, i) => {
		const from = at(a.key);
		const next = s.asks[i + 1];
		const to = next ? at(next.key) : s.items.length;
		const items = s.items.slice(from + 1, to);
		const last = !next;
		const cost = (next ? next.cost : s.cost + (s.running ? s.liveCost : 0)) - a.cost;
		const working = last && s.running;
		const said = items.filter((x) => x.kind === "say");
		return html`<article class="answer" key=${a.key} data-ask=${i}>
			<p class="q"><span class="lbl">You asked</span> ${s.items[from]?.text}</p>
			${said.length ? said.map((x) => html`<${Said} key=${x.key} text=${x.text} />`) : html`<p class="muted">${working ? "Gaffer is answering…" : "No answer was written."}</p>`}
			<p class="muted mono meta" role=${last ? "status" : undefined}>${working ? `Answering · ${usd(cost, 3)} so far` : `This answer cost ${usd(cost, 3)}`}</p>
		</article>`;
	})}</section>`;
}

export function AskBox({ rec, disabled, busy, onAsk }) {
	const [text, setText] = useState("");
	const [error, setError] = useState(null);
	const [sending, setSending] = useState(false);
	const box = useRef(null);
	// `/` focuses the box (docs/ui §9), unless the user is already typing somewhere.
	useEffect(() => {
		const onKey = (e) => {
			if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
			const t = e.target;
			if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
			e.preventDefault();
			box.current?.focus();
		};
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, []);
	const check = (t) => (!t.trim() ? "Type a question first." : t.trim().length > ASK_MAX ? `At most ${ASK_MAX} characters.` : /^[/!]/.test(t.trim()) ? "Questions can't start with / or !: there are no commands here." : null);
	const send = async () => {
		const why = check(text);
		if (why) return setError(why);
		setSending(true);
		setError(null);
		const r = await onAsk(text.trim());
		setSending(false);
		if (r.ok) setText("");
		else setError(r.error);
	};
	const off = disabled || sending || busy;
	return html`<section class="composer" aria-labelledby="ask-h">
		<label for="ask" class="lbl" id="ask-h">Ask about this plan</label>
		<textarea id="ask" ref=${box} rows="2" maxlength=${ASK_MAX} value=${text} disabled=${disabled} aria-describedby="ask-help ask-count${error ? " ask-err" : ""}" aria-invalid=${error ? "true" : undefined}
			placeholder="Questions about this recommendation. To change your team or preferences, start a new run."
			onInput=${(e) => { setText(e.currentTarget.value); setError(null); }}
			onKeyDown=${(e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!off) void send(); } if (e.key === "Escape") e.currentTarget.blur(); }}></textarea>
		${error ? html`<p class="no" id="ask-err" role="alert">${error}</p>` : null}
		<div class="row ask-row">
			<div class="suggest" role="group" aria-label="Suggested questions">${suggestions(rec).map((q) => html`<button type="button" class="btn small" disabled=${disabled} onClick=${() => { setText(q); setError(null); box.current?.focus(); }}>${q}</button>`)}</div>
			<span class="muted mono" id="ask-count">${text.length}/${ASK_MAX}</span>
			<button type="button" class="btn primary small" disabled=${off || !text.trim()} onClick=${send}>${sending ? "Sending…" : busy ? "Answering…" : "Ask"}</button>
		</div>
		<small class="muted" id="ask-help">${disabled ? "Read-only here: this session is open in the browser terminal." : "Press / to type here. Enter sends; Shift+Enter is a new line. Each answer shows what it cost."}</small>
	</section>`;
}
