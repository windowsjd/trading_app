'use strict';

// Builds the self-contained Render Shell commands. Both sources are embedded gzip+base64,
// hash-checked before execution, and evaluated in memory; nothing is downloaded or written
// except the diagnostic's own /tmp once-marker.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');

const ROUND1 = path.join(__dirname, '../2026-10-12-koscom-history-limits/diagnostic.cjs');
const ROUND2 = path.join(__dirname, 'diagnostic.cjs');
const ROUND1_SHA = '4655ed526307e8eff82b9742eb43a509dbc5b727f2ec8d038157a92ca226f12b';
const V1_REL = '../2026-10-12-koscom-history-limits/diagnostic.cjs';
const sha = buffer => createHash('sha256').update(buffer).digest('hex');

function payload(file) {
  const source = fs.readFileSync(file);
  const encoded = zlib.gzipSync(source, { level: 9 }).toString('base64');
  return { sha: sha(source), parts: encoded.match(/.{1,128}/g) };
}

function body(r1, r2, separator) {
  const list = p => p.parts.map(part => `'${part}'`).join(`,${separator}`);
  return [
    `'use strict';`,
    `try {`,
    `  const zlib = require('node:zlib'), crypto = require('node:crypto');`,
    `  const unpack = (parts, sha) => { const s = zlib.gunzipSync(Buffer.from(parts.join(''), 'base64')); if (crypto.createHash('sha256').update(s).digest('hex') !== sha) throw new Error(); return s.toString('utf8'); };`,
    `  const load = (source, req) => { const m = { exports: {} }; new Function('require', 'module', source)(req, m); return m.exports; };`,
    `  const round1 = load(unpack([${separator}${list(r1)}], '${r1.sha}'), require);`,
    `  const round2 = load(unpack([${separator}${list(r2)}], '${r2.sha}'), name => name === '${V1_REL}' ? round1 : require(name));`,
    `  void round2.main();`,
    `} catch {`,
    `  process.stdout.write('{"type":"fatal","code":"PACKAGED_SCRIPT_INVALID","actualCalls":0}\\n');`,
    `  process.exitCode = 2;`,
    `}`,
  ].join(separator === '\n' ? '\n' : ' ');
}

const r1 = payload(ROUND1), r2 = payload(ROUND2);
if (r1.sha !== ROUND1_SHA) throw new Error('ROUND1_SOURCE_CHANGED');
const heredoc = `node --max-old-space-size=128 <<'KOSCOM_10M_DATE_QUOTA_PROBE'\n${body(r1, r2, '\n')}\nKOSCOM_10M_DATE_QUOTA_PROBE\n`;
const oneLine = `node --max-old-space-size=128 -e '${body(r1, r2, ' ').replaceAll("'", `'"'"'`)}'\n`;
fs.writeFileSync(path.join(__dirname, 'render-shell-command.sh'), heredoc);
fs.writeFileSync(path.join(__dirname, 'render-shell-one-line.sh'), oneLine);
process.stdout.write(`${JSON.stringify({ round1Sha256: r1.sha, round2Sha256: r2.sha,
  heredocBytes: Buffer.byteLength(heredoc), heredocSha256: sha(heredoc),
  oneLineBytes: Buffer.byteLength(oneLine), oneLineSha256: sha(oneLine) })}\n`);
