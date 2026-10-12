'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Block every real network path before the diagnostic modules bind to them.
let realNetworkAttempts = 0;
for (const [mod, fn] of [['node:net', 'connect'], ['node:net', 'createConnection'], ['node:tls', 'connect'],
  ['node:http', 'request'], ['node:http', 'get'], ['node:https', 'request'], ['node:https', 'get']]) {
  require(mod)[fn] = () => { realNetworkAttempts++; throw new Error('REAL_NETWORK_BLOCKED'); };
}
globalThis.fetch = () => { realNetworkAttempts++; throw new Error('REAL_NETWORK_BLOCKED'); };

const probe = require('./diagnostic.cjs');
const v1 = require('../2026-10-12-koscom-history-limits/diagnostic.cjs');
const KEY = 'FAKE_DIAGNOSTIC_SECRET_DO_NOT_PRINT';
const BASE = 'https://oap.k-mydata.org';
const V1_REL = '../2026-10-12-koscom-history-limits/diagnostic.cjs';
const calls = probe.plan();
const OPEN_WALL = Date.parse('2026-10-13T02:00:00Z'); // 11:00 KST, KRX open
const END = Array.from({ length: 39 }, (_, i) => 550 + i * 10);
const tm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}0000`;
const BASES = { '2026-05-18': 55000n, '2026-05-19': 56000n, '2026-07-10': 61000n, '2026-10-08': 70000n, '2026-10-12': 72000n };

function session(base, { labels = END, accStart = 5000n } = {}) {
  let acc = accStart, accAmount = accStart * base;
  return labels.map((t, i) => {
    const auction = t === 930;
    const open = auction ? base + 7n : base + BigInt(i);
    const [high, low, close] = auction ? [open, open, open] : [open + 3n, open - 2n, open + 1n];
    const volume = 100n + BigInt(i), amount = volume * open;
    acc += volume; accAmount += amount;
    return { inddTm: tm(t), inddOpnprc: String(open), inddHgprc: String(high), inddLwprc: String(low),
      inddClsprc: String(close), inddTrdvol: String(volume), inddTrdval: String(amount),
      inddAccTrdvol: String(acc), inddAccTrdval: String(accAmount) };
  });
}

function daily(rows, date, { extraVolume = 777n, override = {} } = {}) {
  const n = name => rows.map(r => BigInt(r[name]));
  const sum = name => n(name).reduce((a, b) => a + b, 0n);
  const sorted = rows.slice().sort((a, b) => Number(a.inddTm) - Number(b.inddTm));
  return { trdDd: date.replaceAll('-', ''), opnprc: sorted[0].inddOpnprc,
    hgprc: String(n('inddHgprc').reduce((a, b) => (b > a ? b : a))), lwprc: String(n('inddLwprc').reduce((a, b) => (b < a ? b : a))),
    trdPrc: sorted.at(-1).inddClsprc, accTrdvol: String(sum('inddTrdvol') + extraVolume),
    accTrdval: String(sum('inddTrdval') + extraVolume * 10n), ...override };
}

const ok = (result, headers = {}) => ({ status: 200, headers, code: null, body: JSON.stringify({ jsonrpc: '2.0', result }) });
const intradayPacket = rows => ok({ isuSrtCd: '005930', hisLists: rows });
const historyPacket = rows => ok({ isuSrtCd: '005930', hisLists: rows });

function priceRow(symbol, trdTm = '10595900') {
  return { isuSrtCd: symbol, trdPrc: '70000', cmpprevddTpCd: '2', cmpprevddPrc: '100', trdTm, accTrdvol: '1', accTrdval: '70000' };
}
function bookRow(symbol, { levels = 10, zero = false } = {}) {
  const row = { isuSrtCd: symbol, askordTotRqty: '10', bidordTotRqty: '10' };
  for (let i = 1; i <= levels; i++) {
    row[`askStep${i}BstordPrc`] = zero ? '0' : String(70000 + i * 100);
    row[`askStep${i}BstordRqty`] = zero ? '0' : '5';
    row[`bidStep${i}BstordPrc`] = zero ? '0' : String(70000 - (i - 1) * 100);
    row[`bidStep${i}BstordRqty`] = zero ? '0' : '5';
  }
  return row;
}

/** Default provider: every trading date distinct, holiday empty, multiquote complete. */
function provider(overrides = {}) {
  return call => {
    if (overrides[call.id]) return overrides[call.id](call);
    if (call.kind === 'intraday') return intradayPacket(BASES[call.date] ? session(BASES[call.date]) : []);
    if (call.kind === 'history') return historyPacket([daily(session(BASES[call.date]), call.date)]);
    return ok({ isulist: call.symbols.map(s => (call.item === 'price' ? priceRow(s) : bookRow(s))) });
  };
}

async function study(respond = provider(), { advanceSleep = true, wall = () => OPEN_WALL, headers } = {}) {
  const output = [], sleeps = [], ids = [];
  let time = 0, active = 0, maxActive = 0;
  const emit = v1.safeEmitter(KEY, line => output.push(line));
  const summary = await probe.runStudy({ base: BASE, apiKey: KEY, emit, wallNow: wall,
    now: () => time,
    sleep: async ms => { sleeps.push(ms); if (advanceSleep) time += ms; },
    transport: async url => {
      const call = calls.find(c => probe.buildUrl(BASE, KEY, c).href === url.href &&
        !ids.includes(c.id) && (c.repeatOf === undefined || ids.includes(c.repeatOf)));
      ids.push(call.id);
      active++; maxActive = Math.max(maxActive, active);
      await Promise.resolve(); time += 2;
      active--;
      const packet = respond(call);
      return headers ? { ...packet, headers: headers(call, ids.length) } : packet;
    },
  });
  return { output, sleeps, ids, summary, maxActive, joined: output.join('\n') };
}

const line = (r, id) => JSON.parse(r.output.find(l => l.includes(`"type":"request","id":${id},`)));

test('plan: 17 fixed calls, KRX session offsets, adjacent day and holiday from the repository calendar', () => {
  assert.equal(calls.length, 17);
  assert.equal(JSON.stringify(calls.filter(c => c.kind === 'intraday').map(c => c.date)),
    JSON.stringify(['2026-05-19', '2026-05-18', '2026-07-10', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-12']));
  assert.equal(probe.sessionOffset('2026-05-19'), 96);
  assert.equal(probe.sessionOffset('2026-05-18'), 97);
  assert.equal(probe.sessionOffset('2026-07-10'), 60);
  assert.equal(probe.isTradingDay('2026-10-09'), false);
  assert.doesNotThrow(() => probe.checkPlan());
  const source = fs.readFileSync(path.join(__dirname, '../../../backend/src/orders/market-calendar/data/krx-2026.ts'), 'utf8');
  const closures = [...source.matchAll(/date: '(2026-\d{2}-\d{2})', name: '[^']*', isFullDayClosed: true/g)].map(m => m[1]);
  assert.equal(JSON.stringify(closures), JSON.stringify(probe.CLOSED));
});

test('URLs: full-session 10m, single dated daily, ≤20-symbol multiquote; off-plan requests and hosts rejected', () => {
  const intraday = probe.buildUrl(BASE, KEY, calls[0]);
  assert.equal(intraday.pathname, '/v3/market/realtime/kospi/stocks/005930/intraday');
  assert.equal(intraday.searchParams.toString(), `inddCycleTpCd=600&inqStrtDd=20260519&strtTm=0900&endTm=1530&apikey=${KEY}`);
  assert.equal(probe.buildUrl(BASE, KEY, calls[1]).searchParams.toString(),
    `trnsmCycleTpCd=D&inqStrtDd=20260519&inqEndDd=20260519&reqCnt=1&apikey=${KEY}`);
  const kosdaq = probe.buildUrl(BASE, KEY, calls[14]);
  assert.equal(kosdaq.pathname, '/v3/market/realtime/kosdaq/multiquote/stocks/orderbook');
  assert.equal(kosdaq.searchParams.get('isuCd'), '086520,247540');
  for (const base of ['http://oap.k-mydata.org', 'https://evil.invalid', `${BASE}/`, `${BASE}@evil.invalid`])
    assert.throws(() => probe.buildUrl(base, KEY, calls[0]), /^Error: BASE_NOT_ALLOWED$/);
  assert.throws(() => probe.buildUrl(BASE, KEY, { ...calls[0], date: '2026-05-20' }), /^Error: REQUEST_NOT_IN_PLAN$/);
  assert.throws(() => probe.buildUrl(BASE, KEY, { ...calls[11], symbols: ['005930', '000660', '035420'] }), /^Error: REQUEST_NOT_IN_PLAN$/);
});

test('full regular session: END labels 09:10–15:30, both 4h buckets complete, 15:30 closing auction single price', () => {
  const o = probe.analyze(calls[0], intradayPacket(session(56000n)), OPEN_WALL).output;
  assert.equal(o.rowCount, 39);
  assert.equal(o.first, '09:10');
  assert.equal(o.last, '15:30');
  assert.equal(o.boundaryEvidence, 'END_GRID');
  assert.equal(o.gridComplete, true);
  assert.equal(o.fourHourBucketsEndLabels['09:00-13:00'].expected, 24);
  assert.equal(o.fourHourBucketsEndLabels['13:00-15:30'].expected, 14);
  assert.equal(o.fourHourBucketsEndLabels['13:00-15:30'].complete, true);
  assert.equal(o.fourHourBucketsEndLabels['13:00-15:30'].optionalAuctionPresent, true);
  assert.equal(o.auctionRow.singlePrice, true);
  assert.equal(o.cumulative.consistent, true);
  assert.equal(o.cumulative.preFirstBarVolume, '5000');
  assert.equal(o.possiblyTruncatedAtHundred, false);
  assert.equal(o.verdict, '정규장 전체 구간 반환·날짜 미확정');
});

test('missing slots are listed, never interpolated; an absent 15:30 auction row alone does not break the 13:00 bucket', () => {
  const rows = session(56000n).filter(r => !['11000000', '14000000'].includes(r.inddTm));
  const o = probe.analyze(calls[0], intradayPacket(rows)).output;
  assert.equal(JSON.stringify(o.missingEndLabels), '["11:00","14:00"]');
  assert.equal(o.fourHourBucketsEndLabels['09:00-13:00'].present, 23);
  assert.equal(o.fourHourBucketsEndLabels['13:00-15:30'].complete, false);
  assert.equal(o.verdict, '일부 구간 누락·날짜 미확정');
  const noAuction = probe.analyze(calls[0], intradayPacket(session(56000n).filter(r => r.inddTm !== '15300000'))).output;
  assert.equal(noAuction.fourHourBucketsEndLabels['13:00-15:30'].complete, true);
  assert.equal(noAuction.auctionRow.present, false);
  assert.equal(noAuction.gridComplete, false);
});

test('label semantics: START grid and a pre-open 09:00 row are reported, not silently merged', () => {
  const start = probe.analyze(calls[0], intradayPacket(session(56000n, { labels: END.map(t => t - 10) }))).output;
  assert.equal(start.boundaryEvidence, 'START_GRID');
  assert.equal(start.gridComplete, true);
  const withPreOpen = probe.analyze(calls[0], intradayPacket(session(56000n, { labels: [540, ...END] }))).output;
  assert.equal(withPreOpen.boundaryEvidence, 'NEITHER');
  assert.equal(withPreOpen.preOpenRows, 1);
  assert.equal(JSON.stringify(withPreOpen.extraEndLabels), '["09:00"]');
});

test('abnormal responses: >100 rows, exactly 100, duplicates, off-grid, bad OHLC and wrong shape fail closed', () => {
  const many = Array.from({ length: 101 }, () => session(56000n)[0]);
  assert.equal(probe.analyze(calls[0], intradayPacket(many)).output.usable, false);
  assert.equal(probe.analyze(calls[0], intradayPacket(many)).output.overHundred, true);
  assert.equal(probe.analyze(calls[0], intradayPacket(many.slice(0, 100))).output.possiblyTruncatedAtHundred, true);
  const rows = session(56000n);
  rows[3] = { ...rows[3], inddTm: '09450000' };
  rows[4] = { ...rows[4], inddHgprc: '1' };
  const bad = probe.analyze(calls[0], intradayPacket(rows)).output;
  assert.equal(bad.offGrid, 1);
  assert.equal(bad.invalidRows, 1);
  assert.equal(bad.verdict, '검증 실패');
  const shape = probe.analyze(calls[0], ok({ isuSrtCd: '000660', hisLists: [] }));
  assert.equal(shape.stop, 'RESPONSE_SHAPE_ERROR');
});

test('dated daily: exact OHLC with after-hours volume is strong attribution; cumulative total can equal daily', () => {
  const rows = session(56000n);
  const s = probe.finalSummary([probe.analyze(calls[0], intradayPacket(rows)),
    probe.analyze(calls[1], historyPacket([daily(rows, '2026-05-19')]))], 2, null);
  const d = s.dates[0];
  assert.equal(d.comparison.openEqual && d.comparison.highEqual && d.comparison.lowEqual && d.comparison.closeEqual, true);
  assert.equal(d.comparison.volumeRelation, 'SESSION_LESS');
  assert.equal(d.comparison.volumeDifference, '777');
  assert.equal(d.comparison.auctionCloseEqualsDailyClose, true);
  assert.equal(d.attribution, 'DATED_DAILY_OHLC_EXACT');
  const total = BigInt(rows.at(-1).inddAccTrdvol);
  const eq = probe.compareDaily(probe.analyze(calls[0], intradayPacket(rows)),
    probe.analyze(calls[1], historyPacket([daily(rows, '2026-05-19', { override: { accTrdvol: String(total) } })])));
  assert.equal(eq.lastCumulativeVolumeRelation, 'EQUAL');
});

test('dated daily contradictions and range-only matches never become positive attribution', () => {
  const rows = session(56000n);
  const intra = probe.analyze(calls[0], intradayPacket(rows));
  const outside = probe.analyze(calls[1], historyPacket([daily(rows, '2026-05-19', { override: { lwprc: '55999' } })]));
  assert.equal(probe.attribution(probe.compareDaily(intra, outside), false), 'CONTRADICTED_BY_DATED_DAILY');
  const lessVolume = probe.analyze(calls[1], historyPacket([daily(rows, '2026-05-19', { extraVolume: -1n })]));
  assert.equal(probe.attribution(probe.compareDaily(intra, lessVolume), false), 'CONTRADICTED_BY_DATED_DAILY');
  const wide = probe.analyze(calls[1], historyPacket([daily(rows, '2026-05-19', { override: { hgprc: '99999', lwprc: '1' } })]));
  assert.equal(probe.attribution(probe.compareDaily(intra, wide), false), 'CONSISTENT_RANGE_ONLY');
  const otherDay = probe.analyze(calls[1], historyPacket([daily(rows, '2026-05-18')]));
  assert.equal(otherDay.output.verdict, '일봉 날짜 불일치');
  assert.equal(probe.compareDaily(intra, otherDay).status, 'UNAVAILABLE');
});

test('holiday returning the previous session is flagged, never storable, and does not taint the real 10-08 date', async () => {
  const r = await study(provider({ 9: () => intradayPacket(session(BASES['2026-10-08'])) }));
  assert.equal(r.summary.holiday.verdict, 'HOLIDAY_RETURNED_PREVIOUS_SESSION');
  assert.equal(r.summary.holiday.fingerprintEqualsBeforeHoliday, true);
  assert.equal(r.summary.holiday.aggregateMatchesBeforeHolidayDailyOhlc, true);
  assert.equal(r.summary.holiday.storeAsHolidayCandles, false);
  assert.equal(r.summary.dates.find(d => d.date === '2026-10-08').attribution, 'DATED_DAILY_OHLC_EXACT');
  const empty = await study();
  assert.equal(empty.summary.holiday.verdict, 'HOLIDAY_EMPTY');
  assert.equal(empty.summary.holiday.storeAsHolidayCandles, false);
});

test('identical data on two different trading days contradicts both dates even when daily bars look consistent', async () => {
  const r = await study(provider({ 3: () => intradayPacket(session(BASES['2026-05-19'])),
    4: () => historyPacket([daily(session(BASES['2026-05-19']), '2026-05-18')]) }));
  assert.equal(JSON.stringify(r.summary.repeatedAcrossDates), '[["2026-05-19","2026-05-18"]]');
  assert.equal(r.summary.dates[0].attribution, 'CONTRADICTED_REPEATED_ACROSS_DATES');
  assert.equal(r.summary.dates[1].attribution, 'CONTRADICTED_REPEATED_ACROSS_DATES');
  assert.equal(r.summary.identicalRowPairs[0].identicalRows, 39);
});

test('normal run: distinct dated sessions attribute exactly; repeat of 10-12 is reproducible', async () => {
  const r = await study(undefined, { headers: (_c, n) => ({ 'X-RateLimit-Limit-Day': '50000', 'X-RateLimit-Remaining-Day': String(40000 - n) }) });
  assert.equal(r.summary.actualCalls, 17);
  assert.equal(r.summary.completePlan, true);
  assert.equal(r.summary.dates.every(d => d.attribution === 'DATED_DAILY_OHLC_EXACT'), true);
  assert.equal(r.summary.repeatedAcrossDates.length, 0);
  assert.equal(r.summary.reproducibility.sameFingerprintAsId10, true);
  assert.equal(r.summary.actualApiValidationComplete, false);
});

test('multiquote: all symbols, 10-level fields, fresh clocks while open; partial return and closed market stay distinct', async () => {
  const r = await study();
  const price = line(r, 12), book = line(r, 13);
  assert.equal(price.matched, 2);
  assert.equal(price.verdict, '요청 종목 전체 반환');
  assert.equal(price.perSymbol[0].freshness, 'FRESH_CLOCK');
  assert.equal(book.tenLevelFields, true);
  assert.equal(book.perSymbol[0].askPositiveLevels, 10);
  assert.equal(book.perSymbol[0].levelsMonotonic, true);
  const partial = probe.analyze(calls[13], ok({ isulist: [priceRow('086520')] }), OPEN_WALL).output;
  assert.equal(partial.matched, 1);
  assert.equal(partial.verdict, '일부 종목만 반환');
  const closedWall = Date.parse('2026-10-13T08:00:00Z');
  const closed = probe.analyze(calls[11], ok({ isulist: PAIRSROWS() }), closedWall).output;
  assert.equal(closed.perSymbol[0].freshness, 'NOT_EVALUATED_MARKET_CLOSED');
  const emptyBook = probe.analyze(calls[12], ok({ isulist: ['005930', '000660'].map(s => bookRow(s, { zero: true })) }), closedWall).output;
  assert.equal(emptyBook.tenLevelFields, true);
  assert.equal(emptyBook.perSymbol[0].askPositiveLevels, 0);
  const five = probe.analyze(calls[12], ok({ isulist: ['005930', '000660'].map(s => bookRow(s, { levels: 5 })) })).output;
  assert.equal(five.tenLevelFields, false);
});
function PAIRSROWS() { return ['005930', '000660'].map(s => priceRow(s, '15300000')); }

test('permission denial on multiquote (HTTP 403 or JSON 권한 error) stops all later calls; service-hours error continues', async () => {
  const http403 = await study(provider({ 12: () => ({ status: 403, headers: {}, code: null, body: `${KEY} https://x.invalid?apikey=${KEY}` }) }));
  assert.equal(http403.summary.actualCalls, 12);
  assert.equal(http403.summary.stopReason, 'HTTP_AUTH_ERROR');
  assert.equal(line(http403, 12).verdict, '권한 부족 또는 인증 실패');
  const json = await study(provider({ 13: () => ({ status: 200, headers: {}, code: null,
    body: JSON.stringify({ jsonrpc: '2.0', error: { code: 'E403', message: `이용계약 권한 없음 ${KEY}` } }) }) }));
  assert.equal(json.summary.actualCalls, 13);
  assert.equal(json.summary.stopReason, 'API_AUTH_ERROR');
  assert.equal(line(json, 13).apiErrorCode, 'E403');
  const hours = await study(provider({ 12: () => ({ status: 200, headers: {}, code: null,
    body: JSON.stringify({ jsonrpc: '2.0', error: { message: '당일 종가 제공 시간이 아닙니다.' } }) }) }));
  assert.equal(hours.summary.stopped, false);
  assert.equal(line(hours, 12).api, 'API_SERVICE_HOURS');
  for (const r of [http403, json, hours]) {
    assert.equal(r.joined.includes(KEY), false);
    assert.equal(/https?:\/\/|apikey=/.test(r.joined), false);
  }
});

