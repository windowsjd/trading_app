'use strict';

// Standalone investigation. Never imports the app, its clients, DB or Redis.
const https = require('node:https');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const REVIEW_COMMIT = 'ed5b01817be739d7abb03b62566912e08c40631f';
const RENDER_SERVICE_ID = 'srv-da84cg8u01pc73cjasa0';
const ANCHOR = '2026-10-12';
const HOLIDAY = '2026-10-09';
const CLOSED = [
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-02',
  '2026-05-01', '2026-05-05', '2026-05-25', '2026-06-03', '2026-07-17',
  '2026-08-17', '2026-09-24', '2026-09-25', '2026-10-05', '2026-10-09',
  '2026-12-25', '2026-12-31',
];
const MAX_CALLS = 12;
const GAP_MS = 1100;
const TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 524288;
const SCALE = 10n ** 12n;
const FIELDS = ['open', 'high', 'low', 'close', 'volume', 'amount'];
const compact = date => date.replaceAll('-', '');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function plan() {
  const sessions = [];
  for (let t = Date.parse('2026-01-01T00:00:00Z'); t <= Date.parse(`${ANCHOR}T00:00:00Z`); t += 86400000) {
    const d = new Date(t), date = d.toISOString().slice(0, 10);
    if (d.getUTCDay() % 6 !== 0 && !CLOSED.includes(date)) sessions.push(date);
  }
  const targets = [0, 1, 30, 60, 96].map(offset => ({ offset, date: sessions.at(-1 - offset) }));
  if (targets.some(t => !t.date) || !CLOSED.includes(HOLIDAY)) throw new Error('PLAN_INVALID');
  const calls = targets.flatMap(t => [60, 600].map(cycle => ({ kind: 'intraday', ...t, cycle })));
  calls.push({ kind: 'intraday', offset: null, date: HOLIDAY, cycle: 60 });
  calls.push({ kind: 'history', ...targets.at(-1), cycle: 'D' });
  return calls.map((call, i) => ({ id: i + 1, ...call }));
}

function losslessJson(text) {
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value !== 'number') return value;
    if (!context?.source) throw new Error('LOSSLESS_JSON_UNAVAILABLE');
    return context.source;
  });
}

function decimal(value, positive = false) {
  if (typeof value !== 'string' || !/^\d{1,30}(?:\.\d{1,12})?$/.test(value)) throw new Error('INVALID_DECIMAL');
  const [integer, fraction = ''] = value.split('.');
  const n = BigInt(integer) * SCALE + BigInt(fraction.padEnd(12, '0'));
  if (positive && n === 0n) throw new Error('INVALID_PRICE');
  return n;
}

function decimalText(n) {
  const fraction = (n % SCALE).toString().padStart(12, '0').replace(/0+$/, '');
  return `${n / SCALE}${fraction ? `.${fraction}` : ''}`;
}

function candle(row, intraday) {
  if (!isRecord(row)) throw new Error('INVALID_ROW');
  const names = intraday
    ? ['inddOpnprc', 'inddHgprc', 'inddLwprc', 'inddClsprc', 'inddTrdvol', 'inddTrdval']
    : ['opnprc', 'hgprc', 'lwprc', 'trdPrc', 'accTrdvol', 'accTrdval'];
  const values = Object.fromEntries(FIELDS.map((field, i) => [field, decimal(row[names[i]], i < 4)]));
  if (values.high < values.low || values.high < values.open || values.high < values.close ||
      values.low > values.open || values.low > values.close) throw new Error('INVALID_OHLC');
  return values;
}

function minuteLabel(value) {
  // Same HHMMSScc decoding as the existing KOSCOM normalizer; no format guessing.
  if (typeof value !== 'string' || !/^\d{1,8}$/.test(value)) throw new Error('INVALID_TIME');
  const s = value.padStart(8, '0');
  const h = Number(s.slice(0, 2)), m = Number(s.slice(2, 4));
  if (h > 23 || m > 59 || s.slice(4) !== '0000') throw new Error('INVALID_TIME');
  return h * 60 + m;
}

