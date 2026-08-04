import {
  AdRewardClaimStatus,
  Prisma,
  SnapshotReason,
  WalletTransactionReferenceType,
} from '../generated/prisma/client';
import {
  assertGeneralPerformanceStateConsistent,
  generalPerformanceErrorCodes,
  GeneralPerformanceError,
  MONEY_SCALE,
} from './general-performance.policy';

/**
 * Integrity of EVERY general-account history row a chart is built from
 * (작업 6·7 보완 3).
 *
 * WHAT WAS WRONG BEFORE
 * ---------------------
 * The equity history endpoint validated the account's LATEST performance state
 * and then serialised whatever rows the range returned. A damaged historical
 * row therefore rendered as a normal data point: a null performance column came
 * out as `"investmentPnlKrw": null`, and an `after` boundary whose `before`
 * partner had been lost drew a vertical jump that looks exactly like a trading
 * gain. Both are confidently wrong numbers in a chart the user reads as fact.
 *
 * So every returned row is checked, and a damaged range is a structured 500
 * rather than a 200 with holes in it.
 *
 * COST
 * ----
 * All checks are pure except the claim/ledger cross-check, which issues ONE
 * batched query per request for the distinct reference ids in the page — never
 * one per point. The existing range policy is unchanged; no additional history
 * is loaded to run these checks.
 */

const ORIGIN_REASONS: readonly SnapshotReason[] = [
  SnapshotReason.general_account_open,
  SnapshotReason.performance_baseline,
];

const BOUNDARY_REASONS: readonly SnapshotReason[] = [
  SnapshotReason.external_funding_before,
  SnapshotReason.external_funding_after,
];

export type GeneralHistoryEquityRow = {
  id: string;
  seasonParticipantId: string | null;
  tradingAccountId: string | null;
  totalAssetKrw: Prisma.Decimal;
  returnRate: Prisma.Decimal;
  snapshotReason: SnapshotReason;
  cumulativeExternalFundingKrw: Prisma.Decimal | null;
  investmentPnlKrw: Prisma.Decimal | null;
  timeWeightedReturnFactor: Prisma.Decimal | null;
  externalFundingAmountKrw: Prisma.Decimal | null;
  externalFundingReferenceType: WalletTransactionReferenceType | null;
  externalFundingReferenceId: string | null;
  capturedAt: Date;
  createdAt: Date;
};

export type GeneralHistoryDailyRow = {
  id: string;
  seasonParticipantId: string | null;
  tradingAccountId: string | null;
  totalAssetKrw: Prisma.Decimal;
  returnRate: Prisma.Decimal;
  cumulativeExternalFundingKrw: Prisma.Decimal | null;
  investmentPnlKrw: Prisma.Decimal | null;
  timeWeightedReturnFactor: Prisma.Decimal | null;
  capturedAt: Date;
};

function fail(label: string, reason: string): never {
  throw new GeneralPerformanceError(
    generalPerformanceErrorCodes.GENERAL_PERFORMANCE_INTEGRITY,
    `${label} ${reason}`,
  );
}

/**
 * Scope + performance-state checks shared by both history tables.
 * `assertGeneralPerformanceStateConsistent` already covers the non-null triple,
 * the non-negative bounds, `investmentPnl = total - cumulativeFunding`, and
 * `returnRate = (factor - 1) × 100`; this adds the account scope around it.
 */
function assertRowScopeAndState(
  accountId: string,
  label: string,
  row: {
    seasonParticipantId: string | null;
    tradingAccountId: string | null;
    totalAssetKrw: Prisma.Decimal;
    returnRate: Prisma.Decimal;
    cumulativeExternalFundingKrw: Prisma.Decimal | null;
    investmentPnlKrw: Prisma.Decimal | null;
    timeWeightedReturnFactor: Prisma.Decimal | null;
  },
): void {
  if (row.tradingAccountId !== accountId) {
    fail(
      label,
      `belongs to trading account ${row.tradingAccountId ?? 'none'} but was returned for ${accountId}.`,
    );
  }
  if (row.seasonParticipantId !== null) {
    fail(label, 'carries a season participant link on a general account.');
  }

  assertGeneralPerformanceStateConsistent(row, label);
}

