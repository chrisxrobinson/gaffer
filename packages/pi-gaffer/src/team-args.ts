/** `/team <id> [--ft N] [--pending "OUT>IN, OUT>IN"]` (FR-INP-01, FR-INP-04). */

export interface TeamArgs {
	teamId: number;
	ft?: number;
	pending?: string;
}

export const TEAM_USAGE = 'Usage: /team <id> [--ft N] [--pending "Salah>Palmer, Saka>Foden"] — your FPL team ID is the number in the URL of your Points page. --ft sets your free transfers for the next GW (FPL doesn\'t publish them); --pending lists transfers you\'ve already made for it.';

/** Split on whitespace, keeping "double" or 'single' quoted runs together. */
function tokens(s: string): string[] {
	const out: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] ?? m[2] ?? m[3]);
	return out;
}

export function parseTeamArgs(args: string): TeamArgs | { error: string } {
	const t = tokens(args.trim());
	const raw = t.shift() ?? "";
	if (!/^\d{1,10}$/.test(raw)) return { error: TEAM_USAGE };
	const out: TeamArgs = { teamId: Number(raw) };
	while (t.length) {
		let flag = t.shift()!;
		let value: string | undefined;
		const eq = flag.indexOf("=");
		if (flag.startsWith("--") && eq > 0) {
			value = flag.slice(eq + 1);
			flag = flag.slice(0, eq);
		}
		if (flag === "--ft") {
			value ??= t.shift();
			if (!value || !/^\d$/.test(value) || Number(value) > 5) return { error: `--ft needs a number of free transfers from 0 to 5, got "${value ?? ""}".` };
			out.ft = Number(value);
		} else if (flag === "--pending") {
			// Everything up to the next flag, so unquoted "Salah>Palmer Saka>Foden" also works.
			const parts: string[] = value !== undefined ? [value] : [];
			while (t.length && !t[0].startsWith("--")) parts.push(t.shift()!);
			const spec = parts.join(",").split(/[,;]/).map((p) => p.trim()).filter(Boolean);
			if (!spec.length || spec.some((p) => !/^[^>]+>[^>]+$/.test(p))) return { error: `--pending needs transfers like "Salah>Palmer, Saka>Foden" (OUT>IN, names or player ids).` };
			out.pending = spec.join(", ");
		} else {
			return { error: `Unknown option "${flag}". ${TEAM_USAGE}` };
		}
	}
	return out;
}
