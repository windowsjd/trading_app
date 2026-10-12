'use strict';

// Round-2 standalone investigation. Never imports the app, its clients, DB or Redis.
// Transport (GET only, no redirect, no retry, timeout, bounded body), lossless JSON,
// exact decimals, rate-header filtering and the output gate are the round-1 module
// that already ran on Render, loaded unchanged (sha256 4655ed52…, pinned by the
// packaged command).
const v1 = require('../2026-10-12-koscom-history-limits/diagnostic.cjs');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');

const RENDER_SERVICE_ID = 'srv-da84cg8u01pc73cjasa0';
const ANCHOR = '2026-10-12';
const RUN_FIRST_KST_DATE = '2026-10-13';
const RUN_LAST_KST_DATE = '2026-10-31';
const CLOSED = [
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-02',
  '2026-05-01', '2026-05-05', '2026-05-25', '2026-06-03', '2026-07-17',
  '2026-08-17', '2026-09-24', '2026-09-25', '2026-10-05', '2026-10-09',
  '2026-12-25', '2026-12-31',
];
const SYMBOL = '005930';
const PAIRS = { kospi: ['005930', '000660'], kosdaq: ['086520', '247540'] };
const MAX_CALLS = 17;
const GAP_MS = 1100;
const MARKER = '/tmp/trading-class-koscom-10m-date-quota-20261013.once';
const ROUND1_MARKER = '/tmp/trading-class-koscom-history-20261012.once';
const FIELDS = ['open', 'high', 'low', 'close', 'volume', 'amount'];
const INTRADAY_NAMES = ['inddOpnprc', 'inddHgprc', 'inddLwprc', 'inddClsprc', 'inddTrdvol', 'inddTrdval'];
const DAILY_NAMES = ['opnprc', 'hgprc', 'lwprc', 'trdPrc', 'accTrdvol', 'accTrdval'];
// Minutes of the KST day. 10-minute labels are END labels (round-1 evidence):
// 09:10 covers 09:00–09:10; 15:30 covers the 15:20–15:30 closing single-price auction.
const OPEN = 540, SPLIT = 780, AUCTION_START = 920, CLOSE = 930;
const range = (from, to) => Array.from({ length: (to - from) / 10 + 1 }, (_, i) => from + i * 10);
const END_GRID = range(OPEN + 10, CLOSE);
const START_GRID = range(OPEN, CLOSE - 10);
const compact = date => date.replaceAll('-', '');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = n => (n === null || n === undefined ? null : v1.decimalText(n));
const signedText = n => (n === null ? null : n < 0n ? `-${text(-n)}` : text(n));
const minuteText = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const PLAN = Object.freeze([
  { kind: 'intraday', role: 'TARGET_96', date: '2026-05-19' },
  { kind: 'history', role: 'TARGET_96', date: '2026-05-19' },
  { kind: 'intraday', role: 'ADJACENT_PREVIOUS', date: '2026-05-18' },
  { kind: 'history', role: 'ADJACENT_PREVIOUS', date: '2026-05-18' },
  { kind: 'intraday', role: 'TARGET_60', date: '2026-07-10' },
  { kind: 'history', role: 'TARGET_60', date: '2026-07-10' },
  { kind: 'intraday', role: 'BEFORE_HOLIDAY', date: '2026-10-08' },
  { kind: 'history', role: 'BEFORE_HOLIDAY', date: '2026-10-08' },
  { kind: 'intraday', role: 'HOLIDAY', date: '2026-10-09' },
  { kind: 'intraday', role: 'AFTER_HOLIDAY', date: '2026-10-12' },
  { kind: 'history', role: 'AFTER_HOLIDAY', date: '2026-10-12' },
  { kind: 'multiquote', role: 'MULTI', market: 'kospi', item: 'price', symbols: PAIRS.kospi },
  { kind: 'multiquote', role: 'MULTI', market: 'kospi', item: 'orderbook', symbols: PAIRS.kospi },
  { kind: 'multiquote', role: 'MULTI', market: 'kosdaq', item: 'price', symbols: PAIRS.kosdaq },
  { kind: 'multiquote', role: 'MULTI', market: 'kosdaq', item: 'orderbook', symbols: PAIRS.kosdaq },
  // Quota comparison only; sent only when the original response carried a daily quota header.
  { kind: 'intraday', role: 'QUOTA_REPEAT', date: '2026-10-12', repeatOf: 10 },
  { kind: 'multiquote', role: 'QUOTA_REPEAT', market: 'kospi', item: 'price', symbols: PAIRS.kospi, repeatOf: 12 },
].map((call, i) => ({ id: i + 1, ...call })));

function plan() {
  return PLAN.map(call => ({ ...call, ...(call.symbols ? { symbols: [...call.symbols] } : {}) }));
}

function isTradingDay(date) {
  return /^2026-\d{2}-\d{2}$/.test(date) && new Date(`${date}T00:00:00Z`).getUTCDay() % 6 !== 0 && !CLOSED.includes(date);
}

