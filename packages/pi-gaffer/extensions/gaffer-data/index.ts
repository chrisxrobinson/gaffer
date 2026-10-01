/**
 * gaffer-data: the fpl_snapshot tool and the read-only tool_call guard (ADR 0002).
 * The sandbox has no network, so this harness-side tool is the only way data gets in.
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { dataDir, idSalt } from "../../src/config.ts";
import { checkToolCall } from "../../src/guard.ts";
import { sandboxDerive } from "../../src/derive.ts";
import { FplClient } from "../../src/http.ts";
import { sharedSandboxSession } from "../../src/sandbox.ts";
import { fplState, type SnapshotEntry } from "../../src/session.ts";
import { takeSnapshot, type SnapshotDetails } from "../../src/snapshot.ts";
import { SnapshotStore } from "../../src/store.ts";

export default function gafferData(pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "fpl_snapshot",
			label: "FPL snapshot",
			description:
				"Fetch the user's FPL team and the public FPL data (players, fixtures, GW state, chips), validate it and store an immutable snapshot. " +
				"Returns a compact summary (squad with selling prices, bank, free transfers, chips, deadline, warnings), derived by gaffer_lib in the sandbox, and the snapshot path, which is readable (read-only) from the sandbox. " +
				"Per-user data is always fetched fresh; shared data is cached per FPL's update cycle. Never returns raw JSON: read the snapshot files with Python for detail. " +
					'With include: ["odds"] the snapshot also holds bookmaker odds; the summary ends with the gaffer_lib command that turns the snapshot into a full plan.',
			promptSnippet: "Fetch and snapshot the user's FPL team and public FPL data",
			parameters: Type.Object({
				team_id: Type.Optional(Type.Integer({ minimum: 1, description: "FPL team (entry) ID. Defaults to the team set with /team." })),
				element_summaries: Type.Optional(
					Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 20, description: "Player ids whose per-fixture history (element-summary) to include in the snapshot." }),
				),
				include: Type.Optional(
					Type.Array(Type.Union([Type.Literal("odds")]), {
						description: 'Extra sources. "odds": next-round bookmaker odds and past results from football-data.co.uk, used for team strength. Include it before running the golden path.',
					}),
				),
				force_fresh: Type.Optional(Type.Boolean({ description: "Bypass the shared-data cache. Only when the user asks for the very latest data." })),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				const state = fplState(ctx.sessionManager.getBranch());
				const teamId = params.team_id ?? state.teamId;
				// The /team --ft / --pending overrides apply to the team they were given for.
				const own = teamId === state.teamId;
				if (!teamId) throw new Error("No FPL team ID yet. Ask the user for it (the number in the URL of their FPL Points page), or they can run /team <id>.");
				const { text, details } = await takeSnapshot(
					{ teamId, elementSummaries: params.element_summaries, include: params.include, forceFresh: params.force_fresh, ft: own ? state.ft : undefined, pending: own ? state.pending : undefined, signal },
					{ client: new FplClient(), store: new SnapshotStore(dataDir()), salt: idSalt(), derive: sandboxDerive(sharedSandboxSession()) },
				);
				const entry: SnapshotEntry = {
					snapshot_id: details.snapshot_id,
					snapshot_path: details.snapshot_path,
					snapshot_hash: details.snapshot_hash,
					team_id: teamId,
					team_id_hash: details.team_id_hash,
					fetched_at: details.fetched_at,
					stale: details.stale,
					stale_reason: details.stale_reason,
					season: details.season,
					gw: details.gw,
					free_transfers: details.free_transfers?.value ?? null,
					ft_source: details.free_transfers?.source ?? null,
					pending_transfers: details.assumptions?.pending_transfers ?? [],
					odds: details.odds,
					ep_next: details.ep_next,
					endpoints: details.endpoints,
				};
				pi.appendEntry("gaffer.snapshot", entry);
				return { content: [{ type: "text", text }], details: details satisfies SnapshotDetails };
			},
		}),
	);

	// Read-only policy over every tool call: no FPL account endpoints anywhere, no writes to /data.
	pi.on("tool_call", async (event) => checkToolCall(event.toolName, event.input));
}
