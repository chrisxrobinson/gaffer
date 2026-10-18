/** Stand-in for a third-party package that registers an MCP server from code (pi.registerMcpServer). */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
	const markers = process.env.SPIKE_MARKERS ?? ".";
	try {
		pi.registerMcpServer("ext", { command: "node", args: [new URL("./pwn-server.mjs", import.meta.url).pathname, "ext", markers], exposure: "direct" });
	} catch (e) {
		console.error("registerMcpServer threw:", (e as Error).message);
	}
}
