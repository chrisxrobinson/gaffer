/**
 * The human-readable recommendation (ARCHITECTURE §2.4, FR-OUT-02): transfers, XI and bench, captain
 * and vice, chip, the 4-GW table, warnings and summary, laid out for a 100-column terminal. Tables
 * never exceed the width they are given: long cells wrap inside their own column.
 */
import type { Recommendation } from "./schema/recommendation.ts";

export const RENDER_WIDTH = 100;
const MIN_WIDTH = 72;

/** Colouring hooks; the default leaves text plain (tests, exports, the model-facing copy). */
export interface Paint {
	title(s: string): string;
	label(s: string): string;
	dim(s: string): string;
	good(s: string): string;
	warn(s: string): string;
	bad(s: string): string;
}
const id = (s: string) => s;
export const PLAIN: Paint = { title: id, label: id, dim: id, good: id, warn: id, bad: id };

const CHIP_LABEL: Record<string, string> = { wildcard: "Wildcard", freehit: "Free Hit", bboost: "Bench Boost", "3xc": "Triple Captain" };
const CHIP_SHORT: Record<string, string> = { wildcard: "WC", freehit: "FH", bboost: "BB", "3xc": "TC" };
const POSITIONS = ["GKP", "DEF", "MID", "FWD"];

const money = (v: number) => `£${v.toFixed(1)}m`;
const signed = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const padR = (s: string, n: number) => cut(s, n).padEnd(n);
const padL = (s: string, n: number) => cut(s, n).padStart(n);

/** Greedy word wrap to `width` columns; a word longer than the width is cut. */
export function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const w = cut(word, width);
		if (line && line.length + 1 + w.length > width) {
			out.push(line);
			line = w;
		} else {
			line = line ? `${line} ${w}` : w;
		}
	}
	if (line) out.push(line);
	return out.length ? out : [""];
}

/** Join items with a separator, starting a new line rather than passing `width`. */
function flow(items: string[], sep: string, width: number): string[] {
	const out: string[] = [];
	let line = "";
	for (const raw of items) {
		const item = cut(raw, width);
		if (line && line.length + sep.length + item.length > width) {
			out.push(line);
			line = item;
		} else {
			line = line ? `${line}${sep}${item}` : item;
		}
	}
	if (line) out.push(line);
	return out;
}

