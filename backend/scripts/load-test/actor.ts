import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Prisma } from '../../src/generated/prisma/client';
import type { Manifest, Screen } from './manifest';
import { SCREENS, hash } from './manifest';
import { Metrics, jsonl } from './metrics';
import { ApiFailure, AppClient, AppSocket, type Subscription } from './client';

export type FixtureActor = {
  index: number;
  email: string;
  userId: string;
  accountId: string;
  mode: 'general' | 'beginner' | 'season';
};
export type Fixture = {
  version: 1;
  runId: string;
  manifestHash: string;
  actors: FixtureActor[];
  assets: Array<{ id: string; symbol: string; assetType: string }>;
  instruments: Array<{ id: string; underlyingAssetId: string }>;
  counts: Record<string, number>;
  preparedAt: string;
};
export function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}
export function choose<T extends string>(
  weights: Record<T, number>,
  rng: () => number,
): T {
  let r = rng();
  const entries = Object.entries(weights) as [T, number][];
  for (const [key, v] of entries) {
    r -= v;
    if (r < 0) return key;
  }
  return entries[entries.length - 1][0];
}
export function initialScreen(m: Manifest, index: number): Screen {
  const percentile = (index + 0.5) / m.users;
  let sum = 0;
  for (const s of SCREENS) {
    sum += m.screenWeights[s];
    if (percentile < sum) return s;
  }
  return 'historyFx';
}
/** Entry probabilities divided by mean dwell give target TIME occupancy. */
export function nextScreen(m: Manifest, rng: () => number): Screen {
  const weights = Object.fromEntries(
    SCREENS.map((s) => [
      s,
      m.screenWeights[s] / ((m.dwellSeconds[s][0] + m.dwellSeconds[s][1]) / 2),
    ]),
  ) as Record<Screen, number>;
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  SCREENS.forEach((s) => (weights[s] /= sum));
  return choose(weights, rng);
}
const money = (v: string) => new Prisma.Decimal(v);
export class Actor {
  readonly rng: () => number;
  readonly ws: AppSocket;
  screen: Screen;
  started = false;
  private entered = false;
  private nextMove = 0;
  private nextPoll = 0;
  private nextTrade = 0;
  private nextFx = 0;
  private busy = false;
  private mountedMarket: Subscription[] = [];
  private focusSubscriptions: Subscription[] = [];
  private asset: Fixture['assets'][number];
  private orderSequence = 0;
  private historyIsFx: boolean;
  private futuresTrader: boolean;
  private historyHasPending = false;
  private cancels: Array<{ at: number; path: string }> = [];
  constructor(
    readonly m: Manifest,
    readonly fixture: FixtureActor,
    readonly data: Fixture,
    readonly http: AppClient,
    readonly metrics: Metrics,
    readonly commandsFile: string,
  ) {
    this.rng = random(m.seed ^ ((fixture.index + 1) * 2654435761));
    this.screen = initialScreen(m, fixture.index);
    this.ws = new AppSocket(http, metrics);
    const crypto = data.assets.filter((a) => a.assetType === 'crypto');
    this.asset = crypto[fixture.index % crypto.length];
    this.historyIsFx = this.rng() < 0.4;
    this.futuresTrader = this.rng() < m.futures.traderRatio;
  }
  private between([a, b]: [number, number]) {
    return (a + (b - a) * this.rng()) * 1000;
  }
  path(suffix: string) {
    return `/trading-accounts/${this.fixture.accountId}${suffix}`;
  }
  idempotency() {
    return `${this.m.runId}:${this.fixture.index}:${this.metrics.phase === 'prepare' ? 'prep' : 'run'}:${++this.orderSequence}`;
  }
  async start() {
    await this.http.login();
    this.ws.setSubscriptions([
      { channel: 'asset_ticker', assetId: this.asset.id },
    ]);
    await this.ws.ready();
    const now = performance.now();
    this.nextMove =
      now + this.rng() * this.between(this.m.dwellSeconds[this.screen]);
    this.nextTrade =
      now +
      this.rng() *
        this.between(
          this.screen === 'futures'
            ? this.m.futures.thinkSeconds
            : this.m.spot.thinkSeconds,
        );
    await this.enter();
    this.started = true;
  }
  async step(now: number) {
    if (this.busy) {
      if (now >= this.nextPoll) this.metrics.count('action.deferredWhileBusy');
      return;
    }
    this.busy = true;
    try {
      if (now >= this.nextMove) {
        this.metrics.time('action.scheduledDelay', now - this.nextMove);
        this.metrics.count('action.screenMove');
        this.screen = nextScreen(this.m, this.rng);
        this.nextMove = now + this.between(this.m.dwellSeconds[this.screen]);
        this.entered = false;
        await this.enter();
      }
      if (this.ws.candleRestored && this.screen === 'detail') {
        this.ws.candleRestored = false;
        await this.http.get(
          `/assets/${this.asset.id}/candles?range=prev_open&interval=5m&limit=600`,
          5000,
          true,
        );
      }
      if (
        now >= this.nextPoll &&
        (this.screen === 'futures' ||
          (this.screen === 'historyFx' &&
            !this.historyIsFx &&
            this.historyHasPending))
      ) {
        this.metrics.time(
          'action.scheduledDelay',
          Math.max(0, now - this.nextPoll),
        );
        this.metrics.count('action.pollPlanned');
        // A screen polls only while focused. No accumulated catch-up requests.
        this.nextPoll = now + (this.screen === 'futures' ? 2000 : 4000);
        if (this.screen === 'futures')
          await Promise.all([
            this.http.get(this.path('/futures/instruments'), 5000, true),
            this.http.get(this.path('/futures/positions'), 5000, true),
          ]);
        else if (this.screen === 'historyFx' && !this.historyIsFx) {
          const d = await this.http.get(
            this.path('/orders?limit=20&offset=0'),
            5000,
            true,
          );
          this.historyHasPending = (d.orders ?? []).some(
            (o: any) => o.status === 'submitted' && o.orderType === 'limit',
          );
        }
        this.metrics.count('action.pollCompleted');
      }
      if (
        this.screen === 'historyFx' &&
        this.historyIsFx &&
        (this.ws.fxInvalidated || now >= this.nextFx)
      ) {
        this.ws.fxInvalidated = false;
        this.nextFx = now + 300000;
        await this.http.get('/fx/rate', 5000, true);
      }
      if (
        now >= this.nextTrade &&
        (this.screen === 'spot' ||
          (this.screen === 'futures' && this.futuresTrader))
      ) {
        this.metrics.count('action.tradePlanned');
        this.nextTrade =
          now +
          this.between(
            this.screen === 'spot'
              ? this.m.spot.thinkSeconds
              : this.m.futures.thinkSeconds,
          );
        if (this.screen === 'spot') await this.spotTrade();
        else await this.futuresTrade();
        this.metrics.count('action.tradeCompleted');
      }
      for (const item of this.cancels.filter((c) => c.at <= now)) {
        await this.http.request('POST', item.path);
        this.cancels.splice(this.cancels.indexOf(item), 1);
      }
    } catch (e) {
      this.metrics.count('action.failed');
      if (!(e instanceof ApiFailure))
        this.metrics.failure(
          e instanceof Error && /^WORKLOAD_/.test(e.message)
            ? e.message
            : 'WORKLOAD_ACTION_ERROR',
        );
    } finally {
      this.busy = false;
    }
  }
  private async enter() {
    if (this.entered) return;
    this.entered = true;
    const account = this.fixture.accountId;
    await Promise.all([
      this.http.get('/me', 60000),
      this.http.get('/trading-accounts', 30000),
    ]);
    this.focusSubscriptions = [];
    if (this.screen === 'market') {
      // 70% crypto, 30% stocks; loaded pages stay subscribed as in MarketScreen.
      const type =
        this.rng() < 0.7
          ? 'crypto'
          : this.rng() < 0.5
            ? 'domestic_stock'
            : 'us_stock';
      const path = `/assets?assetType=${type}&withPrice=true&sortBy=turnover&sortOrder=desc&limit=20&offset=0`;
      const d = await this.http.get(path);
      let assets = d.assets ?? [];
      if (
        d.pagination?.nextOffset !== null &&
        d.pagination?.nextOffset !== undefined &&
        this.rng() < 0.25
      ) {
        const page = await this.http.get(
          path.replace('offset=0', `offset=${d.pagination.nextOffset}`) +
            (d.sortSnapshot
              ? `&sortSnapshot=${encodeURIComponent(d.sortSnapshot)}`
              : ''),
        );
        assets = [...assets, ...(page.assets ?? [])];
      }
      this.mountedMarket = assets.map((a: any) => ({
        channel: 'asset_ticker',
        assetId: a.id,
      }));
    } else if (this.screen === 'detail' || this.screen === 'spot') {
      const crypto = this.data.assets.filter((a) => a.assetType === 'crypto');
      // Popularity skew, not every user trading the same symbol.
      this.asset =
        crypto[
          Math.min(
            crypto.length - 1,
            Math.floor(this.rng() ** 2 * crypto.length),
          )
        ];
      await this.http.get(`/assets/${this.asset.id}`);
      this.focusSubscriptions = [
        { channel: 'asset_ticker', assetId: this.asset.id },
        { channel: 'asset_order_book', assetId: this.asset.id },
      ];
      if (this.screen === 'detail') {
        await this.http.get(
          `/assets/${this.asset.id}/candles?range=prev_open&interval=5m&limit=600`,
        );
        this.focusSubscriptions.push({
          channel: 'asset_candle',
          assetId: this.asset.id,
          interval: '5m',
        });
      } else
        await Promise.all([
          this.http.get(this.path('/wallets')),
          this.http.get(
            this.path(`/positions?assetId=${this.asset.id}&limit=20&offset=0`),
          ),
        ]);
    } else if (this.screen === 'futures') {
      this.mountedMarket = []; // selecting Futures market releases Spot rows
      await Promise.all([
        this.http.get(this.path('/futures/instruments')),
        this.http.get(this.path('/futures/positions')),
        this.http.get(this.path('/futures/executions?limit=20&offset=0')),
        this.http.get(this.path('/futures/final-settlement')),
      ]);
    } else if (this.screen === 'home') {
      await Promise.all([
        this.http.get(this.path('/portfolio')),
        this.http.get(this.path('/positions?limit=5&offset=0')),
        this.http.get(this.path('/wallets')),
        this.http.get(
          '/assets?withPrice=true&sortBy=turnover&sortOrder=desc&limit=5&offset=0',
        ),
      ]);
      if (this.rng() < 0.25)
        await this.http.get(this.path('/portfolio/equity?range=1d'));
    } else {
      if (this.historyIsFx) {
        await this.http.get('/fx/rate');
        this.focusSubscriptions.push({ channel: 'fx_rate', pair: 'USD/KRW' });
        this.nextFx = performance.now() + 300000;
      } else {
        const d = await this.http.get(this.path('/orders?limit=20&offset=0'));
        this.historyHasPending = (d.orders ?? []).some(
          (o: any) => o.status === 'submitted' && o.orderType === 'limit',
        );
      }
    }
    this.ws.setSubscriptions([
      {
        channel: 'asset_ticker',
        assetId: this.data.assets.find((a) => a.assetType === 'crypto')!.id,
      },
      ...this.mountedMarket,
      ...this.focusSubscriptions,
    ]);
    this.nextPoll =
      performance.now() + (this.screen === 'futures' ? 2000 : 4000);
    this.metrics.count(`action.enter.${this.screen}`);
  }
  async command(path: string, body: any, replay = false) {
    const acceptedMono = performance.now();
    const requestedAt = new Date().toISOString();
    const response = await this.http.request('POST', this.path(path), body);
    jsonl(this.commandsFile, {
      phase: this.metrics.phase,
      actor: this.fixture.index,
      accountId: this.fixture.accountId,
      path,
      body,
      requestedAt,
      acceptedAt: new Date().toISOString(),
      responseHash: hash(response),
      resultId:
        response.order?.orderId ??
        response.order?.id ??
        response.execution?.id ??
        response.id ??
        response.commandId,
      latencyMs: performance.now() - acceptedMono,
    });
    if (replay) {
      const repeated = await this.http.request('POST', this.path(path), body);
      const comparable = (r: any) =>
        path === '/futures/limit-orders'
          ? {
              tradingAccountId: r.tradingAccountId,
              order: Object.fromEntries(
                [
                  'id',
                  'tradingAccountId',
                  'instrumentId',
                  'direction',
                  'marginMode',
                  'leverage',
                  'quantity',
                  'limitPrice',
                  'reservedAmount',
                  'createdAt',
                ].map((k) => [k, r.order?.[k]]),
              ),
            }
          : r;
      if (hash(comparable(repeated)) !== hash(comparable(response)))
        this.metrics.failure('IDEMPOTENCY_RESPONSE_MISMATCH', path);
      else this.metrics.count('order.idempotentReplayVerified');
    }
    this.http.invalidate();
    return response;
  }
  async spotTrade(
    forceSide?: 'buy' | 'sell',
    forceAsset?: Fixture['assets'][number],
    forceType?: 'market' | 'limit',
    immediateLimit = false,
  ) {
    const asset = forceAsset ?? this.asset;
    const positions = await this.http.get(
      this.path(`/positions?assetId=${asset.id}&limit=20&offset=0`),
      5000,
      true,
    );
    const p = (positions.positions ?? []).find(
      (v: any) => v.assetId === asset.id,
    );
    let side =
      forceSide ?? (this.rng() < this.m.spot.buyRatio ? 'buy' : 'sell');
    if (
      side === 'sell' &&
      (!p ||
        money(p.quantity)
          .minus(p.reservedQuantity ?? '0')
          .lte(0))
    ) {
      side = 'buy';
      this.metrics.count('order.sellDeferredNoHolding');
    }
    const detail = await this.http.get(`/assets/${asset.id}`, 5000, true);
    const price =
      detail.asset?.price?.currentPrice ?? detail.asset?.price?.priceLocal;
    if (!price) throw new Error('WORKLOAD_PRICE_UNAVAILABLE');
    // Spot input contract is six decimal places (Futures uses eight).
    let quantity = money('10')
      .div(price)
      .toDecimalPlaces(6, Prisma.Decimal.ROUND_DOWN);
    if (side === 'sell')
      quantity = Prisma.Decimal.min(
        quantity,
        money(p.quantity).minus(p.reservedQuantity ?? '0'),
      );
    if (quantity.lte(0)) throw new Error('WORKLOAD_QUANTITY_ZERO');
    const type =
      forceType ?? (this.rng() < this.m.spot.marketRatio ? 'market' : 'limit');
    const body: any = {
      assetId: asset.id,
      side,
      ...(side === 'buy' && asset.assetType === 'crypto'
        ? { amount: '10.00000000' }
        : { quantity: quantity.toFixed(6) }),
      orderType: type,
    };
    if (type === 'limit')
      body.limitPrice = money(price)
        .mul(
          immediateLimit
            ? side === 'buy'
              ? '1.001'
              : '.999'
            : side === 'buy'
              ? '.997'
              : '1.003',
        )
        .toFixed(8);
    const quote = await this.http.request(
      'POST',
      this.path('/orders/quote'),
      body,
    );
    if (this.metrics.phase !== 'prepare') await delay(1000 + this.rng() * 2000);
    const attachedProtection =
      type === 'limit' &&
      side === 'buy' &&
      (!p || money(p.quantity).eq(0)) &&
      this.rng() < this.m.protectionRatio
        ? [
            {
              kind: 'stop_loss',
              triggerPrice: money(body.limitPrice).mul('.95').toFixed(8),
              childOrderType: 'market',
            },
            {
              kind: 'take_profit',
              triggerPrice: money(body.limitPrice).mul('1.05').toFixed(8),
              childOrderType: 'market',
            },
          ]
        : undefined;
    const data = await this.command(
      '/orders',
      {
        ...body,
        ...(attachedProtection ? { attachedProtection } : {}),
        quoteId: quote.quoteId,
        idempotencyKey: this.idempotency(),
      },
      this.rng() < 0.02,
    );
    this.metrics.count(`order.spot.${side}.${type}`);
    const id = data.order?.orderId;
    if (type === 'limit' && id && this.rng() < this.m.cancelRatio)
      this.cancels.push({
        at: performance.now() + 20000 + this.rng() * 100000,
        path: this.path(`/orders/${id}/cancel`),
      });
    return data;
  }
  async futuresTrade(
    forceOpen = false,
    instrumentIndex?: number,
    forceLimit = false,
    immediateLimit = false,
  ) {
    const data = await this.http.get(
      this.path('/futures/positions'),
      5000,
      true,
    );
    const positions = data.positions ?? [];
    const instrument =
      this.data.instruments[
        instrumentIndex ??
          Math.floor(this.rng() ** 2 * this.data.instruments.length)
      ];
    const p = positions.find(
      (v: any) => v.instrumentId === instrument.id && v.status === 'open',
    );
    const catalog = await this.http.get(
      this.path('/futures/instruments'),
      5000,
      true,
    );
    const info = (catalog.instruments ?? []).find(
      (i: any) => i.id === instrument.id,
    );
    const price = info?.referencePrice;
    if (typeof price !== 'string' || !info.referencePriceEvidence)
      throw new Error('WORKLOAD_FUTURES_LAST_UNAVAILABLE');
    const sizingPrice = price;
    const quantity = money('20')
      .div(sizingPrice)
      .toDecimalPlaces(8, Prisma.Decimal.ROUND_DOWN)
      .toFixed(8);
    let body: any;
    if (!p)
      body = {
        instrumentId: instrument.id,
        operation: 'open',
        direction: this.rng() < 0.5 ? 'long' : 'short',
        quantity,
        leverage: [2, 5, 10][Math.floor(this.rng() * 3)],
        marginMode:
          this.rng() < this.m.futures.crossRatio ? 'cross' : 'isolated',
        idempotencyKey: this.idempotency(),
      };
    else {
      const operation = forceOpen
        ? 'increase'
        : this.rng() < 0.6
          ? this.rng() < 0.5
            ? 'close'
            : 'reduce'
          : 'increase';
      body = {
        instrumentId: instrument.id,
        positionId: p.id,
        operation,
        direction: p.direction,
        quantity:
          operation === 'close'
            ? p.quantity
            : operation === 'reduce'
              ? money(p.quantity)
                  .div(2)
                  .toDecimalPlaces(8, Prisma.Decimal.ROUND_DOWN)
                  .toFixed(8)
              : quantity,
        leverage: p.leverage,
        marginMode: p.marginMode,
        idempotencyKey: this.idempotency(),
      };
    }
    if (!p) {
      const pending = await this.http.get(
        this.path('/futures/limit-orders?limit=100&offset=0'),
      );
      if (
        (pending.orders ?? []).some(
          (o: any) => o.instrumentId === instrument.id,
        )
      ) {
        this.metrics.count('order.futuresDeferredPendingEntry');
        return null;
      }
    }
    if (
      !p &&
      (forceLimit || (!forceOpen && this.rng() >= this.m.futures.marketRatio))
    ) {
      const { operation, ...entry } = body;
      entry.limitPrice = money(sizingPrice)
        .mul(
          immediateLimit
            ? body.direction === 'long'
              ? '1.001'
              : '.999'
            : body.direction === 'long'
              ? '.997'
              : '1.003',
        )
        .toFixed(8);
      if (this.rng() < this.m.protectionRatio)
        entry.attachedProtection = [
          {
            kind: 'stop_loss',
            triggerPrice: money(sizingPrice)
              .mul(body.direction === 'long' ? '.95' : '1.05')
              .toFixed(8),
            childOrderType: 'market',
          },
        ];
      const d = await this.command(
        '/futures/limit-orders',
        entry,
        this.rng() < 0.02,
      );
      this.metrics.count('order.futures.limit');
      if (d.order?.id && this.rng() < this.m.cancelRatio)
        this.cancels.push({
          at: performance.now() + 20000 + this.rng() * 100000,
          path: this.path(`/futures/limit-orders/${d.order.id}/cancel`),
        });
      return d;
    }
    const d = await this.command('/futures/execute', body, this.rng() < 0.02);
    this.metrics.count(`order.futures.market.${body.operation}`);
    return d;
  }
  isBusy() {
    return this.busy;
  }
  stop() {
    this.ws.close();
  }
}
