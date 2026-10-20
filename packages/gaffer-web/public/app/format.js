// FPL's own units (docs/ui §1): £m to one decimal, xP to one decimal, local deadlines with UTC on hover.
import { html } from "./html.js";

export const CHIP = { wildcard: "Wildcard", freehit: "Free Hit", bboost: "Bench Boost", "3xc": "Triple Captain" };
export const RISK = { safe: "Safe", balanced: "Balanced", aggressive: "Aggressive" };

export const money = (v) => (typeof v === "number" ? `£${v.toFixed(1)}m` : "–");
export const xp = (v) => (typeof v === "number" ? v.toFixed(1) : "–");
/** A signed figure with a real minus sign. */
export const sign = (v) => (typeof v !== "number" ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`);
export const usd = (v, dp = 2) => (typeof v === "number" ? `$${v.toFixed(dp)}` : "–");

const pad = (n) => String(n).padStart(2, "0");
/** "6d 02:57:10", "02:57:10", or "passed". */
export function countdown(ms) {
	if (!(ms > 0)) return "passed";
	const s = Math.floor(ms / 1000);
	const d = Math.floor(s / 86400);
	const t = `${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
	return d ? `${d}d ${t}` : t;
}
/** "in 6 days", "in 5 hours", "in 12 min". */
export function until(ms) {
	if (!(ms > 0)) return "passed";
	const h = ms / 3_600_000;
	if (h >= 48) return `in ${Math.floor(h / 24)} days`;
	if (h >= 2) return `in ${Math.floor(h)} hours`;
	return `in ${Math.max(1, Math.round(ms / 60_000))} min`;
}
export function localTime(iso) {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "–";
	return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}
export const utcTime = (iso) => {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "" : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
};
export function ago(iso, now = Date.now()) {
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return "";
	const m = Math.round((now - t) / 60_000);
	if (m < 1) return "just now";
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h} h ago`;
	return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
export const secs = (ms) => (typeof ms === "number" ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : "");

export const ICON = {
	ok: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="2" fill="none" /></svg>`,
	err: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" fill="none" /></svg>`,
	run: html`<svg viewBox="0 0 16 16" class="spin" aria-hidden="true"><path d="M8 2a6 6 0 1 1-6 6" stroke="currentColor" stroke-width="2" fill="none" /></svg>`,
	wait: html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-dasharray="2 2.4" /></svg>`,
	warn: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2l7 12H1z" stroke="currentColor" stroke-width="1.6" fill="none" /><path d="M8 6v4M8 11.5v1" stroke="currentColor" stroke-width="1.6" /></svg>`,
	info: html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5" fill="none" /><path d="M8 7v4M8 4.5v1" stroke="currentColor" stroke-width="1.6" /></svg>`,
	plus: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.8" fill="none" /></svg>`,
};

/** The Gaffer mark (docs/ui/brand/gaffer-mark.svg): the centre circle open at the top right, the halfway line its bar. */
export const Mark = ({ mono = false } = {}) => html`<svg viewBox="0 0 64 64" aria-hidden="true">
	<path d="M56 32 A24 24 0 1 1 45.77 12.34" fill="none" stroke=${mono ? "currentColor" : "var(--ink)"} stroke-width="7" />
	<path d="M32 32 H59.5" fill="none" stroke=${mono ? "currentColor" : "var(--brand)"} stroke-width="7" />
	<circle cx="32" cy="32" r="6" fill=${mono ? "currentColor" : "var(--brand)"} />
</svg>`;
