// The Gaffer App (ADR 0014, docs/ui §4–9): the session rail (a drawer on a phone), the status strip and the main
// pane (Start, a session's run, result and follow-ups, the Scorecard, Preferences). State comes from the bridge's
// read-only API and one reducer over the session's events; the page sends only the bridge's own commands.
import { render } from "preact";
import { useCallback, useEffect, useReducer, useRef, useState } from "preact/hooks";
import { html } from "./html.js";
import { AskBox, FollowUps } from "./followup.js";
import { EmptyState, Rail, SessionBanners, Strip, Title } from "./parts.js";
import { historyEvents, initialState, reduce } from "./reduce.js";
import { ResultView } from "./result.js";
import { RunView, runTitle } from "./run.js";
import { PreferencesView, ScorecardView } from "./screens.js";
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
	if (m) return { view: "session", id: m[1] };
	if (location.hash === "#/scorecard") return { view: "scorecard" };
	if (location.hash === "#/prefs") return { view: "prefs" };
	return { view: "start" };
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

function SessionView({ id, home, now, refreshHome, onState }) {
	const [s, dispatch] = useReducer((st, a) => (a.reset ? a.reset : a.events.reduce(reduce, st)), initialState());
	const [view, setView] = useState({ state: "loading" });
	const [conn, setConn] = useState("ok");
	const es = useRef(null);
	const retry = useRef(0);

	const load = useCallback(async () => {
		es.current?.close();
		const r = await api.get(`/api/sessions/${id}`);
		// The App's server is restarting (or the network is down): keep what is shown, say so, and try again.
		if (r.status === 0) {
			setConn("reconnecting");
			retry.current = setTimeout(() => void load(), 2000);
			return;
		}
		setConn("ok");
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
		void refreshHome(); // the rail shows this session (a run just started) at once
		return () => {
			es.current?.close();
			clearTimeout(retry.current);
		};
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
		const onKey = (e) => !e.defaultPrevented && e.key === "Escape" && s.running && view.live && stop();
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, [s.running, view.live, stop]);
	// A follow-up: the bridge opens the session's Pi if it isn't open, then this page follows its stream.
	const ask = useCallback(async (text) => {
		const r = await api.post(`/api/sessions/${id}/commands`, { type: "ask", text });
		if (!r.ok) return { ok: false, error: r.body.error ?? `Not sent (HTTP ${r.status}).` };
		if (!view.live) await load();
		return { ok: true };
	}, [id, view.live, load]);

	if (view.state === "loading") return html`<${SessionBanners} conn=${conn} loading />`;
	if (view.state === "error") return html`<${SessionBanners} conn=${conn} /><div class="banner bad" role="alert"><span></span><p>${view.message}</p></div>`;
	const teamName = s.team?.team_name ?? s.snapshot?.team_name;
	const readOnly = view.lock?.ui === "terminal";
	return html`
		<${SessionBanners} conn=${conn} lock=${view.lock} />
		${s.items.length || s.brief ? html`<${RunView} s=${s} now=${now} canStop=${!!view.live} onStop=${stop} onRetry=${() => (location.hash = "#/")} elsewhere=${readOnly ? (view.lock.running ? "running" : "open") : null} />` : html`<p class="muted">Nothing has run in this session yet.</p>`}
		${s.result ? html`<${ResultView} rec=${s.result} teamName=${teamName} now=${now} terminal=${home?.terminal} />
			<${FollowUps} s=${s} />
			<${AskBox} rec=${s.result} disabled=${readOnly} busy=${s.running} onAsk=${ask} />` : null}`;
}

function App() {
	const [r, setR] = useState(route);
	const [home, setHome] = useState(null);
	const [session, setSession] = useState(null);
	const [drawer, setDrawer] = useState(false);
	const menu = useRef(null);
	const main = useRef(null);
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
	// The phone's drawer: Esc closes it and focus goes back to its button; the page behind can't be reached meanwhile.
	useEffect(() => {
		if (!drawer) return;
		const rail = document.getElementById("rail");
		rail?.querySelector("a, button, input")?.focus();
		const onKey = (e) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			setDrawer(false);
			menu.current?.focus();
		};
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, [drawer]);
	useEffect(() => {
		if (main.current) main.current.inert = drawer;
	}, [drawer]);
	const title = r.view === "start" ? "New session" : r.view === "scorecard" ? "Scorecard" : r.view === "prefs" ? "Preferences" : session ? runTitle(session) : "Session";
	useEffect(() => {
		document.title = `Gaffer · ${title}${session?.running ? " · working" : ""}`;
	}, [title, session?.running]);
	const rename = async (id, name) => {
		const res = await api.post(`/api/sessions/${id}/commands`, { type: "rename", text: name });
		void refreshHome();
		return res.ok ? { ok: true } : { ok: false, error: res.body.error ?? "The session could not be renamed." };
	};
	const empty = home && !home.sessions.length && !home.pending?.length;
	const pick = () => setDrawer(false);
	return html`<div class=${`app${drawer ? " drawer-open" : ""}`}>
		<a class="skip" href="#main" onClick=${(e) => { e.preventDefault(); main.current?.querySelector("h1")?.focus(); }}>Skip to the main content</a>
		<${Rail} home=${home} current=${r.view === "session" ? r.id : null} onRename=${rename} onPick=${pick} open=${drawer} themeSwitch=${html`<${ThemeSwitch} />`} />
		${drawer ? html`<div class="scrim" aria-hidden="true" onClick=${() => setDrawer(false)}></div>` : null}
		<main class="main" id="main" ref=${main}>
			<div class="topbar">
				<button type="button" class="btn small menu" ref=${menu} aria-controls="rail" aria-expanded=${String(drawer)} onClick=${() => setDrawer(!drawer)}>Sessions</button>
				<${Title} text=${title} focusKey=${r.view === "session" ? r.id : r.view} renamable=${r.view === "session" && !!session && (session.items.length > 0 || !!session.brief)} onRename=${(name) => rename(r.id, name)} />
				<${Strip} home=${home} session=${session} now=${now} />
			</div>
			<div class="content">
				${r.view === "start"
					? html`${empty ? html`<${EmptyState} home=${home} />` : null}
						<${StartView} home=${home} api=${api} onStarted=${(id) => { location.hash = `#/s/${id}`; void refreshHome(); }} onOpen=${(a) => (location.hash = a === "scorecard" ? "#/scorecard" : "#/prefs")} />`
					: r.view === "scorecard" ? html`<${ScorecardView} api=${api} />`
					: r.view === "prefs" ? html`<${PreferencesView} api=${api} />`
					: html`<${SessionView} key=${r.id} id=${r.id} home=${home} now=${now} refreshHome=${refreshHome} onState=${setSession} />`}
			</div>
		</main>
	</div>`;
}

render(html`<${App} />`, document.getElementById("app"));
