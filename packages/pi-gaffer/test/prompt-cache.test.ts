/**
 * NFR-COST-04 / ADR 0010: per-prompt context never rebuilds the system prompt. Two prompts in one session
 * through the real extensions: the faux provider records the transcript of every request. The leading
 * system message stays as the first prompt built it, and the second prompt's `fpl_context` arrives as a
 * later system message (a `SystemMessage.sections` patch). Pi's Anthropic adapter keeps such a message in
 * place only when the model's `compat.supportsMidConvoSystemMessages` is set (spike S6), which Pi's
 * catalogue entry for Sonnet 5.5 does (test/default-model.test.ts).
 */
import { fauxAssistantMessage, fauxText, getInitialSystemMessage, type Message, resolveTranscript, type SystemMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GafferTestEnv, startEnv, startGaffer } from "./harness.ts";

describe("follow-up prompts keep the leading system prompt (NFR-COST-04, ADR 0010)", () => {
	let env: GafferTestEnv;
	beforeAll(async () => {
		env = await startEnv();
	}, 60_000);
	afterAll(async () => {
		delete process.env.GAFFER_CLOCK_OFFSET_MS;
		await env.stop();
	});

	it("the second prompt's fpl_context is a later system message; the leading one is unchanged", async () => {
		const requests: TranscriptContext[] = [];
		const answer = (text: string) => (ctx: TranscriptContext) => {
			requests.push(structuredClone(ctx));
			return fauxAssistantMessage(fauxText(text));
		};
		const g = await startGaffer(env, { responses: [answer("first"), answer("second")] });
		await g.session.prompt("/team 1");
		await g.session.prompt("Who should I captain?");
		process.env.GAFFER_CLOCK_OFFSET_MS = String(60_000); // a minute later: fpl_context's `now:` and countdown change
		await g.session.prompt("And the vice-captain?");
		g.session.dispose();

		expect(requests).toHaveLength(2);
		const [first, second] = requests;
		const lead = (c: TranscriptContext) => getInitialSystemMessage(c.messages)!;
		expect(lead(first).sections?.fpl_context).toMatch(/team_id: 1\b/);
		expect(JSON.stringify(lead(second))).toBe(JSON.stringify(lead(first)));

		const later = second.messages.slice(1).filter((m): m is SystemMessage => m.role === "system");
		expect(later).toHaveLength(1);
		expect(Object.keys(later[0].sections ?? {})).toEqual(["fpl_context"]); // user_preferences didn't change, so it isn't resent
		expect(later[0].sections!.fpl_context).not.toBe(lead(first).sections!.fpl_context);
		expect(second.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "system", "user"]);

		// What Pi's Anthropic adapter sends (resolveTranscript with the model's flag): with the flag the
		// transcript goes as it is; without it the leading prompt is rebuilt, invalidating the cache behind it.
		expect(resolveTranscript(second, true).messages).toEqual(second.messages);
		const collapsed = resolveTranscript(second, false).messages as Message[];
		expect((collapsed[0] as SystemMessage).sections?.fpl_context).toBe(later[0].sections!.fpl_context);
		expect(collapsed.filter((m) => m.role === "system")).toHaveLength(1);
	}, 60_000);
});
