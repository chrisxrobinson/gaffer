/**
 * S7 driver: spawn `pi --mode rpc` (1.3.0, from this dir's node_modules) with the faux model and the
 * Gaffer-shaped stub, speak raw JSONL on stdio, and record every record both ways to events.jsonl.
 *
 *   node run-spike.ts            # writes events.jsonl and summary.json next to this file
 *
 * Phases: A = Gaffer-like flags (no built-in extensions, user_bash blocked); B = user_bash handler
 * off (what RPC `bash` does without it); C = built-in extensions left on (what get_commands lists).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

const HERE = import.meta.dirname;
const CLI = join(HERE, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const W = process.env.S7_WORK ?? mkdtempSync(join(tmpdir(), "s7-"));
const AGENT_DIR = join(W, "agent");
const SESSIONS = join(W, "sessions");
for (const d of [AGENT_DIR, SESSIONS, join(W, "escape"), join(W, "elsewhere")]) mkdirSync(d, { recursive: true });

const t0 = Date.now();
const log: string[] = [];
const REPO = join(HERE, "..", "..");
const USER = userInfo().username;
// Keep the log free of local paths and the account name ($W = scratch dir, $REPO = repo root).
const scrub = (s: string) => s.split(W).join("$W").split(REPO).join("$REPO").split(USER).join("$USER");
const record = (phase: string, dir: "in" | "out" | "stderr", rec: unknown) => log.push(scrub(JSON.stringify({ t: Date.now() - t0, phase, dir, rec })));

class Pi {
	proc: ChildProcess;
	listeners: ((r: any) => void)[] = [];
	pending = new Map<string, (r: any) => void>();
	n = 0;
	phase: string;
	constructor(phase: string, args: string[], env: Record<string, string> = {}) {
		this.phase = phase;
		this.proc = spawn(process.execPath, [CLI, "--mode", "rpc", ...args], {
			cwd: W,
			env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let buf = "";
		this.proc.stdout!.setEncoding("utf8");
		this.proc.stdout!.on("data", (chunk: string) => {
			buf += chunk;
			let i: number;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i).replace(/\r$/, "");
				buf = buf.slice(i + 1);
				if (!line) continue;
				const rec = JSON.parse(line);
				record(phase, "out", rec);
				if (rec.type === "response" && rec.id && this.pending.has(rec.id)) {
					this.pending.get(rec.id)!(rec);
					this.pending.delete(rec.id);
				}
				// Answer dialogs as a UI would (S7: pick "balanced").
				if (rec.type === "extension_ui_request" && rec.method === "select") this.write({ type: "extension_ui_response", id: rec.id, value: "balanced" });
				for (const l of [...this.listeners]) l(rec);
			}
		});
		this.proc.stderr!.setEncoding("utf8");
		this.proc.stderr!.on("data", (d: string) => record(phase, "stderr", d));
	}
	write(obj: object) {
		record(this.phase, "in", obj);
		this.proc.stdin!.write(`${JSON.stringify(obj)}\n`);
	}
	send(cmd: Record<string, unknown>): Promise<any> {
		const id = `${this.phase}-${++this.n}`;
		return new Promise((resolve) => {
			this.pending.set(id, resolve);
			this.write({ id, ...cmd });
		});
	}
	waitFor(pred: (r: any) => boolean, ms = 30000): Promise<any> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timeout waiting in phase ${this.phase}`)), ms);
			const l = (r: any) => {
				if (pred(r)) {
					clearTimeout(timer);
					this.listeners = this.listeners.filter((x) => x !== l);
					resolve(r);
				}
			};
			this.listeners.push(l);
		});
	}
	/** Prompt and, if a run started, wait for agent_settled. */
	async run(message: string, during?: () => Promise<void>) {
		const settled = this.waitFor((r) => r.type === "agent_settled");
		const res = await this.send({ type: "prompt", message });
		if (res.success && res.data?.disposition === "started") {
			if (during) await during();
			await settled;
		}
		return res;
	}
	async stop() {
		this.proc.stdin!.end();
		await new Promise((r) => this.proc.once("exit", r));
	}
}