test('HTTP 401/429, redirect, invalid JSON and zero remaining quota each stop after one call without retry', async () => {
  const cases = [
    [{ status: 401, headers: {}, code: null, body: null }, 'HTTP_AUTH_ERROR'],
    [{ status: 429, headers: {}, code: null, body: null }, 'HTTP_RATE_LIMIT'],
    [{ status: 302, headers: { location: 'https://evil.invalid' }, code: null, body: null }, 'REDIRECT_REJECTED'],
    [{ status: 200, headers: {}, code: null, body: `${KEY} not json` }, 'INVALID_JSON'],
    [{ status: 200, headers: {}, code: null, body: '' }, 'INVALID_JSON'],
    [{ status: 500, headers: {}, code: null, body: '{}' }, 'HTTP_ERROR_STOP'],
    [{ ...intradayPacket([]), headers: { 'x-ratelimit-remaining-day': '0' } }, 'DAILY_QUOTA_EXHAUSTED'],
    [{ ...intradayPacket([]), headers: { 'x-ratelimit-remaining-day': '000' } }, 'DAILY_QUOTA_EXHAUSTED'],
  ];
  for (const [packet, reason] of cases) {
    const r = await study(() => packet);
    assert.equal(r.summary.actualCalls, 1);
    assert.equal(r.summary.stopReason, reason);
    assert.equal(r.joined.includes(KEY), false);
  }
});

