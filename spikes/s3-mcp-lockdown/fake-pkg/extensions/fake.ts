// Stand-in for the installed pi-gaffer package: registers one tool so a run shows whether the package loaded.
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function (pi: ExtensionAPI) {
	pi.registerTool(defineTool({ name: "fake_tool", label: "fake_tool", description: "package marker", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) }));
}