function sessionOffset(date) {
  if (!isTradingDay(date)) return null;
  let n = 0;
  for (let t = Date.parse(`${date}T00:00:00Z`) + 86400000; t <= Date.parse(`${ANCHOR}T00:00:00Z`); t += 86400000)
    if (isTradingDay(new Date(t).toISOString().slice(0, 10))) n++;
  return n;
}

function checkPlan() {
  const expected = { '2026-05-18': 97, '2026-05-19': 96, '2026-07-10': 60, '2026-10-08': 1, '2026-10-12': 0 };
  for (const [date, offset] of Object.entries(expected)) if (sessionOffset(date) !== offset) throw new Error('PLAN_INVALID');
  if (isTradingDay('2026-10-09') || PLAN.length !== MAX_CALLS) throw new Error('PLAN_INVALID');
}

function kst(nowMs) {
  const d = new Date(nowMs + 9 * 3600000);
  return { date: d.toISOString().slice(0, 10), clock: d.toISOString().slice(11, 19),
    second: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds() };
}

function marketState(nowMs) {
  const k = kst(nowMs);
  return isTradingDay(k.date) && k.second >= OPEN * 60 && k.second < CLOSE * 60 ? 'OPEN' : 'CLOSED';
}

function buildUrl(base, apiKey, call) {
  if (!['https://oap.k-mydata.org', 'https://testoap.k-mydata.org'].includes(base)) throw new Error('BASE_NOT_ALLOWED');
  if (!apiKey || typeof apiKey !== 'string') throw new Error('KEY_MISSING');
  if (!plan().some(p => JSON.stringify(p) === JSON.stringify(call))) throw new Error('REQUEST_NOT_IN_PLAN');
  let path, query;
  if (call.kind === 'intraday') {
    path = `/v3/market/realtime/kospi/stocks/${SYMBOL}/intraday`;
    query = { inddCycleTpCd: '600', inqStrtDd: compact(call.date), strtTm: '0900', endTm: '1530' };
  } else if (call.kind === 'history') {
    path = `/v3/market/closed/kospi/${SYMBOL}/history`;
    query = { trnsmCycleTpCd: 'D', inqStrtDd: compact(call.date), inqEndDd: compact(call.date), reqCnt: '1' };
  } else {
    path = `/v3/market/realtime/${call.market}/multiquote/stocks/${call.item}`;
    query = { isuCd: call.symbols.join(',') };
  }
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  // Same query-key authentication as the app and round 1. No fallback auth method.
  url.searchParams.set('apikey', apiKey);
  return url;
}

/** HHMMSScc, the existing KOSCOM normalizer format. Returns seconds of the day. */
function clockSeconds(value, minuteOnly) {
  if (typeof value !== 'string' || !/^\d{1,8}$/.test(value)) throw new Error('INVALID_TIME');
  const s = value.padStart(8, '0');
  const h = Number(s.slice(0, 2)), m = Number(s.slice(2, 4)), sec = Number(s.slice(4, 6));
  if (h > 23 || m > 59 || sec > 59 || (minuteOnly && s.slice(4) !== '0000')) throw new Error('INVALID_TIME');
  return h * 3600 + m * 60 + sec;
}

function ohlcv(row, names) {
  if (!isRecord(row)) throw new Error('INVALID_ROW');
  const values = Object.fromEntries(FIELDS.map((field, i) => [field, v1.decimal(row[names[i]], i < 4)]));
  if (values.high < values.low || values.high < values.open || values.high < values.close ||
      values.low > values.open || values.low > values.close) throw new Error('INVALID_OHLC');
  return values;
}

function aggregate(rows) {
  if (!rows.length) return null;
  const sorted = rows.slice().sort((a, b) => a.time - b.time);
  return { open: sorted[0].open, close: sorted.at(-1).close,
    high: sorted.reduce((n, r) => (r.high > n ? r.high : n), sorted[0].high),
    low: sorted.reduce((n, r) => (r.low < n ? r.low : n), sorted[0].low),
    volume: sorted.reduce((n, r) => n + r.volume, 0n), amount: sorted.reduce((n, r) => n + r.amount, 0n) };
}

const aggregateText = agg => (agg ? Object.fromEntries(FIELDS.map(f => [f, text(agg[f])])) : null);

/** Same identity and hash shape as round 1, so window hashes are comparable across runs. */
function fingerprint(rows) {
  if (!rows.length) return null;
  const identities = rows.map(r => [r.time, ...FIELDS.map(f => v1.decimalText(r[f]))]).sort((a, b) => a[0] - b[0]);
  return createHash('sha256').update(JSON.stringify(identities)).digest('hex');
}

function apiErrorCategory(error) {
  const body = JSON.stringify(error ?? null).slice(0, 4096).toLowerCase();
  if (/429|rate.?limit|quota|too many|호출.{0,30}(한도|제한)/.test(body)) return 'API_RATE_LIMIT';
  if (/401|403|api.?key|unauthor|forbidden|permission|authenti|authoriz|credential|인증|권한|접근|계약|허용되지/.test(body)) return 'API_AUTH_ERROR';
  if (/제공\s*시간|시간이\s*아닙니다/.test(body)) return 'API_SERVICE_HOURS';
  return 'API_ERROR_STOP';
}

