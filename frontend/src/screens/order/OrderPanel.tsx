import { getTradingAssetName } from '../../features/asset/tradingHeader';
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
  getLimitOrderSuccessMessage,
  getOrderQuoteDisplay,
  getOrderQuoteExpiresInSeconds,
  isOrderIdempotencyConflictCode,
  isOrderQuoteExpired,
  isOrderRequoteRequiredCode,
  isOrderSuccess,
} from '../../features/order/mapper';
import { buildWsUrl, LIMIT_ORDER_ENABLED } from '../../constants/env';
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
import type { OrderFlowState } from '../../models/enums/viewState';
import {
  BLOCKED_REASON_MESSAGE,
  getApiErrorCode,
  getErrorMessageFromCode,
  mapOrderErrorCodeToBlockedReason,
} from '../../services/api/errorMapper';
import { createIdempotencyKey } from '../../utils/idempotency';
import {
  formatAssetPrice,
  formatCurrency,
  formatDisplayDecimal,
} from '../../utils/format';

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
type OrderDomainState = Extract<
  OrderFlowState,
  | 'order_quote_rejected'
  | 'order_requote_required'
  | 'order_idempotency_conflict'
  | 'order_failed'
>;

const QUOTE_EXPIRED_MESSAGE =
  '견적 유효 시간이 지났습니다. 다시 견적을 받아주세요.';
const REQUOTE_REQUIRED_MESSAGE =
  '가격 또는 환율이 변경되었습니다. 다시 견적을 받아주세요.';
