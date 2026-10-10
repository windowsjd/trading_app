import { semantic } from '../../theme/tokens';
import { getProtections } from '../../features/conditional/api';
import { ProtectionEditor, draftLegs, emptyProtection, protectionInputError } from '../../features/conditional/ProtectionEditor';
import Decimal from 'decimal.js';
import { BUY_COLOR, SELL_COLOR } from '../../features/order/sideColors';
import OrderSideSegment, { type OrderSide } from './OrderSideSegment';
import OrderTypeSelect from './OrderTypeSelect';
import {
  validateOrderQuote,
  OrderQuoteValidationError,
} from '../../features/order/validateOrderQuote';
import { applyTickerMarketState } from '../../features/asset/assetTickerPolicy';
import { getAssetTradingWarning } from '../../features/asset/tradingUx';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Platform,
  View,
  Text,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  type TextInputProps,
} from '../../theme/native';
import { useReducedMotion } from '../../theme/useReducedMotion';
import ActionPressable from '../../components/common/ActionPressable';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';

import { getAssetDetail } from '../../features/asset/api';
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
import { getIntegrityErrorMessage } from '../../features/tradingAccount/integrityErrors';
import ErrorNotice from '../../components/states/ErrorNotice';
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
  amountBuyPreview,
  buyAmountAtRatio,
  indicativeBuyQuantity,
  isPositiveInput,
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
  getApiErrorInfo,
  requestFailureFacts,
  getErrorMessageFromCode,
  mapOrderErrorCodeToBlockedReason,
} from '../../services/api/errorMapper';
import { createIdempotencyKey } from '../../utils/idempotency';
import { formatCurrency, formatDisplayDecimal } from '../../utils/format';

import SectionSkeleton from '../../components/states/SectionSkeleton';
import CTAButton from '../../components/common/CTAButton';
import OrderSuccessBottomSheet from './OrderSuccessBottomSheet';
import QuantityRatioSlider from './QuantityRatioSlider';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import { isTradingAccountScopeMismatchError } from '../../features/tradingAccount/accountScope';
import type { RuntimeFacts } from '../../services/ws/runtimeDiagnostics';

type Props = {
  assetId: string;
  accountId: string;
  initialSide?: 'buy' | 'sell';
  enabled?: boolean;
  showAssetPriceDiagnostic?: boolean;
  onReturnToAsset: () => void;
  onInputFocus?: (input: View | null) => void;
  onInputBlur?: () => void;
  submitRef?: React.RefObject<View | null>;
  onAttachedProtectionVisibilityChange?: (visible: boolean) => void;
  /** Reports user side changes; the panel keeps owning the side. */
  onSideChange?: (side: OrderSide) => void;
};

/** One flow per asset/account/side. Unmounting invalidates pending callbacks. */
export default function OrderPanel({ onSideChange, ...props }: Props) {
  const [side, setSide] = useState<OrderSide>(props.initialSide ?? 'buy');
  const reduced = useReducedMotion();
  // The new side's form mounts at once (fresh inputs and quote state); only
  // its appearance settles with a short fade.
  const formOpacity = useRef(new Animated.Value(1)).current;
  const changeSide = (next: OrderSide) => {
    setSide(next);
    onSideChange?.(next);
    if (reduced) return;
    formOpacity.setValue(0.35);
    Animated.timing(formOpacity, {
      toValue: 1,
      duration: 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: Platform.OS !== 'web',
      isInteraction: false,
    }).start();
  };
  return (
    <View style={styles.panel} testID="inline-order-panel">
      <OrderSideSegment side={side} onChange={changeSide} />
      <Animated.View style={[styles.formFade, { opacity: formOpacity }]}>
        <OrderForm
          key={`${props.assetId}:${props.accountId}:${side}`}
          {...props}
          side={side}
        />
      </Animated.View>
    </View>
  );
}
const BUY_FEE_BUFFER = 0.002;
const RATIO_BUTTONS = [0.25, 0.5, 0.75, 1] as const;

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

