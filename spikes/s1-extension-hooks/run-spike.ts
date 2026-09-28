import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
import gaffer, { log } from "./gaffer-spike-extension.ts";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } }] });
let seenSystemPrompt = "";
faux.setResponses([
	(ctx) => { const m0 = (ctx as any).messages?.[0]; seenSystemPrompt = JSON.stringify(m0?.sections ? Object.fromEntries(Object.entries(m0.sections).map(([k, v]) => [k, String(v).slice(0, 90)])) : m0?.content); return fauxAssistantMessage(fauxToolCall("fpl_fetch", { path: "bootstrap-static/" })); },
	fauxAssistantMessage(fauxToolCall("fpl_fetch", { path: "my-team/123/" })),
	fauxAssistantMessage(fauxToolCall("bash", { command: "hostname; python3 -c 'print(2+2)'" })),
	fauxAssistantMessage(fauxToolCall("edit", { path: "x", edits: [] })),
	fauxAssistantMessage(fauxToolCall("submit_recommendation", { captain: "Haaland" })),
	fauxAssistantMessage(fauxText("SHOULD NOT BE REACHED (terminate:true)")),
]);

const agentDir = mkdtempSync(join(tmpdir(), "gaffer-spike-"));
const cwd = process.cwd();
const settingsManager = SettingsManager.create(cwd, agentDir);
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [(pi) => { pi.registerProvider(faux.provider as any); gaffer(pi); }] as any, noExtensions: true, additionalSkillPaths: [join(cwd, "skills")] } as any);
await loader.reload();
const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"));
const { session } = await createAgentSession({ cwd, agentDir, model: faux.getModel() as any, resourceLoader: loader, sessionManager, settingsManager });
await session.bindExtensions({} as any); // SDK hosts must bind extensions to fire session_start (CLI modes do this)
const toolEvents: string[] = [];
session.subscribe((e: any) => { if (e.type === "tool_execution_end") toolEvents.push(`${e.toolName}:${e.isError ? "ERR" : "ok"}:${JSON.stringify(e.result?.content?.[0]?.text ?? "").slice(0, 120)}`); });
await session.prompt("Recommend my captain. Team 123.");
console.log("ACTIVE TOOLS:", session.getActiveToolNames());
console.log("SYSTEM PROMPT (session):", JSON.stringify(session.systemPrompt));
console.log("SYSTEM PROMPT (seen by model):", JSON.stringify(seenSystemPrompt).slice(0, 1500));
console.log("EXT LOG:", log);
console.log("TOOL RESULTS:\n " + toolEvents.join("\n "));
console.log("FAUX CALLS:", faux.state.callCount, "pending:", faux.getPendingResponseCount());
const dir = join(agentDir, "sessions"); const files = readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl"));
console.log("SESSION FILES:", files);
for (const f of files) for (const line of readFileSync(join(dir, String(f)), "utf8").trim().split("\n")) { const j = JSON.parse(line); console.log("  entry:", j.type, j.customType ?? "", j.message?.role ?? "", j.message?.usage ? JSON.stringify(j.message.usage).slice(0, 160) : ""); }
session.dispose();
