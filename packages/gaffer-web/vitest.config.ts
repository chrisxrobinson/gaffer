// The page's modules import "preact", "preact/hooks" and "htm" through the import map in index.html; the tests
// resolve the same names to the same vendored files, so what is tested is what the browser runs.
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const vendor = (f: string) => resolve(import.meta.dirname, "public/vendor", f);
export default defineConfig({
	resolve: { alias: [{ find: /^preact$/, replacement: vendor("preact.module.js") }, { find: /^preact\/hooks$/, replacement: vendor("hooks.module.js") }, { find: /^htm$/, replacement: vendor("htm.module.js") }] },
	test: { server: { deps: { inline: ["preact-render-to-string"] } }, testTimeout: 30_000 },
});
