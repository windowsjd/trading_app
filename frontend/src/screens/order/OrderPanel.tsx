import { UP_COLOR } from '../../components/charts/candleColors';
import {
  validateOrderQuote,
  OrderQuoteValidationError,
} from '../../features/order/validateOrderQuote';
import { applyTickerMarketState } from '../../features/asset/assetTickerPolicy';
import { getAssetTradingWarning } from '../../features/asset/tradingUx';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  type TextInputProps,
} from 'react-native';
import ActionPressable from '../../components/common/ActionPressable';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';

import {
  getAssetDetail,
  type AssetDetailPriceDto,
} from '../../features/asset/api';
import { isTradableMarketStatus } from '../../features/asset/mapper';
import type { OrderQuoteDto } from '../../features/order/api';
import {
  createTradingAccountOrder,
  getAccountPositionQuantity,
  getTradingAccountPositions,
  getTradingAccountWallets,
  getTradingAccount,
  quoteTradingAccountOrder,
} from '../../features/tradingAccount/api';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import {
  getCapabilityBlockMessage,
  isSeasonNotActiveReason,
} from '../../features/tradingAccount/capabilities';
import {
  resolveAccountBinding,
  shouldResetBoundFlow,
} from '../../features/tradingAccount/accountBinding';
import { getAccountDisplay } from '../../features/tradingAccount/accountDisplay';
import { getIntegrityErrorMessage } from '../../features/tradingAccount/integrityErrors';
import { invalidateAfterOrderCreate } from '../../features/tradingAccount/invalidation';
import {
  captureOrderSuccess,
  clearOrderSuccess,
  EMPTY_ORDER_SUCCESS_STATE,
} from '../../features/order/successState';
import { type WalletCurrency } from '../../features/wallet/api';
import { getWalletAvailableAmount } from '../../features/wallet/mapper';
import {
  isOrderIdempotencyConflictCode,
  isOrderRequoteRequiredCode,
  isOrderSuccess,
} from '../../features/order/mapper';
import { buildWsUrl } from '../../constants/env';
import { useAssetTicker } from '../../features/asset/useAssetTicker';
import { selectDisplayPrice } from '../../features/asset/displayPricePolicy';
import { useStaleRecheck } from '../../features/asset/useStaleRecheck';
import {
  formatPreviewMoney,
  isPreviewPriceAvailable,
  orderPreview,
} from '../../features/tradingAccount/indicativePreview';
import {
  runQuotedAction,
  type QuotedAction,
} from '../../features/tradingAccount/quotedAction';
import { ERROR_CODE } from '../../models/enums/errorCode';
import {
  BLOCKED_REASON_MESSAGE,
  getApiErrorCode,
  getErrorMessageFromCode,
  mapOrderErrorCodeToBlockedReason,
} from '../../services/api/errorMapper';
import { createIdempotencyKey } from '../../utils/idempotency';
import { formatCurrency, formatDisplayDecimal } from '../../utils/format';

import SectionSkeleton from '../../components/states/SectionSkeleton';
import CTAButton from '../../components/common/CTAButton';
import OrderSuccessBottomSheet from './OrderSuccessBottomSheet';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';

type Props = {
  assetId: string;
  accountId: string;
  initialSide?: 'buy' | 'sell';
  enabled?: boolean;
  onReturnToAsset: () => void;
};

/** One flow per asset/account/side. Unmounting invalidates pending callbacks. */
export default function OrderPanel(props: Props) {
  const [side, setSide] = useState(props.initialSide ?? 'buy');
  return (
    <View style={styles.panel} testID="inline-order-panel">
      <View style={styles.tabs}>
        {(['buy', 'sell'] as const).map((value) => (
          <ActionPressable
            key={value}
            testID={
              value === 'buy'
                ? TEST_IDS.assetDetail.buyButton
                : TEST_IDS.assetDetail.sellButton
            }
            accessibilityRole="tab"
            accessibilityLabel={value === 'buy' ? '매수' : '매도'}
            accessibilityState={{ selected: side === value }}
            style={[
              styles.tab,
              side === value &&
                (value === 'buy' ? styles.buyActive : styles.sellActive),
            ]}
            onPress={() => setSide(value)}
          >
            <Text style={[styles.tabText, side === value && styles.activeText]}>
              {value === 'buy' ? '매수' : '매도'}
            </Text>
          </ActionPressable>
        ))}
      </View>
      <OrderForm
        key={`${props.assetId}:${props.accountId}:${side}`}
        {...props}
        side={side}
      />
    </View>
  );
}
const BUY_FEE_BUFFER = 0.002;
const RATIO_BUTTONS = [0.25, 0.5, 0.75, 1] as const;