function analyzeIntraday(call, result, output) {
  if (result.isuSrtCd !== SYMBOL || !Array.isArray(result.hisLists)) return 'RESPONSE_SHAPE_ERROR';
  const rows = [];
  let invalid = 0;
  for (const row of result.hisLists) {
    try {
      const values = ohlcv(row, INTRADAY_NAMES);
      const acc = name => (row[name] === undefined ? null : v1.decimal(row[name]));
      rows.push({ time: clockSeconds(row.inddTm, true) / 60, ...values,
        accVolume: acc('inddAccTrdvol'), accAmount: acc('inddAccTrdval') });
    } catch { invalid++; }
  }
  const rowCount = result.hisLists.length;
  const times = rows.map(r => r.time);
  const labels = new Set(times);
  const duplicates = times.length - labels.size;
  const ascending = times.every((t, i) => i === 0 || t >= times[i - 1]);
  const descending = times.every((t, i) => i === 0 || t <= times[i - 1]);
  const sorted = rows.slice().sort((a, b) => a.time - b.time);
  const offGrid = times.filter(t => t % 10 !== 0).length;
  const outsideRequest = times.filter(t => t < OPEN || t > CLOSE).length;
  const missingEnd = END_GRID.filter(t => !labels.has(t));
  const extraEnd = [...labels].filter(t => !END_GRID.includes(t)).sort((a, b) => a - b);
  const missingStart = START_GRID.filter(t => !labels.has(t));
  const extraStart = [...labels].filter(t => !START_GRID.includes(t));
  const boundaryEvidence = !rows.length ? 'NO_ROWS'
    : !extraEnd.length && extraStart.length ? 'END_GRID'
      : !extraStart.length && extraEnd.length ? 'START_GRID'
        : !extraEnd.length && !extraStart.length ? 'AMBIGUOUS' : 'NEITHER';
  const usable = invalid === 0 && duplicates === 0 && rowCount <= 100 && (ascending || descending) &&
    offGrid === 0 && outsideRequest === 0;
  // Four-hour buckets under END labels and the app's KRX policy: 15:20/15:25 auction
  // slots are never required; a pre-open row (label ≤ 09:00) is outside the session.
  const bucket = (required, optional) => {
    const present = required.filter(t => labels.has(t)).length;
    return { expected: required.length, present, complete: present === required.length,
      optionalAuctionPresent: optional.some(t => labels.has(t)) };
  };
  const buckets = {
    '09:00-13:00': bucket(END_GRID.filter(t => t <= SPLIT), []),
    '13:00-15:30': bucket(END_GRID.filter(t => t > SPLIT && t <= AUCTION_START), [CLOSE]),
  };
  const auction = sorted.find(r => r.time === CLOSE);
  const preOpen = sorted.filter(r => r.time <= OPEN);
  const accPresent = rows.length > 0 && rows.every(r => r.accVolume !== null && r.accAmount !== null);
  let accConsistent = null, preFirstVolume = null, preFirstAmount = null;
  if (accPresent) {
    accConsistent = sorted.every((r, i) => i === 0 ||
      (r.accVolume - sorted[i - 1].accVolume === r.volume && r.accAmount - sorted[i - 1].accAmount === r.amount));
    preFirstVolume = sorted[0].accVolume - sorted[0].volume;
    preFirstAmount = sorted[0].accAmount - sorted[0].amount;
  }
  const window = sorted.filter(r => r.time > 600 && r.time <= 660);
  const gridComplete = boundaryEvidence === 'END_GRID' ? missingEnd.length === 0
    : boundaryEvidence === 'START_GRID' ? missingStart.length === 0 : false;
  Object.assign(output, { api: 'SUCCESS', rowCount, validRows: rows.length, invalidRows: invalid,
    duplicateTimes: duplicates, order: times.length < 2 ? 'NOT_APPLICABLE' : ascending ? 'ASCENDING' : descending ? 'DESCENDING' : 'NON_MONOTONIC',
    offGrid, outsideRequest, overHundred: rowCount > 100, possiblyTruncatedAtHundred: rowCount === 100,
    first: sorted.length ? minuteText(sorted[0].time) : null, last: sorted.length ? minuteText(sorted.at(-1).time) : null,
    boundaryEvidence, missingEndLabels: missingEnd.map(minuteText), extraEndLabels: extraEnd.map(minuteText),
    missingStartLabelCount: missingStart.length, gridComplete,
    fourHourBucketsEndLabels: buckets,
    auctionRow: auction ? { present: true, singlePrice: auction.open === auction.high && auction.high === auction.low && auction.low === auction.close,
      volume: text(auction.volume) } : { present: false },
    preOpenRows: preOpen.length,
    cumulative: { present: accPresent, consistent: accConsistent, preFirstBarVolume: signedText(preFirstVolume),
      preFirstBarAmountNegative: preFirstAmount === null ? null : preFirstAmount < 0n,
      lastAccVolume: accPresent ? text(sorted.at(-1).accVolume) : null },
    allRowsAggregate: aggregateText(aggregate(rows)),
    sessionAggregate: aggregateText(aggregate(sorted.filter(r => r.time > OPEN))),
    fingerprint: fingerprint(rows), round1WindowFingerprint: window.length ? fingerprint(window) : null,
    round1WindowRows: window.length, usable });
  output.verdict = !usable ? '검증 실패' : !rows.length ? '정상적인 데이터 없음'
    : gridComplete ? '정규장 전체 구간 반환·날짜 미확정' : '일부 구간 누락·날짜 미확정';
  return { rows, auction, accPresent, lastAcc: accPresent ? { volume: sorted.at(-1).accVolume, amount: sorted.at(-1).accAmount } : null };
}

