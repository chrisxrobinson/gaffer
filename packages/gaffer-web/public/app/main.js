// The Gaffer App (ADR 0014, docs/ui §4–7): the session rail, the status strip and the main pane (Start, or a
// session: its run and its result). State comes from the bridge's read-only API and one reducer over the
// session's events; the page sends only the bridge's own commands.
import { render } from "preact";
import { useCallback, useEffect, useReducer, useRef, useState } from "preact/hooks";
import { html } from "./html.js";
import { ago, countdown, localTime, Mark, money, usd, utcTime } from "./format.js";
import { historyEvents, initialState, reduce } from "./reduce.js";
import { ResultView } from "./result.js";
import { Banner, RunView, runTitle } from "./run.js";
import { StartView } from "./start.js";

const rid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const api = {
	async get(path) {
		try {
			const r = await fetch(path, { headers: { accept: "application/json" } });
			return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
		} catch (e) {
			return { ok: false, status: 0, body: { error: "The App's server can't be reached." } };
		}
	},
	async post(path, body) {
		try {
			const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: rid(), ...body }) });
			return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
		} catch {
			return { ok: false, status: 0, body: { error: "The App's server can't be reached." } };
		}
	},
};

// NFR-LAT-04: how long each event took from the bridge to this page (the bridge stamps `at` when Pi's event arrives),
// and when the first thinking or text delta of a run arrived after Go (window.__gafferGo, set by Start).
const latency = (window.__gafferLatency = []);
const firstDelta = (e) => {
	const t = e.assistantMessageEvent?.type;
	if (window.__gafferGo && !window.__gafferFirstDelta && (t === "thinking_delta" || t === "text_delta")) window.__gafferFirstDelta = { ms: Date.now() - window.__gafferGo, at: e.at };
};

const route = () => {
	const m = /^#\/s\/([0-9a-f-]{36})$/.exec(location.hash);
	return m ? { view: "session", id: m[1] } : { view: "start" };
};

function useNow(ms = 1000) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(t);
	}, [ms]);
	return now;
}

const THEMES = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];
function applyTheme(t) {
	if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
	else delete document.documentElement.dataset.theme;
}
const savedTheme = (() => {
	try {
		return new URLSearchParams(location.search).get("theme") ?? localStorage.getItem("gaffer.theme") ?? "system";
	} catch {
		return "system";
	}
})();
applyTheme(savedTheme);

/** A rail row's title: its name, else the action and GW it was run for. */
const titleOf = (s) => s.name ?? (s.action === "recommend" || s.rec ? `Recommend GW${s.gw ?? "?"}` : s.gw ? `GW${s.gw} session` : "Session");

