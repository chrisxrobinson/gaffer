/**
 * The Gaffer Terminal's identity and command surface (ADR 0013): FR-UI-05 (header and status strip, with the
 * real extensions and the faux model), FR-UI-06 (the allowlist: autocomplete and the submit guard, one test
 * per refused command). The same refusals in the real TUI under tmux: deploy/compose/tests/commands.mjs.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AutocompleteProvider, CombinedAutocompleteProvider, visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { countdown, gafferAutocomplete, guardSubmit, headerLines, helpLines, seasonOf, stripLines, titleText, type UiState, WORDMARK } from "../extensions/gaffer-core/ui.ts";
import { commandName, GAFFER_COMMANDS, refusal } from "../src/commands.ts";
import { DEADLINE_GW6 } from "./fixtures.ts";
import { type GafferTestEnv, startEnv, startGaffer } from "./harness.ts";

const plain = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as never;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { BUILTIN_SLASH_COMMANDS } = (await import(pathToFileURL(join(piDist, "core/slash-commands.js")).href)) as { BUILTIN_SLASH_COMMANDS: { name: string }[] };
// Typed in full in the TUI, Pi 1.3.0 also runs these (interactive-mode.ts), and its built-in extensions add /mcp and /llama.
const HIDDEN = ["debug", "arminsayshi", "dementedelves", "mcp", "llama"];

describe("header (FR-UI-05)", () => {
	const s: UiState = { fpl: {}, model: "claude-sonnet-5-5", thinking: "medium" };

	it("is docs/ui/brand/wordmark.txt beside a tagline (season, model, advice only), within 100 columns", () => {
		expect(WORDMARK).toEqual(readFileSync(join(import.meta.dirname, "../../../docs/ui/brand/wordmark.txt"), "utf8").trimEnd().split("\n"));
		const lines = headerLines(s, 100, plain, Date.parse("2026-10-18T12:00:00Z")).map(strip);
		WORDMARK.forEach((row, i) => expect(lines[i].startsWith(`${row}    `)).toBe(true));
		expect(lines[0]).toContain("Fantasy Premier League assistant · 2026/27");
		expect(lines[1]).toContain("claude-sonnet-5-5 · thinking medium");
		expect(lines[2]).toContain("Advice only.");
		expect(lines.join("\n")).toContain("/team <id>");
		for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(100);
		expect(lines.join("\n")).not.toMatch(/π|pi v|v1\.3|\/work|ctrl\+o/i);
	});

	it("falls back to one line under 52 columns", () => {
		expect(headerLines(s, 51, plain).map(strip)).toEqual([expect.stringMatching(/^GAFFER · \d{4}\/\d{2} · advice only$/)]);
		expect(headerLines(s, 52, plain).length).toBeGreaterThan(1);
	});

	it("seasons start in July", () => {
		expect(seasonOf(Date.parse("2026-06-30T00:00:00Z"))).toBe("2025/26");
		expect(seasonOf(Date.parse("2026-07-01T00:00:00Z"))).toBe("2026/27");
	});
});

describe("countdown and title", () => {
	it("counts days, hours, minutes and seconds", () => {
		expect(countdown((6 * 86400 + 2 * 3600 + 57 * 60 + 13) * 1000)).toBe("6d 02:57:13");
		expect(countdown(59_000)).toBe("00:00:59");
		expect(countdown(0)).toBeNull();
	});
	it('is "Gaffer · GW8 · 6d", with "working" during a run', () => {
		const now = Date.parse("2026-10-17T12:00:00Z");
		const snapshot = { gw: { current: 7, next: 8, deadline: "2026-10-23T17:30:00Z" } } as never;
		expect(titleText({ fpl: { snapshot } }, now)).toBe("Gaffer · GW8 · 6d");
		expect(titleText({ fpl: { snapshot }, running: true }, now)).toBe("Gaffer · GW8 · 6d · working");
		expect(titleText({ fpl: { snapshot } }, Date.parse("2026-10-23T15:00:00Z"))).toBe("Gaffer · GW8 · 2h");
		expect(titleText({ fpl: {} }, now)).toBe("Gaffer");
	});
});

/** Test-only: a fixed cost per assistant message (the faux provider reports $0), as in extensions.test.ts. */
const costPerMessage = (usd: number) => (pi: ExtensionAPI) => {
	pi.on("message_end", (event) => {
		const m = event.message as { role: string; usage?: { cost: Record<string, number> } };
		if (m.role === "assistant" && m.usage) return { message: { ...m, usage: { ...m.usage, cost: { ...m.usage.cost, total: usd } } } as never };
	});
};

