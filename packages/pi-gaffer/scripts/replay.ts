/**
 * NFR-OBS-01: replay a recommendation from the session log and its snapshot.
 *
 *   docker compose exec gaffer node /opt/pi-gaffer/scripts/replay.ts <rec_id> [sessions dir]
 *
 * Reruns `gaffer_lib validate` in the sandbox on the request stored with the recommendation and
 * compares every recomputed field. Exit 0 if they are identical, 1 if not, 2 if it couldn't run.
 */
import { findRun, replay } from "../src/replay.ts";
import { providerFromEnv, SandboxSession } from "../src/sandbox.ts";

const [recId, sessionsDir = process.env.GAFFER_SESSIONS_DIR ?? "/sessions"] = process.argv.slice(2);
if (!recId) {
	console.error("usage: replay.ts <rec_id> [sessions dir]");
	process.exit(2);
}
const run = findRun(sessionsDir, recId);
if (!run) {
	console.error(`no gaffer.recommendation with rec_id ${recId} (and its gaffer.validation entry) under ${sessionsDir}`);
	process.exit(2);
}
try {
	const r = await replay(run, new SandboxSession(providerFromEnv()));
	console.log(`rec ${recId}: GW${run.recommendation.gw}, snapshot ${run.validation.snapshot_path}`);
	console.log(`gaffer_lib ${r.gaffer_lib.stored} when stored, ${r.gaffer_lib.now} now`);
	if (r.reproduced) {
		console.log(`REPRODUCED: all ${r.numbers} numbers, and every other recomputed field, are identical.`);
		process.exit(0);
	}
	console.log(`NOT REPRODUCED: ${r.differences.length} field(s) differ:`);
	for (const d of r.differences.slice(0, 40)) console.log(`  ${d}`);
	process.exit(1);
} catch (e) {
	console.error((e as Error).message);
	process.exit(2);
}
