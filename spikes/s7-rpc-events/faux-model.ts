/**
 * S7: a scripted faux model, loaded as a Pi extension so that `pi --mode rpc` can use it
 * (`-e ./faux-model.ts --provider faux --model faux-1`). No network, no spend.
 *
 * One "brain" function decides each reply from the transcript, so the script survives extra
 * prompts (follow-ups, `!cmd`, `/export ...`) in any order. Each reply has thinking + text and,
 * on the golden path, a tool call, mimicking a Gaffer run:
 *   user "Recommend ..." -> fpl_snapshot -> bash (golden path) -> submit_recommendation (rejected)
 *   -> submit_recommendation (valid, terminate) ; any other user text -> thinking + text answer.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HERE = import.meta.dirname;
const REC = JSON.parse(readFileSync(join(HERE, "fixtures", "recommendation.json"), "utf8"));

type Msg = { role: string; content: unknown; toolName?: string; isError?: boolean };
const textOf = (m: Msg | undefined) =>
	typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? (m!.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("") : "";

const brain: FauxResponseFactory = (context) => {
	const msgs = (context.messages ?? []) as Msg[];
	const last = msgs[msgs.length - 1];
	// The last real turn: skip custom/steer messages Pi turns into user text after a tool result.
	const lastTool = [...msgs].reverse().find((m) => m.role === "toolResult");
	// Steers ("[steer] ...") and the budget message arrive as user text after a tool result: keep going.
	const lastIsTool = last?.role === "toolResult" || (last?.role === "user" && /\[(budget|steer)\]/.test(textOf(last)) && lastTool);

	if (lastIsTool && lastTool) {
		switch (lastTool.toolName) {
			case "fpl_snapshot":
				return fauxAssistantMessage([
					fauxThinking("The snapshot is fresh: 5 free transfers banked, £0.0m in the bank. Next I run the golden path in the sandbox to get ranked plans."),
					fauxText("Snapshot taken. Running the model and solver in the sandbox."),
					fauxToolCall("bash", { command: "python -m gaffer_lib run --snapshot /data/snapshots/s7 --out /work/plan.json", timeout: 120 }),
				]);
			case "bash":
				return fauxAssistantMessage([
					fauxThinking("Plan 1 sells Smith Rowe, Winks and Haaland. Captain Salah. I will submit it, but I forget the bench order on purpose (S7 retry path)."),
					fauxToolCall("submit_recommendation", { attempt: 1, plan_rank: 1, bench: [] }),
				]);
			case "submit_recommendation":
				if (lastTool.isError)
					return fauxAssistantMessage([
						fauxThinking("Rejected: the bench must have 4 players, goalkeeper first. Resubmitting plan 1 with the bench from the plan file."),
						fauxToolCall("submit_recommendation", { attempt: 2, plan_rank: 1, bench: REC.bench }),
					]);
				return fauxAssistantMessage([fauxText("(the run should have ended after a valid submission)")]);
			default:
				return fauxAssistantMessage([fauxText(`(faux: unexpected tool ${lastTool.toolName})`)]);
		}
	}

	const asked = textOf([...msgs].reverse().find((m) => m.role === "user" && !/\[(budget|steer)\]/.test(textOf(m))));
	if (/recommend/i.test(asked)) {
		const team = /\b(\d{4,8})\b/.exec(asked)?.[1];
		return fauxAssistantMessage([
			fauxThinking("The user wants this GW's recommendation. I need a fresh snapshot of their team and the public FPL data first."),
			fauxText("Let me fetch your team and this week's data."),
			fauxToolCall("fpl_snapshot", { ...(team && { team_id: Number(team) }), include: ["odds"] }),
		]);
	}
	return fauxAssistantMessage([
		fauxThinking(`Follow-up question; answering from the stored recommendation. The user wrote: ${asked.slice(0, 80)}`),
		fauxText(`(faux answer) You asked: "${asked.slice(0, 120)}". Salah captains because his xP (7.95) is the squad's highest.`),
	]);
};

export default function fauxModel(pi: ExtensionAPI) {
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "faux-1", reasoning: true, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }],
		tokensPerSecond: 400,
		tokenSize: { min: 3, max: 8 },
	});
	faux.setResponses(Array.from({ length: 50 }, () => brain));
	pi.registerProvider(faux.provider as never);
}