function analyzeHistory(call, result, output) {
  if (result.isuSrtCd !== SYMBOL || !Array.isArray(result.hisLists)) return 'RESPONSE_SHAPE_ERROR';
  const rows = [];
  let invalid = 0;
  const observed = new Set();
  for (const row of result.hisLists) {
    if (isRecord(row) && typeof row.trdDd === 'string' && /^\d{8}$/.test(row.trdDd)) observed.add(row.trdDd);
    try {
      const values = ohlcv(row, DAILY_NAMES);
      if (row.trdDd !== compact(call.date)) throw new Error('DAILY_DATE_MISMATCH');
      rows.push(values);
    } catch { invalid++; }
  }
  const usable = invalid === 0 && rows.length === 1;
  Object.assign(output, { api: 'SUCCESS', rowCount: result.hisLists.length, validRows: rows.length, invalidRows: invalid,
    observedTrdDd: [...observed].sort(), trdDdMatches: observed.size === 1 && observed.has(compact(call.date)),
    daily: rows.length === 1 ? aggregateText(rows[0]) : null, usable });
  output.verdict = usable ? '날짜 명시 일봉 확인' : !result.hisLists.length ? '정상적인 데이터 없음'
    : output.trdDdMatches ? '검증 실패' : '일봉 날짜 불일치';
  return { daily: usable ? rows[0] : null };
}

function analyzeMultiquote(call, result, output, requestedAtMs) {
  if (!Array.isArray(result.isulist)) return 'RESPONSE_SHAPE_ERROR';
  const list = result.isulist;
  const codes = list.map(r => (isRecord(r) && typeof r.isuSrtCd === 'string' ? r.isuSrtCd : null));
  const state = marketState(requestedAtMs);
  const nowSecond = kst(requestedAtMs).second;
  const perSymbol = call.symbols.map(symbol => {
    const matches = list.filter((_, i) => codes[i] === symbol);
    if (matches.length !== 1) return { symbol, present: false, duplicate: matches.length > 1 };
    const row = matches[0];
    if (call.item === 'price') {
      let priceValid = false, tradeClock = null, ageSeconds = null;
      try { v1.decimal(row.trdPrc, true); priceValid = true; } catch { /* invalid price stays false */ }
      try {
        const s = clockSeconds(row.trdTm, false);
        tradeClock = `${minuteText(Math.floor(s / 60))}:${String(s % 60).padStart(2, '0')}`;
        if (state === 'OPEN') ageSeconds = nowSecond - s;
      } catch { /* invalid clock stays null */ }
      // No trdDd in the multiquote price contract: a clock alone cannot prove today's trade.
      const freshness = state !== 'OPEN' ? 'NOT_EVALUATED_MARKET_CLOSED' : ageSeconds === null ? 'UNKNOWN'
        : ageSeconds < -5 ? 'CLOCK_AHEAD' : ageSeconds <= 300 ? 'FRESH_CLOCK' : 'STALE_CLOCK';
      return { symbol, present: true, priceValid, tradeClock, ageSeconds, freshness, hasTrdDd: row.trdDd !== undefined };
    }
    const side = name => {
      let fields = 0, positive = 0, monotonic = true, previous = null;
      for (let i = 1; i <= 10; i++) {
        const p = row[`${name}Step${i}BstordPrc`], q = row[`${name}Step${i}BstordRqty`];
        if (p === undefined || q === undefined) continue;
        fields++;
        try {
          const price = v1.decimal(p);
          v1.decimal(q);
          if (price > 0n) {
            positive++;
            if (previous !== null && (name === 'ask' ? price <= previous : price >= previous)) monotonic = false;
            previous = price;
          }
        } catch { monotonic = false; }
      }
      return { fields, positive, monotonic };
    };
    const ask = side('ask'), bid = side('bid');
    let crossed = null;
    try {
      const a = v1.decimal(row.askStep1BstordPrc), b = v1.decimal(row.bidStep1BstordPrc);
      if (a > 0n && b > 0n) crossed = b > a;
    } catch { /* missing best levels leave crossed unknown */ }
    return { symbol, present: true, askLevelFields: ask.fields, bidLevelFields: bid.fields,
      askPositiveLevels: ask.positive, bidPositiveLevels: bid.positive,
      levelsMonotonic: ask.monotonic && bid.monotonic, crossed };
  });
  const matched = perSymbol.filter(s => s.present).length;
  const unexpected = codes.filter(c => !call.symbols.includes(c)).length;
  const tenLevelFields = call.item === 'orderbook' && matched > 0 &&
    perSymbol.every(s => !s.present || (s.askLevelFields === 10 && s.bidLevelFields === 10));
  Object.assign(output, { api: 'SUCCESS', marketStateAtRequest: state, requested: call.symbols.length,
    returned: list.length, matched, unexpected, perSymbol,
    ...(call.item === 'orderbook' ? { tenLevelFields } : {}), usable: true });
  output.verdict = matched === call.symbols.length && unexpected === 0 ? '요청 종목 전체 반환'
    : matched ? '일부 종목만 반환' : '요청 종목 미반환';
  return {};
}