function validateQuantity(orderInput: string) {
  const trimmed = orderInput.trim();

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
  showAssetPriceDiagnostic = true,
  onReturnToAsset,
  onInputFocus,
  onInputBlur,
  submitRef,
  onAttachedProtectionVisibilityChange,
}: Props & { side: 'buy' | 'sell' }) {
  // accountId is immutable for this mounted form, supplied by the route or
  // the keyed inline panel. Selection changes never retarget a pending request.
  const rootNavigation = useRootNavigation();
  const queryClient = useQueryClient();
  const {
    accounts,
    selectedAccountId,
    isLoading: accountsLoading,
    isError: accountsError,
    error: accountsFailure,
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
  const accountKnown = binding.state === 'bound';
  const accountChangedAway = shouldResetBoundFlow(binding);

  const [orderInput, setOrderInput] = useState('');
  const [quotedPreview, setQuotedPreview] = useState<OrderQuoteDto | null>(
    null,
  );
  const [chosenRatio, setChosenRatio] = useState<number | null>(null);
  const { fontScale } = useWindowDimensions();
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market');
  const [limitPrice, setLimitPrice] = useState('');
  const [protectionDraft, setProtectionDraft] = useState(emptyProtection);
  const protectionQuery = useQuery({ queryKey: QUERY_KEYS.tradingAccount.protections.list(accountId, 'spot', assetId), queryFn: ({ signal }) => getProtections(accountId, 'spot', assetId, false, signal), enabled: accountKnown && side === 'buy' && orderType === 'limit', retry: false });
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [diagnosticRuntime, setDiagnosticRuntime] = useState<RuntimeFacts | null>(null);
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
    attachedProtection?: import('../../features/conditional/api').ProtectionLeg[];
  };
  const orderActionRef = useRef<QuotedAction<
    OrderRequest,
    OrderQuoteDto
  > | null>(null);
  const submitLockRef = useRef(false);
  const attachedPermission = useRef(false);
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
  const { latestTicker, runtime: tickerRuntime } = useAssetTicker({
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
          if (isActionCurrent(request)) setQuotedPreview(quote);
          return quote;
        },
        execute: (request, quote, key) =>
          createTradingAccountOrder(request.accountId, {
            assetId: request.payload.assetId,
            side: request.payload.side,
            ...(request.payload.amount !== undefined
              ? { amount: request.payload.amount }
              : { quantity: quote.quantity }),
            quoteId: quote.quoteId,
            idempotencyKey: key,
            ...(request.attachedProtection ? { attachedProtection: request.attachedProtection } : {}),
            ...(request.payload.orderType === 'limit'
              ? { orderType: 'limit' as const, limitPrice: quote.limitPrice }
              : {}),
          }),
        isCurrent: () => isActionCurrent(action.request) && (!action.request.attachedProtection?.length || attachedPermission.current),
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
          setOrderInput('');
          setProtectionDraft(emptyProtection());
          setQuotedPreview(null);
          setFieldError(null);
          setDomainError(null);
          setDiagnosticError(null);
          setDiagnosticRuntime(null);
        } else {
          setDiagnosticRuntime(requestFailureFacts(null, { endpoint: 'POST /api/v1/trading-accounts/:accountId/orders', operation: 'order_create', contractFailure: true, contractInvestigation: 'frontend/src/features/order/mapper.ts', outcome: 'unknown' }));
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
      const contractFailure = error instanceof OrderQuoteValidationError || isTradingAccountScopeMismatchError(error);
      const executeAttempted = !!action.quote;
      const uncertain = executeAttempted && (contractFailure || !getApiErrorInfo(error).hasResponse || (getApiErrorInfo(error).status ?? 0) >= 500);
      setDiagnosticRuntime(requestFailureFacts(error, {
        endpoint: executeAttempted ? 'POST /api/v1/trading-accounts/:accountId/orders' : 'POST /api/v1/trading-accounts/:accountId/orders/quote',
        operation: executeAttempted ? 'order_create' : 'order_quote', contractFailure,
        contractInvestigation: error instanceof OrderQuoteValidationError ? 'frontend/src/features/order/validateOrderQuote.ts' : undefined,
        outcome: uncertain ? 'unknown' : executeAttempted ? undefined : 'not_submitted',
      }));
      const code = getApiErrorCode(error);
      if (error instanceof OrderQuoteValidationError) {
        orderActionRef.current = null;
        setQuotedPreview(null);
        setDomainError(error.message);
      } else if (
        isOrderRequoteRequiredCode(code) ||
        isOrderIdempotencyConflictCode(code)
      ) {
        orderActionRef.current = null;
        setQuotedPreview(null);
        setDomainError(
          code === ERROR_CODE.QUOTE_EXPIRED
            ? '주문 견적이 만료되었습니다. 주문 버튼을 다시 눌러주세요.'
            : isOrderIdempotencyConflictCode(code)
              ? '이미 처리 중인 요청입니다. 주문 내역을 확인해주세요.'
              : '가격 또는 환율이 변경되어 주문하지 못했습니다. 주문 버튼을 다시 눌러주세요.',
        );
      } else {
        setDomainError(
          uncertain ? '주문 결과를 확인하지 못했습니다. 주문 내역을 확인해주세요.' : getOrderDomainErrorMessage(code, !action.request.seasonUi),
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
      getTradingAccountPositions(accountId, {
        assetId,
        limit: 20,
        offset: 0,
      }),
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
    setQuotedPreview(null);
    quoteRevisionRef.current += 1;
    setFieldError(null);
    setDomainError(null);
    setDiagnosticError(null);
    setDiagnosticRuntime(null);
    setSuccessState(clearOrderSuccess());
    orderMutation.reset();
  };

  // Standalone OrderScreen keeps its route account and blocks after a switch.
  // Inline panels instead remount with empty inputs for the new selected account.
  useEffect(() => {
    if (!accountChangedAway) return;
    orderActionRef.current = null;
    setQuotedPreview(null);
    quoteRevisionRef.current += 1;

    setOrderInput('');
    setLimitPrice('');
    setFieldError(null);
    setDomainError(null);
    setDiagnosticError(null);
    setDiagnosticRuntime(null);
    setSuccessState(clearOrderSuccess());
  }, [accountChangedAway]);

  const limitPriceInvalidReason = useMemo(
    () => (orderType === 'limit' ? validateLimitPrice(limitPrice) : null),
    [orderType, limitPrice],
  );

  const asset = assetQuery.data?.asset
    ? applyTickerMarketState(
        assetQuery.data.asset,
        latestTicker?.assetId === assetId ? latestTicker : null,
      )
    : undefined;
  const isAmountBuy = asset?.assetType === 'crypto' && side === 'buy';
  const isStock =
    asset?.assetType === 'domestic_stock' || asset?.assetType === 'us_stock';
  const inputInvalidReason = useMemo(() => {
    if (isAmountBuy) {
      return (
        (isPositiveInput(orderInput, 8)
          ? null
          : '매수 금액은 0보다 큰 숫자와 소수점 이하 최대 8자리로 입력해주세요.') ??
        limitPriceInvalidReason
      );
    }
    return (
      validateQuantity(orderInput) ??
      (isStock &&
      orderType === 'limit' &&
      !new Decimal(orderInput.trim()).isInteger()
        ? '주식 소수점 수량은 시장가만 가능합니다. 지정가는 정수 수량을 입력해주세요.'
        : null) ??
      limitPriceInvalidReason
    );
  }, [orderInput, isAmountBuy, isStock, orderType, limitPriceInvalidReason]);
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
  const displayedPriceAvailable = displayPrice.priceLocal !== null;
  const stockMarketClosed = isStock && asset?.marketStatus === 'closed';
  const tradeFeeRate = !feeQuery.isError
    ? feeQuery.data?.feePolicy?.tradeFeeRate
    : null;
  const indicativePreview =
    side === 'buy' && !inputInvalidReason
      ? isAmountBuy
        ? amountBuyPreview(orderInput.trim(), tradeFeeRate)
        : orderPreview({
            quantity: orderInput.trim(),
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
  const preview = quotedPreview
    ? {
        grossAmount: quotedPreview.grossAmount,
        feeAmount: quotedPreview.feeAmount,
        totalAmount: quotedPreview.netAmount,
      }
    : indicativePreview;
  const estimatedQuantity =
    quotedPreview?.quantity ??
    (isAmountBuy
      ? indicativeBuyQuantity(
          orderInput.trim(),
          orderType === 'limit'
            ? limitPrice.trim()
            : previewPriceAvailable
              ? displayPrice.priceLocal
              : null,
        )
      : null);
  const previewNotice =
    !isAmountBuy && orderType === 'market' && !previewPriceAvailable
      ? displayedPriceAvailable
        ? '현재 화면 시세가 오래되어 예상 금액을 표시할 수 없습니다.'
        : '현재 화면 시세가 없어 예상 금액을 표시할 수 없습니다.'
      : feeQuery.isPending
        ? '수수료 정보를 확인하는 중입니다.'
        : '수수료 정보를 불러오지 못해 예상 금액을 표시할 수 없습니다.';
  const positionQuantity = getAccountPositionQuantity(
    positionQuery.data,
    assetId,
  );
  const attachedEditorVisible = side === 'buy' && orderType === 'limit';
  const attachedAvailable = !protectionQuery.isError && protectionQuery.data?.tradingAccountId === accountId && !!protectionQuery.data.capabilities.canCreateSpot && !!protectionQuery.data.capabilities.canUseSpotLimit;
  attachedPermission.current = attachedAvailable;
  useEffect(() => {
    onAttachedProtectionVisibilityChange?.(attachedEditorVisible);
    return () => onAttachedProtectionVisibilityChange?.(false);
  }, [attachedEditorVisible, onAttachedProtectionVisibilityChange]);


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

  // Server marketStatus is a UX hint; Quote/Create revalidate their own clock.
  // Never change the selected order type automatically.
  const sessionNotice =
    stockMarketClosed && orderType === 'market'
      ? '정규장 외에는 시장가 주문을 할 수 없습니다. 지정가를 선택하면 다음 정규장을 기다리는 주문을 등록할 수 있습니다.'
      : null;

  const assetWarningReason =
    (stockMarketClosed &&
    asset?.tradeBlockedReason?.trim().toUpperCase() === 'MARKET_CLOSED'
      ? null
      : asset
        ? getAssetTradingWarning(asset)
        : null) ??
    (asset &&
    asset.marketStatus !== 'closed' &&
    !isTradableMarketStatus(asset.marketStatus)
      ? '장 상태는 서버 견적에서 최종 확인됩니다.'
      : asset &&
          orderType === 'market' &&
          !stockMarketClosed &&
          (side === 'buy' ? !previewPriceAvailable : !displayedPriceAvailable)
        ? isAmountBuy
          ? displayedPriceAvailable
            ? '현재 화면 시세가 오래되어 예상 수량을 표시할 수 없습니다. 견적은 서버가 최종 판정합니다.'
            : '현재 화면 시세가 없어 예상 수량을 표시할 수 없습니다. 견적은 서버가 최종 판정합니다.'
          : displayedPriceAvailable
            ? '현재 화면 시세가 오래되어 비율 수량 계산은 제한됩니다. 견적은 서버가 최종 판정합니다.'
            : '현재 화면 시세가 없어 비율 수량 계산은 제한됩니다. 견적은 서버가 최종 판정합니다.'
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
          : side === 'sell' && Number(orderInput) > Number(positionQuantity)
            ? '보유 수량을 초과하여 매도할 수 없습니다.'
            : null;

  const preOrderBlockedReason =
    accountBlockedReason ?? assetHardBlockedReason ?? sellBlockedReason;
  // Empty holdings still block submission. Only the initial input-dependent
  // error is quiet; account/position service failures stay visible.
  const visibleBlockedReason =
    accountBlockedReason ??
    assetHardBlockedReason ??
    (positionQuery.isLoading || positionUnavailable || orderInput.trim()
      ? sellBlockedReason
      : null);

  const settlementCurrency = isWalletCurrency(asset?.settlementCurrency)
    ? asset.settlementCurrency
    : null;
  // Ratio buttons and spendable-cash checks use the AVAILABLE balance
  // (balance - reserved): cash locked by open limit orders is not spendable.
  const buyAvailable =
    side === 'buy' && settlementCurrency
      ? getWalletAvailableAmount(walletsQuery.data, settlementCurrency, asset?.assetType === 'crypto' ? 'crypto_spot' : 'securities')
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
    if (isAmountBuy) {
      return buyAmountAtRatio(buyAvailable, tradeFeeRate, 1) === null
        ? '수수료 정보를 확인해야 매수 금액 비율을 계산할 수 있습니다.'
        : null;
    }
    if (!ratioPriceValue) {
      if (stockMarketClosed && orderType === 'market')
        return '정규장 외에는 시장가 주문을 할 수 없습니다.';
      return orderType === 'limit'
        ? '지정가를 입력하면 비율 수량을 계산할 수 있습니다.'
        : displayedPriceAvailable
          ? '현재 화면 시세가 오래되어 비율 수량을 계산할 수 없습니다.'
          : '현재가가 없어 비율 수량을 계산할 수 없습니다.';
    }

    return null;
  }, [
    isAmountBuy,
    displayedPriceAvailable,
    stockMarketClosed,
    buyAvailable,
    tradeFeeRate,
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
    !successData &&
    !orderActionRef.current?.completed;
  const inputErrorMessage =
    fieldError ?? (orderInput.trim() ? inputInvalidReason : null);

  // Stock ratios retain their existing fee buffer; crypto uses the server's
  // fee policy and writes gross amount, never a client execution quantity.
  const quantityAtRatio = (ratio: number) =>
    side === 'sell'
      ? (positionQuantityValue ?? 0) * ratio
      : ((buyAvailableValue ?? 0) * ratio) /
        ((ratioPriceValue ?? 0) * (1 + BUY_FEE_BUFFER));
  const inputAtRatio = (ratio: number) => {
    if (isAmountBuy) return buyAmountAtRatio(buyAvailable, tradeFeeRate, ratio);
    const value = quantityAtRatio(ratio);
    return formatQuantityInput(
      isStock && orderType === 'limit' ? Math.floor(value) : value,
    );
  };
  // Preserve the chosen percentage through six-decimal flooring, but only
  // while it still describes this input at the current price/balance.
  const activeRatio =
    !ratioDisabledReason &&
    chosenRatio !== null &&
    (chosenRatio === 0
      ? orderInput === ''
      : inputAtRatio(chosenRatio) === orderInput)
      ? chosenRatio
      : null;
  const capacity = isAmountBuy ? Number(inputAtRatio(1)) : quantityAtRatio(1);
  const inputRatio =
    !ratioDisabledReason && Number.isFinite(capacity) && capacity > 0
      ? Math.min(1, (parsePositiveDecimal(orderInput) ?? 0) / capacity)
      : 0;
  const displayedRatio = activeRatio ?? inputRatio;

  const applyQuantityRatio = (value: number) => {
    if (submitLockRef.current) return;
    if (!Number.isFinite(value)) return;
    const ratio = Math.max(0, Math.min(1, value));
    if (ratioDisabledReason) {
      setFieldError(ratioDisabledReason);
      return;
    }

    if (ratio === 0) {
      setOrderInput('');
      setChosenRatio(0);
      resetOrderActionState();
      return;
    }

    const nextQuantity = inputAtRatio(ratio);

    if (!nextQuantity || Number(nextQuantity) <= 0) {
      setFieldError(
        isAmountBuy
          ? '계산된 매수 금액이 너무 작습니다.'
          : '계산된 수량이 너무 작습니다.',
      );
      return;
    }

    setOrderInput(nextQuantity);
    setChosenRatio(ratio);
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
    setDiagnosticRuntime(null);
    // An uncertain create response retains this exact quote/key for a user
    // retry. It never silently obtains a second executable order.
    const attached = attachedEditorVisible ? draftLegs(protectionDraft) : [];
    if (attached.length && !attachedPermission.current) { setFieldError('현재 운영 상태에서는 익절·손절을 등록할 수 없습니다.'); return; }
    if (!orderActionRef.current && attached.length && protectionInputError(protectionDraft)) { setFieldError(protectionInputError(protectionDraft)); return; }
    orderActionRef.current ??= {
      request: {
        accountId,
        epoch: scopeRef.current.epoch,
        revision: quoteRevisionRef.current,
        seasonUi: capabilities?.isSeason ?? false,
        ...(attached.length ? { attachedProtection: attached } : {}),
        payload: {
          assetId,
          side,
          ...(isAmountBuy
            ? { amount: orderInput.trim() }
            : { quantity: orderInput.trim() }),
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
  if (accountsError)
    return <View style={styles.group}>
      <ErrorNotice error={accountsFailure} message="주문 계정을 확인할 수 없습니다." style={styles.errorText} />
      <CTAButton variant="neutral" label="종목으로 돌아가기" onPress={onReturnToAsset} />
    </View>;
  if (accountChangedAway || !accountKnown)
    return (
      <View style={styles.group}>
        <Text style={styles.errorText}>
          {accountChangedAway
            ? '선택한 계정이 변경되었습니다.'
            : '주문 계정을 확인할 수 없습니다.'}
        </Text>
        <CTAButton variant="neutral" label="종목으로 돌아가기" onPress={onReturnToAsset} />
      </View>
    );
  if (assetQuery.isError || !asset)
    return (
      <View style={styles.group}>
        <Text style={styles.errorText}>주문 정보를 불러오지 못했습니다.</Text>
        <CTAButton
          variant="neutral" label="다시 시도"
          onPress={() => void assetQuery.refetch()}
        />
        <AdminDiagnosticPanel error={assetQuery.error} />
      </View>
    );
  const pending = orderPending;
  const integrityError = [positionQuery, walletsQuery].find(
    (query) => query.isError && getIntegrityErrorMessage(query.error),
  )?.error;
  const integrityMessage = getIntegrityErrorMessage(integrityError);
  const resetInput = (update: () => void) => {
    if (submitLockRef.current) return;
    update();
    setChosenRatio(null);
    resetOrderActionState();
  };
  return (
    <View style={styles.panel} testID={TEST_IDS.order.screen}>
      <OrderTypeSelect
        value={orderType}
        disabled={pending}
        onChange={(next) =>
          resetInput(() => {
            setOrderType(next);
            if (next === 'market') setLimitPrice('');
          })
        }
      />
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
            onFieldFocus={onInputFocus}
            onBlur={onInputBlur}
          />
        ) : (
          <Text style={styles.marketPrice}>시장가</Text>
        )}
      </View>
      <View style={styles.group}>
        <Text style={styles.label}>
          {isAmountBuy ? `매수 금액 (${asset.settlementCurrency})` : '수량'}
        </Text>
        <OrderNumberInput
          testID={TEST_IDS.order.quantityInput}
          accessibilityLabel={
            isAmountBuy ? `매수 금액 ${asset.settlementCurrency}` : '주문 수량'
          }
          editable={!pending}
          style={styles.input}
          value={orderInput}
          onChangeText={(value) => resetInput(() => setOrderInput(value))}
          keyboardType="decimal-pad"
          placeholder={isAmountBuy ? '매수 금액 입력' : '수량 입력'}
          onFieldFocus={onInputFocus}
          onBlur={onInputBlur}
        />
      </View>
      {attachedEditorVisible ? (
        <View style={styles.group} testID="attached-entry-editor">
          <Text style={styles.label}>체결 후 익절/손절 (선택)</Text>
          {!attachedAvailable ? <Text style={styles.helper}>현재 운영 상태에서는 새 보호 조건을 등록할 수 없습니다.</Text> : null}
          <Text style={styles.helper}>새 보유 종목을 여는 진입 주문에 설정합니다. 진입 체결 전에는 조건을 감시하지 않습니다.</Text>
          <ProtectionEditor value={protectionDraft} onChange={(draft) => resetInput(() => setProtectionDraft(draft))} disabled={pending || !attachedAvailable} canLimit={attachedAvailable} onInputFocus={onInputFocus} onInputBlur={onInputBlur} />
        </View>
      ) : null}
      {isAmountBuy ? (
        <Text style={styles.helper} testID="order-estimated-quantity">
          {estimatedQuantity
            ? `예상 수량 약 ${formatDisplayDecimal(estimatedQuantity)} ${asset.symbol?.replace(/USDT$/, '') ?? ''}`
            : '예상 수량은 서버 견적에서 확인됩니다.'}
        </Text>
      ) : null}
      <View style={styles.group}>
        <View style={styles.ratioLabel}>
          <Text style={styles.label}>
            {isAmountBuy ? '매수 금액 비율' : '수량 비율'}
          </Text>
          <Text
            style={[
              styles.label,
              styles.ratioValue,
              { flexBasis: 36 * fontScale },
            ]}
          >
            {Math.round(displayedRatio * 100)}%
          </Text>
        </View>
        <QuantityRatioSlider
          accessibilityLabel={isAmountBuy ? '매수 금액 비율' : '주문 수량 비율'}
          value={displayedRatio}
          disabled={pending || !!ratioDisabledReason}
          disabledReason={ratioDisabledReason ?? undefined}
          onChange={applyQuantityRatio}
        />
      </View>
      <View style={styles.ratios}>
        {RATIO_BUTTONS.map((ratio) => (
          <ActionPressable
            key={ratio}
            accessibilityRole="button"
            accessibilityLabel={`${isAmountBuy ? '매수 금액' : '주문 가능 수량'} ${getRatioLabel(ratio)}`}
            aria-pressed={activeRatio === ratio}
            testID={`order-ratio-${Math.round(ratio * 100)}`}
            style={[
              styles.ratioButton,
              { flexBasis: 34 * fontScale },
              activeRatio === ratio && styles.ratioSelected,
              pending && styles.ratioPending,
            ]}
            hitSlop={{ top: 6, bottom: 6 }}
            disabled={pending}
            accessibilityState={{
              disabled: pending,
              selected: activeRatio === ratio,
            }}
            onPress={() => applyQuantityRatio(ratio)}
          >
            <Text
              style={[
                styles.ratioText,
                activeRatio === ratio && styles.activeText,
              ]}
            >
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
      {integrityMessage ? (
        <AdminDiagnosticPanel error={integrityError} />
      ) : null}
      {visibleBlockedReason ? (
        <Text
          testID={TEST_IDS.tradingAccount.capabilityNotice}
          style={styles.errorText}
        >
          {visibleBlockedReason}
        </Text>
      ) : null}
      {visibleBlockedReason && side === 'sell' && positionUnavailable ? (
        <AdminDiagnosticPanel
          error={positionQuery.error}
          diagnostic={positionQuery.isError ? undefined : positionQuery.data?.valuationErrors?.find(
            (error) => error.diagnostic,
          )?.diagnostic}
        />
      ) : null}
      {!integrityMessage && side === 'buy' && walletsQuery.isError ? (
        <ErrorNotice error={walletsQuery.error} message="지갑 잔액을 확인할 수 없습니다." style={styles.errorText} />
      ) : null}
      {sessionNotice ? (
        <Text style={styles.warningText}>{sessionNotice}</Text>
      ) : null}
      {assetWarningReason ? (
        <>
          <Text style={styles.warningText}>{assetWarningReason}</Text>
          {(showAssetPriceDiagnostic || displayPrice.priceLocal !== null) &&
          (side === 'buy' ? !previewPriceAvailable : !displayedPriceAvailable) ? (
            <AdminDiagnosticPanel
              diagnostic={showAssetPriceDiagnostic &&
                displayPrice.priceLocal === null &&
                displayPrice.basis !== 'realtime' &&
                displayPrice.basis !== 'snapshot'
                ? assetQuery.data?.priceErrors?.find(
                    (error) => error.assetId === assetId && error.diagnostic,
                  )?.diagnostic
                : undefined}
              runtime={displayPrice.priceLocal !== null ||
                displayPrice.basis === 'realtime' ||
                displayPrice.basis === 'snapshot' ? {
                assetId,
                ...tickerRuntime,
                displayedPriceBasis: displayPrice.basis,
                displayedPriceAvailable: displayPrice.priceLocal !== null,
                priceCapturedAt: displayPrice.priceCapturedAt,
                previewPriceAvailable,
              } : null}
            />
          ) : null}
        </>
      ) : null}
      {inputErrorMessage ? (
        <Text style={styles.errorText}>{inputErrorMessage}</Text>
      ) : null}
      {domainError ? (
        <>
          <Text accessibilityLiveRegion="polite" style={styles.errorText}>
            {domainError}
          </Text>
          <AdminDiagnosticPanel error={diagnosticError} runtime={diagnosticRuntime} includeRuntimeWithDiagnostic />
        </>
      ) : null}
      {asset.settlementCurrency === 'USD' &&
      domainError ===
        getOrderDomainErrorMessage(ERROR_CODE.INSUFFICIENT_BALANCE) ? (
        <CTAButton
          label="USD 환전하러 가기"
          onPress={() =>
            rootNavigation.navigate('MainTabs', {
              screen: 'WalletTab',
              params: { screen: 'WalletFx', initial: false },
            })
          }
        />
      ) : null}
      {side === 'buy' && !(stockMarketClosed && orderType === 'market') ? (
        <>
          {!inputInvalidReason ? (
            <View style={styles.preview} testID="order-indicative-preview">
              {preview ? (
                <>
                  <Amount
                    label={isAmountBuy ? '매수 원금' : '예상 주문금액'}
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
                  {orderType === 'market' && !previewPriceAvailable && !assetWarningReason ? (
                    <AdminDiagnosticPanel
                      diagnostic={showAssetPriceDiagnostic &&
                        displayPrice.priceLocal === null &&
                        displayPrice.basis !== 'realtime' &&
                        displayPrice.basis !== 'snapshot'
                        ? assetQuery.data?.priceErrors?.find(
                        (error) => error.assetId === assetId && error.diagnostic,
                      )?.diagnostic : undefined}
                      runtime={displayPrice.priceLocal !== null ||
                        displayPrice.basis === 'realtime' ||
                        displayPrice.basis === 'snapshot' ? {
                        assetId,
                        ...tickerRuntime,
                        displayedPriceBasis: displayPrice.basis,
                        displayedPriceAvailable: displayPrice.priceLocal !== null,
                        priceCapturedAt: displayPrice.priceCapturedAt,
                        previewPriceAvailable,
                      } : null}
                    />
                  ) : null}
                  {feeQuery.isError ? (
                    <AdminDiagnosticPanel error={feeQuery.error} />
                  ) : null}
                  {orderType === 'market' && !previewPriceAvailable ? (
                    <CTAButton
                      variant="neutral" label="시세 다시 불러오기"
                      onPress={() => void assetQuery.refetch()}
                    />
                  ) : null}
                  {feeQuery.isError ? (
                    <CTAButton
                      variant="neutral" label="수수료 다시 불러오기"
                      onPress={() => void feeQuery.refetch()}
                    />
                  ) : null}
                </>
              )}
            </View>
          ) : null}
        </>
      ) : null}
      <View ref={submitRef} collapsable={false}>
        <CTAButton
          testID={TEST_IDS.order.executeSubmit}
          label={side === 'buy' ? '매수' : '매도'}
          style={side === 'buy' ? styles.buyActive : styles.sellActive}
          state={pending ? 'loading' : canExecute ? 'enabled' : 'disabled'}
          onPress={submitOrder}
        />
      </View>
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
            screen: 'MyTab',
            params: { screen: 'Record', initial: false, params: { screen: 'RecordSeasonList' } },
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

/** Keep the native caret and horizontal scrolling in the actual input. */
function OrderNumberInput({ onFieldFocus, ...props }: TextInputProps & { onFieldFocus?: (input: View | null) => void }) {
  const fieldRef = useRef<View>(null);
  const { fontScale } = useWindowDimensions();
  const [width, setWidth] = useState(0);
  const showFullValue =
    width > 0 && (props.value?.length ?? 0) * 9.6 * fontScale > width - 16;
  return (
    <View
      ref={fieldRef}
      collapsable={false}
      style={styles.group}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <TextInput {...props} onFocus={(event) => { props.onFocus?.(event); onFieldFocus?.(fieldRef.current); }} style={[props.style, styles.compactInput,
        fontScale > 1 && { minHeight: Math.ceil(22 * fontScale + 24), lineHeight: Math.ceil(22 * fontScale) }]} />
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
  formFade: { minWidth: 0 },
  buyActive: { backgroundColor: BUY_COLOR },
  sellActive: { backgroundColor: SELL_COLOR },
  activeText: { color: semantic.onAccent },
  group: { gap: 4, minWidth: 0 },
  label: { fontSize: 12, color: semantic.muted },
  helper: { fontSize: 12, color: semantic.secondary },
  amount: {
    fontSize: 14,
    fontWeight: '600',
    color: semantic.text,
    fontVariant: ['tabular-nums'],
  },
  marketPrice: {
    fontSize: 14,
    color: semantic.muted,
    backgroundColor: semantic.raised,
    borderRadius: 8,
    padding: 12,
    minHeight: 46,
  },
  input: {
    width: '100%',
    minWidth: 0,
    minHeight: 54,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 8,
    fontSize: 16,
    lineHeight: 24,
    color: semantic.text,
    backgroundColor: semantic.input,
  },
  compactInput: { flexShrink: 1, paddingHorizontal: 4, fontSize: 14, lineHeight: 22 },
  ratios: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 3,
    rowGap: 12,
    paddingVertical: 6,
  },
  ratioLabel: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 4,
    justifyContent: 'space-between',
  },
  // Reserve space for 100% so digit changes cannot move the track during a drag.
  ratioValue: {
    flexShrink: 1,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  ratioButton: {
    backgroundColor: semantic.raised,
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    minHeight: 32,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 6,
    paddingVertical: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ratioText: { fontSize: 11, fontWeight: '600', color: semantic.text },
  ratioSelected: { backgroundColor: semantic.selected, borderColor: semantic.selected },
  ratioPending: { opacity: 0.4 },
  preview: {
    gap: 8,
    borderTopWidth: 1,
    borderColor: semantic.border,
    paddingTop: 10,
  },
  errorText: { fontSize: 12, color: semantic.error },
  warningText: { fontSize: 12, color: semantic.warning },
});
