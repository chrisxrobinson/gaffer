/**
 * The eval runner (FR-EVL-02, ARCHITECTURE §6.3): the full Gaffer, headless through Pi's SDK with
 * bindExtensions(), one fresh session per case, on the case's frozen data.
 *
 *   node evals/runner/run.ts --cases DIR --model faux|<provider>/<model> [--thinking medium] [--only a,b]
 *        [--out FILE] [--sessions DIR] [--data DIR] [--package installed|repo] [--agent-dir DIR] [--timeout 300]
 *
 * Usually started by `pnpm eval` (cli.ts) inside the harness container, where it uses the installed
 * pi-gaffer package, the real sandbox (SANDBOX_URL) and /data, which the sandbox reads at the same path.
 * Per case: a stand-in API serves the case (mock.ts); Gaffer's FPL clock is set to the case's time
 * (GAFFER_CLOCK_OFFSET_MS); saved preferences are installed; the stale case first takes a good
 * snapshot, then FPL "updates"; the prompt runs, then the case's follow-up prompt if it has one; the run
 * is graded (graders.ts) and its recommendation and G0 (the golden path's plan 1, no LLM) are scored on
 * the GW's real points by `gaffer_lib score`.
 * One JSON line per case is appended to --out as it finishes, then a summary line.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getInitialSystemMessage, type SystemMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, type ExtensionAPI, type ExtensionFactory, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { gafferLibCommand } from "../../packages/pi-gaffer/src/derive.ts";
import { idSalt } from "../../packages/pi-gaffer/src/config.ts";
import { lastJsonLine, providerFromEnv, SandboxSession, sandboxReadFile, sandboxRun, shellQuote } from "../../packages/pi-gaffer/src/sandbox.ts";
import { hashTeamId } from "../../packages/pi-gaffer/src/team-hash.ts";
import { parseEntries, sessionUsage } from "../../packages/pi-gaffer/src/usage.ts";
import { type CaseResult, chipScenarios, type EvalCase, gradeExpectations, gradeFollowUp, gradeInjection, gradePrefs, gradeValidity, type RequestShape, summarise, type ToolCall } from "./graders.ts";
import { CaseApi } from "./mock.ts";
import { goldenPathPolicy } from "./policy.ts";

const GAFFER_TOOLS = ["read", "write", "edit", "bash", "fpl_snapshot", "submit_recommendation", "set_preferences"];
const REPO = resolve(import.meta.dirname, "../..");

const { values } = parseArgs({
	options: {
		cases: { type: "string", default: resolve(REPO, "var/evals/cases") },
		only: { type: "string" },
		model: { type: "string", default: "faux" },
		thinking: { type: "string", default: process.env.GAFFER_THINKING ?? "medium" },
		out: { type: "string" },
		sessions: { type: "string", default: resolve(REPO, "var/evals/sessions") },
		data: { type: "string", default: resolve(REPO, "var/evals/data") },
		package: { type: "string", default: "installed" },
		"agent-dir": { type: "string", default: process.env.PI_CODING_AGENT_DIR ?? "/opt/pi-agent" },
		cwd: { type: "string", default: "/work" },
		timeout: { type: "string", default: "300" },
	},
});

const startedAt = new Date();
const modelLabel = values.model!;
const runId = `${startedAt.toISOString().replace(/[-:]/g, "").slice(0, 15)}-${modelLabel.replace(/[^A-Za-z0-9.-]+/g, "_")}`;
const out = values.out ?? resolve(REPO, "evals/results", `${startedAt.toISOString().slice(0, 10)}-${modelLabel.replace(/[^A-Za-z0-9.-]+/g, "_")}.jsonl`);
const sessionsDir = join(values.sessions!, runId);
const dataRoot = join(values.data!, runId);
const timeoutMs = Number(values.timeout) * 1000;
const salt = (() => {
	try {
		return idSalt();
	} catch {
		return "gaffer-eval";
	}
})();
process.env.GAFFER_ID_SALT ??= salt;
const sandbox = new SandboxSession(providerFromEnv());
const log = (line: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

function loadCases(): EvalCase[] {
	const only = values.only ? new Set(values.only.split(",")) : undefined;
	return readdirSync(values.cases!)
		.filter((d) => existsSync(join(values.cases!, d, "case.json")) && (!only || only.has(d)))
		.sort()
		.map((d) => JSON.parse(readFileSync(join(values.cases!, d, "case.json"), "utf8")) as EvalCase);
}

/** The saved preferences file (src/prefs.ts's format), written as /prefs or set_preferences would. */
function installPrefs(c: EvalCase, dataDir: string): void {
	if (!c.prefs) return;
	const boot = JSON.parse(readFileSync(join(values.cases!, c.id, "upstream", "bootstrap-static.json"), "utf8"));
	const name = (id: number) => boot.elements.find((e: { id: number }) => e.id === id)?.web_name ?? String(id);
	const file = join(dataDir, "users", hashTeamId(c.team_id, salt).replace(/^hmac-sha256:/, ""), "prefs.json");
	mkdirSync(dirname(file), { recursive: true });
	const p = c.prefs;
	writeFileSync(file, `${JSON.stringify({ schema: "gaffer.prefs/1", updated_at: c.as_of, risk: p.risk, save_chips: p.save_chips, keep: p.keep.map((id) => ({ id, name: name(id) })), avoid: p.avoid.map((id) => ({ id, name: name(id) })), max_hits_per_gw: p.max_hits_per_gw }, null, 2)}\n`);
}

