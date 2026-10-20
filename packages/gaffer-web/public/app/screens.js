// The two screens that make no model call (docs/ui §5.4): the Scorecard, read from outcomes.jsonl by the bridge
// (FR-EVL-04), and Preferences, the Recommend options saved per team, written through Gaffer (`/run`, action
// "preferences") so the bridge stays read-only.
import { useEffect, useState } from "preact/hooks";
import { html } from "./html.js";
import { CHIP, localTime, sign, utcTime, xp } from "./format.js";
import { Banner } from "./run.js";
import { ChipsToSave, KeepField, Seg, TeamField, useTeam } from "./start.js";

const fig = (v) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : "–");
/** A difference in points, with a real minus sign; whole points print without a decimal. */
const delta = (v) => (Number.isInteger(Math.round(v * 10) / 10) && Math.abs(v - Math.round(v)) < 1e-9 ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(Math.round(v))}` : sign(v));
const SERIES = [["gaffer", "Gaffer's plan", "g"], ["actual", "Your points", "y"], ["b0", "Hold (B0)", "b0"], ["b1", "Best swap (B1)", "b1"]];

/** The season's figures and bars, from the bridge's scorecard (the counted rows of outcomes.jsonl only). */
export function Scorecard({ card, teamName }) {
	const t = card.totals;
	const max = Math.max(1, ...card.gws.flatMap((g) => [g.gaffer, g.actual, g.b0, g.b1]));
	return html`<section class="card scorecard" aria-labelledby="sc-h">
		<header><h2 id="sc-h">Scorecard${teamName ? ` · ${teamName}` : ""}</h2><span class="muted">${card.season ?? "This season"} · ${card.gws.length} GW${card.gws.length === 1 ? "" : "s"} scored · each GW is scored after FPL checks it</span></header>
		${card.gws.length ? html`
			<div class="sc-figs">
				${SERIES.map(([k, label, c]) => html`<div data-total=${k}><div class="lbl"><i class=${`sw ${c}`} aria-hidden="true"></i>${label}</div><div class="fig">${fig(t[k])}</div></div>`)}
				<p class="sc-vs">Gaffer against you <b class=${t.gaffer - t.actual >= 0 ? "gain" : "loss"}>${delta(t.gaffer - t.actual)}</b> · against holding <b class=${t.gaffer - t.b0 >= 0 ? "gain" : "loss"}>${delta(t.gaffer - t.b0)}</b> · against the best swap <b class=${t.gaffer - t.b1 >= 0 ? "gain" : "loss"}>${delta(t.gaffer - t.b1)}</b></p>
			</div>
			<div class="sc-bars" aria-hidden="true">${card.gws.map((g) => html`<div class="sc-gw"><b class="gwc">GW${g.gw}</b><div class="sc-group">${SERIES.map(([k, , c]) => html`<span class="sc-bar"><i class=${c} style=${`width:${(Math.max(0, g[k]) / max) * 100}%`}></i><span class="mono">${fig(g[k])}</span></span>`)}</div></div>`)}</div>
			<div class="scroll-x" tabindex="0" role="region" aria-label="Points per GW table"><table class="sc-table">
				<caption class="sr">Points per scored GW</caption>
				<thead><tr><th scope="col">GW</th><th scope="col" class="n">Gaffer</th><th scope="col" class="n">You</th><th scope="col" class="n">B0</th><th scope="col" class="n">B1</th><th scope="col" class="n">Gaffer xP</th></tr></thead>
				<tbody>${card.gws.map((g) => html`<tr data-gw=${g.gw}><th scope="row" class="gwc">${g.gw}</th><td class="n">${fig(g.gaffer)}</td><td class="n">${fig(g.actual)}</td><td class="n">${fig(g.b0)}</td><td class="n">${fig(g.b1)}</td><td class="n">${xp(g.expected)}</td></tr>`)}</tbody>
				<tfoot><tr><th scope="row">All</th><td class="n">${fig(t.gaffer)}</td><td class="n">${fig(t.actual)}</td><td class="n">${fig(t.b0)}</td><td class="n">${fig(t.b1)}</td><td class="n">${xp(t.expected)}</td></tr></tfoot>
			</table></div>
			<small class="muted">Gaffer: the recommended XI, captain and chip after auto-subs, minus its hits. You: your actual points. B0: hold, with the XI and captain by FPL's ep_next. B1: one free transfer on the best ep_next swap. All from the same pre-deadline squad.${card.projection.players ? ` Projection error over ${card.projection.players} player-GWs (mean absolute): Gaffer ${card.projection.mae_gaffer}, FPL's ep_next ${card.projection.mae_official}.` : ""}${card.notCounted ? ` ${card.notCounted} earlier recommendation${card.notCounted === 1 ? " was" : "s were"} scored but not counted: the last before each deadline counts.` : ""}</small>`
		: html`<p class="muted">No finished GW has been scored for this team yet. Gaffer scores each recommendation once FPL marks its GW as checked.</p>`}
		${card.waiting.length ? html`<div class="sc-wait"><span class="lbl">Waiting to be scored</span><ul>${card.waiting.map((w) => html`<li data-waiting=${w.gw}><b>GW${w.gw}</b> · ${w.recommendations} recommendation${w.recommendations === 1 ? "" : "s"} · scored ${w.when}${w.by ? html`, <span class="mono" title=${utcTime(w.by)}>${localTime(w.by)}</span>` : ""}</li>`)}</ul></div>` : null}
		${card.unscorable.length ? html`<ul class="muted">${card.unscorable.map((u) => html`<li>GW${u.gw} ${u.rec_id}: not scored (${u.reason})</li>`)}</ul>` : null}
	</section>`;
}

export function ScorecardView({ api }) {
	const { teamId, setTeamId, team } = useTeam(api);
	const [card, setCard] = useState({ state: "idle" });
	useEffect(() => {
		if (team.state !== "ok") return setCard({ state: "idle" });
		setCard({ state: "loading" });
		void api.get(`/api/team/${team.id}/scorecard`).then((r) => setCard(r.ok ? { state: "ok", card: r.body } : { state: "error", message: r.body.error ?? "The scorecard could not be read." }));
	}, [team.state === "ok" ? team.id : null]);
	return html`<div class="start">
		${team.state !== "ok" ? html`<section class="card" aria-label="Team"><${TeamField} teamId=${teamId} setTeamId=${setTeamId} team=${team} /></section>` : null}
		${card.state === "loading" ? html`<p class="muted">Reading the scorecard…</p>` : card.state === "error" ? html`<${Banner} kind="bad" text=${card.message} />` : card.state === "ok" ? html`<${Scorecard} card=${card.card} teamName=${team.name} />` : null}
	</div>`;
}

const HITS = [[0, "0"], [1, "1"], [2, "2"], [null, "No limit"]];
const DEFAULTS = { risk: "balanced", max_hits_per_gw: null, save_chips: [], keep: [] };

export function PreferencesView({ api }) {
	const { teamId, setTeamId, team, reload } = useTeam(api);
	const [p, setP] = useState(DEFAULTS);
	const [status, setStatus] = useState({ state: "idle" });
	const [confirm, setConfirm] = useState(false);
	const saved = team.state === "ok" ? team.prefs : null;
	useEffect(() => {
		if (team.state !== "ok") return;
		const s = team.prefs;
		setP(s ? { risk: s.risk, max_hits_per_gw: s.max_hits_per_gw, save_chips: s.save_chips, keep: s.keep.map((k) => k.id) } : DEFAULTS);
	}, [team.state === "ok" ? `${team.id}:${team.prefs?.updated_at ?? ""}` : null]);

	const save = async (clear) => {
		setConfirm(false);
		setStatus({ state: "saving" });
		const r = await api.post("/api/runs", { action: "preferences", team_id: team.id, options: clear ? { ...DEFAULTS, clear: true } : { ...p, clear: false } });
		if (!r.ok) return setStatus({ state: "error", message: r.body.error ?? `Not saved (HTTP ${r.status}).` });
		setStatus({ state: "ok", message: clear ? "Cleared: every run for this team now starts from the defaults." : "Saved. Every run for this team starts from these, and the plan is checked against them when it is submitted." });
		reload();
	};
	const set = (patch) => {
		setStatus({ state: "idle" });
		setP((x) => ({ ...x, ...patch }));
	};
	const squad = team.state === "ok" ? team.squad : [];
	const savedNames = saved?.keep ?? [];
	return html`<div class="start">
		<section class="card" aria-labelledby="pf-h">
			<header><h2 id="pf-h">Preferences${team.state === "ok" ? ` · ${team.name}` : ""}</h2><span class="muted">Used by every run for this team and checked when a plan is submitted</span></header>
			${team.state !== "ok" ? html`<${TeamField} teamId=${teamId} setTeamId=${setTeamId} team=${team} />` : html`
				<div class="opts">
					<div class="grid2">
						<div class="field"><span class="lbl as-label">Risk appetite</span><${Seg} label="Risk" value=${p.risk} options=${[["safe", "Safe"], ["balanced", "Balanced"], ["aggressive", "Aggressive"]]} onChange=${(risk) => set({ risk })} />
							<small class="muted">Only breaks ties between plans within 0.5 xP of the best.</small></div>
						<div class="field"><span class="lbl as-label">Most hits in a GW</span><${Seg} label="Most hits in a GW" value=${p.max_hits_per_gw} options=${HITS} onChange=${(max_hits_per_gw) => set({ max_hits_per_gw })} /></div>
					</div>
					<${ChipsToSave} value=${p.save_chips} onChange=${(save_chips) => set({ save_chips })} />
					<${KeepField} squad=${squad} names=${savedNames} value=${p.keep} onChange=${(keep) => set({ keep })} />
					${saved?.avoid?.length ? html`<p class="muted">Players to avoid: ${saved.avoid.map((a) => a.name).join(", ")}. Set in words or with /prefs in the terminal; kept when you save here, removed by Clear all.</p>` : null}
				</div>
				<p class="muted pf-when" role="status">${status.state === "ok" ? status.message : status.state === "saving" ? "Saving…" : saved ? `Saved${saved.updated_at ? ` ${localTime(saved.updated_at)}` : ""}: risk ${saved.risk}, ${saved.save_chips.length ? `saving ${saved.save_chips.map((c) => CHIP[c]).join(", ")}` : "no chips saved"}, ${saved.keep.length ? `keep ${saved.keep.map((k) => k.name).join(", ")}` : "no players kept"}, ${saved.max_hits_per_gw === null ? "no hit limit" : `at most ${saved.max_hits_per_gw} hit${saved.max_hits_per_gw === 1 ? "" : "s"}`}.` : "Nothing saved for this team yet: runs use the defaults (balanced, no chips saved, no players kept, no hit limit)."}</p>
				${status.state === "error" ? html`<${Banner} kind="bad" text=${status.message} />` : null}
				<div class="row pf-actions">
					${confirm
						? html`<span>Clear every saved preference for ${team.name}?</span><button type="button" class="btn" onClick=${() => save(true)}>Yes, clear all</button><button type="button" class="btn" onClick=${() => setConfirm(false)}>Keep them</button>`
						: html`<button type="button" class="btn" disabled=${!saved || status.state === "saving"} onClick=${() => setConfirm(true)}>Clear all</button>`}
					<button type="button" class="btn primary" disabled=${status.state === "saving"} onClick=${() => save(false)}>Save preferences</button>
				</div>`}
		</section>
	</div>`;
}
