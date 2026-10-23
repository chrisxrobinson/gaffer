// S12: open the terminal through the door the way a browser does, and print what the command sees as TTYD_USER.
const [url, forged] = process.argv.slice(2);
const r = await fetch(url.replace(/^ws/, "http").replace(/\/ws$/, "/token"), forged ? { headers: { "Tailscale-User-Login": forged } } : {});
const { token } = await r.json();
const origin = url.replace(/^ws/, "http").replace(/\/terminal\/ws$/, "");
const ws = new WebSocket(url, { protocols: ["tty"], headers: { Origin: origin, ...(forged && { "Tailscale-User-Login": forged }) } });
let out = "";
ws.binaryType = "arraybuffer";
ws.onopen = () => ws.send(JSON.stringify({ AuthToken: token, columns: 80, rows: 24 }));
ws.onmessage = (m) => { const b = new Uint8Array(m.data); if (b[0] === 0x30) out += new TextDecoder().decode(b.slice(1)); if (out.includes("user=")) { console.log(out.trim().split("\n")[0]); process.exit(0); } };
ws.onerror = (e) => { console.log("ws error", e.message ?? e.type); process.exit(1); };
setTimeout(() => { console.log("timeout; got:", JSON.stringify(out)); process.exit(1); }, 8000);
