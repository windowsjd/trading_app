import type {
  FxExecuteDto,
  FxQuoteDto,
  FxRateDto,
  WalletBalanceDto,
  WalletCurrency,
  WalletsDto,
} from './api';
import { ERROR_CODE } from '../../models/enums/errorCode';
import type { WalletFxViewState } from '../../models/enums/viewState';
import {
  getApiErrorCode,
  isIdempotencyConflictError,
  isQuoteExpiredError,
  isRequoteRequiredError,
} from '../../services/api/errorMapper';
import { formatSourceMetadata } from '../../models/dto/common';

type WalletQueryState = {
  isLoading?: boolean;
  isError?: boolean;
  walletError?: unknown;
  rateError?: unknown;
};

function parseDecimal(value?: string | number | null) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestamp(value?: string | null) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getNowTimestamp(now?: Date | number) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  return Date.now();
}

function displayValue(value?: string | number | boolean | null) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function isUnavailableState(state?: string | null) {
  return (
    state === 'empty' ||
    state === 'blocked' ||
    state === 'unavailable' ||
    state === 'error'
  );
}

export function getWalletByCurrency(
  walletsDto: WalletsDto | null | undefined,
  currencyCode: WalletCurrency,
): WalletBalanceDto | null {
  return (
    walletsDto?.wallets?.find(
      (item) => (item.currencyCode ?? item.currency) === currencyCode,
    ) ?? null
  );
}

export function getWalletBalanceAmount(
  walletsDto: WalletsDto | null | undefined,
  currencyCode: WalletCurrency,
) {
  const wallet = getWalletByCurrency(walletsDto, currencyCode);
  return wallet?.balanceAmount ?? wallet?.balance ?? '0';
}

export function calculateUsdBalanceKrw(
  usdAmount: string | number | null | undefined,
  fxRate: FxRateDto | string | number | null | undefined,
) {
  const usdValue = parseDecimal(usdAmount);
  const rateValue = parseDecimal(
    typeof fxRate === 'object' ? fxRate?.rate : fxRate,
  );

  if (usdValue === null || rateValue === null) return '0';

  return (usdValue * rateValue).toFixed(0);
}

export function isFxQuoteExpired(
  quote?: Pick<FxQuoteDto, 'expiresAt'> | null,
  now?: Date | number,
) {
  const expiresAt = parseTimestamp(quote?.expiresAt);
  if (expiresAt === null) return true;

  return expiresAt <= getNowTimestamp(now);
}

export function getFxQuoteExpiresInSeconds(
  quote?: Pick<FxQuoteDto, 'expiresAt'> | null,
  now?: Date | number,
) {
  const expiresAt = parseTimestamp(quote?.expiresAt);
  if (expiresAt === null) return 0;

  return Math.max(0, Math.floor((expiresAt - getNowTimestamp(now)) / 1000));
}

export function getFxQuoteDisplay(quote: FxQuoteDto) {
  return {
    quoteId: displayValue(quote.quoteId),
    direction: `${quote.fromCurrency} → ${quote.toCurrency}`,
    sourceAmount: displayValue(quote.sourceAmount),
    appliedRate: displayValue(quote.appliedRate),
    grossTargetAmount: displayValue(quote.grossTargetAmount),
    feeRate: displayValue(quote.feeRate),
    feeAmount: `${displayValue(quote.feeAmount)} ${quote.feeCurrency}`,
    netTargetAmount: displayValue(quote.netTargetAmount),
    expiresAt: displayValue(quote.expiresAt),
    maxChangeBps: displayValue(quote.maxChangeBps),
    rateCapturedAt: displayValue(quote.rateCapturedAt),
    rateEffectiveAt: displayValue(quote.rateEffectiveAt),
    rateSource: formatSourceMetadata(quote.rateSource),
  };
}

function getWalletRows(wallets: unknown) {
  if (Array.isArray(wallets)) {
    return wallets
      .map((wallet) => {
        if (!wallet || typeof wallet !== 'object') return null;

        const item = wallet as {
          currencyCode?: string;
          currency?: string;
          balanceAmount?: string;
          balance?: string;
        };
        const currency = item.currencyCode ?? item.currency;
        const balance = item.balanceAmount ?? item.balance;

        if (!currency || !balance) return null;
        return `${currency} ${balance}`;
      })
      .filter((item): item is string => !!item);
  }

  if (wallets && typeof wallets === 'object') {
    return Object.entries(wallets)
      .map(([currency, value]) => {
        if (typeof value === 'string' || typeof value === 'number') {
          return `${currency} ${value}`;
        }

        if (!value || typeof value !== 'object') return null;

        const item = value as {
          balanceAmount?: string;
          balance?: string;
        };
        const balance = item.balanceAmount ?? item.balance;

        return balance ? `${currency} ${balance}` : null;
      })
      .filter((item): item is string => !!item);
  }

  return [];
}

export function getFxExecuteSuccessDisplay(result: FxExecuteDto) {
  return {
    exchangeId: displayValue(result.exchangeId),
    executedAt: displayValue(result.executedAt),
    direction: `${result.fromCurrency} → ${result.toCurrency}`,
    sourceAmount: displayValue(result.sourceAmount),
    grossTargetAmount: displayValue(result.grossTargetAmount),
    netTargetAmount: displayValue(result.netTargetAmount),
    appliedRate: displayValue(result.appliedRate),
    quotedRate: displayValue(result.quotedRate),
    executeRate: displayValue(result.executeRate),
    rateChangeBps: displayValue(result.rateChangeBps),
    fee: `${displayValue(result.feeAmount)} ${result.feeCurrency}`,
    sourceWalletBalanceAfter: displayValue(result.sourceWalletBalanceAfter),
    targetWalletBalanceAfter: displayValue(result.targetWalletBalanceAfter),
    walletRows: getWalletRows(result.wallets),
    rateSource: formatSourceMetadata(result.rateSource),
  };
}

export function isFxRequoteRequiredCode(code?: string | null) {
  return isRequoteRequiredError(code);
}

export function isFxIdempotencyConflictCode(code?: string | null) {
  return isIdempotencyConflictError(code);
}

export function isFxQuoteExpiredCode(code?: string | null) {
  return isQuoteExpiredError(code);
}

export function getWalletViewState(
  walletsDto?: WalletsDto | null,
  fxRateDto?: FxRateDto | null,
  queryState?: WalletQueryState,
): WalletFxViewState {
  if (queryState?.isLoading) return 'wallet_loading';

  const errorCode =
    getApiErrorCode(queryState?.walletError) ??
    getApiErrorCode(queryState?.rateError);

  if (errorCode === ERROR_CODE.SEASON_NOT_JOINED) {
    return 'wallet_not_joined';
  }

  if (queryState?.isError) return 'wallet_error';
  if (!walletsDto || !fxRateDto) return 'wallet_error';

  if (walletsDto.state === 'blocked') return 'wallet_not_joined';

  if (
    isUnavailableState(walletsDto.state) ||
    isUnavailableState(fxRateDto.state) ||
    !fxRateDto.rate
  ) {
    return 'wallet_unavailable';
  }

  return 'wallet_ready';
}