const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 16);

/** A request's shape from the transcript the faux provider receives (it has no wire payload). */
function transcriptShape(messages: readonly { role: string }[]): RequestShape {
	const lead = getInitialSystemMessage(messages);
	const later = messages.slice(1).filter((m): m is SystemMessage => m.role === "system");
	return { system: hash({ content: lead?.content, sections: lead?.sections }), fpl_context_updates: later.filter((m) => m.sections?.fpl_context).length };
}

/** Record every faux request's shape before the scripted step answers it. */
const recording = (steps: FauxResponseStep[], requests: RequestShape[]): FauxResponseStep[] =>
	steps.map((s) => (ctx, ...rest) => {
		requests.push(transcriptShape(ctx.messages));
		return typeof s === "function" ? s(ctx, ...rest) : s;
	});

async function newSession(dir: string, scripted: boolean, requests: RequestShape[] = []) {
	const agentDir = values["agent-dir"]!;
	const cwd = values.cwd!;
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const faux = scripted ? fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] }) : undefined;
	const factories: ExtensionFactory[] = faux ? [(pi: ExtensionAPI) => pi.registerProvider(faux.provider as never)] : [];
	// A real provider's request as sent (NFR-COST-04): the leading system prompt, and any later system message with an fpl_context update.
	factories.push((pi: ExtensionAPI) =>
		pi.on("before_provider_request", (event) => {
			const p = (event as { payload?: { system?: unknown; messages?: { role: string; content: unknown }[] } }).payload;
			if (!p) return;
			requests.push({ system: hash(p.system ?? null), fpl_context_updates: (p.messages ?? []).filter((m) => m.role === "system" && JSON.stringify(m.content).includes("fpl_context")).length });
		}),
	);
	let extra: Record<string, unknown> = {};
	if (values.package === "repo") {
		const ext = (n: string) => import(resolve(REPO, `packages/pi-gaffer/extensions/${n}/index.ts`)).then((m) => m.default as ExtensionFactory);
		factories.push(...(await Promise.all(["gaffer-core", "gaffer-sandbox", "gaffer-data", "gaffer-recommend", "gaffer-budget"].map(ext))));
		extra = { noExtensions: true, additionalSkillPaths: [resolve(REPO, "packages/pi-gaffer/skills")], additionalPromptTemplatePaths: [resolve(REPO, "packages/pi-gaffer/prompts")] };
	}
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true, extensionFactories: factories, ...extra } as never);
	await loader.reload();
	mkdirSync(dir, { recursive: true });
	let model: unknown;
	let modelRuntime: unknown;
	if (faux) model = faux.getModel();
	else {
		const [provider, ...rest] = modelLabel.split("/");
		modelRuntime = await ModelRuntime.create({ modelsPath: join(agentDir, "models.json"), authPath: join(agentDir, "auth.json") } as never);
		model = (modelRuntime as ModelRuntime).getModel(provider, rest.join("/"));
		if (!model) throw new Error(`model ${modelLabel} is not in Pi's catalogue or ${join(agentDir, "models.json")}`);
	}
	const { session } = await createAgentSession({
		cwd, agentDir, model: model as never, ...(modelRuntime ? { modelRuntime: modelRuntime as never } : {}), thinkingLevel: values.thinking as never,
		resourceLoader: loader, sessionManager: SessionManager.create(cwd, dir), settingsManager, tools: GAFFER_TOOLS,
	});
	const notices: string[] = [];
	const ui: Record<string, unknown> = { notify: (m: string, t?: string) => notices.push(`${t ?? "info"}: ${m}`) };
	for (const m of ["select", "confirm", "input", "editor", "custom", "onTerminalInput", "setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader", "setTitle", "pasteToEditor", "setEditorText", "getEditorText", "addAutocompleteProvider", "setEditorComponent", "getEditorComponent", "getAllThemes", "getTheme", "setTheme", "getToolsExpanded", "setToolsExpanded"]) ui[m] = () => undefined;
	await session.bindExtensions({ uiContext: ui as never, mode: "tui" }); // S1: an SDK host must bind extensions
	return { session, faux, notices };
}

