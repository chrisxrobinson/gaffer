// The Result view (docs/ui §5.3, FR-UI-10), drawn from one `gaffer.recommendation/1` object and nothing else, and
// its exports (FR-UI-11): the JSON exactly as stored, and a CSV of the transfers, captain, vice and plan.
// Model-written text (summary, rationales, notes, warnings) is rendered as text.
import { html } from "./html.js";
import { CHIP, localTime, money, sign, utcTime, xp } from "./format.js";

const POS = { GKP: 0, GK: 0, DEF: 1, MID: 2, FWD: 3 };
const pos = (p) => POS[p?.position] ?? 2;

/** The JSON download: the stored entry's data, byte for byte as Pi wrote it (JSON.stringify of the same object). */
export const exportJson = (rec) => JSON.stringify(rec);

const cell = (v) => {
	if (v === null || v === undefined) return "";
	let s = String(v);
	// A text cell a spreadsheet would run as a formula is prefixed; numbers are written as they are.
	if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
	return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per transfer, the captain, the vice and each plan GW (FR-UI-11). */
export function exportCsv(rec) {
	const name = (id) => rec.players?.[String(id)]?.name ?? String(id);
	const rows = [["gw", "kind", "out", "in", "price", "sell_price", "xp_gain_4gw", "xp_gain_6gw_decayed", "expected_points", "confidence"]];
	for (const t of rec.transfers) rows.push([rec.gw, "transfer", t.out.name, t.in.name, t.in.price, t.out.sell_price, t.xp_gain_4gw, t.xp_gain_6gw_decayed, null, t.confidence]);
	rows.push([rec.gw, "captain", null, rec.captain.name, null, null, null, null, rec.captain.xp, null]);
	rows.push([rec.gw, "vice_captain", null, rec.vice_captain.name, null, null, null, null, rec.vice_captain.xp, null]);
	for (const g of rec.plan) rows.push([g.gw, "plan", g.transfers.map((t) => t.out.name).join("|"), g.transfers.map((t) => t.in.name).join("|"), null, null, null, null, g.expected_points, name(g.captain)]);
	return `${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

export function download(name, type, text) {
	const url = URL.createObjectURL(new Blob([text], { type }));
	const a = Object.assign(document.createElement("a"), { href: url, download: name });
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const PitchLines = () => html`<svg class="lines" viewBox="0 0 68 72" preserveAspectRatio="none" aria-hidden="true"><rect x="2" y="2" width="64" height="68" /><path d="M2 2 H66" /><circle cx="34" cy="2" r="9.15" /><rect x="13.85" y="53.5" width="40.3" height="16.5" /><rect x="24.85" y="64.5" width="18.3" height="5.5" /><path d="M26.7 53.5 A9.15 9.15 0 0 1 41.3 53.5" /></svg>`;

function Counter({ rec, id }) {
	const p = rec.players[String(id)] ?? { name: String(id), team: "?", xp: 0 };
	const isC = rec.captain.id === id;
	const isV = rec.vice_captain.id === id;
	const isNew = rec.transfers.some((t) => t.in.id === id);
	return html`<div class="pl" data-player=${id}>
		${isNew ? html`<span class="newin" title="New signing">IN</span>` : null}
		${isC ? html`<span class="badge" title="Captain">C</span>` : isV ? html`<span class="badge v" title="Vice-captain">V</span>` : null}
		<span class="kit">${p.team}</span><span class="nm">${p.name}</span><span class="xp">${xp(isC ? p.xp * 2 : p.xp)}</span>
	</div>`;
}

const conf = (level) => html`<span class=${`tag ${level}`}>${level}</span>`;

export function ResultView({ rec, teamName, now = Date.now(), terminal }) {
	const P = rec.players;
	const xi = rec.starting_xi;
	const rowsOf = (n) => xi.filter((id) => pos(P[String(id)]) === n);
	const gain = rec.transfers.reduce((a, t) => a + t.xp_gain_4gw, 0);
	const scale = Math.max(8, gain, rec.hit_cost);
	const a = rec.assumptions;
	const formation = `${rowsOf(1).length}-${rowsOf(2).length}-${rowsOf(3).length}`;
	const maxPlan = Math.max(...rec.plan.map((g) => g.expected_points));
	const minPlan = Math.min(...rec.plan.map((g) => g.expected_points));
	const deadlinePassed = rec.deadline && Date.parse(rec.deadline) <= now;
	const v = rec.validation;
	return html`<article class="result" aria-labelledby="rec-h">
		${deadlinePassed ? html`<div class="banner info" role="status"><span aria-hidden="true">i</span><p><b>The GW${rec.gw} deadline has passed</b> (${localTime(rec.deadline)}). This plan waits to be scored; a new run plans the next GW.</p></div>` : null}
		<div class="rechead">
			<div>
				<h2 id="rec-h">GW${rec.gw}${teamName ? ` · ${teamName}` : ""}</h2>
				<div class="sub">
					${rec.deadline ? html`<span>Deadline <span class="mono" title=${utcTime(rec.deadline)}>${localTime(rec.deadline)}</span></span>` : null}
					<span>${a.free_transfers ?? "?"} FT (${a.ft_source === "user" ? "yours" : "derived"}) · bank after ${money(a.bank)}</span>
					<span>Data from <span class="mono" title=${utcTime(rec.snapshot.fetched_at)}>${localTime(rec.snapshot.fetched_at)}</span>${rec.snapshot.stale ? html`, <b>stale</b>` : ", fresh"}</span>
				</div>
			</div>
			<div class="headline">
				<div><div class="lbl">Expected this GW</div><div class="fig">${xp(rec.expected_points_gw)}</div></div>
				<div><div class="lbl">Net over 4 GWs</div><div class=${`fig ${rec.net_xp_gain_4gw >= 0 ? "pos" : "neg"}`}>${sign(rec.net_xp_gain_4gw)}</div></div>
				<div><div class="lbl">Confidence</div>${conf(rec.confidence.overall)}</div>
			</div>
		</div>
		<p class="summary">${rec.summary}</p>

		<section class="card" aria-labelledby="tr-h">
			<header><h2 id="tr-h">Transfers</h2><span class="muted">${rec.transfers.length ? `${rec.transfers.length} of ${a.free_transfers ?? "?"} free · ${rec.hits ? `${rec.hits} hit${rec.hits > 1 ? "s" : ""} (−${rec.hit_cost})` : "no hits"}` : "None this week: roll the free transfer"}</span></header>
			${rec.transfers.length ? html`<div class="scroll-x" tabindex="0" role="region" aria-label="Transfers table"><table>
				<thead><tr><th>Move</th><th class="n">Price</th><th class="n">xP 4 GW</th><th class="n">6 GW*</th><th>Conf.</th></tr></thead>
				<tbody>${rec.transfers.map((t) => html`<tr data-transfer=${`${t.out.id}>${t.in.id}`}>
					<td><div class="mv"><span class="out"><span class="sr">Out: </span>${t.out.name}<span class="club">${P[String(t.out.id)]?.team ?? ""}</span></span><span class="arr" aria-hidden="true">→</span><span class="in"><span class="sr">In: </span>${t.in.name}<span class="club">${P[String(t.in.id)]?.team ?? ""}</span></span></div><div class="why">${t.rationale}</div></td>
					<td class="n">${money(t.in.price)}<div class="muted" style="font-size:12px">sell ${money(t.out.sell_price)}</div></td>
					<td class="n gain">${sign(t.xp_gain_4gw)}</td><td class="n">${sign(t.xp_gain_6gw_decayed)}</td><td>${conf(t.confidence)}</td>
				</tr>`)}</tbody>
			</table></div>
			<div class="ledger">
				<span class="lbl">Gain</span><span class="bar" aria-hidden="true"><i style=${`width:${(Math.max(0, gain) / scale) * 100}%`}></i></span><span class="mono gain">${sign(gain)}</span>
				<span class="lbl">Hit cost</span><span class="bar" aria-hidden="true"><i class="hit" style=${`width:${(rec.hit_cost / scale) * 100}%`}></i></span><span class="mono">${rec.hit_cost ? `−${rec.hit_cost}` : "0"}</span>
				<span class="lbl">Net</span><span></span><span class=${`mono ${rec.net_xp_gain_4gw >= 0 ? "gain" : "loss"}`} style="font-size:15px">${sign(rec.net_xp_gain_4gw)}</span>
			</div>
			<small class="muted">* decayed expected points over the 6-GW horizon, later weeks weighted down.</small>` : null}
		</section>

		<div class="split">
			<section class="card pitchwrap" aria-labelledby="xi-h">
				<header><h2 id="xi-h">Starting XI</h2><span class="muted">${formation} · ${xp(rec.expected_points_gw)} xP</span></header>
				<div class="pitch" aria-hidden="true"><${PitchLines} />${[3, 2, 1, 0].map((n) => html`<div class="lineup-row">${rowsOf(n).map((id) => html`<${Counter} key=${id} rec=${rec} id=${id} />`)}</div>`)}</div>
				<ul class="sr" aria-label="Starting eleven">${[0, 1, 2, 3].flatMap((n) => rowsOf(n)).map((id) => html`<li>${P[String(id)]?.position} ${P[String(id)]?.name} (${P[String(id)]?.team}), ${xp(P[String(id)]?.xp)} xP${rec.captain.id === id ? ", captain" : rec.vice_captain.id === id ? ", vice-captain" : ""}${rec.transfers.some((t) => t.in.id === id) ? ", new signing" : ""}</li>`)}</ul>
				<div><div class="lbl" style="margin-bottom:6px">Bench, in auto-sub order</div>
					<ol class="bench">${rec.bench.map((id, i) => {
						const p = P[String(id)] ?? { name: String(id), team: "?", xp: 0 };
						return html`<li class="slot" data-player=${id}><span class="o">${i === 0 ? "GK" : i}</span><b>${p.name}</b><span class="muted" style="font-size:12px">${p.team} · ${xp(p.xp)} xP</span></li>`;
					})}</ol>
				</div>
			</section>
			<div class="stack">
				<section class="card" aria-labelledby="cap-h">
					<header><h2 id="cap-h">Captaincy</h2><span class="muted">Captain's points shown doubled on the pitch</span></header>
					<div class="roles">
						${[[rec.captain, "C", "Captain"], [rec.vice_captain, "V", "Vice-captain"]].map(([r, mark, word]) => html`<div class="role" data-role=${mark}>
							<span class=${`armband${mark === "V" ? " v" : ""}`} title=${word}>${mark}</span>
							<div><div class="nm">${r.name}</div><div class="muted">${P[String(r.id)]?.team ?? ""} · P(start) ${r.p_start.toFixed(2)}</div></div>
							<div class="xp">${xp(r.xp)}</div>
						</div>`)}
					</div>
					${rec.xmins_overrides.length ? html`<div class="news"><span class="lbl">Team news applied</span>${rec.xmins_overrides.map((o) => html`<div><b>${o.name}</b>: ${xp(o.xmins)} expected minutes${o.gw ? ` in GW${o.gw}` : ""}, from ${o.source === "user" ? "you" : "FPL news"} <q>${o.quote}</q></div>`)}</div>` : null}
				</section>
				<section class="card" aria-labelledby="chip-h">
					<header><h2 id="chip-h">Chips</h2><span class=${`tag ${rec.chip.confidence}`}>${rec.chip.play ? `Play ${CHIP[rec.chip.play]}` : "No chip"} · ${rec.chip.confidence}</span></header>
					<p style="margin:0 0 12px">${rec.chip.rationale}</p>
					<div class="scen">${rec.chip.scenarios.map((s) => s.evaluated
						? html`<span data-scenario=${`${s.chip}:${s.gw}`}><b>${CHIP[s.chip]}</b> <span class="muted mono">GW${s.gw}</span></span><span class="bar" aria-hidden="true"><i class=${s.delta_xp < 0 ? "neg" : ""} style=${`width:${Math.min(100, (Math.abs(s.delta_xp ?? 0) / 6) * 100)}%`}></i></span><span class="mono" style="text-align:right">${sign(s.delta_xp)}</span>`
						: html`<span data-scenario=${`${s.chip}:-`}><b>${CHIP[s.chip]}</b>${s.gw ? html` <span class="muted mono">GW${s.gw}</span>` : null}</span><span class="ne">${s.reason ?? "not evaluated"}</span><span class="mono muted" style="text-align:right">–</span>`)}</div>
					<small class="muted" style="display:block;margin-top:8px">Decayed xP against the chip-free plan.${rec.gw < 19 ? " First-half chips expire at the GW19 deadline." : ""}</small>
				</section>
			</div>
		</div>

		<section class="card" aria-labelledby="plan-h">
			<header><h2 id="plan-h">${rec.plan.length}-GW plan</h2><span class="muted">Free transfers banked as shown</span></header>
			<div class="spark" aria-hidden="true">${rec.plan.map((g) => html`<div><span class="v">${xp(g.expected_points)}</span><span class="b" style=${`height:${8 + (maxPlan > minPlan ? ((g.expected_points - minPlan) / (maxPlan - minPlan)) * 40 : 20)}px`}></span><span class="v">GW${g.gw}</span></div>`)}</div>
			<div class="scroll-x" tabindex="0" role="region" aria-label="4-GW plan table"><table class="plan">
				<thead><tr><th>GW</th><th>Moves</th><th>Captain</th><th class="n">FT</th><th class="n">xP</th></tr></thead>
				<tbody>${rec.plan.map((g, i) => html`<tr class=${i === 0 ? "now" : ""} data-gw=${g.gw}>
					<td class="gwc">${g.gw}</td>
					<td>${g.transfers.length ? g.transfers.map((t, j) => html`${j ? html`<br />` : null}${t.out.name} → <b>${t.in.name}</b>`) : html`<span class="muted">Roll</span>`}${g.chip ? html` <span class="tag warn">${CHIP[g.chip]}</span>` : null}${g.hits ? html` <span class="tag bad">−${g.hit_cost}</span>` : null}<div class="why">${g.note}</div></td>
					<td>${P[String(g.captain)]?.name ?? g.captain}</td><td class="n">${g.free_transfers}</td><td class="n">${xp(g.expected_points)}</td>
				</tr>`)}</tbody>
			</table></div>
		</section>

		${rec.warnings.length || rec.confidence.drivers.length ? html`<div class="warnbox" role="note"><span class="lbl">Check before the deadline</span>${rec.warnings.map((w) => html`<div>${w}</div>`)}${rec.confidence.drivers.length ? html`<div><b>Confidence ${rec.confidence.overall}:</b> ${rec.confidence.drivers.join("; ")}.</div>` : null}</div>` : null}

		<div class="foot">
			<span class="mono">rec ${rec.rec_id} · ${rec.model} · gaffer_lib ${rec.gaffer_lib} · pi ${rec.pi} · valid on attempt ${v.attempts} · ${v.plans_compared} plans compared, gap to best ${xp(v.gap_to_best)}</span>
			<span class="row">
				<button type="button" class="btn small" onClick=${() => download(`gaffer-${rec.rec_id}.json`, "application/json", exportJson(rec))}>Export JSON</button>
				<button type="button" class="btn small" onClick=${() => download(`gaffer-gw${rec.gw}-${rec.rec_id}.csv`, "text/csv", exportCsv(rec))}>Export CSV</button>
				${terminal ? html`<a class="btn small" href=${terminal} target="_blank" rel="noopener noreferrer">Open in terminal</a>` : null}
			</span>
		</div>
		<p class="muted" style="font-size:12.5px">${terminal ? "Open in terminal opens the browser terminal's own page in a new tab; " : "In the browser terminal "}this session is under /resume there. The App itself has no terminal.</p>
	</article>`;
}
