import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  Prisma,
} from '../generated/prisma/client';
import {
  formatDecimalScale,
  formatMoneyScale8,
  returnRateScale,
} from '../fx/fx-decimal-policy';
import { fxExecuteSnapshotFreshnessThresholdMs } from '../fx/fx-execute-snapshot-policy';
import {
  isProviderWorkflowAllowed,
  type ProviderEligibleWorkflow,
  type SourceDecision,
} from '../providers/source-eligibility.policy';

type DecimalInput = string | Prisma.Decimal;

export type PortfolioCashWalletInput = {
  currencyCode: CurrencyCode;
  balanceAmount: DecimalInput;
};

export type PortfolioPositionInput = {
  assetId: string;
  assetType: AssetType;
  quantity: DecimalInput;
  averageCost: DecimalInput;
  currencyCode: CurrencyCode;
  realizedPnl: DecimalInput;
  realizedPnlKrw?: DecimalInput;
  latestPriceSnapshot?: PortfolioAssetPriceSnapshotInput | null;
};

export type PortfolioAssetPriceSnapshotInput = {
  id?: string;
  assetId: string;
  price: DecimalInput;
  priceKrw?: DecimalInput | null;
  currencyCode: CurrencyCode;
  sourceType: AssetPriceSourceType;
  sourceName?: string | null;
  effectiveAt: Date;
  capturedAt: Date;
  createdAt: Date;
  sourceDecision?: SourceDecision;
};

export type PortfolioFxRateSnapshotInput = {
  id?: string;
  baseCurrency: CurrencyCode;
  quoteCurrency: CurrencyCode;
  rate: DecimalInput;
  sourceType: FxRateSourceType;
  sourceName?: string | null;
  effectiveAt: Date;
  capturedAt: Date;
  createdAt: Date;
  approvedByUserId?: string | null;
  sourceDecision?: SourceDecision;
};

export type PortfolioSourceSummary = {
  providerApiUsed: boolean;
  adminManualUsed: boolean;
  fallbackUsed: boolean;
  fallbackReasons: string[];
  rejectedProviderReasons: string[];
};

export type PortfolioValuationInput = {
  seasonParticipantId: string;
  initialCapitalKrw: DecimalInput;
  cashWallets: readonly PortfolioCashWalletInput[];
  positions: readonly PortfolioPositionInput[];
  usdKrwSnapshot?: PortfolioFxRateSnapshotInput | null;
  valuationAt: Date;
  sourceEligibilityWorkflow?: ProviderEligibleWorkflow;
  enforceAdminManualFxFreshness?: boolean;
};

export type PortfolioValuationResult = {
  seasonParticipantId: string;
  totalAssetKrw: string;
  returnRate: string;
  krwCash: string;
  usdCashKrw: string;
  assetValueKrw: string;
  domesticStockValueKrw: string;
  usStockValueKrw: string;
  cryptoValueKrw: string;
  realizedPnlKrw: string;
  unrealizedPnlKrw: string;
  valuationAt: Date;
  sourceSummary: PortfolioSourceSummary;
  assetPriceSourceDecisions: Array<{
    assetId: string;
    sourceDecision: SourceDecision;
  }>;
  fxRateSourceDecision: SourceDecision | null;
};