async function promptWithTimeout(session: { prompt(t: string): Promise<void>; abort(): Promise<void> | void }, text: string): Promise<string | undefined> {
	let timer: NodeJS.Timeout | undefined;
	const timedOut = new Promise<string>((r) => (timer = setTimeout(() => r(`timed out after ${timeoutMs / 1000} s`), timeoutMs)));
	try {
		const r = await Promise.race([session.prompt(text).then(() => undefined), timedOut]);
		if (r) await session.abort();
		return r;
	} finally {
		clearTimeout(timer);
	}
}

const setClock = (iso: string) => {
	process.env.GAFFER_CLOCK_OFFSET_MS = String(Date.parse(iso) - Date.now());
};

/** The golden-path command for a run's snapshot, as fpl_snapshot's summary names it (src/snapshot.ts runCommand). */
function goldenPathCommand(snap: Record<string, any>, prefsFile: string | undefined, out: string): string {
	let cmd = `${gafferLibCommand()} run --snapshot ${shellQuote(snap.snapshot_path)} --out ${shellQuote(out)} --no-chips`;
	if (snap.ft_source === "user" && snap.free_transfers !== null) cmd += ` --ft ${Math.trunc(snap.free_transfers)}`;
	if (snap.pending_transfers?.length) cmd += ` --pending ${shellQuote(snap.pending_transfers.map(([o, i]: number[]) => `${o}>${i}`).join(","))}`;
	if (prefsFile) cmd += ` --prefs ${shellQuote(prefsFile)}`;
	if (snap.finalise_transfers && snap.finalise_transfers.allowed === false) cmd += " --hold";
	return cmd;
}

const lineupOf = (g: Record<string, any>, hitCost: number) => ({ xi: g.xi, bench: g.bench, captain: g.captain, vice_captain: g.vice_captain, chip: g.chip ?? null, hit_cost: hitCost });

