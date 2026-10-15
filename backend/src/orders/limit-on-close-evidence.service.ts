import { Injectable } from '@nestjs/common';
import { CurrencyCode, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KoscomClient, koscomRecord } from '../providers/koscom/koscom.client';
import {
  KOSCOM_HISTORY_SOURCE,
  KoscomConfigService,
  KoscomError,
} from '../providers/koscom/koscom.config';
import { KoscomMarketMapService } from '../providers/koscom/koscom-market-map.service';
import { ohlcv } from '../providers/koscom/koscom-candle.adapter';
import { buildProviderRawPayloadJson } from '../providers/provider-raw-payload';
import {
  LOC_EVIDENCE_POLICY_VERSION,
  nextCloseEvidenceTransition,
  sessionDateText,
} from './limit-on-close.policy';

export type SessionCloseTarget = {
  assetId: string;
  symbol: string;
  /** Stored Asset.market label (e.g. KRX); the provider market is resolved. */
  assetMarket: string;
  market: 'KRX' | 'US';
  sessionDate: Date;
  /** Current calendar close of the bound session. */
  sessionCloseAt: Date;
};

export type SessionCloseObservation = {
  provider: string;
  sourceName: string;
  providerSymbol: string;
  /** Provider business date, compact `YYYYMMDD`. */
  providerTradingDate: string;
  closePrice: Prisma.Decimal;
  currencyCode: CurrencyCode;
  /** Provider response receipt time. */
  observedAt: Date;
  raw: Prisma.InputJsonValue;
};

/** Fixed rejection categories for an observation that cannot be evidence. */
export class SessionCloseEvidenceError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'SessionCloseEvidenceError';
  }
}

export function sessionCloseFailure(error: unknown): string {
  if (error instanceof KoscomError) return error.code;
  if (error instanceof SessionCloseEvidenceError) return error.reason;
  return 'SESSION_CLOSE_OBSERVATION_FAILED';
}

const KOSCOM_PROVIDER = 'koscom';

/**
 * KRX dated regular-session close from KOSCOM `closed/{market}/{code}/history`
 * (D, exact date, one row) — the same endpoint/validation as the existing
 * completed-session recovery. `closeprice` is not used: it carries no business
 * date. Realtime ticks, 5m candles and stored daily candles are never read.
 * Provider calls happen outside every financial transaction.
 */
@Injectable()
export class KoscomSessionCloseSource {
  constructor(
    private readonly config: KoscomConfigService,
    private readonly client: KoscomClient,
    private readonly markets: KoscomMarketMapService,
  ) {}

  async observe(target: SessionCloseTarget): Promise<SessionCloseObservation> {
    if (target.market !== 'KRX')
      throw /* @diagnosticSurface internal: Fixed LOC evidence category recorded on the order and Ops summary. */ new SessionCloseEvidenceError(
        'SESSION_CLOSE_SOURCE_UNAVAILABLE',
      );
    const date = sessionDateText(target.sessionDate).replaceAll('-', '');
    const market = await this.markets.resolve(
      target.symbol,
      target.assetMarket,
    );
    const path = `/v3/market/closed/${market}/${target.symbol}/history`;
    const query = {
      trnsmCycleTpCd: 'D',
      inqStrtDd: date,
      inqEndDd: date,
      reqCnt: '1',
    };
    const response = await this.client.get(path, query, undefined, {
      category: 'loc',
    });
    if (response.result.isuSrtCd !== target.symbol)
      throw /* @diagnosticSurface internal: Fixed LOC evidence category recorded on the order and Ops summary. */ new SessionCloseEvidenceError(
        'KOSCOM_CLOSE_SYMBOL_MISMATCH',
      );
    const rows = response.result.hisLists;
    if (!Array.isArray(rows) || rows.length !== 1)
      throw /* @diagnosticSurface internal: Fixed LOC evidence category recorded on the order and Ops summary. */ new SessionCloseEvidenceError(
        'KOSCOM_CLOSE_EVIDENCE_MISSING',
      );
    if (response.receivedAt < target.sessionCloseAt)
      throw /* @diagnosticSurface internal: Fixed LOC evidence category recorded on the order and Ops summary. */ new SessionCloseEvidenceError(
        'KOSCOM_CLOSE_BEFORE_SESSION_END',
      );
    const row = koscomRecord(rows[0]);
    if (row.trdDd !== date)
      throw /* @diagnosticSurface internal: Fixed LOC evidence category recorded on the order and Ops summary. */ new SessionCloseEvidenceError(
        'KOSCOM_CLOSE_DATE_MISMATCH',
      );
    const values = ohlcv(row, false);
    // A session without trades has no closing auction print to fill against.
    if (!new Prisma.Decimal(values.volume).gt(0))
      throw /* @diagnosticSurface internal: Fixed LOC evidence category recorded on the order and Ops summary. */ new SessionCloseEvidenceError(
        'KOSCOM_CLOSE_NO_TRADES',
      );
    return {
      provider: KOSCOM_PROVIDER,
      sourceName: KOSCOM_HISTORY_SOURCE,
      providerSymbol: target.symbol,
      providerTradingDate: date,
      closePrice: new Prisma.Decimal(values.close),
      currencyCode: CurrencyCode.KRW,
      observedAt: response.receivedAt,
      raw: buildProviderRawPayloadJson({
        payload: {
          provider: KOSCOM_PROVIDER,
          messageType: 'rest_session_close_history',
          path,
          query,
          isuSrtCd: response.result.isuSrtCd,
          row,
          receivedAt: response.receivedAt.toISOString(),
        },
        maxBytes: 16000,
        secrets: [this.config.getConfig().apiKey],
      }) as Prisma.InputJsonValue,
    };
  }
}