export class PortfolioValuationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function calculatePortfolioValuation(
  input: PortfolioValuationInput,
): PortfolioValuationResult {
  const initialCapitalKrw = toDecimal(
    input.initialCapitalKrw,
    'initialCapitalKrw',
  );

  if (initialCapitalKrw.lte(0)) {
    throw new PortfolioValuationError(
      'INVALID_INITIAL_CAPITAL',
      'initialCapitalKrw must be greater than 0.',
    );
  }

  assertRequiredWallets(input.cashWallets);

  const krwCash = sumWallets(input.cashWallets, CurrencyCode.KRW);
  const usdCash = sumWallets(input.cashWallets, CurrencyCode.USD);
  const needsUsdConversion =
    !usdCash.eq(0) || input.positions.some(positionNeedsUsdConversion);
  const usdKrwRate = needsUsdConversion
    ? selectUsableUsdKrwRate(
        input.usdKrwSnapshot,
        input.valuationAt,
        input.sourceEligibilityWorkflow,
        input.enforceAdminManualFxFreshness,
      )
    : null;

  let usdCashKrw = new Prisma.Decimal(0);
  if (!usdCash.eq(0) && usdKrwRate) {
    usdCashKrw = usdCash.mul(usdKrwRate);
  }

  let assetValueKrw = new Prisma.Decimal(0);
  let domesticStockValueKrw = new Prisma.Decimal(0);
  let usStockValueKrw = new Prisma.Decimal(0);
  let cryptoValueKrw = new Prisma.Decimal(0);
  let realizedPnlKrw = new Prisma.Decimal(0);
  let unrealizedPnlKrw = new Prisma.Decimal(0);
  const assetPriceSourceDecisions: Array<{
    assetId: string;
    sourceDecision: SourceDecision;
  }> = [];

  for (const position of input.positions) {
    const quantity = toDecimal(position.quantity, 'position.quantity');
    const averageCost = toDecimal(position.averageCost, 'position.averageCost');
    const realizedPnlKrwDelta = toDecimal(
      position.realizedPnlKrw ?? '0',
      'position.realizedPnlKrw',
    );
    const hasOpenQuantity = !quantity.eq(0);

    if (!hasOpenQuantity && realizedPnlKrwDelta.eq(0)) {
      continue;
    }

    realizedPnlKrw = realizedPnlKrw.add(realizedPnlKrwDelta);

    if (!hasOpenQuantity) {
      continue;
    }

    const priceSnapshot = position.latestPriceSnapshot;
    if (!priceSnapshot) {
      throw new PortfolioValuationError(
        'ASSET_PRICE_UNAVAILABLE',
        `Asset price snapshot is unavailable for asset ${position.assetId}.`,
      );
    }

    assertEligibleAssetPriceSnapshot(
      priceSnapshot,
      position,
      input.valuationAt,
      input.sourceEligibilityWorkflow,
    );
    if (priceSnapshot.sourceDecision) {
      assetPriceSourceDecisions.push({
        assetId: position.assetId,
        sourceDecision: priceSnapshot.sourceDecision,
      });
    }

    const currentPrice = toDecimal(priceSnapshot.price, 'assetPrice.price');
    const positionValue = quantity.mul(currentPrice);
    const unrealizedPnl = currentPrice.sub(averageCost).mul(quantity);
    const conversionRate =
      priceSnapshot.currencyCode === CurrencyCode.USD ? usdKrwRate : null;
    const positionValueKrw = priceSnapshot.priceKrw
      ? quantity.mul(toDecimal(priceSnapshot.priceKrw, 'assetPrice.priceKrw'))
      : convertToKrw(
          positionValue,
          priceSnapshot.currencyCode,
          conversionRate,
        );

    assetValueKrw = assetValueKrw.add(positionValueKrw);
    switch (position.assetType) {
      case AssetType.domestic_stock:
        domesticStockValueKrw = domesticStockValueKrw.add(positionValueKrw);
        break;
      case AssetType.us_stock:
        usStockValueKrw = usStockValueKrw.add(positionValueKrw);
        break;
      case AssetType.crypto:
        cryptoValueKrw = cryptoValueKrw.add(positionValueKrw);
        break;
    }
    unrealizedPnlKrw = unrealizedPnlKrw.add(
      convertToKrw(unrealizedPnl, position.currencyCode, usdKrwRate),
    );
  }

  const totalAssetKrw = krwCash.add(usdCashKrw).add(assetValueKrw);
  const returnRate = totalAssetKrw
    .sub(initialCapitalKrw)
    .div(initialCapitalKrw)
    .mul(100);

  return {
    seasonParticipantId: input.seasonParticipantId,
    totalAssetKrw: formatMoneyScale8(totalAssetKrw),
    returnRate: formatDecimalScale(returnRate, returnRateScale),
    krwCash: formatMoneyScale8(krwCash),
    usdCashKrw: formatMoneyScale8(usdCashKrw),
    assetValueKrw: formatMoneyScale8(assetValueKrw),
    domesticStockValueKrw: formatMoneyScale8(domesticStockValueKrw),
    usStockValueKrw: formatMoneyScale8(usStockValueKrw),
    cryptoValueKrw: formatMoneyScale8(cryptoValueKrw),
    realizedPnlKrw: formatMoneyScale8(realizedPnlKrw),
    unrealizedPnlKrw: formatMoneyScale8(unrealizedPnlKrw),
    valuationAt: input.valuationAt,
    sourceSummary: buildPortfolioSourceSummary([
      ...assetPriceSourceDecisions.map((source) => source.sourceDecision),
      ...(input.usdKrwSnapshot?.sourceDecision
        ? [input.usdKrwSnapshot.sourceDecision]
        : []),
    ]),
    assetPriceSourceDecisions,
    fxRateSourceDecision: input.usdKrwSnapshot?.sourceDecision ?? null,
  };
}