async function runCase(c: EvalCase): Promise<CaseResult> {
	const dataDir = join(dataRoot, c.id);
	mkdirSync(dataDir, { recursive: true });
	const api = await new CaseApi(join(values.cases!, c.id), c.team_id).start();
	Object.assign(process.env, { FPL_BASE_URL: api.fplBase, FOOTBALL_DATA_BASE_URL: api.footballDataBase, GAFFER_DATA_DIR: dataDir });
	installPrefs(c, dataDir);
	const result: CaseResult = {
		schema: "gaffer.evalresult/1", run_id: runId, case: c.id, title: c.title, tags: c.tags, model: modelLabel, valid: false, attempts: 0, grades: {},
		points: { scorable: c.scorable, recommended: null, g0: null, diff: null, g0_source: null }, chips: {}, cost: 0, model_calls: 0, tool_calls: [], latency_ms: null,
		recommendation: null, rec_id: null, session_file: null,
	};
	try {
		if (c.stale) {
			// FR-DAT-05: a good snapshot two hours before, then FPL "updates" and the deadline is 30 minutes away.
			setClock(c.stale.prime_at);
			const prime = await newSession(join(sessionsDir, "prime"), true);
			prime.faux!.setResponses([fauxAssistantMessage(fauxToolCall("fpl_snapshot", { team_id: c.team_id, include: ["odds"] })), fauxAssistantMessage(fauxText("primed"))]);
			await prime.session.prompt("prime the snapshot store");
			prime.session.dispose();
			api.updating = true;
		}
		setClock(c.as_of);
		const scripted = modelLabel === "faux";
		const requests: RequestShape[] = [];
		const { session, faux, notices } = await newSession(sessionsDir, scripted, requests);
		if (faux) faux.setResponses(recording(goldenPathPolicy(c.team_id, { fauxAssistantMessage, fauxToolCall, fauxText } as never), requests));
		if (c.team_command) await promptWithTimeout(session, c.team_command);
		const timedOut = await promptWithTimeout(session, c.prompt);
		if (timedOut) result.error = timedOut;
		else if (c.follow_up) {
			// NFR-COST-04: a second prompt in the same session once the run has settled, as in the TUI.
			if (faux) faux.setResponses(recording([fauxAssistantMessage(fauxText("Because plan 1 does, and the gate checked it."))], requests));
			const followUpTimedOut = await promptWithTimeout(session, c.follow_up);
			if (followUpTimedOut) result.error = `follow-up ${followUpTimedOut}`;
		}
		const file = session.sessionManager.getSessionFile();
		session.dispose();
		result.session_file = file ?? null;
		const entries = file && existsSync(file) ? parseEntries(readFileSync(file, "utf8")) : [];
		const custom = (t: string) => entries.filter((e) => e.type === "custom" && e.customType === t).map((e) => e.data as Record<string, any>);
		const rec = custom("gaffer.recommendation").at(-1);
		const validations = custom("gaffer.validation");
		const snap = custom("gaffer.snapshot").at(-1);
		const usage = sessionUsage(entries, file ?? "");
		const results = new Map(entries.filter((e) => e.message?.role === "toolResult").map((e) => [e.message!.toolCallId, !!e.message!.isError]));
		const calls: ToolCall[] = entries
			.filter((e) => e.message?.role === "assistant")
			.flatMap((e) => (e.message!.content ?? []).filter((b) => b.type === "toolCall").map((b) => ({ name: b.name ?? "?", args: ((b as { arguments?: Record<string, unknown> }).arguments ?? {}), isError: results.get(b.id) ?? false })));
		Object.assign(result, {
			valid: !!rec, recommendation: rec ?? null, rec_id: rec?.rec_id ?? null, cost: usage.cost, model_calls: usage.calls, tool_calls: calls.map((x) => x.name + (x.isError ? "!" : "")),
			latency_ms: usage.runs.filter((r) => r.recommendation).at(-1)?.ms ?? null, chips: chipScenarios(rec),
		});
		if (!rec && notices.length) result.error ??= notices.at(-1)!.slice(0, 300);
		const v = gradeValidity(rec, validations as { passed: boolean }[]);
		result.attempts = v.attempts;
		result.grades.valid = v;
		if (c.tags.includes("injection")) result.grades.injection = gradeInjection(c, calls, rec, existsSync(join(dataDir, "users")));
		if (c.prefs) result.grades.prefs = gradePrefs(c, rec);
		if (c.expect) result.grades.expect = gradeExpectations(c, rec);
		if (c.follow_up) {
			const { follow_up, ...grade } = gradeFollowUp(entries, requests);
			result.grades.follow_up = grade;
			result.follow_up = follow_up;
		}
		if (c.scorable && snap) await scorePoints(c, result, rec, validations, snap, dataDir);
		else if (!c.scorable) result.points.note = `GW${c.gw} ${c.season} isn't finished: no result to score against yet`;
		else result.points.note = "no snapshot was taken, so there is nothing to score";
	} catch (e) {
		result.error = (e as Error).message.split("\n")[0];
	} finally {
		await api.stop();
	}
	return result;
}

