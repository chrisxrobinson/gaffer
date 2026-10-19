/**
 * What the Gaffer App needs from Gaffer's package (ADR 0014, M1.1-3): the session and run locks (NFR-REL-03),
 * `/run {json}` and its `gaffer.run` entry (FR-UI-08), and the golden path's plan-step tag with the progress
 * lines kept out of the model's context. The real extensions, a scripted model, a host sandboxd and mock FPL.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listSessions, newestFreeSession } from "../src/app-data.ts";
import { FileLock, lockHolder, runLockPath, sessionLockPath, STALE_MS } from "../src/lock.ts";
import { goldenPathOut, planStep, stripProgress } from "../src/plan-step.ts";
import { prefsPath } from "../src/prefs.ts";
import type { Recommendation } from "../src/schema/recommendation.ts";
import type { RunEntry } from "../src/session.ts";
import { hashTeamId } from "../src/snapshot.ts";
import { type GafferTestEnv, hostGafferLibCommand, startEnv, startGaffer } from "./harness.ts";
import { installModelSnapshot, type PlanDoc, planDoc, seed, snapshotEntry, submission, TEAM_ID } from "./model-fixtures.ts";
import * as fx from "./fixtures.ts";

const LOCK = resolve(import.meta.dirname, "../src/lock.ts");
const MODEL_DATA = resolve(import.meta.dirname, "../../../python/gaffer_lib/tests/data/snapshot-model");
const PROMPTS = resolve(import.meta.dirname, "../prompts");
const GW_TEMPLATE = readFileSync(resolve(import.meta.dirname, "../prompts/gw.md"), "utf8").split("---\n")[2].replace(/\n$/, "").replace("$@", "");

let env: GafferTestEnv;
beforeAll(async () => {
	env = await startEnv();
	process.env.GAFFER_LIB_CMD = hostGafferLibCommand({ analytics: true });
	process.env.GAFFER_SESSIONS_ROOT = env.sessionsDir;
	env.fpl.data[`entry/${TEAM_ID}/`] = fx.entry(TEAM_ID);
	// /run checks players against FPL's list: the frozen snapshot's, as FPL would serve it.
	env.fpl.data["bootstrap-static/"] = JSON.parse(readFileSync(join(MODEL_DATA, "bootstrap-static.json"), "utf8"));
}, 240_000);
afterAll(() => env.stop());

/** Another process holding a lock file, as the other UI would: it exits when killed. */
function holdLock(path: string, ui: string): Promise<ChildProcess> {
	const child = spawn(process.execPath, ["--input-type=module", "-e", `const { FileLock } = await import(${JSON.stringify(LOCK)}); new FileLock(${JSON.stringify(path)}, ${JSON.stringify(ui)}).tryAcquire() || process.exit(3); console.log("held"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
	return new Promise((ok, fail) => {
		child.stdout!.once("data", () => ok(child));
		child.once("exit", (code) => fail(new Error(`lock holder exited ${code}`)));
	});
}
/** What Pi's CLI does when a session ends (an SDK session's dispose() alone doesn't): session_shutdown, then dispose. */
async function shutdown(g: Awaited<ReturnType<typeof startGaffer>>) {
	await g.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" } as never);
	g.session.dispose();
}
const kill = (c: ChildProcess) => new Promise<void>((r) => (c.exitCode !== null ? r() : (c.once("exit", () => r()), c.kill("SIGKILL"))));
const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n");
const bare = (hash: string) => hash.replace(/^hmac-sha256:/, "");

describe("FileLock (lock.ts)", () => {
	const dir = () => mkdtempSync(join(tmpdir(), "gaffer-lock-"));

	it("is exclusive, released by its owner, and holds pid, host and a heartbeat", async () => {
		const path = join(dir(), "a.jsonl.lock");
		const a = new FileLock(path, "terminal");
		const b = new FileLock(path, "app");
		expect(a.tryAcquire()).toBe(true);
		expect(b.tryAcquire()).toBe(false);
		expect(lockHolder(path)).toMatchObject({ pid: process.pid, host: hostname(), ui: "terminal" });
		expect(Date.parse(lockHolder(path)!.heartbeat)).toBeGreaterThan(Date.now() - 5000);
		a.release();
		expect(existsSync(path)).toBe(false);
		expect(b.tryAcquire()).toBe(true);
		b.release();
	});

	it("a lock whose heartbeat stopped, or whose process is gone, is stale and taken over", async () => {
		const path = join(dir(), "s.lock");
		const old = new Date(Date.now() - STALE_MS - 1000).toISOString();
		writeFileSync(path, JSON.stringify({ pid: 999_999, host: "elsewhere", start: null, ui: "app", token: "x", acquired_at: old, heartbeat: old }));
		expect(lockHolder(path)).toBeUndefined();
		const a = new FileLock(path, "terminal");
		expect(a.tryAcquire()).toBe(true);
		expect(lockHolder(path)?.ui).toBe("terminal");
		a.release();
		// A fresh heartbeat on this host from a process that no longer exists.
		const holder = await holdLock(path, "app");
		expect(lockHolder(path)?.ui).toBe("app");
		expect(new FileLock(path, "terminal").tryAcquire()).toBe(false);
		await kill(holder);
		expect(lockHolder(path)).toBeUndefined();
		const b = new FileLock(path, "terminal");
		expect(b.tryAcquire()).toBe(true);
		b.release();
		// A file caught half-written is held for a moment, then stale.
		writeFileSync(path, "");
		expect(lockHolder(path)).toBeDefined();
		utimesSync(path, new Date(Date.now() - STALE_MS - 1000), new Date(Date.now() - STALE_MS - 1000));
		expect(lockHolder(path)).toBeUndefined();
		expect(new FileLock(path, "terminal").tryAcquire()).toBe(true);
	});
});

describe("the session lock (NFR-REL-03)", () => {
	it("a second writer is refused with a notice, writes nothing, and takes over once the first is gone", async () => {
		const a = await startGaffer(env, { responses: [fauxAssistantMessage(fauxText("first answer")), fauxAssistantMessage(fauxText("third answer"))] });
		await a.session.prompt("Hello");
		const file = a.session.sessionManager.getSessionFile()!;
		expect(lockHolder(sessionLockPath(file))?.pid).toBe(process.pid);
		const before = readFileSync(file, "utf8");

		// The same session opened again (a second session object, as a second Pi process would).
		const b = await startGaffer(env, { sessionFile: file, responses: [fauxAssistantMessage(fauxText("SHOULD NOT BE REACHED"))] });
		expect(b.notifications.at(-1)?.message).toMatch(/open in the browser terminal, so it is read-only here/);
		await b.session.prompt("Am I allowed?");
		await b.session.prompt("/team 1");
		expect(b.faux.state.callCount).toBe(0);
		expect(b.notifications.filter((n) => /read-only here/.test(n.message))).toHaveLength(3);
		expect(readFileSync(file, "utf8")).toBe(before); // never interleaves: not one line from the second writer

		// The first writes on; the second, which opened before that, may not take over until it reopens.
		await a.session.prompt("Again");
		await shutdown(a);
		expect(lockHolder(sessionLockPath(file))).toBeUndefined();
		await b.session.prompt("Now?");
		expect(b.notifications.at(-1)?.message).toMatch(/changed in the browser terminal after you opened it/);
		expect(b.faux.state.callCount).toBe(0);
		b.session.dispose();

		// Reopened, it is the writer.
		const c = await startGaffer(env, { sessionFile: file, responses: [fauxAssistantMessage(fauxText("fourth"))] });
		await c.session.prompt("Now.");
		expect(c.faux.state.callCount).toBe(1);
		const roles = lines(file).map((l) => JSON.parse(l)).filter((e) => e.type === "message").map((e) => e.message.role);
		expect(roles.filter((r) => r === "user")).toHaveLength(3);
		c.session.dispose();
	}, 60_000);

	it("a stale session lock (a process that died) is taken over on open", async () => {
		const a = await startGaffer(env, { responses: [fauxAssistantMessage(fauxText("hi"))] });
		await a.session.prompt("Hello");
		const file = a.session.sessionManager.getSessionFile()!;
		await shutdown(a);
		const holder = await holdLock(sessionLockPath(file), "app");
		await kill(holder); // SIGKILL: no release, the file stays behind
		expect(existsSync(sessionLockPath(file))).toBe(true);
		const b = await startGaffer(env, { sessionFile: file, responses: [fauxAssistantMessage(fauxText("again"))] });
		expect(lockHolder(sessionLockPath(file))?.pid).toBe(process.pid);
		await b.session.prompt("Still there?");
		expect(b.faux.state.callCount).toBe(1);
		b.session.dispose();
	}, 60_000);

	it("--continue's pick skips a session another UI holds; the App's list says who holds it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gaffer-continue-"));
		const mk = (name: string, ageS: number) => {
			const f = join(dir, `${name}.jsonl`);
			writeFileSync(f, `${JSON.stringify({ type: "session", version: 3, id: `0000000${name}-0000-7000-8000-000000000000`, timestamp: new Date().toISOString(), cwd: "/work" })}\n`);
			const t = new Date(Date.now() - ageS * 1000);
			utimesSync(f, t, t);
			return f;
		};
		const older = mk("1", 60);
		const newer = mk("2", 10);
		mk("3", 5); // another project's session
		writeFileSync(join(dir, "3.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "x", cwd: "/elsewhere" })}\n`);
		expect(newestFreeSession(dir)).toBe(newer);
		const holder = await holdLock(sessionLockPath(newer), "app");
		expect(newestFreeSession(dir)).toBe(older);
		expect(listSessions(dir).map((s) => [s.file, s.lock?.ui ?? null])).toEqual([[newer, "app"], [older, null]]);
		await kill(holder);
		expect(newestFreeSession(dir)).toBe(newer);
	});
});

