/**
 * gaffer-ui: the terminal's identity and command surface (ADR 0013, docs/ui §2–3). Re-applied on every
 * session_start: Pi resets extension UI on /new, /resume and reload (and the title after session_start).
 * - Header: the mark, the ASCII wordmark and a tagline; one line under 52 columns. `quietStartup` hides Pi's.
 * - Footer: the status strip (team, GW and live deadline countdown, free transfers, bank) and spend against
 *   the caps with the model. Redrawn every second; spend is recomputed on turn_end and tool_execution_end
 *   with the functions /usage uses.
 * - Title: "Gaffer · GW8 · 6d", with "working" while a run is active.
 * - Commands: an autocomplete provider listing only Gaffer's (no @file or path completion), and an editor
 *   whose onSubmit refuses everything else. Pi copies its submit handler onto a custom editor
 *   (`newEditor.onSubmit = this.defaultEditor.onSubmit`, interactive-mode.ts @v1.3.0), which is undocumented,
 *   so deploy/compose/tests/commands.mjs checks it in the real TUI on every Pi upgrade. This is defence in
 *   depth: /share, /bug, /login and MCP are neutralised by settings, PI_OFFLINE and --no-mcp.
 */
import { CustomEditor, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { type AutocompleteProvider, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { commandName, GAFFER_COMMANDS, isAllowedCommand, refusal } from "../../src/commands.ts";
import { budgetConfig, fplNow, sessionsRoot } from "../../src/config.ts";
import type { SessionFplState } from "../../src/prompt.ts";
import { fplState, type SnapshotEntry } from "../../src/session.ts";
import { usageNow } from "../../src/usage.ts";

/** docs/ui/brand/wordmark.txt: the mark (7 columns), 4 spaces, "GAFFER" (29 columns). */
export const WORDMARK = [" ▄▀▀▀▀     ▄▀▀▀ ▄▀▀▄ █▀▀▀ █▀▀▀ █▀▀▀ █▀▀▄", "█  ●━━━    █ ▀█ █▀▀█ █▀▀  █▀▀  █▀▀  █▀▀▄", " ▀▄▄▄▄▀    ▀▄▄▀ ▀  ▀ ▀    ▀    ▀▀▀▀ ▀  ▀"];

type Paint = Pick<Theme, "fg" | "bold">;

export interface Spend {
	session: number;
	today: number;
}

/** What the header and strip show: the session's FPL state, its latest snapshot, spend, and the model. */
export interface UiState {
	fpl: SessionFplState & { snapshot?: SnapshotEntry };
	spend?: Spend;
	model?: string;
	thinking?: string;
	running?: boolean;
}

/** "6d 02:57:13", "02:57:13", or null once the deadline has passed. */
export function countdown(ms: number): string | null {
	if (ms <= 0) return null;
	const s = Math.floor(ms / 1000);
	const hms = [Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
	return s >= 86400 ? `${Math.floor(s / 86400)}d ${hms}` : hms;
}

/** The FPL season a date falls in ("2026/27"); the game opens for a new season in July. */
export function seasonOf(ms: number): string {
	const d = new Date(ms);
	const y = d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
	return `${y}/${String((y + 1) % 100).padStart(2, "0")}`;
}

const usd = (x: number) => `$${x.toFixed(4)}`;
const cap = (x: number) => `$${x.toFixed(2)}`;
const pad = (left: string, right: string, width: number) => {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return gap >= 1 ? left + " ".repeat(gap) + right : truncateToWidth(left, width);
};

export function headerLines(s: UiState, width: number, t: Paint, now = fplNow()): string[] {
	const season = s.fpl.snapshot?.season ?? seasonOf(now);
	const model = [s.model, s.thinking && `thinking ${s.thinking}`].filter(Boolean).join(" · ");
	if (width < 52) return [truncateToWidth(`${t.bold(t.fg("accent", "GAFFER"))} ${t.fg("muted", `· ${season} · advice only`)}`, width)];
	const tagline = [t.bold(`Fantasy Premier League assistant · ${season}`), t.fg("muted", model || "model not set"), t.fg("muted", "Advice only. Gaffer never logs in to your FPL account.")];
	const lines = WORDMARK.map((row, i) => {
		const art = i === 1 ? t.bold("█  ") + t.fg("accent", "●━━━") + t.bold(row.slice(7)) : t.bold(row);
		return truncateToWidth(`${art}    ${tagline[i]}`, width);
	});
	const cmd = (c: string) => t.fg("accent", c);
	const start = s.fpl.teamId
		? t.fg("muted", ` Team set${s.fpl.teamName ? `: ${s.fpl.teamName}` : ""}. Ask for `) + cmd("/gw") + t.fg("muted", ", or ask a question in words.")
		: t.fg("muted", " Start with ") + cmd("/team <id>") + t.fg("muted", " (the number in your Points page address), then ") + cmd("/gw") + t.fg("muted", ".");
	const keys = t.fg("dim", " Type / for commands · Shift+Enter new line · Esc stops a run · PageUp/PageDown scroll");
	return [...lines, "", truncateToWidth(start, width), truncateToWidth(keys, width), ""];
}

/** The two footer lines: the status strip, then spend against the caps and the model. */
export function stripLines(s: UiState, width: number, t: Paint, now = fplNow()): string[] {
	const sep = t.fg("muted", " · ");
	const snap = s.fpl.snapshot;
	let status: string;
	if (!s.fpl.teamId) status = t.fg("muted", "No team yet: ") + t.fg("accent", "/team <id>") + t.fg("muted", " to start");
	else {
		const name = t.bold(s.fpl.teamName ?? snap?.team_name ?? `Team ${s.fpl.teamId}`);
		if (!snap) status = name + sep + t.fg("muted", "no snapshot yet: ") + t.fg("accent", "/gw") + t.fg("muted", " fetches one");
		else {
			const gw = snap.gw.next ?? snap.gw.current;
			const left = snap.gw.deadline ? countdown(Date.parse(snap.gw.deadline) - now) : null;
			const deadline = t.bold(t.fg("warning", `GW${gw ?? "?"} ${left ?? "deadline passed"}`));
			const ft = snap.free_transfers === null || snap.free_transfers === undefined ? "?" : String(snap.free_transfers);
			const parts = [name, deadline, t.fg("muted", "FT ") + ft + (snap.ft_source === "derived" ? t.fg("muted", " (derived)") : ""), t.fg("muted", "bank ") + (typeof snap.bank === "number" ? `£${snap.bank.toFixed(1)}m` : "?")];
			if (snap.stale) parts.push(t.fg("warning", "data stale"));
			status = parts.join(sep);
		}
	}
	const cfg = budgetConfig();
	const money = (x: number, soft: number, hard: number) => (x >= hard ? t.fg("error", usd(x)) : x >= soft ? t.fg("warning", usd(x)) : usd(x));
	const spend = s.spend
		? t.fg("muted", "today ") + money(s.spend.today, cfg.daily, cfg.daily) + t.fg("muted", ` of ${cap(cfg.daily)} · session `) + money(s.spend.session, cfg.soft, cfg.hard) + t.fg("muted", ` of ${cap(cfg.hard)}`)
		: t.fg("muted", "spend not read yet");
	const model = t.fg("dim", [s.model ?? "no model", s.thinking && `thinking ${s.thinking}`].filter(Boolean).join(" · "));
	return [truncateToWidth(` ${status}`, width), pad(` ${spend}`, `${model} `, width)];
}

/** "Gaffer · GW8 · 6d" ("5h", "42m"), with "working" while a run is active. */
export function titleText(s: UiState, now = fplNow()): string {
	const parts = ["Gaffer"];
	const snap = s.fpl.snapshot;
	if (snap) {
		parts.push(`GW${snap.gw.next ?? snap.gw.current ?? "?"}`);
		const ms = snap.gw.deadline ? Date.parse(snap.gw.deadline) - now : 0;
		parts.push(ms <= 0 ? "deadline passed" : ms >= 86_400_000 ? `${Math.floor(ms / 86_400_000)}d` : ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}h` : `${Math.max(1, Math.floor(ms / 60_000))}m`);
	}
	if (s.running) parts.push("working");
	return parts.join(" · ");
}

/** Only Gaffer's commands in the `/` list; nothing for `@file` or Tab path completion. */
export function gafferAutocomplete(current: AutocompleteProvider): AutocompleteProvider {
	return {
		triggerCharacters: [],
		async getSuggestions(lines, line, col, options) {
			const before = (lines[line] ?? "").slice(0, col).trimStart();
			if (line !== 0 || !before.startsWith("/")) return null;
			const name = commandName(before);
			if (before.includes(" ")) return name && isAllowedCommand(name) ? current.getSuggestions(lines, line, col, options) : null;
			const res = await current.getSuggestions(lines, line, col, options);
			const items = res?.items.filter((i) => isAllowedCommand(i.value.replace(/^\//, ""))) ?? [];
			return res && items.length ? { ...res, items } : null;
		},
		applyCompletion: (lines, line, col, item, prefix) => current.applyCompletion(lines, line, col, item, prefix),
		shouldTriggerFileCompletion: () => false,
	};
}

/** A submit handler that refuses every slash command not on Gaffer's list and passes everything else on. */
export function guardSubmit(inner: (text: string) => void, refuse: (message: string) => void): (text: string) => void {
	return (text) => {
		const name = commandName(text);
		if (name && !isAllowedCommand(name)) return refuse(refusal(name));
		inner(text);
	};
}

class GafferEditor extends CustomEditor {
	constructor(refuse: (message: string) => void, ...args: ConstructorParameters<typeof CustomEditor>) {
		super(...args);
		// An accessor over the class field, so the handler Pi assigns is wrapped (see the file comment).
		let inner: ((text: string) => void) | undefined;
		Object.defineProperty(this, "onSubmit", {
			configurable: true,
			enumerable: true,
			get: () => inner && guardSubmit(inner, refuse),
			set: (fn: ((text: string) => void) | undefined) => {
				inner = fn;
			},
		});
	}
}

const DESCRIBE: Record<(typeof GAFFER_COMMANDS)[number], string> = {
	gw: "/gw [notes]          the next GW's recommendation: transfers, captain, XI, chip, 4-GW plan",
	whatif: "/whatif <idea>       test a transfer or chip against the best plan: /whatif Watkins>Isak",
	explain: "/explain <player>    why a player is in, out or captain",
	team: '/team <id>           set your FPL team; add --ft N or --pending "OUT>IN" if FPL is behind',
	prefs: "/prefs [...]         show or change saved preferences: risk, chips to save, keep, avoid, hits",
	scorecard: "/scorecard           season to date: Gaffer's plans against your points and the baselines",
	usage: "/usage               cost and time for this session and today, against the caps",
	"export-rec": "/export-rec          write the latest recommendation as JSON to /data/exports",
	new: "/new                 start a new session",
	resume: "/resume              open an earlier session",
	copy: "/copy                copy the last answer",
	help: "/help                this list",
};

/** Gaffer's /help, in its own voice (docs/ui §2): what it can do and how to ask. */
export function helpLines(): string[] {
	return [
		"GAFFER · help",
		"Gaffer plans your FPL week from public FPL data with tested maths, and explains its picks.",
		"It gives advice only and never logs in to your FPL account.",
		"Start with /team <id> (the number in your Points page address), then /gw.",
		...GAFFER_COMMANDS.map((c) => `  ${DESCRIBE[c]}`),
		'Or ask in words: "Is Palmer worth keeping?", "Should I play the Bench Boost in GW9?"',
		"Keys: Shift+Enter new line · Esc stops a run · PageUp/PageDown, Ctrl+Home/End scroll",
		"Copy: drag to select, or /copy for the last answer.",
	];
}

export function gafferUi(pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let spend: Spend | undefined;
	let running = false;
	let title = "";
	let current: ExtensionContext | undefined;
	const stop = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};

	const state = (ctx: ExtensionContext): UiState => {
		// The session's team and its latest snapshot, as fpl_context sees them (the entry is the whole SnapshotEntry).
		const fpl = fplState(ctx.sessionManager.getBranch()) as UiState["fpl"];
		return { fpl, spend, model: ctx.model?.id, thinking: pi.getThinkingLevel(), running };
	};
	const refreshSpend = (ctx: ExtensionContext) => {
		try {
			const { session, today } = usageNow(ctx.sessionManager, sessionsRoot(ctx.sessionManager.getSessionDir()));
			spend = { session: session.cost, today: today.cost };
		} catch {
			/* keep the last figures */
		}
	};
	const retitle = (ctx: ExtensionContext, force = false) => {
		const next = titleText(state(ctx));
		if (force || next !== title) ctx.ui.setTitle((title = next));
	};

	pi.on("session_start", async (_event, ctx) => {
		stop();
		current = ctx;
		if (ctx.mode !== "tui") return;
		refreshSpend(ctx);
		ctx.ui.setHeader((_tui, theme) => ({
			invalidate() {},
			render: (width: number) => {
				try {
					return headerLines(state(ctx), width, theme);
				} catch {
					return [truncateToWidth("GAFFER", width)];
				}
			},
		}));
		ctx.ui.setFooter((tui, theme) => {
			stop();
			timer = setInterval(() => {
				tui.requestRender();
				try {
					retitle(ctx);
				} catch {
					/* a stale context after a session switch: the next session_start replaces this footer */
				}
			}, 1000);
			return {
				dispose: stop,
				invalidate() {},
				render: (width: number) => {
					try {
						return stripLines(state(ctx), width, theme);
					} catch {
						return [truncateToWidth(" Gaffer", width), ""];
					}
				},
			};
		});
		ctx.ui.addAutocompleteProvider(gafferAutocomplete);
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new GafferEditor((m) => ctx.ui.notify(m, "warning"), tui, theme, keybindings));
		// Pi sets its own title ("π - work") after session_start handlers return.
		retitle(ctx, true);
		setTimeout(() => {
			try {
				if (current === ctx) retitle(ctx, true);
			} catch {
				/* the session was replaced or disposed meanwhile */
			}
		}, 50).unref?.();
	});
	pi.on("session_shutdown", async () => {
		stop();
		current = undefined;
	});
	pi.on("agent_start", async (_event, ctx) => {
		running = true;
		if (ctx.mode === "tui") retitle(ctx);
	});
	pi.on("agent_end", async (_event, ctx) => {
		running = false;
		if (ctx.mode === "tui") {
			refreshSpend(ctx);
			retitle(ctx);
		}
	});
	pi.on("turn_end", async (_event, ctx) => {
		if (ctx.mode === "tui") refreshSpend(ctx);
	});
	pi.on("tool_execution_end", async (_event, ctx) => {
		if (ctx.mode === "tui") refreshSpend(ctx);
	});

	pi.registerCommand("help", {
		description: "What Gaffer can do and how to ask",
		handler: async (_args, ctx) => ctx.ui.notify(helpLines().join("\n"), "info"),
	});
}
