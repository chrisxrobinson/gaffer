/**
 * gaffer-web, the Gaffer App's bridge (ADR 0014): run by the harness entrypoint beside ttyd, bound like ttyd to
 * the egress interface and published on the host's 127.0.0.1 only.
 *
 *   node server.ts --host <ip> [--port 7682]                       the App over the real session store
 *   node server.ts --replay events.jsonl [--speed 4] [--port 7682]  a recorded run, no Pi, no model (dev)
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createBridge } from "./src/bridge.ts";
import { replaySource } from "./src/replay.ts";

const { values } = parseArgs({
	options: {
		host: { type: "string", default: "127.0.0.1" },
		port: { type: "string", default: "7682" },
		replay: { type: "string" },
		speed: { type: "string", default: "1" },
		sessions: { type: "string", default: process.env.GAFFER_SESSIONS_DIR ?? "/sessions" },
		data: { type: "string", default: process.env.GAFFER_DATA_DIR ?? "/data" },
	},
});
const here = import.meta.dirname;
const replay = values.replay ? replaySource(resolve(values.replay), Number(values.speed)) : undefined;
// Replay mode serves axe-core (a dev dependency) for the accessibility check, when it is installed.
const axe = join(here, "node_modules", "axe-core", "axe.min.js");
const bridge = createBridge({
	sessionsDir: replay ? mkdtempSync(join(tmpdir(), "gaffer-web-replay-")) : values.sessions!,
	dataDir: values.data!,
	publicDir: join(here, "public"),
	...(replay && { spawnPi: replay.spawn, replay: replay.api, devFiles: existsSync(axe) ? { "/dev/axe.min.js": axe } : {} }),
});
bridge.server.listen(Number(values.port), values.host, () => console.log(`gaffer-web on http://${values.host}:${values.port}${replay ? ` (replay of ${values.replay})` : ""}`));
for (const sig of ["SIGTERM", "SIGINT"] as const) {
	process.on(sig, () => {
		void bridge.close().finally(() => process.exit(0));
	});
}