test('no automatic retry through the reused round-1 transport: one socket per call even on timeout', async () => {
  let sockets = 0;
  const hang = () => { sockets++; const req = new EventEmitter(); req.destroy = () => {}; req.end = () => {}; return req; };
  const r = await probe.runStudy({ base: BASE, apiKey: KEY, emit: v1.safeEmitter(KEY, () => {}), sleep: async () => {},
    transport: (url, opts) => v1.requestOnce(url, { ...opts, timeoutMs: 20, request: hang }) });
  assert.equal(sockets, 1);
  assert.equal(r.stopReason, 'TIMEOUT');
});

test('17-call cap: sequential, ≥1 s spacing; quota repeats sent only when the original carried a daily quota header', async () => {
  const withHeaders = await study(undefined, { headers: () => ({ 'x-ratelimit-remaining-day': '100' }) });
  assert.equal(withHeaders.ids.length, 17);
  assert.equal(withHeaders.maxActive, 1);
  assert.equal(withHeaders.sleeps.length, 16);
  assert.equal(withHeaders.sleeps.every(ms => ms >= 1000), true);
  const without = await study();
  assert.equal(without.ids.length, 15);
  assert.equal(JSON.stringify(without.summary.skipped.map(s => s.reason)), '["NO_QUOTA_HEADER_ON_ORIGINAL","NO_QUOTA_HEADER_ON_ORIGINAL"]');
  assert.equal(without.summary.completePlan, true);
  const guard = await study(undefined, { advanceSleep: false });
  assert.equal(guard.ids.length, 1);
  assert.equal(guard.summary.stopReason, 'SPACING_GUARD');
});

