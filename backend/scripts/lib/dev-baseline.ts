import {
  CurrencyCode,
  ParticipantStatus,
  SeasonStatus,
  TradingAccountMode,
  TradingAccountStatus,
  UserStatus,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
  type PrismaClient,
} from '../../src/generated/prisma/client';
import { ensureSeasonTradingAccountLink } from '../../src/seasons/season-trading-account-link';

/**
 * Non-destructive dev baseline: the always-open development season and the
 * dev user / participant / wallets / initial grant. Shared by
 * `prisma/seed.ts`, `scripts/dev-open-season.ts`, and
 * `scripts/dev-recover-local-data.ts` so there is ONE implementation of the
 * "never reset existing financial data" rules.
 *
 * Hard rules enforced here:
 *  - Wallet balances (balanceAmount, reservedAmount), participant financials
 *    (totalAssetKrw, totalReturnRate, maxDrawdown, ranks, tiers, fill counts,
 *    initialCapitalKrw) and ledger rows are created ONLY when absent and are
 *    never overwritten for an existing row.
 *  - The initial grant is created only when the participant is newly created,
 *    so re-running can never double-grant or reset a balance.
 *  - The dev season is kept active with the wide 2000-2099 window; existing
 *    fee/capital config is not reset on update.
 */

export const DEV_SEASON_ID = 'sea_2026_s1';
export const DEV_SEASON_NAME = 'Season 1';
export const DEV_SEASON_START_AT = new Date('2000-01-01T00:00:00.000Z');
export const DEV_SEASON_END_AT = new Date('2099-12-31T23:59:59.000Z');
export const DEV_SEASON_TRADE_FEE_RATE = '0.001000';
export const DEV_SEASON_FX_FEE_RATE = '0.001000';

export const DEV_USER_ID = 'usr_dev_001';
export const DEV_USER_EMAIL = 'dev1@example.com';
export const DEV_USER_NICKNAME = 'dev_trader_01';
export const DEV_USER_PASSWORD_HASH = 'dev_only_hash';

export const DEV_SEASON_PARTICIPANT_ID = 'sp_dev_001';
export const DEV_TRADING_ACCOUNT_ID = 'ta_dev_001';
export const DEV_KRW_WALLET_ID = 'wal_krw_dev_001';
export const DEV_USD_WALLET_ID = 'wal_usd_dev_001';
export const DEV_INITIAL_GRANT_TX_ID = 'wtx_initial_grant_dev_001';

export const DEV_INITIAL_CAPITAL_KRW = '10000000.00000000';
export const DEV_JOINED_AT = new Date('2026-03-30T00:00:00.000Z');
const ZERO_AMOUNT = '0.00000000';

export type DevSeasonEnsureResult = {
  seasonId: string;
  action: 'created' | 'updated' | 'unchanged' | 'would-create' | 'would-update';
  status: string;
  startAt: string;
  endAt: string;
  otherActiveSeasons: Array<{
    id: string;
    name: string;
    startAt: string;
    endAt: string;
  }>;
};

/**
 * Keep the development season `sea_2026_s1` active and open across 2000-2099.
 * Fee rates and initial capital are set only on create; an existing season's
 * config is never reset (only status/window/name are forced open).
 */
