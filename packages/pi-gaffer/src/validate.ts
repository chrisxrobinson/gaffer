/**
 * Schema and invariant validation of fetched FPL data (FR-DAT-06). Failures are hard errors
 * that name each failed check; we never analyse data we don't understand.
 */
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import * as S from "./schema/fpl.ts";

export class FplDataError extends Error {
	override name = "FplDataError";
	readonly failures: { check: string; message: string }[];
	constructor(failures: { check: string; message: string }[]) {
		super(`FPL data failed validation:\n${failures.map((f) => `- [${f.check}] ${f.message}`).join("\n")}`);
		this.failures = failures;
	}
	get checks(): string[] {
		return this.failures.map((f) => f.check);
	}
}

const compiled = new Map<TSchema, ReturnType<typeof Compile>>();
function schemaErrors(name: string, schema: TSchema, value: unknown): { check: string; message: string }[] {
	let c = compiled.get(schema);
	if (!c) compiled.set(schema, (c = Compile(schema)));
	if (c.Check(value)) return [];
	return [...c.Errors(value)].slice(0, 5).map((e) => {
		const missing = (e.params as { requiredProperties?: string[] })?.requiredProperties;
		const where = e.instancePath || "/";
		return { check: `schema:${name}`, message: `${where}: ${e.message}${missing ? ` (${missing.join(", ")})` : ""}` };
	});
}

export const KNOWN_CHIPS = ["wildcard", "freehit", "bboost", "3xc"] as const;

export interface Dataset {
	bootstrap: unknown;
	fixtures: unknown;
	entry?: unknown;
	history?: unknown;
	transfers?: unknown;
	picks?: unknown;
}

export interface DatasetFlags {
	/** GW → teams with no fixture. */
	blanks: Record<number, number[]>;
	/** GW → teams with two or more fixtures. */
	doubles: Record<number, number[]>;
}

export function validateDataset(d: Dataset): DatasetFlags {
	const failures = [
		...schemaErrors("bootstrap-static", S.Bootstrap, d.bootstrap),
		...schemaErrors("fixtures", S.Fixtures, d.fixtures),
		...(d.entry === undefined ? [] : schemaErrors("entry", S.Entry, d.entry)),
		...(d.history === undefined ? [] : schemaErrors("history", S.History, d.history)),
		...(d.transfers === undefined ? [] : schemaErrors("transfers", S.Transfers, d.transfers)),
		...(d.picks === undefined ? [] : schemaErrors("picks", S.Picks, d.picks)),
	];
	// Invariants only make sense on data whose shape is right.
	if (failures.length) throw new FplDataError(failures);

	const fail = (check: string, message: string) => failures.push({ check, message });
	const b = d.bootstrap as S.Bootstrap;
	const teamIds = new Set(b.teams.map((t) => t.id));
	const elements = new Map(b.elements.map((e) => [e.id, e]));

	if (b.teams.length !== 20) fail("teams.count", `expected 20 teams, got ${b.teams.length}`);
	const next = b.events.filter((e) => e.is_next).length;
	const seasonOver = b.events.at(-1)?.is_current === true;
	if (next !== 1 && !(next === 0 && seasonOver)) fail("events.is_next", `expected exactly one is_next event, got ${next}`);
	if (b.events.filter((e) => e.is_current).length > 1) fail("events.is_current", "more than one is_current event");
	if (b.element_types.length !== 4) fail("element_types.count", `expected 4 element types, got ${b.element_types.length}`);
	if (b.chips.length !== 8) fail("chips.count", `expected 8 chip definitions, got ${b.chips.length}`);
	for (const c of b.chips) {
		if (!(KNOWN_CHIPS as readonly string[]).includes(c.name)) fail("chips.name", `unknown chip "${c.name}"`);
		if (c.start_event > c.stop_event || c.start_event < 1 || c.stop_event > b.events.length) fail("chips.window", `chip ${c.id} window ${c.start_event}–${c.stop_event} is invalid`);
	}
	for (const e of b.elements) {
		if (!teamIds.has(e.team) || e.element_type < 1 || e.element_type > 4) {
			fail("elements.ref", `element ${e.id} has team ${e.team} / type ${e.element_type}`);
			break;
		}
	}

	const fixtures = d.fixtures as S.Fixtures;
	for (const f of fixtures) {
		if (!teamIds.has(f.team_h) || !teamIds.has(f.team_a) || f.team_h === f.team_a) {
			fail("fixtures.team", `fixture ${f.id} has teams ${f.team_h} v ${f.team_a}`);
			break;
		}
	}
	const flags = blankAndDoubleGameweeks(fixtures, [...teamIds]);

	if (d.picks !== undefined) {
		const p = d.picks as S.Picks;
		if (p.picks.length !== 15) fail("picks.count", `expected 15 picks, got ${p.picks.length}`);
		const unknown = p.picks.filter((x) => !elements.has(x.element));
		if (unknown.length) fail("picks.element", `unknown element(s) ${unknown.map((x) => x.element).join(", ")}`);
		else if (p.picks.length === 15) {
			const counts = [1, 2, 3, 4].map((t) => p.picks.filter((x) => elements.get(x.element)!.element_type === t).length);
			const want = [1, 2, 3, 4].map((t) => b.element_types.find((et) => et.id === t)?.squad_select ?? 0);
			if (counts.join() !== want.join()) fail("picks.positions", `squad has ${counts.join("/")} GK/DEF/MID/FWD, expected ${want.join("/")}`);
		}
		if (new Set(p.picks.map((x) => x.position)).size !== p.picks.length) fail("picks.position", "duplicate pick positions");
		if (p.picks.filter((x) => x.is_captain).length !== 1 || p.picks.filter((x) => x.is_vice_captain).length !== 1) {
			fail("picks.captain", "expected exactly one captain and one vice-captain");
		}
	}

	if (failures.length) throw new FplDataError(failures);
	return flags;
}

/** Count fixtures per team per GW: a team with 0 is blank, ≥2 is double (FR-RUL-06 uses the same rule). */
export function blankAndDoubleGameweeks(fixtures: S.Fixtures, teamIds: number[]): DatasetFlags {
	const perGw = new Map<number, Map<number, number>>();
	for (const f of fixtures) {
		if (f.event === null) continue;
		const m = perGw.get(f.event) ?? new Map<number, number>();
		m.set(f.team_h, (m.get(f.team_h) ?? 0) + 1);
		m.set(f.team_a, (m.get(f.team_a) ?? 0) + 1);
		perGw.set(f.event, m);
	}
	const blanks: Record<number, number[]> = {};
	const doubles: Record<number, number[]> = {};
	for (const [gw, m] of perGw) {
		const b = teamIds.filter((t) => !m.has(t));
		const dbl = teamIds.filter((t) => (m.get(t) ?? 0) >= 2);
		if (b.length) blanks[gw] = b;
		if (dbl.length) doubles[gw] = dbl;
	}
	return { blanks, doubles };
}
