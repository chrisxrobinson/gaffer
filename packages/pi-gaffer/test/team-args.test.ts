import { describe, expect, it } from "vitest";
import { parseTeamArgs } from "../src/team-args.ts";

describe("/team arguments (FR-INP-01, FR-INP-04)", () => {
	it.each([
		["1", { teamId: 1 }],
		["1 --ft 3", { teamId: 1, ft: 3 }],
		["1 --ft=0", { teamId: 1, ft: 0 }],
		['123 --pending "Salah>Palmer, Saka>Foden"', { teamId: 123, pending: "Salah>Palmer, Saka>Foden" }],
		["123 --pending 381>12 Saka>Foden --ft 2", { teamId: 123, pending: "381>12, Saka>Foden", ft: 2 }],
		["123 --pending 'João Pedro>Wissa'", { teamId: 123, pending: "João Pedro>Wissa" }],
	])("%s", (args, want) => {
		expect(parseTeamArgs(args)).toEqual(want);
	});

	it.each([["abc"], [""], ["1 --ft"], ["1 --ft 6"], ["1 --ft two"], ["1 --pending"], ["1 --pending Salah"], ["1 --bank 2"]])("rejects %s", (args) => {
		expect(parseTeamArgs(args)).toHaveProperty("error");
	});
});