function analyze(call, packet, requestedAtMs = Date.now()) {
  const output = { type: 'request', id: call.id, kind: call.kind, role: call.role,
    ...(call.date ? { date: call.date, tradingDay: isTradingDay(call.date), offsetFromAnchor: sessionOffset(call.date) } : {}),
    ...(call.market ? { market: call.market, item: call.item, symbols: call.symbols } : {}),
    ...(call.repeatOf ? { repeatOf: call.repeatOf } : {}),
    requestedAtKst: kst(requestedAtMs).clock, http: packet.status, api: 'UNCONFIRMED',
    rateHeaders: v1.rateHeaders(packet.headers), verdict: '검증 실패', usable: false };
  const failure = (code, verdict) => ({ output: { ...output, api: code, ...(verdict ? { verdict } : {}) }, detail: null, stop: code });
  if (packet.code) return failure(packet.code);
  if ([401, 403].includes(packet.status)) return failure('HTTP_AUTH_ERROR', '권한 부족 또는 인증 실패');
  if (packet.status === 429) return failure('HTTP_RATE_LIMIT', '호출 제한');
  if (packet.status >= 300 && packet.status < 400) return failure('REDIRECT_REJECTED');
  let body;
  try { body = v1.losslessJson(packet.body); } catch { return failure(packet.status === 200 ? 'INVALID_JSON' : 'HTTP_ERROR_STOP'); }
  if (isRecord(body) && (body.error != null || body.result?.error != null)) {
    const error = body.error ?? body.result.error;
    const category = apiErrorCategory(error);
    const code = isRecord(error) && /^-?[A-Za-z0-9_]{1,16}$/.test(String(error.code ?? '')) ? String(error.code) : null;
    const verdict = { API_AUTH_ERROR: '권한 부족 또는 인증 실패', API_RATE_LIMIT: '호출 제한',
      API_SERVICE_HOURS: '제공 시간 외 응답(권한 판정 불가)' }[category];
    const result = failure(category, verdict);
    result.output.apiErrorCode = code;
    // A documented "outside service hours" answer is not a permission/quota signal; keep the plan.
    if (category === 'API_SERVICE_HOURS') result.stop = null;
    return result;
  }
  if (packet.status !== 200) return failure('HTTP_ERROR_STOP');
  if (!isRecord(body) || body.jsonrpc !== '2.0' || !isRecord(body.result)) return failure('RESPONSE_SHAPE_ERROR');
  const analyzer = { intraday: analyzeIntraday, history: analyzeHistory, multiquote: analyzeMultiquote }[call.kind];
  const detail = analyzer(call, body.result, output, requestedAtMs);
  if (typeof detail === 'string') return failure(detail);
  return { output, detail, stop: null };
}

function compareDaily(intraday, daily) {
  if (!intraday?.output.usable || !intraday.detail.rows.length || !daily?.detail?.daily) return { status: 'UNAVAILABLE' };
  const s = aggregate(intraday.detail.rows), d = daily.detail.daily;
  const relation = (a, b) => (a === b ? 'EQUAL' : a < b ? 'SESSION_LESS' : 'SESSION_GREATER');
  const diff = (a, b) => text(a > b ? a - b : b - a);
  const acc = intraday.detail.lastAcc;
  const auction = intraday.detail.auction;
  return { status: 'COMPARED', intradayId: intraday.output.id, dailyId: daily.output.id,
    openEqual: s.open === d.open, highEqual: s.high === d.high, lowEqual: s.low === d.low, closeEqual: s.close === d.close,
    priceWithinDailyRange: s.low >= d.low && s.high <= d.high,
    volumeRelation: relation(s.volume, d.volume), volumeDifference: diff(s.volume, d.volume),
    amountRelation: relation(s.amount, d.amount), amountDifference: diff(s.amount, d.amount),
    lastCumulativeVolumeRelation: acc ? relation(acc.volume, d.volume) : null,
    lastCumulativeAmountRelation: acc ? relation(acc.amount, d.amount) : null,
    auctionCloseEqualsDailyClose: auction ? auction.close === d.close : null };
}

