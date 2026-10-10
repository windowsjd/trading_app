import { Prisma } from '../generated/prisma/client';
import {
  FUTURES_EXCHANGE_INFO_URL,
  parseFuturesContracts,
} from './futures-instrument-coverage';
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
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
import { type FuturesMarkSource } from '../generated/prisma/client';
import { futuresRiskConfig } from './futures.config';
import { parseBinanceMark } from './futures-mark';

export const FUTURES_MARK_WS_URL = 'wss://fstream.binance.com/market/stream';
export const FUTURES_MARK_REST_URL =
  'https://fapi.binance.com/fapi/v1/premiumIndex';
@Injectable()
export class FuturesMarkIngestion implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FuturesMarkIngestion.name);
  private socket?: WebSocket;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private busy = false;
  private targets = new Map<string, string>();
  private pending = new Map<string, { payload: unknown; capturedAt: Date }>();
  private lastWs = 0;
  private lastConnect = 0;
  private lastTargets = 0;
  private lastRecovery = 0;
  private lastCoverage = 0;
  private coverageTask?: Promise<void>;
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
    if (!futuresRiskConfig().ingestion) return;
    this.timer = setInterval(() => {
      void this.cycle().catch(() =>
        this.logger.warn('FUTURES_MARK_INGESTION_FAILED'),
      );
    }, 1000);
    void this.cycle().catch(() =>
      this.logger.warn('FUTURES_MARK_BOOTSTRAP_FAILED'),
    );
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.socket?.close();
    await this.coverageTask;
    await this.httpClient.onModuleDestroy();
  }
  async persist(
    payload: unknown,
    source: FuturesMarkSource,
    symbol: string,
    instrumentId: string,
    capturedAt: Date,
  ) {
    const parsed = parseBinanceMark(payload, source, symbol, capturedAt);
    if (!parsed) return false;
    // createMany skipDuplicates leaves existing durable evidence unchanged on replay.
    const result = await this.prisma.futuresMarkSnapshot.createMany({
      data: [{ ...parsed, instrumentId }],
      skipDuplicates: true,
    });
    return result.count === 1;
  }
  async refreshCoverage() {
    const { json } = await this.httpClient.getJson<unknown>(
      FUTURES_EXCHANGE_INFO_URL,
      { provider: 'binance', timeoutMs: 2500 },
    );
    const contracts = parseFuturesContracts(json);
    const capturedAt = new Date();
    const instruments = await this.prisma.futuresInstrument.findMany({
      include: { underlyingAsset: true },
    });
    for (const instrument of instruments) {
      const contract = contracts.get(instrument.underlyingAsset.symbol);
      await this.prisma.futuresInstrument.update({
        where: { id: instrument.id },
        data: {
          markContractJson: contract ?? Prisma.DbNull,
          markVerifiedAt: contract ? capturedAt : null,
        },
      });
    }
  }
  private connect() {
    this.lastConnect = Date.now();
    const socket =
      this.socketFactory?.(FUTURES_MARK_WS_URL) ??
      new WebSocket(FUTURES_MARK_WS_URL);
    this.socket = socket;
    socket.on('open', () =>
      socket.send(
        JSON.stringify({
          method: 'SUBSCRIBE',
          params: [...this.targets.keys()].map(
            (s) => `${s.toLowerCase()}@markPrice@1s`,
          ),
          id: 'futures-mark',
        }),
      ),
    );
    socket.on('message', (data) => {
      try {
        const frame = JSON.parse(
          (Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer)
          ).toString('utf8'),
        ) as { data?: unknown };
        const payload = (frame.data ?? frame) as Record<string, unknown>;
        if (typeof payload.s !== 'string' || !this.targets.has(payload.s))
          return;
        const capturedAt = new Date();
        if (
          !parseBinanceMark(
            payload,
            'binance_usdm_mark_ws',
            payload.s,
            capturedAt,
          )
        )
          return;
        const previous = this.pending.get(payload.s)?.payload as
          | Record<string, unknown>
          | undefined;
        if (previous && Number(previous.E) >= Number(payload.E)) return;
        this.pending.set(payload.s, { payload, capturedAt });
        this.lastWs = Date.now();
      } catch {
        this.logger.warn('FUTURES_MARK_INVALID_FRAME');
      }
    });
    socket.on('error', () => {
      this.logger.warn('FUTURES_MARK_WS_UNAVAILABLE');
      socket.terminate();
    });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = undefined;
    });
  }
  async cycle() {
    if (this.busy || this.stopped || !futuresRiskConfig().ingestion) return;
    this.busy = true;
    try {
      if (!this.coverageTask && Date.now() - this.lastCoverage >= 300000) {
        this.lastCoverage = Date.now();
        // Catalog network/row-lock latency must not hold up the 1s Mark drain.
        // One in-flight task, no new scheduler or financial owner.
        this.coverageTask = this.refreshCoverage()
          .catch(() => {
            this.logger.warn('FUTURES_COVERAGE_UNAVAILABLE');
          })
          .finally(() => {
            this.coverageTask = undefined;
          });
      }
      if (Date.now() - this.lastTargets > 30000) {
        const instruments = await this.prisma.futuresInstrument.findMany({
          where: {
            OR: [
              { isActive: true },
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
        if (
          JSON.stringify([...targets]) !== JSON.stringify([...this.targets])
        ) {
          this.socket?.close();
          this.socket = undefined;
          this.targets = targets;
        }
        this.lastTargets = Date.now();
      }
      if (!this.targets.size) return;
      if (!this.socket && Date.now() - this.lastConnect >= 5000) this.connect();
      // A dead connection is replaced, including 24-hour provider disconnects and missing heartbeats.
      if (
        this.socket &&
        Date.now() - Math.max(this.lastWs, this.lastConnect) > 15000
      ) {
        this.socket.terminate();
        this.socket = undefined;
      }
      const batch = [...this.pending];
      this.pending.clear();
      for (const [symbol, entry] of batch) {
        const id = this.targets.get(symbol);
        if (id)
          await this.persist(
            entry.payload,
            'binance_usdm_mark_ws',
            symbol,
            id,
            entry.capturedAt,
          );
      }
      // Recovery is independent of financial locks; validates each symbol's provider time.
      const freshSymbols = await this.prisma.futuresMarkSnapshot.groupBy({
        by: ['instrumentId'],
        where: {
          instrumentId: { in: [...this.targets.values()] },
          source: 'binance_usdm_mark_ws',
          effectiveAt: { gte: new Date(Date.now() - 3000) },
        },
      });
      if (
        (Date.now() - this.lastWs > 3000 ||
          freshSymbols.length < this.targets.size) &&
        Date.now() - this.lastRecovery >= 3000
      ) {
        this.lastRecovery = Date.now();
        const { json: payload } = await this.httpClient.getJson<unknown>(
          FUTURES_MARK_REST_URL,
          { provider: 'binance', timeoutMs: 2500 },
        );
        const capturedAt = new Date();
        if (!Array.isArray(payload))
          throw new Error('FUTURES_MARK_REST_INVALID');
        for (const row of payload as Array<Record<string, unknown>>) {
          if (typeof row.symbol !== 'string') continue;
          const id = this.targets.get(row.symbol);
          if (id)
            await this.persist(
              row,
              'binance_usdm_mark_rest',
              row.symbol,
              id,
              capturedAt,
            );
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