function buildPortfolioSourceSummary(
  decisions: readonly SourceDecision[],
): PortfolioSourceSummary {
  return {
    providerApiUsed: decisions.some(
      (decision) => decision.selectedSourceType === 'provider_api',
    ),
    adminManualUsed: decisions.some(
      (decision) => decision.selectedSourceType === 'admin_manual',
    ),
    fallbackUsed: decisions.some((decision) => decision.fallbackUsed),
    fallbackReasons: uniqueNonNull(
      decisions.map((decision) => decision.fallbackReason),
    ),
    rejectedProviderReasons: uniqueNonNull(
      decisions.map((decision) => decision.rejectedProviderReason),
    ),
  };
}

function uniqueNonNull(values: readonly (string | null)[]): string[] {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}

export function isFxSnapshotStaleForPortfolioValuation(
  effectiveAt: Date,
  valuationAt: Date,
): boolean {
  return (
    valuationAt.getTime() - effectiveAt.getTime() >
    fxExecuteSnapshotFreshnessThresholdMs
  );
}

function assertRequiredWallets(wallets: readonly PortfolioCashWalletInput[]) {
  const hasKrwWallet = wallets.some(
    (wallet) => wallet.currencyCode === CurrencyCode.KRW,
  );
  const hasUsdWallet = wallets.some(
    (wallet) => wallet.currencyCode === CurrencyCode.USD,
  );

  if (!hasKrwWallet || !hasUsdWallet) {
    throw new PortfolioValuationError(
      'CASH_WALLET_UNAVAILABLE',
      'KRW and USD cash wallets are required for portfolio valuation.',
    );
  }
}

function sumWallets(
  wallets: readonly PortfolioCashWalletInput[],
  currencyCode: CurrencyCode,
): Prisma.Decimal {
  return wallets
    .filter((wallet) => wallet.currencyCode === currencyCode)
    .reduce(
      (sum, wallet) =>
        sum.add(toDecimal(wallet.balanceAmount, 'balanceAmount')),
      new Prisma.Decimal(0),
    );
}

function positionNeedsUsdConversion(position: PortfolioPositionInput): boolean {
  const quantity = toDecimal(position.quantity, 'position.quantity');

  return position.currencyCode === CurrencyCode.USD && !quantity.eq(0);
}