function isPriceAvailable(price?: AssetDetailPriceDto | null) {
  return price?.state === 'available' && !!price.currentPrice;
}

function getOrderDomainErrorMessage(
  code?: string | null,
  isGeneralAccount = false,
) {
  if (isGeneralAccount && isSeasonNotActiveReason(code)) {
    // Compatibility for an older backend's error copy; this grants no
    // permission and does not participate in asset/capability decisions.
    return '주문을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.';
  }
  const blockedReason = mapOrderErrorCodeToBlockedReason(code);
  return blockedReason
    ? BLOCKED_REASON_MESSAGE[blockedReason]
    : getErrorMessageFromCode(code);
}

function validateQuantity(quantity: string) {
  const trimmed = quantity.trim();

  if (!trimmed) return '수량을 입력해주세요.';
  if (!/^(?:\d+|\d*\.\d{1,6})$/.test(trimmed)) {
    return '수량은 숫자와 소수점 이하 최대 6자리까지 입력할 수 있습니다.';
  }
  if (!Number.isFinite(Number(trimmed))) return '숫자 형식을 확인해주세요.';
  if (Number(trimmed) <= 0) return '0보다 큰 수량을 입력해주세요.';

  return null;
}

function validateLimitPrice(limitPrice: string) {
  const trimmed = limitPrice.trim();

  if (!trimmed) return '지정가 가격을 입력해주세요.';
  if (!/^(?:\d+|\d*\.\d{1,8})$/.test(trimmed)) {
    return '지정가는 숫자와 소수점 이하 최대 8자리까지 입력할 수 있습니다.';
  }
  if (!Number.isFinite(Number(trimmed))) return '숫자 형식을 확인해주세요.';
  if (Number(trimmed) <= 0) return '0보다 큰 지정가를 입력해주세요.';

  return null;
}

function parsePositiveDecimal(value?: string | number | null) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatQuantityInput(value: number) {
  if (!Number.isFinite(value) || value <= 0) return null;

  const roundedDown = Math.floor(value * 1_000_000) / 1_000_000;
  if (roundedDown <= 0) return null;

  return roundedDown.toFixed(6).replace(/\.?0+$/, '');
}

function isWalletCurrency(value?: string | null): value is WalletCurrency {
  return value === 'KRW' || value === 'USD';
}

function getRatioLabel(ratio: (typeof RATIO_BUTTONS)[number]) {
  return `${Math.round(ratio * 100)}%`;
}