describe("status strip with the real extensions (FR-UI-05)", () => {
	let env: GafferTestEnv;
	beforeAll(async () => {
		env = await startEnv();
		// Three days before the fixtures' GW6 deadline, so the countdown runs (the eval runner's clock offset).
		process.env.GAFFER_CLOCK_OFFSET_MS = String(Date.parse(DEADLINE_GW6) - (3 * 24 + 1) * 3_600_000 - Date.now());
	}, 60_000);
	afterAll(async () => {
		delete process.env.GAFFER_CLOCK_OFFSET_MS;
		await env.stop();
	});

	it("shows the latest gaffer.snapshot's values and /usage's spend; ticks every second while idle; stops on session_shutdown", async () => {
		type Footer = { render(w: number): string[]; dispose(): void };
		const footers: Footer[] = [];
		const titles: string[] = [];
		let renders = 0;
		const tui = { requestRender: () => renders++ };
		const ui = {
			setFooter: (f: (tui: unknown, theme: unknown, data: unknown) => Footer) => footers.push(f(tui, plain, {})),
			setTitle: (t: string) => titles.push(t),
		};
		const g = await startGaffer(env, { ui, extra: [costPerMessage(0.0123)], responses: [fauxAssistantMessage(fauxToolCall("fpl_snapshot", {})), fauxAssistantMessage(fauxText("Here's your squad."))] });
		await g.session.prompt("/team 1");
		await g.session.prompt("How does my team look?");
		await g.session.prompt("/usage");
		const usage = g.notifications.at(-1)!.message;
		const footer = footers.at(-1)!;
		const [status, spend] = footer.render(100).map(strip);

		const snap = g.sessionEntries().filter((e) => e.customType === "gaffer.snapshot").at(-1).data;
		expect(status).toContain("Test XI");
		expect(status).toMatch(new RegExp(`GW${snap.gw.next} 3d 00:\\d\\d:\\d\\d`));
		expect(status).toContain(`FT ${snap.free_transfers}${snap.ft_source === "derived" ? " (derived)" : ""}`);
		expect(status).toContain(`bank £${snap.bank.toFixed(1)}m`);
		expect(snap.team_name).toBe("Test XI");
		const money = (re: RegExp, s: string) => re.exec(s)?.[1];
		expect(money(/^This session: .*?(\$\d+\.\d{4})$/m, usage)).toBeDefined();
		expect(money(/today (\$\d+\.\d{4})/, spend)).toBe(money(/^Today \(UTC [^)]+\): (\$\d+\.\d{4})/m, usage));
		expect(money(/session (\$\d+\.\d{4})/, spend)).toBe(money(/^This session: .*?(\$\d+\.\d{4})$/m, usage));
		expect(money(/session (\$\d+\.\d{4})/, spend)).toBe("$0.0246"); // two model calls
		expect(spend).toContain("of $5.00");
		expect(spend).toContain("faux-1");
		expect(`${status}\n${spend}`).not.toMatch(/\/work|tokens|↑|↓|\d+(\.\d+)?%/);
		expect(titles.at(-1)).toMatch(/^Gaffer · GW6 · 3d$/);

		// Idle: the countdown moves and the footer is redrawn every second.
		const before = renders;
		await new Promise((r) => setTimeout(r, 2200));
		expect(renders - before).toBeGreaterThanOrEqual(2);
		expect(strip(footer.render(100)[0])).not.toBe(status);

		// /new or a reconnect starts a new session: one timer at a time, and none after session_shutdown.
		await g.bind();
		expect(footers.length).toBe(2);
		const runner = (g.session as unknown as { extensionRunner: { emit(e: unknown): Promise<unknown> } }).extensionRunner;
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		const after = renders;
		await new Promise((r) => setTimeout(r, 1500));
		expect(renders).toBe(after);
		g.session.dispose();
	}, 60_000);
});

describe("the strip without a team or snapshot", () => {
	it("says how to start, and how to get a snapshot", () => {
		expect(strip(stripLines({ fpl: {} }, 100, plain)[0])).toBe(" No team yet: /team <id> to start");
		expect(strip(stripLines({ fpl: { teamId: 1, teamName: "Test XI" } }, 100, plain)[0])).toBe(" Test XI · no snapshot yet: /gw fetches one");
		const passed = { gw: { current: 8, next: 9, deadline: "2026-10-01T00:00:00Z" }, free_transfers: 1, ft_source: "user", bank: 0.5, stale: true } as never;
		expect(strip(stripLines({ fpl: { teamId: 1, teamName: "X", snapshot: passed } }, 100, plain)[0])).toBe(" X · GW9 deadline passed · FT 1 · bank £0.5m · data stale");
	});
});

