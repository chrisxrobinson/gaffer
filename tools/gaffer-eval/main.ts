/**
 * gaffer-eval (FR-EVL-03, ARCHITECTURE §6.4): a one-shot live tracker. For every finished GW whose data
 * FPL has checked, score each real ledgered recommendation and (re)write /data/ledger/outcomes.jsonl.
 * Safe to run at any time and as often as you like: it skips what is already scored, scores nothing
 * before `data_checked`, and writes the same bytes for the same inputs.
 *
 *   node tools/gaffer-eval/main.ts [--gw N] [--rebuild] [--data /data] [--sessions /sessions]
 *
 * In the stack: docker compose exec gaffer node /opt/tools/gaffer-eval/main.ts
 * It needs what the harness has: /sessions and /data, the FPL API, the sandbox and the ID salt.
 * Exit status: 0 done (including "nothing to score yet"); 2 FPL or the sandbox could not be reached.
 */
import { parseArgs } from "node:util";
import { idSalt } from "../../packages/pi-gaffer/src/config.ts";
import { FplClient } from "../../packages/pi-gaffer/src/http.ts";
import { track } from "../../packages/pi-gaffer/src/live-eval.ts";
import { providerFromEnv, SandboxSession } from "../../packages/pi-gaffer/src/sandbox.ts";

const { values } = parseArgs({
	options: {
		gw: { type: "string" },
		rebuild: { type: "boolean", default: false },
		data: { type: "string", default: process.env.GAFFER_DATA_DIR ?? "/data" },
		sessions: { type: "string", default: "/sessions" },
	},
});
const sandbox = new SandboxSession(providerFromEnv());
try {
	const s = await track(
		{ gw: values.gw ? Number(values.gw) : undefined, rebuild: values.rebuild },
		{ dataDir: values.data!, sessionsDir: values.sessions!, salt: idSalt(), client: new FplClient(), sandbox, log: (l) => console.log(l) },
	);
	console.log(`finished and data-checked GWs: ${s.finished.join(", ") || "none"}`);
	console.log(`scored now: ${s.scored.filter((x) => x.status === "scored").length}; unscorable: ${s.scored.filter((x) => x.status === "unscorable").length}; already scored: ${s.alreadyScored}; test rows skipped: ${s.skippedTest}`);
	for (const w of s.waiting) console.log(`GW${w.gw}: ${w.recommendations} real recommendation(s) waiting for the GW to finish and its data to be checked`);
	console.log(`outcomes.jsonl: ${s.rows} row(s)`);
} catch (e) {
	console.error(`gaffer-eval: ${(e as Error).message}`);
	process.exitCode = 2;
}
// No sandbox.release(): it clears /work, which a user's run in the TUI shares. `score` writes nothing there.
