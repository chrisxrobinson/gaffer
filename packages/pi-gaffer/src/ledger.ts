/**
 * `/data/ledger/recommendations.jsonl`, the index of recommendations (ADR 0004), as gaffer-eval and
 * `gaffer admin` read it.
 *
 * Test rows: a recommendation made by Pi's scripted faux provider (`model` "faux/…") is a test of the
 * machinery, not advice anyone saw. M4's stack check wrote such rows into the real ledger; they are
 * kept (the ledger is append-only) but never scored or counted. The stack check now uses a scratch
 * data directory, and the eval suite writes to its own.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LedgerRow {
	rec_id: string;
	created_at: string;
	team_id_hash: string;
	season: string;
	gw: number;
	deadline: string;
	snapshot_id: string;
	model: string;
	gaffer_lib: string;
	confidence: string;
	transfers: number[][];
	captain: number;
	chip: string | null;
	expected_points_gw: number;
	session_file: string | null;
}

export const isTestRow = (row: Pick<LedgerRow, "model">): boolean => row.model.startsWith("faux/");

export function readLedger(dataDir: string): LedgerRow[] {
	const file = join(dataDir, "ledger", "recommendations.jsonl");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.flatMap((l) => {
			try {
				return [JSON.parse(l) as LedgerRow];
			} catch {
				return [];
			}
		});
}
