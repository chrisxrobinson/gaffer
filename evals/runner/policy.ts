/**
 * The scripted model for `pnpm eval --model faux` (and CI): Pi's faux provider playing the golden path
 * as the gaffer-workflow skill describes it. Snapshot with odds, run the command the snapshot names (it
 * carries --ft, --pending, --prefs and --hold as needed), build a submission from plan 1 of
 * /work/plan.json in the sandbox, submit. It costs nothing and exercises the whole runner, every
 * grader and the gate; its recommendation is G0's, so its points against G0 are 0 by construction.
 */
import type { FauxResponseStep } from "@earendil-works/pi-ai";

interface FauxApi {
	fauxAssistantMessage: (content: unknown) => unknown;
	fauxToolCall: (name: string, args: Record<string, unknown>) => unknown;
	fauxText: (text: string) => unknown;
}

/** Plan 1 of the plan file as a submission, printed as one JSON line (run in the sandbox). */
export const SUBMISSION_FROM_PLAN = `python -I - <<'PY'
import json
d = json.load(open("/work/plan.json"))
p = d["plans"][0]
g = p["gws"][0]
sub = {
    "plan_file": "/work/plan.json",
    "transfers": [{"out": {"id": t["out"]["id"]}, "in": {"id": t["in"]["id"]}, "rationale": "The solver's best move over the horizon."} for t in p["transfers"]],
    "captain": {"id": g["captain"]}, "vice_captain": {"id": g["vice_captain"]},
    "starting_xi": g["xi"], "bench": g["bench"],
    "chip": {"play": None, "rationale": "No chip beats the chip-free plan by enough this week."},
    "plan": [{"gw": s["gw"], "transfers": [{"out": {"id": t["out"]}, "in": {"id": t["in"]}} for t in s["transfers"]], "chip": s["chip"], "captain": s["captain"]} for s in p["gws"][:4]],
    "summary": "Plan 1 of the golden path, submitted as it is.",
}
print("SUBMISSION " + json.dumps(sub))
PY`;

const lastText = (ctx: { messages: { role?: string; content?: unknown }[] }) => {
	const m = ctx.messages.at(-1);
	return Array.isArray(m?.content) ? (m.content as { text?: string }[]).map((c) => c.text ?? "").join("") : String(m?.content ?? "");
};

export function goldenPathPolicy(teamId: number, api: FauxApi): FauxResponseStep[] {
	const say = (text: string) => api.fauxAssistantMessage(api.fauxText(text)) as never;
	const call = (name: string, args: Record<string, unknown>) => api.fauxAssistantMessage(api.fauxToolCall(name, args)) as never;
	let submission: Record<string, unknown> | undefined;
	return [
		() => call("fpl_snapshot", { team_id: teamId, include: ["odds"] }),
		(ctx) => {
			const cmd = /run in the sandbox: (python -m gaffer_lib run .*)$/m.exec(lastText(ctx))?.[1];
			return cmd ? call("bash", { command: `${cmd}; echo run_exit=$?`, timeout: 115 }) : say(`I could not get your FPL data: ${lastText(ctx).slice(0, 300)}`);
		},
		(ctx) => (/run_exit=[01]\b/.test(lastText(ctx)) ? call("bash", { command: SUBMISSION_FROM_PLAN, timeout: 30 }) : say(`The golden path did not produce a plan: ${lastText(ctx).slice(-300)}`)),
		(ctx) => {
			const line = /^SUBMISSION (\{.*\})$/m.exec(lastText(ctx))?.[1];
			if (!line) return say("I could not read the plan file.");
			submission = JSON.parse(line);
			return call("submit_recommendation", submission!);
		},
		// Only reached when the gate refused the submission: try once more, then stop.
		() => (submission ? call("submit_recommendation", submission) : say("No recommendation.")),
		() => say("The recommendation was refused twice; stopping."),
	];
}
