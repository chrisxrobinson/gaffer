/**
 * Spike S1: can a Pi extension turn Pi into a domain agent without touching core?
 * Proves: (1) custom tool registration, (2) restricting the active tool set,
 * (3) whole system-prompt replacement, (4) tool_call interception/blocking,
 * (5) redirecting the built-in bash tool into a separate Docker container ("hands"),
 * (6) terminate:true structured final answer, (7) appendEntry for durable non-context data.
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SANDBOX = process.env.GAFFER_SANDBOX ?? "gaffer-spike-sandbox";
export const log: string[] = [];

export default function gaffer(pi: ExtensionAPI) {
	// (5) bash runs inside the sandbox container via docker exec, not on the harness host.
	const bash = createBashToolDefinition(process.cwd(), {
		operations: {
			exec: (command, _cwd, { onData, signal }) =>
				new Promise((resolve, reject) => {
					const child = spawn("docker", ["exec", SANDBOX, "sh", "-c", command], { signal });
					child.stdout.on("data", onData);
					child.stderr.on("data", onData);
					child.on("error", reject);
					child.on("close", (code) => resolve({ exitCode: code }));
				}),
		},
	});
	pi.registerTool(bash);

	// (1) a domain tool
	pi.registerTool(
		defineTool({
			name: "fpl_fetch",
			label: "FPL fetch",
			description: "Fetch an FPL API resource (stub for spike).",
			parameters: Type.Object({ path: Type.String() }),
			async execute(_id, params) {
				log.push(`fpl_fetch:${params.path}`);
				return { content: [{ type: "text", text: `{"stub":"${params.path}"}` }], details: undefined };
			},
		}),
	);

	// (6) terminating structured answer
	pi.registerTool(
		defineTool({
			name: "submit_recommendation",
			label: "Submit recommendation",
			description: "Final structured recommendation.",
			parameters: Type.Object({ captain: Type.String() }),
			async execute(_id, params) {
				pi.appendEntry("gaffer.recommendation", params); // (7)
				return { content: [{ type: "text", text: "saved" }], details: params, terminate: true };
			},
		}),
	);

	pi.on("session_start", async () => {
		// (2) drop edit/write etc.; only what Gaffer needs
		pi.setActiveTools(["bash", "read", "fpl_fetch", "submit_recommendation"]);
		log.push(`active:${pi.getActiveTools().join(",")}`);
	});

	// (3) replace system prompt
	pi.on("before_agent_start", async (event) => {
		if (process.env.SPIKE_FULL_REPLACE) return { systemPrompt: "You are Gaffer, an FPL advisor." };
		// Preferred: replace only the preamble; Pi still appends skills + cwd + custom sections
		event.systemPromptOptions.customPrompt = "You are Gaffer, an FPL advisor.";
		event.systemPromptOptions.contextFiles = [];
		event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, user_preferences: "risk: balanced" };
	});

	// (4) block anything that tries to reach the FPL login/write endpoints
	pi.on("tool_call", async (event) => {
		log.push(`tool_call:${event.toolName}`);
		if (event.toolName === "fpl_fetch" && String((event.input as any).path).includes("my-team")) {
			return { block: true, reason: "Gaffer is read-only; authenticated endpoints are blocked." };
		}
	});
}
