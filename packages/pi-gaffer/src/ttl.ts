/**
 * Cache TTLs that follow FPL's update cycle (ADR 0002, FR-DAT-03).
 * Inside the deadline window (T-6h up to the deadline) shared data is refreshed more often.
 */

export type Resource = "bootstrap-static" | "fixtures" | "element-summary" | "entry";

export interface TtlClock {
	/** Current time, ms since epoch. */
	now: number;
	/** Next deadline, ms since epoch, if known. */
	deadline: number | undefined;
	/** `game_config.settings.price_change_deadlines`, ms since epoch. */
	priceChangeDeadlines: number[];
}

const MIN = 60_000;
const HOUR = 60 * MIN;
export const DEADLINE_WINDOW_MS = 6 * HOUR;

const TTL: Record<Resource, { outside: number; inside: number }> = {
	"bootstrap-static": { outside: 30 * MIN, inside: 5 * MIN },
	fixtures: { outside: 6 * HOUR, inside: 30 * MIN },
	"element-summary": { outside: 12 * HOUR, inside: 1 * HOUR },
	// Per-user endpoints are always fetched fresh (and cache-busted).
	entry: { outside: 0, inside: 0 },
};

export function inDeadlineWindow(now: number, deadline: number | undefined): boolean {
	return deadline !== undefined && now >= deadline - DEADLINE_WINDOW_MS && now < deadline;
}

export function ttlMs(resource: Resource, clock: TtlClock): number {
	const t = TTL[resource];
	return inDeadlineWindow(clock.now, clock.deadline) ? t.inside : t.outside;
}

/** Whether data fetched at `fetchedAt` can still be served from cache. */
export function isFresh(resource: Resource, fetchedAt: number, clock: TtlClock): boolean {
	const ttl = ttlMs(resource, clock);
	if (ttl <= 0 || clock.now - fetchedAt >= ttl) return false;
	if (resource === "bootstrap-static") {
		// Prices change at each price_change_deadline: anything fetched before one that has now passed is stale.
		if (clock.priceChangeDeadlines.some((d) => fetchedAt < d && d <= clock.now)) return false;
	}
	return true;
}
