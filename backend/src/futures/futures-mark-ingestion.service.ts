import { BINANCE_FUTURES_SYMBOLS } from '../providers/binance/binance-product-catalog';
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
import { MARK_MAX_AGE_MS, parseBinanceMark } from './futures-mark';
import {
  databaseFailureKind,
  type DatabaseFailureKind,
} from '../common/database-failure';

export const FUTURES_MARK_WS_URL = 'wss://fstream.binance.com/market/stream';
export const FUTURES_MARK_REST_URL =
  'https://fapi.binance.com/fapi/v1/premiumIndex';
/** A target whose newest STORED WS Mark is older than this is re-confirmed by REST. */
export const FUTURES_MARK_QUIET_MS = 3000;
const ALERT_INTERVAL_MS = 60000;

type MarkRow = NonNullable<ReturnType<typeof parseBinanceMark>> & {
  instrumentId: string;
};

export type FuturesMarkIngestionStatus = {
  enabled: boolean;
  targets: number;
  /** Targets whose newest stored Mark (any source) is older than 5 s. */
  staleTargets: number;
  /** Stale targets with no stored Mark at all since this process started. */
  missingTargets: number;
  oldestStoredAgeMs: number | null;
  lastFrameAgeMs: number | null;
  socketOpen: boolean;
  consecutivePersistFailures: number;
  lastPersistFailure: { kind: DatabaseFailureKind; at: string } | null;
  recoveryInFlight: boolean;
  consecutiveRecoveryFailures: number;
};

/** Mark collection only. Freshness here is this process's record of rows that
 * PostgreSQL confirmed; it schedules REST recovery and feeds monitoring. Risk,
 * liquidation and valuation always read FuturesMarkSnapshot rows themselves. */