export async function ensureDevSeasonOpen(input: {
  prisma: PrismaClient;
  apply: boolean;
}): Promise<DevSeasonEnsureResult> {
  const { prisma, apply } = input;

  const otherActive = await prisma.season.findMany({
    where: { status: SeasonStatus.active, id: { not: DEV_SEASON_ID } },
    orderBy: { startAt: 'asc' },
    select: { id: true, name: true, startAt: true, endAt: true },
  });

  const existing = await prisma.season.findUnique({
    where: { id: DEV_SEASON_ID },
    select: { id: true, name: true, status: true, startAt: true, endAt: true },
  });

  const needsChange =
    !existing ||
    existing.status !== SeasonStatus.active ||
    existing.name !== DEV_SEASON_NAME ||
    existing.startAt.getTime() !== DEV_SEASON_START_AT.getTime() ||
    existing.endAt.getTime() !== DEV_SEASON_END_AT.getTime();

  let action: DevSeasonEnsureResult['action'];
  if (!existing) {
    action = apply ? 'created' : 'would-create';
  } else if (needsChange) {
    action = apply ? 'updated' : 'would-update';
  } else {
    action = 'unchanged';
  }

  if (apply && needsChange) {
    await prisma.season.upsert({
      where: { id: DEV_SEASON_ID },
      // Only force the "kept open" fields; never reset fee/capital config.
      update: {
        name: DEV_SEASON_NAME,
        status: SeasonStatus.active,
        startAt: DEV_SEASON_START_AT,
        endAt: DEV_SEASON_END_AT,
      },
      create: {
        id: DEV_SEASON_ID,
        name: DEV_SEASON_NAME,
        status: SeasonStatus.active,
        startAt: DEV_SEASON_START_AT,
        endAt: DEV_SEASON_END_AT,
        initialCapitalKrw: DEV_INITIAL_CAPITAL_KRW,
        tradeFeeRate: DEV_SEASON_TRADE_FEE_RATE,
        fxFeeRate: DEV_SEASON_FX_FEE_RATE,
      },
    });
  }

  return {
    seasonId: DEV_SEASON_ID,
    action,
    status: SeasonStatus.active,
    startAt: DEV_SEASON_START_AT.toISOString(),
    endAt: DEV_SEASON_END_AT.toISOString(),
    otherActiveSeasons: otherActive.map((season) => ({
      id: season.id,
      name: season.name,
      startAt: season.startAt.toISOString(),
      endAt: season.endAt.toISOString(),
    })),
  };
}

export type DevBaselineResult = {
  userAction: 'created' | 'exists' | 'would-create';
  participantAction: 'created' | 'exists' | 'would-create';
  seasonParticipantId: string | null;
  walletsCreated: number;
  grantCreated: boolean;
  accountLinkRepaired: boolean;
  notes: string[];
};

/**
 * Ensure the dev user and, when the participant is absent, its participant +
 * KRW/USD wallets + initial KRW grant. When the participant already exists,
 * NOTHING financial is created or modified (no wallet, no grant, no balance).
 */
