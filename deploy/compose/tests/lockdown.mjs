// NFR-SEC-08 / ADR 0012, the CLI half (spike S3 row 15), run inside the harness container:
//   docker compose exec -T gaffer node --input-type=module - < tests/lockdown.mjs
// The image's own pi, agent settings and keybindings (a copy of /opt/pi-agent) and gaffer-pi's launch line,
// in RPC mode with a scripted faux model. A marker-writing MCP server is named in the agent's mcp.json and in a
// trusted project's .pi/mcp.json, whose settings also try `+builtin:mcp`. The model tries the MCP, codemode
// and tool_search routes. Passes when no server starts, no codemode, tool_search or mcp__* tool is
// registered or offered (the model sees exactly Gaffer's seven tools), no MCP section reaches the system
// prompt, and /mcp and /llama are absent from RPC get_commands. No key is used and nothing outside a
// temporary directory is written.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GAFFER_TOOLS = ["read", "write", "edit", "bash", "fpl_snapshot", "submit_recommendation", "set_preferences"];
const root = mkdtempSync(join(tmpdir(), "gaffer-lockdown-"));
const [agent, work, markers, sessions] = ["agent", "work", "markers", "sessions"].map((d) => join(root, d));
for (const d of [agent, join(work, ".pi"), markers, sessions, join(root, "data")]) mkdirSync(d, { recursive: true });