function attribution(cmp, repeated) {
  if (repeated) return 'CONTRADICTED_REPEATED_ACROSS_DATES';
  if (cmp.status !== 'COMPARED') return 'UNCONFIRMED_NO_COMPARISON';
  if (!cmp.priceWithinDailyRange || cmp.volumeRelation === 'SESSION_GREATER' || cmp.amountRelation === 'SESSION_GREATER')
    return 'CONTRADICTED_BY_DATED_DAILY';
  if (cmp.openEqual && cmp.highEqual && cmp.lowEqual && cmp.closeEqual) return 'DATED_DAILY_OHLC_EXACT';
  return 'CONSISTENT_RANGE_ONLY';
}

function quotaAnalysis(analyses) {
  const category = o => (o.kind === 'multiquote' ? `multiquote-${o.item}` : o.kind);
  const observations = analyses.map(a => ({ id: a.output.id, category: category(a.output),
    limitDay: a.output.rateHeaders['x-ratelimit-limit-day'] ?? null,
    remainingDay: a.output.rateHeaders['x-ratelimit-remaining-day'] ?? null,
    otherRateHeaders: Object.keys(a.output.rateHeaders).filter(k => !k.startsWith('x-ratelimit-') || !k.endsWith('-day')).sort() }));
  const numeric = observations.filter(o => /^\d+$/.test(o.remainingDay ?? ''));
  const consecutive = numeric.slice(1).map((o, i) => ({ fromId: numeric[i].id, id: o.id,
    observedDecrease: (BigInt(numeric[i].remainingDay) - BigInt(o.remainingDay)).toString() }));
  const sameCategory = [];
  for (let j = 0; j < numeric.length; j++) {
    const i = numeric.findLastIndex((o, k) => k < j && o.category === numeric[j].category);
    if (i < 0) continue;
    const between = observations.filter(o => o.id > numeric[i].id && o.id <= numeric[j].id);
    const decrease = BigInt(numeric[i].remainingDay) - BigInt(numeric[j].remainingDay);
    sameCategory.push({ category: numeric[j].category, fromId: numeric[i].id, id: numeric[j].id, observedDecrease: decrease.toString(),
      diagnosticCallsBetween: between.length, sameCategoryCallsBetween: between.filter(o => o.category === numeric[j].category).length });
  }
  const ranges = {};
  for (const o of numeric) {
    const v = BigInt(o.remainingDay), r = ranges[o.category];
    ranges[o.category] = r ? { min: v < r.min ? v : r.min, max: v > r.max ? v : r.max, count: r.count + 1 } : { min: v, max: v, count: 1 };
  }
  const negative = p => p.observedDecrease.startsWith('-');
  // An increase can only come from another counter (separate budget or gateway node) or a reset.
  const sharedContradicted = consecutive.some(negative) ||
    sameCategory.some(p => BigInt(p.observedDecrease) < BigInt(p.diagnosticCallsBetween));
  const perCategoryContradicted = sameCategory.some(p => BigInt(p.observedDecrease) < BigInt(p.sameCategoryCallsBetween));
  return { observations, consecutive, sameCategory,
    categoryRanges: Object.fromEntries(Object.entries(ranges).map(([k, r]) => [k, { min: r.min.toString(), max: r.max.toString(), count: r.count }])),
    limitValues: [...new Set(observations.map(o => o.limitDay).filter(Boolean))],
    increasesBetweenConsecutiveCalls: consecutive.filter(negative).length,
    singleStrictSharedCounter: !numeric.length ? 'NO_DATA' : sharedContradicted ? 'CONTRADICTED_BY_OBSERVATION' : 'NOT_CONTRADICTED',
    withinCategoryMonotonic: !sameCategory.length ? 'NO_DATA' : sameCategory.some(negative) ? 'NO' : 'YES',
    perCategoryCounter: !sameCategory.length ? 'NO_DATA' : perCategoryContradicted ? 'CONTRADICTED_BY_OBSERVATION' : 'NOT_CONTRADICTED',
    perCategoryExact: sameCategory.length > 0 && sameCategory.every(p => p.observedDecrease === String(p.sameCategoryCallsBetween)),
    operatingCallsMayOverlap: true, contractScope: 'UNCONFIRMED' };
}