function Rail({ home, current, onRename }) {
	const [q, setQ] = useState("");
	const [editing, setEditing] = useState(null);
	const sessions = (home?.sessions ?? []).filter((s) => !q || titleOf(s).toLowerCase().includes(q.toLowerCase()) || (s.team?.name ?? "").toLowerCase().includes(q.toLowerCase()));
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
	const dot = (s) => (s.live === "running" ? "run" : s.outcome === "done" ? "done" : s.outcome === "failed" ? "fail" : "idle");
	const dotWord = { run: "running", done: "done", fail: "failed", idle: "idle" };
	const meta = (s) => [ago(s.updated), s.lock && s.lock.ui === "terminal" ? "open in the terminal" : s.live === "running" ? "running" : s.outcome === "failed" ? "no recommendation" : s.cost ? usd(s.cost) : null].filter(Boolean).join(" · ");
	return html`<aside class="rail" aria-label="Sessions">
		<a class="brandbar" href="#/" aria-label="Gaffer: new session"><${Mark} /><span class="wordmark">Gaffer</span></a>
		<div class="rail-actions">
			<a class="btn primary small" href="#/">New session</a>
			<label class="sr" for="session-search">Search sessions</label>
			<input class="search" id="session-search" type="search" placeholder="Search" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} />
		</div>
		<nav class="sessions" aria-label="Sessions by team and gameweek">
			${pending.map((p) => html`<a class="sess" href=${`#/s/${p.id}`} aria-current=${current === p.id ? "page" : undefined}><span class="t">New session</span><span class=${`state-dot ${p.live === "running" ? "run" : "idle"}`} role="img" aria-label=${p.live === "running" ? "running" : "idle"}></span><span class="m">${p.live === "running" ? "running" : "just now"}</span></a>`)}
			${[...teams.values()].map(({ team, gws }) => html`<section class="team">
				<header><h3>${team?.name ?? (team ? `Team ${team.id}` : "No team")}</h3>${team ? html`<span class="mono muted">${team.id}</span>` : null}</header>
				${[...gws.entries()].sort((a, b) => b[0] - a[0]).map(([gw, list]) => html`<div class="gwhead lbl">${gw ? `GW${gw}` : "No GW"}</div>
					${list.map((s) => editing === s.id
						? html`<div class="sess"><input aria-label="Session name" maxlength="80" value=${titleOf(s)} onKeyDown=${(e) => { if (e.key === "Enter") { onRename(s.id, e.currentTarget.value); setEditing(null); } if (e.key === "Escape") setEditing(null); }} onBlur=${() => setEditing(null)} ref=${(el) => el?.focus()} /></div>`
						: html`<a class="sess" href=${`#/s/${s.id}`} aria-current=${current === s.id ? "page" : undefined} title="Double-click to rename" onDblClick=${(e) => { e.preventDefault(); setEditing(s.id); }}>
							<span class="t">${titleOf(s)}</span><span class=${`state-dot ${dot(s)}`} role="img" aria-label=${dotWord[dot(s)]}></span><span class="m">${meta(s)}</span></a>`)}`)}
			</section>`)}
			${!sessions.length && !pending.length ? html`<p class="muted" style="padding:8px">${q ? "No session matches." : "No sessions yet."}</p>` : null}
		</nav>
		<div class="rail-foot"><span class="lbl">Theme</span><${ThemeSwitch} /></div>
	</aside>`;
}

function ThemeSwitch() {
	const [t, setT] = useState(savedTheme);
	const pick = (v) => {
		setT(v);
		applyTheme(v);
		try {
			localStorage.setItem("gaffer.theme", v);
		} catch {
			/* not remembered */
		}
	};
	return html`<span class="seg" role="group" aria-label="Theme">${THEMES.map(([v, label]) => html`<button type="button" aria-pressed=${String(t === v)} onClick=${() => pick(v)}>${label}</button>`)}</span>`;
}

