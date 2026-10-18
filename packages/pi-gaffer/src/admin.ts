/**
 * The admin report (FR-ADM-01, ARCHITECTURE §9): a static admin.html built from `/sessions` and
 * `/data` only. Sessions, tokens and cost per session, per model and per tool, latency, errors,
 * data-source health, budget events, and the recommendation and outcome ledgers. No raw team id and
 * no name appears in it: teams are shown by a prefix of their HMAC, and error texts have their digits
 * masked (src/usage.ts).
 */
import { isTestRow, type LedgerRow } from "./ledger.ts";
import type { OutcomeRow } from "./outcomes.ts";
import { type EndpointStat, percentile, type SessionUsage, type ToolStat, totals } from "./usage.ts";

export interface AdminInput {
	sessions: SessionUsage[];
	ledger: LedgerRow[];
	outcomes: OutcomeRow[];
	generatedAt: Date;
	sources: { sessions: string; data: string };
}

export interface AdminReport {
	totals: ReturnType<typeof totals> & { today: number; runLatency: { p50: number | null; p95: number | null; n: number } };
	byModel: Record<string, { calls: number; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number }>;
	byTool: Record<string, ToolStat>;
	byDay: Record<string, number>;
	endpoints: Record<string, EndpointStat>;
	html: string;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const usd = (x: number) => `$${x.toFixed(4)}`;
const int = (x: number) => Math.round(x).toLocaleString("en-GB");
const sec = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`);
const team = (hash: string) => `${hash.replace("hmac-sha256:", "").slice(0, 8)}…`;
const shortId = (id: string) => id.slice(0, 8);

function table(head: string[], rows: (string | number)[][], numeric: number[] = []): string {
	const th = head.map((h, i) => `<th${numeric.includes(i) ? ' class="n"' : ""}>${esc(h)}</th>`).join("");
	const tr = rows.map((r) => `<tr>${r.map((c, i) => `<td${numeric.includes(i) ? ' class="n"' : ""}>${esc(c)}</td>`).join("")}</tr>`).join("\n");
	return `<div class="scroll"><table><thead><tr>${th}</tr></thead><tbody>\n${tr || `<tr><td colspan="${head.length}" class="empty">none</td></tr>`}\n</tbody></table></div>`;
}

/** A bar sparkline as inline SVG (no script, no external resource). */
function sparkline(values: number[], label: string): string {
	if (!values.length) return "";
	const w = 6;
	const h = 32;
	const max = Math.max(...values, 1e-9);
	const bars = values.map((v, i) => `<rect x="${i * (w + 2)}" y="${(h - (v / max) * h).toFixed(1)}" width="${w}" height="${((v / max) * h).toFixed(1)}"/>`).join("");
	return `<svg class="spark" role="img" aria-label="${esc(label)}" width="${values.length * (w + 2)}" height="${h}" viewBox="0 0 ${values.length * (w + 2)} ${h}">${bars}</svg>`;
}

export function buildAdmin(input: AdminInput): AdminReport {
	const { sessions } = input;
	const t = totals(sessions);
	const day = input.generatedAt.toISOString().slice(0, 10);
	const byDay: Record<string, number> = {};
	const byModel: AdminReport["byModel"] = {};
	const byTool: Record<string, ToolStat> = {};
	const endpoints: Record<string, EndpointStat> = {};
	for (const s of sessions) {
		for (const [d, c] of Object.entries(s.byDay)) byDay[d] = (byDay[d] ?? 0) + c;
		for (const [m, v] of Object.entries(s.byModel)) {
			const b = (byModel[m] ??= { calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			b.calls += v.calls;
			b.cost += v.cost;
			b.input += v.tokens.input;
			b.output += v.tokens.output;
			b.cacheRead += v.tokens.cacheRead;
			b.cacheWrite += v.tokens.cacheWrite;
		}
		for (const [name, v] of Object.entries(s.tools)) {
			const b = (byTool[name] ??= { calls: 0, errors: 0, totalMs: 0, maxMs: 0, timed: 0, cost: 0 });
			b.calls += v.calls;
			b.errors += v.errors;
			b.totalMs += v.totalMs;
			b.maxMs = Math.max(b.maxMs, v.maxMs);
			b.timed += v.timed;
			b.cost += v.cost;
		}
		for (const [src, v] of Object.entries(s.snapshots.endpoints)) {
			const b = (endpoints[src] ??= { source: src, requests: 0, fromCache: 0, failures: 0, retries: 0, totalMs: 0, maxMs: 0, maxAge: null });
			b.requests += v.requests;
			b.fromCache += v.fromCache;
			b.failures += v.failures;
			b.retries += v.retries;
			b.totalMs += v.totalMs;
			b.maxMs = Math.max(b.maxMs, v.maxMs);
			if (v.maxAge !== null) b.maxAge = Math.max(b.maxAge ?? 0, v.maxAge);
		}
	}
	const recRuns = sessions.flatMap((s) => s.runs.filter((r) => r.recommendation && r.ms !== null).map((r) => r.ms!));
	const report: AdminReport = {
		totals: { ...t, today: byDay[day] ?? 0, runLatency: { p50: percentile(recRuns, 50), p95: percentile(recRuns, 95), n: recRuns.length } },
		byModel, byTool, byDay, endpoints, html: "",
	};

	const days = Object.keys(byDay).sort();
	const real = input.ledger.filter((r) => !isTestRow(r));
	const test = input.ledger.length - real.length;
	const scored = input.outcomes.filter((o) => o.status === "scored");
	const counted = scored.filter((o) => o.counted);
	const sumOf = (rows: OutcomeRow[], f: (o: OutcomeRow) => number | undefined) => rows.reduce((n, o) => n + (f(o) ?? 0), 0);
	const errors = sessions.flatMap((s) => s.errors.map((e) => ({ ...e, session: s.id })));

	const sessionRows = [...sessions]
		.sort((a, b) => (b.started ?? "").localeCompare(a.started ?? ""))
		.map((s) => {
			const runs = s.runs.filter((r) => r.recommendation && r.ms !== null).map((r) => r.ms!);
			return [
				s.started?.replace("T", " ").slice(0, 19) ?? "–", shortId(s.id), s.models.join(", ") || "–", s.calls,
				int(s.tokens.input), int(s.tokens.output), int(s.tokens.cacheRead), int(s.tokens.cacheWrite), usd(s.cost),
				s.runs.length, s.recommendations.length, sec(percentile(runs, 50)), sec(s.calls ? s.modelMs / s.calls : null), s.errors.length,
				[s.budget.steered ? "steered" : "", s.budget.capped ? `stopped (${s.budget.capped})` : ""].filter(Boolean).join(", ") || "–",
				s.teams.map(team).join(" ") || "–",
			];
		});

	const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gaffer admin</title>
<style>
:root{--bg:#fff;--fg:#1d2329;--muted:#5d6874;--line:#d8dde3;--accent:#2a6f97;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#14181c;--fg:#e4e8ec;--muted:#9aa5b1;--line:#2c343c;--accent:#7cc0e8;--bad:#f2b8b5}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
.muted,.empty{color:var(--muted)}.cards{display:flex;flex-wrap:wrap;gap:12px;margin:12px 0}
.card{border:1px solid var(--line);border-radius:6px;padding:8px 12px;min-width:120px}.card b{display:block;font-size:18px}
.scroll{overflow-x:auto}table{border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{border-bottom:1px solid var(--line);padding:4px 10px;text-align:left;white-space:nowrap}th{color:var(--muted);font-weight:600}
.n{text-align:right}.spark rect{fill:var(--accent)}
</style></head><body>
<h1>Gaffer admin</h1>
<p class="muted">Generated ${esc(input.generatedAt.toISOString())} from ${esc(input.sources.sessions)} (${sessions.length} session files) and ${esc(input.sources.data)}. Costs are Pi's <code>usage.cost.total</code> on each assistant message and <code>usage</code> entry; nothing here comes from another store.</p>
<div class="cards">
<div class="card">Sessions<b>${t.sessions}</b></div>
<div class="card">Model calls<b>${t.calls}</b></div>
<div class="card">Cost, all time<b>${usd(t.cost)}</b></div>
<div class="card">Cost today (UTC)<b>${usd(report.totals.today)}</b></div>
<div class="card">Tokens in / out<b>${int(t.tokens.input + t.tokens.cacheRead + t.tokens.cacheWrite)} / ${int(t.tokens.output)}</b></div>
<div class="card">Recommendations<b>${t.recommendations}</b></div>
<div class="card">Prompt → recommendation p50 / p95<b>${sec(report.totals.runLatency.p50)} / ${sec(report.totals.runLatency.p95)}</b></div>
<div class="card">Errors<b>${t.errors}</b></div>
</div>
<p>Cost per day ${sparkline(days.map((d) => byDay[d]), "cost per day")} <span class="muted">${esc(days[0] ?? "")} – ${esc(days.at(-1) ?? "")}</span></p>
<p>Prompt → recommendation, by run ${sparkline(recRuns, "run latency")}</p>

<h2>Sessions</h2>
${table(["Started (UTC)", "Session", "Models", "Calls", "Input", "Output", "Cache read", "Cache write", "Cost", "Runs", "Recs", "Run p50", "Mean call", "Errors", "Budget", "Teams"], sessionRows, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])}

<h2>Cost by model</h2>
${table(["Model", "Calls", "Input", "Output", "Cache read", "Cache write", "Cost"], Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost).map(([m, v]) => [m, v.calls, int(v.input), int(v.output), int(v.cacheRead), int(v.cacheWrite), usd(v.cost)]), [1, 2, 3, 4, 5, 6])}

<h2>Tools</h2>
<p class="muted">A tool's cost is the cost of the model calls that called it, split evenly when one call made several; "(text)" is model calls that called no tool, and "(cache warming and other Pi calls)" is Pi's spend outside the conversation (its <code>usage</code> entries). Latency is from the end of the calling message to the tool's result.</p>
${table(["Tool", "Calls", "Failed", "Mean", "Max", "Cost"], Object.entries(byTool).sort((a, b) => b[1].cost - a[1].cost).map(([n, v]) => [n, v.calls, v.errors, sec(v.timed ? v.totalMs / v.timed : null), sec(v.timed ? v.maxMs : null), usd(v.cost)]), [1, 2, 3, 4, 5])}

<h2>Errors</h2>
${table(["When (UTC)", "Session", "Kind", "Where", "What (digits masked)"], errors.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")).slice(0, 200).map((e) => [e.at?.replace("T", " ").slice(0, 19) ?? "–", shortId(e.session), e.kind, e.source, e.message]))}

<h2>Data-source health</h2>
<p class="muted">From the per-endpoint records in every <code>gaffer.snapshot</code> entry (NFR-OBS-02). Cache hits made no request.</p>
${table(["Source", "Requests", "Cache hits", "Failed", "Retries", "Mean", "Max", "Max CDN age"], Object.values(endpoints).sort((a, b) => a.source.localeCompare(b.source)).map((e) => [e.source, e.requests, e.fromCache, e.failures, e.retries, e.requests ? `${Math.round(e.totalMs / e.requests)} ms` : "–", e.requests ? `${e.maxMs} ms` : "–", e.maxAge === null ? "–" : `${e.maxAge} s`]), [1, 2, 3, 4, 5, 6, 7])}
<p class="muted">Snapshots: ${sessions.reduce((n, s) => n + s.snapshots.count, 0)}, of which stale: ${sessions.reduce((n, s) => n + s.snapshots.stale, 0)}.</p>

<h2>Recommendations</h2>
<p>${input.ledger.length} in the ledger: ${real.length} real, ${test} made by the scripted test model (not scored). By GW: ${esc(Object.entries(real.reduce<Record<string, number>>((m, r) => ((m[`${r.season} GW${r.gw}`] = (m[`${r.season} GW${r.gw}`] ?? 0) + 1), m), {})).map(([k, v]) => `${k}: ${v}`).join(", ") || "none")}.</p>

<h2>Outcomes</h2>
${counted.length ? `<p>${scored.length} scored (${counted.length} counted: the last recommendation per team before each deadline), ${input.outcomes.length - scored.length} unscorable.</p>
${table(["Season", "GW", "Team", "Rec", "Gaffer", "Actual", "B0", "B1", "Gaffer xP"], counted.sort((a, b) => a.gw - b.gw).map((o) => [o.season, o.gw, team(o.team_id_hash), shortId(o.rec_id), o.recommended?.points ?? "–", o.actual?.points ?? "–", o.baselines?.B0.points ?? "–", o.baselines?.B1.points ?? "–", o.recommended?.expected_points ?? "–"]), [1, 4, 5, 6, 7, 8])}
<p>Counted totals: Gaffer ${sumOf(counted, (o) => o.recommended?.points)}, actual ${sumOf(counted, (o) => o.actual?.points)}, B0 ${sumOf(counted, (o) => o.baselines?.B0.points)}, B1 ${sumOf(counted, (o) => o.baselines?.B1.points)}.</p>` : `<p class="muted">No outcomes yet: <code>gaffer-eval</code> scores a GW's recommendations once FPL marks its data as checked (${input.outcomes.length} unscorable rows).</p>`}
</body></html>
`;
	report.html = html;
	return report;
}