/** §4.1 — every EquitySnapshot the general history will return. */
export function assertGeneralEquityHistoryRows(
  accountId: string,
  rows: readonly GeneralHistoryEquityRow[],
): void {
  let originCount = 0;

  for (const row of rows) {
    const label = `General equity snapshot ${row.id}`;
    assertRowScopeAndState(accountId, label, row);

    if (ORIGIN_REASONS.includes(row.snapshotReason)) {
      originCount += 1;
      // An origin is the zero point of the account's performance by
      // definition: nothing has been earned before it exists.
      if (!row.timeWeightedReturnFactor!.equals(1)) {
        fail(label, 'is a performance origin whose factor is not exactly 1.');
      }
      if (!row.returnRate.isZero()) {
        fail(label, 'is a performance origin whose return rate is not 0.');
      }
      continue;
    }

    if (BOUNDARY_REASONS.includes(row.snapshotReason)) {
      if (
        row.externalFundingAmountKrw === null ||
        row.externalFundingReferenceType === null ||
        row.externalFundingReferenceId === null
      ) {
        fail(
          label,
          'is an external-funding boundary with no funding reference.',
        );
      }
      if (row.externalFundingAmountKrw.lte(0)) {
        fail(
          label,
          'is an external-funding boundary with a non-positive amount.',
        );
      }
      continue;
    }

    // Ordinary capture: a scheduled/order-driven point is NOT an inflow, so it
    // must carry no funding reference. One that does would be counted as a
    // boundary by every downstream reader.
    if (
      row.externalFundingAmountKrw !== null ||
      row.externalFundingReferenceType !== null ||
      row.externalFundingReferenceId !== null
    ) {
      fail(
        label,
        'is an ordinary capture that carries external-funding reference columns.',
      );
    }
  }

  // The account-wide "exactly one origin" rule is enforced by
  // `requirePerformanceState`; within one page more than one is already proof
  // of damage without loading the rest of the history.
  if (originCount > 1) {
    fail(
      `General account ${accountId} history`,
      `contains ${originCount} performance origin snapshots; exactly one may exist.`,
    );
  }
}

/** §4.2 — every DailyPortfolioSnapshot the general history will return. */
export function assertGeneralDailyHistoryRows(
  accountId: string,
  rows: readonly GeneralHistoryDailyRow[],
): void {
  for (const row of rows) {
    assertRowScopeAndState(accountId, `General daily snapshot ${row.id}`, row);
  }
}

// ------------------------------------------------------- boundary pairs

type BoundaryClaimClient = Pick<Prisma.TransactionClient, 'adRewardClaim'>;

/**
 * §4.3 — the before/after pairs inside the returned range, plus the ad-reward
 * claims they reference.
 *
 * A pair is written in ONE transaction and both rows share a capturedAt, so a
 * capturedAt-bounded range can never split a healthy pair: seeing one half
 * means the other half was lost, not filtered out.
 *
 * LEGACY CLAIMS ARE NOT GIVEN BOUNDARIES THEY NEVER HAD. Pre-작업 7 unkeyed
 * claims committed before boundaries existed; nothing here requires or
 * fabricates a pair for them. What it does require is that a boundary row which
 * DOES exist is complete and agrees with its claim.
 */