function clockText(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

function rateHeaders(headers = {}) {
  const result = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || !/(rate-?limit|quota|^retry-after$)/.test(name)) continue;
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    // Never copy arbitrary header values (including error text/tokens/URLs).
    result[name] = /^\d{1,20}$/.test(value) ? value : 'NON_NUMERIC_VALUE_OMITTED';
  }
  return result;
}

function buildUrl(base, apiKey, call) {
  if (!['https://oap.k-mydata.org', 'https://testoap.k-mydata.org'].includes(base)) throw new Error('BASE_NOT_ALLOWED');
  if (!apiKey || typeof apiKey !== 'string') throw new Error('KEY_MISSING');
  const valid = plan().some(p => JSON.stringify(p) === JSON.stringify(call));
  if (!valid) throw new Error('REQUEST_NOT_IN_PLAN');
  const path = call.kind === 'intraday'
    ? '/v3/market/realtime/kospi/stocks/005930/intraday'
    : '/v3/market/closed/kospi/005930/history';
  const url = new URL(path, base);
  const query = call.kind === 'intraday'
    ? { inddCycleTpCd: String(call.cycle), inqStrtDd: compact(call.date), strtTm: '1000', endTm: '1100' }
    : { trnsmCycleTpCd: 'D', inqStrtDd: compact(call.date), inqEndDd: compact(call.date), reqCnt: '1' };
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  // Preserve the app's query-key authentication. No fallback to another auth method.
  url.searchParams.set('apikey', apiKey);
  return url;
}

function requestOnce(url, { signal, timeoutMs = TIMEOUT_MS, request = https.request } = {}) {
  return new Promise(resolve => {
    let req, res, timer, done = false;
    const finish = packet => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve(packet);
    };
    const fail = code => {
      finish({ status: res?.statusCode ?? null, headers: rateHeaders(res?.headers), body: null, code });
      res?.destroy();
      req?.destroy();
    };
    const cancel = () => fail('CANCELED');
    if (signal?.aborted) return cancel();
    try {
      // Native HTTPS: GET only, no redirects, no retry, no reused connection.
      req = request(url, { method: 'GET', agent: false }, response => {
        res = response;
        res.on('error', () => fail('BODY_ERROR'));
        res.on('aborted', () => fail('BODY_ERROR'));
        const status = res.statusCode;
        if ([401, 403, 429].includes(status) || (status >= 300 && status < 400)) {
          finish({ status, headers: rateHeaders(res.headers), body: null, code: null });
          res.destroy();
          return;
        }
        let bytes = 0;
        const chunks = [];
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_BODY_BYTES) return fail('BODY_TOO_LARGE');
          chunks.push(chunk);
        });
        res.on('end', () => finish({ status, headers: rateHeaders(res.headers), body: Buffer.concat(chunks).toString('utf8'), code: null }));
      });
      req.on('error', () => fail('TRANSPORT_ERROR'));
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => fail('TIMEOUT'), timeoutMs);
      if (signal?.aborted) cancel();
      else req.end();
    } catch {
      fail('TRANSPORT_ERROR');
    }
  });
}

function apiErrorCategory(error) {
  const text = JSON.stringify(error).slice(0, MAX_BODY_BYTES).toLowerCase();
  if (/429|rate.?limit|quota|too many|호출.{0,30}(한도|제한)/.test(text)) return 'API_RATE_LIMIT';
  if (/401|403|api.?key|unauthor|forbidden|permission|authenti|authoriz|credential|인증|권한|접근|계약/.test(text)) return 'API_AUTH_ERROR';
  return 'API_ERROR_STOP';
}

