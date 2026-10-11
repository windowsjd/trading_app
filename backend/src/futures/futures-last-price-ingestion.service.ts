import { BINANCE_FUTURES_SYMBOLS } from '../providers/binance/binance-product-catalog';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  Inject,
} from '@nestjs/common';
import WebSocket from 'ws';
import {
  FUTURES_PROVIDER_SOCKET_FACTORY,
  type FuturesProviderSocketFactory,
} from '../providers/provider-socket-factory';
import { RedisService } from '../redis/redis.service';
import { ProviderHttpClient } from '../providers/provider-http.client';
import { PrismaService } from '../prisma/prisma.service';
import { futuresLastPriceConfig } from './futures.config';
import {
  parseBinanceAggTrade,
  parseBinanceTickerPrice,
  type ParsedFuturesLastPrice,
} from './futures-last-price';

export const FUTURES_LAST_WS_URL = 'wss://fstream.binance.com/market/stream';
export const FUTURES_LAST_REST_URL =
  'https://fapi.binance.com/fapi/v2/ticker/price';
/** A symbol without a stored observation for this long is re-confirmed by REST. */
export const FUTURES_LAST_QUIET_MS = 3000;

/** Separate socket and lifecycle from Mark ingestion: a Last outage or message
 * burst never affects Mark/risk. Public market data only; one shared server
 * stream, no user or order-scoped provider calls. Stores at most one newest
 * trade per symbol per second plus REST re-confirmations of quiet symbols. */
