'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const probe = require('./diagnostic.cjs');
const KEY = 'FAKE_DIAGNOSTIC_SECRET_DO_NOT_PRINT';
const BASE = 'https://oap.k-mydata.org';
const calls = probe.plan();
const tm = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}${String(minute % 60).padStart(2, '0')}0000`;
const amount = 1234567890123456789012n;

function minutes(date, { first = 601, base = 50000, dated = false } = {}) {
  return Array.from({ length: 60 }, (_, i) => ({
    inddTm: tm(first + i), inddOpnprc: String(base + i), inddHgprc: String(base + i + 2),
    inddLwprc: String(base + i - 2), inddClsprc: String(base + i + 1),
    inddTrdvol: String(100 + i), inddTrdval: String(amount + BigInt(i)),
    ...(dated ? { trdDd: date.replaceAll('-', '') } : {}),
  }));
}

function tens(rows, boundary = 'END') {
  return Array.from({ length: 6 }, (_, i) => {
    const group = rows.slice(i * 10, i * 10 + 10);
    return { inddTm: boundary === 'END' ? group[9].inddTm : group[0].inddTm,
      inddOpnprc: group[0].inddOpnprc, inddHgprc: String(Math.max(...group.map(r => Number(r.inddHgprc)))),
      inddLwprc: String(Math.min(...group.map(r => Number(r.inddLwprc)))), inddClsprc: group[9].inddClsprc,
      inddTrdvol: group.reduce((n, r) => n + BigInt(r.inddTrdvol), 0n).toString(),
      inddTrdval: group.reduce((n, r) => n + BigInt(r.inddTrdval), 0n).toString(),
      ...(group[0].trdDd ? { trdDd: group[0].trdDd } : {}),
    };
  });
}

function packet(rows, extra = {}) {
  return { status: 200, headers: {}, code: null,
    body: JSON.stringify({ jsonrpc: '2.0', result: { isuSrtCd: '005930', hisLists: rows } }), ...extra };
}

function analyzePair(rows = minutes(calls[0].date), tenRows = tens(rows)) {
  return [probe.analyze(calls[0], packet(rows)), probe.analyze(calls[1], packet(tenRows))];
}

async function study(makePacket = () => packet([]), { advanceSleep = true } = {}) {
  const output = [], sleeps = [], urls = [];
  let time = 0, active = 0, maxActive = 0;
  const emit = probe.safeEmitter(KEY, line => output.push(line));
  const summary = await probe.runStudy({ base: BASE, apiKey: KEY, emit,
    now: () => time,
    sleep: async ms => { sleeps.push(ms); if (advanceSleep) time += ms; },
    transport: async url => {
      urls.push(url);
      active++; maxActive = Math.max(maxActive, active);
      await Promise.resolve(); time += 2;
      const p = makePacket(calls[urls.length - 1], urls.length);
      active--;
      return p;
    },
  });
  return { output, sleeps, urls, summary, maxActive };
}

test('frozen KRX calendar selects actual session offsets including June 3 and July 17 closures', () => {
  assert.equal(calls.length, 12);
  assert.equal(JSON.stringify(calls.filter(c => c.cycle === 60).map(c => c.date)),
    JSON.stringify(['2026-10-12', '2026-10-08', '2026-08-25', '2026-07-10', '2026-05-19', '2026-10-09']));
  assert.equal(calls[11].date, '2026-05-19');
});

test('lossless numbers and exact decimal addition retain money beyond Number precision', () => {
  const v = probe.losslessJson('{"a":1234567890123456789012,"b":0.00000001}');
  assert.equal(v.a, '1234567890123456789012');
  assert.equal(v.b, '0.00000001');
  assert.equal(probe.decimalText(probe.decimal(v.a) + probe.decimal(v.b)), '1234567890123456789012.00000001');
});

test('only documented origins and the exact twelve request parameters are accepted', () => {
  const url = probe.buildUrl(BASE, KEY, calls[0]);
  assert.equal(url.pathname, '/v3/market/realtime/kospi/stocks/005930/intraday');
  assert.equal(url.searchParams.get('strtTm'), '1000');
  assert.equal(url.searchParams.get('endTm'), '1100');
  assert.equal(probe.buildUrl(BASE, KEY, calls[1]).searchParams.get('inddCycleTpCd'), '600');
  assert.equal(probe.buildUrl(BASE, KEY, calls[11]).searchParams.get('reqCnt'), '1');
  for (const base of ['http://oap.k-mydata.org', 'https://evil.invalid', `${BASE}/`, `${BASE}@evil.invalid`]) {
    assert.throws(() => probe.buildUrl(base, KEY, calls[0]), /^Error: BASE_NOT_ALLOWED$/);
  }
  assert.throws(() => probe.buildUrl(BASE, KEY, { ...calls[0], cycle: 300 }), /^Error: REQUEST_NOT_IN_PLAN$/);
});

test('valid rows without trading dates remain unconfirmed even with different prices', () => {
  const [one] = analyzePair();
  assert.equal(one.output.validRows, 60);
  assert.equal(one.output.verdict, '데이터 존재·날짜 미확정');
  assert.equal(one.output.earliest, '10:01');
  assert.equal(one.output.latest, '11:00');
  assert.equal(one.output.ohlcvValid, true);
  const other = probe.analyze(calls[2], packet(minutes(calls[2].date, { base: 70000 })));
  assert.equal(other.output.verdict, '데이터 존재·날짜 미확정');
  assert.equal(other.output.fingerprint === one.output.fingerprint, false);
});

test('successful empty result is distinct from malformed/missing candle fields', () => {
  assert.equal(probe.analyze(calls[0], packet([])).output.verdict, '정상적인 데이터 없음');
  const rows = minutes(calls[0].date); delete rows[0].inddTrdval;
  const a = probe.analyze(calls[0], packet(rows));
  assert.equal(a.output.verdict, '검증 실패');
  assert.equal(a.output.invalidRows, 1);
});

test('duplicates, conflicting candles, nonmonotonic order, invalid OHLC/time and >100 rows fail validation', () => {
  const rows = minutes(calls[0].date);
  const duplicate = probe.analyze(calls[0], packet([...rows, { ...rows[0], inddTrdvol: '999' }]));
  assert.equal(duplicate.output.duplicateTimes, 1);
  assert.equal(duplicate.output.conflictingDuplicateTimes, 1);
  assert.equal(duplicate.output.usable, false);
  const shuffled = rows.slice(); [shuffled[1], shuffled[2]] = [shuffled[2], shuffled[1]];
  assert.equal(probe.analyze(calls[0], packet(shuffled)).output.order, 'NON_MONOTONIC');
  assert.equal(probe.analyze(calls[0], packet(rows.slice().reverse())).output.order, 'DESCENDING');
  const invalid = rows.map(r => ({ ...r })); invalid[0].inddHgprc = '1'; invalid[1].inddTm = '10100100';
  assert.equal(probe.analyze(calls[0], packet(invalid)).output.invalidRows, 2);
  assert.equal(probe.analyze(calls[0], packet([...rows, ...rows])).output.usable, false);
});

test('matching END/END and START/START hypotheses compare all six fields but do not confirm boundaries', () => {
  for (const boundary of ['START', 'END']) {
    const rows = minutes(calls[0].date, { first: boundary === 'START' ? 600 : 601 });
    const [one, ten] = analyzePair(rows, tens(rows, boundary));
    const result = probe.compareHypotheses(one, ten);
    const candidate = result.hypotheses.find(h => h.minuteBoundary === boundary && h.tenBoundary === boundary);
    assert.equal(candidate.complete, 6);
    assert.equal(Object.values(candidate.mismatches).every(n => n === 0), true);
    assert.equal(result.boundary, 'UNCONFIRMED');
    assert.equal(result.verdict, '비교 불가');
  }
});

test('missing minute is never interpolated; all price, volume and amount mismatches are counted', () => {
  const rows = minutes(calls[0].date), tenRows = tens(rows);
  tenRows[1].inddTrdvol = (BigInt(tenRows[1].inddTrdvol) + 1n).toString();
  tenRows[2].inddTrdval = (BigInt(tenRows[2].inddTrdval) + 1n).toString();
  tenRows[3].inddOpnprc = (BigInt(tenRows[3].inddOpnprc) + 1n).toString();
  tenRows[3].inddHgprc = (BigInt(tenRows[3].inddHgprc) + 1n).toString();
  tenRows[3].inddLwprc = (BigInt(tenRows[3].inddLwprc) - 1n).toString();
  tenRows[3].inddClsprc = (BigInt(tenRows[3].inddClsprc) + 1n).toString();
  const [one, ten] = analyzePair(rows.filter((_, i) => i !== 5), tenRows);
  const h = probe.compareHypotheses(one, ten).hypotheses.find(h => h.minuteBoundary === 'END' && h.tenBoundary === 'END');
  assert.equal(h.complete, 5);
  assert.equal(h.incomplete, 1);
  assert.equal(h.mismatches.volume, 1);
  assert.equal(h.mismatches.amount, 1);
  assert.equal(h.mismatches.open, 1);
  assert.equal(h.mismatches.high, 1);
  assert.equal(h.mismatches.low, 1);
  assert.equal(h.mismatches.close, 1);
});

test('date filters: repeated responses and holiday data suppress positive attribution', () => {
  const a = probe.analyze(calls[0], packet(minutes(calls[0].date, { dated: true })));
  const b = probe.analyze(calls[2], packet(minutes(calls[2].date, { dated: true })));
  const holiday = probe.analyze(calls[10], packet(minutes(calls[10].date)));
  const s = probe.finalSummary([a, b, holiday], 3, null);
  assert.equal(s.repeatedAcrossDates.length, 3);
  assert.equal(s.classifications[0].verdict, '데이터 존재·날짜 미확정');
  assert.equal(s.holiday.dateFilterSuspicion, true);
  assert.equal(s.holiday.verdict, '검증 실패');
  const wrongDate = minutes('2026-10-08', { dated: true });
  assert.equal(probe.analyze(calls[0], packet(wrongDate)).output.dateMismatches, 60);
});

test('matching top-level date alone is insufficient; explicit row dates require successful controls', () => {
  const rows = minutes(calls[0].date);
  const body = { jsonrpc: '2.0', result: { isuSrtCd: '005930', trdDd: '20261012', hisLists: rows } };
  const undated = probe.analyze(calls[0], packet([], { body: JSON.stringify(body) }));
  const holiday = probe.analyze(calls[10], packet([]));
  assert.equal(probe.finalSummary([undated, holiday], 2, null).classifications[0].verdict, '데이터 존재·날짜 미확정');
  const dated = probe.analyze(calls[0], packet(minutes(calls[0].date, { dated: true })));
  assert.equal(probe.finalSummary([dated], 1, null).classifications[0].verdict, '데이터 존재·날짜 미확정');
  assert.equal(probe.finalSummary([dated, holiday], 2, null).classifications[0].verdict, '확인됨');
});

test('dated independent daily comparison detects contradictions, does not prove undated minute attribution', () => {
  const minute = probe.analyze(calls[8], packet(minutes(calls[8].date)));
  const dailyRows = [{ trdDd: '20260519', opnprc: '50000', hgprc: '60000', lwprc: '40000', trdPrc: '51000',
    accTrdvol: '999999', accTrdval: '99999999999999999999999999' }];
  const daily = probe.analyze(calls[11], packet(dailyRows));
  const holiday = probe.analyze(calls[10], packet([]));
  const s = probe.finalSummary([minute, holiday, daily], 3, null);
  assert.equal(s.dailyChecks[0].priceWithinDailyRange, true);
  assert.equal(s.classifications[0].verdict, '데이터 존재·날짜 미확정');
  dailyRows[0].hgprc = '51000'; dailyRows[0].lwprc = '50000';
  const contradicted = probe.finalSummary([minute, holiday, probe.analyze(calls[11], packet(dailyRows))], 3, null);
  assert.equal(contradicted.dailyChecks[0].priceWithinDailyRange, false);
  assert.equal(contradicted.classifications[0].verdict, '검증 실패');
  dailyRows[0].trdDd = '20260520';
  assert.equal(probe.analyze(calls[11], packet(dailyRows)).output.verdict, '검증 실패');
});

test('extract only rate-related headers, suppress arbitrary values, expose deltas without attributing concurrent calls', async () => {
  const headers = probe.rateHeaders({ 'X-RateLimit-Limit-Day': '100000', 'X-RateLimit-Remaining-Day': '90000',
    'RateLimit-Reset': '3600', 'X-Quota-Message': `${KEY} https://private.invalid`, Authorization: KEY });
  assert.equal(headers['x-ratelimit-limit-day'], '100000');
  assert.equal(headers['ratelimit-reset'], '3600');
  assert.equal(headers['x-quota-message'], 'NON_NUMERIC_VALUE_OMITTED');
  assert.equal('authorization' in headers, false);
  const r = await study((_call, n) => packet([], { headers: { 'X-RateLimit-Limit-Day': '100000', 'X-RateLimit-Remaining-Day': String(90000 - n * 3) } }));
  assert.equal(r.summary.quotaDeltas[0].observedDecrease, '3');
  assert.equal(r.summary.quotaDeltas[0].diagnosticOnlyAttribution, false);
});

