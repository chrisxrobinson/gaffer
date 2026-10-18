/**
 * Gaffer's command surface (FR-UI-06, ADR 0013): an allowlist, so a built-in that a later Pi adds is
 * refused by default. The TUI hides everything else from `/` and refuses it on submit (gaffer-core/ui.ts).
 */

/** The commands Gaffer offers: its templates and commands, and four session basics. */
export const GAFFER_COMMANDS = ["gw", "whatif", "explain", "team", "prefs", "scorecard", "usage", "export-rec", "new", "resume", "copy", "help"] as const;

const ALLOWED = new Set<string>(GAFFER_COMMANDS);

/** The command a submission names (`/share x` → `share`), or undefined if it isn't a slash command. */
export function commandName(text: string): string | undefined {
	return /^\/(\S+)/.exec(text.trim())?.[1];
}

export function isAllowedCommand(name: string): boolean {
	return ALLOWED.has(name);
}

// Why each Pi command is missing, in Gaffer's words. Anything not listed gets the default.
const SESSIONS = "Use /new for a fresh session or /resume for an earlier one.";
const WHY: Record<string, string> = {
	share: "sessions stay on this machine. Use /export-rec for the recommendation's JSON.",
	export: "use /export-rec for the recommendation's JSON.",
	import: `sessions come only from Gaffer. ${SESSIONS}`,
	bug: "Gaffer sends nothing to third parties.",
	login: "the model key is set by the operator.",
	logout: "the model key is set by the operator.",
	model: "the model is set by the operator (GAFFER_MODEL).",
	"scoped-models": "the model is set by the operator (GAFFER_MODEL).",
	thinking: "the thinking level is set by the operator (GAFFER_THINKING).",
	settings: "its settings are fixed. Use /prefs for your preferences.",
	tree: `each session is one conversation. ${SESSIONS}`,
	fork: `each session is one conversation. ${SESSIONS}`,
	clone: `each session is one conversation. ${SESSIONS}`,
	name: "use /resume to see your sessions.",
	session: "use /usage for this session's cost and time.",
	compact: "Gaffer compacts a long session by itself.",
	reload: "its extensions are fixed.",
	trust: "it has no projects to trust.",
	quit: "close the browser tab instead; the session keeps running.",
	hotkeys: "type /help for what Gaffer can do and its keys.",
	changelog: "type /help for what Gaffer can do.",
	mcp: "it connects to no MCP servers.",
	llama: "it uses no local models.",
};

/** Gaffer's one-line refusal for a command it doesn't offer. */
export function refusal(name: string): string {
	const why = name.startsWith("skill:") ? "Gaffer uses its skills by itself; just ask." : (WHY[name] ?? "type /help to see what Gaffer can do.");
	return `/${name} is not available in Gaffer: ${why}`;
}
