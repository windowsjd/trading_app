import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { BINANCE_FIXED_ASSET_UNIVERSE } from '../../src/providers/binance/binance-fixed-asset-universe';
import { KIS_FIXED_ASSET_UNIVERSE } from '../../src/providers/kis/kis-fixed-asset-universe';
import type { Manifest } from './manifest';
import { hash } from './manifest';
import { Metrics } from './metrics';

export const CRYPTO = BINANCE_FIXED_ASSET_UNIVERSE;
export const STOCKS = KIS_FIXED_ASSET_UNIVERSE;
export function contract(symbol: string) {
  return {
    symbol,
    pair: symbol,
    baseAsset: symbol.slice(0, -4),
    contractType: 'PERPETUAL',
    status: 'TRADING',
    quoteAsset: 'USDT',
    marginAsset: 'USDT',
    underlyingType: 'COIN',
  };
}
const bases: Record<string, bigint> = {
  BTCUSDT: 6000000n,
  ETHUSDT: 250000n,
  BNBUSDT: 60000n,
  SOLUSDT: 15000n,
  DOGEUSDT: 15n,
  XRPUSDT: 60n,
};
/** Integer-generated provider prices, not financial settlement arithmetic. */
export function replayPrice(
  symbol: string,
  tick: number,
  seed: number,
): string {
  const base = bases[symbol] ?? 10000n;
  const phase = (((tick + seed + symbol.length * 97) % 1800) + 1800) % 1800;
  const triangle = phase < 900 ? phase : 1800 - phase;
  const micro = base * 1000000n + base * BigInt(triangle - 450) * 10n;
  return `${micro / 100000000n}.${(micro % 100000000n).toString().padStart(8, '0')}`;
}
export function markPrice(last: string): string {
  const value = (BigInt(last.replace('.', '')) * 10005n) / 10000n;
  return `${value / 100000000n}.${(value % 100000000n).toString().padStart(8, '0')}`;
}
export function providerFrames(
  symbol: string,
  tick: number,
  epochMs: number,
  m: Manifest,
  priceTick = tick,
) {
  const now = epochMs + tick * m.replay.tickMs;
  const price = replayPrice(symbol, priceTick, m.seed);
  const open = Math.floor(now / 300000) * 300000;
  const bucketTicks = Math.floor((now - open) / m.replay.tickMs);
  const firstTick = priceTick - bucketTicks;
  const candidateTicks = [firstTick, priceTick];
  for (
    let boundary =
      Math.ceil((firstTick + m.seed + symbol.length * 97) / 900) * 900;
    boundary <= priceTick + m.seed + symbol.length * 97;
    boundary += 900
  )
    candidateTicks.push(boundary - m.seed - symbol.length * 97);
  const prices = candidateTicks.map((t) => replayPrice(symbol, t, m.seed));
  const sorted = [...prices].sort((a, b) => Number(a) - Number(b));
  return {
    ticker: {
      stream: `${symbol.toLowerCase()}@ticker`,
      data: {
        e: '24hrTicker',
        E: now,
        C: now,
        s: symbol,
        c: price,
        P: '0.1',
        b: price,
        a: price,
        v: '10000',
        q: '1000000',
      },
    },
    book: {
      stream: `${symbol.toLowerCase()}@depth10`,
      data: {
        lastUpdateId: tick + 1,
        bids: [[price, '100']],
        asks: [[price, '100']],
      },
    },
    candle: {
      stream: `${symbol.toLowerCase()}@kline_5m`,
      data: {
        e: 'kline',
        E: now,
        s: symbol,
        k: {
          t: open,
          T: open + 299999,
          s: symbol,
          i: '5m',
          f: 1,
          L: tick + 2,
          o: prices[0],
          h: sorted.at(-1)!,
          l: sorted[0],
          c: price,
          v: String(bucketTicks + 1),
          q: String((bucketTicks + 1) * 100),
          n: bucketTicks + 1,
          x: false,
        },
      },
    },
    last: {
      e: 'aggTrade',
      E: now,
      s: symbol,
      a: tick + 1,
      p: price,
      q: '0.1',
      f: tick + 1,
      l: tick + 1,
      T: now,
      m: false,
    },
    mark: {
      e: 'markPriceUpdate',
      E: now,
      s: symbol,
      p: markPrice(price),
      i: price,
      r: '0',
      T: now + 3600000,
    },
  };
}
export class ReplaySocket extends EventEmitter {
  readyState = 0;
  streams = new Set<string>();
  constructor(
    public kind: 'spot' | 'last' | 'mark',
    private metrics: Metrics,
  ) {
    super();
    setImmediate(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.emit('open');
    });
  }
  send(text: string) {
    const p = JSON.parse(text);
    if (
      p.method === 'SUBSCRIBE' &&
      p.params.some((s: string) => s.endsWith('@aggTrade'))
    )
      this.kind = 'last';
    if (p.method === 'SUBSCRIBE')
      p.params.forEach((s: string) => this.streams.add(s));
    if (p.method === 'UNSUBSCRIBE')
      p.params.forEach((s: string) => this.streams.delete(s));
    setImmediate(() => this.frame({ result: null, id: p.id }));
  }
  frame(payload: unknown) {
    if (this.readyState !== 1) return;
    this.metrics.count(`replay.frames.${this.kind}`);
    this.emit('message', Buffer.from(JSON.stringify(payload)));
  }
  ping() {
    this.emit('pong', Buffer.alloc(0));
  }
  pong() {}
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }
  terminate() {
    this.close(1006);
  }
}
export class Replay {
  sockets = new Set<ReplaySocket>();
  epochMs = Date.now();
  tick = 0;
  private priceStartTick?: number;
  private previousCandles = new Map<
    string,
    ReturnType<typeof providerFrames>['candle']
  >();
  private timer?: NodeJS.Timeout;
  private startMono = performance.now();
  constructor(
    readonly m: Manifest,
    readonly metrics: Metrics,
  ) {}
  createSocket = (raw: string): ReplaySocket => {
    const u = new URL(raw);
    const kind =
      u.hostname === 'stream.binance.com'
        ? 'spot'
        : raw === 'wss://fstream.binance.com/market/stream'
          ? 'mark'
          : raw === 'wss://fstream.binance.com/public/stream'
            ? 'last'
            : undefined;
    if (!kind) {
      this.metrics.failure('EXTERNAL_PROVIDER_SOCKET_BLOCKED');
      throw new Error('EXTERNAL_PROVIDER_SOCKET_BLOCKED');
    }
    const socket = new ReplaySocket(kind, this.metrics);
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    return socket;
  };
  get priceTick() {
    return this.priceStartTick === undefined
      ? 0
      : this.tick - this.priceStartTick;
  }
  setPhase(phase: string) {
    if (phase === 'ramp' && this.priceStartTick === undefined)
      this.priceStartTick = this.tick;
  }
  start() {
    this.epochMs = Date.now();
    this.startMono = performance.now();
    this.timer = setInterval(() => {
      // Missed ticks are measured and skipped, never caught up in a burst.
      const due = Math.floor(
        (performance.now() - this.startMono) / this.m.replay.tickMs,
      );
      if (due <= this.tick) return;
      if (due > this.tick + 1)
        this.metrics.count('replay.missedTicks', due - this.tick - 1);
      this.tick = due;
      this.metrics.time(
        'replay.scheduleDelay',
        Math.max(
          0,
          performance.now() - this.startMono - due * this.m.replay.tickMs,
        ),
      );
      for (const socket of this.sockets)
        for (const stream of socket.streams) {
          const symbol = stream.split('@')[0].toUpperCase();
          if (!CRYPTO.some((a) => a.symbol === symbol)) {
            this.metrics.failure('REPLAY_UNKNOWN_SYMBOL');
            continue;
          }
          const frames = providerFrames(
            symbol,
            due,
            Date.now() - due * this.m.replay.tickMs,
            this.m,
            this.priceTick,
          );
          if (socket.kind === 'spot') {
            if (
              stream.endsWith('@ticker') &&
              due % this.m.replay.tickerEveryTicks === 0
            )
              socket.frame(frames.ticker);
            if (
              stream.endsWith('@depth10') &&
              due % this.m.replay.bookEveryTicks === 0
            )
              socket.frame(frames.book);
            if (
              stream.endsWith('@kline_5m') &&
              due % this.m.replay.candleEveryTicks === 0
            ) {
              const previous = this.previousCandles.get(stream);
              if (previous && previous.data.k.t !== frames.candle.data.k.t)
                socket.frame({
                  ...previous,
                  data: {
                    ...previous.data,
                    E: frames.candle.data.E,
                    k: { ...previous.data.k, x: true },
                  },
                });
              socket.frame(frames.candle);
              this.previousCandles.set(stream, frames.candle);
            }
          } else if (
            socket.kind === 'last' &&
            due % this.m.replay.lastEveryTicks === 0
          )
            socket.frame(frames.last);
          else if (
            socket.kind === 'mark' &&
            due % this.m.replay.markEveryTicks === 0
          )
            socket.frame(frames.mark);
        }
    }, this.m.replay.tickMs);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const s of [...this.sockets]) s.close();
  }
  fingerprint() {
    return hash(
      CRYPTO.map((a) => providerFrames(a.symbol, 20, 1700000000000, this.m)),
    );
  }
  fetch = async (
    raw: string | URL | Request,
    _options?: RequestInit,
  ): Promise<Response> => {
    const u = new URL(raw instanceof Request ? raw.url : String(raw));
    const now = Date.now();
    let value: unknown;
    const symbol = u.searchParams.get('symbol') ?? CRYPTO[0].symbol;
    if (
      u.hostname === 'fapi.binance.com' &&
      u.pathname === '/fapi/v1/exchangeInfo'
    )
      value = { symbols: CRYPTO.map((a) => contract(a.symbol)) };
    else if (
      u.hostname === 'fapi.binance.com' &&
      u.pathname === '/fapi/v2/ticker/price'
    )
      value = CRYPTO.map((a) => ({
        symbol: a.symbol,
        price: replayPrice(a.symbol, this.priceTick, this.m.seed),
        time: now,
      }));
    else if (
      u.hostname === 'fapi.binance.com' &&
      u.pathname === '/fapi/v1/premiumIndex'
    )
      value = CRYPTO.map((a) => ({
        symbol: a.symbol,
        markPrice: markPrice(
          replayPrice(a.symbol, this.priceTick, this.m.seed),
        ),
        indexPrice: replayPrice(a.symbol, this.priceTick, this.m.seed),
        lastFundingRate: '0',
        nextFundingTime: now + 3600000,
        time: now,
      }));
    else if (
      u.hostname === 'api.binance.com' &&
      u.pathname === '/api/v3/exchangeInfo'
    )
      value = {
        symbols: CRYPTO.map((a) => ({
          ...contract(a.symbol),
          filters: [
            {
              filterType: 'PRICE_FILTER',
              minPrice: a.priceTickSize,
              maxPrice: '10000000',
              tickSize: a.priceTickSize,
            },
          ],
        })),
      };
    else if (
      u.hostname === 'api.binance.com' &&
      u.pathname === '/api/v3/ticker/24hr'
    )
      value = {
        symbol,
        lastPrice: replayPrice(symbol, this.priceTick, this.m.seed),
        closeTime: now,
        priceChangePercent: '0.1',
        volume: '10000',
        quoteVolume: '1000000',
      };
    else if (
      u.hostname === 'api.binance.com' &&
      u.pathname === '/api/v3/klines'
    ) {
      const step = u.searchParams.get('interval') === '1d' ? 86400000 : 300000;
      const limit = Math.min(1000, Number(u.searchParams.get('limit') ?? 500));
      const end = Math.min(now, Number(u.searchParams.get('endTime') ?? now));
      const start = Number(
        u.searchParams.get('startTime') ??
          Math.floor(end / step) * step - (limit - 1) * step,
      );
      const price = replayPrice(symbol, 0, this.m.seed);
      value = Array.from(
        {
          length: Math.min(
            limit,
            Math.max(0, Math.floor((end - start) / step) + 1),
          ),
        },
        (_, i) => {
          const t = start + i * step;
          return [
            t,
            price,
            price,
            price,
            price,
            '10000',
            t + step - 1,
            '1000000',
            100,
            '5000',
            '500000',
            '0',
          ];
        },
      );
    } else if (
      u.hostname === 'v6.exchangerate-api.com' &&
      u.pathname.endsWith('/latest/USD')
    )
      value = {
        result: 'success',
        base_code: 'USD',
        time_last_update_unix: Math.floor(now / 1000),
        conversion_rates: { KRW: '1300' },
      };
    else if (
      u.hostname === 'openapi.koreainvestment.com' &&
      u.pathname === '/oauth2/tokenP'
    )
      value = {
        access_token: 'load-test-provider-token',
        token_type: 'Bearer',
        expires_in: 86400,
      };
    else if (
      u.hostname === 'openapi.koreainvestment.com' &&
      u.pathname.endsWith('/quotations/price')
    )
      value = {
        rt_cd: '0',
        output: {
          symb: u.searchParams.get('SYMB'),
          last: '100',
          rate: '0.1',
          tvol: '10000',
          tamt: '1000000',
        },
      };
    else if (
      u.hostname === 'oap.k-mydata.org' &&
      /\/stocks\/lists$/.test(u.pathname)
    )
      value = {
        isuLists: u.pathname.includes('/kospi/')
          ? STOCKS.filter((a) => a.assetType === 'domestic_stock').map((a) => ({
              isuSrtCd: a.symbol,
            }))
          : [],
        result: {},
      };
    else if (
      u.hostname === 'oap.k-mydata.org' &&
      /\/multiquote\/stocks\/(price|orderbook)$/.test(u.pathname)
    ) {
      const kst = new Date(now + 9 * 3600000).toISOString();
      value = {
        result: {
          isulist: (u.searchParams.get('isuCd') ?? '').split(',').map((s) => ({
            isuSrtCd: s,
            trdPrc: '100000',
            trdDd: kst.slice(0, 10).replaceAll('-', ''),
            trdTm: kst.slice(11, 19).replaceAll(':', '') + '00',
            cmpprevddPrc: '0',
            cmpprevddTpCd: '3',
            bidordPrc_1: '99900',
            askordPrc_1: '100100',
            accTrdvol: '10000',
            accTrdval: '1000000000',
          })),
        },
      };
    } else {
      this.metrics.failure('EXTERNAL_PROVIDER_HTTP_BLOCKED');
      throw new Error('EXTERNAL_PROVIDER_HTTP_BLOCKED');
    }
    this.metrics.count(
      `replay.http.${u.hostname}${u.pathname.replace(/\/load-test-[^/]+/g, '/:test-key')}`,
    );
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}