function analyze(call, packet) {
  const output = { type: 'request', id: call.id, kind: call.kind, offset: call.offset, date: call.date,
    cycle: call.cycle, http: packet.status, api: 'UNCONFIRMED', rateHeaders: rateHeaders(packet.headers),
    verdict: '검증 실패', rowCount: null, validRows: 0 };
  const failure = code => ({ output: { ...output, api: code }, rows: [], stop: code });
  if (packet.code) return failure(packet.code);
  if ([401, 403].includes(packet.status)) { output.verdict = '권한 부족'; return failure('HTTP_AUTH_ERROR'); }
  if (packet.status === 429) { output.verdict = '호출 제한'; return failure('HTTP_RATE_LIMIT'); }
  if (packet.status >= 300 && packet.status < 400) return failure('REDIRECT_REJECTED');
  let body;
  try { body = losslessJson(packet.body); } catch { return failure('INVALID_JSON'); }
  if (isRecord(body) && (body.error != null || body.result?.error != null)) {
    const code = apiErrorCategory(body.error ?? body.result.error);
    if (code === 'API_AUTH_ERROR') output.verdict = '권한 부족';
    if (code === 'API_RATE_LIMIT') output.verdict = '호출 제한';
    return failure(code);
  }
  if (packet.status !== 200) return failure('HTTP_ERROR_STOP');
  if (!isRecord(body) || body.jsonrpc !== '2.0' || !isRecord(body.result) ||
      body.result.isuSrtCd !== '005930' || !Array.isArray(body.result.hisLists)) return failure('RESPONSE_SHAPE_ERROR');
  output.api = 'SUCCESS';
  output.rowCount = body.result.hisLists.length;
  const expectedDate = compact(call.date);
  const rows = [];
  let invalid = 0, datePresent = 0, dateMismatches = 0;
  const observedDates = new Set();
  const checkDate = value => {
    if (value === undefined) return;
    datePresent++;
    if (typeof value !== 'string' || !/^2026\d{4}$/.test(value)) { dateMismatches++; return; }
    observedDates.add(value);
    if (value !== expectedDate) dateMismatches++;
  };
  let rowDatePresent = 0;
  for (const row of body.result.hisLists) {
    if (isRecord(row) && row.trdDd !== undefined) { rowDatePresent++; checkDate(row.trdDd); }
    try {
      const values = candle(row, call.kind === 'intraday');
      const time = call.kind === 'intraday' ? minuteLabel(row.inddTm) : 0;
      if (call.kind === 'history' && row.trdDd !== expectedDate) throw new Error('DAILY_DATE_MISMATCH');
      rows.push({ time, ...values });
    } catch { invalid++; }
  }
  checkDate(body.result.trdDd);
  checkDate(body.trdDd);
  const identities = rows.map(row => [row.time, ...FIELDS.map(field => decimalText(row[field]))]);
  const sorted = identities.slice().sort((a, b) => a[0] - b[0]);
  const seen = new Map();
  let duplicates = 0, conflicts = 0;
  for (const identity of identities) {
    const key = identity[0], serialized = JSON.stringify(identity);
    if (seen.has(key)) { duplicates++; if (seen.get(key) !== serialized) conflicts++; }
    seen.set(key, serialized);
  }
  const times = rows.map(r => r.time), ordered = times.slice().sort((a, b) => a - b);
  const ascending = times.every((v, i) => i === 0 || v >= times[i - 1]);
  const descending = times.every((v, i) => i === 0 || v <= times[i - 1]);
  const intraday = call.kind === 'intraday';
  const outsideWindow = intraday ? times.filter(t => t < 600 || t > 660).length : 0;
  const outsideSession = intraday ? times.filter(t => t < 540 || t > 930).length : 0;
  const offGrid = intraday ? times.filter(t => (t - 540) % (call.cycle / 60) !== 0).length : 0;
  const irregularGaps = intraday ? ordered.filter((t, i) => i > 0 && t - ordered[i - 1] !== call.cycle / 60).length : 0;
  const usable = invalid === 0 && duplicates === 0 && dateMismatches === 0 && output.rowCount <= 100 &&
    (ascending || descending) && outsideWindow === 0 && outsideSession === 0 && offGrid === 0;
  Object.assign(output, { validRows: rows.length, invalidRows: invalid, duplicateTimes: duplicates,
    conflictingDuplicateTimes: conflicts, order: times.length < 2 ? 'NOT_APPLICABLE' : ascending ? 'ASCENDING' : descending ? 'DESCENDING' : 'NON_MONOTONIC',
    irregularGaps, outsideWindow, outsideSession, offGrid,
    earliest: intraday && times.length ? clockText(ordered[0]) : null,
    latest: intraday && times.length ? clockText(ordered.at(-1)) : null,
    ohlcvValid: rows.length > 0 && invalid === 0,
    rowDatePresent, datePresent, dateMismatches, observedDates: [...observedDates].sort(),
    resultDateMatches: body.result.trdDd === undefined ? null : body.result.trdDd === expectedDate,
    fingerprint: rows.length ? createHash('sha256').update(JSON.stringify(sorted)).digest('hex') : null,
    usable });
  output.verdict = !usable ? '검증 실패' : rows.length ? '데이터 존재·날짜 미확정' : '정상적인 데이터 없음';
  if (!intraday && usable && rows.length === 1) output.verdict = '확인됨';
  if (rows.length) output.priceRange = {
    low: decimalText(rows.reduce((n, r) => r.low < n ? r.low : n, rows[0].low)),
    high: decimalText(rows.reduce((n, r) => r.high > n ? r.high : n, rows[0].high)),
  };
  return { output, rows, stop: null };
}

