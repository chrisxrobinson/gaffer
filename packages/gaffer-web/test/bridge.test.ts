/**
 * The bridge (ADR 0014) against a fake Pi that records every command it is sent:
 * - NFR-SEC-05 / NFR-SEC-07: every RPC command outside the allowlist, switch_session with any path, path-traversal
 *   session ids, a bad Origin or Host, an over-long follow-up, `/` and `!` prompts: rejected, with no side effect.
 * - FR-UI-03: SSE with sequence ids; a reconnect replays from Last-Event-ID; the current run is buffered.
 * - NFR-LAT-04: events reach an SSE client in ≤ 500 ms p95.
 * - NFR-REL-03 on the App's side: a session the other UI holds is not opened for writing.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runLockPath, sessionLockPath } from "../../pi-gaffer/src/lock.ts";
import { createBridge, type Pi } from "../src/bridge.ts";

/** The 33 RPC commands of Pi 1.3.0 (rpc-types.ts), as research 11 §2.1 lists them. */
const RPC = [
	"prompt", "steer", "follow_up", "abort", "new_session", "get_state", "set_model", "cycle_model", "get_available_models", "set_thinking_level", "cycle_thinking_level",
	"get_available_thinking_levels", "set_steering_mode", "set_follow_up_mode", "compact", "set_auto_compaction", "set_auto_retry", "abort_retry", "bash", "abort_bash",
	"get_session_stats", "export_html", "switch_session", "fork", "clone", "get_fork_messages", "get_tree", "get_last_assistant_text", "set_session_name", "get_messages",
	"get_entries", "get_commands", "clear_queue",
];
/** What the bridge may send Pi (ADR 0014); this fake records anything else too, and the tests check none arrives. */
const ALLOWED = new Set(["start", "stop", "getState", "prompt", "steer", "abort", "setSessionName", "cancelDialog"]);

class FakePi {
	calls: { m: string; args: unknown[] }[] = [];
	listeners: ((e: unknown) => void)[] = [];
	id: string;
	file: string;
	onPrompt?: (text: string) => void;
	constructor(id: string, file: string) {
		this.id = id;
		this.file = file;
	}
	emit(e: unknown) {
		for (const l of this.listeners) l(e);
	}
	api(): Pi {
		const rec = (m: string) => (...args: unknown[]) => {
			this.calls.push({ m, args });
		};
		return {
			start: async () => rec("start")(),
			stop: async () => rec("stop")(),
			onEvent: (l) => {
				this.listeners.push(l as (e: unknown) => void);
				return () => {};
			},
			getState: async () => {
				rec("getState")();
				return { sessionId: this.id, sessionFile: this.file } as never;
			},
			prompt: async (text: string) => {
				rec("prompt")(text);
				this.onPrompt?.(text);
				return "handled" as never;
			},
			steer: async (text: string) => {
				rec("steer")(text);
				return "queued" as never;
			},
			abort: async () => rec("abort")(),
			setSessionName: async (n: string) => rec("setSessionName")(n),
			cancelDialog: (id: string) => rec("cancelDialog")(id),
		};
	}
}

const root = mkdtempSync(join(tmpdir(), "gaffer-web-"));
const sessionsDir = join(root, "sessions");
const dataDir = join(root, "data");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
process.env.GAFFER_ID_SALT = "test-salt";
const EXISTING = "01a14ad8-5d5b-7421-b42c-a5a70968b3e7";
const existingFile = join(sessionsDir, `2026-10-19T10-00-00-000Z_${EXISTING}.jsonl`);
writeFileSync(existingFile, `${JSON.stringify({ type: "session", version: 3, id: EXISTING, timestamp: "2026-10-19T10:00:00.000Z", cwd: "/work" })}\n${JSON.stringify({ type: "custom", customType: "gaffer.team", data: { team_id: 1, team_name: "Test XI" }, id: "a1", parentId: null, timestamp: "2026-10-19T10:00:01.000Z" })}\n`);

