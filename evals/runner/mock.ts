/**
 * A stand-in for fantasy.premierleague.com/api and football-data.co.uk that serves one built eval case
 * (evals/build/build_cases.py: `<case>/upstream/`). `fpl_snapshot` runs unchanged against it, so the
 * whole of Gaffer (fetch, validation, derive, snapshot, golden path, gate) runs on the case's data.
 *
 * - FPL: bootstrap-static, fixtures, event/{gw}/live for finished GWs, and the case team's entry,
 *   history, transfers and picks. Any other team is 404; element-summary is an empty history.
 * - football-data.co.uk at the root (the odds guard allows only /fixtures.csv and /mmz4281/<code>/E0.csv).
 * - `updating = true` makes the per-user endpoints answer like FPL during "the game is being updated"
 *   (HTML, 503), for the stale-data case.
 * The case's own result (event/{its gw}/live) is never served: it's in the future.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

export class CaseApi {
	readonly dir: string;
	readonly teamId: number;
	updating = false;
	hits: { path: string; status: number }[] = [];
	private server!: Server;
	base = "";

	constructor(caseDir: string, teamId: number) {
		this.dir = join(caseDir, "upstream");
		this.teamId = teamId;
	}

	get fplBase(): string {
		return `${this.base}/api/`;
	}
	get footballDataBase(): string {
		return `${this.base}/`;
	}

	private file(name: string): string | undefined {
		const f = join(this.dir, name);
		return existsSync(f) ? readFileSync(f, "utf8") : undefined;
	}

	/** The body for a path, or undefined for 404. */
	route(path: string): { status: number; type: string; body: string } | undefined {
		const json = (body: string | undefined) => (body === undefined ? undefined : { status: 200, type: "application/json", body });
		if (path === "fixtures.csv" || /^mmz4281\/\d{4}\/E0\.csv$/.test(path)) {
			const body = this.file(join("football-data", path));
			return body === undefined ? undefined : { status: 200, type: "text/csv", body };
		}
		if (!path.startsWith("api/")) return undefined;
		const p = path.slice(4);
		if (p === "bootstrap-static/") return json(this.file("bootstrap-static.json"));
		if (p === "fixtures/") return json(this.file("fixtures.json"));
		let m = /^event\/(\d+)\/live\/$/.exec(p);
		if (m) return json(this.file(`live-${m[1]}.json`));
		m = /^element-summary\/(\d+)\/$/.exec(p);
		if (m) return { status: 200, type: "application/json", body: JSON.stringify({ fixtures: [], history: [], history_past: [] }) };
		m = /^entry\/(\d+)\/(.*)$/.exec(p);
		if (!m || Number(m[1]) !== this.teamId) return undefined;
		if (this.updating) return { status: 503, type: "text/html", body: "<html><body>The game is being updated.</body></html>" };
		const rest = m[2];
		if (rest === "") return json(this.file("entry.json"));
		if (rest === "history/") return json(this.file("history.json"));
		if (rest === "transfers/") return json(this.file("transfers.json"));
		m = /^event\/(\d+)\/picks\/$/.exec(rest);
		if (m) return json(this.file(`picks-${m[1]}.json`));
		return undefined;
	}

	async start(): Promise<this> {
		this.server = createServer((req, res) => {
			const path = (req.url ?? "").replace(/^\//, "").replace(/\?.*$/, "");
			const r = req.method === "GET" ? this.route(path) : { status: 405, type: "text/plain", body: "GET only" };
			const status = r?.status ?? 404;
			this.hits.push({ path, status });
			res.writeHead(status, { "content-type": r?.type ?? "application/json", age: "0" }).end(r?.body ?? JSON.stringify({ detail: "Not found." }));
		});
		await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
		this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
		return this;
	}

	stop(): Promise<void> {
		return new Promise((resolve) => this.server.close(() => resolve()));
	}
}
