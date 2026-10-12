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
    [{ status: 500, headers: {}, code: null, body: '{}' }, 'HTTP_ERROR_STOP'],
    [{ ...intradayPacket([]), headers: { 'x-ratelimit-remaining-day': '0' } }, 'DAILY_QUOTA_EXHAUSTED'],
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

test('no test reached the real network', () => {
  assert.equal(realNetworkAttempts, 0);
});