let fakes: FakePi[] = [];
let spawned: (string | undefined)[] = [];
let n = 0;
const bridge = createBridge({
	sessionsDir,
	dataDir,
	publicDir: resolve(import.meta.dirname, "../public"),
	replay: { home: () => ({ gw: { next: 9 }, sessions: [] }), team: (id) => ({ id, name: "Test XI", squad: [] }) },
	spawnPi: (file) => {
		spawned.push(file);
		const fake = new FakePi(file ? EXISTING : `${String(++n).padStart(8, "0")}-0000-7000-8000-000000000000`, file ?? join(sessionsDir, `new-${n}.jsonl`));
		// A run starts when its prompt arrives (as Pi's /run does: handled, then agent_start).
		fake.onPrompt = () => setTimeout(() => fake.emit({ type: "agent_start" }), 5);
		fakes.push(fake);
		return fake.api();
	},
});
let base = "";
let host = "";
beforeAll(async () => {
	await new Promise<void>((r) => bridge.server.listen(0, "127.0.0.1", r));
	const port = (bridge.server.address() as AddressInfo).port;
	host = `127.0.0.1:${port}`;
	base = `http://${host}`;
});
afterAll(() => bridge.close());
beforeEach(() => {
	fakes = [];
	spawned = [];
});

const origin = () => ({ origin: base });
const post = (path: string, body: unknown, headers: Record<string, string> = origin()) =>
	fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const rid = () => `req-${Math.random().toString(36).slice(2, 12)}`;
const run = (options: Record<string, unknown> = {}) => ({ requestId: rid(), team_id: 1, options: { risk: "balanced", max_hits_per_gw: 1, save_chips: ["wildcard"], keep: [8], save: false, ...options } });
const allCalls = () => fakes.flatMap((f) => f.calls);
const sentToPi = () => allCalls().filter((c) => c.m === "prompt" || c.m === "steer" || c.m === "setSessionName");

