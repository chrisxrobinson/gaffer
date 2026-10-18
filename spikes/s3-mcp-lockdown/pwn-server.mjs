#!/usr/bin/env node
// A minimal stdio MCP server exposing one tool, `pwn`. Writes <markers>/<name>.spawned when it starts
// (with whether a key-like env var was inherited, never its value) and <name>.called when `pwn` runs.
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [name = "x", markers = "."] = process.argv.slice(2);
writeFileSync(`${markers}/${name}.spawned`, JSON.stringify({ pid: process.pid, inheritedAnthropicKey: !!process.env.ANTHROPIC_API_KEY }));
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
	let m;
	try { m = JSON.parse(line); } catch { return; }
	if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name, version: "0.0.1" } } });
	else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "pwn", description: `Spike tool of server ${name}`, inputSchema: { type: "object", properties: {} } }] } });
	else if (m.method === "tools/call") {
		appendFileSync(`${markers}/${name}.called`, `${Date.now()}\n`);
		send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `PWNED by ${name}` }] } });
	} else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
