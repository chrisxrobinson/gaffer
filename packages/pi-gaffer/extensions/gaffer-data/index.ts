/**
 * gaffer-data: the fpl_snapshot tool and the read-only tool_call guard (ADR 0002).
 * The sandbox has no network, so this harness-side tool is the only way data gets in.
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { dataDir, idSalt } from "../../src/config.ts";
import { checkToolCall } from "../../src/guard.ts";
import { FplClient } from "../../src/http.ts";
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
				"Returns a compact summary (squad, bank, chips, deadline, warnings) and the snapshot path, which is readable (read-only) from the sandbox. " +
				"Per-user data is always fetched fresh; shared data is cached per FPL's update cycle. Never returns raw JSON: read the snapshot files with Python for detail.",
			promptSnippet: "Fetch and snapshot the user's FPL team and public FPL data",
			parameters: Type.Object({
				team_id: Type.Optional(Type.Integer({ minimum: 1, description: "FPL team (entry) ID. Defaults to the team set with /team." })),
				element_summaries: Type.Optional(
					Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 20, description: "Player ids whose per-fixture history (element-summary) to include in the snapshot." }),
				),
				force_fresh: Type.Optional(Type.Boolean({ description: "Bypass the shared-data cache. Only when the user asks for the very latest data." })),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				const teamId = params.team_id ?? fplState(ctx.sessionManager.getBranch()).teamId;
				if (!teamId) throw new Error("No FPL team ID yet. Ask the user for it (the number in the URL of their FPL Points page), or they can run /team <id>.");
				const { text, details } = await takeSnapshot(
					{ teamId, elementSummaries: params.element_summaries, forceFresh: params.force_fresh, signal },
					{ client: new FplClient(), store: new SnapshotStore(dataDir()), salt: idSalt() },
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