describe("NFR-SEC-05 / NFR-SEC-07: only the allowlist reaches Pi", () => {
	it("a run sends Pi exactly one bridge-built /run {json}, from the typed fields only", async () => {
		const r = await post("/api/runs", { ...run({ path: "/etc/passwd", args: ["--session", "/etc/passwd"] }), sessionPath: "/etc/passwd", command: "bash" });
		expect(r.status).toBe(201);
		expect(spawned).toEqual([undefined]); // a new session: no path at all
		const prompts = sentToPi();
		expect(prompts).toHaveLength(1);
		const text = prompts[0].args[0] as string;
		expect(text.startsWith("/run ")).toBe(true);
		expect(JSON.parse(text.slice(5))).toEqual({ action: "recommend", team_id: 1, options: { risk: "balanced", max_hits_per_gw: 1, save_chips: ["wildcard"], keep: [8], save: false } });
		expect(allCalls().every((c) => ALLOWED.has(c.m))).toBe(true);
	});

	it.each(RPC)("the RPC command %s, sent to every endpoint, is refused and reaches no Pi", async (type) => {
		const bodies = [{ requestId: rid(), type, command: "id", sessionPath: "/etc/passwd", outputPath: "/tmp/x.html", message: "/team 1" }, { type, id: "x" }];
		for (const body of bodies) {
			for (const path of ["/api/runs", `/api/sessions/${EXISTING}/commands`, "/api/rpc", "/api/home", `/api/sessions/${EXISTING}`]) {
				const r = await post(path, body);
				if (path === "/api/runs") expect(r.status).toBe(400); // not a run's fields
				else if (path.endsWith("/commands") && ["abort"].includes(type)) expect([400, 409]).toContain(r.status);
				else expect([400, 404, 405]).toContain(r.status);
			}
		}
		expect(spawned).toEqual([]);
		expect(sentToPi()).toEqual([]);
	});

	it("switch_session with any path, and path-traversal session ids, resolve to nothing", async () => {
		const ids = ["../../etc/passwd", "..%2F..%2Fetc%2Fpasswd", "%2e%2e%2f%2e%2e%2fetc%2fpasswd", "/etc/passwd", encodeURIComponent(existingFile), "01a14ad8-5d5b-7421-b42c-a5a70968b3e7/../x", "01A14AD8-5D5B-7421-B42C-A5A70968B3E7", "00000000-0000-0000-0000-000000000000", `${EXISTING}%00`, `${EXISTING}.jsonl`];
		for (const id of ids) {
			for (const [m, p] of [["GET", `/api/sessions/${id}`], ["GET", `/api/sessions/${id}/events`], ["POST", `/api/sessions/${id}/commands`]] as const) {
				const r = m === "GET" ? await fetch(base + p) : await post(p, { requestId: rid(), type: "ask", text: "hello", sessionPath: "/etc/passwd" });
				// 404, or 405 where the client resolved "../" itself and the path left /api/.
				expect([404, 405], `${m} ${p}`).toContain(r.status);
				await r.body?.cancel();
			}
		}
		for (const p of ["/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/app/../../src/bridge.ts", "/vendor/..%2f..%2fserver.ts", "/server.ts", "/%2fetc%2fpasswd"]) {
			const r = await fetch(base + p);
			expect(r.status, p).toBe(404);
			await r.body?.cancel();
		}
		expect(spawned).toEqual([]);
	});

	it("a request from another origin, with no origin, or under another host name is refused before anything runs", async () => {
		const cases: [Record<string, string>, number][] = [
			[{ origin: "http://evil.example" }, 403],
			[{ origin: `http://${host}.evil.example` }, 403],
			[{ origin: "null" }, 403],
			[{}, 403], // a POST must say where it comes from
			[{ origin: base, "sec-fetch-site": "cross-site" }, 403],
			[{ origin: "http://evil.example:80", host: "evil.example" }, 421], // DNS rebinding: a page on another name
		];
		for (const [headers, status] of cases) {
			// fetch() can't set Host or Origin freely: use a raw request.
			const res = await raw("POST", "/api/runs", JSON.stringify(run()), headers);
			expect(res.status, JSON.stringify(headers)).toBe(status);
		}
		const get = await raw("GET", "/api/home", "", { host: "attacker.test:1234" });
		expect(get.status).toBe(421);
		const xsite = await raw("GET", `/api/sessions/${EXISTING}`, "", { "sec-fetch-site": "cross-site" });
		expect(xsite.status).toBe(403);
		expect(spawned).toEqual([]);
	});

	it("follow-ups: over 280 characters, starting with / or !, or with control characters, are refused; others are sent as text", async () => {
		for (const text of ["x".repeat(281), "/team 999", "  /export /tmp/x", "!ls /run/secrets", "!!id", "hi\u0007there", "", "   "]) {
			const r = await post(`/api/sessions/${EXISTING}/commands`, { requestId: rid(), type: "ask", text });
			expect(r.status, JSON.stringify(text)).toBe(400);
		}
		expect(spawned).toEqual([]);
		const ok = await post(`/api/sessions/${EXISTING}/commands`, { requestId: rid(), type: "ask", text: "Why Haaland as captain?" });
		expect(ok.status).toBe(200);
		expect(spawned).toEqual([existingFile]); // the bridge resolved the id to its own path
		expect(sentToPi().map((c) => [c.m, c.args[0]])).toEqual([["prompt", "Why Haaland as captain?"]]);
		const long = await post(`/api/sessions/${EXISTING}/commands`, { requestId: rid(), type: "rename", text: "x".repeat(81) });
		expect(long.status).toBe(400);
		// Let it go, as the idle timer would.
		await bridge.live.get(EXISTING)?.pi.stop();
		bridge.live.delete(EXISTING);
	});

	it("run options are checked field by field", async () => {
		for (const bad of [{ team_id: "1; rm -rf /" }, { team_id: 0 }, { options: { risk: "reckless" } }, { options: { save_chips: ["bench"] } }, { options: { keep: ["Salah"] } }, { options: { ft: 9 } }, { options: { pending: "Salah to Palmer" } }, { options: { save: "yes" } }]) {
			const body = { ...run(), ...bad, options: { ...run().options, ...(bad as { options?: object }).options } };
			const r = await post("/api/runs", body);
			expect(r.status, JSON.stringify(bad)).toBe(400);
		}
		const notJson = await post("/api/runs", "{not json");
		expect(notJson.status).toBe(400);
		const big = await post("/api/runs", { ...run(), pad: "x".repeat(20_000) });
		expect(big.status).toBe(413);
		expect(spawned).toEqual([]);
	});

	it("a dialog request is cancelled for the id that process asked, and never reaches the page", async () => {
		const r = await post("/api/runs", run());
		const { id } = (await r.json()) as { id: string };
		const fake = fakes[0];
		fake.emit({ type: "extension_ui_request", id: "dlg-1", method: "select", title: "Pick", options: ["a"] });
		await new Promise((res) => setTimeout(res, 20));
		expect(fake.calls.filter((c) => c.m === "cancelDialog")).toEqual([{ m: "cancelDialog", args: ["dlg-1"] }]);
		const events = await sse(id, 0, 1);
		expect(events.some((e) => e.data.includes("dlg-1"))).toBe(false);
	});
});

