/* Investigation-only, offline control-flow probes. No application imports may
 * start modules, access environment files, open sockets, or connect to a DB.
 * Run from any directory: node <this file>. Uses existing backend dependencies.
 * Mock results do NOT establish PostgreSQL isolation or native UI behavior.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const backendRequire = createRequire(path.join(root, 'backend/package.json'));
const ts = backendRequire('typescript');
const { Decimal } = backendRequire('@prisma/client/runtime/client');
const noopDecorator = () => () => {};
class Logger { log() {} warn() {} error() {} }
const nest = { Injectable: noopDecorator, Optional: noopDecorator, Inject: noopDecorator,
  WebSocketGateway: noopDecorator, WebSocketServer: noopDecorator, Logger,
  HttpException: class extends Error {}, HttpStatus: { INTERNAL_SERVER_ERROR: 500 } };
const dependencyStub = new Proxy({}, { get: () => class UnusedDependency {} });
let enums;
function load(relative, mocks = {}, globals = {}) {
  const filename = path.join(root, relative);
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true, emitDecoratorMetadata: false, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  const mockedRequire = (name) => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.includes('generated/prisma/client')) return { ...enums, Prisma: { Decimal } };
    if (name === '@nestjs/common' || name === '@nestjs/websockets') return nest;
    if (name === 'node:url') return require(name);
    if (name === 'ws') return { WebSocket: { OPEN: 1 } };
    if (name.startsWith('.')) return dependencyStub;
    throw new Error(`Unmocked external dependency: ${name}`);
  };
  vm.runInNewContext(js, { module, exports: module.exports, require: mockedRequire,
    Date, Map, Set, WeakMap, Promise, console, ...globals }, { filename });
  return module.exports;
}
enums = load('backend/src/generated/prisma/enums.ts');
const d = (x) => new Decimal(x);

async function sessionProbe(kind) {
  let stored = { access: 'A-old-access', refresh: 'A-old-refresh' };
  let notifyCount = 0;
  let onError;
  let resolveRefresh, rejectRefresh, announceStarted;
  const started = new Promise((resolve) => { announceStarted = resolve; });
  const response = new Promise((resolve, reject) => { resolveRefresh = resolve; rejectRefresh = reject; });
  const api = async (config) => ({ retriedWith: config.headers.Authorization });
  api.interceptors = { request: { use() {} }, response: { use(_ok, bad) { onError = bad; } } };
  load('frontend/src/services/api/client.ts', {
    axios: { create: () => api, post: () => { announceStarted(); return response; } },
    '../storage/tokenStorage': {
      getAccessToken: async () => stored.access,
      getRefreshToken: async () => stored.refresh,
      saveTokens: async (access, refresh) => { stored = { access, refresh }; },
      clearTokens: async () => {
        if (kind === 'storage-failure') throw new Error('synthetic storage failure');
        stored = { access: null, refresh: null };
      },
    },
    '../../constants/env': { API_BASE_URL: 'https://offline.invalid/api/v1' },
    './sessionExpiry': { notifySessionExpired: () => { notifyCount++; } },
  });
  const pending = onError({ response: { status: 401 }, config: { headers: {}, url: '/me' } })
    .then((value) => ({ value }), (error) => ({ error: String(error) }));
  await started;
  // A logout and B login finish while the old A refresh is still outstanding.
  if (kind !== 'storage-failure') stored = { access: 'B-access', refresh: 'B-refresh' };
  if (kind === 'success') resolveRefresh({ data: { data: { tokens: {
    accessToken: 'A-new-access', refreshToken: 'A-new-refresh',
  } } } });
  else rejectRefresh(new Error('synthetic refresh failure'));
  const outcome = await pending;
  if (kind === 'success') {
    assert.equal(stored.access, 'A-new-access');
    assert.equal(outcome.value.retriedWith, 'Bearer A-new-access');
  } else if (kind === 'failure') {
    assert.equal(stored.access, null);
    assert.equal(notifyCount, 1);
  } else {
    assert.equal(notifyCount, 0);
    assert.equal(stored.access, 'A-old-access');
  }
  return { kind, storedIdentity: stored.access?.split('-')[0] ?? null, notifyCount,
    observation: kind === 'success' ? 'late A refresh overwrites B tokens and retries A request'
      : kind === 'failure' ? 'late A failure clears B tokens'
        : 'storage rejection prevents expiry notification' };
}

async function matcherProbe(mode, side) {
  const now = new Date('2026-09-22T00:00:00Z');
  const queried = [], filled = [];
  const rows = [1, 2, 3].map((i) => ({
    id: `order-${i}`, side, tradingAccountId: 'account', assetId: 'asset',
    quantity: d(1), limitPrice: d(i === 3 ? 100 : side === 'buy' ? 50 : 150),
    currencyCode: 'USD', reservedAmount: side === 'buy' ? d(100) : null,
    reservedQuantity: side === 'sell' ? d(1) : null, reservationFeeRate: d(0),
    submittedAt: new Date(now.getTime() - (4-i) * 60000),
    tradingAccount: { seasonParticipant: mode === 'season' ? {
      season: { id: 'season', endAt: new Date(now.getTime()+86400000) },
    } : null },
    asset: { id: 'asset', assetType: 'crypto', market: 'BINANCE', symbol: 'BTCUSDT',
      currencyCode: 'USD', priceCurrency: 'USD', settlementCurrency: 'USD', isActive: true },
  }));
  const prisma = { order: { findMany: async (query) => {
    if (query.distinct) return [{ assetId: 'asset' }];
    assert.equal(query.orderBy[0].submittedAt, 'asc');
    assert.equal(query.cursor, undefined);
    const selected = rows.slice().sort((a,b) => a.submittedAt-b.submittedAt).slice(0,query.take);
    queried.push(selected.map((row) => row.id));
    return selected;
  } } };
  const { LimitOrderCandidateRepository } = load('backend/src/orders/limit-order-candidate.repository.ts');
  const { LimitOrderMatchingService } = load('backend/src/orders/limit-order-matching.service.ts', {
    './limit-order-matching.config': { readLimitOrderMatchingConfig: () => ({ batchSize: 2, candleLookbackMs: 900000 }) },
  });
  const repo = new LimitOrderCandidateRepository(prisma);
  const matcher = new LimitOrderMatchingService(prisma, repo, {
    findEligibleClosedCandlesForAsset: async () => [], selectTriggerCandleForOrder: () => null,
  }, { fillLimitOrder: async ({ orderId, plan }) => {
    filled.push(orderId); return { state: 'filled', path: plan.path };
  } });
  matcher.resolvePathASnapshot = async () => ({ id: 'snapshot', price: d(100) });
  const summaries = [];
  for (let cycle=0; cycle<3; cycle++) summaries.push(await matcher.matchDueLimitOrders({ now, batchSize: 2 }));
  assert.equal(queried.length, 3);
  assert.ok(queried.every((ids) => ids.join(',') === 'order-1,order-2'));
  assert.equal(filled.length, 0);
  assert.ok(matcher.buildFillPlan(rows[2], { id: 'snapshot', price: d(100) }, []));
  return { mode, side, cycles: 3, queried, filled,
    ordersConsidered: summaries.map((s) => s.ordersConsidered),
    batchExhausted: summaries.map((s) => s.batchExhausted), thirdOrderHasValidPlan: true };
}

async function integrityProbe(count) {
  let referenceReads = 0;
  const exchanges = Array.from({ length: count }, (_,i) => ({ id: `exchange-${i}`,
    fromCurrency: 'KRW', toCurrency: 'USD', fxExecuteRequests: [
      { id: `request-${i}`, status: 'succeeded', tradingAccountId: 'account' },
    ] }));
  const ledgers = exchanges.flatMap((exchange) => ['source','target'].map((kind) => ({
    id: `${exchange.id}-${kind}`, get referenceId() { referenceReads++; return exchange.id; },
    tradingAccountId: 'account', currencyCode: kind === 'source' ? 'KRW' : 'USD',
    direction: kind === 'source' ? 'debit' : 'credit', txType: `exchange_${kind}`,
    wallet: { tradingAccountId: 'account' },
  })));
  const { assertGeneralAccountFxRowsIntegrity } = load('backend/src/trading-accounts/general-account-integrity.ts');
  await assertGeneralAccountFxRowsIntegrity({
    exchangeTransaction: { findFirst: async () => null, findMany: async () => exchanges },
    fxExecuteRequest: { findFirst: async () => null }, quote: { findFirst: async () => null },
    walletTransaction: { findMany: async () => ledgers },
  }, 'account', 'user');
  assert.equal(referenceReads, 2 * count * count + 4 * count);
  return { exchanges: count, ledgerRows: 2*count, referenceReads };
}

function gatewayChild() {
  const timers = new Map();
  const { AssetTickerGateway } = load('backend/src/realtime/asset-ticker.gateway.ts', {}, {
    setInterval: (fn, ms) => { timers.set(ms, fn); return { unref() {} }; },
  });
  const bus = { subscribe: () => () => {} };
  const gateway = new AssetTickerGateway({}, {}, {}, {
    getAssetPriceForTicker: async () => { throw new Error('AUDIT_SYNTHETIC_DB_FAILURE'); },
  }, {}, bus, bus);
  gateway.clients.set({ readyState: 1 }, { subscriptions: new Map([['asset', null]]) });
  gateway.onModuleInit();
  timers.get(3000)(); // Actual interval callback: its rejection has no owner.
}

async function rankingProbe() {
  const older = new Date('2026-09-22T00:01:00Z');
  const newer = new Date('2026-09-22T00:02:00Z');
  const season = { id: 'season', status: 'active',
    startAt: new Date('2026-09-01Z'), endAt: new Date('2026-10-01Z') };
  const participant = { id: 'participant', seasonId: 'season', userId: 'user',
    tradingAccountId: 'account', initialCapitalKrw: d(100), totalFillCount: 1 };
  let releaseOld, announceOld;
  const oldEntered = new Promise((r) => { announceOld = r; });
  const oldDelay = new Promise((r) => { releaseOld = r; });
  let rows = [], currentValue;
  const writes = [];
  const tx = {
    seasonRanking: { findMany: async () => rows, deleteMany: async () => { rows = []; },
      create: async ({ data }) => { rows.push(data); writes.push(data.capturedAt.toISOString()); return { id: 'rank' }; } },
    seasonParticipant: { update: async ({ data }) => { currentValue = data.totalAssetKrw; return { id: 'participant' }; } },
  };
  const prisma = { season: { findUnique: async () => season }, $transaction: async (fn) => fn(tx) };
  const { RankingRefreshService } = load('backend/src/ranking/ranking-refresh.service.ts', {
    './ranking-calculation.policy': load('backend/src/ranking/ranking-calculation.policy.ts'),
    './ranking-source-scope': { buildRankingParticipantScopes: () => new Map([['participant','account']]) },
    './season-ranking-scope': { assertSeasonRankingScopes() {}, SEASON_RANKING_SCOPE_SELECT: {},
      resolveSeasonRankingAccountScopes: async () => new Map([['participant',{ tradingAccountId: 'account' }]]) },
    './season-write-lock': { lockSeasonForWrite: async () => season },
  });
  const service = new RankingRefreshService(prisma, {
    calculateTradingAccountValuation: async (_id, at) => {
      if (at === older) { announceOld(); await oldDelay; }
      return { seasonParticipantId: 'participant', totalAssetKrw: at === older ? '100' : '200',
        returnRate: at === older ? '0' : '100', krwCash: '100', usdCashKrw: '0',
        domesticStockValueKrw: '0', usStockValueKrw: '0', cryptoValueKrw: '0' };
    },
  });
  service.findRankableParticipants = async () => [participant];
  service.findEquityHistory = async () => [];
  const slow = service.refreshCurrentRankingAfterParticipantChange('season','participant',older);
  await oldEntered;
  await service.refreshCurrentRankingForSeason('season', { capturedAt: newer, lockKey: 'scheduled:season' });
  assert.equal(rows[0].capturedAt.toISOString(), newer.toISOString());
  releaseOld();
  await slow;
  assert.equal(rows[0].capturedAt.toISOString(), older.toISOString());
  assert.equal(currentValue, '100');
  return { writeOrder: writes, finalCapturedAt: rows[0].capturedAt.toISOString(),
    finalParticipantValue: currentValue, note: 'actual public refresh and writer; valuation, scope and DB doubles; not a PostgreSQL lock test' };
}

async function seasonJoinProbe() {
  const end = new Date('2026-09-22T00:00:00Z');
  let nowMs = end.getTime()-1;
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [nowMs])); } }
  const writes = [];
  const created = (kind) => async ({ data }) => { writes.push({ kind, data }); return { id: kind }; };
  const tx = {
    season: { findUnique: async () => ({ id: 'season', status: 'active',
      startAt: new Date('2026-09-01Z'), endAt: end, initialCapitalKrw: d(10000000) }) },
    user: { findUnique: async () => ({ status: 'active' }) },
    seasonParticipant: {
      findUnique: async () => { nowMs = end.getTime()+1; return null; },
      create: created('participant'),
    },
    tradingAccount: { create: created('account') }, cashWallet: { create: created('wallet') },
    walletTransaction: { create: created('ledger') }, equitySnapshot: { create: created('equity') },
  };
  const { SeasonsService } = load('backend/src/seasons/seasons.service.ts', {
    './season-lifecycle.policy': load('backend/src/seasons/season-lifecycle.policy.ts'),
  }, { Date: ClockDate });
  const result = await new SeasonsService({ $transaction: async (fn) => fn(tx) }).joinSeason('season','user');
  assert.equal(result.success, true);
  assert.ok(new Date(result.data.joinedAt) > end);
  return { seasonEndAt: end.toISOString(), joinedAt: result.data.joinedAt,
    createdRows: writes.map((row) => row.kind),
    note: 'actual service and policy, controlled clock and DB doubles; settlement race requires PostgreSQL follow-up' };
}

if (process.argv.includes('--gateway-child')) gatewayChild();
else (async () => {
  const results = { scope: 'offline actual-source control-flow; DB/HTTP/storage/provider doubles',
    sessions: [], matcher: [], integrity: [] };
  for (const kind of ['success','failure','storage-failure']) results.sessions.push(await sessionProbe(kind));
  for (const mode of ['general','season']) for (const side of ['buy','sell']) results.matcher.push(await matcherProbe(mode, side));
  for (const count of [100,200,1000]) results.integrity.push(await integrityProbe(count));
  results.ranking = await rankingProbe();
  results.seasonJoin = await seasonJoinProbe();
  const child = spawnSync(process.execPath, [__filename, '--gateway-child'], {
    encoding: 'utf8', env: { PATH: process.env.PATH || '', NODE_ENV: 'test' },
  });
  assert.equal(child.status, 1, child.stderr);
  assert.ok(child.stderr.includes('AUDIT_SYNTHETIC_DB_FAILURE'), child.stderr);
  results.gateway = { defaultNodeExitCode: child.status, unhandledDatabaseRejection: true,
    note: 'actual timer and ticker lookup; no real DB or socket; deployment NODE_OPTIONS not inspected' };
  console.log(JSON.stringify(results, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
