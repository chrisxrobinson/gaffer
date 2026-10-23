// Start (docs/ui §5.1, FR-UI-08): the team ID checked against FPL as you type, the GW from FPL, the action picker
// and each action's options. Go sends the options as fields (players as FPL ids); the bridge builds the run from
// them, and Gaffer writes its prompt from FPL's names. Scorecard and Preferences open their own screens.
import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "./html.js";
import { CHIP, ICON, localTime, money, until, usd, utcTime } from "./format.js";
import { Banner } from "./run.js";

export const ACTIONS = [
	["recommend", "Recommend this GW", "Transfers, captain, line-up, chip and a 4-GW plan"],
	["whatif", "What-if", "Test a transfer or a chip against the best plan"],
	["explain", "Explain a pick", "Why a player is in, out or captain"],
	["chips", "Chip planner", "When to play each chip before they expire"],
	["scorecard", "Scorecard", "Season so far: Gaffer vs you vs baselines"],
	["prefs", "Preferences", "Risk, chips to save, players to keep"],
];
/** What a run of each action usually takes and costs (BUILD.md, M1.1-4's real-model runs). */
const EXPECT = {
	recommend: "About 75 s and $0.06. Data is fetched fresh from FPL at the start.",
	whatif: "About 60 s and $0.05: a solve with the move forced, against the best plan.",
	explain: "About 40 s and $0.03.",
	chips: "About 2–3 min and $0.08: one solve per chip and week.",
	scorecard: "No run and no cost: from the scored GWs on this machine.",
	prefs: "No run and no cost.",
};
const HITS = [[0, "0"], [1, "1"], [2, "2"], [null, "No limit"]];
const HORIZON = 6;
export const store = {
	get: (k) => {
		try {
			return localStorage.getItem(k);
		} catch {
			return null;
		}
	},
	set: (k, v) => {
		try {
			localStorage.setItem(k, v);
		} catch {
			/* private window: the team ID just isn't remembered */
		}
	},
};

export function Seg({ label, value, options, onChange }) {
	return html`<span class="seg" role="group" aria-label=${label}>${options.map(([v, text]) => html`<button type="button" aria-pressed=${String(v === value)} onClick=${() => onChange(v)}>${text}</button>`)}</span>`;
}

/** The team ID box and its check against FPL as you type (FR-INP-01), shared by Start, Scorecard and Preferences. */
export function useTeam(api) {
	const [teamId, setTeamId] = useState(() => store.get("gaffer.team") ?? "");
	const [team, setTeam] = useState({ state: "idle" });
	const [again, setAgain] = useState(0);
	const seq = useRef(0);
	useEffect(() => {
		const id = teamId.trim();
		if (!id) return setTeam({ state: "idle" });
		if (!/^[1-9][0-9]{0,9}$/.test(id)) return setTeam({ state: "bad", message: "Digits only, from your Points page address" });
		const n = ++seq.current;
		setTeam({ state: "checking" });
		const t = setTimeout(async () => {
			const r = await api.get(`/api/team/${id}`);
			if (n !== seq.current) return;
			if (r.ok) {
				store.set("gaffer.team", id);
				setTeam({ state: "ok", ...r.body });
			} else setTeam({ state: r.status === 404 ? "notfound" : "bad", message: r.status === 404 ? "Not found on FPL. Check the number in your Points page address." : (r.body.error ?? "FPL could not be reached") });
		}, again ? 0 : 350);
		return () => clearTimeout(t);
	}, [teamId, again]);
	return { teamId, setTeamId, team, reload: () => setAgain((n) => n + 1) };
}

