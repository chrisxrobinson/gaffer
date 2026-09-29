// Sandbox isolation checks (NFR-SEC-01, NFR-SEC-02), run inside the harness container through the same
// sandboxd path the model's bash tool uses:
//   docker compose exec -T gaffer node --input-type=module - < tests/isolation.mjs
// Secret values are compared in this process and never printed.
import { readFileSync } from "node:fs";

const SANDBOX = process.env.SANDBOX_URL ?? "http://sandbox:8080";

async function sh(command, timeout_s = 30) {
	const res = await fetch(`${SANDBOX}/exec`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command, timeout_s }) });
	let out = "";
	let end;
	for (const line of (await res.text()).split("\n").filter(Boolean)) {
		const m = JSON.parse(line);
		if (m.data !== undefined) out += Buffer.from(m.data, "base64").toString();
		else end = m;
	}
	return { out: out.trim(), exit: end?.exit ?? null, timedOut: !!end?.timed_out };
}

const results = [];
function check(id, name, pass, evidence) {
	results.push({ id, name, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  [${id}] ${name}\n      ${String(evidence).replace(/\n/g, "\n      ")}`);
}

const secret = (f) => {
	try {
		return readFileSync(f, "utf8").trim();
	} catch {
		return "";
	}
};
const salt = secret("/run/secrets/gaffer_id_salt");
const apiKey = secret("/run/secrets/anthropic_api_key"); // the entrypoint exports this to Pi; `compose exec` doesn't inherit it

// --- NFR-SEC-01: no network
let r = await sh("command -v curl wget nc || echo 'no curl/wget/nc in image'");
check("NFR-SEC-01", "no network tools in the sandbox image", r.out === "no curl/wget/nc in image", r.out);

r = await sh(`python -c "
import urllib.request
try:
    urllib.request.urlopen('https://fantasy.premierleague.com/api/bootstrap-static/', timeout=5); print('REACHED')
except Exception as e: print(type(e).__name__, e)"`);
check("NFR-SEC-01", "HTTP to the internet fails (FPL API)", !r.out.includes("REACHED"), r.out);

r = await sh(`python -c "
import socket
for host, port in [('1.1.1.1', 443), ('8.8.8.8', 53)]:
    s = socket.socket(); s.settimeout(3)
    try: s.connect((host, port)); print('CONNECTED', host)
    except Exception as e: print(host, type(e).__name__, e)"`);
check("NFR-SEC-01", "raw TCP to public IPs fails", !r.out.includes("CONNECTED"), r.out);

r = await sh(`python -c "
import socket
try: print('RESOLVED', socket.gethostbyname('fantasy.premierleague.com'))
except Exception as e: print(type(e).__name__, e)"`);
check("NFR-SEC-01", "public DNS does not resolve", !r.out.includes("RESOLVED"), r.out);

// The sandbox must not reach the web TUI (it would let generated code drive the agent).
const egressIp = (await import("node:os")).networkInterfaces();
const ttydIp = readFileSync("/proc/net/route", "utf8")
	.split("\n")
	.map((l) => l.trim().split(/\s+/))
	.find((c) => c[1] === "00000000")?.[0];
const ttydAddr = egressIp[ttydIp]?.find((a) => a.family === "IPv4")?.address;
r = await sh(`python -c "
import socket
for host in ['gaffer', '${ttydAddr}']:
    s = socket.socket(); s.settimeout(3)
    try: s.connect((host, 7681)); print('CONNECTED', host)
    except Exception as e: print(host, type(e).__name__, e)"`);
check("NFR-SEC-01", "sandbox cannot reach the harness web TUI (ttyd :7681)", !r.out.includes("CONNECTED"), r.out);

// --- NFR-SEC-01: privileges and filesystem
r = await sh("id -u; id");
check("NFR-SEC-01", "runs as non-root (id -u ≠ 0)", r.out.split("\n")[0] !== "0", r.out);

r = await sh("grep -E '^(CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp):' /proc/self/status");
const caps = Object.fromEntries(r.out.split("\n").map((l) => l.split(/:\s+/)));
check(
	"NFR-SEC-01",
	"cap-drop ALL, no-new-privileges, seccomp filtering",
	["CapPrm", "CapEff", "CapBnd"].every((k) => /^0+$/.test(caps[k] ?? "x")) && caps.NoNewPrivs === "1" && caps.Seccomp === "2",
	r.out,
);

r = await sh("touch /should-fail 2>&1; echo exit=$?; touch /usr/local/lib/python3.14/site-packages/evil.py 2>&1; echo exit=$?");
check("NFR-SEC-01", "writes to / and site-packages fail (read-only root)", !r.out.includes("exit=0"), r.out);

r = await sh("ls /data; touch /data/should-fail 2>&1; echo exit=$?; f=$(find /data/snapshots -name '*.json' 2>/dev/null | head -1); [ -n \"$f\" ] && { echo \"x\" >> \"$f\" 2>&1; echo append_exit=$?; } || echo 'no snapshot yet'");
check("NFR-SEC-01 / FR-DAT-07", "/data (snapshots) is read-only to the sandbox", !/exit=0/.test(r.out), r.out);

r = await sh("echo ok > /work/probe && cat /work/probe && df -h /work | tail -1");
check("NFR-SEC-01", "/work is writable tmpfs", r.out.startsWith("ok"), r.out);

r = await sh("cat /sys/fs/cgroup/pids.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max 2>&1");
check("NFR-SEC-01", "resource limits: pids 128, memory 2 GiB, 2 CPUs", r.out.includes("128") && r.out.includes(String(2 * 1024 ** 3)) && r.out.includes("200000 100000"), r.out);

r = await sh("ulimit -u");
check("NFR-SEC-01", "per-command process cap below the pids limit (RLIMIT_NPROC 96)", r.out === "96", r.out);

r = await sh("bash -c ':(){ :|:& };:' 2>&1 | tail -2; echo bomb-done", 10);
const alive = await fetch(`${SANDBOX}/healthz`).then((x) => x.ok).catch(() => false);
const after = await sh("echo still-alive");
check("NFR-SEC-01", "fork bomb is contained (pids limit + timeout) and the sandbox survives", alive && after.out === "still-alive", `timed_out=${r.timedOut}; ${r.out.split("\n").slice(-2).join(" | ")}; healthz=${alive}`);

// --- NFR-SEC-02: secrets never enter the sandbox
r = await sh("env");
const envNames = r.out.split("\n").map((l) => l.split("=")[0]);
check("NFR-SEC-02", "command env is the fixed minimal set", envNames.every((n) => ["PATH", "HOME", "TMPDIR", "MPLCONFIGDIR", "PYTHONDONTWRITEBYTECODE", "PYTHONUNBUFFERED", "LANG", "PWD", "SHLVL", "_"].includes(n)), envNames.join(" "));

r = await sh("for f in /proc/[0-9]*/environ; do tr '\\0' '\\n' < $f 2>/dev/null; done | sort -u");
const keyLike = r.out.split("\n").filter((l) => /(KEY|TOKEN|SECRET|SALT|PASSWORD)=/i.test(l) || /sk-[a-z]{2,}-/i.test(l));
const leaksKey = apiKey.length > 0 && r.out.includes(apiKey);
const leaksSalt = salt.length > 0 && r.out.includes(salt);
check("NFR-SEC-02", "/proc/*/environ holds no key-like values, no LLM key, no ID salt", keyLike.length === 0 && !leaksKey && !leaksSalt, `key-like lines: ${keyLike.length}; LLM key present in harness: ${apiKey.length > 0}, found in sandbox: ${leaksKey}; salt found in sandbox: ${leaksSalt}`);

r = await sh("ls /run/secrets 2>&1; grep -rl --binary-files=without-match -e 'sk-ant' /work /tmp /etc 2>/dev/null | head -3; echo done");
check("NFR-SEC-02", "no secrets mounted or on disk in the sandbox", !r.out.includes("anthropic") && !r.out.includes("gaffer_id_salt"), r.out);

r = await sh("for p in /proc/[0-9]*; do cut -d' ' -f3 $p/stat 2>/dev/null; done | grep -c Z; true");
check("NFR-SEC-01", "no zombie processes left behind (init reaps orphans)", r.out.trim() === "0", `zombies: ${r.out}`);

const failed = results.filter((x) => !x.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