test('all twelve calls are sequential, spaced, and never retried; absent quota remains unconfirmed', async () => {
  const r = await study();
  assert.equal(r.urls.length, 12);
  assert.equal(r.maxActive, 1);
  assert.equal(r.sleeps.length, 11);
  assert.equal(r.sleeps.every(ms => ms >= 1000), true);
  assert.equal(r.summary.actualCalls, 12);
  assert.equal(r.summary.completePlan, true);
  assert.equal(r.summary.quota.every(q => q.limitDay === null && q.remainingDay === null), true);
  assert.equal(r.summary.actualApiValidationComplete, false);
  const guard = await study(undefined, { advanceSleep: false });
  assert.equal(guard.urls.length, 1);
  assert.equal(guard.summary.stopReason, 'SPACING_GUARD');
});

for (const status of [401, 403, 429]) test(`HTTP ${status} stops immediately and prints no body, URL or secret`, async () => {
  const r = await study((_call, n) => n === 3 ? { status, headers: {}, code: null, body: `${KEY} https://private.invalid?apikey=${KEY}` } : packet([]));
  assert.equal(r.urls.length, 3);
  assert.equal(r.summary.stopped, true);
  assert.equal(r.summary.stopReason, status === 429 ? 'HTTP_RATE_LIMIT' : 'HTTP_AUTH_ERROR');
  assert.equal(r.output.join('').includes(KEY), false);
  assert.equal(/https?:\/\/|apikey=/.test(r.output.join('')), false);
});

