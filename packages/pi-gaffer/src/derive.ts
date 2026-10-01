/**
 * Derived team state (ARCHITECTURE §2.2): fpl_snapshot runs `python -m gaffer_lib derive` in the
 * sandbox against the snapshot it just wrote, so the rules have one implementation (ADR 0002).
 */
import { type SandboxSession, sandboxRun, shellQuote } from "./sandbox.ts";

export interface DerivedPlayer {
	id: number;
	name: string;
	team: string;
	position: "GKP" | "DEF" | "MID" | "FWD";
	pick_position: number;
	is_captain: boolean;
	is_vice_captain: boolean;
	now_cost: number;
	purchase_price: number | null;
	purchase_source: string;
	purchase_gw: number;
	selling_price: number;
}

/** The subset of gaffer.derived/1 the harness uses. Money in tenths of £1m. */
export interface Derived {
	schema: "gaffer.derived/1";
	gaffer_lib_version: string;
	gw: { current: number | null; next: number | null; deadline: string | null };
	squad_basis_gw: number | null;
	bank: number | null;
	squad_value: number;
	selling_value: number;
	budget: number;
	squad: DerivedPlayer[];
	free_transfers: { value: number | null; source: "derived" | "user"; derived: number | null; confidence: string; unlimited?: boolean };
	pending: null | {
		transfers: { out: number; out_name: string; in: number; in_name: string; in_price: number }[];
		count: number;
		hits: number;
		hit_cost: number;
		ft_remaining: number | null;
		bank_after: number;
		violations: { code: string; message: string }[];
	};
	chips: { name: string; half: 1 | 2; window: [number, number]; used_in: number | null; available: boolean }[];
	blanks_doubles: Record<string, { blank: string[]; double: string[] }>;
	assumptions: { free_transfers: number | null; ft_source: "derived" | "user"; pending_transfers: [number, number][] };
	warnings: string[];
}

export interface DeriveOptions {
	ft?: number;
	pending?: string;
	signal?: AbortSignal;
}

export type DeriveFn = (snapshotDir: string, opts: DeriveOptions) => Promise<Derived>;

/** The user's input was rejected (e.g. an unknown player in --pending): exit status 2 with a message. */
export class DeriveInputError extends Error {
	override name = "DeriveInputError";
}

/** How to invoke gaffer_lib in the sandbox. Tests on a host sandboxd point this at the repo source. */
export function gafferLibCommand(env: NodeJS.ProcessEnv = process.env): string {
	return env.GAFFER_LIB_CMD ?? "python -m gaffer_lib";
}

export function deriveCommand(snapshotDir: string, opts: DeriveOptions, lib = gafferLibCommand()): string {
	let cmd = `${lib} derive --snapshot ${shellQuote(snapshotDir)}`;
	if (opts.ft !== undefined) cmd += ` --ft ${Math.trunc(opts.ft)}`;
	if (opts.pending) cmd += ` --pending ${shellQuote(opts.pending)}`;
	return cmd;
}

export function sandboxDerive(session: SandboxSession): DeriveFn {
	return async (snapshotDir, opts) => {
		const { exitCode, output } = await sandboxRun(session, deriveCommand(snapshotDir, opts), { timeoutS: 60, signal: opts.signal });
		// The JSON document is the last line that parses; anything before it is stderr noise.
		const lines = output.trim().split("\n").reverse();
		let doc: unknown;
		for (const l of lines) {
			if (!l.startsWith("{")) continue;
			try {
				doc = JSON.parse(l);
				break;
			} catch {
				/* keep looking */
			}
		}
		const err = (doc as { error?: string } | undefined)?.error;
		if (exitCode === 2 && err) throw new DeriveInputError(err.replace(/^DeriveError: /, ""));
		if (exitCode !== 0 || !doc || err) throw new Error(`gaffer_lib derive failed (exit ${exitCode}): ${err ?? output.trim().slice(-300)}`);
		return doc as Derived;
	};
}