const common = ["--provider", "faux", "--model", "faux-1", "--thinking", "medium", "--session-dir", SESSIONS, "--no-context-files", "--no-skills", "--no-prompt-templates", "--offline"];
const stubs = ["-e", join(HERE, "faux-model.ts"), "-e", join(HERE, "stub-gaffer.ts")];
const gafferTools = ["--tools", "read,write,edit,bash,fpl_snapshot,submit_recommendation"];
const notes: Record<string, unknown> = {};

// ---------------------------------------------------------------- Phase A: Gaffer-like
{
	const pi = new Pi("A", ["--no-extensions", ...stubs, ...gafferTools, ...common]);
	await new Promise((r) => setTimeout(r, 300));
	notes.state0 = (await pi.send({ type: "get_state" })).data;
	notes.commandsA = (await pi.send({ type: "get_commands" })).data?.commands?.map((c: any) => `${c.source}:${c.name}`);
	notes.team = await pi.run("/team 1234567");
	notes.pick = await pi.run("/pick");
	notes.recommend = await pi.run("Recommend this GW for team 1234567. Risk: balanced. Save: wildcard.", async () => {
		await pi.waitFor((r) => r.type === "tool_execution_start");
		notes.midRunState = (await pi.send({ type: "get_state" })).data;
		notes.midRunPromptNoBehaviour = await pi.send({ type: "prompt", message: "also check Palmer" });
		notes.midRunSteer = await pi.send({ type: "steer", message: "[steer] Keep Salah, please." });
	});
	// Reconnect: what a fresh client can rebuild from.
	notes.reconnect = {
		state: (await pi.send({ type: "get_state" })).data,
		messages: (await pi.send({ type: "get_messages" })).data?.messages?.map((m: any) => m.role + (m.customType ? `:${m.customType}` : "") + (m.toolName ? `:${m.toolName}` : "")),
		entries: (await pi.send({ type: "get_entries" })).data?.entries?.map((e: any) => e.type + (e.customType ? `:${e.customType}` : "") + (e.message ? `:${e.message.role}` : "")),
		stats: (await pi.send({ type: "get_session_stats" })).data,
		lastText: (await pi.send({ type: "get_last_assistant_text" })).data,
	};
	notes.followUp = await pi.run("Why is Salah captain rather than Palmer?");
	// Structured start through an extension command that starts the run itself.
	{
		const settled = pi.waitFor((r) => r.type === "agent_settled");
		notes.structuredStart = await pi.send({ type: "prompt", message: '/run {"action":"recommend","team_id":1234567,"risk":"aggressive"}' });
		notes.structuredStartSettled = await settled;
	}
	// Stop button: abort mid-run.
	{
		const settled = pi.waitFor((r) => r.type === "agent_settled");
		await pi.send({ type: "prompt", message: "Recommend this GW for team 1234567 (to be aborted)." });
		await pi.waitFor((r) => r.type === "tool_execution_start");
		notes.abort = await pi.send({ type: "abort" });
		notes.abortSettled = await settled;
		notes.afterAbortState = (await pi.send({ type: "get_state" })).data?.isStreaming;
	}
	notes.bangPrompt = await pi.run("!echo S7-BANG-IN-PROMPT");
	notes.builtinSlashPrompt = await pi.run(`/export ${join(W, "escape", "via-slash.html")}`);
	notes.unknownSlash = await pi.run("/share");
	// Dangerous commands
	notes.bashBlocked = await pi.send({ type: "bash", command: "echo S7-RPC-BASH-RAN; id -un" });
	notes.exportHtml = await pi.send({ type: "export_html", outputPath: join(W, "escape", "exported.html") });
	notes.exportHtmlWritten = existsSync(join(W, "escape", "exported.html"));
	notes.exportViaSlashWritten = existsSync(join(W, "escape", "via-slash.html"));
	// A crafted "session" elsewhere: switch_session loads it, header cwd and all.
	const crafted = join(W, "elsewhere", "crafted.jsonl");
	writeFileSync(
		crafted,
		[
			{ type: "session", version: 3, id: "crafted", timestamp: new Date().toISOString(), cwd: join(W, "elsewhere") },
			{ type: "message", id: "c1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "INJECTED HISTORY from a file outside --session-dir" }], timestamp: Date.now() } },
		]
			.map((x) => JSON.stringify(x))
			.join("\n") + "\n",
	);
	notes.switchCrafted = await pi.send({ type: "switch_session", sessionPath: crafted });
	notes.afterSwitchCrafted = { state: (await pi.send({ type: "get_state" })).data, messages: (await pi.send({ type: "get_messages" })).data?.messages?.length };
	notes.switchNonSession = await pi.send({ type: "switch_session", sessionPath: join(W, "escape", "exported.html") });
	const fresh = join(W, "escape", "new-file.jsonl");
	notes.switchNonexistent = await pi.send({ type: "switch_session", sessionPath: fresh });
	await pi.run("Recommend again please, team 1234567");
	notes.nonexistentNowWritten = existsSync(fresh) ? readFileSync(fresh, "utf8").split("\n").length - 1 : false;
	notes.newSessionParent = await pi.send({ type: "new_session", parentSession: "/etc/passwd" });
	notes.newSessionState = (await pi.send({ type: "get_state" })).data;
	notes.setModelUnknown = await pi.send({ type: "set_model", provider: "anthropic", modelId: "claude-opus-5-5" });
	await pi.stop();
}

// ---------------------------------------------------------------- Phase B: no user_bash handler
{
	const pi = new Pi("B", ["--no-extensions", ...stubs, ...gafferTools, ...common], { S7_BLOCK_USER_BASH: "0" });
	await new Promise((r) => setTimeout(r, 300));
	notes.bashUnblocked = await pi.send({ type: "bash", command: "echo S7-RPC-BASH-RAN; id -un; pwd" });
	notes.bashUnblockedMessages = (await pi.send({ type: "get_messages" })).data?.messages?.map((m: any) => m.role);
	await pi.stop();
}

// ---------------------------------------------------------------- Phase C: built-in extensions on
{
	const pi = new Pi("C", [...stubs, ...common]);
	await new Promise((r) => setTimeout(r, 300));
	notes.commandsC = (await pi.send({ type: "get_commands" })).data?.commands?.map((c: any) => `${c.source}:${c.name}`);
	notes.mcpCommand = await pi.run("/mcp");
	await pi.stop();
}

writeFileSync(join(HERE, "events.jsonl"), `${log.join("\n")}\n`);

// ---------------------------------------------------------------- Summary
const recs = log.map((l) => JSON.parse(l));
const out = recs.filter((r) => r.dir === "out").map((r) => ({ phase: r.phase, ...r.rec }));
const count = (xs: string[]) => xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {});
const summary = {
	work: "$W",
	eventTypes: count(out.filter((r) => r.type !== "response").map((r) => r.type)),
	assistantMessageEvents: count(out.filter((r) => r.type === "message_update").map((r) => r.assistantMessageEvent.type)),
	messageStartRoles: count(out.filter((r) => r.type === "message_start").map((r) => r.message.role + (r.message.customType ? `:${r.message.customType}` : ""))),
	extensionUi: count(out.filter((r) => r.type === "extension_ui_request").map((r) => r.method)),
	entryAppended: count(out.filter((r) => r.type === "entry_appended").map((r) => r.entry.customType)),
	toolUpdates: count(out.filter((r) => r.type === "tool_execution_update").map((r) => r.toolName)),
	toolEnds: out.filter((r) => r.type === "tool_execution_end").map((r) => ({ tool: r.toolName, isError: r.isError, durationMs: r.durationMs, detailsKeys: r.result?.details ? Object.keys(r.result.details) : null })),
	responses: out.filter((r) => r.type === "response").map((r) => `${r.phase}:${r.command}:${r.success ? (r.data?.disposition ?? "ok") : `ERR ${r.error}`}`),
	notes,
};
writeFileSync(join(HERE, "summary.json"), `${scrub(JSON.stringify(summary, null, 1))}\n`);
console.log(scrub(JSON.stringify(summary, null, 1)).slice(0, 20000));
process.exit(0);