function finalSummary(analyses, calls, stopReason, skipped = [], quotaResetCrossed = false) {
  const byId = id => analyses.find(a => a.output.id === id);
  const intraday = analyses.filter(a => a.output.kind === 'intraday' && a.output.role !== 'QUOTA_REPEAT');
  const repeatedPairs = [];
  const identicalRowPairs = [];
  for (let i = 0; i < intraday.length; i++) for (let j = i + 1; j < intraday.length; j++) {
    const a = intraday[i], b = intraday[j];
    if (!a.detail?.rows.length || !b.detail?.rows.length) continue;
    if (a.output.fingerprint === b.output.fingerprint) repeatedPairs.push([a.output.date, b.output.date]);
    const keys = new Set(a.detail.rows.map(r => JSON.stringify([r.time, ...FIELDS.map(f => text(r[f]))])));
    const same = b.detail.rows.filter(r => keys.has(JSON.stringify([r.time, ...FIELDS.map(f => text(r[f]))]))).length;
    if (same) identicalRowPairs.push({ dates: [a.output.date, b.output.date], identicalRows: same });
  }
  // A closed date echoing a session is reported in the holiday block; it does not taint that session.
  const repeatedDate = date => repeatedPairs.some(p => p.includes(date) && p.every(isTradingDay));
  const dates = [[1, 2], [3, 4], [5, 6], [7, 8], [10, 11]].map(([i, d]) => {
    const cmp = compareDaily(byId(i), byId(d));
    const o = byId(i)?.output;
    return { date: PLAN[i - 1].date, role: PLAN[i - 1].role, comparison: cmp,
      attribution: o ? attribution(cmp, repeatedDate(o.date)) : 'NOT_REQUESTED' };
  });
  const holiday = byId(9), before = byId(7), after = byId(10);
  const holidayVsPrevDaily = compareDaily(holiday, byId(8));
  const holidayBlock = holiday ? {
    rowCount: holiday.output.rowCount ?? null, validRows: holiday.output.validRows ?? null,
    fingerprintEqualsBeforeHoliday: Boolean(holiday.output.fingerprint && holiday.output.fingerprint === before?.output.fingerprint),
    fingerprintEqualsAfterHoliday: Boolean(holiday.output.fingerprint && holiday.output.fingerprint === after?.output.fingerprint),
    aggregateMatchesBeforeHolidayDailyOhlc: holidayVsPrevDaily.status === 'COMPARED' &&
      holidayVsPrevDaily.openEqual && holidayVsPrevDaily.highEqual && holidayVsPrevDaily.lowEqual && holidayVsPrevDaily.closeEqual,
    verdict: !holiday.output.usable ? 'UNAVAILABLE' : !holiday.output.validRows ? 'HOLIDAY_EMPTY'
      : holiday.output.fingerprint === before?.output.fingerprint ? 'HOLIDAY_RETURNED_PREVIOUS_SESSION' : 'HOLIDAY_RETURNED_UNMATCHED_ROWS',
    // Rows returned for a closed date are never that date's candles.
    storeAsHolidayCandles: false } : null;
  const repeat = byId(16);
  const multiquote = analyses.filter(a => a.output.kind === 'multiquote').map(a => ({ id: a.output.id, market: a.output.market,
    item: a.output.item, api: a.output.api, http: a.output.http, requested: a.output.requested ?? null,
    matched: a.output.matched ?? null, tenLevelFields: a.output.tenLevelFields ?? null, verdict: a.output.verdict }));
  return { type: 'summary', actualCalls: calls, maxCalls: MAX_CALLS, stopped: Boolean(stopReason), stopReason, skipped,
    completePlan: !stopReason && calls + skipped.length === MAX_CALLS,
    sessions: intraday.map(a => ({ id: a.output.id, date: a.output.date, role: a.output.role, rowCount: a.output.rowCount ?? null,
      first: a.output.first ?? null, last: a.output.last ?? null, boundaryEvidence: a.output.boundaryEvidence ?? null,
      gridComplete: a.output.gridComplete ?? null, verdict: a.output.verdict })),
    dates, repeatedAcrossDates: repeatedPairs, identicalRowPairs, holiday: holidayBlock,
    reproducibility: repeat?.output.usable ? { id: 16, sameFingerprintAsId10: repeat.output.fingerprint === after?.output.fingerprint } : null,
    multiquote, quota: quotaAnalysis(analyses), quotaResetCrossed,
    // Date attribution and timestamp semantics still need manual review of these lines.
    actualApiValidationComplete: false };
}

