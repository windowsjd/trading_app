import {
  CurrencyCode,
  FxRateSourceType,
  Prisma,
} from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { FX_USD_KRW_PROVIDER_SOURCE_PRIORITY } from './source-eligibility.policy';

export type UsdKrwProviderSnapshotCandidate = {
  id: string;
  baseCurrency: CurrencyCode;
  quoteCurrency: CurrencyCode;
  rate: Prisma.Decimal;
  sourceType: FxRateSourceType;
  sourceName: string | null;
  effectiveAt: Date;
  capturedAt: Date;
  createdAt: Date;
  approvedByUserId: string | null;
};

type FxRateSnapshotClient = PrismaService | Prisma.TransactionClient;

export type FindUsdKrwProviderCandidatesOptions = {
  sourceNames: readonly string[];
  take?: number;
  effectiveAtLte?: Date;
  positiveRateOnly?: boolean;
};

/**
 * Reads a bounded provider candidate set without letting one noisy source hide
 * every row from another source. The first query keeps the common one-query
 * path. A source-specific bounded query is added only when that first page has
 * no observation from an expected source.
 */
export async function findUsdKrwProviderSnapshotCandidates(
  client: FxRateSnapshotClient,
  options: FindUsdKrwProviderCandidatesOptions,
): Promise<UsdKrwProviderSnapshotCandidate[]> {
  const sourceNames = [...new Set(options.sourceNames.filter(Boolean))];
  if (sourceNames.length === 0) {
    return [];
  }

  const take = normalizeTake(options.take);
  const baseWhere = {
    baseCurrency: CurrencyCode.USD,
    quoteCurrency: CurrencyCode.KRW,
    sourceType: FxRateSourceType.provider_api,
    sourceName: { in: sourceNames },
    ...(options.effectiveAtLte
      ? { effectiveAt: { lte: options.effectiveAtLte } }
      : {}),
    ...(options.positiveRateOnly ? { rate: { gt: 0 } } : {}),
  } satisfies Prisma.FxRateSnapshotWhereInput;
  const query = (where: Prisma.FxRateSnapshotWhereInput) =>
    client.fxRateSnapshot.findMany({
      where,
      orderBy: [
        { effectiveAt: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      take,
      select: {
        id: true,
        baseCurrency: true,
        quoteCurrency: true,
        rate: true,
        sourceType: true,
        sourceName: true,
        effectiveAt: true,
        capturedAt: true,
        createdAt: true,
        approvedByUserId: true,
      },
    });

  const firstPage = await query(baseWhere);
  const presentSources = new Set(
    firstPage.map((candidate) => candidate.sourceName).filter(Boolean),
  );
  const missingSources = sourceNames.filter(
    (sourceName) => !presentSources.has(sourceName),
  );

  if (missingSources.length === 0) {
    return firstPage;
  }

  const supplements = await Promise.all(
    missingSources.map((sourceName) =>
      query({
        ...baseWhere,
        sourceName,
      }),
    ),
  );

  return [...firstPage, ...supplements.flat()];
}

export type UsdKrwRateAtInstant = {
  snapshotId: string;
  rate: Prisma.Decimal;
};

/**
 * USD/KRW evidence in effect at each instant (UTC ISO strings), by the season
 * settlement rule (docs/policy-decisions.md "Source Type 우선순위"): provider
 * sources in priority order, the latest positive row effective at or before the
 * instant; otherwise the latest approved positive admin_manual row. A row also
 * has to be CAPTURED at or before the instant, so only evidence the system held
 * at that moment counts — a later or backdated insert never reprices the past.
 *
 * One indexed lookup per instant and source (LATERAL), instead of loading the
 * season's whole FX history. Instants without evidence are absent from the map.
 */
export async function findUsdKrwRatesAtOrBefore(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>,
  instants: readonly string[],
): Promise<Map<string, UsdKrwRateAtInstant>> {
  const rates = new Map<string, UsdKrwRateAtInstant>();
  let pending = [...new Set(instants)];
  const record = (rows: Array<{ at: string; id: string; rate: unknown }>) => {
    for (const row of rows) {
      rates.set(row.at, {
        snapshotId: row.id,
        rate: new Prisma.Decimal(String(row.rate)),
      });
    }
    pending = pending.filter((at) => !rates.has(at));
  };

  for (const sourceName of FX_USD_KRW_PROVIDER_SOURCE_PRIORITY) {
    if (pending.length === 0) break;
    record(
      await client.$queryRaw<Array<{ at: string; id: string; rate: unknown }>>`
        SELECT u."at" AS "at", f."id" AS "id", f."rate" AS "rate"
        FROM unnest(${pending}::text[]) AS u("at")
        CROSS JOIN LATERAL (
          SELECT s."id", s."rate"
          FROM "fx_rate_snapshots" s
          WHERE s."base_currency" = 'USD'
            AND s."quote_currency" = 'KRW'
            AND s."source_type" = 'provider_api'
            AND s."source_name" = ${sourceName}
            AND s."rate" > 0
            AND s."effective_at" <= (u."at"::timestamptz AT TIME ZONE 'UTC')
            AND s."captured_at" <= (u."at"::timestamptz AT TIME ZONE 'UTC')
          ORDER BY s."effective_at" DESC, s."captured_at" DESC, s."created_at" DESC
          LIMIT 1
        ) f
      `,
    );
  }

  if (pending.length > 0) {
    record(
      await client.$queryRaw<Array<{ at: string; id: string; rate: unknown }>>`
        SELECT u."at" AS "at", f."id" AS "id", f."rate" AS "rate"
        FROM unnest(${pending}::text[]) AS u("at")
        CROSS JOIN LATERAL (
          SELECT s."id", s."rate"
          FROM "fx_rate_snapshots" s
          WHERE s."base_currency" = 'USD'
            AND s."quote_currency" = 'KRW'
            AND s."source_type" = 'admin_manual'
            AND s."approved_by_user_id" IS NOT NULL
            AND s."rate" > 0
            AND s."effective_at" <= (u."at"::timestamptz AT TIME ZONE 'UTC')
            AND s."captured_at" <= (u."at"::timestamptz AT TIME ZONE 'UTC')
          ORDER BY s."effective_at" DESC, s."captured_at" DESC, s."created_at" DESC
          LIMIT 1
        ) f
      `,
    );
  }

  return rates;
}

function normalizeTake(value: number | undefined): number {
  if (!Number.isInteger(value) || !value || value < 1) {
    return 10;
  }
  return Math.min(value, 100);
}
