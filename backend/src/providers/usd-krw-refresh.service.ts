import { Injectable } from '@nestjs/common';
import { CurrencyCode } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExchangeRateIngestionService } from './exchange-rate/exchange-rate.ingestion.service';
import { findUsdKrwProviderSnapshotCandidates } from './fx-rate-snapshot-query';
import { KoreaEximExchangeIngestionService } from './korea-exim/korea-exim-exchange.ingestion.service';
import { ProviderConfigError, ProviderHttpError } from './provider.types';
import {
  isPositiveDecimal,
  resolveFxProviderEligibility,
  selectFreshProviderSnapshotBySourcePriority,
} from './source-eligibility.policy';

type RefreshWorkflow = 'orders_execute' | 'fx_execute' | 'fx_quote';
export type UsdKrwRefreshResult = {
  attempted: boolean;
  result: 'already_fresh' | 'refreshed' | 'unavailable';
  source: string | null;
};

/** Provider preparation only: never accepts a transaction or returns a rate.
 * Executions must independently select committed evidence at their DB clock.
 */
@Injectable()
export class UsdKrwRefreshService {
  private readonly inFlight = new Map<number, Promise<UsdKrwRefreshResult>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly koreaExim: KoreaEximExchangeIngestionService,
    private readonly exchangeRate: ExchangeRateIngestionService,
  ) {}

  async prepare(
    workflow: RefreshWorkflow,
    now = new Date(),
  ): Promise<UsdKrwRefreshResult> {
    const eligibility = resolveFxProviderEligibility({
      workflow,
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
    });
    if (!eligibility.eligible) {
      return { attempted: false, result: 'unavailable', source: null };
    }
    const { sourceNames, freshnessThresholdSeconds } = eligibility;
    // Include the initial DB check in the shared work so concurrent callers
    // cannot start a second refresh from a stale pre-refresh read.
    const pending = this.inFlight.get(freshnessThresholdSeconds);
    if (pending) return pending;
    const preparation = this.run(now, sourceNames, freshnessThresholdSeconds);
    this.inFlight.set(freshnessThresholdSeconds, preparation);
    try {
      return await preparation;
    } finally {
      if (this.inFlight.get(freshnessThresholdSeconds) === preparation) {
        this.inFlight.delete(freshnessThresholdSeconds);
      }
    }
  }

  private async run(
    now: Date,
    sourceNames: readonly string[],
    maxAgeSeconds: number,
  ): Promise<UsdKrwRefreshResult> {
    const select = async (at: Date) =>
      selectFreshProviderSnapshotBySourcePriority({
        candidates: await findUsdKrwProviderSnapshotCandidates(this.prisma, {
          sourceNames,
          take: 10,
        }),
        expectedSourceNames: sourceNames,
        now: at,
        freshnessThresholdSeconds: maxAgeSeconds,
        isPositiveValue: (candidate) => isPositiveDecimal(candidate.rate),
      });
    const existing = await select(now);
    if (existing.state === 'selected') {
      return {
        attempted: false,
        result: 'already_fresh',
        source: existing.snapshot.sourceName,
      };
    }

    try {
      await this.koreaExim.ensureFreshUsdKrwSnapshot({ now, maxAgeSeconds });
    } catch (error) {
      if (
        !(
          error instanceof ProviderConfigError ||
          error instanceof ProviderHttpError
        )
      ) {
        throw error;
      }
    }
    // Ingestion success alone is insufficient. Confirm eligible committed
    // evidence, including observations received after preparation started.
    let selected = await select(new Date());
    if (selected.state !== 'selected') {
      await this.exchangeRate.ingestUsdKrw({
        dryRun: false,
        requestedBy: 'fx_on_demand_refresh',
      });
      selected = await select(new Date());
    }
    return selected.state === 'selected'
      ? {
          attempted: true,
          result: 'refreshed',
          source: selected.snapshot.sourceName,
        }
      : { attempted: true, result: 'unavailable', source: null };
  }
}
