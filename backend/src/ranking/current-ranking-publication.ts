import { Prisma, SnapshotReason } from '../generated/prisma/client';

const PUBLICATION_BATCH_SIZE = 200;

/** The caller owns the transaction and has already checked the Season lock,
 * generation, participant set and account scopes. Batch failures propagate so
 * publication still rolls back as one unit. Never skip conflicting rows. */
export async function insertCurrentRankingRows(
  tx: Pick<Prisma.TransactionClient, 'seasonRanking'>,
  rows: readonly Prisma.SeasonRankingCreateManyInput[],
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += PUBLICATION_BATCH_SIZE) {
    await tx.seasonRanking.createMany({
      data: rows.slice(offset, offset + PUBLICATION_BATCH_SIZE),
    });
  }
}

/** Retain the first scheduled snapshot per account in the five-minute bucket,
 * with the same Season lock held across the existence check and insertion. */
export async function insertMissingScheduledEquitySnapshots(
  tx: Pick<Prisma.TransactionClient, 'equitySnapshot'>,
  input: {
    capturedAt: Date;
    rows: readonly Prisma.EquitySnapshotCreateManyInput[];
  },
): Promise<void> {
  const bucketStart = new Date(
    Math.floor(input.capturedAt.getTime() / (5 * 60_000)) * 5 * 60_000,
  );
  const bucketEnd = new Date(bucketStart.getTime() + 5 * 60_000);

  for (
    let offset = 0;
    offset < input.rows.length;
    offset += PUBLICATION_BATCH_SIZE
  ) {
    const batch = input.rows.slice(offset, offset + PUBLICATION_BATCH_SIZE);
    const existing = await tx.equitySnapshot.findMany({
      where: {
        tradingAccountId: { in: batch.map((row) => row.tradingAccountId) },
        snapshotReason: SnapshotReason.scheduled,
        capturedAt: { gte: bucketStart, lt: bucketEnd },
      },
      select: { tradingAccountId: true },
    });
    const existingAccounts = new Set(
      existing.map((row) => row.tradingAccountId),
    );
    const missing = batch.filter(
      (row) => !existingAccounts.has(row.tradingAccountId),
    );
    if (missing.length > 0) {
      await tx.equitySnapshot.createMany({ data: missing });
    }
  }
}