export type SessionCloseEvidenceRow = Awaited<
  ReturnType<LimitOnCloseEvidenceService['find']>
>;

/**
 * PostgreSQL record of dated close observations. One row per
 * asset/market/session/provider; it becomes final only through
 * nextCloseEvidenceTransition and is immutable afterwards.
 */
@Injectable()
export class LimitOnCloseEvidenceService {
  constructor(private readonly prisma: PrismaService) {}

  find(target: Pick<SessionCloseTarget, 'assetId' | 'market' | 'sessionDate'>) {
    return this.prisma.sessionClosePriceEvidence.findUnique({
      where: {
        assetId_market_sessionDate_provider: {
          assetId: target.assetId,
          market: target.market,
          sessionDate: target.sessionDate,
          provider: KOSCOM_PROVIDER,
        },
      },
    });
  }

  async recordObservation(
    target: SessionCloseTarget,
    observation: SessionCloseObservation,
    confirmMs: number,
  ) {
    assertObservationIdentity(target, observation);
    const key = {
      assetId: target.assetId,
      market: target.market,
      sessionDate: target.sessionDate,
      provider: observation.provider,
    };
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const found = await tx.sessionClosePriceEvidence.findUnique({
            where: { assetId_market_sessionDate_provider: key },
            select: { id: true },
          });
          if (found)
            await tx.$queryRaw`SELECT "id" FROM "session_close_price_evidences" WHERE "id" = ${found.id} FOR UPDATE`;
          const existing = found
            ? await tx.sessionClosePriceEvidence.findUniqueOrThrow({
                where: { id: found.id },
              })
            : null;
          const transition = nextCloseEvidenceTransition(
            existing,
            observation,
            confirmMs,
          );
          if (transition === 'create')
            return tx.sessionClosePriceEvidence.create({
              data: {
                ...key,
                sessionCloseAt: target.sessionCloseAt,
                sourceName: observation.sourceName,
                providerSymbol: observation.providerSymbol,
                providerTradingDate: observation.providerTradingDate,
                closePrice: observation.closePrice,
                currencyCode: observation.currencyCode,
                firstObservedAt: observation.observedAt,
                lastObservedAt: observation.observedAt,
                firstRawJson: observation.raw,
                policyVersion: LOC_EVIDENCE_POLICY_VERSION,
              },
            });
          if (!existing || transition === 'ignore') return existing;
          if (transition === 'replace')
            return tx.sessionClosePriceEvidence.update({
              where: { id: existing.id },
              data: {
                closePrice: observation.closePrice,
                firstObservedAt: observation.observedAt,
                lastObservedAt: observation.observedAt,
                firstRawJson: observation.raw,
                observationCount: { increment: 1 },
                mismatchCount: { increment: 1 },
              },
            });
          if (transition === 'extend')
            return tx.sessionClosePriceEvidence.update({
              where: { id: existing.id },
              data: {
                lastObservedAt: observation.observedAt,
                observationCount: { increment: 1 },
              },
            });
          const [clock] = await tx.$queryRaw<
            Array<{ now: Date }>
          >`SELECT clock_timestamp() AS "now"`;
          return tx.sessionClosePriceEvidence.update({
            where: { id: existing.id },
            data: {
              status: 'final',
              finalizedAt: clock.now,
              lastObservedAt: observation.observedAt,
              confirmRawJson: observation.raw,
              observationCount: { increment: 1 },
            },
          });
        });
      } catch (error) {
        // Two writers creating the first observation: re-read the winner.
        if (
          attempt === 0 &&
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        )
          continue;
        throw error;
      }
    }
  }
}

function assertObservationIdentity(
  target: SessionCloseTarget,
  observation: SessionCloseObservation,
) {
  if (
    observation.providerSymbol !== target.symbol ||
    observation.providerTradingDate !==
      sessionDateText(target.sessionDate).replaceAll('-', '') ||
    observation.observedAt < target.sessionCloseAt ||
    !observation.closePrice.isFinite() ||
    observation.closePrice.lte(0) ||
    observation.currencyCode !==
      (target.market === 'KRX' ? CurrencyCode.KRW : CurrencyCode.USD)
  )
    throw /* @diagnosticSurface internal: Fixed LOC evidence category recorded on the order and Ops summary. */ new SessionCloseEvidenceError(
      'SESSION_CLOSE_IDENTITY_MISMATCH',
    );
}