/** The recommendation and G0 scored on the GW's real points (gaffer_lib score in the sandbox). */
async function scorePoints(c: EvalCase, result: CaseResult, rec: Record<string, any> | undefined, validations: Record<string, any>[], snap: Record<string, any>, dataDir: string) {
	// G0: plan 1 of the plan file the run used, unless the model changed the golden path's inputs
	// (minutes overrides): then, and when there's no recommendation, the golden path runs again without them.
	const passed = validations.find((x) => x.passed && x.request?.plan);
	const plan = passed?.request?.plan;
	let g0: Record<string, any> | undefined;
	if (plan && !(plan.xmins_input ?? []).length) {
		g0 = plan.plans[0];
		result.points.g0_source = "plan 1 of the run's plan file";
	} else {
		const prefsFile = join(dataDir, "users", hashTeamId(c.team_id, salt).replace(/^hmac-sha256:/, ""), "prefs.json");
		const outFile = `/work/eval-g0-${c.id}.json`;
		const { output } = await sandboxRun(sandbox, goldenPathCommand(snap, existsSync(prefsFile) ? prefsFile : undefined, outFile), { timeoutS: 115 });
		try {
			g0 = JSON.parse(await sandboxReadFile(sandbox, outFile)).plans[0];
			result.points.g0_source = "a separate golden-path run (the model changed the inputs, or made no recommendation)";
		} catch {
			result.points.note = `G0 could not be computed: ${output.trim().slice(-200)}`;
		}
	}
	const live = JSON.parse(readFileSync(join(values.cases!, c.id, "result.json"), "utf8"));
	const lineups: Record<string, unknown> = {};
	if (rec) lineups.recommended = { xi: rec.starting_xi, bench: rec.bench, captain: rec.captain.id, vice_captain: rec.vice_captain.id, chip: rec.chip?.play ?? null, hit_cost: rec.hit_cost ?? 0 };
	if (g0) lineups.g0 = lineupOf(g0.gws[0], g0.gws[0].hit_cost ?? 0);
	if (!Object.keys(lineups).length) return;
	const { exitCode, output } = await sandboxRun(sandbox, `${gafferLibCommand()} score --snapshot ${shellQuote(snap.snapshot_path)} --request -`, { timeoutS: 60, stdin: JSON.stringify({ gw: c.gw, live, lineups }) });
	const doc = lastJsonLine(output) as Record<string, any> | undefined;
	if (!doc?.lineups) {
		result.points.note = `gaffer_lib score failed (exit ${exitCode}): ${doc?.error ?? output.trim().slice(-200)}`;
		return;
	}
	result.points.recommended = doc.lineups.recommended?.points ?? null;
	result.points.g0 = doc.lineups.g0?.points ?? null;
	if (result.points.recommended !== null && result.points.g0 !== null) result.points.diff = result.points.recommended - result.points.g0;
}

const cases = loadCases();
if (!cases.length) {
	console.error(`no built cases under ${values.cases} (run evals/build/build_cases.py)`);
	process.exit(2);
}
mkdirSync(dirname(out), { recursive: true });
const partial = `${out}.partial`;
writeFileSync(partial, "");
log(`run ${runId}: ${cases.length} case(s), model ${modelLabel}, thinking ${values.thinking}, package ${values.package}; sessions ${sessionsDir}`);
const rows: CaseResult[] = [];
for (const c of cases) {
	log(`${c.id}: ${c.title}`);
	const r = await runCase(c);
	rows.push(r);
	appendFileSync(partial, `${JSON.stringify(r)}\n`);
	const failed = Object.entries(r.grades).filter(([, g]) => !g.pass).map(([k, g]) => `${k}: ${g.problems.join("; ")}`);
	log(`  ${r.valid ? `recommendation ${r.rec_id} (attempts ${r.attempts})` : "NO recommendation"}; $${r.cost.toFixed(4)}; ${r.latency_ms === null ? "–" : `${(r.latency_ms / 1000).toFixed(0)} s`}; ` +
		`points ${r.points.recommended ?? "–"} vs G0 ${r.points.g0 ?? "–"}; tools ${r.tool_calls.join(",")}${failed.length ? `; FAILED ${failed.join(" | ")}` : ""}${r.error ? `; error: ${r.error}` : ""}`);
}
const summary = summarise(rows, { run_id: runId, model: modelLabel, started_at: startedAt.toISOString(), finished_at: new Date().toISOString() });
appendFileSync(partial, `${JSON.stringify(summary)}\n`);
renameSync(partial, out);
writeFileSync(out.replace(/\.jsonl$/, ".summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
log(`results: ${out}`);
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