describe("command allowlist (FR-UI-06)", () => {
	let provider: AutocompleteProvider;
	beforeAll(() => {
		const work = mkdtempSync(join(tmpdir(), "gaffer-ac-"));
		mkdirSync(join(work, "src"));
		writeFileSync(join(work, "src", "secret.txt"), "x");
		// Pi's own provider, as it builds it: every built-in, the hidden ones, Gaffer's templates and commands, a skill.
		const names = [...BUILTIN_SLASH_COMMANDS.map((c) => c.name), "mcp", "llama", "skill:gaffer-workflow", ...GAFFER_COMMANDS];
		provider = gafferAutocomplete(new CombinedAutocompleteProvider([...new Set(names)].map((name) => ({ name, description: name })), work, null));
	});
	const ask = (text: string, force = false) => provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal, force });

	it("typing / lists exactly Gaffer's twelve commands", async () => {
		const res = await ask("/");
		expect(res?.items.map((i) => i.value).sort()).toEqual([...GAFFER_COMMANDS].sort());
	});
	it.each(["/sh", "/mod", "/sk", "/mc", "/ll", "/model ", "/login ", "/skill:"])("%s suggests nothing", async (text) => {
		expect(await ask(text)).toBeNull();
	});
	it("@file and Tab path completion list nothing from the harness filesystem", async () => {
		expect(await ask("@")).toBeNull();
		expect(await ask("look at src/", true)).toBeNull();
		expect(provider.shouldTriggerFileCompletion?.(["src/"], 0, 4)).toBe(false);
		expect(provider.triggerCharacters).toEqual([]);
	});

	const submit = (text: string) => {
		const passed: string[] = [];
		const refused: string[] = [];
		guardSubmit((t) => passed.push(t), (m) => refused.push(m))(text);
		return { passed, refused };
	};
	// FR-UI-06's list, then every other Pi built-in and hidden command, typed in full.
	const LISTED = ["share", "login", "logout", "model", "thinking", "settings", "reload", "export", "import", "tree", "fork", "clone", "compact", "session", "bug", "mcp", "llama", "quit"];
	it.each([...LISTED, "skill:gaffer-workflow", "model claude-opus-4-8", "share --public"])("/%s is refused with one line and goes no further", (cmd) => {
		const r = submit(`/${cmd}`);
		expect(r.passed).toEqual([]);
		expect(r.refused).toEqual([refusal(commandName(`/${cmd}`)!)]);
		expect(r.refused[0]).toMatch(new RegExp(`^/${commandName(`/${cmd}`)} is not available in Gaffer: \\S`));
		expect(r.refused[0]).not.toContain("\n");
	});
	it("every Pi built-in not on the list is refused, and so is a command Pi might add later", () => {
		const others = [...BUILTIN_SLASH_COMMANDS.map((c) => c.name), ...HIDDEN, "agents", "share-v2"].filter((n) => !(GAFFER_COMMANDS as readonly string[]).includes(n));
		expect(others.length).toBeGreaterThanOrEqual(24);
		for (const n of others) expect(submit(`/${n}`).refused, n).toHaveLength(1);
	});
	it("Gaffer's commands, plain messages and a !command (blocked by user_bash) pass through", () => {
		for (const c of GAFFER_COMMANDS) expect(submit(`/${c} x`).passed).toEqual([`/${c} x`]);
		for (const t of ["What should I do this week?", "!ls", "  hello /share", "/ not a command"]) expect(submit(t).passed).toEqual([t]);
	});
	it("/share's refusal says why, and every refusal fits one line at 100 columns as Pi shows it", () => {
		expect(refusal("share")).toBe("/share is not available in Gaffer: sessions stay on this machine. Try /export-rec.");
		const skills = readdirSync(join(import.meta.dirname, "../skills")).map((d) => `skill:${d}`);
		for (const n of [...BUILTIN_SLASH_COMMANDS.map((c) => c.name), ...HIDDEN, ...skills]) expect(visibleWidth(` Warning: ${refusal(n)}`), n).toBeLessThanOrEqual(100);
	});
	it("/help covers every command on the list", () => {
		const help = helpLines().join("\n");
		for (const c of GAFFER_COMMANDS) expect(help).toContain(`/${c}`);
		for (const l of helpLines()) expect(visibleWidth(l), l).toBeLessThanOrEqual(96); // one line each at 100 columns
	});
});

afterEach(() => {
	delete process.env.GAFFER_BUDGET_DAILY;
});
