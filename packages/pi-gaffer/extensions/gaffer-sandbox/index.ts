/**
 * gaffer-sandbox: Pi's bash/read/write/edit, re-registered to run in the no-network sandbox (ADR 0001).
 * Same-name registration overrides the built-ins; the harness env is never passed through. The golden path's
 * bash result is tagged for the Gaffer App (plan-step.ts).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { SANDBOX_CWD, sessionsRoot } from "../../src/config.ts";
import { processRunLock, uiName } from "../../src/lock.ts";
import { goldenPathOut, PROGRESS_PREFIX, type PlanStep, planStep, stripProgress } from "../../src/plan-step.ts";
import { createSandboxOperations, sandboxReadFile, sharedSandboxSession } from "../../src/sandbox.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export default function gafferSandbox(pi: ExtensionAPI) {
	const session = sharedSandboxSession();
	// Skills live in the harness; Pi's skill loading reads them with `read`, so serve that dir locally.
	const ops = createSandboxOperations(session, { localReadRoots: [join(PACKAGE_ROOT, "skills")] });

	pi.registerTool(createBashToolDefinition(SANDBOX_CWD, { operations: ops.bash, exposeSessionEnvironment: false }));
	pi.registerTool(createReadToolDefinition(SANDBOX_CWD, { operations: ops.read }));
	pi.registerTool(createWriteToolDefinition(SANDBOX_CWD, { operations: ops.write }));
	pi.registerTool(createEditToolDefinition(SANDBOX_CWD, { operations: ops.edit }));

	// /work is shared by every Pi process in the harness: it is cleared only under the run lock (locks.ts).
	pi.on("session_start", async (_event, ctx) => {
		session.runLock = processRunLock(sessionsRoot(ctx.sessionManager.getSessionDir()), uiName(ctx));
	});

	pi.on("session_shutdown", async () => {
		await session.release();
	});

	// The golden-path step for the Gaffer App (plan-step.ts): its plan's summary in `details`, and the progress
	// lines out of what the model reads (and structuredContent with it, which Pi drops if content alone changes).
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "bash") return;
		const texts = event.content.map((c) => (c.type === "text" ? c.text : ""));
		const progress = texts.some((t) => t.includes(PROGRESS_PREFIX));
		const out = goldenPathOut(String(event.input.command ?? ""));
		if (!progress && !out) return;
		const content = event.content.map((c) => (c.type === "text" ? { ...c, text: stripProgress(c.text) } : c));
		const sc = event.structuredContent as { output?: unknown } | undefined;
		const structuredContent = sc && typeof sc.output === "string" ? { ...sc, output: stripProgress(sc.output) } : event.structuredContent;
		let step: PlanStep | { step: "plan"; file: string; error: string } | undefined;
		if (out) {
			try {
				step = planStep(out, JSON.parse(await sandboxReadFile(session, out))) ?? { step: "plan", file: out, error: "not a gaffer.plan/1 file" };
			} catch (e) {
				step = { step: "plan", file: out, error: (e as Error).message.split("\n")[0] };
			}
		}
		return { content, structuredContent, details: step ? { ...(event.details ?? {}), ...step } : event.details };
	});
}
