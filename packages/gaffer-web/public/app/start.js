// Start (docs/ui §5.1, FR-UI-08): the team ID checked against FPL as you type, the GW from FPL, the action picker
// and the Recommend options. Go sends the options as fields; the bridge builds the run from them.
import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "./html.js";
import { CHIP, ICON, localTime, until, usd, utcTime } from "./format.js";
import { Banner } from "./run.js";

const ACTIONS = [
	["recommend", "Recommend this GW", "Transfers, captain, line-up, chip and a 4-GW plan"],
	["whatif", "What-if", "Test a transfer or a chip against the best plan"],
	["explain", "Explain a pick", "Why a player is in, out or captain"],
	["chips", "Chip planner", "When to play each chip before they expire"],
	["scorecard", "Scorecard", "Season so far: Gaffer vs you vs baselines"],
	["prefs", "Preferences", "Risk, chips to save, players to keep"],
];
const HITS = [[0, "0"], [1, "1"], [2, "2"], [null, "No limit"]];
const store = {
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

function Seg({ label, value, options, onChange }) {
	return html`<span class="seg" role="group" aria-label=${label}>${options.map(([v, text]) => html`<button type="button" aria-pressed=${String(v === value)} onClick=${() => onChange(v)}>${text}</button>`)}</span>`;
}

export function StartView({ home, api, onStarted }) {
	const [teamId, setTeamId] = useState(() => store.get("gaffer.team") ?? "");
	const [team, setTeam] = useState({ state: "idle" });
	const [opts, setOpts] = useState({ risk: "balanced", max_hits_per_gw: null, save_chips: [], keep: [], ft: "", pending: "", save: false });
	const [go, setGo] = useState({ state: "idle" });
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
				const p = r.body.prefs;
				if (p) setOpts((o) => ({ ...o, risk: p.risk, max_hits_per_gw: p.max_hits_per_gw, save_chips: p.save_chips, keep: p.keep.map((k) => k.id).filter((k) => r.body.squad.some((s) => s.id === k)) }));
			} else setTeam({ state: r.status === 404 ? "notfound" : "bad", message: r.status === 404 ? "Not found on FPL. Check the number in your Points page address." : (r.body.error ?? "FPL could not be reached") });
		}, 350);
		return () => clearTimeout(t);
	}, [teamId]);

	const gw = home?.gw;
	const spend = home?.spend;
	const capped = spend && spend.today >= spend.daily;
	const busy = home?.busy;
	const deadlineMs = gw?.deadline ? Date.parse(gw.deadline) - (home.now ?? Date.now()) : null;
	const ftInvalid = opts.ft !== "" && !/^[0-5]$/.test(String(opts.ft));
	const ready = team.state === "ok" && gw?.next && !capped && !busy && !ftInvalid && go.state !== "sending";
	const squad = team.state === "ok" ? team.squad : [];
	const set = (patch) => setOpts((o) => ({ ...o, ...patch }));

	const submit = async () => {
		setGo({ state: "sending" });
		const options = { risk: opts.risk, max_hits_per_gw: opts.max_hits_per_gw, save_chips: opts.save_chips, keep: opts.keep, save: opts.save };
		if (opts.ft !== "") options.ft = Number(opts.ft);
		if (opts.pending.trim()) options.pending = opts.pending.trim();
		const r = await api.post("/api/runs", { team_id: Number(teamId), options });
		if (r.ok) {
			setGo({ state: "idle" });
			onStarted(r.body.id);
		} else setGo({ state: "error", message: r.body.error ?? `The run didn't start (HTTP ${r.status}).` });
	};

	return html`<div class="start">
		${capped ? html`<${Banner} kind="bad" text=${`Today's spend is ${usd(spend.today)} of the ${usd(spend.daily)} daily cap. New runs can start after midnight UTC. Past sessions and exports still work.`} />` : null}
		${busy ? html`<${Banner} kind="info" text=${`A run is in progress in ${busy.ui === "terminal" ? "the browser terminal" : busy.ui === "app" ? "the Gaffer App" : "another Gaffer process"}. Gaffer runs one at a time here; Go is available when it finishes.`} />` : null}
		<section class="card" aria-labelledby="start-h">
			<header><h2 id="start-h">New session</h2><span class="muted">Gaffer advises only. It never logs in to or changes your FPL team.</span></header>
			<div class="grid2">
				<div class="field">
					<label for="team-id">FPL team ID</label>
					<div class="row">
						<input class="input team" id="team-id" inputmode="numeric" autocomplete="off" value=${teamId} onInput=${(e) => setTeamId(e.currentTarget.value)} aria-describedby="team-help team-state" />
						<span id="team-state" role="status" aria-live="polite">${team.state === "ok" ? html`<span class="ok">${ICON.ok}${team.name}</span>` : team.state === "checking" ? html`<span class="muted">Checking with FPL…</span>` : team.state === "notfound" || team.state === "bad" ? html`<span class="no">${ICON.warn}${team.message}</span>` : null}</span>
					</div>
					<small class="muted" id="team-help">The number in the address of your Points page. Remembered on this device; Gaffer stores only a hash of it.</small>
				</div>
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
			<div class="actions">${ACTIONS.map(([key, title, sub]) => {
				const on = key === "recommend";
				return html`<button type="button" class="action" aria-pressed=${String(on)} disabled=${!on} title=${on ? undefined : "Coming soon"}><strong>${title}</strong><span>${sub}</span>${on ? null : html`<span class="tag plain soon">Coming soon</span>`}</button>`;
			})}</div>
		</section>

		<section class="card" aria-labelledby="opts-h">
			<header><h2 id="opts-h">Options for this recommendation</h2><span class="muted">${team.state === "ok" && team.prefs ? "Your saved preferences are filled in. " : ""}Changes apply to this run only unless you save them.</span></header>
			<div class="opts">
				<div class="grid2">
					<div class="field"><span class="lbl as-label">Risk appetite</span><${Seg} label="Risk" value=${opts.risk} options=${[["safe", "Safe"], ["balanced", "Balanced"], ["aggressive", "Aggressive"]]} onChange=${(risk) => set({ risk })} />
						<small class="muted">Only breaks ties between plans within 0.5 xP of the best.</small></div>
					<div class="field"><span class="lbl as-label">Most hits this GW</span><${Seg} label="Most hits this GW" value=${opts.max_hits_per_gw} options=${HITS} onChange=${(max_hits_per_gw) => set({ max_hits_per_gw })} /></div>
				</div>
				<div class="field"><span class="lbl as-label">Chips to save</span><div class="chipbox" role="group" aria-label="Chips to save">${Object.entries(CHIP).map(([k, label]) => html`<button type="button" class="toggle" aria-pressed=${String(opts.save_chips.includes(k))} onClick=${() => set({ save_chips: opts.save_chips.includes(k) ? opts.save_chips.filter((c) => c !== k) : [...opts.save_chips, k] })}>${label}</button>`)}</div></div>
				<div class="field"><label for="keep">Players to keep</label>
					<div class="row">
						${opts.keep.map((id) => {
							const p = squad.find((s) => s.id === id);
							return html`<span class="player-chip">${p?.name ?? id} <span class="club">${p?.team ?? ""}</span><button type="button" aria-label=${`Don't keep ${p?.name ?? id}`} onClick=${() => set({ keep: opts.keep.filter((k) => k !== id) })}>×</button></span>`;
						})}
						<select class="input" id="keep" disabled=${!squad.length} onChange=${(e) => { const id = Number(e.currentTarget.value); if (id && !opts.keep.includes(id)) set({ keep: [...opts.keep, id] }); e.currentTarget.value = ""; }}>
							<option value="">${squad.length ? "Add from your squad" : "Enter your team ID first"}</option>
							${squad.filter((p) => !opts.keep.includes(p.id)).map((p) => html`<option value=${p.id}>${p.name} (${p.position}, ${p.team})</option>`)}
						</select>
					</div></div>
				<div class="grid2">
					<div class="field"><label for="ft">Free transfers</label><div class="row"><input class="input mono" id="ft" inputmode="numeric" style="width:6ch" value=${opts.ft} placeholder=${team.ft?.value ?? ""} onInput=${(e) => set({ ft: e.currentTarget.value.trim() })} aria-describedby="ft-help" aria-invalid=${String(ftInvalid)} />
						<small class="muted" id="ft-help">${ftInvalid ? "A number from 0 to 5." : team.ft?.value !== undefined && team.ft?.value !== null ? `Gaffer derives ${team.ft.value} from public data. Type a number only if the FPL app shows a different one.` : "Derived from public data when the run starts. Type a number only if the FPL app shows a different one."}</small></div></div>
					<div class="field"><label for="pending">Transfers already made for GW${gw?.next ?? ""}</label><input class="input" id="pending" value=${opts.pending} placeholder="e.g. Saka>Kudus" onInput=${(e) => set({ pending: e.currentTarget.value })} /></div>
				</div>
				<label class="check"><input type="checkbox" checked=${opts.save} onChange=${(e) => set({ save: e.currentTarget.checked })} /> Save these as my preferences${team.state === "ok" ? ` for ${team.name}` : ""}</label>
			</div>
		</section>

		${go.state === "error" ? html`<${Banner} kind="bad" text=${go.message} />` : null}
		<div class="go">
			<span class="muted">About 75 s and $0.06. Data is fetched fresh from FPL at the start.</span>
			<button type="button" class="btn primary" disabled=${!ready} onClick=${submit}>${go.state === "sending" ? "Starting…" : `Recommend GW${gw?.next ?? ""}`}</button>
		</div>
	</div>`;
}