export function OrderForm({
  assetId,
  accountId,
  side,
  enabled = true,
  onReturnToAsset,
}: Props & { side: 'buy' | 'sell' }) {
  // accountId is immutable for this mounted form, supplied by the route or
  // the keyed inline panel. Selection changes never retarget a pending request.
  const rootNavigation = useRootNavigation();
  const queryClient = useQueryClient();
  const {
    accounts,
    selectedAccountId,
    isLoading: accountsLoading,
  } = useTradingAccount();

  // Ownership is re-checked against the freshly fetched owned list, and the
  // binding also reports whether the selection has moved on. A route param is
  // user-reachable state; it is not evidence of ownership.
  const binding = resolveAccountBinding({
    boundAccountId: accountId,
    accounts,
    selectedAccountId,
    accountsLoading,
  });
  const routeAccount = binding.state === 'bound' ? binding.account : null;
  const capabilities = binding.state === 'bound' ? binding.capabilities : null;
  const accountDisplay = routeAccount ? getAccountDisplay(routeAccount) : null;
  const accountKnown = binding.state === 'bound';
  const accountChangedAway = shouldResetBoundFlow(binding);

  const [quantity, setQuantity] = useState('');
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market');
  const [limitPrice, setLimitPrice] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [diagnosticError, setDiagnosticError] = useState<unknown>(null);
  const [successState, setSuccessState] = useState(EMPTY_ORDER_SUCCESS_STATE);
  // Create clears the active quote so stale inputs cannot be re-submitted,
  // while this immutable snapshot remains available to the success sheet.
  const successData = successState.data;
  const successQuoteData = successState.quote;
  const [, setQuoteNow] = useState(() => Date.now());
  type OrderRequest = {
    accountId: string;
    epoch: number;
    revision: number;
    seasonUi: boolean;
    payload: Parameters<typeof quoteTradingAccountOrder>[1];
  };
  const orderActionRef = useRef<QuotedAction<
    OrderRequest,
    OrderQuoteDto
  > | null>(null);
  const submitLockRef = useRef(false);
  const quoteRevisionRef = useRef(0);
  const scopeRef = useRef({ key: '', epoch: 0, mounted: true });
  const scopeKey = `${accountId}:${selectedAccountId ?? ''}:${accountKnown}:${assetId}:${side}`;
  if (scopeRef.current.key !== scopeKey) {
    orderActionRef.current = null;
    scopeRef.current = {
      key: scopeKey,
      epoch: scopeRef.current.epoch + 1,
      mounted: true,
    };
  }
  useEffect(() => {
    scopeRef.current.mounted = true;
    return () => {
      scopeRef.current.mounted = false;
    };
  }, []);
  const isActionCurrent = (request: OrderRequest) =>
    scopeRef.current.mounted &&
    request.epoch === scopeRef.current.epoch &&
    request.revision === quoteRevisionRef.current;
  const assetQuery = useQuery({
    queryKey: QUERY_KEYS.asset.detail(assetId),
    queryFn: () => getAssetDetail(assetId),
  });
  const feeQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.detail(accountId),
    queryFn: () => getTradingAccount(accountId),
    enabled: accountKnown && side === 'buy',
  });
  const tickerUrl = useMemo(() => buildWsUrl('/api/v1/ws'), []);
  const { latestTicker } = useAssetTicker({
    assetId,
    wsUrl: tickerUrl ?? '',
    enabled: enabled && side === 'buy' && !!tickerUrl,
  });
  useStaleRecheck(enabled && side === 'buy', () => setQuoteNow(Date.now()));

  const orderMutation = useMutation({
    mutationFn: (action: QuotedAction<OrderRequest, OrderQuoteDto>) =>
      runQuotedAction(action, {
        quote: async (request) => {
          const quote = await quoteTradingAccountOrder(
            request.accountId,
            request.payload,
          );
          validateOrderQuote(request.payload, quote);
          return quote;
        },
        execute: (request, quote, key) =>
          createTradingAccountOrder(request.accountId, {
            assetId: request.payload.assetId,
            side: request.payload.side,
            quantity: quote.quantity,
            quoteId: quote.quoteId,
            idempotencyKey: key,
            ...(request.payload.orderType === 'limit'
              ? { orderType: 'limit' as const, limitPrice: quote.limitPrice }
              : {}),
          }),
        isCurrent: () => isActionCurrent(action.request),
      }),
    retry: false,
    onSettled: () => {
      submitLockRef.current = false;
    },
    onSuccess: async (data, action) => {
      if (!data) return;
      if (isActionCurrent(action.request)) {
        if (isOrderSuccess(data.result)) {
          setSuccessState(captureOrderSuccess(data.result, data.quote));
          setQuantity('');
          setFieldError(null);
          setDomainError(null);
          setDiagnosticError(null);
        } else {
          setDomainError(
            '주문 결과를 확인할 수 없습니다. 주문 내역을 확인해주세요.',
          );
        }
      }
      await invalidateAfterOrderCreate(queryClient, action.request.accountId, {
        seasonUi: action.request.seasonUi,
      });
    },
    onError: (error, action) => {
      if (!isActionCurrent(action.request)) return;
      setDiagnosticError(error);
      const code = getApiErrorCode(error);
      if (error instanceof OrderQuoteValidationError) {
        orderActionRef.current = null;
        setDomainError(error.message);
      } else if (
        isOrderRequoteRequiredCode(code) ||
        isOrderIdempotencyConflictCode(code)
      ) {
        orderActionRef.current = null;
        setDomainError(
          code === ERROR_CODE.QUOTE_EXPIRED
            ? '주문 견적이 만료되었습니다. 주문 버튼을 다시 눌러주세요.'
            : isOrderIdempotencyConflictCode(code)
              ? '이미 처리 중인 요청입니다. 주문 내역을 확인해주세요.'
              : '가격 또는 환율이 변경되어 주문하지 못했습니다. 주문 버튼을 다시 눌러주세요.',
        );
      } else {
        setDomainError(
          getOrderDomainErrorMessage(code, !action.request.seasonUi),
        );
      }
    },
  });
  const orderPending = orderMutation.isPending;

  const positionQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.positions(accountId, {
      assetId,
      limit: 20,
    }),
    queryFn: () =>
      getTradingAccountPositions(accountId, { assetId, limit: 20, offset: 0 }),
    enabled: accountKnown,
  });

  const walletsQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.wallets(accountId),
    queryFn: () => getTradingAccountWallets(accountId),
    enabled: accountKnown && side === 'buy',
  });

  const resetOrderActionState = () => {
    if (submitLockRef.current) return;
    orderActionRef.current = null;
    quoteRevisionRef.current += 1;
    setFieldError(null);
    setDomainError(null);
    setDiagnosticError(null);
    setSuccessState(clearOrderSuccess());
    orderMutation.reset();
  };

  // Standalone OrderScreen keeps its route account and blocks after a switch.
  // Inline panels instead remount with empty inputs for the new selected account.
  useEffect(() => {
    if (!accountChangedAway) return;
    orderActionRef.current = null;
    quoteRevisionRef.current += 1;

    setQuantity('');
    setLimitPrice('');
    setFieldError(null);
    setDomainError(null);
    setDiagnosticError(null);
    setSuccessState(clearOrderSuccess());
  }, [accountChangedAway]);

  const limitPriceInvalidReason = useMemo(
    () => (orderType === 'limit' ? validateLimitPrice(limitPrice) : null),
    [orderType, limitPrice],
  );

  const inputInvalidReason = useMemo(
    () => validateQuantity(quantity) ?? limitPriceInvalidReason,
    [quantity, limitPriceInvalidReason],
  );

  const asset = assetQuery.data?.asset
    ? applyTickerMarketState(
        assetQuery.data.asset,
        latestTicker?.assetId === assetId ? latestTicker : null,
      )
    : undefined;
  const price = asset?.price;
  const displayPrice = selectDisplayPrice({
    latestTicker: latestTicker?.assetId === assetId ? latestTicker : null,
    assetType: asset?.assetType,
    marketStatus: asset?.marketStatus,
    restPrice: price,
    assetPriceCurrency: asset?.priceCurrency,
    assetDisplayPriceDecimals: asset?.displayPriceDecimals,
  });
  const previewPriceAvailable = isPreviewPriceAvailable(
    displayPrice,
    Date.now(),
  );
  const preview =
    side === 'buy' && !inputInvalidReason
      ? orderPreview({
          quantity: quantity.trim(),
          price:
            orderType === 'limit'
              ? limitPrice.trim()
              : previewPriceAvailable
                ? displayPrice.priceLocal
                : null,
          feeRate: !feeQuery.isError
            ? feeQuery.data?.feePolicy?.tradeFeeRate
            : null,
        })
      : null;
  const previewNotice =
    orderType === 'market' && !previewPriceAvailable
      ? '현재 시세가 없거나 오래되어 예상 금액을 표시할 수 없습니다.'
      : feeQuery.isPending
        ? '수수료 정보를 확인하는 중입니다.'
        : '수수료 정보를 불러오지 못해 예상 금액을 표시할 수 없습니다.';
  const positionQuantity = getAccountPositionQuantity(
    positionQuery.data,
    assetId,
  );

  /**
   * Every gate below is about the ROUTE account. General and season accounts
   * share this flow; suspended/closed accounts cannot open new orders; season
   * accounts
   * needs its own season to be active — not merely for some season somewhere to
   * be running.
   */
  const accountBlockedReason = accountsLoading
    ? '계정 정보를 확인하는 중입니다.'
    : !routeAccount
      ? '이 주문 화면의 계정을 찾을 수 없습니다. 계정을 다시 선택해주세요.'
      : getCapabilityBlockMessage(capabilities, capabilities?.tradeBlockReason);

  const assetHardBlockedReason =
    asset && !asset.isActive ? '비활성 자산입니다.' : null;

  const assetWarningReason =
    (asset?.assetType === 'domestic_stock' &&
    asset.marketStatus === 'closed' &&
    asset.tradeBlockedReason?.trim().toUpperCase() === 'MARKET_CLOSED'
      ? null
      : asset
        ? getAssetTradingWarning(asset)
        : null) ??
    (asset &&
    asset.marketStatus !== 'closed' &&
    !isTradableMarketStatus(asset.marketStatus)
      ? '장 상태는 서버 견적에서 최종 확인됩니다.'
      : asset &&
          (side === 'buy' ? !previewPriceAvailable : !isPriceAvailable(price))
        ? '현재 화면 시세가 없어 비율 수량 계산은 제한됩니다. 견적은 서버가 최종 판정합니다.'
        : null);

  const positionUnavailable =
    positionQuery.isError || positionQuery.data?.state === 'unavailable';
  const sellBlockedReason =
    side === 'sell' && positionQuery.isLoading
      ? '보유 수량을 확인하는 중입니다.'
      : side === 'sell' && positionUnavailable
        ? '보유 수량을 확인할 수 없어 매도할 수 없습니다.'
        : side === 'sell' && Number(positionQuantity) <= 0
          ? '보유 수량이 없어 매도할 수 없습니다.'
          : side === 'sell' && Number(quantity) > Number(positionQuantity)
            ? '보유 수량을 초과하여 매도할 수 없습니다.'
            : null;

  const preOrderBlockedReason =
    accountBlockedReason ?? assetHardBlockedReason ?? sellBlockedReason;
  // Empty holdings still block submission. Only the initial input-dependent
  // error is quiet; account/position service failures stay visible.
  const visibleBlockedReason =
    accountBlockedReason ??
    assetHardBlockedReason ??
    (positionQuery.isLoading || positionUnavailable || quantity.trim()
      ? sellBlockedReason
      : null);

  const settlementCurrency = isWalletCurrency(asset?.settlementCurrency)
    ? asset.settlementCurrency
    : null;
  // Ratio buttons and spendable-cash checks use the AVAILABLE balance
  // (balance - reserved): cash locked by open limit orders is not spendable.
  const buyAvailable =
    side === 'buy' && settlementCurrency
      ? getWalletAvailableAmount(walletsQuery.data, settlementCurrency)
      : null;
  const buyAvailableValue = parsePositiveDecimal(buyAvailable);
  const priceValue = parsePositiveDecimal(
    side === 'buy'
      ? previewPriceAvailable
        ? displayPrice.priceLocal
        : null
      : price?.currentPrice,
  );
  const limitPriceValue = parsePositiveDecimal(limitPrice);
  const ratioPriceValue = orderType === 'limit' ? limitPriceValue : priceValue;
  const positionQuantityValue = parsePositiveDecimal(positionQuantity);

  const ratioDisabledReason = useMemo(() => {
    if (accountBlockedReason || assetHardBlockedReason)
      return accountBlockedReason ?? assetHardBlockedReason;

    if (side === 'sell') {
      if (positionQuery.isLoading) return '보유 수량을 확인하는 중입니다.';
      if (positionUnavailable) return '보유 수량을 확인할 수 없습니다.';
      if (!positionQuantityValue) return '보유 수량이 없습니다.';
      return null;
    }

    if (!settlementCurrency) return '결제 통화를 확인할 수 없습니다.';
    if (walletsQuery.isLoading) return '지갑 잔액을 확인하는 중입니다.';
    if (walletsQuery.isError || !walletsQuery.data) {
      return '지갑 잔액을 확인할 수 없습니다.';
    }
    if (!buyAvailableValue) {
      return `${settlementCurrency} 사용 가능 잔액이 없습니다.`;
    }
    if (!ratioPriceValue) {
      return orderType === 'limit'
        ? '지정가를 입력하면 비율 수량을 계산할 수 있습니다.'
        : '현재가가 없어 비율 수량을 계산할 수 없습니다.';
    }

    return null;
  }, [
    buyAvailableValue,
    orderType,
    accountBlockedReason,
    assetHardBlockedReason,
    positionUnavailable,
    positionQuery.isLoading,
    positionQuantityValue,
    ratioPriceValue,
    settlementCurrency,
    side,
    walletsQuery.data,
    walletsQuery.isError,
    walletsQuery.isLoading,
  ]);

  const canExecute =
    !preOrderBlockedReason &&
    !inputInvalidReason &&
    (side === 'sell' || !!preview) &&
    !successData &&
    !orderActionRef.current?.completed;
  const inputErrorMessage =
    fieldError ?? (quantity.trim() ? inputInvalidReason : null);

  const applyQuantityRatio = (ratio: (typeof RATIO_BUTTONS)[number]) => {
    if (submitLockRef.current) return;
    if (ratioDisabledReason) {
      setFieldError(ratioDisabledReason);
      return;
    }

    const nextQuantity =
      side === 'sell'
        ? formatQuantityInput((positionQuantityValue ?? 0) * ratio)
        : formatQuantityInput(
            ((buyAvailableValue ?? 0) * ratio) /
              ((ratioPriceValue ?? 0) * (1 + BUY_FEE_BUFFER)),
          );

    if (!nextQuantity) {
      setFieldError('계산된 수량이 너무 작습니다.');
      return;
    }

    setQuantity(nextQuantity);
    resetOrderActionState();
  };

  const submitOrder = () => {
    if (
      accountChangedAway ||
      submitLockRef.current ||
      orderPending ||
      !canExecute
    )
      return;
    setFieldError(null);
    setDomainError(null);
    setDiagnosticError(null);
    // An uncertain create response retains this exact quote/key for a user
    // retry. It never silently obtains a second executable order.
    orderActionRef.current ??= {
      request: {
        accountId,
        epoch: scopeRef.current.epoch,
        revision: quoteRevisionRef.current,
        seasonUi: capabilities?.isSeason ?? false,
        payload: {
          assetId,
          side,
          quantity: quantity.trim(),
          ...(orderType === 'limit'
            ? { orderType: 'limit', limitPrice: limitPrice.trim() }
            : {}),
        },
      },
      idempotencyKey: createIdempotencyKey('order'),
    };
    submitLockRef.current = true;
    orderMutation.mutate(orderActionRef.current);
  };

  if (assetQuery.isLoading || accountsLoading)
    return <SectionSkeleton lines={5} />;
  if (accountChangedAway || !accountKnown)
    return (
      <View style={styles.group}>
        <Text style={styles.errorText}>
          {accountChangedAway
            ? '선택한 계정이 변경되었습니다.'
            : '주문 계정을 확인할 수 없습니다.'}
        </Text>
        <CTAButton label="종목으로 돌아가기" onPress={onReturnToAsset} />
      </View>
    );
  if (assetQuery.isError || !asset)
    return (
      <View style={styles.group}>
        <Text style={styles.errorText}>주문 정보를 불러오지 못했습니다.</Text>
        <CTAButton
          label="다시 시도"
          onPress={() => void assetQuery.refetch()}
        />
        <AdminDiagnosticPanel error={assetQuery.error} />
      </View>
    );
  const pending = orderPending;
  const integrityMessage =
    getIntegrityErrorMessage(positionQuery.error) ??
    getIntegrityErrorMessage(walletsQuery.error);
  const resetInput = (update: () => void) => {
    if (submitLockRef.current) return;
    update();
    resetOrderActionState();
  };
  return (
    <View style={styles.panel} testID={TEST_IDS.order.screen}>
      {accountDisplay ? (
        <Text style={styles.accountLabel}>
          {accountDisplay.title} · {accountDisplay.statusLabel}
        </Text>
      ) : null}
      <View style={styles.tabs}>
        <ActionPressable
          testID={TEST_IDS.order.typeToggleMarket}
          accessibilityRole="tab"
          accessibilityLabel="시장가"
          accessibilityState={{
            selected: orderType === 'market',
            disabled: pending,
          }}
          disabled={pending}
          style={[styles.typeTab, orderType === 'market' && styles.typeActive]}
          onPress={() => {
            if (orderType !== 'market')
              resetInput(() => {
                setOrderType('market');
                setLimitPrice('');
              });
          }}
        >
          <Text style={styles.typeText}>시장가</Text>
        </ActionPressable>
        <ActionPressable
          testID={TEST_IDS.order.typeToggleLimit}
          accessibilityRole="tab"
          accessibilityLabel="지정가"
          accessibilityState={{
            selected: orderType === 'limit',
            disabled: pending,
          }}
          disabled={pending}
          style={[styles.typeTab, orderType === 'limit' && styles.typeActive]}
          onPress={() => {
            if (orderType !== 'limit') resetInput(() => setOrderType('limit'));
          }}
        >
          <Text style={styles.typeText}>지정가</Text>
        </ActionPressable>
      </View>
      <View style={styles.group}>
        <Text style={styles.label}>가격 ({asset.settlementCurrency})</Text>
        {orderType === 'limit' ? (
          <OrderNumberInput
            testID={TEST_IDS.order.limitPriceInput}
            accessibilityLabel={`지정가 가격 ${asset.settlementCurrency}`}
            editable={!pending}
            style={styles.input}
            value={limitPrice}
            onChangeText={(value) => resetInput(() => setLimitPrice(value))}
            keyboardType="decimal-pad"
            placeholder="지정가 입력"
          />
        ) : (
          <Text style={styles.marketPrice}>시장가</Text>
        )}
      </View>
      <View style={styles.group}>
        <Text style={styles.label}>수량</Text>
        <OrderNumberInput
          testID={TEST_IDS.order.quantityInput}
          accessibilityLabel="주문 수량"
          editable={!pending}
          style={styles.input}
          value={quantity}
          onChangeText={(value) => resetInput(() => setQuantity(value))}
          keyboardType="decimal-pad"
          placeholder="수량 입력"
        />
      </View>
      <View style={styles.ratios}>
        {RATIO_BUTTONS.map((ratio) => (
          <ActionPressable
            key={ratio}
            accessibilityRole="button"
            accessibilityLabel={`주문 가능 수량 ${getRatioLabel(ratio)}`}
            testID={`order-ratio-${Math.round(ratio * 100)}`}
            style={styles.ratioButton}
            disabled={pending}
            accessibilityState={{ disabled: pending }}
            onPress={() => applyQuantityRatio(ratio)}
          >
            <Text style={[styles.ratioText, pending && styles.muted]}>
              {getRatioLabel(ratio)}
            </Text>
          </ActionPressable>
        ))}
      </View>
      <Text style={styles.helper}>
        {side === 'buy'
          ? `주문 가능 ${walletsQuery.isError ? '-' : formatCurrency(buyAvailable, settlementCurrency)} ${settlementCurrency ?? ''}`
          : `보유 ${formatDisplayDecimal(positionQuantity)}`}
      </Text>
      {integrityMessage ? (
        <Text
          testID={TEST_IDS.tradingAccount.integrityError}
          style={styles.errorText}
        >
          {integrityMessage}
        </Text>
      ) : null}
      {visibleBlockedReason ? (
        <Text
          testID={TEST_IDS.tradingAccount.capabilityNotice}
          style={styles.errorText}
        >
          {visibleBlockedReason}
        </Text>
      ) : null}
      {assetWarningReason ? (
        <Text style={styles.warningText}>{assetWarningReason}</Text>
      ) : null}
      {inputErrorMessage ? (
        <Text style={styles.errorText}>{inputErrorMessage}</Text>
      ) : null}
      {domainError ? (
        <>
          <Text accessibilityLiveRegion="polite" style={styles.errorText}>
            {domainError}
          </Text>
          <AdminDiagnosticPanel error={diagnosticError} />
        </>
      ) : null}
      {asset.settlementCurrency === 'USD' &&
      domainError ===
        getOrderDomainErrorMessage(ERROR_CODE.INSUFFICIENT_BALANCE) ? (
        <CTAButton
          label="USD 환전하러 가기"
          onPress={() =>
            rootNavigation.navigate('MainTabs', {
              screen: 'HomeTab',
              params: { screen: 'WalletFx' },
            })
          }
        />
      ) : null}
      {side === 'buy' ? (
        <>
          {!inputInvalidReason ? (
            <View style={styles.preview} testID="order-indicative-preview">
              {preview ? (
                <>
                  <Amount
                    label="예상 주문금액"
                    value={formatPreviewMoney(
                      preview.grossAmount,
                      asset.settlementCurrency,
                    )}
                  />
                  <Amount
                    label="예상 수수료"
                    value={formatPreviewMoney(
                      preview.feeAmount,
                      asset.settlementCurrency,
                    )}
                  />
                  <Amount
                    label={
                      orderType === 'limit' ? '예상 예약금액' : '예상 결제금액'
                    }
                    value={formatPreviewMoney(
                      preview.totalAmount,
                      asset.settlementCurrency,
                    )}
                  />
                </>
              ) : (
                <>
                  <Text style={styles.warningText}>{previewNotice}</Text>
                  {orderType === 'market' && !previewPriceAvailable ? (
                    <CTAButton
                      label="시세 다시 불러오기"
                      onPress={() => void assetQuery.refetch()}
                    />
                  ) : null}
                  {feeQuery.isError ? (
                    <CTAButton
                      label="수수료 다시 불러오기"
                      onPress={() => void feeQuery.refetch()}
                    />
                  ) : null}
                </>
              )}
            </View>
          ) : null}
        </>
      ) : null}
      <CTAButton
        testID={TEST_IDS.order.executeSubmit}
        label={side === 'buy' ? '매수' : '매도'}
        style={side === 'buy' ? styles.buyActive : styles.sellActive}
        state={pending ? 'loading' : canExecute ? 'enabled' : 'disabled'}
        onPress={submitOrder}
      />
      <OrderSuccessBottomSheet
        visible={!!successData}
        payload={successData}
        quote={successQuoteData}
        displayPriceDecimals={asset.displayPriceDecimals}
        onClose={() => setSuccessState(clearOrderSuccess())}
        onGoAssetDetail={() => {
          setSuccessState(clearOrderSuccess());
          onReturnToAsset();
        }}
        onGoOrderHistory={() => {
          setSuccessState(clearOrderSuccess());
          rootNavigation.navigate('MainTabs', {
            screen: 'RecordTab',
            params: { screen: 'RecordSeasonList' },
          });
        }}
        onGoHome={() => {
          setSuccessState(clearOrderSuccess());
          rootNavigation.reset({
            index: 0,
            routes: [
              {
                name: 'MainTabs',
                params: { screen: 'HomeTab', params: { screen: 'Home' } },
              },
            ],
          });
        }}
      />
    </View>
  );
}