export async function ensureDevBaselineParticipant(input: {
  prisma: PrismaClient;
  apply: boolean;
}): Promise<DevBaselineResult> {
  const { prisma, apply } = input;
  const notes: string[] = [];

  const existingUser = await prisma.user.findUnique({
    where: { email: DEV_USER_EMAIL },
    select: { id: true },
  });

  let userId = existingUser?.id ?? null;
  let userAction: DevBaselineResult['userAction'];
  if (existingUser) {
    userAction = 'exists';
  } else if (apply) {
    const created = await prisma.user.create({
      data: {
        id: DEV_USER_ID,
        email: DEV_USER_EMAIL,
        passwordHash: DEV_USER_PASSWORD_HASH,
        nickname: DEV_USER_NICKNAME,
        status: UserStatus.active,
      },
      select: { id: true },
    });
    userId = created.id;
    userAction = 'created';
  } else {
    userAction = 'would-create';
  }

  // Look up an existing participant (by natural key when the user exists).
  const existingParticipant = userId
    ? await prisma.seasonParticipant.findUnique({
        where: { seasonId_userId: { seasonId: DEV_SEASON_ID, userId } },
        select: {
          id: true,
          userId: true,
          joinedAt: true,
          participantStatus: true,
          initialCapitalKrw: true,
          tradingAccountId: true,
        },
      })
    : null;

  if (existingParticipant) {
    if (existingParticipant.tradingAccountId) {
      notes.push(
        'Participant already exists; wallets, balances, and ledger left untouched.',
      );
      return {
        userAction,
        participantAction: 'exists',
        seasonParticipantId: existingParticipant.id,
        walletsCreated: 0,
        grantCreated: false,
        accountLinkRepaired: false,
        notes,
      };
    }

    // Deploy-boundary legacy participant without a trading account link:
    // repair ONLY the link (deterministic account id, shared repair rules).
    // Wallets, balances, ledger, and snapshots are never touched here.
    if (!apply) {
      notes.push(
        'Participant exists without a trading account link; apply would repair the link only (no wallet, balance, ledger, or snapshot changes).',
      );
      return {
        userAction,
        participantAction: 'exists',
        seasonParticipantId: existingParticipant.id,
        walletsCreated: 0,
        grantCreated: false,
        accountLinkRepaired: false,
        notes,
      };
    }

    const link = await prisma.$transaction((tx) =>
      ensureSeasonTradingAccountLink(tx, existingParticipant),
    );
    notes.push(
      `Participant existed without a trading account link; repaired link to ${link.tradingAccountId} (${link.action}). Wallets, balances, and ledger left untouched.`,
    );
    return {
      userAction,
      participantAction: 'exists',
      seasonParticipantId: existingParticipant.id,
      walletsCreated: 0,
      grantCreated: false,
      accountLinkRepaired: link.action !== 'already-linked',
      notes,
    };
  }

  if (!apply) {
    notes.push(
      'Participant absent; a dry-run apply would create the trading account, participant, KRW+USD wallets, and the initial KRW grant.',
    );
    return {
      userAction,
      participantAction: 'would-create',
      seasonParticipantId: null,
      walletsCreated: 0,
      grantCreated: false,
      accountLinkRepaired: false,
      notes,
    };
  }

  if (!userId) {
    // Should not happen when apply=true (user was created above), but fail
    // closed rather than fabricate financial rows.
    throw new Error('Dev user id unavailable; refusing to create participant.');
  }

  const resolvedUserId = userId;

  // Create trading account + participant + both wallets + initial grant
  // atomically so a partial failure never leaves a participant without its
  // trading account or funding ledger.
  const result = await prisma.$transaction(async (tx) => {
    const tradingAccount = await tx.tradingAccount.create({
      data: {
        id: DEV_TRADING_ACCOUNT_ID,
        userId: resolvedUserId,
        mode: TradingAccountMode.season,
        status: TradingAccountStatus.active,
        initialCapitalKrw: DEV_INITIAL_CAPITAL_KRW,
        openedAt: DEV_JOINED_AT,
      },
      select: { id: true },
    });

    const participant = await tx.seasonParticipant.create({
      data: {
        id: DEV_SEASON_PARTICIPANT_ID,
        seasonId: DEV_SEASON_ID,
        userId: resolvedUserId,
        joinedAt: DEV_JOINED_AT,
        participantStatus: ParticipantStatus.active,
        initialCapitalKrw: DEV_INITIAL_CAPITAL_KRW,
        totalAssetKrw: DEV_INITIAL_CAPITAL_KRW,
        totalReturnRate: ZERO_AMOUNT,
        maxDrawdown: ZERO_AMOUNT,
        tradingAccountId: tradingAccount.id,
      },
      select: { id: true },
    });

    // Transitional dual-write: financial rows carry BOTH identifiers.
    const krwWallet = await tx.cashWallet.create({
      data: {
        id: DEV_KRW_WALLET_ID,
        seasonParticipantId: participant.id,
        tradingAccountId: tradingAccount.id,
        currencyCode: CurrencyCode.KRW,
        balanceAmount: DEV_INITIAL_CAPITAL_KRW,
      },
      select: { id: true },
    });

    await tx.cashWallet.create({
      data: {
        id: DEV_USD_WALLET_ID,
        seasonParticipantId: participant.id,
        tradingAccountId: tradingAccount.id,
        currencyCode: CurrencyCode.USD,
        balanceAmount: ZERO_AMOUNT,
      },
      select: { id: true },
    });

    await tx.walletTransaction.create({
      data: {
        id: DEV_INITIAL_GRANT_TX_ID,
        seasonParticipantId: participant.id,
        tradingAccountId: tradingAccount.id,
        walletId: krwWallet.id,
        currencyCode: CurrencyCode.KRW,
        direction: WalletTransactionDirection.credit,
        txType: WalletTransactionType.initial_grant,
        referenceType: WalletTransactionReferenceType.season_join,
        referenceId: participant.id,
        amount: DEV_INITIAL_CAPITAL_KRW,
        balanceAfter: DEV_INITIAL_CAPITAL_KRW,
        occurredAt: DEV_JOINED_AT,
      },
      select: { id: true },
    });

    return { participantId: participant.id };
  });

  notes.push(
    'Participant absent; created trading account, participant, KRW+USD wallets, and one initial KRW grant.',
  );

  return {
    userAction,
    participantAction: 'created',
    seasonParticipantId: result.participantId,
    walletsCreated: 2,
    grantCreated: true,
    accountLinkRepaired: false,
    notes,
  };
}
