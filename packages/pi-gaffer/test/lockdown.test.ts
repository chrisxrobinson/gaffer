/**
 * NFR-SEC-08 / ADR 0012, the SDK half (spike S3 rows S1-S2): an SDK host such as this harness and the eval
 * runner loads none of Pi's built-in extensions, so no MCP server starts, no codemode, tool_search or mcp__*
 * tool is registered, there is no /mcp or /llama, and the model is offered exactly Gaffer's seven tools,
 * even with a marker-writing MCP server in the agent's mcp.json. A Pi that moved built-ins into the SDK
 * would fail here. The CLI half, with the image's settings and launch line, is deploy/compose/tests/lockdown.mjs.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GAFFER_TOOLS } from "../src/config.ts";
import { type GafferTestEnv, startEnv, startGaffer } from "./harness.ts";

const BUILTIN = /^(mcp__|codemode$|tool_search$)/;

describe("Pi's built-ins stay off in SDK hosts (NFR-SEC-08, ADR 0012)", () => {
	let env: GafferTestEnv;
	const saved = process.env.PI_CODING_AGENT_DIR;
	let markers: string;
	beforeAll(async () => {
		env = await startEnv();
		// The MCP extension reads mcp.json from PI_CODING_AGENT_DIR (S3 finding 6): give it one to find.
		const agent = mkdtempSync(join(tmpdir(), "gaffer-mcp-agent-"));
		markers = join(agent, "markers");
		mkdirSync(markers);
		const server = join(agent, "marker-server.mjs");
		writeFileSync(server, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(markers, "spawned"))}, String(process.pid));\n`);
		writeFileSync(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { marker: { command: process.execPath, args: [server], exposure: "direct" } } }));
		process.env.PI_CODING_AGENT_DIR = agent;
	}, 60_000);
	afterAll(async () => {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
		await env.stop();
	});

	it("registers only Gaffer's tools, no /mcp or /llama, and offers the model exactly the seven", async () => {
		const seen: { registered: string[]; commands: string[] } = { registered: [], commands: [] };
		const probe = (pi: ExtensionAPI) => {
			pi.on("session_start", async () => {
				seen.registered = pi.getAllTools().map((t) => t.name);
				seen.commands = pi.getCommands().map((c) => c.name);
			});
		};
		const requests: TranscriptContext[] = [];
		const g = await startGaffer(env, {
			extra: [probe],
			responses: [
				(ctx: TranscriptContext) => {
					requests.push(structuredClone(ctx));
					return fauxAssistantMessage(fauxText("ok"));
				},
			],
		});
		await g.session.prompt("Which tools do you have?");
		g.session.dispose();

		expect(seen.registered.length).toBeGreaterThan(0);
		expect(seen.registered.filter((n) => BUILTIN.test(n))).toEqual([]);
		expect(seen.commands).not.toContain("mcp");
		expect(seen.commands).not.toContain("llama");
		expect(requests).toHaveLength(1);
		expect(getCurrentTools(requests[0].messages).map((t) => t.name).sort()).toEqual([...GAFFER_TOOLS].sort());
		expect(getCurrentSystemPrompt(requests[0].messages)).not.toMatch(/MCP servers/i);
		await new Promise((r) => setTimeout(r, 500)); // a server would have started by now
		expect(existsSync(markers) && readdirSync(markers)).toEqual([]);
	}, 60_000);
});
