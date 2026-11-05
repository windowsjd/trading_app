import { createHash } from 'crypto';
import type { Prisma } from '../generated/prisma/client';
import { createApiError } from './api-error';

/**
 * 대기주문·설정 변경 (docs/pending-order-modification-contract.md). Shared
 * pieces of every in-place change: each module keeps its own locks, state
 * rules and create-time validation, and calls these in the same order:
 *
 *   account fence → target row FOR UPDATE → replay? → state → revision →
 *   create rules on the new terms → update (revision + 1, revised_at) → record
 *
 * The replay check comes before the state and revision checks so a retry
 * after a lost response finds its own commit instead of a "changed" revision.
 */

export type ModificationTarget =
  | 'spot_order'
  | 'conditional_buy'
  | 'conditional_sell'
  | 'futures_limit_order'
  | 'futures_conditional_entry'
  | 'futures_tp_sl'
  | 'entry_tp_sl_plan';

/** The canonical terms of a target (decimal text), compared and recorded as is. */
export type ModificationTerms = Record<string, string | number | null>;

export type ModificationEnvelope = {
  idempotencyKey: string;
  expectedRevision: number;
};

type ModificationClient = {
  pendingOrderModification: {
    findUnique: (args: {
      where: {
        tradingAccountId_idempotencyKey: {
          tradingAccountId: string;
          idempotencyKey: string;
        };
      };
      select: { requestHash: true; targetType: true; targetId: true };
    }) => Promise<{
      requestHash: string;
      targetType: string;
      targetId: string;
    } | null>;
    create: (args: {
      data: Prisma.PendingOrderModificationUncheckedCreateInput;
    }) => Promise<unknown>;
  };
};

/** The key the change is replayed by, and the revision the user changed from. */
export function parseModificationEnvelope(body: unknown): ModificationEnvelope {
  const row =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const key = row.idempotencyKey;
  if (typeof key !== 'string' || !/^[A-Za-z0-9:_-]{8,128}$/.test(key))
    throw createApiError(
      'INVALID_IDEMPOTENCY_KEY',
      'A valid idempotency key is required.',
      400,
    );
  const revision = row.expectedRevision;
  if (
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    revision < 0 ||
    revision > 1_000_000
  )
    throw createApiError(
      'INVALID_PENDING_ORDER_MODIFICATION',
      'expectedRevision must be the revision the change was made from.',
      400,
    );
  return { idempotencyKey: key, expectedRevision: revision };
}

/** Request identity: the target, the revision changed from and the new terms. */
export function modificationHash(
  target: ModificationTarget,
  targetId: string,
  expectedRevision: number,
  terms: ModificationTerms,
) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        operation: 'pending_order_modify:v1',
        target,
        targetId,
        expectedRevision,
        terms,
      }),
    )
    .digest('hex');
}

/**
 * True when this key already committed this exact change (replay: answer
 * with the target as it is now); another request under the key conflicts.
 * Call under the account fence, before the state and revision checks.
 */
export async function isReplayedModification(
  tx: ModificationClient,
  input: {
    accountId: string;
    target: ModificationTarget;
    targetId: string;
    idempotencyKey: string;
    requestHash: string;
  },
) {
  const committed = await tx.pendingOrderModification.findUnique({
    where: {
      tradingAccountId_idempotencyKey: {
        tradingAccountId: input.accountId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    select: { requestHash: true, targetType: true, targetId: true },
  });
  if (!committed) return false;
  if (
    committed.requestHash !== input.requestHash ||
    committed.targetType !== input.target ||
    committed.targetId !== input.targetId
  )
    throw createApiError(
      'PENDING_ORDER_MODIFY_IDEMPOTENCY_CONFLICT',
      'The command differs from the committed request.',
      409,
    );
  return true;
}

/** Only a still-pending target changes; anything else answers with its state. */
export function notModifiable(): never {
  throw createApiError(
    'PENDING_ORDER_NOT_MODIFIABLE',
    'This order or setting can no longer be changed.',
    409,
  );
}

/** The change was made from an older revision: the user reviews the latest terms. */
export function assertExpectedRevision(current: number, expected: number) {
  if (current !== expected)
    throw createApiError(
      'PENDING_ORDER_CHANGED',
      'The order or setting changed; review its latest terms.',
      409,
    );
}

/** Same terms again: nothing to change (and no reason to move the evidence floor). */
export function assertTermsChanged(
  before: ModificationTerms,
  after: ModificationTerms,
) {
  if (JSON.stringify(before) === JSON.stringify(after))
    throw createApiError(
      'PENDING_ORDER_UNCHANGED',
      'The new terms are the same as the current ones.',
      400,
    );
}

/** The append-only record of a committed change (same transaction as the change). */
export async function recordModification(
  tx: ModificationClient,
  input: {
    accountId: string;
    target: ModificationTarget;
    targetId: string;
    idempotencyKey: string;
    requestHash: string;
    revision: number;
    before: ModificationTerms;
    after: ModificationTerms;
    at: Date;
  },
) {
  try {
    await tx.pendingOrderModification.create({
      data: {
        tradingAccountId: input.accountId,
        targetType: input.target,
        targetId: input.targetId,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        revision: input.revision,
        beforeJson: input.before,
        afterJson: input.after,
        createdAt: input.at,
      },
    });
  } catch (error) {
    // One key raced on two targets under a shared fence (Season Spot orders
    // lock the participant FOR SHARE): the unique key decides, and the loser
    // gets the conflict its replay would. Its transaction rolls back whole.
    if ((error as { code?: unknown } | null)?.code === 'P2002')
      throw createApiError(
        'PENDING_ORDER_MODIFY_IDEMPOTENCY_CONFLICT',
        'The command differs from the committed request.',
        409,
      );
    throw error;
  }
}

/** The evidence floor of a pending row: its latest change, else its first registration. */
export function evidenceFloor(
  row: { revisedAt?: Date | null },
  registered: Date,
) {
  return row.revisedAt && row.revisedAt > registered
    ? row.revisedAt
    : registered;
}
