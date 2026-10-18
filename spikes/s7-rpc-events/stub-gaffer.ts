/**
 * S7: a stub with the *shapes* of Gaffer's extensions (no sandbox, no FPL), to see what
 * `pi --mode rpc` 1.3.0 puts on the wire for each of them.
 *
 * - fpl_snapshot: progress via onUpdate, then {content:[text], details: SnapshotDetails-like}; appendEntry("gaffer.snapshot").
 * - bash: Pi's own bash tool definition with fake streaming operations (as gaffer-sandbox does with sandboxd).
 * - submit_recommendation: terminating; throws on the first (bad) attempt, returns details.recommendation on the second; renderResult.
 * - /team (appendEntry + notify), /pick (select dialog, custom(), component widget), user_bash block,
 *   setStatus/setWidget/setTitle, a budget-style steer message, and a proposed "gaffer.run" record.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createBashToolDefinition, defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const HERE = import.meta.dirname;
const REC = JSON.parse(readFileSync(join(HERE, "fixtures", "recommendation.json"), "utf8"));
const BLOCK_USER_BASH = process.env.S7_BLOCK_USER_BASH !== "0";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SNAPSHOT_DETAILS = {
	snapshot_id: "2024-25/10/20241101T090019Z-cea317422424",
	snapshot_path: "/data/snapshots/s7",
	snapshot_hash: "0".repeat(64),
	team_id_hash: REC.team_id_hash,
	season: "2024/25",
	fetched_at: "2024-11-01T09:00:18.195Z",
	stale: false,
	stale_reason: null,
	gw: { current: 9, next: 10, deadline: "2024-11-02T11:00:00Z" },
	team_name: "S7 XI",
	bank: 0,
	squad_value: 100.4,
	budget: 100.4,
	free_transfers: { value: 5, source: "derived", derived: 5, confidence: "high" },
	chips: [
		{ name: "wildcard", available: true },
		{ name: "bboost", available: true },
	],
	odds: { requested: true, available: true, fixtures: 10, reason: null },
	run_command: "python -m gaffer_lib run --snapshot /data/snapshots/s7 --out /work/plan.json",
	warnings: [],
};

export default function stubGaffer(pi: ExtensionAPI) {
	let turns = 0;
	let steered = false;

	pi.on("session_start", async (_e, ctx) => {
		ctx.ui.setTitle("Gaffer (S7 stub)");
		ctx.ui.setStatus("gaffer", "no team set");
	});

	pi.on("agent_start", async () => {
		turns = 0;
	});

	// Proposed for UI 2's structured start: the bridge sends `/run {json}`; the command validates it, records a
	// "gaffer.run" entry (-> entry_appended) and starts the run with a prompt rendered server-side.
	pi.registerCommand("run", {
		description: "S7: structured start: /run {\"action\":\"recommend\",\"team_id\":N,\"risk\":\"balanced\"}",
		handler: async (args, ctx) => {
			let spec: { action?: string; team_id?: number; risk?: string };
			try {
				spec = JSON.parse(args);
			} catch {
				return ctx.ui.notify("run: invalid JSON", "error");
			}
			if (spec.action !== "recommend" || !Number.isInteger(spec.team_id)) return ctx.ui.notify("run: unsupported action", "error");
			pi.appendEntry("gaffer.run", { action: spec.action, team_id_hash: REC.team_id_hash, gw: 10, risk: spec.risk ?? "balanced", started_at: new Date().toISOString() });
			pi.sendUserMessage(`Recommend this GW for team ${spec.team_id}. Risk: ${spec.risk ?? "balanced"}.`);
		},
	});

	pi.on("turn_end", async (_e, ctx) => {
		turns++;
		pi.appendEntry("gaffer.budget", { session_cost: 0.01 * turns, turn: turns, soft: 0.15, hard: 0.3, capped: false });
		if (turns === 2 && !steered) {
			steered = true; // like gaffer-budget's soft-cap steer
			pi.sendMessage({ customType: "gaffer.steer", content: "[budget] Soft cap reached: wrap up and submit.", display: true }, { deliverAs: "steer" });
		}
		ctx.ui.setStatus("gaffer-budget", `turn ${turns} · $${(0.01 * turns).toFixed(2)}`);
	});

	if (BLOCK_USER_BASH) {
		pi.on("user_bash", async (_e, ctx) => {
			ctx.ui.notify("Shell commands are disabled in Gaffer (S7 stub).", "warning");
			return { result: { output: "Shell commands are disabled in Gaffer (S7 stub).", exitCode: 1, cancelled: false, truncated: false } };
		});
	}

	pi.registerCommand("team", {
		description: "Set your FPL team: /team <id>",
		handler: async (args, ctx) => {
			const id = Number(args.trim());
			if (!Number.isInteger(id) || id < 1) return ctx.ui.notify("Usage: /team <id>", "warning");
			pi.appendEntry("gaffer.team", { team_id: id, team_name: "S7 XI" });
			ctx.ui.setStatus("gaffer", `team S7 XI (${id}) · GW10`);
			ctx.ui.notify(`Team set: S7 XI (ID ${id}).`, "info");
		},
	});

	pi.registerCommand("pick", {
		description: "S7: exercise a dialog, custom() and a component widget over RPC",
		handler: async (_args, ctx) => {
			const choice = await ctx.ui.select("Risk appetite?", ["safe", "balanced", "aggressive"], { timeout: 5000 });
			const custom = await ctx.ui.custom(() => ({ render: () => ["x"], invalidate() {} }) as never);
			ctx.ui.setWidget("s7-component", (() => ({ render: () => ["component"], invalidate() {} })) as never);
			ctx.ui.setWidget("s7-lines", ["Deadline: Sat 2 Nov 11:00", "5 FT · £0.0m ITB"], { placement: "belowEditor" });
			ctx.ui.notify(`pick: select=${JSON.stringify(choice)} custom=${JSON.stringify(custom)} mode=${ctx.mode} hasUI=${ctx.hasUI}`, "info");
		},
	});

	pi.registerTool(
		defineTool({
			name: "fpl_snapshot",
			label: "FPL snapshot",
			description: "Fetch and snapshot the user's FPL team and public FPL data (S7 stub).",
			parameters: Type.Object({ team_id: Type.Optional(Type.Integer()), include: Type.Optional(Type.Array(Type.String())) }),
			async execute(_id, _params, _signal, onUpdate, ctx) {
				for (const stage of ["bootstrap-static", "fixtures", "entry picks", "odds", "derive"]) {
					onUpdate?.({ content: [{ type: "text", text: `fetching ${stage}` }], details: { stage } });
					await sleep(40);
				}
				pi.appendEntry("gaffer.snapshot", { snapshot_id: SNAPSHOT_DETAILS.snapshot_id, gw: SNAPSHOT_DETAILS.gw, free_transfers: 5, stale: false });
				ctx.ui.setWidget("gaffer-deadline", ["GW10 deadline: Sat 2 Nov 2024 11:00 UTC"]);
				return {
					content: [{ type: "text", text: "Snapshot 2024-25/10/...: S7 XI, GW10, 5 FT, £0.0m ITB, deadline 2024-11-02T11:00:00Z. Run: python -m gaffer_lib run ..." }],
					details: SNAPSHOT_DETAILS,
				};
			},
		}),
	);

	// Pi's own bash definition, with operations that stream like sandboxd would.
	pi.registerTool(
		createBashToolDefinition("/work", {
			exposeSessionEnvironment: false,
			operations: {
				async exec(_command, _cwd, { onData }) {
					for (const line of ["loading snapshot", "model: xP for 680 players", "solver: HiGHS ... optimal", "plans: 5 ranked", "wrote /work/plan.json"]) {
						onData(Buffer.from(`${line}\n`));
						await sleep(150);
					}
					return { exitCode: 0 };
				},
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "submit_recommendation",
			label: "Recommendation",
			description: "Submit the final recommendation (S7 stub: validated, stored, shown; ends the run).",
			parameters: Type.Object({ attempt: Type.Integer(), plan_rank: Type.Integer(), bench: Type.Array(Type.Integer()) }),
			executionMode: "sequential",
			async execute(_id, params) {
				if (params.bench.length !== 4) {
					pi.appendEntry("gaffer.validation", { attempt: params.attempt, passed: false, stage: "validate", errors: [{ code: "BENCH", message: "bench must list 4 players, goalkeeper first" }] });
					throw new Error("Rejected (attempt 1 of 3): BENCH: bench must list 4 players, goalkeeper first. Fix it and resubmit.");
				}
				pi.appendEntry("gaffer.validation", { rec_id: REC.rec_id, attempt: params.attempt, passed: true, stage: "validate", errors: [] });
				pi.appendEntry("gaffer.recommendation", REC);
				return { content: [{ type: "text", text: `GW${REC.gw} recommendation ${REC.rec_id}: ${REC.summary}` }], details: { recommendation: REC }, terminate: true };
			},
			renderResult(_result, _options, _theme) {
				return { invalidate() {}, render: () => ["(TUI-only renderer)"] };
			},
		}),
	);
}