describe("NFR-REL-03 on the App's side", () => {
	it("a session the terminal holds is not opened for writing; a run is refused while another run holds the sandbox", async () => {
		const held = await import("node:child_process").then(({ spawn }) =>
			new Promise<import("node:child_process").ChildProcess>((ok) => {
				const c = spawn(process.execPath, ["--input-type=module", "-e", `const { FileLock } = await import(${JSON.stringify(resolve(import.meta.dirname, "../../pi-gaffer/src/lock.ts"))}); new FileLock(${JSON.stringify(sessionLockPath(existingFile))}, "terminal").tryAcquire(); new FileLock(${JSON.stringify(runLockPath(sessionsDir))}, "terminal").tryAcquire(); console.log("held"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
				c.stdout!.once("data", () => ok(c));
			}));
		try {
			const view = await (await fetch(`${base}/api/sessions/${EXISTING}`)).json();
			expect(view.lock).toEqual({ ui: "terminal" });
			const ask = await post(`/api/sessions/${EXISTING}/commands`, { requestId: rid(), type: "ask", text: "hello" });
			expect(ask.status).toBe(409);
			expect(((await ask.json()) as { error: string }).error).toMatch(/open in the browser terminal/);
			const r = await post("/api/runs", run());
			expect(r.status).toBe(409);
			expect(((await r.json()) as { error: string }).error).toMatch(/A run is in progress in the browser terminal/);
			expect(spawned).toEqual([]);
		} finally {
			await new Promise((r) => (held.once("exit", r), held.kill("SIGKILL")));
		}
	});
});

describe("FR-UI-03 and NFR-LAT-04: the event stream", () => {
	it("each event has a sequence id; a reconnect with Last-Event-ID replays only what it missed; a retried request isn't repeated", async () => {
		const body = run();
		const r1 = await post("/api/runs", body);
		const r2 = await post("/api/runs", body); // the same request id: answered once, nothing sent twice
		const { id } = (await r1.json()) as { id: string };
		expect(await r2.json()).toEqual({ id });
		expect(sentToPi()).toHaveLength(1);
		const fake = fakes[0];
		for (let i = 0; i < 10; i++) fake.emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `w${i} ` } });
		const all = await sse(id, 0, 11);
		expect(all.map((e) => e.id)).toEqual(all.map((_e, i) => all[0].id + i));
		const rest = await sse(id, all[5].id, 5);
		expect(rest.map((e) => e.id)).toEqual(all.slice(6).map((e) => e.id));
		// What the page loads first says where the buffer starts.
		const view = await (await fetch(`${base}/api/sessions/${id}`)).json();
		expect(view.live).toMatchObject({ running: true, from: all[0].id });
	});

	it("the system prompt, whole-run payloads and validation replay requests don't reach the page", async () => {
		const { id } = (await (await post("/api/runs", run())).json()) as { id: string };
		const fake = fakes[0];
		fake.emit({ type: "message_start", message: { role: "system", sections: { preamble: "SECRET-PREAMBLE" } } });
		fake.emit({ type: "agent_end", messages: [{ role: "system", content: "SECRET-PREAMBLE" }] });
		fake.emit({ type: "entry_appended", entry: { type: "custom", customType: "gaffer.validation", data: { attempt: 1, passed: false, stage: "validate", errors: [{ code: "X", message: "m" }], request: { plan: "HUGE-PLAN" } } } });
		fake.emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "{\"a\":" } });
		const events = await sse(id, 0, 3);
		const text = events.map((e) => e.data).join("\n");
		expect(text).not.toContain("SECRET-PREAMBLE");
		expect(text).not.toContain("HUGE-PLAN");
		expect(text).not.toContain("toolcall_delta");
		expect(text).toContain('"errors":[{"code":"X","message":"m"}]');
	});

	it("NFR-LAT-04: 500 events over two seconds reach the client in ≤ 500 ms p95", async () => {
		const { id } = (await (await post("/api/runs", run())).json()) as { id: string };
		const fake = fakes[0];
		const got: number[] = [];
		const ctrl = new AbortController();
		const reader = fetch(`${base}/api/sessions/${id}/events?after=1`, { signal: ctrl.signal }).then(async (res) => {
			const dec = new TextDecoder();
			let buf = "";
			for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
				buf += dec.decode(chunk);
				let k: number;
				while ((k = buf.indexOf("\n\n")) >= 0) {
					const frame = buf.slice(0, k);
					buf = buf.slice(k + 2);
					const data = /^data: (.*)$/m.exec(frame)?.[1];
					if (data && data.includes("sentAt")) got.push(Date.now() - JSON.parse(data).assistantMessageEvent.sentAt);
				}
				if (got.length >= 500) break;
			}
		}).catch(() => {});
		await new Promise((r) => setTimeout(r, 50));
		for (let i = 0; i < 500; i++) {
			fake.emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "x", sentAt: Date.now() } });
			if (i % 25 === 0) await new Promise((r) => setTimeout(r, 100));
		}
		await Promise.race([reader, new Promise((r) => setTimeout(r, 5000))]);
		ctrl.abort();
		expect(got.length).toBe(500);
		const p95 = got.sort((a, b) => a - b)[Math.ceil(got.length * 0.95) - 1];
		expect(p95).toBeLessThanOrEqual(500);
	});
});

/** Read `count` SSE frames after `after` (Last-Event-ID). */
async function sse(id: string, after: number, count: number): Promise<{ id: number; data: string }[]> {
	const ctrl = new AbortController();
	const res = await fetch(`${base}/api/sessions/${id}/events`, { headers: after ? { "last-event-id": String(after) } : {}, signal: ctrl.signal });
	const out: { id: number; data: string }[] = [];
	const dec = new TextDecoder();
	let buf = "";
	const timer = setTimeout(() => ctrl.abort(), 1500);
	try {
		for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
			buf += dec.decode(chunk);
			let k: number;
			while ((k = buf.indexOf("\n\n")) >= 0) {
				const frame = buf.slice(0, k);
				buf = buf.slice(k + 2);
				const fid = /^id: (\d+)$/m.exec(frame)?.[1];
				const data = /^data: (.*)$/m.exec(frame)?.[1];
				if (fid && data) out.push({ id: Number(fid), data });
			}
			if (out.length >= count) break;
		}
	} catch {
		/* aborted */
	} finally {
		clearTimeout(timer);
		ctrl.abort();
	}
	return out;
}

/** A raw HTTP request, so Host and Origin can be anything. */
async function raw(method: string, path: string, body: string, headers: Record<string, string>): Promise<{ status: number }> {
	const { request } = await import("node:http");
	const [h, port] = host.split(":");
	return new Promise((ok, fail) => {
		const req = request({ host: h, port: Number(port), method, path, headers: { host, "content-type": "application/json", ...headers } }, (res) => {
			res.resume();
			ok({ status: res.statusCode ?? 0 });
		});
		req.on("error", fail);
		req.end(body);
	});
}
