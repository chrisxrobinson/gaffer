// The App's shell pieces that hold no connection of their own (main.js wires them up): the session rail, the status
// strip, the page-level states of docs/ui §6 (empty, reconnecting, open elsewhere) and the editable title. Kept free
// of side effects so the tests render them as they are.
import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "./html.js";
import { ago, countdown, localTime, Mark, money, usd, utcTime } from "./format.js";
import { Banner } from "./run.js";

/** A rail row's title: its name, else its run's title ("What-if: keep Watkins"), else the GW it was for. */
export const titleOf = (s) => s.name ?? s.title ?? (s.action === "recommend" || s.rec ? `Recommend GW${s.gw ?? "?"}` : s.gw ? `GW${s.gw} session` : "Session");

/**
 * A name being edited in place: Enter saves, Esc cancels, an error stays under the box until the next try
 * (instead of an alert). `onSave` answers `{ok, error}`.
 */
export function NameEditor({ initial, onSave, onDone, label = "Session name" }) {
	const [value, setValue] = useState(initial);
	const [error, setError] = useState(null);
	const [saving, setSaving] = useState(false);
	const input = useRef(null);
	useEffect(() => {
		input.current?.focus();
		input.current?.select();
	}, []);
	const save = async () => {
		const name = value.trim();
		if (name === initial) return onDone();
		if (!name) return setError("A name needs at least one character.");
		setSaving(true);
		const r = await onSave(name);
		setSaving(false);
		if (r.ok) onDone();
		else setError(r.error ?? "The session could not be renamed.");
	};
	return html`<div class="rename">
		<input class="input" aria-label=${label} maxlength="80" value=${value} disabled=${saving} aria-invalid=${error ? "true" : undefined} aria-describedby=${error ? "rename-err" : undefined}
			onInput=${(e) => { setValue(e.currentTarget.value); setError(null); }}
			onKeyDown=${(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onDone(); } }}
			onBlur=${() => !error && !saving && onDone()} ref=${input} />
		${error ? html`<p class="no" id="rename-err" role="alert">${error}</p>` : html`<small class="muted">Enter to save, Esc to cancel</small>`}
	</div>`;
}

/** Long-press (touch) as well as double-click: either opens the name for editing. */
export function useLongPress(onPress, ms = 550) {
	const t = useRef(0);
	const fired = useRef(false);
	return {
		onPointerDown: (e) => {
			if (e.pointerType === "mouse") return;
			fired.current = false;
			clearTimeout(t.current);
			t.current = setTimeout(() => ((fired.current = true), onPress()), ms);
		},
		onPointerUp: () => clearTimeout(t.current),
		onPointerLeave: () => clearTimeout(t.current),
		onPointerCancel: () => clearTimeout(t.current),
		onContextMenu: (e) => fired.current && e.preventDefault(),
		// A long-press doesn't also follow the link.
		onClickCapture: (e) => fired.current && (e.preventDefault(), (fired.current = false)),
	};
}

