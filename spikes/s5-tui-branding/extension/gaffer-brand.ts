/**
 * Spike S5: can a Pi 1.3.0 extension brand the TUI as Gaffer without patching Pi?
 * - header: setHeader() with a placeholder block-letter wordmark
 * - status strip: setFooter() with fake team / GW / deadline countdown (ticks every second) / FTs / bank / budget
 * - title: setTitle(), re-applied after Pi's own updateTerminalTitle()
 * - commands: hide built-ins from autocomplete (addAutocompleteProvider) and block them on submit
 *   (a CustomEditor whose onSubmit setter wraps the handler Pi installs)
 * Throwaway code. Writes a probe log to $S5_LOG so the run script can see which events fired.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { type AutocompleteProvider, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const LOG = process.env.S5_LOG;
const log = (line: string) => {
	if (LOG) appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
};

// Built-in and built-in-extension commands Gaffer refuses (see the research note for the reasons).
export const BLOCKED = new Set([
	"settings", "model", "thinking", "scoped-models", "login", "logout",
	"export", "import", "share", "bug", "name", "session", "fork", "clone", "tree", "trust",
	"resume", "reload", "changelog", "debug", "arminsayshi", "dementedelves", "quit",
	"compact", "mcp", "llama",
]);
// Pi commands Gaffer keeps (justified session basics).
export const KEPT = new Set(["new", "copy", "hotkeys"]);

const WORDMARK = [
	" ██████   █████  ███████ ███████ ███████ ██████ ",
	"██       ██   ██ ██      ██      ██      ██   ██",
	"██   ███ ███████ █████   █████   █████   ██████ ",
	"██    ██ ██   ██ ██      ██      ██      ██   ██",
	" ██████  ██   ██ ██      ██      ███████ ██   ██",
];

function commandName(text: string): string | undefined {
	const m = /^\/([^\s]+)/.exec(text.trim());
	return m?.[1];
}

class GafferEditor extends CustomEditor {
	constructor(...args: ConstructorParameters<typeof CustomEditor>) {
		super(...args);
		// Pi copies its submit handler onto a custom editor (`newEditor.onSubmit = defaultEditor.onSubmit`).
		// An accessor wraps whatever Pi installs, so every submission (Enter, Alt+Enter when idle) passes here
		// before Pi's built-in command dispatch.
		let inner: ((text: string) => void) | undefined;
		Object.defineProperty(this, "onSubmit", {
			configurable: true,
			enumerable: true,
			get: () =>
				inner &&
				((text: string) => {
					const name = commandName(text);
					if (name && (BLOCKED.has(name) || name.startsWith("skill:"))) {
						log(`blocked /${name}`);
						notify?.(`/${name} isn't available in Gaffer. Type / to see Gaffer's commands.`);
						return;
					}
					inner?.(text);
				}),
			set: (fn: ((text: string) => void) | undefined) => {
				log(`onSubmit installed by Pi: ${typeof fn}`);
				inner = fn;
			},
		});
	}
}
let notify: ((msg: string) => void) | undefined;

function hideBuiltins(current: AutocompleteProvider): AutocompleteProvider {
	return {
		...current,
		triggerCharacters: current.triggerCharacters,
		async getSuggestions(lines, line, col, options) {
			const before = (lines[line] ?? "").slice(0, col).trimStart();
			// Only slash-command suggestions; no @file or Tab path completion of the harness filesystem.
			if (!before.startsWith("/")) return null;
			const res = await current.getSuggestions(lines, line, col, options);
			if (!res) return res;
			if (before.includes(" ")) {
				const name = commandName(before);
				return name && (BLOCKED.has(name) || name.startsWith("skill:")) ? null : res;
			}
			const items = res.items.filter((i) => !BLOCKED.has(i.value) && !i.value.startsWith("skill:"));
			return items.length ? { ...res, items } : null;
		},
		applyCompletion: current.applyCompletion.bind(current),
		shouldTriggerFileCompletion: () => false,
	};
}

// Fake FPL state for the strip. Deadline: 2 days 3 hours after start, so the countdown visibly ticks.
const deadline = Date.now() + (2 * 24 + 3) * 3600_000 + 12 * 60_000;
function countdown(ms: number): string {
	if (ms <= 0) return "passed";
	const s = Math.floor(ms / 1000);
	const d = Math.floor(s / 86400);
	const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, "0");
	const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
	const ss = String(s % 60).padStart(2, "0");
	return `${d}d ${hh}:${mm}:${ss}`;
}

function applyBranding(ctx: ExtensionContext) {
	if (ctx.mode !== "tui") return;
	notify = (m) => ctx.ui.notify(m, "warning");

	ctx.ui.setHeader((_tui, theme) => ({
		invalidate() {},
		render(width: number): string[] {
			const tagline = `${theme.fg("muted", "Fantasy Premier League advisor")}  ${theme.fg("dim", "· /team <id> to start · / for commands · Esc to stop")}`;
			if (width < 52) return ["", theme.bold(theme.fg("accent", "GAFFER")), truncateToWidth(tagline, width), ""];
			return ["", ...WORDMARK.map((l) => theme.fg("accent", l)), "", truncateToWidth(tagline, width), ""];
		},
	}));

	ctx.ui.setFooter((tui, theme) => {
		const timer = setInterval(() => tui.requestRender(), 1000);
		return {
			dispose: () => clearInterval(timer),
			invalidate() {},
			render(width: number): string[] {
				const sep = theme.fg("borderMuted", " │ ");
				const left = theme.fg("accent", theme.bold(" GAFFER "));
				const parts = [
					`${theme.fg("muted", "Team")} ${theme.fg("text", "Spike Utd")}`,
					`${theme.fg("muted", "GW")}${theme.fg("text", "8")}`,
					`${theme.fg("muted", "Deadline")} ${theme.fg("warning", countdown(deadline - Date.now()))}`,
					`${theme.fg("muted", "FT")} ${theme.fg("text", "2")}`,
					`${theme.fg("muted", "Bank")} ${theme.fg("text", "£1.5m")}`,
					`${theme.fg("muted", "Budget")} ${theme.fg("success", "$0.06")}${theme.fg("dim", "/$0.50")}`,
				];
				const line = left + sep + parts.join(sep);
				const model = theme.fg("dim", ` ${ctx.model?.id ?? "no model"} · thinking ${ctx.thinkingLevel ?? "?"}`);
				const out = [truncateToWidth(line, width)];
				if (visibleWidth(line) + visibleWidth(model) <= width) out[0] = line + " ".repeat(width - visibleWidth(line) - visibleWidth(model)) + model;
				return out;
			},
		};
	});

	ctx.ui.setEditorComponent((tui, theme, kb) => new GafferEditor(tui, theme, kb));
	ctx.ui.addAutocompleteProvider(hideBuiltins);
	ctx.ui.setHiddenThinkingLabel("Gaffer is thinking…");
	ctx.ui.setWorkingMessage("Gaffer is working…");
	// Pi calls updateTerminalTitle() ("π - <cwd>") after session_start handlers return, so set it on the next tick too.
	ctx.ui.setTitle("Gaffer · GW8");
	setTimeout(() => ctx.ui.setTitle("Gaffer · GW8"), 50);
}

export default function gafferBrand(pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx) => {
		log(`session_start reason=${(event as { reason?: string }).reason} mode=${ctx.mode} theme=${ctx.ui.theme.name} appearance=${ctx.ui.theme.appearance}`);
		applyBranding(ctx);
	});
	// Probe: does the input event ever see built-in slash commands?
	pi.on("input", async (event) => {
		log(`input event text=${JSON.stringify((event as { text?: string }).text)}`);
		return { action: "continue" };
	});
	// Probe: an extension command with a built-in's name.
	pi.registerCommand("share", {
		description: "S5 probe: extension command named share",
		handler: async (_args, ctx) => {
			log("extension /share handler ran");
			ctx.ui.notify("extension /share ran", "info");
		},
	});
	pi.registerCommand("team", {
		description: "Set your FPL team (spike stub)",
		handler: async (args, ctx) => ctx.ui.notify(`team ${args} (stub)`, "info"),
	});
	for (const [name, description] of [
		["prefs", "Show or change your preferences (spike stub)"],
		["export-rec", "Export the last recommendation as JSON (spike stub)"],
		["usage", "Token and cost usage (spike stub)"],
		["scorecard", "How past recommendations scored (spike stub)"],
	] as const) {
		pi.registerCommand(name, { description, handler: async (_a, ctx) => ctx.ui.notify(`${name} (stub)`, "info") });
	}
}
