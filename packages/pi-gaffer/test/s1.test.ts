/**
 * Spike S1's eight checks, as tests against the real Gaffer extensions (NFR-MNT-02: these gate Pi upgrades).
 * See spikes/s1-extension-hooks/README.md.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GafferTestEnv, startEnv, startGaffer } from "./harness.ts";

let env: GafferTestEnv;
beforeAll(async () => {
	env = await startEnv();
});
afterAll(() => env.stop());

describe("S1 checks", () => {
	it("S1-1: an extension tool (fpl_snapshot) is registered and executes", async () => {
		const g = await startGaffer(env, { responses: [fauxAssistantMessage(fauxToolCall("fpl_snapshot", { team_id: 1 })), fauxAssistantMessage(fauxText("done"))] });
		await g.session.prompt("What's my squad? Team 1.");
		const r = g.toolResults.find((t) => t.name === "fpl_snapshot")!;
		expect(r.isError).toBe(false);
		expect(r.text).toContain("Bank: £0.5m");
		g.session.dispose();
	}, 30_000);

	it("S1-2: coding tools are removed; only Gaffer's allowlist is active", async () => {
		const g = await startGaffer(env, {
			responses: [fauxAssistantMessage(fauxToolCall("grep", { pattern: "x" })), fauxAssistantMessage(fauxToolCall("ls", {})), fauxAssistantMessage(fauxText("ok"))],
		});
		expect(g.session.getActiveToolNames().sort()).toEqual(["bash", "edit", "fpl_snapshot", "read", "write"]);
		await g.session.prompt("list files");
		expect(g.toolResults.map((t) => [t.name, t.isError])).toEqual([
			["grep", true],
			["ls", true],
		]);
		expect(g.toolResults[0].text).toMatch(/not found/i);
		g.session.dispose();
	});

	it("S1-3/8: the coding preamble is replaced, skills are kept, fpl_context and user_preferences are injected", async () => {
		const skills = mkdtempSync(join(tmpdir(), "gaffer-skills-"));
		mkdirSync(join(skills, "chip-strategy"));
		writeFileSync(join(skills, "chip-strategy", "SKILL.md"), "---\nname: chip-strategy\ndescription: When to play FPL chips.\n---\n# Chips\n");
		let sections: Record<string, string> = {};
		const g = await startGaffer(env, {
			skillsDir: skills,
			responses: [
				(ctx) => {
					sections = (ctx as unknown as { messages: { sections?: Record<string, string> }[] }).messages[0].sections ?? {};
					return fauxAssistantMessage(fauxText("hi"));
				},
			],
		});
		await g.session.prompt("/team 1");
		await g.session.prompt("hello");
		const names = Object.keys(sections);
		expect(sections.preamble).toMatch(/^You are Gaffer, a Fantasy Premier League/);
		expect(names).toContain("skills");
		expect(sections.skills).toContain("chip-strategy");
		expect(names).toEqual(expect.arrayContaining(["fpl_context", "user_preferences"]));
		expect(sections.fpl_context).toContain("team_id: 1 (Test XI)");
		for (const coding of ["tools", "rules", "docs", "context_files", "project_context"]) expect(names).not.toContain(coding);
		expect(JSON.stringify(sections)).not.toMatch(/coding assistant|expert coding/i);
		g.session.dispose();
	});

	it("S1-4: tool calls are policed — FPL account endpoints and /data writes are blocked with a reason", async () => {
		const g = await startGaffer(env, {
			responses: [
				fauxAssistantMessage(fauxToolCall("bash", { command: "curl -s https://fantasy.premierleague.com/api/my-team/1/" })),
				fauxAssistantMessage(fauxToolCall("write", { path: "/data/snapshots/evil.json", content: "{}" })),
				fauxAssistantMessage(fauxText("ok")),
			],
		});
		await g.session.prompt("try");
		expect(g.toolResults.map((t) => t.isError)).toEqual([true, true]);
		expect(g.toolResults[0].text).toMatch(/read-only/);
		expect(g.toolResults[1].text).toMatch(/read-only/);
		g.session.dispose();
	});

	it("S1-5: bash runs in the sandbox, not the harness, and never sees harness secrets", async () => {
		const g = await startGaffer(env, {
			responses: [fauxAssistantMessage(fauxToolCall("bash", { command: "pwd; env; python3 -c 'print(6*7)'" })), fauxAssistantMessage(fauxText("ok"))],
		});
		await g.session.prompt("run");
		const out = g.toolResults[0].text;
		expect(g.toolResults[0].isError).toBe(false);
		expect(out).toContain(env.sandboxWork); // sandboxd's work dir, not the harness cwd
		expect(out).toContain("42");
		expect(out).not.toContain("sk-ant-test-harness-secret");
		expect(out).not.toMatch(/ANTHROPIC|PI_SESSION|GAFFER_ID_SALT/);
		g.session.dispose();
	});

	it("S1-6: a terminating tool ends the run on a structured result with no extra LLM turn", async () => {
		const terminating = (pi: ExtensionAPI) =>
			pi.registerTool(
				defineTool({
					name: "submit_recommendation",
					label: "Submit (test double)",
					description: "Test double; the real tool lands in M4.",
					parameters: Type.Object({ captain: Type.String() }),
					async execute(_id, params) {
						return { content: [{ type: "text", text: "saved" }], details: params, terminate: true };
					},
				}),
			);
		const g = await startGaffer(env, {
			extra: [terminating],
			responses: [fauxAssistantMessage(fauxToolCall("submit_recommendation", { captain: "Haaland" })), fauxAssistantMessage(fauxText("SHOULD NOT BE REACHED"))],
		});
		await g.session.prompt("submit");
		expect(g.faux.state.callCount).toBe(1);
		expect(g.faux.getPendingResponseCount()).toBe(1);
		g.session.dispose();
	});

	it("S1-7: durable non-context records go into the session log as custom entries", async () => {
		const g = await startGaffer(env, { responses: [fauxAssistantMessage(fauxToolCall("fpl_snapshot", { team_id: 1 })), fauxAssistantMessage(fauxText("done"))] });
		await g.session.prompt("snapshot");
		const custom = g.sessionEntries().filter((e) => e.type === "custom" && e.customType === "gaffer.snapshot");
		expect(custom.length).toBeGreaterThanOrEqual(1);
		expect(custom.at(-1).data).toMatchObject({ team_id: 1, stale: false, snapshot_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
		g.session.dispose();
	}, 30_000);

	it("S1 gotcha: session_start (and so setActiveTools) only runs after bindExtensions", async () => {
		let starts = 0;
		const g = await startGaffer(env, { bind: false, extra: [(pi: ExtensionAPI) => pi.on("session_start", () => void starts++)], responses: [] });
		expect(starts).toBe(0);
		await g.bind();
		expect(starts).toBe(1);
		expect(g.session.getActiveToolNames()).not.toContain("grep");
		g.session.dispose();
	});
});