test('quota: shared counter, per-API budgets and multi-node counters are distinguished only as far as data allows', async () => {
  const shared = await study(undefined, { headers: (_c, n) => ({ 'X-RateLimit-Limit-Day': '50000', 'X-RateLimit-Remaining-Day': String(34000 - n) }) });
  assert.equal(shared.summary.quota.singleStrictSharedCounter, 'NOT_CONTRADICTED');
  assert.equal(shared.summary.quota.perCategoryCounter, 'NOT_CONTRADICTED');
  assert.equal(shared.summary.quota.perCategoryExact, false);
  assert.equal(shared.summary.quota.contractScope, 'UNCONFIRMED');
  assert.equal(shared.summary.quota.operatingCallsMayOverlap, true);
  const counters = {};
  const perType = await study(undefined, { headers: call => {
    const key = call.kind === 'multiquote' ? `mq-${call.item}` : call.kind;
    counters[key] = (counters[key] ?? { intraday: 34040, history: 33540, 'mq-price': 20000, 'mq-orderbook': 10000 }[key]) - 1;
    return { 'X-RateLimit-Limit-Day': '50000', 'X-RateLimit-Remaining-Day': String(counters[key]), 'RateLimit-Reset': '3600' };
  } });
  const q = perType.summary.quota;
  assert.equal(q.singleStrictSharedCounter, 'CONTRADICTED_BY_OBSERVATION');
  assert.equal(q.perCategoryCounter, 'NOT_CONTRADICTED');
  assert.equal(q.perCategoryExact, true);
  assert.equal(q.withinCategoryMonotonic, 'YES');
  assert.equal(q.categoryRanges.history.max, '33539');
  assert.equal(JSON.stringify(q.observations[0].otherRateHeaders), '["ratelimit-reset"]');
  const nodes = await study(undefined, { headers: (call, n) => ({ 'X-RateLimit-Remaining-Day': String((n % 2 ? 34040 : 33540) - n) }) });
  assert.equal(nodes.summary.quota.withinCategoryMonotonic, 'NO');
  assert.equal(nodes.summary.quota.perCategoryCounter, 'CONTRADICTED_BY_OBSERVATION');
  const crossing = [Date.parse('2026-10-12T23:59:55Z')];
  const crossed = await study(undefined, { wall: () => (crossing.push(crossing.at(-1) + 2000), crossing.at(-1)) });
  assert.equal(crossed.summary.quotaResetCrossed, true);
  assert.equal(shared.summary.quotaResetCrossed, false);
});

test('output gate blocks the key and any URL in diagnostic lines', () => {
  const lines = [], emit = v1.safeEmitter(KEY, l => lines.push(l));
  assert.throws(() => emit({ accidental: KEY }), /^Error: OUTPUT_BLOCKED$/);
  assert.throws(() => emit({ url: 'https://oap.k-mydata.org/v3' }), /^Error: OUTPUT_BLOCKED$/);
  assert.equal(lines.length, 0);
});

function fakeRequest(counter) {
  return (_url, options, callback) => {
    counter.count++;
    assert.equal(options.method, 'GET');
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter();
      res.statusCode = 401; res.headers = {}; res.destroy = () => {};
      callback(res);
    });
    return req;
  };
}

/** Loads both real sources in a sandbox exactly like the packaged Render command does. */
function isolatedMain(env, iso = '2026-10-13T02:00:00Z') {
  const lines = [], count = { count: 0 }, markers = new Set();
  const FixedDate = class extends Date {
    constructor(...args) { super(...(args.length ? args : [iso])); }
    static now() { return Date.parse(iso); }
  };
  const fakeProcess = { env: { RENDER_SERVICE_ID: 'srv-da84cg8u01pc73cjasa0', ...env }, versions: { node: '24.14.1' },
    stdout: { write: l => lines.push(l) }, on() {}, removeListener() {}, exitCode: 0 };
  const fakeFs = { openSync(p) { if (markers.has(p)) throw new Error('exists'); markers.add(p); return 1; },
    writeSync() {}, closeSync() {}, existsSync: p => p === '/tmp/trading-class-koscom-history-20261012.once' };
  const base = name => (name === 'node:https' ? { request: fakeRequest(count) } : name === 'node:fs' ? fakeFs : require(name));
  const load = (file, req) => {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: req, module, process: fakeProcess, Date: FixedDate,
      URL, Buffer, AbortController, setTimeout, clearTimeout, queueMicrotask });
    return module.exports;
  };
  const round1 = load(require.resolve(V1_REL), base);
  const round2 = load(require.resolve('./diagnostic.cjs'), name => (name === V1_REL ? round1 : base(name)));
  return { main: round2.main, lines, count, markers, process: fakeProcess };
}

test('main: diagnostic-only once marker (distinct from round 1); second invocation sends zero calls', async () => {
  const iso = isolatedMain({ KOSCOM_API_KEY: KEY, KOSCOM_BASE_URL: BASE });
  await iso.main();
  assert.equal(iso.count.count, 1);
  const start = JSON.parse(iso.lines[0]);
  assert.equal(/^[a-f0-9]{12}$/.test(start.runId), true);
  assert.equal(start.round1MarkerPresent, true);
  assert.equal([...iso.markers][0], '/tmp/trading-class-koscom-10m-date-quota-20261013.once');
  await iso.main();
  assert.equal(iso.count.count, 1);
  assert.equal(JSON.parse(iso.lines.at(-1)).code, 'ONCE_GUARD_BLOCKED');
  assert.equal(iso.lines.join('').includes(KEY), false);
  assert.equal(/https?:\/\/|apikey=/.test(iso.lines.join('')), false);
});

test('main: unset KOSCOM_BASE_URL uses the app default production origin', async () => {
  const iso = isolatedMain({ KOSCOM_API_KEY: KEY });
  await iso.main();
  assert.equal(iso.count.count, 1);
  assert.equal(JSON.parse(iso.lines[0]).baseFromEnv, false);
  assert.equal(JSON.parse(iso.lines[0]).baseEnvironment, 'PRODUCTION');
});

test('main: wrong service, missing key, foreign base, debug output, stale date and 09:00 quota reset block before any call', async () => {
  for (const [env, iso, code] of [
    [{ RENDER_SERVICE_ID: 'wrong' }, undefined, 'RENDER_SERVICE_MISMATCH'],
    [{ KOSCOM_BASE_URL: BASE }, undefined, 'KEY_MISSING'],
    [{ KOSCOM_API_KEY: KEY, KOSCOM_BASE_URL: 'https://evil.invalid' }, undefined, 'BASE_NOT_ALLOWED'],
    [{ KOSCOM_API_KEY: KEY, NODE_DEBUG: 'https' }, undefined, 'DEBUG_OUTPUT_ENABLED'],
    [{ KOSCOM_API_KEY: KEY }, '2026-10-12T12:00:00Z', 'PLAN_DATE_OUT_OF_RANGE'],
    [{ KOSCOM_API_KEY: KEY }, '2026-11-01T03:00:00Z', 'PLAN_DATE_OUT_OF_RANGE'],
    [{ KOSCOM_API_KEY: KEY }, '2026-10-13T23:57:00Z', 'QUOTA_RESET_WINDOW'],
  ]) {
    const isolated = isolatedMain(env, iso);
    await isolated.main();
    assert.equal(isolated.count.count, 0);
    assert.equal(isolated.markers.size, 0);
    assert.equal(JSON.parse(isolated.lines.at(-1)).code, code);
    assert.equal(isolated.lines.join('').includes(KEY), false);
  }
});

