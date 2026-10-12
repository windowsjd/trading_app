import type { Prisma } from '../generated/prisma/client';

/** Lock the target before reading role/status. NO KEY UPDATE permits audit
 * foreign-key KEY SHARE locks on actors (including crossed admin requests).
 * All role/status writers, including restore, use this same target boundary.
 */
export async function lockManagedUser(
  tx: Prisma.TransactionClient,
  userId: string,
) {
  await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR NO KEY UPDATE`;
}

/** Only active-admin reductions acquire this transaction-scoped PG lock.
 * Count AFTER acquiring it under READ COMMITTED: another reduction's commit
 * must be visible. No other target user rows are explicitly locked or mutated while holding it.
 * The two-int namespace ("TCAD", 1) is reserved for this invariant.
 */
export async function lockActiveAdminReduction(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(1413693764, 1)::text`;
}
