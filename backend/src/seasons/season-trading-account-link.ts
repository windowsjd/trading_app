import { createHash } from 'node:crypto';
import {
  ParticipantStatus,
  Prisma,
  TradingAccountMode,
  TradingAccountStatus,
} from '../generated/prisma/client';

/**
 * Season participant ↔ TradingAccount link repair.
 *
 * Deploy-boundary background: `season_participants.trading_account_id` is a
 * transitional nullable column. The `add_trading_account_foundation` migration
 * backfilled every participant that existed at migration time, but an
 * old-version writer running during the deploy window can still create a
 * participant with a null link. This module is the ONE implementation of the
 * repair rules shared by joinSeason, operator exclusion, the dev baseline, and
 * the operational repair script:
 *
 *  - The repaired account id is derived deterministically from the participant
 *    id with exactly the same formula as the migration backfill, so a repair
 *    can never create a second/orphan account for the same participant.
 *  - Repair copies userId / initialCapitalKrw / joinedAt from the participant
 *    and maps ParticipantStatus to TradingAccountStatus like the backfill.
 *  - Repair NEVER touches wallets, ledgers, orders, positions, exchanges, or
 *    snapshots, and it never overwrites an inconsistent account silently —
 *    any mismatch fails closed with SeasonTradingAccountLinkIntegrityError.
 */

const SEASON_TRADING_ACCOUNT_ID_NAMESPACE =
  'trading-account:season-participant:';

/**
 * Derive the season TradingAccount id for a participant exactly like the
 * migration backfill: md5('trading-account:season-participant:' || id) cast
 * to a UUID (PostgreSQL `md5(...)::uuid::text`).
 *
 * md5 is used here ONLY as a deterministic identifier derivation that must
 * stay byte-identical to the migration SQL — it is NOT a security mechanism
 * and this helper must never be used for tokens, secrets, or authentication.
 */
export function deriveSeasonTradingAccountId(
  seasonParticipantId: string,
): string {
  const hex = createHash('md5')
    .update(`${SEASON_TRADING_ACCOUNT_ID_NAMESPACE}${seasonParticipantId}`)
    .digest('hex');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * ParticipantStatus → TradingAccountStatus, identical to the migration
 * backfill CASE mapping.
 */
export function mapParticipantStatusToTradingAccountStatus(
  status: ParticipantStatus,
): TradingAccountStatus {
  switch (status) {
    case ParticipantStatus.registered:
    case ParticipantStatus.active:
      return TradingAccountStatus.active;
    case ParticipantStatus.excluded:
      return TradingAccountStatus.suspended;
    case ParticipantStatus.finished:
    case ParticipantStatus.rewarded:
      return TradingAccountStatus.closed;
  }
}

/**
 * Internal data-consistency failure. Callers must surface this as a
 * structured 5xx (or a script failure) — never hide it behind 409/404 and
 * never "fix" the mismatch by overwriting data.
 */
export class SeasonTradingAccountLinkIntegrityError extends Error {
  readonly code = 'TRADING_ACCOUNT_LINK_INTEGRITY';

  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SeasonTradingAccountLinkIntegrityError';
  }
}

export type SeasonTradingAccountLinkParticipant = {
  id: string;
  userId: string;
  joinedAt: Date;
  participantStatus: ParticipantStatus;
  initialCapitalKrw: Prisma.Decimal | string;
  tradingAccountId: string | null;
};

export type SeasonTradingAccountLinkClient = Pick<
  Prisma.TransactionClient,
  'tradingAccount' | 'seasonParticipant' | '$executeRaw'
>;

export type SeasonTradingAccountLinkReadClient = Pick<
  Prisma.TransactionClient,
  'tradingAccount' | 'seasonParticipant'
>;

const LINK_ACCOUNT_SELECT = {
  id: true,
  userId: true,
  mode: true,
  status: true,
  initialCapitalKrw: true,
  openedAt: true,
  seasonParticipant: {
    select: {
      id: true,
    },
  },
} satisfies Prisma.TradingAccountSelect;

type LinkAccountRow = {
  id: string;
  userId: string;
  mode: TradingAccountMode;
  status: TradingAccountStatus;
  initialCapitalKrw: Prisma.Decimal;
  openedAt: Date;
  seasonParticipant: { id: string } | null;
};

export type SeasonTradingAccountLinkResult = {
  tradingAccountId: string;
  action: 'already-linked' | 'linked-existing-account' | 'created-and-linked';
};

export type SeasonTradingAccountLinkPreview = {
  tradingAccountId: string;
  action:
    | 'already-linked'
    | 'would-link-existing-account'
    | 'would-create-and-link';
};