function selectUsableUsdKrwRate(
  snapshot: PortfolioFxRateSnapshotInput | null | undefined,
  valuationAt: Date,
  sourceEligibilityWorkflow?: ProviderEligibleWorkflow,
  enforceAdminManualFxFreshness = true,
): Prisma.Decimal {
  if (!snapshot) {
    throw new PortfolioValuationError(
      'FX_RATE_UNAVAILABLE',
      'USD/KRW FX rate snapshot is unavailable.',
    );
  }

  if (
    snapshot.baseCurrency !== CurrencyCode.USD ||
    snapshot.quoteCurrency !== CurrencyCode.KRW
  ) {
    throw new PortfolioValuationError(
      'FX_RATE_UNAVAILABLE',
      'No eligible USD/KRW FX rate snapshot is available.',
    );
  }

  if (snapshot.sourceType === FxRateSourceType.admin_manual) {
    if (!snapshot.approvedByUserId) {
      throw new PortfolioValuationError(
        'FX_RATE_UNAVAILABLE',
        'No approved admin_manual USD/KRW FX rate snapshot is available.',
      );
    }

    if (
      enforceAdminManualFxFreshness &&
      isFxSnapshotStaleForPortfolioValuation(snapshot.effectiveAt, valuationAt)
    ) {
      throw new PortfolioValuationError(
        'FX_RATE_STALE',
        'USD/KRW FX rate snapshot is stale.',
      );
    }
  } else if (
    snapshot.sourceType !== FxRateSourceType.provider_api ||
    !sourceEligibilityWorkflow ||
    !isProviderWorkflowAllowed(sourceEligibilityWorkflow)
  ) {
    throw new PortfolioValuationError(
      'FX_RATE_UNAVAILABLE',
      'No eligible USD/KRW FX rate snapshot is available.',
    );
  }

  if (snapshot.effectiveAt.getTime() > valuationAt.getTime()) {
    throw new PortfolioValuationError(
      'FX_RATE_UNAVAILABLE',
      'USD/KRW FX rate snapshot is not yet effective.',
    );
  }

  const rate = toDecimal(snapshot.rate, 'fxRate.rate');
  if (rate.lte(0)) {
    throw new PortfolioValuationError(
      'FX_RATE_UNAVAILABLE',
      'USD/KRW FX rate must be greater than 0.',
    );
  }

  return rate;
}

function assertEligibleAssetPriceSnapshot(
  snapshot: PortfolioAssetPriceSnapshotInput,
  position: PortfolioPositionInput,
  valuationAt: Date,
  sourceEligibilityWorkflow?: ProviderEligibleWorkflow,
) {
  if (snapshot.assetId !== position.assetId) {
    throw new PortfolioValuationError(
      'ASSET_PRICE_UNAVAILABLE',
      `Asset price snapshot assetId mismatch for asset ${position.assetId}.`,
    );
  }

  if (
    snapshot.sourceType !== AssetPriceSourceType.admin_manual &&
    (snapshot.sourceType !== AssetPriceSourceType.provider_api ||
      !sourceEligibilityWorkflow ||
      !isProviderWorkflowAllowed(sourceEligibilityWorkflow))
  ) {
    throw new PortfolioValuationError(
      'ASSET_PRICE_UNAVAILABLE',
      `Only eligible asset price snapshots are allowed for asset ${position.assetId}.`,
    );
  }

  if (snapshot.effectiveAt.getTime() > valuationAt.getTime()) {
    throw new PortfolioValuationError(
      'ASSET_PRICE_UNAVAILABLE',
      `Asset price snapshot is not yet effective for asset ${position.assetId}.`,
    );
  }

  if (snapshot.currencyCode !== position.currencyCode) {
    throw new PortfolioValuationError(
      'ASSET_PRICE_UNAVAILABLE',
      `Asset price currency mismatch for asset ${position.assetId}.`,
    );
  }

  const price = toDecimal(snapshot.price, 'assetPrice.price');
  if (price.lte(0)) {
    throw new PortfolioValuationError(
      'ASSET_PRICE_UNAVAILABLE',
      `Asset price must be greater than 0 for asset ${position.assetId}.`,
    );
  }
}

function convertToKrw(
  amount: Prisma.Decimal,
  currencyCode: CurrencyCode,
  usdKrwRate: Prisma.Decimal | null,
): Prisma.Decimal {
  if (currencyCode === CurrencyCode.KRW) {
    return amount;
  }

  if (!usdKrwRate) {
    throw new PortfolioValuationError(
      'FX_RATE_UNAVAILABLE',
      'USD/KRW FX rate snapshot is required for USD conversion.',
    );
  }

  return amount.mul(usdKrwRate);
}

function toDecimal(value: DecimalInput, fieldName: string): Prisma.Decimal {
  try {
    const decimal =
      typeof value === 'string' ? new Prisma.Decimal(value.trim()) : value;

    if (!(decimal instanceof Prisma.Decimal) || !decimal.isFinite()) {
      throw new Error();
    }

    return decimal;
  } catch {
    throw new PortfolioValuationError(
      'INVALID_DECIMAL',
      `${fieldName} must be a finite decimal.`,
    );
  }
}