@Injectable()
export class FuturesLastPriceIngestion
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(FuturesLastPriceIngestion.name);
  private socket?: WebSocket;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private busy = false;
  /** symbol → instrumentId */
  private targets = new Map<string, string>();
  private pending = new Map<string, ParsedFuturesLastPrice>();
  private lastAggregate = new Map<string, number>();
  private lastTradeAt = new Map<string, number>();
  /** Last frame or pong: liveness never depends on market activity. */
  private lastWs = 0;
  private lastPing = 0;
  private lastConnect = 0;
  private lastTargets = 0;
  private lastRecovery = 0;
  private recoveryTask?: Promise<unknown>;
  private readonly httpClient: ProviderHttpClient;
  constructor(
    private readonly prisma: PrismaService,
    @Optional() redis?: RedisService,
    @Optional()
    @Inject(FUTURES_PROVIDER_SOCKET_FACTORY)
    private readonly socketFactory?: FuturesProviderSocketFactory,
  ) {
    this.httpClient = new ProviderHttpClient(redis);
  }
  onModuleInit() {
    if (!futuresLastPriceConfig().ingestion) return;
    this.timer = setInterval(() => {
      void this.cycle().catch(() =>
        this.logger.warn('FUTURES_LAST_PRICE_INGESTION_FAILED'),
      );
    }, 1000);
    void this.cycle().catch(() =>
      this.logger.warn('FUTURES_LAST_PRICE_BOOTSTRAP_FAILED'),
    );
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.socket?.close();
    await this.recoveryTask;
    await this.httpClient.onModuleDestroy();
  }
  /** Keeps the newest aggregate trade per symbol. Duplicate or out-of-order
   * aggregate IDs, other symbols/contracts and invalid prices are dropped. */
  accept(payload: unknown, capturedAt: Date) {
    const symbol =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).s
        : undefined;
    if (typeof symbol !== 'string' || !this.targets.has(symbol)) return false;
    const parsed = parseBinanceAggTrade(payload, symbol, capturedAt);
    if (!parsed) return false;
    const previous = this.lastAggregate.get(symbol);
    if (previous !== undefined && parsed.aggregateId <= previous) return false;
    this.lastAggregate.set(symbol, parsed.aggregateId);
    const { aggregateId, ...row } = parsed;
    void aggregateId;
    this.pending.set(symbol, row);
    return true;
  }
  async persist(rows: ParsedFuturesLastPrice[]) {
    const data = rows.flatMap((row) => {
      const instrumentId = this.targets.get(row.symbol);
      return instrumentId ? [{ ...row, instrumentId }] : [];
    });
    if (!data.length) return 0;
    // A replayed observation (same instrument/source/receipt) changes nothing.
    const result = await this.prisma.futuresLastPriceSnapshot.createMany({
      data,
      skipDuplicates: true,
    });
    for (const row of data)
      this.lastTradeAt.set(
        row.symbol,
        Math.max(this.lastTradeAt.get(row.symbol) ?? 0, +row.effectiveAt),
      );
    return result.count;
  }
  /** Registered, active, contract-verified instruments, plus any instrument
   * with an open lifetime so its exits and Season end stay priced. */
  async refreshTargets() {
    const instruments = await this.prisma.futuresInstrument.findMany({
      where: {
        OR: [
          {
            isActive: true,
            markVerifiedAt: { not: null },
            underlyingAsset: {
              isActive: true,
              symbol: { in: [...BINANCE_FUTURES_SYMBOLS] },
            },
          },
          { positions: { some: { status: 'open' } } },
        ],
      },
      include: { underlyingAsset: true },
      orderBy: { id: 'asc' },
    });
    const targets = new Map(
      instruments
        .filter((i) => /^[A-Z0-9]+USDT$/.test(i.underlyingAsset.symbol))
        .map((i) => [i.underlyingAsset.symbol, i.id]),
    );
    if (JSON.stringify([...targets]) !== JSON.stringify([...this.targets])) {
      this.socket?.close();
      this.socket = undefined;
      this.targets = targets;
    }
    this.lastTargets = Date.now();
  }
  private connect() {
    this.lastConnect = Date.now();
    const socket =
      this.socketFactory?.(FUTURES_LAST_WS_URL) ??
      new WebSocket(FUTURES_LAST_WS_URL);
    this.socket = socket;
    socket.on('open', () => {
      this.lastWs = Date.now();
      socket.send(
        JSON.stringify({
          method: 'SUBSCRIBE',
          params: [...this.targets.keys()].map(
            (s) => `${s.toLowerCase()}@aggTrade`,
          ),
          id: 1,
        }),
      );
    });
    socket.on('pong', () => {
      this.lastWs = Date.now();
    });
    socket.on('message', (data) => {
      this.lastWs = Date.now();
      try {
        const frame = JSON.parse(
          (Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer)
          ).toString('utf8'),
        ) as { data?: unknown };
        this.accept(frame.data ?? frame, new Date());
      } catch {
        this.logger.warn('FUTURES_LAST_PRICE_INVALID_FRAME');
      }
    });
    socket.on('error', () => {
      this.logger.warn('FUTURES_LAST_PRICE_WS_UNAVAILABLE');
      socket.terminate();
    });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = undefined;
    });
  }
  /** REST re-confirms the CURRENT last trade of quiet or WS-gapped symbols.
   * A reply reporting an older trade than one already stored adds nothing. */
  async recover(symbols: readonly string[]) {
    const { json } = await this.httpClient.getJson<unknown>(
      FUTURES_LAST_REST_URL,
      { provider: 'binance', timeoutMs: 2500 },
    );
    const capturedAt = new Date();
    if (!Array.isArray(json))
      // @diagnosticSurface internal: cycle() catches this fixed provider-shape error and logs a fixed code.
      throw new Error('FUTURES_LAST_PRICE_REST_INVALID');
    const wanted = new Set(symbols);
    const rows: ParsedFuturesLastPrice[] = [];
    for (const item of json as unknown[]) {
      const symbol =
        item && typeof item === 'object'
          ? (item as Record<string, unknown>).symbol
          : undefined;
      if (typeof symbol !== 'string' || !wanted.has(symbol)) continue;
      const parsed = parseBinanceTickerPrice(item, symbol, capturedAt);
      if (parsed && +parsed.effectiveAt >= (this.lastTradeAt.get(symbol) ?? 0))
        rows.push(parsed);
    }
    return this.persist(rows);
  }
  async cycle() {
    if (this.busy || this.stopped || !futuresLastPriceConfig().ingestion)
      return;
    this.busy = true;
    try {
      if (Date.now() - this.lastTargets > 30000) await this.refreshTargets();
      if (!this.targets.size) return;
      if (!this.socket && Date.now() - this.lastConnect >= 5000) this.connect();
      // A dead connection is replaced, including 24-hour provider disconnects.
      // Quiet markets send no trades, so liveness uses protocol ping/pong.
      if (
        this.socket &&
        Date.now() - Math.max(this.lastWs, this.lastConnect) > 15000
      ) {
        this.socket.terminate();
        this.socket = undefined;
      } else if (
        this.socket?.readyState === WebSocket.OPEN &&
        Date.now() - this.lastPing >= 5000
      ) {
        this.lastPing = Date.now();
        this.socket.ping();
      }
      const batch = [...this.pending.values()];
      this.pending.clear();
      await this.persist(batch);
      if (
        this.recoveryTask ||
        Date.now() - this.lastRecovery < FUTURES_LAST_QUIET_MS
      )
        return;
      // Stored observations are the authority, so a failed write is recovered too.
      const fresh = await this.prisma.futuresLastPriceSnapshot.groupBy({
        by: ['instrumentId'],
        where: {
          instrumentId: { in: [...this.targets.values()] },
          capturedAt: { gte: new Date(Date.now() - FUTURES_LAST_QUIET_MS) },
        },
      });
      const freshIds = new Set(fresh.map((row) => row.instrumentId));
      const quiet = [...this.targets]
        .filter(([, id]) => !freshIds.has(id))
        .map(([symbol]) => symbol);
      if (!quiet.length) return;
      this.lastRecovery = Date.now();
      // One in-flight REST task; provider latency never delays the WS drain.
      this.recoveryTask = this.recover(quiet)
        .catch(() => this.logger.warn('FUTURES_LAST_PRICE_REST_UNAVAILABLE'))
        .finally(() => {
          this.recoveryTask = undefined;
        });
    } finally {
      this.busy = false;
    }
  }
}