/**
 * Ensure the participant is linked to its season TradingAccount. Must run
 * inside the caller's DB transaction. Safe under concurrent repair: the
 * deterministic id + conflict-ignoring insert + post-insert re-read
 * validation + guarded updateMany guarantee exactly one verified account and
 * no orphan even when two repairs race.
 */
export async function ensureSeasonTradingAccountLink(
  tx: SeasonTradingAccountLinkClient,
  participant: SeasonTradingAccountLinkParticipant,
): Promise<SeasonTradingAccountLinkResult> {
  if (participant.tradingAccountId) {
    const account = (await tx.tradingAccount.findUnique({
      where: { id: participant.tradingAccountId },
      select: LINK_ACCOUNT_SELECT,
    })) as LinkAccountRow | null;

    if (!account) {
      throw new SeasonTradingAccountLinkIntegrityError(
        'Participant references a trading account that does not exist.',
        {
          seasonParticipantId: participant.id,
          tradingAccountId: participant.tradingAccountId,
        },
      );
    }

    validateLinkedAccount(account, participant);

    return { tradingAccountId: account.id, action: 'already-linked' };
  }

  const accountId = deriveSeasonTradingAccountId(participant.id);
  const initialCapitalKrw = toAmountString(participant.initialCapitalKrw);

  const existing = (await tx.tradingAccount.findUnique({
    where: { id: accountId },
    select: LINK_ACCOUNT_SELECT,
  })) as LinkAccountRow | null;

  let insertedCount = 0;
  if (existing) {
    validateDeterministicAccount(existing, participant, initialCapitalKrw);
  } else {
    // Raw ON CONFLICT DO NOTHING (not create/upsert): a concurrent repair
    // inserting the same deterministic id must not raise a unique violation,
    // which would abort this whole transaction in PostgreSQL. A conflict can
    // only be the identical deterministic row, and it is never modified.
    insertedCount = await tx.$executeRaw`
      INSERT INTO "trading_accounts" (
        "id", "user_id", "mode", "status",
        "initial_capital_krw", "opened_at", "closed_at",
        "created_at", "updated_at"
      )
      VALUES (
        ${accountId},
        ${participant.userId},
        CAST(${TradingAccountMode.season}::text AS "TradingAccountMode"),
        CAST(${mapParticipantStatusToTradingAccountStatus(
          participant.participantStatus,
        )}::text AS "TradingAccountStatus"),
        CAST(${initialCapitalKrw} AS DECIMAL(24, 8)),
        ${participant.joinedAt},
        NULL,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT ("id") DO NOTHING
    `;

    // The first lookup and the insert are not atomic: a concurrent
    // transaction may have inserted a DIFFERENT row under the same
    // deterministic id, which DO NOTHING silently ignores. Always re-read
    // what is actually stored and validate it BEFORE linking the
    // participant; never link an account that was not verified.
    const stored = (await tx.tradingAccount.findUnique({
      where: { id: accountId },
      select: LINK_ACCOUNT_SELECT,
    })) as LinkAccountRow | null;

    if (!stored) {
      throw new SeasonTradingAccountLinkIntegrityError(
        'Deterministic trading account is missing after insert.',
        { seasonParticipantId: participant.id, tradingAccountId: accountId },
      );
    }

    validateDeterministicAccount(stored, participant, initialCapitalKrw);
  }

  let linked: { count: number };
  try {
    // Guarded link: only a still-null participant row is updated, so a
    // concurrent repair that already linked cannot be overwritten.
    linked = await tx.seasonParticipant.updateMany({
      where: { id: participant.id, tradingAccountId: null },
      data: { tradingAccountId: accountId },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new SeasonTradingAccountLinkIntegrityError(
        'Trading account is already linked to a different participant.',
        { seasonParticipantId: participant.id, tradingAccountId: accountId },
      );
    }

    throw error;
  }

  if (linked.count === 0) {
    const current = await tx.seasonParticipant.findUnique({
      where: { id: participant.id },
      select: { tradingAccountId: true },
    });

    if (!current) {
      throw new SeasonTradingAccountLinkIntegrityError(
        'Participant disappeared during trading account link repair.',
        { seasonParticipantId: participant.id },
      );
    }

    if (current.tradingAccountId !== accountId) {
      throw new SeasonTradingAccountLinkIntegrityError(
        'Participant was linked to an unexpected trading account concurrently.',
        {
          seasonParticipantId: participant.id,
          expectedTradingAccountId: accountId,
          actualTradingAccountId: current.tradingAccountId,
        },
      );
    }

    // A concurrent repair won the guarded update with the same deterministic
    // account — the end state is identical, so treat it as already linked.
    return { tradingAccountId: accountId, action: 'already-linked' };
  }

  return {
    tradingAccountId: accountId,
    // insertedCount distinguishes a real insert from an ignored conflict
    // where a concurrent identical repair created the row first.
    action:
      existing || insertedCount === 0
        ? 'linked-existing-account'
        : 'created-and-linked',
  };
}

/**
 * Read-only variant for dry-run tooling: performs exactly the same lookups
 * and integrity validation as ensureSeasonTradingAccountLink but never
 * writes.
 */
export async function previewSeasonTradingAccountLink(
  client: SeasonTradingAccountLinkReadClient,
  participant: SeasonTradingAccountLinkParticipant,
): Promise<SeasonTradingAccountLinkPreview> {
  if (participant.tradingAccountId) {
    const account = (await client.tradingAccount.findUnique({
      where: { id: participant.tradingAccountId },
      select: LINK_ACCOUNT_SELECT,
    })) as LinkAccountRow | null;

    if (!account) {
      throw new SeasonTradingAccountLinkIntegrityError(
        'Participant references a trading account that does not exist.',
        {
          seasonParticipantId: participant.id,
          tradingAccountId: participant.tradingAccountId,
        },
      );
    }

    validateLinkedAccount(account, participant);

    return { tradingAccountId: account.id, action: 'already-linked' };
  }

  const accountId = deriveSeasonTradingAccountId(participant.id);
  const initialCapitalKrw = toAmountString(participant.initialCapitalKrw);
  const existing = (await client.tradingAccount.findUnique({
    where: { id: accountId },
    select: LINK_ACCOUNT_SELECT,
  })) as LinkAccountRow | null;

  if (existing) {
    validateDeterministicAccount(existing, participant, initialCapitalKrw);

    return {
      tradingAccountId: accountId,
      action: 'would-link-existing-account',
    };
  }

  return { tradingAccountId: accountId, action: 'would-create-and-link' };
}

function validateLinkedAccount(
  account: LinkAccountRow,
  participant: SeasonTradingAccountLinkParticipant,
) {
  if (account.userId !== participant.userId) {
    throw new SeasonTradingAccountLinkIntegrityError(
      'Linked trading account belongs to a different user.',
      {
        seasonParticipantId: participant.id,
        tradingAccountId: account.id,
        participantUserId: participant.userId,
        accountUserId: account.userId,
      },
    );
  }

  if (account.mode !== TradingAccountMode.season) {
    throw new SeasonTradingAccountLinkIntegrityError(
      'Linked trading account is not a season account.',
      {
        seasonParticipantId: participant.id,
        tradingAccountId: account.id,
        accountMode: account.mode,
      },
    );
  }

  if (
    account.seasonParticipant &&
    account.seasonParticipant.id !== participant.id
  ) {
    throw new SeasonTradingAccountLinkIntegrityError(
      'Linked trading account is attached to a different participant.',
      {
        seasonParticipantId: participant.id,
        tradingAccountId: account.id,
        linkedSeasonParticipantId: account.seasonParticipant.id,
      },
    );
  }
}

function validateDeterministicAccount(
  account: LinkAccountRow,
  participant: SeasonTradingAccountLinkParticipant,
  initialCapitalKrw: string,
) {
  validateLinkedAccount(account, participant);

  if (toAmountString(account.initialCapitalKrw) !== initialCapitalKrw) {
    throw new SeasonTradingAccountLinkIntegrityError(
      'Deterministic trading account has a different initial capital.',
      {
        seasonParticipantId: participant.id,
        tradingAccountId: account.id,
        participantInitialCapitalKrw: initialCapitalKrw,
        accountInitialCapitalKrw: toAmountString(account.initialCapitalKrw),
      },
    );
  }

  if (account.openedAt.getTime() !== participant.joinedAt.getTime()) {
    throw new SeasonTradingAccountLinkIntegrityError(
      'Deterministic trading account has a different openedAt.',
      {
        seasonParticipantId: participant.id,
        tradingAccountId: account.id,
        participantJoinedAt: participant.joinedAt.toISOString(),
        accountOpenedAt: account.openedAt.toISOString(),
      },
    );
  }
}

function toAmountString(value: Prisma.Decimal | string): string {
  return typeof value === 'string'
    ? new Prisma.Decimal(value).toFixed(8)
    : value.toFixed(8);
}

function isUniqueConstraintError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'P2002';
}