// The agent dir as built (settings.json names the package as ../pi-gaffer), plus the hostile mcp.json.
for (const f of readdirSync("/opt/pi-agent")) if (f.endsWith(".json") && f !== "mcp.json") cpSync(`/opt/pi-agent/${f}`, join(agent, f));
symlinkSync("/opt/pi-gaffer", join(root, "pi-gaffer"));
const server = join(root, "marker-server.mjs");
writeFileSync(server, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(markers)} + "/" + process.argv[2], JSON.stringify({ pid: process.pid, key: !!process.env.ANTHROPIC_API_KEY }));
process.stdin.resume();
`);
const srv = (name, exposure) => ({ command: process.execPath, args: [server, name], ...(exposure ? { exposure } : {}) });
writeFileSync(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { agent_default: srv("agent_default"), agent_direct: srv("agent_direct", "direct"), agent_deferred: srv("agent_deferred", "deferred") } }));
writeFileSync(join(work, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { project_direct: srv("project_direct", "direct") } }));
writeFileSync(join(work, ".pi", "settings.json"), JSON.stringify({ extensions: ["+builtin:mcp"] }));

// A scripted model that tries every route, and a report of what it was offered.
const report = join(root, "report.json");
const faux = join(root, "faux.ts");
writeFileSync(faux, `import { writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
const r = { offered: [], registered: [], results: [] };
const save = () => writeFileSync(${JSON.stringify(report)}, JSON.stringify(r));
const seen = (ctx) => { r.offered.push({ tools: getCurrentTools(ctx.messages).map((t) => t.name), mcp: /mcp/i.test(getCurrentSystemPrompt(ctx.messages)) }); save(); };
const steps = [["mcp__agent_direct__pwn", {}], ["mcp__project_direct__pwn", {}], ["codemode", { code: "return 1" }], ["tool_search", { query: "pwn" }]];
export default function (pi) {
  const f = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  f.setResponses([...steps.map(([n, a]) => (ctx) => { seen(ctx); return fauxAssistantMessage(fauxToolCall(n, a)); }), (ctx) => { seen(ctx); return fauxAssistantMessage(fauxText("done")); }]);
  pi.registerProvider(f.provider);
  pi.on("session_start", async () => { r.registered = pi.getAllTools().map((t) => t.name); save(); });
  pi.on("tool_execution_end", async (e) => { r.results.push({ tool: e.toolName, isError: e.isError }); save(); });
}
`);

// gaffer-pi's launch line, with this run's session dir, the project trusted (--approve, the worst case), RPC
// mode, and the faux model loaded with -e (an extension, like Gaffer's own).
const launcher = readFileSync("/opt/gaffer/gaffer-pi", "utf8").replace(/\\\n\s*/g, " ");
const line = /^set -- (.*)$/m.exec(launcher)[1].trim().split(/\s+/);
const args = [...line.map((a) => (a === "/sessions" ? sessions : a)), "--approve", "--mode", "rpc", "--provider", "faux", "--model", "faux-1", "-e", faux];
console.log(`pi ${args.join(" ").replaceAll(root, "$TMP")}`);
const pi = spawn("pi", args, {
	cwd: work,
	env: { ...process.env, PI_CODING_AGENT_DIR: agent, GAFFER_SESSIONS_ROOT: sessions, GAFFER_DATA_DIR: join(root, "data"), ANTHROPIC_API_KEY: "sk-ant-lockdown-dummy" },
	stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
pi.stderr.on("data", (d) => (stderr += d));
const send = (m) => pi.stdin.write(`${JSON.stringify(m)}\n`);
const running = () => readdirSync("/proc").filter((p) => /^\d+$/.test(p)).filter((p) => {
	try {
		return readFileSync(`/proc/${p}/cmdline`, "utf8").includes(server);
	} catch {
		return false;
	}
});

let commands;
const processes = new Set();
const done = new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error(`timed out; stderr:\n${stderr}`)), 90_000);
	let buf = "";
	pi.stdout.on("data", (d) => {
		buf += d;
		for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
			const m = JSON.parse(buf.slice(0, i));
			buf = buf.slice(i + 1);
			for (const p of running()) processes.add(p);
			if (m.type === "response" && m.command === "get_commands") {
				commands = (m.data?.commands ?? []).map((c) => c.name);
				send({ id: "go", type: "prompt", message: "go" });
			} else if (m.type === "response" && !m.success) reject(new Error(`${m.command}: ${m.error}`));
			else if (m.type === "agent_settled" || m.type === "agent_end") {
				clearTimeout(timer);
				resolve();
			}
		}
	});
	pi.on("exit", (code) => reject(new Error(`pi exited ${code} early; stderr:\n${stderr}`)));
});
send({ id: "cmds", type: "get_commands" });
await done;
await new Promise((r) => setTimeout(r, 1000)); // give a late spawn time to show
for (const p of running()) processes.add(p);
pi.removeAllListeners("exit");
pi.kill();

const rep = JSON.parse(readFileSync(report, "utf8"));
const builtin = (n) => /^(mcp__|codemode$|tool_search$)/.test(n);
let failed = 0;
function check(name, pass, evidence) {
	if (!pass) failed++;
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${evidence}`);
}
check("no MCP server started (agent mcp.json, trusted project mcp.json + +builtin:mcp)", readdirSync(markers).length === 0 && processes.size === 0, `markers: [${readdirSync(markers).join(", ")}], processes: ${processes.size}`);
check("no codemode, tool_search or mcp__* tool registered", rep.registered.length > 0 && !rep.registered.some(builtin), rep.registered.join(", "));
const offered = [...new Set(rep.offered.flatMap((o) => o.tools))].sort();
check("the model is offered exactly Gaffer's seven tools on every request", rep.offered.length === 5 && rep.offered.every((o) => o.tools.slice().sort().join() === [...GAFFER_TOOLS].sort().join()), `${rep.offered.length} requests; ${offered.join(", ")}`);
check("no MCP section in the system prompt", !rep.offered.some((o) => o.mcp), rep.offered.map((o) => o.mcp).join(", "));
check("every MCP, codemode and tool_search call failed", rep.results.length === 4 && rep.results.every((x) => x.isError), rep.results.map((x) => `${x.tool}:${x.isError ? "error" : "RAN"}`).join(", "));
check("/mcp and /llama are absent from RPC get_commands", Array.isArray(commands) && !commands.includes("mcp") && !commands.includes("llama") && commands.includes("team"), commands?.join(", "));
if (failed === 0) console.log("NFR-SEC-08 lockdown check passed");
process.exit(failed ? 1 : 0);
