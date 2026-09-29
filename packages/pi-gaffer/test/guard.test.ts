import { describe, expect, it } from "vitest";
import { checkFplRequest, checkToolCall } from "../src/guard.ts";

describe("checkFplRequest (FR-ACC-01)", () => {
	it.each([
		"bootstrap-static/",
		"fixtures/",
		"entry/1/",
		"entry/123456/history/",
		"entry/123456/transfers/",
		"entry/123456/event/5/picks/",
		"element-summary/430/",
	])("allows GET %s", (path) => {
		expect(checkFplRequest("GET", path)).toEqual({ ok: true });
	});

	it.each(["my-team/1/", "me/", "entry/1/../../my-team/1/", "accounts/login/", "transfers/", "leagues-classic/1/standings/", "entry/abc/"])(
		"blocks GET %s",
		(path) => {
			const r = checkFplRequest("GET", path);
			expect(r.ok).toBe(false);
			expect(r.ok === false && r.reason).toMatch(/read-only/);
		},
	);

	it.each(["POST", "PUT", "DELETE", "PATCH"])("blocks %s even on an allowed path", (method) => {
		expect(checkFplRequest(method, "entry/1/").ok).toBe(false);
	});
});

describe("checkToolCall (tool_call guard)", () => {
	it("blocks any tool call that references FPL account endpoints", () => {
		expect(checkToolCall("bash", { command: "curl https://fantasy.premierleague.com/api/my-team/1/" })?.block).toBe(true);
		expect(checkToolCall("bash", { command: "python -c \"import urllib.request as u; u.urlopen('https://fantasy.premierleague.com/api/me/')\"" })?.block).toBe(true);
		expect(checkToolCall("write", { path: "/work/x.py", content: "URL='https://users.premierleague.com/accounts/login/'" })?.block).toBe(true);
	});
	it("blocks writes and edits to the read-only data paths", () => {
		expect(checkToolCall("write", { path: "/data/snapshots/2026-27/6/x.json", content: "{}" })?.block).toBe(true);
		expect(checkToolCall("edit", { path: "/data/users/abc/prefs.json", edits: [] })?.block).toBe(true);
		expect(checkToolCall("write", { path: "../data/x", content: "" })?.block).toBe(true);
	});
	it("allows ordinary sandbox work", () => {
		expect(checkToolCall("bash", { command: "python -c 'print(2+2)'" })).toBeUndefined();
		expect(checkToolCall("write", { path: "/work/plan.py", content: "print(1)" })).toBeUndefined();
		expect(checkToolCall("read", { path: "/data/snapshots/2026-27/6/x/bootstrap-static.json" })).toBeUndefined();
		expect(checkToolCall("fpl_snapshot", { team_id: 1 })).toBeUndefined();
	});
});
