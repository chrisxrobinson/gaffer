/**
 * Spike S9 helper: /fill puts ~90 lines of recommendation-shaped markdown into the transcript as a custom
 * message (no model call), so wheel scrolling, selection, links and wrapping can be tested in the browser.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function body(): string {
	const rows = Array.from({ length: 15 }, (_, i) =>
		`| Player ${String(i + 1).padStart(2, "0")} (ARS) | £${(5 + i * 0.3).toFixed(1)}m | → Replacement ${i + 1} (NEW) | +${(9.5 - i * 0.4).toFixed(1)} | high |`,
	);
	const xi = Array.from({ length: 40 }, (_, i) => `- Line ${i + 1}: squad note with enough words to look like a real recommendation row.`);
	return [
		"## GAFFER · GW8 recommendation · deadline Sat 24 Oct 10:00 UTC · confidence medium",
		"",
		"TOP-OF-RESULT marker: scroll up to here with the wheel.",
		"",
		"| Out | Sell | In | xP 4GW | Conf |",
		"|---|---|---|---|---|",
		...rows,
		"",
		"Docs link (OSC 8 test): [pi.dev docs](https://pi.dev/docs/latest/tui)",
		"",
		...xi,
		"",
		"BOTTOM-OF-RESULT marker.",
	].join("\n");
}

export default function fill(pi: ExtensionAPI) {
	pi.registerCommand("fill", {
		description: "S9: add a long recommendation-shaped message to the transcript",
		handler: async () => {
			pi.sendMessage({ customType: "s9.fill", content: body(), display: true });
		},
	});
}