describe("the run lock (one run per harness while the sandbox is shared)", () => {
	it("a prompt is refused while another process runs, and runs once it has finished; /work is never cleared under it", async () => {
		const holder = await holdLock(runLockPath(env.sessionsDir), "app");
		const g = await startGaffer(env, { responses: [fauxAssistantMessage(fauxText("ran"))] });
		await g.session.prompt("Recommend something");
		expect(g.faux.state.callCount).toBe(0);
		expect(g.notifications.at(-1)?.message).toBe("A run is in progress in the Gaffer App. Gaffer runs one at a time here; try again when it has finished.");
		// Releasing this session's sandbox would clear /work: not while the other run holds it.
		writeFileSync(join(env.sandboxWork, "theirs.json"), "{}");
		const { sharedSandboxSession } = await import("../src/sandbox.ts");
		await sharedSandboxSession().url();
		await sharedSandboxSession().release();
		expect(existsSync(join(env.sandboxWork, "theirs.json"))).toBe(true);
		await kill(holder);
		await g.session.prompt("Recommend something");
		expect(g.faux.state.callCount).toBe(1);
		expect(lockHolder(runLockPath(env.sessionsDir))).toBeUndefined(); // released when the run settled
		await sharedSandboxSession().url();
		await sharedSandboxSession().release();
		expect(existsSync(join(env.sandboxWork, "theirs.json"))).toBe(false); // free: cleared as before
		g.session.dispose();
	}, 60_000);

	it("headless callers can wait for it (GAFFER_RUN_LOCK_WAIT_MS) instead of being refused", async () => {
		const holder = await holdLock(runLockPath(env.sessionsDir), "terminal");
		setTimeout(() => void kill(holder), 1500);
		process.env.GAFFER_RUN_LOCK_WAIT_MS = "10000";
		try {
			const g = await startGaffer(env, { responses: [fauxAssistantMessage(fauxText("waited"))] });
			const t0 = Date.now();
			await g.session.prompt("Go");
			expect(g.faux.state.callCount).toBe(1);
			expect(Date.now() - t0).toBeGreaterThan(1000);
			g.session.dispose();
		} finally {
			delete process.env.GAFFER_RUN_LOCK_WAIT_MS;
		}
	}, 30_000);
});