function compareHypotheses(one, ten) {
  const unavailable = { boundary: 'UNCONFIRMED', verdict: '비교 불가', hypotheses: [] };
  if (!one?.output.usable || !ten?.output.usable || !one.rows.length || !ten.rows.length || one.output.date !== ten.output.date) return unavailable;
  const hypotheses = [];
  for (const minuteBoundary of ['START', 'END']) for (const tenBoundary of ['START', 'END']) {
    const minutes = new Map(one.rows.map(r => [r.time - (minuteBoundary === 'END' ? 1 : 0), r]));
    const mismatches = Object.fromEntries(FIELDS.map(field => [field, 0]));
    let complete = 0, incomplete = 0, excludedEdges = 0;
    for (const row of ten.rows) {
      const start = row.time - (tenBoundary === 'END' ? 10 : 0);
      if (start < 600 || start + 10 > 660) { excludedEdges++; continue; }
      const group = Array.from({ length: 10 }, (_, i) => minutes.get(start + i));
      if (group.some(r => r === undefined)) { incomplete++; continue; }
      complete++;
      const aggregate = { open: group[0].open, close: group[9].close,
        high: group.reduce((n, r) => r.high > n ? r.high : n, group[0].high),
        low: group.reduce((n, r) => r.low < n ? r.low : n, group[0].low),
        volume: group.reduce((n, r) => n + r.volume, 0n), amount: group.reduce((n, r) => n + r.amount, 0n) };
      for (const field of FIELDS) if (aggregate[field] !== row[field]) mismatches[field]++;
    }
    hypotheses.push({ minuteBoundary, tenBoundary, complete, incomplete, excludedEdges, mismatches });
  }
  // Candidate alignments are evidence only: this window cannot independently prove timestamp semantics.
  return { ...unavailable, hypotheses };
}