const IDEMPOTENCY_CONFLICT_MESSAGE =
  '이미 다른 내용으로 처리 중인 요청입니다. 새 견적을 받아 다시 시도해주세요.';
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
  const showLimitToggle = LIMIT_ORDER_ENABLED;
  const [orderTypeState, setOrderTypeState] = useState<'market' | 'limit'>(
    'market',
  );
  const orderType = showLimitToggle ? orderTypeState : 'market';
  const [limitPrice, setLimitPrice] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [diagnosticError, setDiagnosticError] = useState<unknown>(null);
  const [quoteData, setQuoteData] = useState<OrderQuoteDto | null>(null);
  const [executeIdempotencyKey, setExecuteIdempotencyKey] = useState<
    string | null
  >(null);
  const [orderDomainState, setOrderDomainState] =
    useState<OrderDomainState | null>(null);
  const [successState, setSuccessState] = useState(EMPTY_ORDER_SUCCESS_STATE);
  // Create clears the active quote so stale inputs cannot be re-submitted,
  // while this immutable snapshot remains available to the success sheet.
  const successData = successState.data;
  const successQuoteData = successState.quote;
  const [quoteNow, setQuoteNow] = useState(() => Date.now());
  type BuyRequest = {
    accountId: string;
    epoch: number;
    seasonUi: boolean;
    payload: Parameters<typeof quoteTradingAccountOrder>[1];
  };
  const buyActionRef = useRef<QuotedAction<BuyRequest, OrderQuoteDto> | null>(
    null,
  );
  const buySubmitLockRef = useRef(false);
  const sellSubmitLockRef = useRef(false);
  const quoteRevisionRef = useRef(0);
  const buyScopeRef = useRef({ key: '', epoch: 0, mounted: true });
  const scopeKey = `${accountId}:${selectedAccountId ?? ''}:${accountKnown}:${assetId}:${side}`;
  if (buyScopeRef.current.key !== scopeKey) {
    buyActionRef.current = null;
    buyScopeRef.current = {
      key: scopeKey,
      epoch: buyScopeRef.current.epoch + 1,
      mounted: true,
    };
  }
  useEffect(() => {
    buyScopeRef.current.mounted = true;
    return () => {
      buyScopeRef.current.mounted = false;
    };
  }, []);
  const isBuyCurrent = (request: BuyRequest) =>
    buyScopeRef.current.mounted && request.epoch === buyScopeRef.current.epoch;
  const latestQuoteInputRef = useRef<{
    assetId: string;
    side: typeof side;
    quantity: string;
    orderType: 'market' | 'limit';
    limitPrice: string;
  }>({
    assetId,
    side,
    quantity: '',
    orderType: 'market',
    limitPrice: '',
  });

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

  const buyMutation = useMutation({
    mutationFn: (action: QuotedAction<BuyRequest, OrderQuoteDto>) =>
      runQuotedAction(action, {
        quote: (request) =>
          quoteTradingAccountOrder(request.accountId, request.payload),
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
        isCurrent: () => isBuyCurrent(action.request),
      }),
    retry: false,
    onSettled: () => {
      buySubmitLockRef.current = false;
    },
    onSuccess: async (data, action) => {
      if (!data) return;
      if (isBuyCurrent(action.request)) {
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
      if (!isBuyCurrent(action.request)) return;
      setDiagnosticError(error);
      const code = getApiErrorCode(error);
      if (
        isOrderRequoteRequiredCode(code) ||
        isOrderIdempotencyConflictCode(code)
      ) {
        buyActionRef.current = null;
        setDomainError(
          code === ERROR_CODE.QUOTE_EXPIRED
            ? '주문 견적이 만료되었습니다. 매수하기를 다시 눌러주세요.'
            : isOrderIdempotencyConflictCode(code)
              ? '이미 처리 중인 요청입니다. 주문 내역을 확인해주세요.'
              : '가격 또는 환율이 변경되어 주문하지 못했습니다. 매수하기를 다시 눌러주세요.',
        );
      } else {
        setDomainError(
          getOrderDomainErrorMessage(code, !action.request.seasonUi),
        );
      }
    },
  });
  const buyPending = buyMutation.isPending;

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

  latestQuoteInputRef.current = {
    assetId,
    side,
    quantity: quantity.trim(),
    orderType,
    limitPrice: limitPrice.trim(),
  };

  useEffect(() => {
    if (!quoteData) return undefined;

    setQuoteNow(Date.now());
    const intervalId = setInterval(() => {
      setQuoteNow(Date.now());
    }, 1000);

    return () => clearInterval(intervalId);
  }, [quoteData]);

  type SellQuoteRequest = {
    payload: Parameters<typeof quoteTradingAccountOrder>[1];
    epoch: number;
    revision: number;
  };
  const isSellQuoteCurrent = (request: SellQuoteRequest) =>
    buyScopeRef.current.mounted &&
    request.epoch === buyScopeRef.current.epoch &&
    request.revision === quoteRevisionRef.current;
  const quoteMutation = useMutation({
    // The accountId is closed over from the bound form, so every quote this screen
    // issues names the same account for as long as the screen exists.
    mutationFn: (request: SellQuoteRequest) =>
      quoteTradingAccountOrder(accountId, request.payload),
    retry: false,
    onSuccess: (result, request) => {
      if (!isSellQuoteCurrent(request)) return;
      const variables = request.payload;
      const latestInput = latestQuoteInputRef.current;
      if (
        variables.assetId !== latestInput.assetId ||
        variables.side !== latestInput.side ||
        variables.quantity !== latestInput.quantity ||
        (variables.orderType ?? 'market') !== latestInput.orderType ||
        (variables.limitPrice ?? '') !== latestInput.limitPrice
      ) {
        return;
      }

      setQuoteData(result);
      setExecuteIdempotencyKey(createIdempotencyKey('order'));
      setOrderDomainState(null);
      setFieldError(null);
      setDomainError(null);
      setDiagnosticError(null);
      setSuccessState(clearOrderSuccess());
    },
    onError: (error, request) => {
      if (!isSellQuoteCurrent(request)) return;
      const variables = request.payload;
      const latestInput = latestQuoteInputRef.current;
      if (
        variables.assetId !== latestInput.assetId ||
        variables.side !== latestInput.side ||
        variables.quantity !== latestInput.quantity ||
        (variables.orderType ?? 'market') !== latestInput.orderType ||
        (variables.limitPrice ?? '') !== latestInput.limitPrice
      ) {
        return;
      }

      const code = getApiErrorCode(error);
      setDiagnosticError(error);

      setQuoteData(null);
      setExecuteIdempotencyKey(null);
      setOrderDomainState('order_quote_rejected');
      setDomainError(
        isOrderRequoteRequiredCode(code)
          ? REQUOTE_REQUIRED_MESSAGE
          : getOrderDomainErrorMessage(code, capabilities?.isGeneral === true),
      );
    },
  });

  type SellCreateRequest = {
    payload: Parameters<typeof createTradingAccountOrder>[1];
    epoch: number;
    quote: OrderQuoteDto;
    seasonUi: boolean;
  };
  const createMutation = useMutation({
    mutationFn: (request: SellCreateRequest) =>
      createTradingAccountOrder(accountId, request.payload),
    retry: false,
    onSettled: () => {
      sellSubmitLockRef.current = false;
    },
    onSuccess: async (result, request) => {
      // An already-sent create still belongs to the old account. Refresh that
      // account even after unmount, but never show its success in a new flow.
      await invalidateAfterOrderCreate(queryClient, accountId, {
        seasonUi: request.seasonUi,
      });
      if (
        !buyScopeRef.current.mounted ||
        request.epoch !== buyScopeRef.current.epoch
      )
        return;
      if (!isOrderSuccess(result)) {
        setOrderDomainState('order_failed');
        setDomainError(
          '주문 결과를 확인할 수 없습니다. 잠시 후 다시 확인해주세요.',
        );
        return;
      }

      setSuccessState(captureOrderSuccess(result, request.quote));
      setQuoteData(null);
      setExecuteIdempotencyKey(null);
      setOrderDomainState(null);
      setFieldError(null);
      setDomainError(null);
      setDiagnosticError(null);
    },
    onError: (error, request) => {
      if (
        !buyScopeRef.current.mounted ||
        request.epoch !== buyScopeRef.current.epoch
      )
        return;
      const code = getApiErrorCode(error);
      setDiagnosticError(error);

      if (isOrderRequoteRequiredCode(code)) {
        setQuoteData(null);
        setExecuteIdempotencyKey(null);
        setOrderDomainState('order_requote_required');
        setDomainError(
          code === ERROR_CODE.QUOTE_EXPIRED
            ? QUOTE_EXPIRED_MESSAGE
            : REQUOTE_REQUIRED_MESSAGE,
        );
        return;
      }

      if (isOrderIdempotencyConflictCode(code)) {
        setQuoteData(null);
        setExecuteIdempotencyKey(null);
        setOrderDomainState('order_idempotency_conflict');
        setDomainError(IDEMPOTENCY_CONFLICT_MESSAGE);
        return;
      }

      setOrderDomainState('order_failed');
      setDomainError(
        getOrderDomainErrorMessage(code, capabilities?.isGeneral === true),
      );
    },
  });

  const resetOrderActionState = () => {
    if (buySubmitLockRef.current || sellSubmitLockRef.current) return;
    buyActionRef.current = null;
    quoteRevisionRef.current += 1;
    setFieldError(null);
    setDomainError(null);
    setDiagnosticError(null);
    setQuoteData(null);
    setExecuteIdempotencyKey(null);
    setOrderDomainState(null);
    setSuccessState(clearOrderSuccess());
    quoteMutation.reset();
    createMutation.reset();
  };

  // Standalone OrderScreen keeps its route account and blocks after a switch.
  // Inline panels instead remount with empty inputs for the new selected account.
  useEffect(() => {
    if (!accountChangedAway) return;
    buyActionRef.current = null;
    quoteRevisionRef.current += 1;

    setQuantity('');
    setLimitPrice('');
    setFieldError(null);
    setDomainError(null);
    setDiagnosticError(null);
    setQuoteData(null);
    setExecuteIdempotencyKey(null);
    setOrderDomainState(null);
    setSuccessState(clearOrderSuccess());
    quoteMutation.reset();
    createMutation.reset();
    // Mutation objects are recreated every render; depending on them here would
    // re-run this on every render instead of only when the account changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountChangedAway]);

  const limitPriceInvalidReason = useMemo(
    () => (orderType === 'limit' ? validateLimitPrice(limitPrice) : null),
    [orderType, limitPrice],
  );

  const inputInvalidReason = useMemo(
    () => validateQuantity(quantity) ?? limitPriceInvalidReason,
    [quantity, limitPriceInvalidReason],
  );

  const quoteExpired = useMemo(
    () => (quoteData ? isOrderQuoteExpired(quoteData, quoteNow) : false),
    [quoteData, quoteNow],
  );

  const quoteExpiresInSeconds = useMemo(
    () => (quoteData ? getOrderQuoteExpiresInSeconds(quoteData, quoteNow) : 0),
    [quoteData, quoteNow],
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

  // Price precision comes from asset metadata, including when a quote arrives.
  const quoteDisplay = useMemo(
    () =>
      quoteData
        ? getOrderQuoteDisplay(quoteData, asset?.displayPriceDecimals)
        : null,
    [quoteData, asset?.displayPriceDecimals],
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

  const sellBlockedReason =
    side === 'sell' && positionQuery.isLoading
      ? '보유 수량을 확인하는 중입니다.'
      : side === 'sell' && positionQuery.isError
        ? '보유 수량을 확인할 수 없어 매도할 수 없습니다.'
        : side === 'sell' && Number(positionQuantity) <= 0
          ? '보유 수량이 없어 매도할 수 없습니다.'
          : side === 'sell' && Number(quantity) > Number(positionQuantity)
            ? '보유 수량을 초과하여 매도할 수 없습니다.'
            : null;

  const preOrderBlockedReason =
    accountBlockedReason ?? assetHardBlockedReason ?? sellBlockedReason;

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
      if (positionQuery.isError) return '보유 수량을 확인할 수 없습니다.';
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
    positionQuery.isError,
    positionQuery.isLoading,
    positionQuantityValue,
    ratioPriceValue,
    settlementCurrency,
    side,
    walletsQuery.data,
    walletsQuery.isError,
    walletsQuery.isLoading,
  ]);

  const viewState = useMemo<OrderFlowState>(() => {
    if (createMutation.isPending) return 'order_submitting';
    if (quoteMutation.isPending) return 'order_quote_loading';
    if (successData) return 'order_success';
    if (orderDomainState) return orderDomainState;
    if (quoteData && quoteExpired) return 'order_quote_expired';
    if (quoteData) return 'order_quote_ready';
    if (inputInvalidReason) {
      return quantity.trim() || fieldError
        ? 'order_input_invalid'
        : 'order_input_idle';
    }
    return 'order_input_idle';
  }, [
    createMutation.isPending,
    quoteMutation.isPending,
    successData,
    orderDomainState,
    quoteData,
    quoteExpired,
    inputInvalidReason,
    quantity,
    fieldError,
  ]);

  const canExecute =
    !preOrderBlockedReason &&
    !inputInvalidReason &&
    !!quoteData &&
    !quoteExpired &&
    !!executeIdempotencyKey &&
    orderDomainState !== 'order_requote_required' &&
    orderDomainState !== 'order_idempotency_conflict';

  const canBuyExecute =
    !preOrderBlockedReason &&
    !inputInvalidReason &&
    !!preview &&
    !successData &&
    !buyActionRef.current?.completed;

  const inputErrorMessage =
    fieldError ??
    (viewState === 'order_input_invalid' ? inputInvalidReason : null);

  const requestQuote = () => {
    if (
      sellSubmitLockRef.current ||
      quoteMutation.isPending ||
      accountChangedAway
    )
      return;
    if (preOrderBlockedReason) {
      setDomainError(preOrderBlockedReason);
      return;
    }

    if (inputInvalidReason) {
      setFieldError(inputInvalidReason);
      return;
    }

    setFieldError(null);
    setDomainError(null);
    setDiagnosticError(null);
    setQuoteData(null);
    setExecuteIdempotencyKey(null);
    setOrderDomainState(null);
    setSuccessState(clearOrderSuccess());
    createMutation.reset();

    quoteRevisionRef.current += 1;
    quoteMutation.mutate({
      epoch: buyScopeRef.current.epoch,
      revision: quoteRevisionRef.current,
      payload: {
        assetId,
        side,
        quantity: quantity.trim(),
        ...(orderType === 'limit'
          ? { orderType: 'limit' as const, limitPrice: limitPrice.trim() }
          : {}),
      },
    });
  };

  const applyQuantityRatio = (ratio: (typeof RATIO_BUTTONS)[number]) => {
    if (buySubmitLockRef.current || sellSubmitLockRef.current) return;
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

  const executeQuote = () => {
    if (
      sellSubmitLockRef.current ||
      createMutation.isPending ||
      accountChangedAway
    )
      return;
    if (preOrderBlockedReason) {
      setDomainError(preOrderBlockedReason);
      return;
    }

    if (inputInvalidReason) {
      setFieldError(inputInvalidReason);
      return;
    }

    if (!quoteData) {
      setDomainError('먼저 견적을 확인해주세요.');
      return;
    }

    if (quoteExpired) {
      setDomainError(QUOTE_EXPIRED_MESSAGE);
      return;
    }

    if (!executeIdempotencyKey) {
      setOrderDomainState('order_failed');
      setDomainError(getErrorMessageFromCode(ERROR_CODE.IDEMPOTENCY_REQUIRED));
      return;
    }

    setFieldError(null);
    setDomainError(null);
    setDiagnosticError(null);
    setOrderDomainState(null);

    sellSubmitLockRef.current = true;
    createMutation.mutate({
      epoch: buyScopeRef.current.epoch,
      quote: quoteData,
      seasonUi: capabilities?.isSeason ?? false,
      payload: {
        quoteId: quoteData.quoteId,
        assetId,
        side,
        quantity: quoteData.quantity,
        idempotencyKey: executeIdempotencyKey,
        ...(orderType === 'limit'
          ? {
              orderType: 'limit' as const,
              // Server-quoted canonical limit price wins over the raw input.
              limitPrice: quoteData.limitPrice ?? limitPrice.trim(),
            }
          : {}),
      },
    });
  };

  const submitBuy = () => {
    if (
      accountChangedAway ||
      buySubmitLockRef.current ||
      buyPending ||
      !canBuyExecute
    )
      return;
    setFieldError(null);
    setDomainError(null);
    setDiagnosticError(null);
    buyActionRef.current ??= {
      request: {
        accountId,
        epoch: buyScopeRef.current.epoch,
        seasonUi: capabilities?.isSeason ?? false,
        payload: {
          assetId,
          side: 'buy',
          quantity: quantity.trim(),
          ...(orderType === 'limit'
            ? { orderType: 'limit', limitPrice: limitPrice.trim() }
            : {}),
        },
      },
      idempotencyKey: createIdempotencyKey('order'),
    };
    buySubmitLockRef.current = true;
    buyMutation.mutate(buyActionRef.current);
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
  const pending = buyPending || createMutation.isPending;
  const integrityMessage =
    getIntegrityErrorMessage(positionQuery.error) ??
    getIntegrityErrorMessage(walletsQuery.error);
  const resetInput = (update: () => void) => {
    if (buySubmitLockRef.current || sellSubmitLockRef.current) return;
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
              resetInput(() => setOrderTypeState('market'));
          }}
        >
          <Text style={styles.typeText}>시장가</Text>
        </ActionPressable>
        {showLimitToggle ? (
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
              if (orderType !== 'limit')
                resetInput(() => setOrderTypeState('limit'));
            }}
          >
            <Text style={styles.typeText}>지정가</Text>
          </ActionPressable>
        ) : null}
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
            disabled={pending || !!ratioDisabledReason}
            onPress={() => applyQuantityRatio(ratio)}
          >
            <Text
              style={[
                styles.ratioText,
                (pending || !!ratioDisabledReason) && styles.muted,
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
      {preOrderBlockedReason ? (
        <Text
          testID={TEST_IDS.tradingAccount.capabilityNotice}
          style={styles.errorText}
        >
          {preOrderBlockedReason}
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
          <CTAButton
            testID={TEST_IDS.order.executeSubmit}
            label={`매수 ${getTradingAssetName(asset)}`}
            style={styles.buyActive}
            state={
              buyPending ? 'loading' : canBuyExecute ? 'enabled' : 'disabled'
            }
            onPress={submitBuy}
          />
        </>
      ) : (
        <>
          {quoteMutation.isPending ? (
            <SectionSkeleton lines={3} />
          ) : quoteDisplay && quoteData ? (
            <View style={styles.preview}>
              <Amount
                label={orderType === 'limit' ? '지정가' : '예상 체결가'}
                value={
                  orderType === 'limit'
                    ? formatAssetPrice(
                        quoteData.limitPrice,
                        quoteData.currencyCode,
                        asset.displayPriceDecimals,
                      )
                    : quoteDisplay.price
                }
              />
              <Amount label="수량" value={quoteDisplay.quantity} />
              <Amount
                label="예상 주문금액"
                value={formatCurrency(
                  quoteData.quotedGrossAmount ?? quoteData.grossAmount,
                  quoteData.currencyCode,
                )}
              />
              <Amount
                label="예상 수수료"
                value={formatCurrency(
                  quoteData.quotedFeeAmount ?? quoteData.feeAmount,
                  quoteData.currencyCode,
                )}
              />
              <Amount
                label="예상 순수령액"
                value={formatCurrency(
                  quoteData.quotedNetAmount ?? quoteData.netAmount,
                  quoteData.currencyCode,
                )}
              />
              {orderType === 'limit' ? (
                <>
                  <Amount
                    label="예약 예정 수량"
                    value={formatDisplayDecimal(quoteData.reservedQuantity)}
                  />
                  <Text style={styles.helper}>
                    {getLimitOrderSuccessMessage(
                      quoteData.executionPolicy,
                      side,
                    )}
                  </Text>
                </>
              ) : null}
              <Text style={styles.helper}>
                남은 시간 {quoteExpiresInSeconds}초
              </Text>
              {quoteExpired ? (
                <Text style={styles.errorText}>{QUOTE_EXPIRED_MESSAGE}</Text>
              ) : null}
            </View>
          ) : null}
          <CTAButton
            testID={TEST_IDS.order.quoteSubmit}
            label={
              quoteExpired || orderDomainState === 'order_requote_required'
                ? '견적 다시 받기'
                : '견적 확인'
            }
            state={
              quoteMutation.isPending
                ? 'loading'
                : preOrderBlockedReason || pending
                  ? 'blocked'
                  : inputInvalidReason
                    ? 'disabled'
                    : 'enabled'
            }
            onPress={requestQuote}
          />
          <CTAButton
            testID={TEST_IDS.order.executeSubmit}
            label={`매도 ${getTradingAssetName(asset)}`}
            style={styles.sellActive}
            state={
              createMutation.isPending
                ? 'loading'
                : canExecute
                  ? 'enabled'
                  : 'disabled'
            }
            onPress={executeQuote}
          />
        </>
      )}
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
  buyActive: { backgroundColor: '#a13e3b' },
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
