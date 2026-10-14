import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import WebSocket from 'ws';
import { PrismaService } from '../prisma/prisma.service';
import { BINANCE_FUTURES_SYMBOLS } from '../providers/binance/binance-product-catalog';
import { OrderBookPubSubService } from '../providers/order-book-pubsub.service';
import {
  FUTURES_PROVIDER_SOCKET_FACTORY,
  type FuturesProviderSocketFactory,
} from '../providers/provider-socket-factory';
import { futuresMarketDataConfig } from './futures.config';
import { verifiedFuturesInstrument } from './futures-instrument-coverage';
import {
  FUTURES_DEPTH_STREAM_SUFFIX,
  FUTURES_TICKER_STREAM_SUFFIX,
  futuresBaseAsset,
  futuresMarketLabel,
  parseBinanceFuturesDepth,
  parseBinanceFuturesTicker,
  type FuturesMarketStats,
  type FuturesOrderBookEvent,
} from './futures-market-data';
import { FuturesMarketStatsStore } from './futures-market-stats.store';

/** Binance routes partial books to `/public` and tickers to `/market`. */
export const FUTURES_PUBLIC_WS_URL = 'wss://fstream.binance.com/public/stream';
export const FUTURES_MARKET_WS_URL = 'wss://fstream.binance.com/market/stream';

type Target = { instrumentId: string; symbol: string };
type Stream = {
  socket?: WebSocket;
  lastWs: number;
  lastPing: number;
  lastConnect: number;
};

/**
 * Display-only USDⓈ-M market data: the 10-level book and rolling 24h ticker
 * of every offered, contract-verified instrument. Its own sockets, separate
 * from Last and Mark, so a book burst or outage never touches execution or
 * risk evidence. One shared server connection per route — never per user —
 * and no REST: nothing here spends Binance REST weight.
 */