function finalSummary(analyses, calls, stopReason) {
  const intraday = analyses.filter(a => a.output.kind === 'intraday');
  const repeated = [];
  for (let i = 0; i < intraday.length; i++) for (let j = i + 1; j < intraday.length; j++) {
    const a = intraday[i].output, b = intraday[j].output;
    if (a.cycle === b.cycle && a.date !== b.date && a.fingerprint && a.fingerprint === b.fingerprint) repeated.push([a.id, b.id]);
  }
  const holiday = analyses.find(a => a.output.id === 11);
  const daily = analyses.find(a => a.output.id === 12);
  const comparisons = [0, 1, 30, 60, 96].map(offset => ({ offset,
    ...compareHypotheses(intraday.find(a => a.output.offset === offset && a.output.cycle === 60),
      intraday.find(a => a.output.offset === offset && a.output.cycle === 600)) }));
  const dailyChecks = [9, 10].map(id => {
    const a = analyses.find(a => a.output.id === id);
    if (!daily?.output.usable || daily.rows.length !== 1 || !a?.output.usable || !a.rows.length) return { id, status: 'UNAVAILABLE' };
    const d = daily.rows[0];
    return { id, status: 'COMPARED', priceWithinDailyRange: a.rows.every(r => r.low >= d.low && r.high <= d.high),
      volumeWithinDailyTotal: a.rows.reduce((n, r) => n + r.volume, 0n) <= d.volume,
      amountWithinDailyTotal: a.rows.reduce((n, r) => n + r.amount, 0n) <= d.amount };
  });
  const classifications = intraday.map(a => {
    const o = a.output;
    let verdict = o.verdict;
    const dailyContradiction = dailyChecks.some(c => c.id === o.id && c.status === 'COMPARED' &&
      (!c.priceWithinDailyRange || !c.volumeWithinDailyTotal || !c.amountWithinDailyTotal));
    const controlPassed = holiday?.output.usable && holiday.output.rowCount === 0 && repeated.length === 0;
    if (dailyContradiction || (o.date === HOLIDAY && o.validRows > 0)) verdict = '검증 실패';
    else if (o.usable && o.validRows > 0 && o.rowDatePresent === o.rowCount && controlPassed) verdict = '확인됨';
    return { id: o.id, date: o.date, cycle: o.cycle, verdict,
      dateConfidence: verdict === '확인됨' ? 'EXPLICIT_ROW_DATES_AND_CONTROLS' : 'UNCONFIRMED' };
  });
  const quota = analyses.map(a => ({ id: a.output.id, kind: a.output.kind,
    limitDay: a.output.rateHeaders['x-ratelimit-limit-day'] ?? null,
    remainingDay: a.output.rateHeaders['x-ratelimit-remaining-day'] ?? null }));
  const quotaDeltas = [];
  for (let i = 1; i < quota.length; i++) {
    const a = quota[i - 1], b = quota[i];
    if (/^\d+$/.test(a.remainingDay ?? '') && /^\d+$/.test(b.remainingDay ?? '')) quotaDeltas.push({
      previousId: a.id, id: b.id, observedDecrease: (BigInt(a.remainingDay) - BigInt(b.remainingDay)).toString(),
      limitChanged: a.limitDay !== b.limitDay, diagnosticOnlyAttribution: false });
  }
  return { type: 'summary', actualCalls: calls, stopped: Boolean(stopReason), stopReason,
    completePlan: calls === MAX_CALLS && !stopReason, actualApiValidationComplete: false,
    // Manual review of date attribution and timestamp semantics is always required.
    classifications, repeatedAcrossDates: repeated,
    holiday: holiday ? { rowCount: holiday.output.rowCount, validRows: holiday.output.validRows,
      verdict: classifications.find(c => c.id === 11)?.verdict,
      dateFilterSuspicion: holiday.output.validRows > 0 } : null,
    daily: daily ? { rowCount: daily.output.rowCount, verdict: daily.output.verdict, priceRange: daily.output.priceRange ?? null } : null,
    dailyChecks, comparisons, quota, quotaDeltas, operatingCallsMayOverlap: true };
}

function pause(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
  });
}

