import {
  CurrencyCode,
  FxRateSourceType,
} from '../generated/prisma/client';
import type { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

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

function normalizeTake(value: number | undefined): number {
  if (!Number.isInteger(value) || !value || value < 1) {
    return 10;
  }
  return Math.min(value, 100);
}