describe("/run {json} (FR-UI-08, the agent's half)", () => {
	let doc: PlanDoc;
	let dir: string;
	let planFile: string;
	beforeEach(() => {
		rmSync(join(env.dataDir, "users"), { recursive: true, force: true });
		doc = planDoc();
		({ dir, planFile } = installModelSnapshot(env));
	});
	const settled = (g: Awaited<ReturnType<typeof startGaffer>>) =>
		new Promise<void>((r) => {
			const off = g.session.subscribe((e: { type: string }) => {
				if (e.type === "agent_settled") {
					off();
					r();
				}
			});
		});
	const runJson = (options: Record<string, unknown>) => `/run ${JSON.stringify({ action: "recommend", team_id: TEAM_ID, options: { risk: "balanced", max_hits_per_gw: 1, save_chips: [], keep: [], save: false, ...options } })}`;

	it("save_chips [wildcard] and a kept player: the /gw template runs, and the recommendation lists both and plays no wildcard", async () => {
		const kept = doc.plans[0].gws[0].xi[4];
		const claimed = { ...planDoc(), prefs_resolved: { save_chips: ["wildcard"], keep_ids: [kept], avoid_ids: [], max_hits_per_gw: 1 } };
		installModelSnapshot(env, { plan: claimed });
		const g = await startGaffer(env, { promptsDir: PROMPTS, extra: [seed(snapshotEntry(dir))], responses: [fauxAssistantMessage(fauxToolCall("submit_recommendation", submission(doc, planFile) as never)), fauxAssistantMessage(fauxText("SHOULD NOT BE REACHED"))] });
		await g.session.prompt("/seed");
		const done = settled(g);
		await g.session.prompt(runJson({ save_chips: ["wildcard"], keep: [kept], ft: 2, pending: "1>2" }));
		await done;
		const entries = g.sessionEntries();
		const custom = (t: string) => entries.filter((e) => e.customType === t).map((e) => e.data);
		const [run] = custom("gaffer.run") as RunEntry[];
		const hash = hashTeamId(TEAM_ID, "test-salt");
		expect(run).toMatchObject({ action: "recommend", team_id: TEAM_ID, team_id_hash: hash, source: "app", options: { risk: "balanced", save_chips: ["wildcard"], keep: [{ id: kept, name: doc.players[String(kept)].name }], max_hits_per_gw: 1, ft: 2, pending: "1>2", save: false } });
		expect(custom("gaffer.team").at(-1)).toEqual({ team_id: TEAM_ID, team_name: fx.entry(TEAM_ID).name, ft: 2, pending: "1>2" });
		// The run's prompt is the /gw template, as the terminal sends it.
		const users = entries.filter((e) => e.type === "message" && e.message.role === "user").map((e) => e.message.content.map((c: { text: string }) => c.text).join(""));
		expect(users).toEqual([GW_TEMPLATE]);
		// The options apply to this session only: its own file, not the team's.
		expect(run.prefs_file).toMatch(new RegExp(`/users/${bare(hash)}/runs/${g.session.sessionManager.getSessionId()}\\.json$`));
		expect(existsSync(prefsPath(env.dataDir, hash))).toBe(false);
		const [rec] = custom("gaffer.recommendation") as Recommendation[];
		expect(rec.preferences).toEqual({ risk: "balanced", save_chips: ["wildcard"], keep: [{ id: kept, name: doc.players[String(kept)].name }], avoid: [], max_hits_per_gw: 1 });
		expect(rec.chip.play).not.toBe("wildcard");
		expect(rec.starting_xi.concat(rec.bench)).toContain(kept);
		g.session.dispose();
	}, 60_000);

	it("'save as my preferences' writes the team's file; bad JSON, an unknown player and a missing team are refused with nothing started", async () => {
		const g = await startGaffer(env, { promptsDir: PROMPTS, responses: [fauxAssistantMessage(fauxText("ok"))] });
		const hash = hashTeamId(TEAM_ID, "test-salt");
		for (const [args, why] of [
			["/run {not json", /isn't valid JSON/],
			[`/run ${JSON.stringify({ action: "explain", team_id: TEAM_ID, options: {} })}`, /Run not started: \/action/],
			[runJson({ keep: [99_998] }), /FPL has no player with id 99998/],
			[runJson({ path: "/etc/passwd" }), /Run not started: \/options/],
			[`/run ${JSON.stringify({ action: "recommend", team_id: 999_999_999, options: { risk: "safe", max_hits_per_gw: null, save_chips: [], keep: [], save: true } })}`, /not found/],
		] as const) {
			await g.session.prompt(args);
			expect(g.notifications.at(-1)?.message).toMatch(why);
		}
		expect(g.faux.state.callCount).toBe(0);
		expect(existsSync(join(env.dataDir, "users", bare(hash)))).toBe(false);
		const done = settled(g);
		await g.session.prompt(runJson({ risk: "safe", save: true }));
		await done;
		expect(JSON.parse(readFileSync(prefsPath(env.dataDir, hash), "utf8"))).toMatchObject({ risk: "safe", save_chips: [], keep: [], max_hits_per_gw: 1 });
		expect((g.sessionEntries().find((e) => e.customType === "gaffer.run")!.data as RunEntry).prefs_file).toBeNull();
		g.session.dispose();
	}, 60_000);
});

describe("the plan-step tag and progress lines (docs/ui §8)", () => {
	it("tags the golden path's bash result with its plan's summary and keeps the progress lines from the model", async () => {
		const { planFile } = installModelSnapshot(env);
		const doc = JSON.parse(readFileSync(planFile, "utf8"));
		// The host sandboxd has no /work: the plan file is at its real path.
		const command = `printf 'progress: projecting points\\nprogress: main solve 2 s of 43 s\\nGaffer plan for GW6\\n'; true python -m gaffer_lib run --snapshot /x --out ${planFile}`;
		const g = await startGaffer(env, { responses: [fauxAssistantMessage(fauxToolCall("bash", { command })), fauxAssistantMessage(fauxText("done"))] });
		const updates: string[] = [];
		g.session.subscribe((e: { type: string; partialResult?: { content?: { text?: string }[] } }) => {
			if (e.type === "tool_execution_update") updates.push(e.partialResult?.content?.map((c) => c.text ?? "").join("") ?? "");
		});
		await g.session.prompt("Plan it");
		const result = g.toolResults.find((r) => r.name === "bash")!;
		expect(result.text).toBe("Gaffer plan for GW6\n");
		expect(result.details).toMatchObject({
			step: "plan", file: planFile, gw: doc.gw, plans: doc.plans.length, valid_plans: doc.plans.length,
			solver: { status: doc.solver.status }, scenarios: { evaluated: doc.chip_scenarios.filter((c: { evaluated: boolean }) => c.evaluated).length, total: doc.chip_scenarios.length },
		});
		expect(updates.join("\n")).toContain("progress: main solve 2 s of 43 s"); // the UIs see them while it runs
		const stored = g.sessionEntries().find((e) => e.type === "message" && e.message.role === "toolResult")!.message;
		expect(JSON.stringify(stored)).not.toContain("progress:"); // the model never does
		g.session.dispose();
	}, 60_000);

	it("goldenPathOut, planStep and stripProgress", () => {
		expect(goldenPathOut("python -m gaffer_lib run --snapshot '/data/s x' --out /work/plan.json --prefs '/data/p.json'")).toBe("/work/plan.json");
		expect(goldenPathOut("python -m gaffer_lib run --out='/work/a b.json'")).toBe("/work/a b.json");
		expect(goldenPathOut("python -m gaffer_lib validate --out /work/plan.json")).toBeUndefined();
		expect(planStep("/w", { schema: "something else" })).toBeUndefined();
		expect(stripProgress("progress: a\nkeep\nprogress: b\n")).toBe("keep\n");
	});
});
