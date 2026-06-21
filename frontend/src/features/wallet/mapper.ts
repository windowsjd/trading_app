import type {
  FxRateDto,
  WalletBalanceDto,
  WalletCurrency,
  WalletsDto,
} from './api';
import { ERROR_CODE } from '../../models/enums/errorCode';
import type { WalletFxViewState } from '../../models/enums/viewState';
import { getApiErrorCode } from '../../services/api/errorMapper';

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
