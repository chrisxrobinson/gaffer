import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComposeSandboxProvider, createSandboxOperations, SandboxSession } from "../src/sandbox.ts";

const SANDBOXD = resolve(import.meta.dirname, "../../../sandbox/sandboxd.py");
let proc: ChildProcess;
let url: string;
let work: string;

async function freePort(): Promise<number> {
	return new Promise((r) => {
		const s = createServer().listen(0, "127.0.0.1", () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => r(p));
		});
	});
}

beforeEach(async () => {
	work = join(mkdtempSync(join(tmpdir(), "gaffer-sbx-")), "work");
	mkdirSync(work);
	const port = await freePort();
	url = `http://127.0.0.1:${port}`;
	proc = spawn("python3", [SANDBOXD, "--host", "127.0.0.1", "--port", String(port), "--work", work], { stdio: "ignore" });
	await new ComposeSandboxProvider(url).provision();
});
afterEach(() => void proc.kill());

const collect = () => {
	const chunks: Buffer[] = [];
	return { onData: (b: Buffer) => chunks.push(b), text: () => Buffer.concat(chunks).toString() };
};

describe("sandbox operations (bash/read/write/edit → sandboxd)", () => {
	it("bash exec streams output and returns the exit code, ignoring the harness env", async () => {
		const ops = createSandboxOperations(new SandboxSession(new ComposeSandboxProvider(url)), { localReadRoots: [] });
		const out = collect();
		const r = await ops.bash.exec("echo hello; echo $SECRET_FROM_HARNESS; exit 4", work, { onData: out.onData, env: { SECRET_FROM_HARNESS: "leak" } });
		expect(r.exitCode).toBe(4);
		expect(out.text()).toContain("hello");
		expect(out.text()).not.toContain("leak");
	});

	it("timeouts surface as Pi's 'timeout:N' error", async () => {
		const ops = createSandboxOperations(new SandboxSession(new ComposeSandboxProvider(url)), { localReadRoots: [] });
		await expect(ops.bash.exec("sleep 20", work, { onData: () => {}, timeout: 1 })).rejects.toThrow("timeout:1");
	});

	it("abort stops the command in the sandbox and surfaces as 'aborted'", async () => {
		const ops = createSandboxOperations(new SandboxSession(new ComposeSandboxProvider(url)), { localReadRoots: [] });
		const ac = new AbortController();
		const p = ops.bash.exec(`sleep 1; touch ${work}/should-not-exist`, work, { onData: () => {}, signal: ac.signal });
		setTimeout(() => ac.abort(), 200);
		await expect(p).rejects.toThrow("aborted");
		await new Promise((r) => setTimeout(r, 1500));
		expect(existsSync(join(work, "should-not-exist"))).toBe(false);
	});

	it("write, read and access go to the sandbox filesystem", async () => {
		const ops = createSandboxOperations(new SandboxSession(new ComposeSandboxProvider(url)), { localReadRoots: [] });
		await ops.write.mkdir(`${work}/a/b`);
		await ops.write.writeFile(`${work}/a/b/x.py`, "print(1)\n");
		expect((await ops.read.readFile(`${work}/a/b/x.py`)).toString()).toBe("print(1)\n");
		await expect(ops.edit.access(`${work}/a/b/x.py`)).resolves.toBeUndefined();
		await expect(ops.read.access(`${work}/nope`)).rejects.toThrow(/ENOENT|not found|does not exist/i);
	});

	it("reads under the package skills dir are served locally, everything else goes to the sandbox", async () => {
		const skills = mkdtempSync(join(tmpdir(), "gaffer-skills-"));
		writeFileSync(join(skills, "SKILL.md"), "# local skill");
		const ops = createSandboxOperations(new SandboxSession(new ComposeSandboxProvider(url)), { localReadRoots: [skills] });
		expect((await ops.read.readFile(join(skills, "SKILL.md"))).toString()).toBe("# local skill");
		// a path outside the allowlist that only exists on the harness is not readable
		await expect(ops.read.readFile(join(skills, "..", "other.txt"))).rejects.toThrow();
		// traversal out of the allowlist is not treated as local
		expect(ops.isLocalRead(join(skills, "..", "etc"))).toBe(false);
	});
});

describe("SandboxSession lifecycle", () => {
	it("provisions lazily on first use", async () => {
		let provisions = 0;
		const provider = { provision: async () => (provisions++, { url }), release: async () => {} };
		const session = new SandboxSession(provider);
		expect(provisions).toBe(0);
		const ops = createSandboxOperations(session, { localReadRoots: [] });
		await ops.bash.exec("true", work, { onData: () => {} });
		await ops.bash.exec("true", work, { onData: () => {} });
		expect(provisions).toBe(1);
	});

	it("releases after the idle timeout and re-provisions on next use", async () => {
		let releases = 0;
		let provisions = 0;
		const provider = { provision: async () => (provisions++, { url }), release: async () => void releases++ };
		const session = new SandboxSession(provider, { idleMs: 100 });
		const ops = createSandboxOperations(session, { localReadRoots: [] });
		await ops.bash.exec("true", work, { onData: () => {} });
		await new Promise((r) => setTimeout(r, 250));
		expect(releases).toBe(1);
		await ops.bash.exec("true", work, { onData: () => {} });
		expect(provisions).toBe(2);
		await session.release();
	});

	it("the compose provider's release empties /work", async () => {
		writeFileSync(join(work, "leftover.txt"), "x");
		await new ComposeSandboxProvider(url).release();
		expect(readdirSync(work)).toEqual([]);
	});

	it("provision fails clearly when sandboxd is unreachable", async () => {
		await expect(new ComposeSandboxProvider("http://127.0.0.1:1", { timeoutMs: 300 }).provision()).rejects.toThrow(/sandbox .* not reachable/);
	});
});
