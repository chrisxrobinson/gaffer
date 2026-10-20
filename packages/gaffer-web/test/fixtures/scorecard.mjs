// A season for team 1 as gaffer-eval writes it (`gaffer.outcome/1` rows in ledger/outcomes.jsonl) and the ledger it
// scored (ledger/recommendations.jsonl), with the team hashed under the tests' salt ("test-salt"). Counted and
// scored: GW6 and GW7 (an earlier GW7 recommendation is scored but not counted); GW8 waits to be scored; another
// team's row and a faux test row must not show. For the bridge and view tests and for `--replay` screenshots:
//   node test/fixtures/scorecard.mjs <data dir>   writes <data dir>/ledger/{outcomes,recommendations}.jsonl
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TEAM = 1;
export const HASH = "hmac-sha256:0132058d591f01ef4153be7055efc4bed993933af78160b356d6feea6abd757f"; // hashTeamId(1, "test-salt")
const OTHER = "hmac-sha256:0756a360c4831bb9bf043a0f407f9f7ce87b4620f525ebbae6f9ea00d1afc511"; // team 2
const scored = (points) => ({ points, gross: points, hit_cost: 0, chip: null, armband: 1, autosubs: [] });
const row = (gw, rec_id, counted, [g, a, b0, b1], x, team = HASH) => ({
	schema: "gaffer.outcome/1", rec_id, team_id_hash: team, season: "2026/27", gw, deadline: `2026-10-${String(gw * 2).padStart(2, "0")}T17:30:00Z`, created_at: "2026-10-01T10:00:00Z",
	model: "anthropic/claude-sonnet-5-5", snapshot_id: `2026-27/${gw}/x`, counted, status: "scored",
	recommended: { ...scored(g), expected_points: x }, actual: { points: a, gross: a, hit_cost: 0, chip: null, recomputed: a, matches: true },
	baselines: { B0: { ...scored(b0), transfers: [] }, B1: { ...scored(b1), transfers: [[1, 2]] } }, gaffer_lib: "0.6.0",
});

export const OUTCOMES = [
	row(6, "01REC6", true, [55, 48, 62, 57], 60.2),
	row(7, "01REC7EARLY", false, [40, 51, 45, 44], 58),
	row(7, "01REC7", true, [71, 51, 45, 44], 62.5),
	row(6, "01OTHER6", true, [99, 10, 10, 10], 50, OTHER),
];
/** What the Scorecard must show for team 1: the counted rows' sums. */
export const TOTALS = { gaffer: 126, actual: 99, b0: 107, b1: 101, expected: 122.7 };

const ledger = (gw, rec_id, model = "anthropic/claude-sonnet-5-5", team = HASH) => ({
	rec_id, created_at: "2026-10-20T10:00:00Z", team_id_hash: team, season: "2026/27", gw, deadline: "2026-10-23T17:30:00Z", snapshot_id: `2026-27/${gw}/x`, model,
	gaffer_lib: "0.6.0", confidence: "medium", transfers: [], captain: 1, chip: null, expected_points_gw: 58, session_file: null,
});
export const LEDGER = [ledger(6, "01REC6"), ledger(7, "01REC7EARLY"), ledger(7, "01REC7"), ledger(8, "01REC8A"), ledger(8, "01REC8B"), ledger(8, "01FAUX8", "faux/faux-1"), ledger(8, "01OTHER8", undefined, OTHER)];

export function writeScorecard(dataDir) {
	mkdirSync(join(dataDir, "ledger"), { recursive: true });
	writeFileSync(join(dataDir, "ledger", "outcomes.jsonl"), `${OUTCOMES.map((r) => JSON.stringify(r)).join("\n")}\n`);
	writeFileSync(join(dataDir, "ledger", "recommendations.jsonl"), `${LEDGER.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
	writeScorecard(process.argv[2]);
	console.log(`wrote ${OUTCOMES.length} outcomes and ${LEDGER.length} ledger rows to ${process.argv[2]}/ledger`);
}