function safeEmitter(apiKey, write = line => process.stdout.write(`${line}\n`)) {
  return value => {
    const serialized = JSON.stringify(value);
    if ((apiKey && serialized.includes(apiKey)) || serialized.includes('apikey=') || /https?:\/\//.test(serialized)) throw new Error('OUTPUT_BLOCKED');
    write(serialized);
  };
}

async function runStudy({ base, apiKey, emit, signal, transport = requestOnce, sleep = pause, now = () => performance.now() }) {
  const analyses = [];
  let calls = 0, stopReason = null, previousCompletion = null;
  for (const call of plan()) {
    if (calls >= MAX_CALLS) { stopReason = 'CALL_CAP'; break; }
    if (calls > 0) await sleep(GAP_MS, signal);
    if (signal?.aborted) { stopReason = 'CANCELED'; break; }
    const start = now();
    if (previousCompletion !== null && start - previousCompletion < 1000) { stopReason = 'SPACING_GUARD'; break; }
    let packet;
    try {
      const url = buildUrl(base, apiKey, call);
      calls++;
      packet = await transport(url, { signal });
    } catch { stopReason = 'TRANSPORT_ERROR'; break; }
    previousCompletion = now();
    const analysis = analyze(call, packet);
    Object.assign(analysis.output, { elapsedMs: Math.max(0, Math.round(previousCompletion - start)) });
    analyses.push(analysis);
    emit(analysis.output);
    if (analysis.stop) { stopReason = analysis.stop; break; }
    if (analysis.output.rateHeaders['x-ratelimit-remaining-day'] === '0') { stopReason = 'DAILY_QUOTA_EXHAUSTED'; break; }
  }
  const summary = finalSummary(analyses, calls, stopReason);
  emit(summary);
  return summary;
}

async function main() {
  let callsStarted = false;
  const apiKey = process.env.KOSCOM_API_KEY?.trim() ?? '';
  const emit = safeEmitter(apiKey);
  try {
    if (process.env.RENDER_SERVICE_ID !== RENDER_SERVICE_ID) throw new Error('RENDER_SERVICE_MISMATCH');
    if (Number(process.versions.node.split('.')[0]) < 22 || losslessJson('1234567890123456789012') !== '1234567890123456789012') throw new Error('RUNTIME_UNSUPPORTED');
    if (process.env.NODE_DEBUG || process.env.NODE_DEBUG_NATIVE) throw new Error('DEBUG_OUTPUT_ENABLED');
    const base = process.env.KOSCOM_BASE_URL?.trim() ?? '';
    buildUrl(base, apiKey, plan()[0]);
    const dateKst = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    if (dateKst !== ANCHOR || Date.now() < Date.parse(`${ANCHOR}T15:30:00+09:00`)) throw new Error('PLAN_DATE_STALE_OR_NOT_CLOSED');
    // Local diagnostic marker only. Leave it in place after success/error/Ctrl+C.
    const guardPath = '/tmp/trading-class-koscom-history-20261012.once';
    let marker;
    try { marker = fs.openSync(guardPath, 'wx', 0o600); } catch { throw new Error('ONCE_GUARD_BLOCKED'); }
    fs.writeSync(marker, 'KOSCOM_HISTORY_DIAGNOSTIC_DO_NOT_RERUN\n');
    fs.closeSync(marker);
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    emit({ type: 'start', codeReviewCommit: REVIEW_COMMIT,
      renderCommit: /^[a-f0-9]{40}$/.test(process.env.RENDER_GIT_COMMIT ?? '') ? process.env.RENDER_GIT_COMMIT : null,
      startedAt: new Date().toISOString(), environment: 'EXISTING_RENDER_SHELL_REQUIRED', symbol: '005930', market: 'kospi',
      baseEnvironment: base.startsWith('https://testoap.') ? 'TEST' : 'PRODUCTION',
      maxCalls: MAX_CALLS, gapMs: GAP_MS, timeoutMs: TIMEOUT_MS, anchor: ANCHOR, calendarVersion: 'KRX_2026_2026.1',
      operationsChanged: false, diagnosticTmpMarkerCreated: true, plan: plan() });
    callsStarted = true;
    try {
      const result = await runStudy({ base, apiKey, emit, signal: controller.signal });
      if (result.stopped) process.exitCode = controller.signal.aborted ? 130 : 2;
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
  } catch (error) {
    const allowed = ['RENDER_SERVICE_MISMATCH', 'RUNTIME_UNSUPPORTED', 'DEBUG_OUTPUT_ENABLED', 'BASE_NOT_ALLOWED', 'KEY_MISSING',
      'PLAN_DATE_STALE_OR_NOT_CLOSED', 'ONCE_GUARD_BLOCKED', 'OUTPUT_BLOCKED'];
    const code = allowed.includes(error?.message) ? error.message : 'DIAGNOSTIC_FAILED';
    // Fixed text only. Do not stringify the error, URL, headers or environment.
    process.stdout.write(`${JSON.stringify({ type: 'fatal', code, callsMayHaveStarted: callsStarted, rerunAllowed: false })}\n`);
    process.exitCode = 2;
  }
}

module.exports = { plan, losslessJson, decimal, decimalText, rateHeaders, buildUrl, requestOnce,
  analyze, compareHypotheses, finalSummary, safeEmitter, runStudy, main };
if (require.main === module) void main();
