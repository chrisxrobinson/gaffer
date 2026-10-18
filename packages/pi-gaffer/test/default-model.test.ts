/**
 * NFR-MNT-05 / ADR 0009, 0010: the default model as Pi resolves it in the image, with no models.json, has the
 * prices and the mid-conversation system-message flag in default-model.expected.json. A Pi upgrade that changes
 * either fails here; update the expectation only from the provider's price list.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../../..");
const EXPECTED = JSON.parse(readFileSync(resolve(import.meta.dirname, "default-model.expected.json"), "utf8"));

describe("the default model's prices and compat (NFR-MNT-05)", () => {
	it("is the model the Compose file defaults to", () => {
		const compose = readFileSync(join(REPO, "deploy/compose/docker-compose.yml"), "utf8");
		expect(compose).toContain(`GAFFER_PROVIDER: \${GAFFER_PROVIDER:-${EXPECTED.provider}}`);
		expect(compose).toContain(`GAFFER_MODEL: \${GAFFER_MODEL:-${EXPECTED.model}}`);
	});

	it("comes from Pi's catalogue: the image ships no models.json to replace it", () => {
		expect(existsSync(join(REPO, "harness/models.json"))).toBe(false);
		expect(readFileSync(join(REPO, "harness/Dockerfile"), "utf8")).not.toMatch(/models\.json/);
	});

	it("resolves with the pinned cost and supportsMidConvoSystemMessages", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gaffer-models-")); // an agent dir like the image's: no models.json
		const runtime = await ModelRuntime.create({ modelsPath: join(dir, "models.json"), authPath: join(dir, "auth.json") } as never);
		const model = runtime.getModel(EXPECTED.provider, EXPECTED.model) as { compat?: { supportsMidConvoSystemMessages?: boolean }; cost: Record<string, number> } | undefined;
		expect(model, `${EXPECTED.provider}/${EXPECTED.model} is not in Pi's catalogue`).toBeDefined();
		expect(model!.cost).toEqual(EXPECTED.cost);
		expect(model!.compat?.supportsMidConvoSystemMessages ?? false).toBe(EXPECTED.compat.supportsMidConvoSystemMessages);
	});
});
