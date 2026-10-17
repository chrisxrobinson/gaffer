// Spike S8 driver. `node run-spike.ts` runs every scenario; `node run-spike.ts child <mode> <dir>` is internal.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { type AgentEvent, type Conversation, type EntryRecord, LiveDoc, ToolResultEntry, watchEvents } from "@earendil-works/pi-durable";
import { effects, openGaffer, PrefsDoc, RecommendationDoc, SnapshotDoc } from "./gaffer-durable.ts";
import { scriptedModel } from "./scripted-model.ts";

const GW = { type: "input", content: "/gw What should I do this week?", requestId: "gw-1" } as const;
const out = (label: string, value: unknown) => console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);

async function transcript(c: Conversation) {
	const page = await c.entries({}, 200, undefined, ctx);
	return [...page.items].reverse().map((e: EntryRecord) => {
		const m = e.model?.[0];
		if (m?.role === "assistant") {
			const a = m as AssistantMessage;
			const calls = a.content.filter((x) => x.type === "toolCall").map((x) => (x.type === "toolCall" ? x.name : ""));
			return `${e.id}:${e.kind}(${a.stopReason}${calls.length ? ` ${calls.join(",")}` : ""})`;
		}
		if (m?.role === "toolResult") {
			const r = m as ToolResultMessage;
			const t = r.content.map((x) => (x.type === "text" ? x.text : "")).join("").replace(/\s+/g, " ");
			return `${e.id}:${e.kind}(${r.toolName}${r.isError ? " ERROR" : ""}: ${t.slice(0, r.isError ? 220 : 60)})`;
		}
		return `${e.id}:${e.kind}`;
	});
}

// ─── child process: run (optionally crash) or resume one storage ─────────────────────────────────
async function child(mode: string, dir: string) {
	const crash = process.env.S8_CRASH; // "bash" | "model" | undefined
	const marker = join(dir, "crashed");
	const die = () => {
		writeFileSync(marker, String(process.pid));
		process.kill(process.pid, "SIGKILL");
	};
	const armed = mode === "run" && crash !== undefined && !existsSync(marker);
	const { harness, root } = await openGaffer(
		join(dir, "gaffer.sqlite"),
		{
			log: effects(dir),
			bashReplay: (process.env.S8_BASH_REPLAY as "safe" | "unsafe") ?? "unsafe",
			// Crash in the middle of the golden-path run, after 3 of its 8 output lines (and their progress commits).
			sandbox: { onLine: (n) => armed && crash === "bash" && n === 3 && setTimeout(die, 150) },
			tokensPerSecond: crash === "model" ? 300 : Number(process.env.S8_TPS ?? 0) || undefined,
			responses: Array.from({ length: 50 }, () =>
				scriptedModel({
					longThinking: crash === "model" ? 60 : 1,
					beforeLongStream: () => armed && crash === "model" && setTimeout(die, 700),
				}),
			),
		},
		ctx,
	);
	harness.resume();
	const started = Date.now();
	const submission = await root.submit(GW, ctx); // same requestId after a restart: the same submission
	const settled = await submission.wait(ctx);
	out("settled", { status: settled.status, ms: Date.now() - started, ...(settled.status === "unanswered" ? { reason: settled.reason } : {}) });
	out("transcript", await transcript(root));
	out("recommendation", await harness.snapshot(RecommendationDoc, root.id, ctx));
	out("usage", await harness.usage(ctx));
	await harness.close(ctx);
}

function spawnChild(mode: string, dir: string, env: Record<string, string>) {
	return new Promise<{ code: number | null; signal: string | null; stdout: string }>((resolve) => {
		const p = spawn(process.execPath, [import.meta.filename, "child", mode, dir], { env: { ...process.env, ...env } });
		let stdout = "";
		p.stdout.on("data", (d) => (stdout += d));
		p.stderr.on("data", (d) => process.stderr.write(d));
		p.on("exit", (code, signal) => resolve({ code, signal, stdout }));
	});
}