export function TeamField({ teamId, setTeamId, team }) {
	return html`<div class="field">
		<label for="team-id">FPL team ID</label>
		<div class="row">
			<input class="input team" id="team-id" inputmode="numeric" autocomplete="off" value=${teamId} onInput=${(e) => setTeamId(e.currentTarget.value)} aria-describedby="team-help team-state" />
			<span id="team-state" role="status" aria-live="polite">${team.state === "ok" ? html`<span class="ok">${ICON.ok}${team.name}</span>` : team.state === "checking" ? html`<span class="muted">Checking with FPL…</span>` : team.state === "notfound" || team.state === "bad" ? html`<span class="no">${ICON.warn}${team.message}</span>` : null}</span>
		</div>
		<small class="muted" id="team-help">The number in the address of your Points page. Remembered on this device; Gaffer stores only a hash of it.</small>
	</div>`;
}

const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** A player from FPL's list: a search box narrowing a list box. The value is the player's id. */
export function PlayerPicker({ id, label, players, value, onChange, exclude = [], hint }) {
	const [q, setQ] = useState("");
	const chosen = players.find((p) => p.id === value);
	const needle = fold(q.trim());
	const matches = players.filter((p) => p.id !== value && !exclude.includes(p.id) && (!needle || fold(p.name).includes(needle) || p.team.toLowerCase() === needle));
	const shown = matches.slice(0, 60);
	const line = (p) => `${p.name} (${p.position}, ${p.team}${typeof p.price === "number" && p.price ? `, ${money(p.price)}` : ""})`;
	return html`<div class="field picker">
		<label for=${id}>${label}</label>
		<div class="row">
			<input class="input" type="search" id=${`${id}-q`} aria-label=${`Search for the ${label.toLowerCase()}`} placeholder="Name or club" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} />
			<select class="input" id=${id} value=${value ?? ""} onChange=${(e) => onChange(Number(e.currentTarget.value) || null)}>
				<option value="">${matches.length ? `Choose (${matches.length > shown.length ? `${shown.length} of ${matches.length}` : matches.length} shown)` : "No player matches"}</option>
				${chosen ? html`<option value=${chosen.id}>${line(chosen)}</option>` : null}
				${shown.map((p) => html`<option value=${p.id}>${line(p)}</option>`)}
			</select>
		</div>
		${hint ? html`<small class="muted">${hint}</small>` : null}
	</div>`;
}

/**
 * Whether Go is available, and the page-level state that stops it (docs/ui §6): the daily cap, a run in the other
 * UI, the deadline passed, FPL down. Scorecard and Preferences start no run, so only the team matters for them.
 */
export function goState({ home, teamOk, complete, runs, now = Date.now() }) {
	const gw = home?.gw;
	const spend = home?.spend;
	const deadlineMs = gw?.deadline ? Date.parse(gw.deadline) - (home.now ?? now) - (now - (home.fetchedAt ?? now)) : null;
	const blocked = !runs ? null
		: spend && spend.today >= spend.daily ? "capped"
		: home?.busy ? "busy"
		: deadlineMs !== null && deadlineMs <= 0 ? "passed"
		: !gw?.next ? "nogw"
		: null;
	return { ready: !!(teamOk && complete && !blocked), blocked, deadlineMs };
}

function gwOptions(next, n = HORIZON) {
	return next ? Array.from({ length: Math.min(n, 39 - next) }, (_, i) => next + i) : [];
}