/** Keep native caret scrolling, with the entire raw value visible underneath
 * whenever it is wider than this column. No truncation or input formatting. */
function OrderNumberInput(props: TextInputProps) {
  const { fontScale } = useWindowDimensions();
  const [width, setWidth] = useState(0);
  const showFullValue =
    width > 0 && (props.value?.length ?? 0) * 9.6 * fontScale > width - 16;
  return (
    <View
      style={styles.group}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <TextInput {...props} />
      {showFullValue ? (
        <Text
          selectable
          style={styles.helper}
          testID={`${props.testID}-full-value`}
          accessibilityLabel={`${props.accessibilityLabel}, 전체 입력값 ${props.value}`}
        >
          {props.value}
        </Text>
      ) : null}
    </View>
  );
}

function Amount({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.group}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.amount}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { minWidth: 0, gap: 12 },
  tabs: { flexDirection: 'row', gap: 4, minWidth: 0 },
  tab: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: '#f1f3f5',
    justifyContent: 'center',
    alignItems: 'center',
  },
  tabText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#555',
    textAlign: 'center',
  },
  buyActive: { backgroundColor: UP_COLOR },
  sellActive: { backgroundColor: '#315f9b' },
  activeText: { color: '#fff' },
  typeTab: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    paddingVertical: 8,
    paddingHorizontal: 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 2,
    borderColor: 'transparent',
  },
  typeActive: { borderColor: '#202a35', backgroundColor: '#f4f6f8' },
  typeText: {
    fontSize: 13,
    color: '#202a35',
    fontWeight: '600',
    textAlign: 'center',
  },
  accountLabel: { fontSize: 11, color: '#697583' },
  group: { gap: 4, minWidth: 0 },
  label: { fontSize: 12, color: '#697583' },
  helper: { fontSize: 12, color: '#536170' },
  amount: {
    fontSize: 14,
    fontWeight: '600',
    color: '#202a35',
    fontVariant: ['tabular-nums'],
  },
  marketPrice: {
    fontSize: 14,
    color: '#697583',
    backgroundColor: '#f4f6f8',
    borderRadius: 8,
    padding: 12,
    minHeight: 46,
  },
  input: {
    width: '100%',
    minWidth: 0,
    minHeight: 46,
    borderWidth: 1,
    borderColor: '#d9dfe5',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 12,
    fontSize: 16,
    color: '#202a35',
    backgroundColor: '#fff',
  },
  ratios: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  ratioButton: {
    flexGrow: 1,
    flexBasis: '44%',
    minWidth: 0,
    minHeight: 44,
    borderWidth: 1,
    borderColor: '#dfe4e9',
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ratioText: { fontSize: 12, fontWeight: '600', color: '#354251' },
  muted: { color: '#9ba3ab' },
  preview: {
    gap: 8,
    borderTopWidth: 1,
    borderColor: '#edf0f3',
    paddingTop: 10,
  },
  errorText: { fontSize: 12, color: '#b32d2d' },
  warningText: { fontSize: 12, color: '#7a4b00' },
});