function SessionRow({ s, current, editing, setEditing, onRename, onPick }) {
	const press = useLongPress(() => setEditing(s.id));
	const dot = s.live === "running" ? "run" : s.outcome === "done" ? "done" : s.outcome === "failed" ? "fail" : "idle";
	const word = { run: "running", done: "done", fail: "failed", idle: "idle" }[dot];
	const meta = [ago(s.updated), s.lock && s.lock.ui === "terminal" ? "open in the terminal" : s.live === "running" ? "running" : s.outcome === "failed" ? "no recommendation" : s.cost ? usd(s.cost) : null].filter(Boolean).join(" · ");
	if (editing) return html`<div class="sess editing"><${NameEditor} initial=${titleOf(s)} onSave=${(name) => onRename(s.id, name)} onDone=${() => setEditing(null)} /></div>`;
	return html`<a class="sess" href=${`#/s/${s.id}`} aria-current=${current === s.id ? "page" : undefined} title="Double-click (or long-press) to rename; F2 from the keyboard"
		onDblClick=${(e) => { e.preventDefault(); setEditing(s.id); }} onKeyDown=${(e) => e.key === "F2" && (e.preventDefault(), setEditing(s.id))} onClick=${onPick} ...${press}>
		<span class="t">${titleOf(s)}</span><span class=${`state-dot ${dot}`} role="img" aria-label=${word}></span><span class="m">${meta}</span></a>`;
}

export function Rail({ home, current, onRename, onPick, themeSwitch, id = "rail", open = false }) {
	const [q, setQ] = useState("");
	const [editing, setEditing] = useState(null);
	const match = (s) => !q || titleOf(s).toLowerCase().includes(q.toLowerCase()) || (s.team?.name ?? "").toLowerCase().includes(q.toLowerCase());
	const sessions = (home?.sessions ?? []).filter(match);
	const pending = home?.pending ?? [];
	const teams = new Map();
	for (const s of sessions) {
		const key = s.team ? String(s.team.id) : "";
		if (!teams.has(key)) teams.set(key, { team: s.team, gws: new Map() });
		const t = teams.get(key);
		const gw = s.gw ?? 0;
		if (!t.gws.has(gw)) t.gws.set(gw, []);
		t.gws.get(gw).push(s);
	}
	return html`<aside class=${`rail${open ? " open" : ""}`} id=${id} aria-label="Sessions">
		<a class="brandbar" href="#/" aria-label="Gaffer: new session" onClick=${onPick}><${Mark} /><span class="wordmark">Gaffer</span></a>
		<div class="rail-actions">
			<a class="btn primary small" href="#/" onClick=${onPick}>New session</a>
			<label class="sr" for="session-search">Search sessions</label>
			<input class="search" id="session-search" type="search" placeholder="Search" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} />
		</div>
		<nav class="sessions" aria-label="Sessions by team and gameweek">
			${pending.map((p) => html`<a class="sess" href=${`#/s/${p.id}`} onClick=${onPick} aria-current=${current === p.id ? "page" : undefined}><span class="t">New session</span><span class=${`state-dot ${p.live === "running" ? "run" : "idle"}`} role="img" aria-label=${p.live === "running" ? "running" : "idle"}></span><span class="m">${p.live === "running" ? "running" : "just now"}</span></a>`)}
			${[...teams.values()].map(({ team, gws }) => html`<section class="team">
				<header><h2>${team?.name ?? (team ? `Team ${team.id}` : "No team")}</h2>${team ? html`<span class="mono muted">${team.id}</span>` : null}</header>
				${[...gws.entries()].sort((a, b) => b[0] - a[0]).map(([gw, list]) => html`<h3 class="gwhead lbl">${gw ? `GW${gw}` : "No GW"}</h3>
					${list.map((s) => html`<${SessionRow} key=${s.id} s=${s} current=${current} editing=${editing === s.id} setEditing=${setEditing} onRename=${onRename} onPick=${onPick} />`)}`)}
			</section>`)}
			${!sessions.length && !pending.length ? html`<p class="muted" style="padding:8px">${q ? "No session matches." : "No sessions yet."}</p>` : null}
		</nav>
		<div class="rail-actions rail-links"><a href="#/scorecard" onClick=${onPick}>Scorecard</a><a href="#/prefs" onClick=${onPick}>Preferences</a></div>
		<div class="rail-foot"><span class="lbl">Theme</span>${themeSwitch}</div>
	</aside>`;
}

export function Strip({ home, session, now }) {
	const gw = home?.gw;
	const offset = home ? home.now - home.fetchedAt : 0;
	const left = gw?.deadline ? Date.parse(gw.deadline) - (now + offset) : null;
	const snap = session?.snapshot;
	const team = session?.team?.team_name ?? snap?.team_name;
	const spend = home?.spend;
	const pct = spend ? Math.min(100, (spend.today / spend.daily) * 100) : 0;
	return html`<div class="strip" role="group" aria-label="Team status">
		${team ? html`<span class="kv"><span class="lbl">Team</span><span class="v">${team}</span></span>` : null}
		${gw?.next ? html`<span class="kv"><span class="lbl">GW${gw.next} deadline</span><span class="v big" title=${utcTime(gw.deadline)}>${countdown(left)}</span></span>` : null}
		${snap && snap.free_transfers !== null && snap.free_transfers !== undefined ? html`<span class="kv"><span class="lbl">FT</span><span class="v">${snap.free_transfers}</span><span class="muted">${snap.ft_source === "user" ? "(yours)" : "(derived)"}</span></span>` : null}
		${snap && typeof snap.bank === "number" ? html`<span class="kv"><span class="lbl">Bank</span><span class="v">${money(snap.bank)}</span></span>` : null}
		${spend ? html`<span class="kv"><span class="lbl">Today</span><span class="v">${usd(spend.today)}</span><span class=${`meter${pct >= 100 ? " over" : ""}`} role="img" aria-label=${`${usd(spend.today)} of the ${usd(spend.daily)} daily cap`}><i style=${`width:${pct}%`}></i></span></span>` : null}
	</div>`;
}

/** docs/ui §6, Empty: no sessions yet. */
export const EmptyState = ({ home }) => html`<div class="empty"><${Mark} mono /><b>No sessions yet</b><span>Enter your FPL team ID below to get a recommendation${home?.gw?.next ? ` for GW${home.gw.next}` : ""}.${home?.gw?.deadline ? html`<br />Deadline ${localTime(home.gw.deadline)}.` : null}</span></div>`;

/** docs/ui §6, the page-level states of a session: reconnecting, and open in the other UI. */
export function SessionBanners({ conn, lock, loading = false }) {
	if (loading) return conn === "reconnecting" ? html`<${Banner} kind="info" text="Reconnecting… The App's server can't be reached yet; this page tries again every few seconds." />` : html`<p class="muted">Loading the session…</p>`;
	return html`${conn === "reconnecting" ? html`<${Banner} kind="info" text="Reconnecting… The run continues on the server; the transcript fills in from where it left off." />` : null}
		${lock?.ui === "terminal" ? html`<${Banner} kind="info" text="This session is also open in the browser terminal. Both show the same session; only one can send a prompt at a time, so it is read-only here." />` : null}`;
}

/** The main pane's heading: focused when the view changes; a session's title can be renamed (double-click, long-press, or its button). */
export function Title({ text, renamable, onRename, focusKey }) {
	const [editing, setEditing] = useState(false);
	const h1 = useRef(null);
	const first = useRef(true);
	const press = useLongPress(() => renamable && setEditing(true));
	useEffect(() => {
		setEditing(false);
		// Navigation moves focus to the new view's heading (not on the first load: the page starts at the top).
		if (first.current) first.current = false;
		else h1.current?.focus({ preventScroll: false });
	}, [focusKey]);
	if (editing) return html`<${NameEditor} initial=${text} label="Session name" onSave=${onRename} onDone=${() => { setEditing(false); setTimeout(() => h1.current?.focus(), 0); }} />`;
	return html`<div class="title"><h1 tabindex="-1" ref=${h1} onDblClick=${() => renamable && setEditing(true)} ...${renamable ? press : {}}>${text}</h1>
		${renamable ? html`<button type="button" class="btn small ghost" onClick=${() => setEditing(true)} aria-label=${`Rename "${text}"`}>Rename</button>` : null}</div>`;
}
