// Spike S8 "product code": a Gaffer-shaped agent on pi-durable 1.3.0.
// Mirrors packages/pi-gaffer: a replaced preamble plus dynamic fpl_context/user_preferences sections (gaffer-core),
// bash routed to a sandbox (gaffer-sandbox), fpl_snapshot plus a tool-call guard (gaffer-data), and a terminating
// submit_recommendation that writes a typed document (gaffer-recommend). Throwaway code; stubs, no network.
import { appendFileSync } from "node:fs";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineExtension, defineTool, Harness, hook, section, ToolTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

// ─── Typed documents (Gaffer today: custom JSONL entries + /data files) ──────────────────────────
export const SnapshotDoc = defineDoc<{ snapshot_id?: string; team_id?: number; gw?: number }>({
	kind: "gaffer.snapshot", version: 1, scope: "conversation", history: "rewindable", fork: "asOf", initial: () => ({}),
});
export type Rec = { rec_id: string; gw: number; transfers: string[]; captain: string; snapshot_id: string };
export const RecommendationDoc = defineDoc<{ latest?: Rec; attempts: number }>({
	kind: "gaffer.recommendation", version: 1, scope: "conversation", history: "rewindable", fork: "asOf",
	initial: () => ({ attempts: 0 }),
});
// Preferences outlive conversations: Session scope (one per storage), not forked.
export const PrefsDoc = defineDoc<{ risk: string; keep: number[] }>({
	kind: "gaffer.prefs", version: 1, scope: "session", initial: () => ({ risk: "balanced", keep: [] }),
});

// ─── Side-effect log: survives SIGKILL, shows which executions ran (and reran) ────────────────────
export const effects = (dir: string) => (line: string) => appendFileSync(`${dir}/effects.log`, `${process.pid} ${line}\n`);

// ─── Stub "sandboxd": streams output like POST /exec (NDJSON), the place a crash can land ─────────
export type SandboxHooks = { onLine?: (n: number) => void };
async function sandboxExec(command: string, onChunk: (s: string) => void, hooks: SandboxHooks, signal?: AbortSignal) {
	const lines = command.includes("gaffer_lib run") ? 8 : 2;
	for (let n = 1; n <= lines; n++) {
		await new Promise((r) => setTimeout(r, 150));
		signal?.throwIfAborted();
		onChunk(`[sandbox] ${command.slice(0, 40)} step ${n}/${lines}\n`);
		hooks.onLine?.(n);
	}
	return { exitCode: 0 };
}

const ACCOUNT_ENDPOINT = /fantasy\.premierleague\.com\/api\/(me|my-team|entry\/\d+\/transfers)/;

export function gafferExtensions(opts: { log: (l: string) => void; bashReplay: "safe" | "unsafe"; sandbox: SandboxHooks }) {
	const fplSnapshot = defineTool({
		name: "fpl_snapshot",
		description: "Fetch the user's FPL team and public data, store an immutable snapshot, return a summary.",
		parameters: Type.Object({ team_id: Type.Integer({ minimum: 1 }) }),
		replay: "safe", // a read plus an immutable, content-addressed snapshot: safe to rerun
		execute: async (args, api, ctx) => {
			opts.log(`start fpl_snapshot ${api.callId}`);
			const snapshot_id = `snap-${args.team_id}-gw9`;
			await api.commit(async (tx) => Object.assign(await tx.doc(SnapshotDoc, api.conversationId), { snapshot_id, team_id: args.team_id, gw: 9 }), ctx);
			opts.log(`end fpl_snapshot ${api.callId}`);
			return { output: [{ type: "text", text: `Squad: Raya, Saliba, Gabriel, Salah, Palmer, Haaland… Bank 0.5, FT 1. Snapshot ${snapshot_id}.` }], details: { snapshot_id } };
		},
	});
	const bash = defineTool({
		name: "bash",
		description: "Run a shell command in the no-network Python sandbox (gaffer_lib, HiGHS).",
		parameters: Type.Object({ command: Type.String() }),
		replay: opts.bashReplay,
		execute: async (args, api, ctx) => {
			opts.log(`start bash ${api.callId} ${args.command.slice(0, 30)}`);
			const { exitCode } = await sandboxExec(args.command, (s) => api.output(s), opts.sandbox, ctx.abortSignal);
			opts.log(`end bash ${api.callId}`);
			return { isError: exitCode !== 0 };
		},
	});
	const submitRecommendation = defineTool({
		name: "submit_recommendation",
		description: "Submit the final recommendation; it is validated, stored and shown, and the run ends.",
		parameters: Type.Object({ transfers: Type.Array(Type.String()), captain: Type.String() }),
		executionMode: "sequential",
		execute: async (args, api, ctx) => {
			opts.log(`start submit_recommendation ${api.callId}`);
			const snap = await api.snapshot(SnapshotDoc, api.conversationId, ctx);
			if (!snap?.snapshot_id) throw new Error("No snapshot in this conversation: call fpl_snapshot first.");
			const rec: Rec = { rec_id: `rec-${api.taskId}`, gw: snap.gw ?? 0, snapshot_id: snap.snapshot_id, ...args };
			await api.commit(async (tx) => {
				const doc = await tx.doc(RecommendationDoc, api.conversationId);
				doc.latest = rec;
				doc.attempts += 1;
			}, ctx);
			opts.log(`end submit_recommendation ${api.callId}`);
			return { output: [{ type: "text", text: `Recommendation ${rec.rec_id} saved.` }], details: { recommendation: rec }, control: { terminate: true } };
		},
	});

	return defineExtension({
		name: "gaffer",
		tools: [fplSnapshot, bash, submitRecommendation],
		sections: [
			section("preamble", () => "You are Gaffer, a Fantasy Premier League advisor. Run code only in the sandbox.", { tag: false }),
			section("fpl_context", async (input, ctx: Context) => {
				const s = await input.read.snapshot(SnapshotDoc, input.conversationId, ctx);
				return s?.snapshot_id ? `Team ${s.team_id}, GW${s.gw}, latest snapshot ${s.snapshot_id}.` : "No snapshot yet: call fpl_snapshot first.";
			}),
			section("user_preferences", async (input, ctx: Context) => JSON.stringify(await input.read.snapshot(PrefsDoc, ctx) ?? {})),
		],
		hooks: [
			// gaffer-data's tool_call guard: no FPL account endpoints, no writes to /data.
			hook(ToolTask, {
				beforeTool: (call) => {
					const text = JSON.stringify(call.arguments);
					if (ACCOUNT_ENDPOINT.test(text)) return { block: "FPL account endpoints are not allowed (read-only policy)." };
					if (call.name === "bash" && /(^|\s)(>|tee)\s*\/data/.test(text)) return { block: "/data is read-only." };
					return undefined;
				},
			}),
		],
	});
}

// ─── Host: storage, registry, model ──────────────────────────────────────────────────────────────
export async function openGaffer(dbPath: string, opts: Parameters<typeof gafferExtensions>[0] & { responses: FauxResponseStep[]; tokensPerSecond?: number }, ctx: Context) {
	const faux = fauxProvider({ models: [{ id: "faux-sonnet", reasoning: true }], tokensPerSecond: opts.tokensPerSecond });
	faux.setResponses(opts.responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(gafferExtensions(opts));
	const harness = await Harness.open(await openNodeSqliteStorage(dbPath), { models, registry }, ctx);
	const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-sonnet" }, thinkingLevel: "medium" } });
	return { harness, root, faux };
}
