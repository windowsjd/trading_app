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
  latestPriceSnapshot?: PortfolioAssetPriceSnapshotInput | null;
};

export type PortfolioAssetPriceSnapshotInput = {
  assetId: string;
  price: DecimalInput;
  currencyCode: CurrencyCode;
  sourceType: AssetPriceSourceType;
  effectiveAt: Date;
  capturedAt: Date;
  createdAt: Date;
};

export type PortfolioFxRateSnapshotInput = {
  baseCurrency: CurrencyCode;
  quoteCurrency: CurrencyCode;
  rate: DecimalInput;
  sourceType: FxRateSourceType;
  effectiveAt: Date;
  capturedAt: Date;
  createdAt: Date;
  approvedByUserId?: string | null;
};

export type PortfolioValuationInput = {
  seasonParticipantId: string;
  initialCapitalKrw: DecimalInput;
  cashWallets: readonly PortfolioCashWalletInput[];
  positions: readonly PortfolioPositionInput[];
  usdKrwSnapshot?: PortfolioFxRateSnapshotInput | null;
  valuationAt: Date;
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
    ? selectUsableUsdKrwRate(input.usdKrwSnapshot, input.valuationAt)
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

  for (const position of input.positions) {
    const quantity = toDecimal(position.quantity, 'position.quantity');
    const averageCost = toDecimal(position.averageCost, 'position.averageCost');
    const realizedPnl = toDecimal(position.realizedPnl, 'position.realizedPnl');
    const hasOpenQuantity = !quantity.eq(0);

    if (!hasOpenQuantity && realizedPnl.eq(0)) {
      continue;
    }

    realizedPnlKrw = realizedPnlKrw.add(
      convertToKrw(realizedPnl, position.currencyCode, usdKrwRate),
    );

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
    );

    const currentPrice = toDecimal(priceSnapshot.price, 'assetPrice.price');
    const positionValue = quantity.mul(currentPrice);
    const unrealizedPnl = currentPrice.sub(averageCost).mul(quantity);
    const conversionRate =
      priceSnapshot.currencyCode === CurrencyCode.USD ? usdKrwRate : null;
    const positionValueKrw = convertToKrw(
      positionValue,
      priceSnapshot.currencyCode,
      conversionRate,
    );

    assetValueKrw = assetValueKrw.add(positionValueKrw);
    switch (position.assetType) {
      case AssetType.domestic_stock:
        domesticStockValueKrw =
          domesticStockValueKrw.add(positionValueKrw);
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
    .div(initialCapitalKrw);

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
  };
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
  const realizedPnl = toDecimal(position.realizedPnl, 'position.realizedPnl');

  return (
    position.currencyCode === CurrencyCode.USD &&
    (!quantity.eq(0) || !realizedPnl.eq(0))
  );
}

function selectUsableUsdKrwRate(
  snapshot: PortfolioFxRateSnapshotInput | null | undefined,
  valuationAt: Date,
): Prisma.Decimal {
  if (!snapshot) {
    throw new PortfolioValuationError(
      'FX_RATE_UNAVAILABLE',
      'USD/KRW FX rate snapshot is unavailable.',
    );
  }

  if (
    snapshot.baseCurrency !== CurrencyCode.USD ||
    snapshot.quoteCurrency !== CurrencyCode.KRW ||
    snapshot.sourceType !== FxRateSourceType.admin_manual ||
    !snapshot.approvedByUserId
  ) {
    throw new PortfolioValuationError(
      'FX_RATE_UNAVAILABLE',
      'No approved admin_manual USD/KRW FX rate snapshot is available.',
    );
  }

  if (snapshot.effectiveAt.getTime() > valuationAt.getTime()) {
    throw new PortfolioValuationError(
      'FX_RATE_UNAVAILABLE',
      'USD/KRW FX rate snapshot is not yet effective.',
    );
  }

  if (
    isFxSnapshotStaleForPortfolioValuation(snapshot.effectiveAt, valuationAt)
  ) {
    throw new PortfolioValuationError(
      'FX_RATE_STALE',
      'USD/KRW FX rate snapshot is stale.',
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
) {
  if (snapshot.assetId !== position.assetId) {
    throw new PortfolioValuationError(
      'ASSET_PRICE_UNAVAILABLE',
      `Asset price snapshot assetId mismatch for asset ${position.assetId}.`,
    );
  }

  if (snapshot.sourceType !== AssetPriceSourceType.admin_manual) {
    throw new PortfolioValuationError(
      'ASSET_PRICE_UNAVAILABLE',
      `Only admin_manual asset price snapshots are eligible for asset ${position.assetId}.`,
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
