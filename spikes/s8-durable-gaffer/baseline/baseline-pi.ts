// S8 baseline on Gaffer's pin (pi-coding-agent 0.87.1): kill the process in the middle of a tool call, reopen the
// session like `pi --continue`, and show what was kept and whether the run goes on by itself.
// `node baseline-pi.ts` (parent) spawns `node baseline-pi.ts child <dir> run|continue`.
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, defineTool, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

async function child(dir: string, mode: string) {
	const log = (l: string) => appendFileSync(join(dir, "effects.log"), `${process.pid} ${l}\n`);
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 10 }, () => (ctx: { messages: { role: string; toolName?: string; content?: unknown }[] }) => {
		const last = ctx.messages.at(-1);
		log(`model sees last=${last?.role}${last?.toolName ? `:${last.toolName}` : ""} ${JSON.stringify(last?.content ?? "").slice(0, 80)}`);
		if (last?.role === "user") return fauxAssistantMessage(fauxToolCall("golden_path", {}), { stopReason: "toolUse" });
		return fauxAssistantMessage(fauxText("Done."));
	}));
	const golden = defineTool({
		name: "golden_path",
		label: "golden",
		description: "Run the slow golden path in the sandbox",
		parameters: Type.Object({}),
		async execute(id) {
			log(`start golden_path ${id}`);
			for (let n = 1; n <= 6; n++) {
				await new Promise((r) => setTimeout(r, 150));
				if (mode === "run" && n === 3) process.kill(process.pid, "SIGKILL");
			}
			log(`end golden_path ${id}`);
			return { content: [{ type: "text", text: "plan written" }], details: {} };
		},
	});
	const cwd = dir;
	const agentDir = join(dir, "agent");
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, extensionFactories: [(pi: any) => { pi.registerProvider(faux.provider); pi.registerTool(golden); }] } as any);
	await loader.reload();
	const sessions = join(dir, "sessions");
	const sessionManager = mode === "run" ? SessionManager.create(cwd, sessions) : SessionManager.continueRecent(cwd, sessions);
	const { session } = await createAgentSession({ cwd, agentDir, model: faux.getModel() as any, resourceLoader: loader, sessionManager, settingsManager });
	await session.bindExtensions({} as any);
	if (mode === "run") await session.prompt("/gw");
	else {
		const roles = sessionManager.getEntries().map((e: any) => (e.type === "message" ? `message:${e.message.role}` : e.type));
		console.log(`after reopen (pi --continue), entries: ${JSON.stringify(roles)}; isStreaming=${session.isStreaming}`);
		await new Promise((r) => setTimeout(r, 1500));
		console.log(`1.5 s later, nothing ran by itself: model calls=${faux.state.callCount}`);
		await session.prompt("continue");
		console.log(`after the user types "continue": model calls=${faux.state.callCount}`);
	}
	session.dispose();
}

function run(dir: string, mode: string) {
	return new Promise<string>((resolve) => {
		const p = spawn(process.execPath, [import.meta.filename, "child", dir, mode]);
		let out = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => process.stderr.write(d));
		p.on("exit", (code, signal) => resolve(`${out}[exit ${code ?? signal}]`));
	});
}

if (process.argv[2] === "child") await child(process.argv[3]!, process.argv[4]!);
else {
	const dir = mkdtempSync(join(tmpdir(), "s8-baseline-"));
	console.log("first process:", await run(dir, "run"));
	const file = readdirSync(join(dir, "sessions"), { recursive: true }).find((f) => String(f).endsWith(".jsonl"));
	const lines = readFileSync(join(dir, "sessions", String(file)), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	console.log("JSONL after the kill:", lines.map((j) => (j.type === "message" ? `message:${j.message.role}${j.message.stopReason ? `(${j.message.stopReason})` : ""}` : j.type)));
	console.log("second process:", await run(dir, "continue"));
	console.log("effects.log:", readFileSync(join(dir, "effects.log"), "utf8").trim().split("\n"));
}