async function crashScenario(name: string, env: Record<string, string>) {
	const dir = mkdtempSync(join(tmpdir(), `s8-${name}-`));
	console.log(`\n=== ${name} (${JSON.stringify(env)}) dir=${dir}`);
	const first = await spawnChild("run", dir, env);
	out("first process", { exit: first.code, signal: first.signal, printed: first.stdout.trim() || "(nothing: killed before the run settled)" });
	const second = await spawnChild("resume", dir, { S8_BASH_REPLAY: env.S8_BASH_REPLAY ?? "unsafe" });
	process.stdout.write(second.stdout);
	out("effects.log", readFileSync(join(dir, "effects.log"), "utf8").trim().split("\n"));
}

// ─── in-process: complete run with two watchers, then a what-if fork ─────────────────────────────
async function completeRunAndFork() {
	const dir = mkdtempSync(join(tmpdir(), "s8-complete-"));
	console.log(`\n=== complete run + watchers + fork, dir=${dir}`);
	const { harness, root } = await openGaffer(
		join(dir, "gaffer.sqlite"),
		{ log: effects(dir), bashReplay: "unsafe", sandbox: {}, tokensPerSecond: 400, responses: Array.from({ length: 50 }, () => scriptedModel({ longThinking: 30 })) },
		ctx,
	);
	await harness.commit(async (tx) => Object.assign(await tx.doc(PrefsDoc), { risk: "aggressive", keep: [154] }), ctx);

	// Client 1 (structured UI): agent events, attached before the run.
	const tally: Record<string, number> = {};
	const sequence: string[] = [];
	const deltas = { thinking: 0, text: 0, toolcall: 0 };
	const events = await watchEvents(harness, root.id, ctx);
	out("client1 snapshot keys", Object.keys(events.snapshot));
	events.start(async (batch: readonly AgentEvent[]) => {
		for (const e of batch) {
			tally[e.type] = (tally[e.type] ?? 0) + 1;
			if (e.type === "message_update") for (const c of e.changes) {
				if (c.type === "thinking_delta") deltas.thinking++;
				if (c.type === "text_delta") deltas.text++;
				if (c.type === "toolcall_delta") deltas.toolcall++;
			}
			if (e.type.startsWith("tool_execution") && e.type !== "tool_execution_update") sequence.push(`${e.type}:${"toolName" in e ? e.toolName : ""}`);
			if (e.type === "run_start" || e.type === "run_end") sequence.push(e.type);
		}
	});
	// Client 2 (another UI): raw view ops via watch(), attached before the run too.
	const watch = await root.watch(ctx);
	let frames = 0;
	let opsCount = 0;
	watch.start(async (_v, ops) => {
		frames++;
		opsCount += ops.length;
	});

	const started = Date.now();
	const submission = await root.submit(GW, ctx);
	// Client 3: a late join while the golden-path bash runs.
	await new Promise((r) => setTimeout(r, 1500));
	const late = await watchEvents(harness, root.id, ctx);
	const lateTools = late.snapshot.tools.map((t) => `${t.name}:${t.status}`);
	const lateTypes: Record<string, number> = {};
	late.start(async (batch) => {
		for (const e of batch) lateTypes[e.type] = (lateTypes[e.type] ?? 0) + 1;
	});

	const settled = await submission.wait(ctx);
	await harness.waitForIdle(ctx);
	await new Promise((r) => setTimeout(r, 20));
	out("settled", { status: settled.status, ms: Date.now() - started, answer: settled.status === "done" && "answer" in settled ? settled.answer : null });
	out("transcript", await transcript(root));
	out("documents", { snapshot: await harness.snapshot(SnapshotDoc, root.id, ctx), recommendation: await harness.snapshot(RecommendationDoc, root.id, ctx) });
	const sys = (await root.context(ctx)).messages.filter((m) => m.role === "system").map((m) => (m.role === "system" ? m.sections : null));
	out("system messages (sections per pi.system entry)", sys);
	out("client1 event counts", tally);
	out("client1 deltas", deltas);
	out("client1 tool/run sequence", sequence);
	out("client2 watch()", { frames, ops: opsCount });
	out("client3 late join snapshot tools", lateTools);
	out("client3 event counts", lateTypes);
	await events.stop();
	await watch.stop();
	await late.stop();

	// What-if: fork at the fpl_snapshot result, so the fork keeps the snapshot but not the recommendation.
	const entries = (await root.entries({}, 200, undefined, ctx)).items;
	const snapResult = entries.find((e) => ToolResultEntry.is(e) && (e.model?.[0] as ToolResultMessage).toolName === "fpl_snapshot")!;
	const fork = await root.fork(snapResult.id, { ownership: { kind: "ownerless" } }, ctx);
	out("fork created", { forkId: fork.id, at: snapResult.id });
	out("fork docs at birth", { snapshot: await harness.snapshot(SnapshotDoc, fork.id, ctx), recommendation: await harness.snapshot(RecommendationDoc, fork.id, ctx) });
	const w = await fork.submit({ type: "input", content: "What if I keep Palmer and captain him?" }, ctx);
	out("fork settled", (await w.wait(ctx)).status);
	out("fork transcript (own + inherited)", await transcript(fork));
	out("fork recommendation", await harness.snapshot(RecommendationDoc, fork.id, ctx));
	out("parent recommendation unchanged", await harness.snapshot(RecommendationDoc, root.id, ctx));
	out("live doc after", await harness.snapshot(LiveDoc, root.id, ctx));
	out("effects.log", readFileSync(join(dir, "effects.log"), "utf8").trim().split("\n"));
	await harness.close(ctx);
}

