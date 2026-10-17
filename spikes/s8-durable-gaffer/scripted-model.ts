// Test double, not product code: a faux "model" that decides its next step from the transcript it is sent, so a
// process that restarts mid-run gets the same answers as the one that died.
import type { FauxResponseFactory, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const textOf = (m: Message | undefined): string => {
	if (m === undefined || m.role === "system") return "";
	if (typeof m.content === "string") return m.content;
	return m.content.map((c) => ("text" in c ? c.text : "")).join("");
};

const RUN = "python -m gaffer_lib run --snapshot /data/snapshots/snap-1-gw9 --horizon 6";

export function scriptedModel(hooks: { beforeLongStream?: () => void; longThinking?: number } = {}): FauxResponseFactory {
	return (context) => {
		const msgs = context.messages;
		const lastUser = msgs.findLastIndex((m) => m.role === "user");
		const whatIf = /what if/i.test(textOf(msgs[lastUser]));
		const results = msgs.slice(lastUser + 1).filter((m) => m.role === "toolResult");
		const last = results.at(-1);
		const lastText = textOf(last);
		const step = (thinking: string, say: string, name: string, args: Record<string, unknown>) =>
			fauxAssistantMessage([fauxThinking(thinking), fauxText(say), fauxToolCall(name, args)], { stopReason: "toolUse" });
		const run = (extra = "") => {
			hooks.beforeLongStream?.();
			const pad = " The fixtures for the next six gameweeks matter.".repeat(hooks.longThinking ?? 1);
			return step(`I have the snapshot; run the golden path.${pad}`, "Running the model in the sandbox.", "bash", { command: `${RUN}${extra}` });
		};
		const submit = (captain: string) =>
			step("The plan is legal; submit it.", "Submitting.", "submit_recommendation", { transfers: ["Isak > Haaland"], captain });

		if (whatIf) {
			if (last === undefined || (last.toolName === "bash" && /interrupted/i.test(lastText))) return run(" --keep 154");
			if (last.toolName === "bash" && !last.isError) return submit("Palmer");
			return fauxAssistantMessage("What-if done.");
		}
		if (last === undefined) return step("First get the user's squad.", "Fetching your team.", "fpl_snapshot", { team_id: 1 });
		if (last.toolName === "fpl_snapshot") return run();
		if (last.toolName === "bash" && /interrupted/i.test(lastText)) return run(); // the model retries the cut-off run
		if (last.toolName === "bash" && !last.isError)
			return step("Check the transfer history too.", "Looking at transfers.", "bash", { command: "curl https://fantasy.premierleague.com/api/my-team/1/" });
		if (last.toolName === "bash" && /blocked/i.test(lastText)) return submit("Haaland");
		return fauxAssistantMessage(`Unexpected state after ${last.toolName}: ${lastText.slice(0, 80)}`);
	};
}