function pause(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

function repeatSkipReason(call, analyses) {
  const original = analyses.find(a => a.output.id === call.repeatOf);
  if (!original || original.output.api !== 'SUCCESS') return 'ORIGINAL_NOT_SUCCESSFUL';
  if (!/^\d+$/.test(original.output.rateHeaders['x-ratelimit-remaining-day'] ?? '')) return 'NO_QUOTA_HEADER_ON_ORIGINAL';
  return null;
}

async function runStudy({ base, apiKey, emit, signal, transport = v1.requestOnce, sleep = pause,
  now = () => performance.now(), wallNow = () => Date.now() }) {
  const analyses = [], skipped = [], kstSeconds = [];
  let calls = 0, stopReason = null, previousCompletion = null;
  for (const call of plan()) {
    if (call.repeatOf !== undefined) {
      const reason = repeatSkipReason(call, analyses);
      if (reason) { skipped.push({ id: call.id, reason }); continue; }
    }
    if (calls >= MAX_CALLS) { stopReason = 'CALL_CAP'; break; }
    if (calls > 0) await sleep(GAP_MS, signal);
    if (signal?.aborted) { stopReason = 'CANCELED'; break; }
    const start = now();
    if (previousCompletion !== null && start - previousCompletion < 1000) { stopReason = 'SPACING_GUARD'; break; }
    const requestedAt = wallNow();
    kstSeconds.push(kst(requestedAt));
    let packet;
    try {
      const url = buildUrl(base, apiKey, call);
      calls++;
      packet = await transport(url, { signal });
    } catch { stopReason = 'TRANSPORT_ERROR'; break; }
    previousCompletion = now();
    const analysis = analyze(call, packet, requestedAt);
    analysis.output.elapsedMs = Math.max(0, Math.round(previousCompletion - start));
    analyses.push(analysis);
    emit(analysis.output);
    if (analysis.stop) { stopReason = analysis.stop; break; }
    if (analysis.output.rateHeaders['x-ratelimit-remaining-day'] === '0') { stopReason = 'DAILY_QUOTA_EXHAUSTED'; break; }
  }
  // Provider quota resets at 09:00 KST; deltas across that instant are meaningless.
  const crossed = kstSeconds.some((k, i) => i > 0 && (k.date !== kstSeconds[i - 1].date ||
    (kstSeconds[i - 1].second < OPEN * 60 && k.second >= OPEN * 60)));
  const summary = finalSummary(analyses, calls, stopReason, skipped, crossed);
  emit(summary);
  return summary;
}

async function main() {
  let callsStarted = false;
  const apiKey = process.env.KOSCOM_API_KEY?.trim() ?? '';
  const emit = v1.safeEmitter(apiKey);
  try {
    if (process.env.RENDER_SERVICE_ID !== RENDER_SERVICE_ID) throw new Error('RENDER_SERVICE_MISMATCH');
    if (Number(process.versions.node.split('.')[0]) < 22 || v1.losslessJson('1234567890123456789012') !== '1234567890123456789012') throw new Error('RUNTIME_UNSUPPORTED');
    if (process.env.NODE_DEBUG || process.env.NODE_DEBUG_NATIVE) throw new Error('DEBUG_OUTPUT_ENABLED');
    checkPlan();
    const base = process.env.KOSCOM_BASE_URL?.trim() || 'https://oap.k-mydata.org';
    buildUrl(base, apiKey, plan()[0]);
    const nowKst = kst(Date.now());
    if (nowKst.date < RUN_FIRST_KST_DATE || nowKst.date > RUN_LAST_KST_DATE) throw new Error('PLAN_DATE_OUT_OF_RANGE');
    if (nowKst.second >= 8 * 3600 + 55 * 60 && nowKst.second < 9 * 3600 + 60) throw new Error('QUOTA_RESET_WINDOW');
    const runId = randomBytes(6).toString('hex');
    // Diagnostic-only marker. Leave it in place after success/error/Ctrl+C. Round-1 marker untouched.
    let marker;
    try { marker = fs.openSync(MARKER, 'wx', 0o600); } catch { throw new Error('ONCE_GUARD_BLOCKED'); }
    fs.writeSync(marker, `KOSCOM_10M_DATE_QUOTA_DIAGNOSTIC_DO_NOT_RERUN ${runId}\n`);
    fs.closeSync(marker);
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    const safeId = value => (/^[A-Za-z0-9-]{1,64}$/.test(value ?? '') ? value : null);
    emit({ type: 'start', runId, renderCommit: /^[a-f0-9]{40}$/.test(process.env.RENDER_GIT_COMMIT ?? '') ? process.env.RENDER_GIT_COMMIT : null,
      renderInstanceId: safeId(process.env.RENDER_INSTANCE_ID), startedAt: new Date().toISOString(), startedAtKst: `${nowKst.date} ${nowKst.clock}`,
      marketStateAtStart: marketState(Date.now()), baseEnvironment: base.startsWith('https://testoap.') ? 'TEST' : 'PRODUCTION',
      baseFromEnv: Boolean(process.env.KOSCOM_BASE_URL?.trim()), maxCalls: MAX_CALLS, gapMs: GAP_MS,
      round1MarkerPresent: fs.existsSync(ROUND1_MARKER), calendarVersion: 'KRX_2026_2026.1', anchor: ANCHOR,
      operationsChanged: false, plan: plan() });
    callsStarted = true;
    try {
      const result = await runStudy({ base, apiKey, emit, signal: controller.signal });
      if (result.stopped) process.exitCode = controller.signal.aborted ? 130 : 2;
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
  } catch (error) {
    const allowed = ['RENDER_SERVICE_MISMATCH', 'RUNTIME_UNSUPPORTED', 'DEBUG_OUTPUT_ENABLED', 'PLAN_INVALID', 'BASE_NOT_ALLOWED',
      'KEY_MISSING', 'PLAN_DATE_OUT_OF_RANGE', 'QUOTA_RESET_WINDOW', 'ONCE_GUARD_BLOCKED', 'OUTPUT_BLOCKED'];
    const code = allowed.includes(error?.message) ? error.message : 'DIAGNOSTIC_FAILED';
    // Fixed text only. Do not stringify the error, URL, headers or environment.
    process.stdout.write(`${JSON.stringify({ type: 'fatal', code, callsMayHaveStarted: callsStarted, rerunAllowed: false })}\n`);
    process.exitCode = 2;
  }
}

module.exports = { plan, CLOSED, isTradingDay, sessionOffset, checkPlan, marketState, buildUrl, analyze, compareDaily,
  attribution, quotaAnalysis, finalSummary, runStudy, main };
if (require.main === module) void main();