// ─── cross-process: can a second process watch a conversation another process is running? ────────
async function crossProcessWatch() {
	const dir = mkdtempSync(join(tmpdir(), "s8-xproc-"));
	console.log(`\n=== second process watching the same SQLite file, dir=${dir}`);
	// Create the root first so the reader can open it.
	const seed = await openGaffer(join(dir, "gaffer.sqlite"), { log: effects(dir), bashReplay: "unsafe", sandbox: {}, responses: [] }, ctx);
	await seed.harness.close(ctx);
	const runner = spawnChild("run", dir, { S8_TPS: "200" });
	await new Promise((r) => setTimeout(r, 400));
	let frames = 0;
	let error: string | undefined;
	try {
		const reader = await openGaffer(join(dir, "gaffer.sqlite"), { log: () => {}, bashReplay: "unsafe", sandbox: {}, responses: [] }, ctx);
		const watch = await reader.root.watch(ctx);
		const atAttach = watch.value.entries.length;
		watch.start(async () => void frames++);
		const ran = await runner;
		out("runner", { exit: ran.code, settled: ran.stdout.split("\n").find((l) => l.startsWith("settled")) });
		out("reader watch()", { entriesAtAttach: atAttach, framesWhileOtherProcessRan: frames, entriesInReaderViewAfter: watch.value.entries.length });
		const fresh = await reader.root.entries({}, 200, undefined, ctx);
		out("reader fresh read after", { entries: fresh.items.length });
		await watch.stop();
		await reader.harness.close(ctx);
	} catch (e) {
		error = (e as Error).message;
		out("reader error", error);
		await runner;
	}
}

// ─── two processes on one storage (an overlapping container restart): does work run twice? ───────────
async function twoOwners() {
	const dir = mkdtempSync(join(tmpdir(), "s8-two-owners-"));
	console.log(`\n=== two processes own one storage at once, dir=${dir}`);
	const a = spawnChild("run", dir, { S8_TPS: "100" });
	await new Promise((r) => setTimeout(r, 1200));
	const b = spawnChild("resume", dir, { S8_TPS: "100" });
	const [ra, rb] = await Promise.all([a, b]);
	out("process A", { exit: ra.code, settled: ra.stdout.split("\n").find((l) => l.startsWith("settled")) });
	out("process B", { exit: rb.code, settled: rb.stdout.split("\n").find((l) => l.startsWith("settled")) });
	process.stdout.write(rb.stdout.split("\n").filter((l) => l.startsWith("transcript")).join("\n") + "\n");
	out("effects.log", readFileSync(join(dir, "effects.log"), "utf8").trim().split("\n"));
}

if (process.argv[2] === "child") {
	await child(process.argv[3]!, process.argv[4]!);
} else {
	mkdirSync(join(tmpdir()), { recursive: true });
	await completeRunAndFork();
	await crashScenario("crash-in-bash-unsafe", { S8_CRASH: "bash", S8_BASH_REPLAY: "unsafe" });
	await crashScenario("crash-in-bash-safe", { S8_CRASH: "bash", S8_BASH_REPLAY: "safe" });
	await crashScenario("crash-mid-model-stream", { S8_CRASH: "model" });
	await crossProcessWatch();
	await twoOwners();
}