test('unexpected JSON auth/rate errors, malformed JSON, transport failure, and zero quota stop without retries', async () => {
  const cases = [
    [packet([], { body: JSON.stringify({ error: { message: `invalid apikey ${KEY} https://private.invalid` } }) }), 'API_AUTH_ERROR'],
    [packet([], { body: JSON.stringify({ error: { message: 'quota exceeded' } }) }), 'API_RATE_LIMIT'],
    [packet([], { body: JSON.stringify({ error: { message: `unexpected ${KEY}` } }) }), 'API_ERROR_STOP'],
    [packet([], { body: `${KEY} invalid JSON` }), 'INVALID_JSON'],
    [{ status: null, headers: {}, body: null, code: 'TRANSPORT_ERROR' }, 'TRANSPORT_ERROR'],
    [packet([], { headers: { 'x-ratelimit-remaining-day': '0' } }), 'DAILY_QUOTA_EXHAUSTED'],
    [{ status: 302, headers: { location: 'https://evil.invalid' }, body: null, code: null }, 'REDIRECT_REJECTED'],
  ];
  for (const [p, reason] of cases) {
    const r = await study(() => p);
    assert.equal(r.urls.length, 1);
    assert.equal(r.summary.stopReason, reason);
    assert.equal(r.output.join('').includes(KEY), false);
    assert.equal(/https?:\/\//.test(r.output.join('')), false);
  }
});

test('output gate also rejects a key reflected in otherwise syntactically valid diagnostic fields', () => {
  const lines = [], emit = probe.safeEmitter(KEY, line => lines.push(line));
  assert.throws(() => emit({ type: 'request', accidental: KEY }), /^Error: OUTPUT_BLOCKED$/);
  assert.throws(() => emit({ url: 'https://private.invalid' }), /^Error: OUTPUT_BLOCKED$/);
  assert.equal(lines.length, 0);
});

function fakeRequest(mode, counter) {
  return (_url, options, callback) => {
    counter.count++;
    assert.equal(options.method, 'GET');
    assert.equal(options.agent, false);
    const req = new EventEmitter();
    req.destroy = () => { counter.destroyed++; };
    req.end = () => queueMicrotask(() => {
      if (mode === 'timeout') return;
      if (mode === 'error') { req.emit('error', new Error(`https://private.invalid?apikey=${KEY}`)); return; }
      const res = new EventEmitter();
      res.statusCode = mode === 'redirect' ? 302 : mode === 'unauthorized' ? 401 : 200;
      res.headers = mode === 'redirect' ? { location: `https://private.invalid?apikey=${KEY}` } : {};
      res.destroy = () => { counter.destroyed++; };
      callback(res);
      if (['redirect', 'unauthorized'].includes(mode)) return;
      if (mode === 'oversize') { res.emit('data', Buffer.alloc(524289)); return; }
      res.emit('data', Buffer.from(packet([]).body));
      res.emit('end');
    });
    return req;
  };
}

test('native transport handles JSON, timeout, socket errors, redirect/auth rejection and bounded body without retries', async () => {
  for (const [mode, code, status] of [['json', null, 200], ['timeout', 'TIMEOUT', null],
    ['error', 'TRANSPORT_ERROR', null], ['redirect', null, 302], ['unauthorized', null, 401], ['oversize', 'BODY_TOO_LARGE', 200]]) {
    const count = { count: 0, destroyed: 0 };
    const p = await probe.requestOnce(probe.buildUrl(BASE, KEY, calls[0]), { timeoutMs: 20, request: fakeRequest(mode, count) });
    assert.equal(p.code, code);
    assert.equal(p.status, status);
    assert.equal(count.count, 1);
    assert.equal(JSON.stringify(p).includes(KEY), false);
    if (['timeout', 'error', 'oversize'].includes(mode)) assert.equal(count.destroyed > 0, true);
  }
});

test('cancellation before request sends zero calls; cancellation in-flight destroys it and starts no replacement', async () => {
  const controller = new AbortController(); controller.abort();
  const count = { count: 0, destroyed: 0 };
  const p = await probe.requestOnce(probe.buildUrl(BASE, KEY, calls[0]), { signal: controller.signal, request: fakeRequest('timeout', count) });
  assert.equal(p.code, 'CANCELED');
  assert.equal(count.count, 0);
  const active = new AbortController();
  const pending = probe.requestOnce(probe.buildUrl(BASE, KEY, calls[0]), { signal: active.signal, request: fakeRequest('timeout', count) });
  active.abort();
  assert.equal((await pending).code, 'CANCELED');
  assert.equal(count.count, 1);
  assert.equal(count.destroyed, 1);
});

function isolatedMain(env) {
  const lines = [], count = { count: 0, destroyed: 0 };
  let markerExists = false;
  const FixedDate = class extends Date {
    constructor(...args) { super(...(args.length ? args : ['2026-10-12T12:43:01Z'])); }
    static now() { return Date.parse('2026-10-12T12:43:01Z'); }
  };
  const fakeProcess = { env: { RENDER_SERVICE_ID: 'srv-da84cg8u01pc73cjasa0', ...env }, versions: { node: '24.14.1' }, stdout: { write: line => lines.push(line) },
    on() {}, removeListener() {}, exitCode: 0 };
  const fakeFs = { openSync() { if (markerExists) throw new Error('exists'); markerExists = true; return 1; },
    writeSync() {}, closeSync() {} };
  const localRequire = name => name === 'node:https' ? { request: fakeRequest('unauthorized', count) }
    : name === 'node:fs' ? fakeFs : require(name);
  const context = { require: localRequire, module: { exports: {} }, process: fakeProcess,
    Date: FixedDate, URL, Buffer, AbortController, setTimeout, clearTimeout, queueMicrotask };
  vm.runInNewContext(fs.readFileSync(require.resolve('./diagnostic.cjs'), 'utf8'), context);
  return { main: context.module.exports.main, lines, count, process: fakeProcess };
}

test('actual main acquires a diagnostic-only once marker; a second invocation sends zero additional calls', async () => {
  const isolated = isolatedMain({ KOSCOM_API_KEY: KEY, KOSCOM_BASE_URL: BASE });
  await isolated.main();
  assert.equal(isolated.count.count, 1);
  assert.equal(isolated.process.exitCode, 2);
  await isolated.main();
  assert.equal(isolated.count.count, 1);
  assert.equal(JSON.parse(isolated.lines.at(-1)).code, 'ONCE_GUARD_BLOCKED');
  assert.equal(isolated.lines.join('').includes(KEY), false);
  assert.equal(/https?:\/\/|apikey=/.test(isolated.lines.join('')), false);
});

test('actual main blocks wrong service, missing credentials, undocumented base, and native debug output before requests', async () => {
  for (const [env, code] of [
    [{ RENDER_SERVICE_ID: 'wrong-service' }, 'RENDER_SERVICE_MISMATCH'],
    [{ KOSCOM_BASE_URL: BASE }, 'KEY_MISSING'],
    [{ KOSCOM_API_KEY: KEY, KOSCOM_BASE_URL: 'https://evil.invalid' }, 'BASE_NOT_ALLOWED'],
    [{ KOSCOM_API_KEY: KEY, KOSCOM_BASE_URL: BASE, NODE_DEBUG: 'https' }, 'DEBUG_OUTPUT_ENABLED'],
  ]) {
    const isolated = isolatedMain(env);
    await isolated.main();
    assert.equal(isolated.count.count, 0);
    assert.equal(JSON.parse(isolated.lines.at(-1)).code, code);
    assert.equal(isolated.lines.join('').includes(KEY), false);
  }
});