@Injectable()
export class FuturesMarkIngestion implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FuturesMarkIngestion.name);
  private socket?: WebSocket;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private busy = false;
  private targets = new Map<string, string>();
  /** Target symbol → when it became a target; grace for its first rows. */
  private targetSince = new Map<string, number>();
  private pending = new Map<string, { payload: unknown; capturedAt: Date }>();
  /** Newest accepted WS event time per symbol: replays never re-enter. */
  private lastFrame = new Map<string, number>();
  /** Newest provider time per symbol whose row PostgreSQL confirmed. */
  private storedWs = new Map<string, number>();
  private stored = new Map<string, number>();
  private lastWs = 0;
  private lastConnect = 0;
  private lastTargets = 0;
  private lastRecovery = 0;
  private lastCoverage = 0;
  private coverageTask?: Promise<void>;
  private recoveryTask?: Promise<unknown>;
  private persistFailures = 0;
  private lastPersistFailure: { kind: DatabaseFailureKind; at: number } | null =
    null;
  private recoveryFailures = 0;
  private staleSince?: number;
  private lastAlert = new Map<string, number>();
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
    await this.recoveryTask;
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
    return (await this.store([{ ...parsed, instrumentId }])) === 1;
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
  /** REST re-confirms the given symbols' CURRENT Mark from one public call. */
  async recover(symbols: readonly string[]) {
    const { json } = await this.httpClient.getJson<unknown>(
      FUTURES_MARK_REST_URL,
      { provider: 'binance', timeoutMs: 2500 },
    );
    const capturedAt = new Date();
    if (!Array.isArray(json))
      // @diagnosticSurface internal: the recovery task catches this fixed provider-shape error and logs a fixed code.
      throw new Error('FUTURES_MARK_REST_INVALID');
    const wanted = new Set(symbols);
    const rows: MarkRow[] = [];
    for (const item of json as unknown[]) {
      const symbol =
        item && typeof item === 'object'
          ? (item as Record<string, unknown>).symbol
          : undefined;
      const instrumentId =
        typeof symbol === 'string' && wanted.has(symbol)
          ? this.targets.get(symbol)
          : undefined;
      if (!instrumentId) continue;
      const parsed = parseBinanceMark(
        item,
        'binance_usdm_mark_rest',
        symbol as string,
        capturedAt,
      );
      if (parsed) rows.push({ ...parsed, instrumentId });
    }
    return this.store(rows);
  }
  /** Per-target freshness of STORED Marks, from this process's confirmed
   * writes. Monitoring only; a fresh process reports targets as missing until
   * its first rows are stored (after a 5 s grace). */
  getStatus(now = Date.now()): FuturesMarkIngestionStatus {
    let staleTargets = 0;
    let missingTargets = 0;
    let oldestStoredAgeMs: number | null = null;
    for (const symbol of this.targets.keys()) {
      const graced =
        now - (this.targetSince.get(symbol) ?? now) <= MARK_MAX_AGE_MS;
      const at = this.stored.get(symbol);
      if (at === undefined) {
        if (!graced) {
          missingTargets++;
          staleTargets++;
        }
        continue;
      }
      // Ages are display values; a backward wall-clock step never shows < 0.
      oldestStoredAgeMs = Math.max(oldestStoredAgeMs ?? 0, now - at, 0);
      if (now - at > MARK_MAX_AGE_MS && !graced) staleTargets++;
    }
    return {
      enabled: futuresRiskConfig().ingestion,
      targets: this.targets.size,
      staleTargets,
      missingTargets,
      oldestStoredAgeMs,
      lastFrameAgeMs: this.lastWs ? Math.max(0, now - this.lastWs) : null,
      socketOpen: this.socket?.readyState === WebSocket.OPEN,
      consecutivePersistFailures: this.persistFailures,
      lastPersistFailure: this.lastPersistFailure && {
        kind: this.lastPersistFailure.kind,
        at: new Date(this.lastPersistFailure.at).toISOString(),
      },
      recoveryInFlight: this.recoveryTask !== undefined,
      consecutiveRecoveryFailures: this.recoveryFailures,
    };
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
        // A duplicate or out-of-order provider time never re-enters, even
        // after an earlier frame was already drained and stored.
        const event = Number(payload.E);
        if (event <= (this.lastFrame.get(payload.s) ?? 0)) return;
        this.lastFrame.set(payload.s, event);
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
    if (this.stopped || !futuresRiskConfig().ingestion) return;
    // Freshness alerting is evaluated even while a slow drain holds the cycle.
    this.observe(Date.now());
    if (this.busy) return;
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
              {
                isActive: true,
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
        if (
          JSON.stringify([...targets]) !== JSON.stringify([...this.targets])
        ) {
          this.socket?.close();
          this.socket = undefined;
          const at = Date.now();
          this.targetSince = new Map(
            [...targets.keys()].map((s) => [s, this.targetSince.get(s) ?? at]),
          );
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
      const rows = [...this.pending].flatMap(([symbol, entry]) => {
        const instrumentId = this.targets.get(symbol);
        const parsed =
          instrumentId &&
          parseBinanceMark(
            entry.payload,
            'binance_usdm_mark_ws',
            symbol,
            entry.capturedAt,
          );
        return parsed && instrumentId ? [{ ...parsed, instrumentId }] : [];
      });
      this.pending.clear();
      try {
        await this.store(rows);
      } finally {
        // A failed write leaves its targets unstored, so REST still runs.
        this.scheduleRecovery();
      }
    } finally {
      this.busy = false;
    }
  }
  /** Targets without a STORED WS Mark in the last 3 s get one public REST call:
   * at most one in flight and one per 3 s, 2.5 s timeout, never awaited by
   * the WS drain. Freshness counts stored rows, not received frames, so a
   * failed write is recovered like a silent stream. */
  private scheduleRecovery() {
    const now = Date.now();
    if (this.recoveryTask || now - this.lastRecovery < FUTURES_MARK_QUIET_MS)
      return;
    const quiet = [...this.targets.keys()].filter(
      (symbol) =>
        (this.storedWs.get(symbol) ?? 0) < now - FUTURES_MARK_QUIET_MS,
    );
    if (!quiet.length) return;
    this.lastRecovery = now;
    this.recoveryTask = this.recover(quiet)
      .then(() => {
        this.recoveryFailures = 0;
      })
      .catch(() => {
        this.recoveryFailures++;
        this.logger.warn('FUTURES_MARK_REST_UNAVAILABLE');
      })
      .finally(() => {
        this.recoveryTask = undefined;
      });
  }
  /** One multi-row INSERT per drain. Stored freshness advances only after
   * PostgreSQL confirms the rows (inserted, or the identical immutable row
   * already existed); a row-specific rejection cannot stall other contracts. */
  private async store(rows: MarkRow[]): Promise<number> {
    if (!rows.length) return 0;
    try {
      const { count } = await this.insert(rows);
      this.confirmed(rows);
      return count;
    } catch (error) {
      const kind = databaseFailureKind(error);
      this.persistFailed(kind);
      // An unavailable, full or slow database fails the batch at once rather
      // than as one slow statement per contract.
      if (kind !== 'data_rejected' || rows.length === 1) throw error;
    }
    let count = 0;
    for (const row of rows)
      try {
        count += (await this.insert([row])).count;
        this.confirmed([row]);
      } catch (rowError) {
        this.persistFailed(databaseFailureKind(rowError));
      }
    return count;
  }
  private insert(rows: MarkRow[]) {
    // createMany skipDuplicates leaves existing durable evidence unchanged on replay.
    return this.prisma.futuresMarkSnapshot.createMany({
      data: rows,
      skipDuplicates: true,
    });
  }
  private confirmed(rows: MarkRow[]) {
    this.persistFailures = 0;
    for (const row of rows) {
      const at = +row.effectiveAt;
      if (at > (this.stored.get(row.symbol) ?? 0))
        this.stored.set(row.symbol, at);
      if (
        row.source === 'binance_usdm_mark_ws' &&
        at > (this.storedWs.get(row.symbol) ?? 0)
      )
        this.storedWs.set(row.symbol, at);
    }
  }
  private persistFailed(kind: DatabaseFailureKind) {
    this.persistFailures++;
    this.lastPersistFailure = { kind, at: Date.now() };
    const fields = {
      event:
        kind === 'disk_full' ? 'db_disk_full' : 'futures_mark_persist_failed',
      source: 'futures_mark_ingestion',
      kind,
      consecutive: this.persistFailures,
    };
    if (kind === 'disk_full') this.alert(`persist:${kind}`, 'error', fields);
    else this.alert(`persist:${kind}`, 'warn', fields);
  }
  private observe(now: number) {
    const status = this.getStatus(now);
    if (status.staleTargets > 0) {
      this.staleSince ??= now;
      this.alert('stale', 'warn', {
        event: 'futures_mark_stale',
        staleTargets: status.staleTargets,
        missingTargets: status.missingTargets,
        targets: status.targets,
        oldestStoredAgeMs: status.oldestStoredAgeMs,
        maxAgeMs: MARK_MAX_AGE_MS,
        consecutivePersistFailures: status.consecutivePersistFailures,
      });
    } else if (this.staleSince !== undefined) {
      this.logger.log(
        JSON.stringify({
          event: 'futures_mark_fresh_again',
          staleForMs: now - this.staleSince,
        }),
      );
      this.staleSince = undefined;
      this.lastAlert.delete('stale');
    }
  }
  /** Fixed-code structured alert, at most once a minute per condition. */
  private alert(
    key: string,
    level: 'warn' | 'error',
    fields: Record<string, unknown>,
  ) {
    const now = Date.now();
    const last = this.lastAlert.get(key);
    if (last !== undefined && now - last < ALERT_INTERVAL_MS) return;
    this.lastAlert.set(key, now);
    if (level === 'error') this.logger.error(JSON.stringify(fields));
    else this.logger.warn(JSON.stringify(fields));
  }
}
