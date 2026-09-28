import { describe, expect, it } from "vitest";
import { FplDataError, validateDataset } from "../src/validate.ts";
import * as fx from "./fixtures.ts";

const dataset = () => ({
	bootstrap: fx.bootstrap(),
	fixtures: fx.fixtures(),
	entry: fx.entry(),
	history: fx.history(),
	transfers: fx.transfers(),
	picks: fx.picks(),
});

function failure(mutate: (d: ReturnType<typeof dataset>) => void): FplDataError {
	const d = dataset();
	mutate(d);
	try {
		validateDataset(d);
	} catch (e) {
		expect(e).toBeInstanceOf(FplDataError);
		return e as FplDataError;
	}
	throw new Error("expected validation to fail");
}

describe("validateDataset (FR-DAT-06)", () => {
	it("accepts a consistent dataset and reports no BGW/DGW", () => {
		expect(validateDataset(dataset())).toEqual({ blanks: {}, doubles: {} });
	});

	it("a missing elements[].now_cost is a schema error naming the field", () => {
		const e = failure((d) => delete (d.bootstrap.elements[7] as Record<string, unknown>).now_cost);
		expect(e.message).toMatch(/schema:bootstrap-static/);
		expect(e.message).toMatch(/\/elements\/7.*now_cost/);
	});

	it("14 picks fails the 15-picks invariant", () => {
		const e = failure((d) => d.picks.picks.pop());
		expect(e.checks).toContain("picks.count");
		expect(e.message).toMatch(/expected 15 picks, got 14/);
	});

	it("two is_next events fail the one-next-event invariant", () => {
		const e = failure((d) => (d.bootstrap.events[6].is_next = true));
		expect(e.checks).toContain("events.is_next");
		expect(e.message).toMatch(/exactly one is_next event, got 2/);
	});

	it("rejects anything other than 20 teams", () => {
		expect(failure((d) => d.bootstrap.teams.pop()).checks).toContain("teams.count");
	});

	it("rejects chip definitions that don't parse", () => {
		expect(failure((d) => d.bootstrap.chips.pop()).checks).toContain("chips.count");
		expect(failure((d) => ((d.bootstrap.chips[0] as Record<string, unknown>).name = "assistant_manager")).checks).toContain("chips.name");
		expect(failure((d) => (d.bootstrap.chips[0].start_event = 30)).checks).toContain("chips.window");
	});

	it("rejects a squad that isn't 2/5/5/3 or references unknown players", () => {
		expect(failure((d) => (d.picks.picks[0].element = fx.pid(20, 4))).checks).toContain("picks.positions");
		expect(failure((d) => (d.picks.picks[0].element = 99999)).checks).toContain("picks.element");
	});

	it("rejects a squad without exactly one captain and one vice", () => {
		expect(failure((d) => (d.picks.picks[4].is_captain = true)).checks).toContain("picks.captain");
	});

	it("rejects fixtures that reference unknown teams", () => {
		expect(failure((d) => ((d.fixtures[0] as { team_h: number }).team_h = 21)).checks).toContain("fixtures.team");
	});

	it("flags blank and double gameweeks instead of failing", () => {
		const d = dataset();
		const gw7 = d.fixtures.filter((f) => f.event === 7) as { team_h: number; team_a: number }[];
		const [a, b] = [gw7[0].team_h, gw7[0].team_a];
		const c = gw7[1].team_h;
		d.fixtures = d.fixtures.filter((f) => f !== gw7[0]); // a and b now blank in GW7
		d.fixtures.push({ ...gw7[1], id: 9999, team_h: a, team_a: c }); // a back to one game, c now has two
		const r = validateDataset(d);
		expect(r.blanks[7]).toEqual([b]);
		expect(r.doubles[7]).toEqual([c]);
	});

	it("reports every failed check together", () => {
		const e = failure((d) => {
			d.picks.picks.pop();
			d.bootstrap.events[6].is_next = true;
		});
		expect(e.checks).toEqual(expect.arrayContaining(["picks.count", "events.is_next"]));
	});
});
