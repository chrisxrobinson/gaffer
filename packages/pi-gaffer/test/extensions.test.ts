import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { USER_SHELL_BLOCKED } from "../extensions/gaffer-core/index.ts";
import { type GafferTestEnv, startEnv, startGaffer } from "./harness.ts";

let env: GafferTestEnv;
beforeAll(async () => {
	env = await startEnv();
});
afterAll(() => env.stop());
afterEach(() => {
	delete process.env.GAFFER_BUDGET_SOFT;
	delete process.env.GAFFER_BUDGET_HARD;
	delete process.env.GAFFER_BUDGET_DAILY;
	delete process.env.GAFFER_MAX_TURNS;
});

describe("/team (FR-INP-01)", () => {
	it("/team 1 then a request: the snapshot refers to entry 1", async () => {
		const g = await startGaffer(env, { responses: [fauxAssistantMessage(fauxToolCall("fpl_snapshot", {})), fauxAssistantMessage(fauxText("Here's your squad."))] });
		await g.session.prompt("/team 1");
		expect(g.notifications.at(-1)).toEqual({ message: "Team set: Test XI (ID 1).", type: "info" });
		await g.session.prompt("recommend");
		const snap = g.sessionEntries().filter((e) => e.customType === "gaffer.snapshot").at(-1);
		expect(snap.data.team_id).toBe(1);
		expect(env.fpl.hits.some((h) => h.path === "entry/1/history/")).toBe(true);
		g.session.dispose();
	}, 30_000);

	it("a non-existent ID gives a clear 'team not found' within 10 s and sets nothing", async () => {
		const g = await startGaffer(env, { responses: [] });
		const t0 = Date.now();
		await g.session.prompt("/team 999999999");
		expect(Date.now() - t0).toBeLessThan(10_000);
		expect(g.notifications.at(-1)?.message).toMatch(/team 999999999 not found/i);
		expect(g.notifications.at(-1)?.type).toBe("error");
		expect(g.sessionEntries().filter((e) => e.customType === "gaffer.team")).toHaveLength(0);
		expect(g.faux.state.callCount).toBe(0);
		g.session.dispose();
	});

	it("fpl_snapshot with an unknown team returns a tool error the model can relay", async () => {
		const g = await startGaffer(env, { responses: [fauxAssistantMessage(fauxToolCall("fpl_snapshot", { team_id: 999999999 })), fauxAssistantMessage(fauxText("not found"))] });
		await g.session.prompt("team 999999999");
		expect(g.toolResults[0]).toMatchObject({ name: "fpl_snapshot", isError: true });
		expect(g.toolResults[0].text).toMatch(/team 999999999 not found/i);
		g.session.dispose();
	});

	it("fpl_snapshot with no team asks for one", async () => {
		const g = await startGaffer(env, { responses: [fauxAssistantMessage(fauxToolCall("fpl_snapshot", {})), fauxAssistantMessage(fauxText("?"))] });
		await g.session.prompt("what's my squad?");
		expect(g.toolResults[0].isError).toBe(true);
		expect(g.toolResults[0].text).toMatch(/No FPL team ID/);
		g.session.dispose();
	});

	it("/team 1 --ft 3: the snapshot uses 3 free transfers with ft_source user (FR-INP-04)", async () => {
		const g = await startGaffer(env, { responses: [fauxAssistantMessage(fauxToolCall("fpl_snapshot", {})), fauxAssistantMessage(fauxText("ok"))] });
		await g.session.prompt('/team 1 --ft 3 --pending "P1>P65"');
		expect(g.notifications.at(-1)).toEqual({ message: "Team set: Test XI (ID 1); free transfers 3 (yours); pending P1>P65.", type: "info" });
		await g.session.prompt("recommend");
		const snap = g.sessionEntries().filter((e) => e.customType === "gaffer.snapshot").at(-1);
		expect(snap.data).toMatchObject({ team_id: 1, free_transfers: 3, ft_source: "user", pending_transfers: [[1, 65]] });
		expect(g.toolResults[0].text).toMatch(/Free transfers for GW6: 3 \(set by the user/);
		g.session.dispose();
	}, 30_000);

	it("/team 1 alone: free transfers are derived (ft_source derived)", async () => {
		const g = await startGaffer(env, { responses: [fauxAssistantMessage(fauxToolCall("fpl_snapshot", {})), fauxAssistantMessage(fauxText("ok"))] });
		await g.session.prompt("/team 1");
		await g.session.prompt("recommend");
		const snap = g.sessionEntries().filter((e) => e.customType === "gaffer.snapshot").at(-1);
		expect(snap.data).toMatchObject({ free_transfers: 5, ft_source: "derived", pending_transfers: [] });
		g.session.dispose();
	}, 30_000);

	it("rejects a non-numeric argument", async () => {
		const g = await startGaffer(env, { responses: [] });
		await g.session.prompt("/team abc");
		expect(g.notifications.at(-1)?.message).toMatch(/Usage: \/team <id>/);
		g.session.dispose();
	});
});

describe("user shell (NFR-SEC-04)", () => {
	it("`!ls` and `!!ls` are blocked by the user_bash handler", async () => {
		const g = await startGaffer(env, { responses: [] });
		for (const excludeFromContext of [false, true]) {
			const r = await g.session.extensionRunner.emitUserBash({ type: "user_bash", command: "ls /", excludeFromContext, cwd: "/" });
			expect(r?.result).toMatchObject({ exitCode: 1, output: USER_SHELL_BLOCKED });
		}
		g.session.dispose();
	});
});

/** Test-only: give each assistant message a fixed cost (the faux provider always reports $0). */
const costPerMessage = (usd: number) => (pi: ExtensionAPI) =>
	pi.on("message_end", (event) => {
		const m = event.message as { role: string; stopReason?: string; usage?: { cost: Record<string, number> } };
		if (m.role !== "assistant" || !m.usage || m.stopReason === "aborted" || m.stopReason === "error") return;
		return { message: { ...m, usage: { ...m.usage, cost: { ...m.usage.cost, total: usd } } } as never };
	});

const bashLoop = (n: number) => Array.from({ length: n }, (_, i) => fauxAssistantMessage(fauxToolCall("bash", { command: `echo turn ${i}` })));

describe("budget caps (FR-BUD-01)", () => {
	it("GAFFER_BUDGET_HARD=0.05 aborts the run when it crosses the cap, records gaffer.budget and tells the user", async () => {
		process.env.GAFFER_BUDGET_HARD = "0.05";
		const g = await startGaffer(env, { extra: [costPerMessage(0.02)], responses: bashLoop(10) });
		await g.session.prompt("go");
		expect(g.faux.state.callCount).toBe(3); // $0.02, $0.04, $0.06 ≥ $0.05 → stop
		const budget = g.sessionEntries().filter((e) => e.customType === "gaffer.budget");
		const capped = budget.find((e) => e.data.capped);
		expect(capped.data).toMatchObject({ capped: "session", hard: 0.05, turn: 3 });
		expect(capped.data.session_cost).toBeCloseTo(0.06, 6);
		expect(g.notifications.at(-1)).toMatchObject({ type: "error", message: expect.stringMatching(/stopped this run.*\$0\.06.*\$0\.05/) });
		g.session.dispose();
	}, 30_000);

	it("records a gaffer.budget entry every turn under the cap", async () => {
		const g = await startGaffer(env, { extra: [costPerMessage(0.01)], responses: [...bashLoop(2), fauxAssistantMessage(fauxText("done"))] });
		await g.session.prompt("go");
		const budget = g.sessionEntries().filter((e) => e.customType === "gaffer.budget");
		expect(budget.map((e) => e.data.capped)).toEqual([false, false, false]);
		expect(budget.at(-1).data.session_cost).toBeCloseTo(0.03, 6);
		g.session.dispose();
	}, 30_000);

	it("the daily cap refuses to start a run once today's spend across sessions is at the cap", async () => {
		process.env.GAFFER_BUDGET_DAILY = "0.10";
		const prior = join(env.sessionsDir, "prior");
		mkdirSync(prior, { recursive: true });
		writeFileSync(
			join(prior, "old.jsonl"),
			`${JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", timestamp: Date.now(), usage: { cost: { total: 0.11 } } } })}\n`,
		);
		const g = await startGaffer(env, { responses: [fauxAssistantMessage(fauxText("should not run"))] });
		await g.session.prompt("go");
		expect(g.faux.state.callCount).toBe(0);
		expect(g.notifications.at(-1)?.message).toMatch(/Daily budget reached/);
		g.session.dispose();
		writeFileSync(join(prior, "old.jsonl"), "");
	});

	it("the daily cap counts every session under GAFFER_SESSIONS_ROOT, not only the current session's directory", async () => {
		const sibling = join(env.sessionsDir, "elsewhere");
		const nested = join(env.sessionsDir, "evals", "run-1");
		mkdirSync(sibling, { recursive: true });
		mkdirSync(nested, { recursive: true });
		const { dayCost: before } = await import("../src/budget.ts");
		const others = before(env.sessionsDir, new Date()); // this file's earlier tests spend too
		writeFileSync(
			join(sibling, "headless.jsonl"),
			`${JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", timestamp: Date.now(), usage: { cost: { total: 0.11 } } } })}\n`,
		);
		const { sessionsRoot } = await import("../src/config.ts");
		const { dayCost } = await import("../src/budget.ts");
		try {
			expect(sessionsRoot(nested)).toBe(nested);
			expect(dayCost(sessionsRoot(nested), new Date())).toBe(0); // a headless run in a subdirectory saw only itself
			process.env.GAFFER_SESSIONS_ROOT = env.sessionsDir;
			expect(sessionsRoot(nested)).toBe(env.sessionsDir);
			expect(dayCost(sessionsRoot(nested), new Date()) - others).toBeCloseTo(0.11, 9);
		} finally {
			delete process.env.GAFFER_SESSIONS_ROOT;
			writeFileSync(join(sibling, "headless.jsonl"), "");
		}
	});

	it("caps a run at GAFFER_MAX_TURNS turns", async () => {
		process.env.GAFFER_MAX_TURNS = "3";
		const g = await startGaffer(env, { responses: bashLoop(10) });
		await g.session.prompt("go");
		expect(g.faux.state.callCount).toBe(3);
		expect(g.sessionEntries().filter((e) => e.customType === "gaffer.budget").at(-1).data.capped).toBe("turns");
		g.session.dispose();
	}, 30_000);
});

describe("soft-cap steering (FR-BUD-02)", () => {
	const steers = (g: Awaited<ReturnType<typeof startGaffer>>) => g.sessionEntries().filter((e) => e.customType === "gaffer.steer");
	const contextText = (ctx: { messages: { content?: unknown }[] }) => JSON.stringify(ctx.messages);

	it("a run that crosses GAFFER_BUDGET_SOFT gets one steer message, not two, before its next model call", async () => {
		process.env.GAFFER_BUDGET_SOFT = "0.05";
		const contexts: string[] = [];
		const seen = (step: ReturnType<typeof fauxAssistantMessage>) => (ctx: { messages: { content?: unknown }[] }) => {
			contexts.push(contextText(ctx));
			return step;
		};
		const g = await startGaffer(env, { extra: [costPerMessage(0.02)], responses: [...bashLoop(6).map(seen), seen(fauxAssistantMessage(fauxText("done")))] });
		await g.session.prompt("go");
		expect(g.faux.state.callCount).toBe(7); // the run is steered, not stopped
		const s = steers(g);
		expect(s).toHaveLength(1);
		expect(s[0].content).toMatch(/\$0\.06, past the \$0\.05 soft cap \(GAFFER_BUDGET_SOFT\).*submit_recommendation/);
		// $0.02, $0.04, $0.06 ≥ $0.05: crossed at the third call, so calls 1-3 didn't see it and the fourth did.
		expect(contexts.map((c) => c.includes("soft cap"))).toEqual([false, false, false, true, true, true, true]);
		const budget = g.sessionEntries().filter((e) => e.customType === "gaffer.budget").map((e) => e.data);
		expect(budget.filter((d) => d.steered)).toEqual([expect.objectContaining({ turn: 3, soft: 0.05, capped: false, steered: true })]);
		expect(budget.every((d) => d.capped === false)).toBe(true);
		g.session.dispose();
	}, 30_000);

	it("does not steer again in a later run of the same session", async () => {
		process.env.GAFFER_BUDGET_SOFT = "0.03";
		const g = await startGaffer(env, { extra: [costPerMessage(0.02)], responses: [...bashLoop(3), fauxAssistantMessage(fauxText("done")), ...bashLoop(3), fauxAssistantMessage(fauxText("done again"))] });
		await g.session.prompt("go");
		await g.session.prompt("and again");
		expect(g.faux.state.callCount).toBe(8);
		expect(steers(g)).toHaveLength(1);
		g.session.dispose();
	}, 30_000);

	it("does not steer on the turn that ends the run, so it adds no model call", async () => {
		process.env.GAFFER_BUDGET_SOFT = "0.03";
		const g = await startGaffer(env, { extra: [costPerMessage(0.02)], responses: [...bashLoop(1), fauxAssistantMessage(fauxText("done")), fauxAssistantMessage(fauxText("SHOULD NOT BE CALLED"))] });
		await g.session.prompt("go");
		expect(g.faux.state.callCount).toBe(2);
		expect(steers(g)).toHaveLength(0);
		g.session.dispose();
	}, 30_000);

	it("the hard cap still stops the run; GAFFER_BUDGET_SOFT defaults to $0.75", async () => {
		process.env.GAFFER_BUDGET_SOFT = "0.03";
		process.env.GAFFER_BUDGET_HARD = "0.07";
		const g = await startGaffer(env, { extra: [costPerMessage(0.02)], responses: bashLoop(10) });
		await g.session.prompt("go");
		expect(g.faux.state.callCount).toBe(4); // steered at $0.04, stopped at $0.08
		expect(steers(g)).toHaveLength(1);
		g.session.dispose();
		delete process.env.GAFFER_BUDGET_SOFT;
		const { budgetConfig } = await import("../src/config.ts");
		expect(budgetConfig().soft).toBe(0.75);
	}, 30_000);
});