function deadlineText(iso: string | null): string {
	if (!iso) return "deadline unknown";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return `deadline ${iso}`;
	const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
	const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
	return `deadline ${day} ${d.getUTCDate()} ${month} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

export function recommendationLines(rec: Recommendation, width: number = RENDER_WIDTH, paint: Paint = PLAIN): string[] {
	const W = Math.max(MIN_WIDTH, Math.min(width, RENDER_WIDTH));
	const L: string[] = [];
	const name = (pid: number) => rec.players[String(pid)]?.name ?? `#${pid}`;
	const club = (pid: number) => rec.players[String(pid)]?.team ?? "?";
	const xp = (pid: number) => (rec.players[String(pid)]?.xp ?? 0).toFixed(1);
	const level = (l: string, text: string = l) => (l === "high" ? paint.good(text) : l === "low" ? paint.bad(text) : paint.warn(text));
	const section = (title: string, rest = "") => {
		L.push("");
		L.push(`${paint.label(title)}${rest ? `  ${rest}` : ""}`);
	};
	const para = (text: string, indent: string, colour: (s: string) => string = id) => {
		for (const line of wrap(text, W - indent.length)) L.push(indent + colour(line));
	};

	const head = flow([`GAFFER · GW${rec.gw} recommendation`, deadlineText(rec.deadline), `confidence ${rec.confidence.overall}`], " · ", W);
	head.forEach((line, i) => L.push(i === 0 ? paint.title(line) : line));
	const a = rec.assumptions;
	const start = [
		`${a.free_transfers ?? "?"} free transfer${a.free_transfers === 1 ? "" : "s"} (${a.ft_source === "user" ? "yours" : "derived"})`,
		`bank ${money(a.bank)}`,
		...(a.pending_transfers.length ? [`${a.pending_transfers.length} pending transfer(s) already counted`] : []),
		`data from ${rec.snapshot.fetched_at.slice(0, 16).replace("T", " ")} UTC${rec.snapshot.stale ? " — STALE" : ""}`,
	];
	for (const line of flow(start, " · ", W)) L.push(paint.dim(line));

	// Transfers
	if (rec.transfers.length) {
		const hits = rec.hits ? `${rec.hits} hit${rec.hits === 1 ? "" : "s"}, −${rec.hit_cost}` : "no hits";
		section("TRANSFERS", `net ${signed(rec.net_xp_gain_4gw)} xP over 4 GWs (${hits})`);
		const n = Math.floor((W - 2 - 8 - 8 - 9 - 9 - 8 - 4) / 2); // the two name columns share what is left
		L.push(paint.dim(`  ${padR("Out", n)}${padL("Sell", 8)}  → ${padR("In", n)}${padL("Price", 8)}${padL("xP 4GW", 9)}${padL("xP 6GW*", 9)}  Conf`));
		for (const t of rec.transfers) {
			L.push(`  ${padR(`${t.out.name} (${club(t.out.id)})`, n)}${padL(money(t.out.sell_price), 8)}  → ${padR(`${t.in.name} (${club(t.in.id)})`, n)}${padL(money(t.in.price), 8)}${padL(signed(t.xp_gain_4gw), 9)}${padL(signed(t.xp_gain_6gw_decayed), 9)}  ${level(t.confidence, t.confidence)}`);
			para(t.rationale, "      ", paint.dim);
		}
		L.push(paint.dim("  * over the 6-GW horizon, later GWs weighted down"));
	} else {
		section("TRANSFERS", "none this GW");
	}

	// XI and bench
	section("STARTING XI", `${rec.expected_points_gw.toFixed(1)} expected points (captain counted twice, before hits)`);
	for (const pos of POSITIONS) {
		const players = rec.starting_xi.filter((p) => rec.players[String(p)]?.position === pos);
		if (!players.length) continue;
		const items = players.map((p) => `${name(p)}${p === rec.captain.id ? " (C)" : p === rec.vice_captain.id ? " (V)" : ""} ${xp(p)}`);
		flow(items, " · ", W - 7).forEach((line, i) => L.push(`  ${i === 0 ? pos : "   "}  ${line}`));
	}
	const bench = rec.bench.map((p, i) => `${i === 0 ? "GK" : i} ${name(p)} ${xp(p)}`);
	flow(bench, " · ", W - 9).forEach((line, i) => L.push(`  ${i === 0 ? paint.dim("Bench") : "     "}  ${line}`));

	section("CAPTAIN", `${cut(rec.captain.name, W - 34)} ${rec.captain.xp.toFixed(1)} xP, P(start) ${rec.captain.p_start.toFixed(2)}`);
	L.push(`${paint.label("VICE")}     ${cut(rec.vice_captain.name, W - 34)} ${rec.vice_captain.xp.toFixed(1)} xP, P(start) ${rec.vice_captain.p_start.toFixed(2)}`);

	// Chip
	section("CHIP", `${rec.chip.play ? `play ${CHIP_LABEL[rec.chip.play]}` : "none this GW"} (confidence ${level(rec.chip.confidence)})`);
	para(rec.chip.rationale, "  ", paint.dim);
	for (const s of rec.chip.scenarios) {
		const label = `${CHIP_LABEL[s.chip] ?? s.chip}${s.gw ? ` in GW${s.gw}` : ""}`;
		const text = s.evaluated ? `${label}: ${signed(s.delta_xp ?? 0)} xP over the horizon (${signed(s.delta_xp_gw ?? 0)} that GW)` : `${label}: not evaluated — ${s.reason ?? "no reason given"}`;
		wrap(text, W - 4).forEach((line, i) => L.push(`  ${i === 0 ? "·" : " "} ${line}`));
	}

	// The plan table: the transfers column takes what is left and wraps inside itself.
	section("PLAN", `GW${rec.plan[0].gw}–GW${rec.plan[rec.plan.length - 1].gw}`);
	const tw = W - (2 + 5 + 4 + 6 + 2 + 6 + 18 + 7);
	L.push(paint.dim(`  ${padR("GW", 5)}${padR("FT", 4)}${padR("Transfers", tw)}${padL("Hits", 6)}  ${padR("Chip", 6)}${padR("Captain", 18)}${padL("xP", 7)}`));
	for (const p of rec.plan) {
		const moves = p.transfers.length ? flow(p.transfers.map((t) => `${t.out.name}→${t.in.name}`), ", ", tw - 1) : [p.roll_ft ? "roll" : "—"];
		moves.forEach((cell, i) => {
			if (i === 0) L.push(`  ${padR(String(p.gw), 5)}${padR(String(p.free_transfers), 4)}${padR(cell, tw)}${padL(p.hits ? `−${p.hit_cost}` : "0", 6)}  ${padR(p.chip ? CHIP_SHORT[p.chip] : "–", 6)}${padR(name(p.captain), 18)}${padL(p.expected_points.toFixed(1), 7)}`);
			else L.push(`  ${" ".repeat(9)}${cut(cell, tw)}`);
		});
	}
	for (const p of rec.plan) if (p.note) para(`GW${p.gw}: ${p.note}`, "  ", paint.dim);

	if (rec.xmins_overrides.length) {
		section("TEAM NEWS APPLIED");
		for (const x of rec.xmins_overrides) para(`${x.name}: ${x.xmins} expected minutes${x.gw ? ` in GW${x.gw}` : ""} — “${x.quote}” (${x.source === "news" ? "FPL news" : "from you"})`, "  ");
	}

	if (rec.warnings.length) {
		section("WARNINGS");
		for (const w of rec.warnings) wrap(w, W - 4).forEach((line, i) => L.push(`  ${i === 0 ? paint.warn("!") : " "} ${line}`));
	}

	section("SUMMARY");
	para(rec.summary, "  ");
	L.push("");
	wrap(`Confidence ${rec.confidence.overall}${rec.confidence.drivers.length ? `: ${rec.confidence.drivers.join("; ")}` : ""}`, W).forEach((line) => L.push(paint.dim(line)));
	const v = rec.validation;
	const drift = !v.numbers_checked
		? "the model quoted no figures"
		: v.drift.length
			? `${v.drift.length} of the model's ${v.numbers_checked} figures were wrong and were corrected (largest gap ${v.max_model_number_drift.toFixed(1)})`
			: `the model's ${v.numbers_checked} figures were within ${v.max_model_number_drift.toFixed(1)} of them`;
	wrap(`Validated against the rules and recomputed by gaffer_lib ${rec.gaffer_lib}; ${drift}. ${rec.rec_id} · /export-rec saves the JSON.`, W).forEach((line) => L.push(paint.dim(line)));
	return L;
}

export interface SubmitFailure {
	failed: true;
	attempts: number;
	errors: { code: string; message: string; gw?: number }[];
}

/** What the user sees when every attempt failed (FR-REC-08): a clear failure, never an illegal plan. */
export function failureLines(f: SubmitFailure, width: number = RENDER_WIDTH, paint: Paint = PLAIN): string[] {
	const W = Math.max(MIN_WIDTH, Math.min(width, RENDER_WIDTH));
	const L = [paint.bad(`GAFFER · no recommendation`), ""];
	L.push(...wrap(`Gaffer's plan failed validation ${f.attempts} times, so no recommendation is shown or saved. A plan that breaks FPL's rules, or whose numbers can't be recomputed, is never presented.`, W));
	L.push("", paint.label("Last errors"));
	for (const e of f.errors.slice(0, 6)) wrap(`[${e.code}] ${e.message}`, W - 4).forEach((line, i) => L.push(`  ${i === 0 ? "·" : " "} ${line}`));
	L.push("", ...wrap("Ask again (for example /gw), or change the request. If it keeps failing, the errors above say what Gaffer got wrong.", W));
	return L;
}
