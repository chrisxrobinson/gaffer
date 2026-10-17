/**
 * NFR-REL-01 (ARCHITECTURE §10): a failing data source, sandbox, solver or LLM ends in an explanatory
 * message, no crash (the same session answers the next prompt) and no illegal plan (no recommendation
 * is stored or ledgered). The real extensions, a scripted model, a host sandboxd and a mock FPL API.
 * The odds source going down is FR-DAT-09's (test/odds.test.ts, and verify.sh against the stack); a
 * solver time-out is NFR-REL-02's (python: test_plan.py).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GafferTestEnv, hostGafferLibCommand, startEnv, startGaffer } from "./harness.ts";
import { installModelSnapshot, planDoc, seed, snapshotEntry, submission } from "./model-fixtures.ts";

let env: GafferTestEnv;
beforeAll(async () => {
	env = await startEnv();
}, 240_000);
afterAll(() => env.stop());

const call = (name: string, args: unknown) => fauxAssistantMessage(fauxToolCall(name, args as Record<string, unknown>));
const say = (text: string) => fauxAssistantMessage(fauxText(text));
const stored = (g: Awaited<ReturnType<typeof startGaffer>>) => g.sessionEntries().filter((e) => e.customType === "gaffer.recommendation");
const ledgerRows = () => {
	const f = join(env.dataDir, "ledger", "recommendations.jsonl");
	return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).length : 0;
};

async function stillAnswers(g: Awaited<ReturnType<typeof startGaffer>>) {
	g.faux.setResponses([say("Still here.")]);
	const before = g.faux.state.callCount;
	await g.session.prompt("are you still there?");
	expect(g.faux.state.callCount).toBe(before + 1);
	const last = g.session.messages.at(-1) as { role: string; content: { text?: string }[] };
	expect(last.role).toBe("assistant");
	expect(last.content.map((c) => c.text).join("")).toBe("Still here.");
}

describe("NFR-REL-01: graceful failure", () => {
	it("FPL down with nothing cached: fpl_snapshot says why, a submission is refused, nothing is stored", async () => {
		env.fpl.overrides.set("*", { status: 503, type: "text/html", body: "<html>The game is being updated.</html>" });
		const ledger = ledgerRows();
		try {
			const g = await startGaffer(env, {
				responses: [
					call("fpl_snapshot", { team_id: 1, include: ["odds"] }),
					call("submit_recommendation", submission(planDoc(), "/work/plan.json")),
					say("FPL is being updated, so I can't make a recommendation yet. Try again in a few minutes."),
				],
			});
			await g.session.prompt("What should I do this week?");
			const [snap, sub] = g.toolResults;
			expect(snap).toMatchObject({ name: "fpl_snapshot", isError: true });
			expect(snap.text).toMatch(/FPL bootstrap-static\/ unavailable after 4 tries: (HTTP 503|non-JSON body)/);
			expect(sub).toMatchObject({ name: "submit_recommendation", isError: true });
			expect(sub.text).toMatch(/\[NO_SNAPSHOT\] There is no snapshot for this team/);
			expect(stored(g)).toHaveLength(0);
			expect(ledgerRows()).toBe(ledger);
			await stillAnswers(g);
			g.session.dispose();
		} finally {
			env.fpl.overrides.clear();
		}
	}, 60_000);

	it("the solver can't run: the golden path says so, the gate refuses three times, the user is told and no plan is shown", async () => {
		process.env.GAFFER_LIB_CMD = hostGafferLibCommand({ analytics: true });
		const { dir } = installModelSnapshot(env);
		// open-fpl-solver isn't installed where the sandbox looks for it (sandboxd passes no GAFFER_SOLVER_DIR).
		const run = `${process.env.GAFFER_LIB_CMD} run --snapshot '${dir}' --out /work/plan-nosolver.json; echo run_exit=$?`;
		const sub = { ...submission(planDoc(), "/work/plan-nosolver.json") };
		const g = await startGaffer(env, {
			extra: [seed(snapshotEntry(dir))],
			responses: [call("bash", { command: run, timeout: 110 }), call("submit_recommendation", sub), call("submit_recommendation", sub), call("submit_recommendation", sub), say("SHOULD NOT BE REACHED")],
		});
		await g.session.prompt("/seed");
		const ledger = ledgerRows();
		await g.session.prompt("What should I do this week?");
		const [bash, ...subs] = g.toolResults;
		expect(bash.text).toMatch(/open-fpl-solver/i);
		expect(bash.text).toMatch(/run_exit=2/);
		expect(subs.map((s) => s.isError)).toEqual([true, true, false]); // the third ends the run with the failure
		expect(subs[0].text).toMatch(/\[PLAN_FILE_UNREADABLE\] The golden path's plan file could not be read from \/work\/plan-nosolver\.json/);
		expect(g.notifications.at(-1)).toMatchObject({ type: "error", message: expect.stringMatching(/could not produce a valid recommendation: 3 submissions failed validation, so no plan is shown/) });
		expect(g.faux.getPendingResponseCount()).toBe(1);
		expect(stored(g)).toHaveLength(0);
		expect(ledgerRows()).toBe(ledger);
		await stillAnswers(g);
		g.session.dispose();
	}, 180_000);

	it("the LLM fails: Pi retries, then ends the run on the provider's error; the log is intact and the session carries on", async () => {
		const overloaded = () => fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: "529 overloaded_error: Overloaded" });
		const g = await startGaffer(env, { responses: [overloaded, overloaded, overloaded] as FauxResponseStep[] });
		(g.session as unknown as { settingsManager: { applyOverrides(o: unknown): void } }).settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 } });
		await g.session.prompt("What should I do this week?");
		expect(g.faux.state.callCount).toBe(3); // the first try and two retries
		const last = g.session.messages.at(-1) as { role: string; stopReason?: string; errorMessage?: string };
		expect(last).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: "529 overloaded_error: Overloaded" });
		const entries = g.sessionEntries();
		expect(entries.some((e) => e.type === "message" && e.message.role === "user")).toBe(true);
		expect(entries.filter((e) => e.type === "message" && e.message.stopReason === "error").length).toBeGreaterThanOrEqual(1);
		expect(stored(g)).toHaveLength(0);
		await stillAnswers(g);
		// One overloaded reply, then a good one: the retry recovers the run.
		g.faux.appendResponses([overloaded() as never, say("Recovered.")]);
		await g.session.prompt("try again");
		expect((g.session.messages.at(-1) as { content: { text?: string }[] }).content.map((c) => c.text).join("")).toBe("Recovered.");
		g.session.dispose();
	}, 60_000);

	it("the sandbox dies mid-session: tools and the gate say it's unreachable, fpl_snapshot still answers, and it is used again once it is back", async () => {
		process.env.GAFFER_LIB_CMD = hostGafferLibCommand({ analytics: true });
		const { dir } = installModelSnapshot(env);
		const g = await startGaffer(env, { extra: [seed(snapshotEntry(dir))], responses: [call("bash", { command: "echo before" }), say("ok")] });
		await g.session.prompt("/seed");
		await g.session.prompt("first");
		expect(g.toolResults.at(-1)).toMatchObject({ name: "bash", isError: false, text: expect.stringContaining("before") });

		await env.killSandbox();
		const ledger = ledgerRows();
		g.faux.setResponses([
			call("bash", { command: "echo during" }),
			call("submit_recommendation", submission(planDoc(), "/work/plan.json")),
			call("fpl_snapshot", { team_id: 1 }),
			say("The sandbox isn't reachable, so I can't run the model right now."),
		]);
		await g.session.prompt("second");
		const [bash, sub, snap] = g.toolResults.slice(-3);
		expect(bash).toMatchObject({ name: "bash", isError: true });
		expect(bash.text).toMatch(/sandbox at http:\/\/127\.0\.0\.1:\d+ not reachable/);
		expect(sub).toMatchObject({ name: "submit_recommendation", isError: true });
		expect(sub.text).toMatch(/\[PLAN_FILE_UNREADABLE\].*not reachable/);
		// The snapshot is the harness's: it completes, without the sandbox's derivation, and says so.
		expect(snap).toMatchObject({ name: "fpl_snapshot", isError: false });
		expect(snap.text).toMatch(/Free transfers and selling prices could not be derived: .*not reachable/);
		expect(stored(g)).toHaveLength(0);
		expect(ledgerRows()).toBe(ledger);

		await env.startSandbox();
		g.faux.setResponses([call("bash", { command: "echo after" }), say("ok again")]);
		await g.session.prompt("third");
		expect(g.toolResults.at(-1)).toMatchObject({ name: "bash", isError: false, text: expect.stringContaining("after") });
		g.session.dispose();
	}, 120_000);
});
