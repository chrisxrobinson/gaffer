/**
 * gaffer-sandbox: Pi's bash/read/write/edit, re-registered to run in the no-network sandbox (ADR 0001).
 * Same-name registration overrides the built-ins; the harness env is never passed through.
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
import { SANDBOX_CWD } from "../../src/config.ts";
import { createSandboxOperations, providerFromEnv, SandboxSession } from "../../src/sandbox.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export default function gafferSandbox(pi: ExtensionAPI) {
	const session = new SandboxSession(providerFromEnv());
	// Skills live in the harness; Pi's skill loading reads them with `read`, so serve that dir locally.
	const ops = createSandboxOperations(session, { localReadRoots: [join(PACKAGE_ROOT, "skills")] });

	pi.registerTool(createBashToolDefinition(SANDBOX_CWD, { operations: ops.bash, exposeSessionEnvironment: false }));
	pi.registerTool(createReadToolDefinition(SANDBOX_CWD, { operations: ops.read }));
	pi.registerTool(createWriteToolDefinition(SANDBOX_CWD, { operations: ops.write }));
	pi.registerTool(createEditToolDefinition(SANDBOX_CWD, { operations: ops.edit }));

	pi.on("session_shutdown", async () => {
		await session.release();
	});
}
