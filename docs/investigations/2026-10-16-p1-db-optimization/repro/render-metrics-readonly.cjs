// Render API GET-only metrics for the P0 deploy comparison (DB CPU, memory,
// disk; web service CPU, memory). Reads the CLI key from ~/.render/cli.yaml and
// never prints it. Paced 1.6 s per call (the API answers 429 after ~40 fast calls).
// Usage: node render-metrics-readonly.cjs <startIso> <endIso> <resolutionSeconds>
const fs = require('fs');
const os = require('os');
const [start, end, resolution] = process.argv.slice(2);
const yaml = fs.readFileSync(`${os.homedir()}/.render/cli.yaml`, 'utf8');
const key = /\n\s+key:\s*(\S+)/.exec(yaml)?.[1];
const host = (/\n\s+host:\s*(\S+)/.exec(yaml)?.[1] ?? 'https://api.render.com/v1/').replace(/\/$/, '');
if (!key) throw new Error('no key');
const DB = 'dpg-da7ac0e1egvs73e2sv20-a', WEB = 'srv-da84cg8u01pc73cjasa0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const out = {};
  for (const [name, resource] of [['cpu', DB], ['memory', DB], ['disk-usage', DB], ['disk-capacity', DB], ['cpu', WEB], ['memory', WEB]]) {
    const url = `${host}/metrics/${name}?resource=${resource}&startTime=${start}&endTime=${end}&resolutionSeconds=${resolution}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
    const body = res.ok ? await res.json() : { status: res.status };
    // Keep only label-free numeric series: [{ unit, values: [{timestamp, value}] }].
    out[`${resource === DB ? 'db' : 'web'}:${name}`] = Array.isArray(body)
      ? body.map((s) => ({ unit: s.unit, labels: (s.labels ?? []).filter((l) => !/instance|id/i.test(l.field)).map((l) => `${l.field}=${l.value}`), values: (s.values ?? []).map((v) => [v.timestamp, v.value]) }))
      : body;
    await sleep(1600);
  }
  console.log(JSON.stringify(out));
})().catch((e) => { console.error(e.name); process.exit(1); });