export async function assertGeneralHistoryBoundaryPairs(
  client: BoundaryClaimClient,
  accountId: string,
  rows: readonly GeneralHistoryEquityRow[],
): Promise<void> {
  const boundaries = rows.filter((row) =>
    BOUNDARY_REASONS.includes(row.snapshotReason),
  );
  if (boundaries.length === 0) {
    return;
  }

  const byReference = new Map<string, GeneralHistoryEquityRow[]>();
  for (const row of boundaries) {
    // Non-null by assertGeneralEquityHistoryRows, which runs first.
    const key = `${row.externalFundingReferenceType!}:${row.externalFundingReferenceId!}`;
    byReference.set(key, [...(byReference.get(key) ?? []), row]);
  }

  for (const [key, pair] of byReference) {
    const before = pair.filter(
      (row) => row.snapshotReason === SnapshotReason.external_funding_before,
    );
    const after = pair.filter(
      (row) => row.snapshotReason === SnapshotReason.external_funding_after,
    );

    if (before.length !== 1 || after.length !== 1) {
      fail(
        `General account ${accountId} external-funding boundary ${key}`,
        `must be exactly one before/after pair but has before=${before.length}, after=${after.length}.`,
      );
    }

    const beforeRow = before[0];
    const afterRow = after[0];
    const label = `General account ${accountId} external-funding boundary ${key}`;

    if (
      !afterRow.externalFundingAmountKrw!.equals(
        beforeRow.externalFundingAmountKrw!,
      )
    ) {
      fail(label, 'records a different amount on its before and after rows.');
    }
    // An inflow is money, not performance: the factor, the percent, and the
    // investment PnL must be IDENTICAL across the pair.
    if (
      !beforeRow.timeWeightedReturnFactor!.equals(
        afterRow.timeWeightedReturnFactor!,
      )
    ) {
      fail(
        label,
        'changed the time-weighted return factor; an inflow is not performance.',
      );
    }
    if (!beforeRow.returnRate.equals(afterRow.returnRate)) {
      fail(label, 'changed the return rate; an inflow is not performance.');
    }
    if (!beforeRow.investmentPnlKrw!.equals(afterRow.investmentPnlKrw!)) {
      fail(label, 'changed investment PnL; an inflow is not a gain.');
    }

    const amount = afterRow.externalFundingAmountKrw!;
    if (!afterRow.totalAssetKrw.equals(beforeRow.totalAssetKrw.add(amount))) {
      fail(label, 'has an after total that is not before + the funded amount.');
    }
    if (
      !afterRow.cumulativeExternalFundingKrw!.equals(
        beforeRow.cumulativeExternalFundingKrw!.add(amount),
      )
    ) {
      fail(
        label,
        'has an after cumulative funding that is not before + the funded amount.',
      );
    }
  }

  await assertBoundaryClaims(client, accountId, boundaries);
}

/** ONE batched claim query for the whole page — never one per history point. */
async function assertBoundaryClaims(
  client: BoundaryClaimClient,
  accountId: string,
  boundaries: readonly GeneralHistoryEquityRow[],
): Promise<void> {
  const claimIds = [
    ...new Set(
      boundaries
        .filter(
          (row) =>
            row.externalFundingReferenceType ===
            WalletTransactionReferenceType.ad_reward_claim,
        )
        .map((row) => row.externalFundingReferenceId!),
    ),
  ];
  if (claimIds.length === 0) {
    return;
  }

  const claims = await client.adRewardClaim.findMany({
    where: { id: { in: claimIds } },
    select: {
      id: true,
      status: true,
      tradingAccountId: true,
      rewardAmountKrw: true,
      walletTransactionId: true,
    },
  });
  const claimsById = new Map(claims.map((claim) => [claim.id, claim]));

  for (const row of boundaries) {
    if (
      row.externalFundingReferenceType !==
      WalletTransactionReferenceType.ad_reward_claim
    ) {
      continue;
    }

    const label = `General equity snapshot ${row.id}`;
    const claim = claimsById.get(row.externalFundingReferenceId!);
    if (!claim) {
      fail(label, 'references an ad reward claim that does not exist.');
    }
    if (claim.tradingAccountId !== accountId) {
      fail(
        label,
        'references an ad reward claim on a different trading account.',
      );
    }
    if (claim.status !== AdRewardClaimStatus.granted) {
      fail(
        label,
        `references ad reward claim ${claim.id}, whose status is "${claim.status}" rather than granted; only a granted claim moves money.`,
      );
    }
    if (!claim.walletTransactionId) {
      fail(
        label,
        `references granted ad reward claim ${claim.id}, which has no ledger row.`,
      );
    }
    if (
      !claim.rewardAmountKrw
        .toDecimalPlaces(MONEY_SCALE)
        .equals(row.externalFundingAmountKrw!.toDecimalPlaces(MONEY_SCALE))
    ) {
      fail(
        label,
        `funds ${row.externalFundingAmountKrw!.toFixed(MONEY_SCALE)} but its claim ${claim.id} awards ${claim.rewardAmountKrw.toFixed(MONEY_SCALE)}.`,
      );
    }
  }
}