export function StartView({ home, api, onStarted, onOpen, initial = "recommend" }) {
	const { teamId, setTeamId, team } = useTeam(api);
	const [action, setAction] = useState(initial);
	const [opts, setOpts] = useState({ risk: "balanced", max_hits_per_gw: null, save_chips: [], keep: [], ft: "", pending: "", save: false });
	const [wi, setWi] = useState({ kind: "transfer", out: null, in: null, gw: null, chip: null, player: null });
	const [ex, setEx] = useState({ player: null, against: "recommendation" });
	const [range, setRange] = useState("six");
	const [players, setPlayers] = useState(null);
	const [go, setGo] = useState({ state: "idle" });

	// The saved preferences fill the Recommend options once the team is found.
	useEffect(() => {
		const p = team.state === "ok" ? team.prefs : null;
		if (p) setOpts((o) => ({ ...o, risk: p.risk, max_hits_per_gw: p.max_hits_per_gw, save_chips: p.save_chips, keep: p.keep.map((k) => k.id).filter((k) => team.squad.some((s) => s.id === k)) }));
	}, [team.state === "ok" ? team.id : null]);
	// FPL's player list, for the pickers, once an action needs it.
	useEffect(() => {
		if ((action === "whatif" || action === "explain") && players === null) {
			setPlayers([]);
			void api.get("/api/players").then((r) => setPlayers(r.ok ? r.body : []));
		}
	}, [action]);

	const gw = home?.gw;
	const spend = home?.spend;
	const busy = home?.busy;
	const squad = team.state === "ok" ? team.squad : [];
	const all = players ?? [];
	const byId = (id) => all.find((p) => p.id === id) ?? squad.find((p) => p.id === id);
	const chipsLeft = team.state === "ok" ? (team.chips ?? []).filter((c) => c.available) : [];
	const gws = gwOptions(gw?.next);
	const half = gw?.next && gw.next <= 19 ? 19 : 38;
	const ranges = gw?.next ? [["six", `GW${gw.next}–GW${Math.min(38, gw.next + 5)}`], ...(half - gw.next + 1 > HORIZON && half - gw.next < 12 ? [["half", `To GW${half}`]] : [])] : [];
	const from = gw?.next ?? null;
	const to = from ? (range === "half" && ranges.some(([k]) => k === "half") ? half : Math.min(38, from + 5)) : null;
	const set = (patch) => setOpts((o) => ({ ...o, ...patch }));
	const runs = action !== "scorecard" && action !== "prefs";

	const ftInvalid = opts.ft !== "" && !/^[0-5]$/.test(String(opts.ft));
	const wiGw = wi.gw ?? gw?.next ?? null;
	const complete = {
		recommend: !ftInvalid,
		whatif: wi.kind === "transfer" ? !!(wi.out && wi.in && wiGw) : wi.kind === "chip" ? !!(wi.chip && wiGw) : !!wi.player,
		explain: !!ex.player,
		chips: !!(from && to),
		scorecard: true,
		prefs: true,
	}[action];
	const { ready: can, blocked, deadlineMs } = goState({ home, teamOk: team.state === "ok", complete, runs });
	const ready = can && go.state !== "sending";
	const capped = blocked === "capped";
	const passed = runs && deadlineMs !== null && deadlineMs <= 0;

	const goLabel = {
		recommend: `Recommend GW${gw?.next ?? ""}`,
		whatif: wi.kind === "transfer" ? "Test this move" : wi.kind === "chip" ? `Test the ${CHIP[wi.chip] ?? "chip"}` : `Test keeping ${byId(wi.player)?.name ?? "him"}`,
		explain: `Explain ${byId(ex.player)?.name ?? "the pick"}`,
		chips: "Plan my chips",
		scorecard: "Open scorecard",
		prefs: "Open preferences",
	}[action];

	const spec = () => {
		if (action === "recommend") {
			const options = { risk: opts.risk, max_hits_per_gw: opts.max_hits_per_gw, save_chips: opts.save_chips, keep: opts.keep, save: opts.save };
			if (opts.ft !== "") options.ft = Number(opts.ft);
			if (opts.pending.trim()) options.pending = opts.pending.trim();
			return options;
		}
		if (action === "whatif") return wi.kind === "transfer" ? { kind: "transfer", out: wi.out, in: wi.in, gw: wiGw } : wi.kind === "chip" ? { kind: "chip", chip: wi.chip, gw: wiGw } : { kind: "keep", player: wi.player };
		if (action === "explain") return { player: ex.player, against: ex.against };
		return { from_gw: from, to_gw: to };
	};
	const submit = async () => {
		if (!runs) return onOpen(action);
		setGo({ state: "sending" });
		window.__gafferGo = Date.now();
		window.__gafferFirstDelta = undefined;
		const r = await api.post("/api/runs", { action, team_id: Number(teamId), options: spec() });
		if (r.ok) {
			setGo({ state: "idle" });
			onStarted(r.body.id);
		} else setGo({ state: "error", message: r.body.error ?? `The run didn't start (HTTP ${r.status}).` });
	};

	const heading = { recommend: "Options for this recommendation", whatif: "What to test", explain: "Which player", chips: "Chip planner", scorecard: "Scorecard", prefs: "Preferences" }[action];
	const whatif = html`<div class="opts">
		<div class="field"><span class="lbl as-label">Test</span><${Seg} label="What-if kind" value=${wi.kind} options=${[["transfer", "A transfer"], ["chip", "A chip"], ["keep", "Keep a player"]]} onChange=${(kind) => setWi({ ...wi, kind })} /></div>
		${wi.kind === "transfer" ? html`<div class="grid2">
			<div class="field"><label for="wi-out">Out, from your squad</label><select class="input" id="wi-out" value=${wi.out ?? ""} disabled=${!squad.length} onChange=${(e) => setWi({ ...wi, out: Number(e.currentTarget.value) || null })}>
				<option value="">${squad.length ? "Choose a player" : "Enter your team ID first"}</option>${squad.map((p) => html`<option value=${p.id}>${p.name} (${p.position}, ${p.team})</option>`)}</select></div>
			<${PlayerPicker} id="wi-in" label="In" players=${all.filter((p) => !byId(wi.out) || p.position === byId(wi.out).position)} value=${wi.in} exclude=${squad.map((p) => p.id)} onChange=${(v) => setWi({ ...wi, in: v })} hint=${byId(wi.out) ? `${byId(wi.out).position === "GKP" ? "Goalkeepers" : `${byId(wi.out).position}s`} only, as FPL requires.` : null} />
		</div>` : null}
		${wi.kind === "chip" ? html`<div class="field"><span class="lbl as-label">Chip</span>${chipsLeft.length ? html`<${Seg} label="Chip" value=${wi.chip} options=${chipsLeft.map((c) => [c.name, CHIP[c.name] ?? c.name])} onChange=${(chip) => setWi({ ...wi, chip })} />` : html`<span class="muted">${team.state === "ok" ? "No chips left in this half." : "Enter your team ID first."}</span>`}</div>` : null}
		${wi.kind === "keep" ? html`<div class="field"><label for="wi-keep">Player to keep</label><select class="input" id="wi-keep" value=${wi.player ?? ""} disabled=${!squad.length} onChange=${(e) => setWi({ ...wi, player: Number(e.currentTarget.value) || null })}>
			<option value="">${squad.length ? "Choose from your squad" : "Enter your team ID first"}</option>${squad.map((p) => html`<option value=${p.id}>${p.name} (${p.position}, ${p.team})</option>`)}</select></div>` : null}
		${wi.kind !== "keep" ? html`<div class="field"><span class="lbl as-label">In GW</span><${Seg} label="In GW" value=${wiGw} options=${gws.map((g) => [g, String(g)])} onChange=${(g) => setWi({ ...wi, gw: g })} /></div>` : null}
		<small class="muted">${wi.kind === "keep" ? "Gaffer solves with the player kept and compares it with the best plan." : "Gaffer solves with this forced and compares it with the best plan, in expected points over 4 and 6 GWs. A question, not a decision: nothing is saved as your recommendation."}</small>
	</div>`;
	const explain = html`<div class="opts">
		<${PlayerPicker} id="ex-p" label="Player" players=${[...squad.map((p) => all.find((a) => a.id === p.id) ?? p), ...all.filter((a) => !squad.some((p) => p.id === a.id))]} value=${ex.player} onChange=${(player) => setEx({ ...ex, player })} hint="Your squad is listed first." />
		<div class="field"><span class="lbl as-label">From</span><${Seg} label="Explain against" value=${ex.against} options=${[["recommendation", "Latest recommendation"], ["squad", "Squad only"]]} onChange=${(against) => setEx({ ...ex, against })} /></div>
	</div>`;
	const chips = html`<div class="opts">
		<div class="field"><span class="lbl as-label">Chips left</span>${team.state !== "ok" ? html`<span class="muted">Enter your team ID first.</span>` : chipsLeft.length ? html`<ul class="chipsleft">${chipsLeft.map((c) => html`<li><b>${CHIP[c.name] ?? c.name}</b><span class="muted"> · ${c.half === 1 ? "first half" : "second half"}, until the GW${c.window[1]} deadline${c.expires ? html`, <span class="mono" title=${utcTime(c.expires)}>${localTime(c.expires)}</span>` : ""}</span></li>`)}</ul>` : html`<span class="muted">No chips left in this half.</span>`}</div>
		<div class="field"><span class="lbl as-label">Weeks to consider</span><${Seg} label="Weeks to consider" value=${range} options=${ranges} onChange=${setRange} />
			<small class="muted">One forced-chip solve per chip and week. A longer range takes longer and may leave Wildcard and Free Hit unevaluated.</small></div>
	</div>`;
	const recommend = html`<div class="opts">
		<div class="grid2">
			<div class="field"><span class="lbl as-label">Risk appetite</span><${Seg} label="Risk" value=${opts.risk} options=${[["safe", "Safe"], ["balanced", "Balanced"], ["aggressive", "Aggressive"]]} onChange=${(risk) => set({ risk })} />
				<small class="muted">Only breaks ties between plans within 0.5 xP of the best.</small></div>
			<div class="field"><span class="lbl as-label">Most hits this GW</span><${Seg} label="Most hits this GW" value=${opts.max_hits_per_gw} options=${HITS} onChange=${(max_hits_per_gw) => set({ max_hits_per_gw })} /></div>
		</div>
		<${ChipsToSave} value=${opts.save_chips} onChange=${(save_chips) => set({ save_chips })} />
		<${KeepField} squad=${squad} value=${opts.keep} onChange=${(keep) => set({ keep })} />
		<div class="grid2">
			<div class="field"><label for="ft">Free transfers</label><div class="row"><input class="input mono" id="ft" inputmode="numeric" style="width:6ch" value=${opts.ft} placeholder=${team.ft?.value ?? ""} onInput=${(e) => set({ ft: e.currentTarget.value.trim() })} aria-describedby="ft-help" aria-invalid=${String(ftInvalid)} />
				<small class="muted" id="ft-help">${ftInvalid ? "A number from 0 to 5." : team.ft?.value !== undefined && team.ft?.value !== null ? `Gaffer derives ${team.ft.value} from public data. Type a number only if the FPL app shows a different one.` : "Derived from public data when the run starts. Type a number only if the FPL app shows a different one."}</small></div></div>
			<div class="field"><label for="pending">Transfers already made for GW${gw?.next ?? ""}</label><input class="input" id="pending" value=${opts.pending} placeholder="e.g. Saka>Kudus" onInput=${(e) => set({ pending: e.currentTarget.value })} /></div>
		</div>
		<label class="check"><input type="checkbox" checked=${opts.save} onChange=${(e) => set({ save: e.currentTarget.checked })} /> Save these as my preferences${team.state === "ok" ? ` for ${team.name}` : ""}</label>
	</div>`;

	return html`<div class="start">
		${capped ? html`<${Banner} kind="bad" text=${`Today's spend is ${usd(spend.today)} of the ${usd(spend.daily)} daily cap. New runs can start after midnight UTC. Past sessions and exports still work.`} />` : null}
		${runs && busy && !capped ? html`<${Banner} kind="info" text=${`A run is in progress in ${busy.ui === "terminal" ? "the browser terminal" : busy.ui === "app" ? "the Gaffer App" : "another Gaffer process"}. Gaffer runs one at a time here; Go is available when it finishes.`} />` : null}
		${passed ? html`<${Banner} kind="info" text=${`The GW${gw.next} deadline has passed (${localTime(gw.deadline)}). Gaffer plans GW${gw.next + 1} once FPL has moved on to it; this page picks that up by itself. GW${gw.next}'s recommendations wait to be scored.`} />` : null}
		<section class="card" aria-labelledby="start-h">
			<header><h2 id="start-h">New session</h2><span class="muted">Gaffer advises only. It never logs in to or changes your FPL team.</span></header>
			<div class="grid2">
				<${TeamField} teamId=${teamId} setTeamId=${setTeamId} team=${team} />
				<div class="field">
					<span class="lbl as-label">Gameweek</span>
					<div class="gwbox">
						${gw?.next ? html`<span class="gw">GW${gw.next}</span><span>Deadline <span class="mono" title=${utcTime(gw.deadline)}>${localTime(gw.deadline)}</span></span><span class="muted">${until(deadlineMs)} · from FPL</span>` : html`<span class="muted">${home ? "FPL could not be reached for the next deadline." : "Loading…"}</span>`}
					</div>
				</div>
			</div>
		</section>

		<section class="card" aria-labelledby="act-h">
			<header><h2 id="act-h">What do you want to do?</h2></header>
			<div class="actions" role="group" aria-label="Action">${ACTIONS.map(([key, title, sub]) => html`<button type="button" class="action" data-action=${key} aria-pressed=${String(action === key)} onClick=${() => { setAction(key); setGo({ state: "idle" }); }}><strong>${title}</strong><span>${sub}</span></button>`)}</div>
		</section>

		<section class="card" aria-labelledby="opts-h">
			<header><h2 id="opts-h">${heading}</h2>${action === "recommend" ? html`<span class="muted">${team.state === "ok" && team.prefs ? "Your saved preferences are filled in. " : ""}Changes apply to this run only unless you save them.</span>` : null}</header>
			${action === "recommend" ? recommend : action === "whatif" ? whatif : action === "explain" ? explain : action === "chips" ? chips
				: html`<p class="muted">${action === "scorecard" ? `No options. Shows every counted recommendation${team.state === "ok" ? ` for ${team.name}` : ""} this season against your real points and the two baselines.` : `Opens your saved preferences${team.state === "ok" ? ` for ${team.name}` : ""}: the Recommend options every run starts from.`}</p>`}
		</section>

		${go.state === "error" ? html`<${Banner} kind="bad" text=${go.message} />` : null}
		<div class="go">
			<span class="muted">${EXPECT[action]}</span>
			<button type="button" class="btn primary" disabled=${!ready} onClick=${submit}>${go.state === "sending" ? "Starting…" : goLabel}</button>
		</div>
	</div>`;
}