@Injectable()
export class FuturesMarketDataIngestion
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(FuturesMarketDataIngestion.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private busy = false;
  /** symbol → target */
  private targets = new Map<string, Target>();
  private lastTargets = 0;
  private readonly depth: Stream = { lastWs: 0, lastPing: 0, lastConnect: 0 };
  private readonly ticker: Stream = { lastWs: 0, lastPing: 0, lastConnect: 0 };
  private readonly stats = new Map<string, FuturesMarketStats>();
  private statsDirty = false;
  private readonly sequences = new Map<string, string>();
  private readonly pending = new Map<string, FuturesOrderBookEvent>();
  private readonly publishing = new Map<string, Promise<void>>();
  private rejected = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly statsStore: FuturesMarketStatsStore,
    @Optional() private readonly pubsub?: OrderBookPubSubService,
    @Optional()
    @Inject(FUTURES_PROVIDER_SOCKET_FACTORY)
    private readonly socketFactory?: FuturesProviderSocketFactory,
  ) {}

  onModuleInit() {
    if (!futuresMarketDataConfig().streaming) return;
    this.timer = setInterval(() => {
      void this.cycle().catch(() =>
        this.logger.warn('FUTURES_MARKET_DATA_CYCLE_FAILED'),
      );
    }, 1000);
    void this.cycle().catch(() =>
      this.logger.warn('FUTURES_MARKET_DATA_BOOTSTRAP_FAILED'),
    );
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.depth.socket?.close();
    this.ticker.socket?.close();
    this.pending.clear();
    await Promise.allSettled(this.publishing.values());
  }

  /** The app catalog's instruments: active, offered and contract-verified. */
  async refreshTargets(now = new Date()) {
    const rows = await this.prisma.futuresInstrument.findMany({
      where: {
        isActive: true,
        markVerifiedAt: { not: null },
        underlyingAsset: {
          isActive: true,
          symbol: { in: [...BINANCE_FUTURES_SYMBOLS] },
        },
      },
      include: { underlyingAsset: true },
      orderBy: { id: 'asc' },
    });
    const targets = new Map<string, Target>(
      rows
        .filter((row) => verifiedFuturesInstrument(row, now))
        .map((row) => [
          row.underlyingAsset.symbol,
          { instrumentId: row.id, symbol: row.underlyingAsset.symbol },
        ]),
    );
    if (JSON.stringify([...targets]) !== JSON.stringify([...this.targets])) {
      for (const stream of [this.depth, this.ticker]) {
        stream.socket?.close();
        stream.socket = undefined;
      }
      this.targets = targets;
      for (const symbol of [...this.stats.keys()])
        if (!targets.has(symbol)) {
          this.stats.delete(symbol);
          this.statsDirty = true;
        }
    }
    this.lastTargets = Date.now();
  }

  /** True when the frame was a depth frame (accepted or refused). Only the
   * newest book per contract is kept for the single in-flight publish. */
  acceptDepth(frame: unknown, receivedAt: Date): boolean {
    const parsed = parseBinanceFuturesDepth(frame);
    if (parsed.state === 'other') return false;
    const target =
      parsed.state === 'depth' ? this.targets.get(parsed.symbol) : undefined;
    if (parsed.state !== 'depth' || !target) {
      this.reject();
      return true;
    }
    const previous = this.sequences.get(target.symbol);
    if (previous !== undefined && BigInt(parsed.sequence) <= BigInt(previous))
      return true;
    this.sequences.set(target.symbol, parsed.sequence);
    this.pending.set(target.symbol, {
      type: 'futures_order_book',
      sequence: parsed.sequence,
      book: {
        instrumentId: target.instrumentId,
        symbol: target.symbol,
        priceUnit: 'USDT',
        quantityUnit: futuresBaseAsset(target.symbol),
        marketLabel: futuresMarketLabel(target.symbol),
        asks: parsed.asks,
        bids: parsed.bids,
        capturedAt: receivedAt.toISOString(),
        effectiveAt: parsed.effectiveAt,
      },
    });
    if (!this.publishing.has(target.symbol))
      this.startPublishing(target.symbol);
    return true;
  }

  /** True when the frame was a ticker frame (accepted or refused). */
  acceptTicker(frame: unknown, receivedAt: Date): boolean {
    const parsed = parseBinanceFuturesTicker(frame, receivedAt);
    if (parsed.state === 'other') return false;
    if (parsed.state !== 'ticker' || !this.targets.has(parsed.stats.symbol)) {
      this.reject();
      return true;
    }
    const previous = this.stats.get(parsed.stats.symbol);
    if (
      previous &&
      Date.parse(previous.eventTime) > Date.parse(parsed.stats.eventTime)
    )
      return true;
    this.stats.set(parsed.stats.symbol, parsed.stats);
    this.statsDirty = true;
    return true;
  }

  marketStats(): FuturesMarketStats[] {
    return [...this.stats.values()];
  }

  async cycle() {
    if (this.busy || this.stopped || !futuresMarketDataConfig().streaming)
      return;
    this.busy = true;
    try {
      if (Date.now() - this.lastTargets > 30000) await this.refreshTargets();
      if (!this.targets.size) return;
      this.supervise(
        this.depth,
        FUTURES_PUBLIC_WS_URL,
        FUTURES_DEPTH_STREAM_SUFFIX,
        11,
        (frame, at) => this.acceptDepth(frame, at),
      );
      this.supervise(
        this.ticker,
        FUTURES_MARKET_WS_URL,
        FUTURES_TICKER_STREAM_SUFFIX,
        12,
        (frame, at) => this.acceptTicker(frame, at),
      );
      if (this.statsDirty) {
        this.statsDirty = false;
        if (!(await this.statsStore.write(this.marketStats())))
          this.statsDirty = true;
      }
    } finally {
      this.busy = false;
    }
  }

  private reject() {
    this.rejected += 1;
    // Bounded diagnostics: a bad stream cannot flood logs once per frame.
    if (this.rejected === 1 || this.rejected % 100 === 0)
      this.logger.warn('FUTURES_MARKET_DATA_REJECTED');
  }

  private startPublishing(symbol: string): void {
    const task = this.flush(symbol).finally(() => {
      this.publishing.delete(symbol);
      if (!this.stopped && this.pending.has(symbol))
        this.startPublishing(symbol);
    });
    this.publishing.set(symbol, task);
  }

  private async flush(symbol: string): Promise<void> {
    while (!this.stopped) {
      const event = this.pending.get(symbol);
      if (!event) return;
      this.pending.delete(symbol);
      await this.pubsub?.publishFutures(event);
    }
  }

  /** Same liveness rules as Futures Last: protocol ping every 5 s, a socket
   * silent for 15 s is replaced, reconnects at most every 5 s (this also
   * covers the provider's 24-hour disconnect). */
  private supervise(
    stream: Stream,
    url: string,
    suffix: string,
    id: number,
    accept: (frame: unknown, receivedAt: Date) => boolean,
  ) {
    if (!stream.socket && Date.now() - stream.lastConnect >= 5000)
      this.connect(stream, url, suffix, id, accept);
    if (
      stream.socket &&
      Date.now() - Math.max(stream.lastWs, stream.lastConnect) > 15000
    ) {
      stream.socket.terminate();
      stream.socket = undefined;
    } else if (
      stream.socket?.readyState === WebSocket.OPEN &&
      Date.now() - stream.lastPing >= 5000
    ) {
      stream.lastPing = Date.now();
      stream.socket.ping();
    }
  }

  private connect(
    stream: Stream,
    url: string,
    suffix: string,
    id: number,
    accept: (frame: unknown, receivedAt: Date) => boolean,
  ) {
    stream.lastConnect = Date.now();
    const socket = this.socketFactory?.(url) ?? new WebSocket(url);
    stream.socket = socket;
    socket.on('open', () => {
      stream.lastWs = Date.now();
      socket.send(
        JSON.stringify({
          method: 'SUBSCRIBE',
          params: [...this.targets.keys()].map(
            (symbol) => `${symbol.toLowerCase()}${suffix}`,
          ),
          id,
        }),
      );
    });
    socket.on('pong', () => {
      stream.lastWs = Date.now();
    });
    socket.on('message', (data) => {
      stream.lastWs = Date.now();
      try {
        const frame: unknown = JSON.parse(
          (Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer)
          ).toString('utf8'),
        );
        accept(frame, new Date());
      } catch {
        this.logger.warn('FUTURES_MARKET_DATA_INVALID_FRAME');
      }
    });
    socket.on('error', () => {
      this.logger.warn('FUTURES_MARKET_DATA_WS_UNAVAILABLE');
      socket.terminate();
    });
    socket.on('close', () => {
      if (stream.socket === socket) stream.socket = undefined;
    });
  }
}
