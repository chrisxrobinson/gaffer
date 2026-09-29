import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as fx from "./fixtures.ts";

export type Route = { status?: number; body?: unknown; type?: string; age?: number };

/** A routed stand-in for fantasy.premierleague.com/api. Override any path to inject faults. */
export class MockFpl {
	server!: Server;
	base = "";
	hits: { t: number; path: string; url: string }[] = [];
	overrides = new Map<string, Route | ((n: number) => Route)>();
	data = {
		"bootstrap-static/": fx.bootstrap() as unknown,
		"fixtures/": fx.fixtures() as unknown,
		"entry/1/": fx.entry(1) as unknown,
		"entry/1/history/": fx.history() as unknown,
		"entry/1/transfers/": fx.transfers() as unknown,
		"entry/1/event/5/picks/": fx.picks(5) as unknown,
		"entry/1/event/4/picks/": fx.picks(4) as unknown,
	} as Record<string, unknown>;

	async start(): Promise<this> {
		this.server = createServer((req, res) => {
			const url = req.url ?? "";
			const path = url.replace(/^\/api\//, "").replace(/\?.*$/, "");
			this.hits.push({ t: Date.now(), path, url });
			const o = this.overrides.get(path) ?? this.overrides.get("*");
			const n = this.hits.filter((h) => h.path === path).length - 1;
			const r: Route = typeof o === "function" ? o(n) : (o ?? {});
			const status = r.status ?? (path in this.data ? 200 : 404);
			const body = r.body ?? (status === 200 ? this.data[path] : { detail: "Not found." });
			const headers: Record<string, string> = { "content-type": r.type ?? "application/json", age: String(r.age ?? 0) };
			res.writeHead(status, headers).end(typeof body === "string" ? body : JSON.stringify(body));
		});
		await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
		this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/api/`;
		return this;
	}

	count(path: string): number {
		return this.hits.filter((h) => h.path === path).length;
	}

	stop(): Promise<void> {
		return new Promise((r) => this.server.close(() => r()));
	}
}