test('independent of the app: only node built-ins and the pinned round-1 module are required', () => {
  const source = fs.readFileSync(require.resolve('./diagnostic.cjs'), 'utf8');
  const required = [...source.matchAll(/require\('([^']+)'\)/g)].map(m => m[1]);
  assert.equal(required.every(r => r.startsWith('node:') || r === V1_REL), true);
  assert.equal(/backend|prisma|redis|ioredis|@nestjs/i.test(required.join(' ')), false);
});

test('response policy: valid, empty and partial intraday data keep distinct eligibility and continuation', async () => {
  for (const [rows, status, usable] of [
    [session(56000n), 'COMPLETE_SOURCE_GRID', true],
    [[], 'EMPTY', false],
    [session(56000n).filter(r => r.inddTm !== '11000000'), 'PARTIAL_SOURCE_GRID', true],
  ]) {
    const r = await study(provider({ 1: () => intradayPacket(rows) }));
    const o = line(r, 1);
    assert.equal(o.dataStatus, status);
    assert.equal(o.usable, usable);
    assert.equal(o.investigationAction, 'CONTINUE');
    assert.equal(r.ids.includes(2), true);
    assert.equal(r.summary.stopped, false);
  }
});

test('fatal candle matrix: malformed shape, wrong code, >100, duplicate/conflicting rows, OHLC and time stop the next call', async () => {
  const rows = session(56000n);
  const changed = (i, fields) => rows.map((r, k) => k === i ? { ...r, ...fields } : r);
  for (const [packet, reason] of [
    [ok({ isuSrtCd: '005930', hisLists: {} }), 'RESPONSE_SHAPE_ERROR'],
    [ok({ isuSrtCd: '000660', hisLists: rows }), 'RESPONSE_SHAPE_ERROR'],
    [intradayPacket(Array.from({ length: 101 }, () => rows[0])), 'ROW_LIMIT_EXCEEDED'],
    [intradayPacket([rows[0], ...rows]), 'DUPLICATE_CANDLES'],
    [intradayPacket([{ ...rows[0], inddTrdvol: '999' }, ...rows]), 'CONFLICTING_CANDLES'],
    [intradayPacket(changed(1, { inddHgprc: '1' })), 'INVALID_CANDLE'],
    [intradayPacket(changed(1, { inddTm: '99600000' })), 'INVALID_TIME'],
    [intradayPacket(changed(1, { inddTm: '09210000' })), 'OFF_GRID_TIME'],
    [intradayPacket(session(56000n, { labels: [530, ...END] })), 'OUTSIDE_REQUEST_TIME'],
    [intradayPacket([rows[1], rows[0], ...rows.slice(2)]), 'NON_MONOTONIC_CANDLES'],
  ]) {
    const r = await study(() => packet);
    assert.equal(r.ids.length, 1, reason);
    assert.equal(r.summary.stopReason, reason);
    assert.equal(line(r, 1).usable, false);
    assert.equal(line(r, 1).responseClass, 'FATAL_ERROR');
    assert.equal(line(r, 1).investigationAction, 'STOP');
  }
  const bad = probe.analyze(calls[0], intradayPacket([rows[0], ...rows]));
  assert.equal(bad.output.fourHourBucketsEndLabels['09:00-13:00'].complete === null, true);
  const s = probe.finalSummary([bad, probe.analyze(calls[2], intradayPacket([rows[0], ...rows]))], 2, bad.stop);
  assert.equal(s.repeatedAcrossDates.length, 0); // rejected partial data is not date evidence
});

test('daily anomalies: valid foreign date and empty data continue; malformed candle/date and extra rows stop', async () => {
  const rows = session(56000n);
  for (const [packet, reason, status] of [
    [historyPacket([]), null, 'EMPTY'],
    [historyPacket([daily(rows, '2026-05-18')]), null, 'DATE_MISMATCH'],
    [historyPacket([daily(rows, '2026-05-19', { override: { hgprc: '1' } })]), 'INVALID_DAILY_CANDLE_OR_DATE', 'INVALID'],
    [historyPacket([daily(rows, '2026-05-19', { override: { trdDd: '20260230' } })]), 'INVALID_DAILY_CANDLE_OR_DATE', 'INVALID'],
    [historyPacket([daily(rows, '2026-05-19'), daily(rows, '2026-05-19')]), 'DAILY_ROW_COUNT_EXCEEDED', 'INVALID'],
  ]) {
    const r = await study(provider({ 2: () => packet }));
    assert.equal(r.summary.stopReason, reason);
    assert.equal(line(r, 2).dataStatus, status);
    assert.equal(r.ids.includes(3), reason === null);
    assert.equal(line(r, 2).investigationAction, reason ? 'STOP' : 'CONTINUE');
    assert.equal(r.summary.dates[0].attribution, 'UNCONFIRMED_NO_COMPARISON');
  }
});

test('daily OHLC contradiction is an observation and never stops the remaining fixed plan', async () => {
  const r = await study(provider({ 2: () => historyPacket([daily(session(56000n), '2026-05-19', { override: { lwprc: '55999' } })]) }));
  assert.equal(r.summary.dates[0].attribution, 'CONTRADICTED_BY_DATED_DAILY');
  assert.equal(r.summary.dates[0].fourHourStatus, 'CONTRADICTED_DATE');
  assert.equal(r.ids.includes(3), true);
  assert.equal(r.summary.stopped, false);
});

test('HTTP 5xx with service-hours JSON remains fatal; timeout/transport/body-limit errors never continue', async () => {
  for (const status of [500, 502, 503]) {
    const r = await study(() => ({ status, headers: {}, body: JSON.stringify({ error: { message: '제공 시간이 아닙니다' } }) }));
    assert.equal(r.ids.length, 1);
    assert.equal(r.summary.stopReason, 'HTTP_ERROR_STOP');
  }
  for (const code of ['TIMEOUT', 'TRANSPORT_ERROR', 'BODY_ERROR', 'BODY_TOO_LARGE', 'CANCELED']) {
    const r = await study(() => ({ status: null, headers: {}, body: null, code }));
    assert.equal(r.ids.length, 1);
    assert.equal(r.summary.stopReason, code);
    assert.equal(line(r, 1).investigationAction, 'STOP');
  }
});

test('4h completeness: optional 15:30 absence keeps both required buckets complete without asserting END semantics', () => {
  const rows = session(56000n);
  const all = probe.analyze(calls[0], intradayPacket(rows)).output;
  const noAuction = probe.analyze(calls[0], intradayPacket(rows.slice(0, -1))).output;
  for (const o of [all, noAuction]) {
    assert.equal(o.requiredEndComplete, true);
    assert.equal(o.fourHourBucketsEndLabels['09:00-13:00'].complete, true);
    assert.equal(o.fourHourBucketsEndLabels['13:00-15:30'].complete, true);
    assert.equal(o.labelSemantics.confirmed, false);
  }
  assert.equal(all.sourceGrid.endComplete, true);
  assert.equal(all.labelSemantics.inferred, 'END');
  assert.equal(all.labelSemantics.confidence, 'BOUNDARY_PATTERN_ONLY');
  assert.equal(all.fourHourStatus, 'COMPLETE_UNDER_END_ASSUMPTION_DATE_UNCONFIRMED');
  assert.equal(noAuction.sourceGrid.endComplete, false);
  assert.equal(noAuction.auctionRow.present, false);
  assert.equal(noAuction.labelSemantics.confidence, 'AMBIGUOUS');
  assert.equal(noAuction.fourHourStatus, 'INCONCLUSIVE_LABEL_SEMANTICS');
  assert.equal(noAuction.verdict.includes('필수 4시간봉 구간 충족'), true);
  const endBucket = all.fourHourBucketsEndLabels['13:00-15:30'].aggregate;
  assert.equal(endBucket.close, rows.at(-1).inddClsprc);
  assert.equal(endBucket.volume, String(rows.slice(24).reduce((n, r) => n + BigInt(r.inddTrdvol), 0n)));
  assert.equal(noAuction.fourHourBucketsEndLabels['13:00-15:30'].aggregate.close, rows.at(-2).inddClsprc);
});

test('4h required missing rows cannot be replaced by the optional auction row', () => {
  for (const [missing, bucket, count] of [['11000000', '09:00-13:00', 23], ['14000000', '13:00-15:30', 13]]) {
    const o = probe.analyze(calls[0], intradayPacket(session(56000n).filter(r => r.inddTm !== missing))).output;
    assert.equal(o.requiredEndComplete, false);
    assert.equal(o.fourHourBucketsEndLabels[bucket].present, count);
    assert.equal(o.fourHourBucketsEndLabels[bucket].complete, false);
    assert.equal(o.auctionRow.present, true);
    assert.equal(o.fourHourStatus, 'INCOMPLETE_UNDER_END_ASSUMPTION');
    assert.equal(o.gridComplete, false);
  }
});

test('4h START, ambiguous and pre-open patterns remain inconclusive; holiday rows are never eligible', async () => {
  for (const [labels, pattern] of [[END.map(t => t - 10), 'START_GRID'], [END.slice(0, -1), 'AMBIGUOUS'], [[540, ...END], 'NEITHER']]) {
    const o = probe.analyze(calls[0], intradayPacket(session(56000n, { labels }))).output;
    assert.equal(o.boundaryEvidence, pattern);
    assert.equal(o.fourHourStatus, 'INCONCLUSIVE_LABEL_SEMANTICS');
    assert.equal(o.labelSemantics.confirmed, false);
    assert.equal(o.fourHourBucketsEndLabels['09:00-13:00'].aggregate.open,
      session(56000n, { labels }).find(r => r.inddTm === '09100000').inddOpnprc);
  }
  const r = await study(provider({ 9: () => intradayPacket(session(BASES['2026-10-08'])) }));
  assert.equal(line(r, 9).requiredEndComplete, true);
  assert.equal(line(r, 9).fourHourStatus, 'NOT_APPLICABLE_HOLIDAY');
  assert.equal(r.summary.holiday.storeAsHolidayCandles, false);
  assert.equal(r.ids.includes(10), true);
  assert.equal(r.summary.dates.every(d => d.providerDateIndependentlyProven === false), true);
  assert.equal(r.summary.dates[0].dateConfidence, 'SUPPLIER_DAILY_CORROBORATION_ONLY');
});

test('multiquote coverage: HTTP/JSON success does not promote partial or empty symbols to full success', async () => {
  for (const rows of [[priceRow('005930')], []]) {
    const r = await study(provider({ 12: () => ok({ isulist: rows }) }));
    const o = line(r, 12);
    assert.equal(o.httpSuccess, true);
    assert.equal(o.jsonValid, true);
    assert.equal(o.api, 'SUCCESS');
    assert.equal(o.coverageStatus, rows.length ? 'PARTIAL' : 'NONE');
    assert.equal(o.allRequestedReturned, false);
    assert.equal(o.fullSuccess, false);
    assert.equal(o.usable, false);
    assert.equal(o.responseClass, 'OBSERVATION');
    assert.equal(r.ids.includes(13), true);
    assert.equal(r.summary.multiquote[0].fullSuccess, false);
  }
});

test('multiquote identity and required numeric/time errors preserve observations and stop the next request', async () => {
  for (const [rows, reason, coverage] of [
    [[priceRow('005930'), priceRow('000660'), priceRow('035420')], 'UNEXPECTED_SYMBOL', 'UNEXPECTED_SYMBOLS'],
    [[priceRow('005930'), priceRow('005930'), priceRow('000660')], 'DUPLICATE_SYMBOL', 'DUPLICATE_SYMBOLS'],
    [[{ trdPrc: '70000' }], 'INVALID_SYMBOL_IDENTIFIER', 'INVALID_IDENTIFIERS'],
    [[{ ...priceRow('005930'), trdPrc: '0' }, priceRow('000660')], 'INVALID_CURRENT_PRICE', 'COMPLETE'],
    [[{ ...priceRow('005930'), trdPrc: '-1' }, priceRow('000660')], 'INVALID_CURRENT_PRICE', 'COMPLETE'],
    [[priceRow('005930', '24600000'), priceRow('000660')], 'INVALID_TIME', 'COMPLETE'],
  ]) {
    const r = await study(provider({ 12: () => ok({ isulist: rows }) }));
    const o = line(r, 12);
    assert.equal(r.ids.length, 12, reason);
    assert.equal(r.ids.includes(13), false);
    assert.equal(r.summary.stopReason, reason);
    assert.equal(o.coverageStatus, coverage);
    assert.equal(o.fullSuccess, false);
    assert.equal(o.usable, false);
    assert.equal(r.summary.multiquote[0].responseClass, 'FATAL_ERROR');
  }
});

test('multiquote depth: full levels, missing levels, numeric errors and book conflicts stay distinct', async () => {
  for (const [row, reason, fields] of [
    [bookRow('005930'), null, true],
    [bookRow('005930', { levels: 5 }), null, false],
    [{ ...bookRow('005930'), askStep2BstordRqty: '-1' }, 'INVALID_ORDERBOOK_VALUE', true],
    [{ ...bookRow('005930'), bidStep4BstordPrc: 'NaN' }, 'INVALID_ORDERBOOK_VALUE', true],
    [{ ...bookRow('005930', { levels: 5 }), askStep6BstordPrc: '-1' }, 'INVALID_ORDERBOOK_VALUE', false],
    [{ ...bookRow('005930'), bidStep1BstordPrc: '70200' }, 'CONFLICTING_ORDERBOOK', true],
    [{ ...bookRow('005930'), askStep2BstordPrc: '70100' }, 'CONFLICTING_ORDERBOOK', true],
  ]) {
    const r = await study(provider({ 13: () => ok({ isulist: [row, bookRow('000660')] }) }));
    const o = line(r, 13);
    assert.equal(r.summary.stopReason, reason);
    assert.equal(r.ids.includes(14), reason === null);
    assert.equal(o.tenLevelFields, fields);
    assert.equal(o.fullSuccess, reason === null && fields);
    assert.equal(o.perSymbol[0].levelValuesValid, reason !== 'INVALID_ORDERBOOK_VALUE');
  }
});

test('multiquote freshness: open fresh/stale/future/missing clocks and closed zero depth never become identical success', async () => {
  for (const [clock, freshness, success] of [
    ['10595900', 'FRESH_CLOCK', true], ['10000000', 'STALE_CLOCK', false], ['11010000', 'CLOCK_AHEAD', false],
    [undefined, 'UNKNOWN', false],
  ]) {
    const first = priceRow('005930');
    if (clock === undefined) delete first.trdTm; else first.trdTm = clock;
    const r = await study(provider({ 12: () => ok({ isulist: [first, priceRow('000660')] }) }));
    assert.equal(line(r, 12).perSymbol[0].freshness, freshness);
    assert.equal(line(r, 12).fullSuccess, success);
    assert.equal(r.ids.includes(13), true);
    assert.equal(line(r, 12).perSymbol[0].dateIndependentlyProven, false);
  }
  const closed = await study(provider({ 13: () => ok({ isulist: ['005930', '000660'].map(s => bookRow(s, { zero: true })) }) }),
    { wall: () => Date.parse('2026-10-13T08:00:00Z') });
  assert.equal(line(closed, 12).perSymbol[0].freshness, 'NOT_EVALUATED_MARKET_CLOSED');
  assert.equal(line(closed, 12).fullSuccess, true);
  assert.equal(line(closed, 13).fullSuccess, true);
  assert.equal(line(closed, 13).perSymbol[0].askPositiveLevels, 0);
  assert.equal(line(closed, 13).perSymbol[0].levelValuesValid, true);
  assert.equal(closed.ids.includes(14), true);
});

function quotaSample(index, remaining, start, end = start, headers = {}) {
  return probe.analyze(calls[index], { ...provider()(calls[index]),
    headers: { 'x-ratelimit-remaining-day': String(remaining), ...headers } }, start, end);
}
const RESET = Date.parse('2026-10-13T00:00:00Z'); // 09:00 KST

test('quota reset: request spanning 09:00 excludes its incoming/outgoing deltas but preserves later valid evidence', () => {
  const analyses = [quotaSample(0, 100, RESET - 2000), quotaSample(1, 50000, RESET - 1000, RESET + 1000),
    quotaSample(2, 49999, RESET + 2000), quotaSample(3, 49998, RESET + 3000)];
  const s = probe.finalSummary(analyses, 4, null);
  assert.equal(s.quotaResetCrossed, true);
  assert.equal(s.quota.observations[1].remainingDay, '50000');
  assert.equal(s.quota.consecutive[0].observedDecrease, '-49900');
  assert.equal(s.quota.consecutive[0].eligible, false);
  assert.equal(s.quota.consecutive[1].eligible, false);
  assert.equal(s.quota.consecutive[2].eligible, true);
  assert.equal(s.quota.singleStrictSharedCounter, 'NOT_CONTRADICTED');
  assert.equal(s.quota.increasesBetweenConsecutiveCalls, 0);
  assert.equal(s.quota.withinCategoryMonotonic, 'INCONCLUSIVE');
  assert.equal(s.quota.perCategoryExact === null, true);
  assert.equal(s.quota.status, 'PARTIAL_COMPARISONS_EXCLUDED');
  assert.equal(s.quota.eligibleConsecutiveComparisons, 1);
});

test('quota reset: all comparisons across reset produce INCONCLUSIVE rather than a counter contradiction', () => {
  const q = probe.quotaAnalysis([quotaSample(0, 1, RESET - 1000), quotaSample(2, 50000, RESET + 1000)]);
  assert.equal(q.quotaResetCrossed, true);
  assert.equal(q.status, 'INCONCLUSIVE');
  assert.equal(q.singleStrictSharedCounter, 'INCONCLUSIVE');
  assert.equal(q.perCategoryCounter, 'INCONCLUSIVE');
  assert.equal(q.withinCategoryMonotonic, 'INCONCLUSIVE');
  assert.equal(q.perCategoryExact === null, true);
  assert.equal(q.sameCategory[0].excludedReason, 'QUOTA_RESET_BOUNDARY');
  assert.equal(q.counterPattern, 'INCONCLUSIVE');
});

test('quota reset between calls preserves pre/post-reset comparisons and includes the response time in runStudy', async () => {
  let n = 0;
  const times = [RESET - 4000, RESET - 3000, RESET - 2000, RESET + 1000];
  const r = await study(undefined, { wall: () => times[n++] ?? RESET + n * 1000,
    headers: (call, i) => ({ 'x-ratelimit-remaining-day': String(i === 1 ? 1 : 50002 - i) }) });
  assert.equal(line(r, 2).quotaTiming.resetCrossedDuringRequest, true);
  assert.equal(r.summary.quotaResetCrossed, true);
  assert.equal(r.summary.quota.consecutive[0].eligible, false);
  assert.equal(r.summary.quota.consecutive[1].eligible, false);
  assert.equal(r.summary.quota.singleStrictSharedCounter, 'NOT_CONTRADICTED');
  assert.equal(r.summary.quota.perCategoryCounter, 'NOT_CONTRADICTED');
  assert.equal(r.summary.quota.withinCategoryMonotonic, 'YES');
  const q = probe.quotaAnalysis([quotaSample(0, 4, RESET - 4000), quotaSample(1, 3, RESET - 2000),
    quotaSample(2, 100, RESET + 1000), quotaSample(3, 99, RESET + 3000)]);
  assert.equal(JSON.stringify(q.consecutive.map(p => p.eligible)), '[true,false,true]');
  assert.equal(q.singleStrictSharedCounter, 'NOT_CONTRADICTED');
});

test('quota absence, unknown timing, changed limits and backwards wall clock do not create evidence', () => {
  const noHeaders = probe.analyze(calls[0], provider()(calls[0]), OPEN_WALL);
  assert.equal(probe.quotaAnalysis([noHeaders]).status, 'NO_DATA');
  assert.equal(probe.quotaAnalysis([noHeaders]).singleStrictSharedCounter, 'NO_DATA');
  const a = quotaSample(0, 100, OPEN_WALL), b = quotaSample(2, 99, OPEN_WALL + 2000);
  delete a.output.quotaTiming;
  const unknown = probe.quotaAnalysis([a, b], true);
  assert.equal(unknown.singleStrictSharedCounter, 'INCONCLUSIVE');
  assert.equal(unknown.consecutive[0].excludedReason, 'QUOTA_TIMING_UNAVAILABLE');
  const changed = probe.quotaAnalysis([quotaSample(0, 100, OPEN_WALL, OPEN_WALL, { 'x-ratelimit-limit-day': '1000' }),
    quotaSample(2, 200, OPEN_WALL + 2000, OPEN_WALL + 2000, { 'x-ratelimit-limit-day': '2000' })]);
  assert.equal(changed.singleStrictSharedCounter, 'INCONCLUSIVE');
  assert.equal(changed.sameCategory[0].excludedReason, 'LIMIT_CHANGED');
  const intermediateLimit = probe.quotaAnalysis([
    quotaSample(0, 100, OPEN_WALL, OPEN_WALL, { 'x-ratelimit-limit-day': '1000' }),
    quotaSample(1, 200, OPEN_WALL + 1000, OPEN_WALL + 1000, { 'x-ratelimit-limit-day': '2000' }),
    quotaSample(2, 99, OPEN_WALL + 2000, OPEN_WALL + 2000, { 'x-ratelimit-limit-day': '1000' }),
  ]);
  assert.equal(intermediateLimit.sameCategory[0].excludedReason, 'LIMIT_CHANGED');
  const backwards = probe.quotaAnalysis([quotaSample(0, 100, OPEN_WALL, OPEN_WALL - 1), b]);
  assert.equal(backwards.singleStrictSharedCounter, 'INCONCLUSIVE');
  assert.equal(backwards.consecutive[0].excludedReason, 'WALL_CLOCK_UNRELIABLE');
});

test('quota patterns remain hypotheses and operating-request deductions cannot prove a contract or a gateway', async () => {
  const operating = await study(undefined, { headers: (_call, n) => ({ 'x-ratelimit-remaining-day': String(40000 - n * 7) }) });
  const q = operating.summary.quota;
  assert.equal(q.singleStrictSharedCounter, 'NOT_CONTRADICTED');
  assert.equal(q.perCategoryExact, false);
  assert.equal(q.operatingCallsMayOverlap, true);
  assert.equal(q.counterPattern, 'SHARED_COMPATIBLE_NOT_PROVEN');
  assert.equal(q.contractScope, 'UNCONFIRMED');
  const categories = {};
  const perType = await study(undefined, { headers: c => {
    const key = c.kind === 'multiquote' ? c.item : c.kind;
    categories[key] = (categories[key] ?? 40000) - 1;
    return { 'x-ratelimit-remaining-day': String(categories[key]) };
  } });
  assert.equal(perType.summary.quota.counterPattern, 'CATEGORY_COMPATIBLE_NOT_PROVEN');
  const distributed = await study(undefined, { headers: (_c, n) => ({ 'x-ratelimit-remaining-day': String((n % 2 ? 40000 : 30000) - n) }) });
  assert.equal(distributed.summary.quota.counterPattern, 'FINER_SCOPE_OR_DISTRIBUTED_COUNTER_POSSIBLE');
  assert.equal(distributed.summary.quota.gatewayCounter, 'UNCONFIRMED_NO_GATEWAY_IDENTITY');
  assert.equal(distributed.summary.quota.contractScope, 'UNCONFIRMED');
});

test('reused transport keeps GET/no-agent, 512KB body limit, no redirect and no second socket', async () => {
  for (const mode of ['large', 'redirect']) {
    let sockets = 0, destroyed = 0;
    const request = (_url, options, cb) => {
      sockets++;
      assert.equal(options.method, 'GET');
      assert.equal(options.agent, false);
      const req = new EventEmitter(); req.destroy = () => { destroyed++; };
      req.end = () => queueMicrotask(() => {
        const res = new EventEmitter(); res.statusCode = mode === 'redirect' ? 302 : 200;
        res.headers = { location: 'https://evil.invalid' }; res.destroy = () => { destroyed++; };
        cb(res);
        if (mode === 'large') res.emit('data', Buffer.alloc(524289));
      });
      return req;
    };
    const packet = await v1.requestOnce(probe.buildUrl(BASE, KEY, calls[0]), { request });
    const a = probe.analyze(calls[0], packet);
    assert.equal(a.stop, mode === 'large' ? 'BODY_TOO_LARGE' : 'REDIRECT_REJECTED');
    assert.equal(sockets, 1);
    assert.equal(destroyed > 0, true);
  }
});

// Exercise the generated commands themselves in a VM with a private marker store,
// fixed time, no real process.env, and a transport that cannot open a socket.
function packagedCode(format) {
  const file = path.join(__dirname, format === 'heredoc' ? 'render-shell-command.sh' : 'render-shell-one-line.sh');
  const shell = fs.readFileSync(file, 'utf8');
  if (format === 'heredoc') return shell.split('\n').slice(1, -2).join('\n');
  const prefix = "node --max-old-space-size=128 -e '";
  assert.equal(shell.startsWith(prefix), true);
  assert.equal(shell.endsWith("'\n"), true);
  return shell.slice(prefix.length, -2).replaceAll(`'"'"'`, "'");
}

function packagedSandbox(code, env = {}) {
  const lines = [], markers = new Set();
  let blockedSockets = 0;
  const fakeProcess = { env, versions: { node: '24.14.1' }, stdout: { write: l => lines.push(l) },
    on() {}, removeListener() {}, exitCode: 0 };
  const FixedDate = class extends Date {
    constructor(...args) { super(...(args.length ? args : [OPEN_WALL])); }
    static now() { return OPEN_WALL; }
  };
  const fakeFs = { openSync(p) { if (markers.has(p)) throw new Error('exists'); markers.add(p); return 1; },
    writeSync() {}, closeSync() {}, existsSync: p => markers.has(p) };
  const isolatedRequire = name => {
    assert.equal(name.startsWith('node:'), true);
    if (name === 'node:fs') return fakeFs;
    if (name === 'node:https') return { request() { blockedSockets++; throw new Error('SOCKET_DISABLED'); } };
    return require(name);
  };
  const context = vm.createContext({ require: isolatedRequire, process: fakeProcess, Date: FixedDate,
    URL, Buffer, AbortController, setTimeout, clearTimeout });
  const run = async () => {
    vm.runInContext(code.replace('void round2.main();', 'globalThis.finished = round2.main();'), context, { timeout: 1000 });
    await context.finished;
  };
  return { lines, markers, process: fakeProcess, run, blockedSockets: () => blockedSockets };
}

test('packaging: both commands decode byte-for-byte to current sources and detect a changed source', () => {
  const { createHash } = require('node:crypto');
  const { gunzipSync } = require('node:zlib');
  const sha = b => createHash('sha256').update(b).digest('hex');
  for (const format of ['heredoc', 'one-line']) {
    const matches = [...packagedCode(format).matchAll(/const round[12] = load\(unpack\(\[([\s\S]*?)\], '([a-f0-9]{64})'\)/g)];
    assert.equal(matches.length, 2);
    for (const [i, match] of matches.entries()) {
      const parts = [...match[1].matchAll(/'([A-Za-z0-9+/=]+)'/g)].map(m => m[1]);
      const decoded = gunzipSync(Buffer.from(parts.join(''), 'base64'));
      const source = fs.readFileSync(require.resolve(i ? './diagnostic.cjs' : V1_REL));
      assert.equal(decoded.equals(source), true, `${format} round ${i + 1}`);
      assert.equal(sha(decoded), match[2]);
      assert.equal(sha(Buffer.concat([source, Buffer.from('\n// changed source\n')])) === match[2], false);
    }
  }
});

test('packaging: SHA-256 rejects changed payload and digest before any request in both command formats', async () => {
  const { gzipSync, gunzipSync } = require('node:zlib');
  for (const format of ['heredoc', 'one-line']) {
    const code = packagedCode(format);
    const match = /const round2 = load\(unpack\(\[([\s\S]*?)\], '([a-f0-9]{64})'\)/.exec(code);
    assert.equal(Boolean(match), true);
    const parts = [...match[1].matchAll(/'([A-Za-z0-9+/=]+)'/g)].map(m => m[1]);
    const modified = gzipSync(Buffer.concat([gunzipSync(Buffer.from(parts.join(''), 'base64')), Buffer.from('\n// changed source\n')])).toString('base64');
    const changedPayload = code.replace(match[1], `'${modified}'`);
    const changedDigest = code.replace(match[2], '0'.repeat(64));
    for (const changed of [changedPayload, changedDigest]) {
      const iso = packagedSandbox(changed);
      await iso.run();
      assert.equal(JSON.parse(iso.lines.at(-1)).code, 'PACKAGED_SCRIPT_INVALID');
      assert.equal(iso.blockedSockets(), 0);
      assert.equal(iso.markers.size, 0);
      assert.equal(iso.process.exitCode, 2);
    }
  }
});

test('packaging: no credentials blocks execution; fake key with disabled sockets is redacted and rerun is blocked', async () => {
  for (const format of ['heredoc', 'one-line']) {
    for (const [env, expected] of [[{}, 'RENDER_SERVICE_MISMATCH'],
      [{ RENDER_SERVICE_ID: 'srv-da84cg8u01pc73cjasa0' }, 'KEY_MISSING']]) {
      const iso = packagedSandbox(packagedCode(format), env);
      await iso.run();
      assert.equal(JSON.parse(iso.lines.at(-1)).code, expected);
      assert.equal(iso.blockedSockets(), 0);
      assert.equal(iso.markers.size, 0);
    }
    const iso = packagedSandbox(packagedCode(format), { RENDER_SERVICE_ID: 'srv-da84cg8u01pc73cjasa0', KOSCOM_API_KEY: KEY });
    await iso.run();
    assert.equal(iso.lines.length, 3);
    assert.equal(JSON.parse(iso.lines[1]).api, 'TRANSPORT_ERROR');
    assert.equal(JSON.parse(iso.lines[2]).actualCalls, 1);
    assert.equal(iso.blockedSockets(), 1); // intercepted before opening any socket
    assert.equal(iso.markers.size, 1);
    await iso.run();
    assert.equal(JSON.parse(iso.lines.at(-1)).code, 'ONCE_GUARD_BLOCKED');
    assert.equal(iso.blockedSockets(), 1);
    assert.equal(iso.lines.join('').includes(KEY), false);
    assert.equal(/https?:\/\/|apikey=/.test(iso.lines.join('')), false);
  }
});

test.after(() => assert.equal(realNetworkAttempts, 0));
test('no test reached the real network', () => assert.equal(realNetworkAttempts, 0));