export function ChipsToSave({ value, onChange }) {
	return html`<div class="field"><span class="lbl as-label">Chips to save</span><div class="chipbox" role="group" aria-label="Chips to save">${Object.entries(CHIP).map(([k, label]) => html`<button type="button" class="toggle" aria-pressed=${String(value.includes(k))} onClick=${() => onChange(value.includes(k) ? value.filter((c) => c !== k) : [...value, k])}>${label}</button>`)}</div></div>`;
}

export function KeepField({ squad, value, onChange, names = [] }) {
	return html`<div class="field"><label for="keep">Players to keep</label>
		<div class="row">
			${value.map((id) => {
				const p = squad.find((s) => s.id === id) ?? names.find((s) => s.id === id);
				return html`<span class="player-chip">${p?.name ?? id} <span class="club">${p?.team ?? ""}</span><button type="button" aria-label=${`Don't keep ${p?.name ?? id}`} onClick=${() => onChange(value.filter((k) => k !== id))}>×</button></span>`;
			})}
			<select class="input" id="keep" disabled=${!squad.length} onChange=${(e) => { const id = Number(e.currentTarget.value); if (id && !value.includes(id)) onChange([...value, id]); e.currentTarget.value = ""; }}>
				<option value="">${squad.length ? "Add from your squad" : "Enter your team ID first"}</option>
				${squad.filter((p) => !value.includes(p.id)).map((p) => html`<option value=${p.id}>${p.name} (${p.position}, ${p.team})</option>`)}
			</select>
		</div></div>`;
}
