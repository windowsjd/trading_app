import { Prisma } from '../generated/prisma/client';

type PositionAtomicClient = Pick<Prisma.TransactionClient, '$executeRaw'>;

export type PositionReservationInput = {
  positionId: string;
  seasonParticipantId: string | null;
  tradingAccountId: string;
  assetId: string;
  quantity: string;
};

/** Atomically reserves only unreserved owned quantity. */
export async function reserveAvailablePositionQuantity(
  client: PositionAtomicClient,
  input: PositionReservationInput,
): Promise<number> {
  return client.$executeRaw`
    UPDATE "positions"
    SET "reserved_quantity" = "reserved_quantity" + ${input.quantity}::numeric,
        "updated_at" = clock_timestamp()
    WHERE "id" = ${input.positionId}
      AND "season_participant_id" IS NOT DISTINCT FROM ${input.seasonParticipantId}
      AND "trading_account_id" = ${input.tradingAccountId}
      AND "asset_id" = ${input.assetId}
      AND "quantity" - "reserved_quantity" >= ${input.quantity}::numeric
  `;
}

/** Cancel/cleanup release, guarded so one order can release at most once. */
export async function releaseReservedPositionQuantity(
  client: PositionAtomicClient,
  input: PositionReservationInput,
): Promise<number> {
  return client.$executeRaw`
    UPDATE "positions"
    SET "reserved_quantity" = "reserved_quantity" - ${input.quantity}::numeric,
        "updated_at" = clock_timestamp()
    WHERE "id" = ${input.positionId}
      AND "season_participant_id" IS NOT DISTINCT FROM ${input.seasonParticipantId}
      AND "trading_account_id" = ${input.tradingAccountId}
      AND "asset_id" = ${input.assetId}
      AND "reserved_quantity" >= ${input.quantity}::numeric
  `;
}

/** Full-fill settlement: consume owned quantity and its reservation together. */
export async function settleReservedPositionQuantity(
  client: PositionAtomicClient,
  input: PositionReservationInput & {
    realizedPnlDelta: string;
    realizedPnlKrwDelta: string;
  },
): Promise<number> {
  return client.$executeRaw`
    UPDATE "positions"
    SET "quantity" = "quantity" - ${input.quantity}::numeric,
        "reserved_quantity" = "reserved_quantity" - ${input.quantity}::numeric,
        "realized_pnl" = "realized_pnl" + ${input.realizedPnlDelta}::numeric,
        "realized_pnl_krw" = "realized_pnl_krw" + ${input.realizedPnlKrwDelta}::numeric,
        "updated_at" = clock_timestamp()
    WHERE "id" = ${input.positionId}
      AND "season_participant_id" IS NOT DISTINCT FROM ${input.seasonParticipantId}
      AND "trading_account_id" = ${input.tradingAccountId}
      AND "asset_id" = ${input.assetId}
      AND "quantity" >= ${input.quantity}::numeric
      AND "reserved_quantity" >= ${input.quantity}::numeric
  `;
}