function Strip({ home, session, now }) {
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

function SessionView({ id, home, now, refreshHome, onState }) {
	const [s, dispatch] = useReducer((st, a) => (a.reset ? a.reset : a.events.reduce(reduce, st)), initialState());
	const [view, setView] = useState({ state: "loading" });
	const [conn, setConn] = useState("ok");
	const es = useRef(null);

	const load = useCallback(async () => {
		es.current?.close();
		const r = await api.get(`/api/sessions/${id}`);
		if (!r.ok) return setView({ state: "error", message: r.status === 404 ? "There is no such session." : r.body.error });
		dispatch({ reset: historyEvents(r.body.history).reduce(reduce, initialState()) });
		setView({ state: "ready", lock: r.body.lock, live: r.body.live });
		if (!r.body.live) return;
		const src = new EventSource(`/api/sessions/${id}/events?after=${r.body.live.from - 1}`);
		es.current = src;
		let batch = [];
		let raf = 0;
		src.onmessage = (m) => {
			const e = JSON.parse(m.data);
			if (e.at) latency.length < 20000 && latency.push(Date.now() - e.at);
			firstDelta(e);
			batch.push(e);
			// One render per frame however fast the deltas come.
			raf ||= requestAnimationFrame(() => {
				raf = 0;
				const b = batch;
				batch = [];
				dispatch({ events: b });
			});
		};
		src.onerror = () => setConn("reconnecting");
		src.onopen = () => setConn("ok");
		src.addEventListener("reset", () => void load());
		src.addEventListener("closed", () => {
			src.close();
			void load();
		});
	}, [id]);

	useEffect(() => {
		void load();
		return () => es.current?.close();
	}, [load]);
	useEffect(() => onState(s), [s]);
	// When the run settles the rail's dot, the spend and the session's title change.
	useEffect(() => {
		if (!s.running && s.endedAt) refreshHome();
	}, [s.running, s.endedAt]);
	// The other UI holds this session: show it as it grows.
	useEffect(() => {
		if (view.lock?.ui !== "terminal") return;
		const t = setInterval(() => void load(), 4000);
		return () => clearInterval(t);
	}, [view.lock?.ui, load]);

	const stop = useCallback(() => void api.post(`/api/sessions/${id}/commands`, { type: "stop" }), [id]);
	useEffect(() => {
		const onKey = (e) => e.key === "Escape" && s.running && view.live && stop();
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, [s.running, view.live, stop]);

	if (view.state === "loading") return html`<p class="muted">Loading the session…</p>`;
	if (view.state === "error") return html`<${Banner} kind="bad" text=${view.message} />`;
	const teamName = s.team?.team_name ?? s.snapshot?.team_name;
	return html`
		${conn === "reconnecting" ? html`<${Banner} kind="info" text="Reconnecting… The run continues on the server; the transcript fills in from where it left off." />` : null}
		${view.lock?.ui === "terminal" ? html`<${Banner} kind="info" text="This session is also open in the browser terminal. Both show the same session; only one can send a prompt at a time, so it is read-only here." />` : null}
		${s.items.length || s.brief ? html`<${RunView} s=${s} now=${now} canStop=${!!view.live} onStop=${stop} onRetry=${() => (location.hash = "#/")} />` : html`<p class="muted">Nothing has run in this session yet.</p>`}
		${s.result ? html`<${ResultView} rec=${s.result} teamName=${teamName} now=${now} />` : null}`;
}

function App() {
	const [r, setR] = useState(route);
	const [home, setHome] = useState(null);
	const [session, setSession] = useState(null);
	const now = useNow();
	const refreshHome = useCallback(async () => {
		const res = await api.get("/api/home");
		if (res.ok) setHome({ ...res.body, fetchedAt: Date.now() });
	}, []);
	useEffect(() => {
		const onHash = () => setR(route());
		addEventListener("hashchange", onHash);
		void refreshHome();
		const t = setInterval(() => void refreshHome(), 15_000);
		return () => {
			removeEventListener("hashchange", onHash);
			clearInterval(t);
		};
	}, []);
	useEffect(() => {
		if (r.view !== "session") setSession(null);
	}, [r.view]);
	const title = r.view === "start" ? "New session" : session ? runTitle(session) : "Session";
	useEffect(() => {
		document.title = `Gaffer · ${title}${session?.running ? " · working" : ""}`;
	}, [title, session?.running]);
	const rename = async (id, name) => {
		const res = await api.post(`/api/sessions/${id}/commands`, { type: "rename", text: name });
		if (!res.ok) alert(res.body.error ?? "The session could not be renamed.");
		void refreshHome();
	};
	const empty = home && !home.sessions.length && !home.pending?.length;
	return html`<div class="app">
		<${Rail} home=${home} current=${r.view === "session" ? r.id : null} onRename=${rename} />
		<main class="main">
			<div class="topbar"><h1>${title}</h1><${Strip} home=${home} session=${session} now=${now} /></div>
			<div class="content">
				${r.view === "start"
					? html`${empty ? html`<div class="empty"><${Mark} mono /><b>No sessions yet</b><span>Enter your FPL team ID below to get a recommendation${home.gw?.next ? ` for GW${home.gw.next}` : ""}.${home.gw?.deadline ? html`<br />Deadline ${localTime(home.gw.deadline)}.` : null}</span></div>` : null}
						<${StartView} home=${home} api=${api} onStarted=${(id) => { location.hash = `#/s/${id}`; void refreshHome(); }} />`
					: html`<${SessionView} key=${r.id} id=${r.id} home=${home} now=${now} refreshHome=${refreshHome} onState=${setSession} />`}
			</div>
		</main>
	</div>`;
}

render(html`<${App} />`, document.getElementById("app"));
