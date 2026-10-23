// S11 probe, run in the client: which destinations does the harness reach through the proxy, and which fail?
const targets = [
  ["allowed: FPL bootstrap", "https://fantasy.premierleague.com/api/bootstrap-static/"],
  ["allowed: Anthropic (no key: 401 expected)", "https://api.anthropic.com/v1/models"],
  ["allowed: football-data (apex, as odds.ts)", "https://football-data.co.uk/mmz4281/2627/E0.csv"],
  ["refused: example.com", "https://example.com/"],
  ["refused: an IP literal (FPL's Fastly)", "https://140.248.134.133/"],
  ["refused: www.football-data.co.uk (not in the code)", "https://www.football-data.co.uk/"],
  ["refused: plain http", "http://example.com/"],
  ["refused: allowed name on port 8443", "https://fantasy.premierleague.com:8443/"],
];
for (const [label, url] of targets) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    console.log(`${label}: HTTP ${r.status} (${Date.now() - t0} ms)`);
  } catch (e) {
    console.log(`${label}: failed, ${e.cause?.code ?? e.cause?.message ?? e.message} (${Date.now() - t0} ms)`);
  }
}
