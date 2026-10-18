import { captureQuestGuideCommand, questGuideTarget } from '../../features/quest/questGuideBridge';
import { useTradingGuideFacts } from '../../features/quest/useTradingGuideFacts';
import { useLearningAccess } from '../../features/quest/useLearningAccess';
import QuestTarget from '../../features/quest/QuestTarget';
import { semantic } from '../../theme/tokens';
import Decimal from 'decimal.js';
import { BUY_COLOR, SELL_COLOR } from '../../features/order/sideColors';
import OrderSideSegment, { type OrderSide } from './OrderSideSegment';
import OrderTypeSelect from './OrderTypeSelect';
import ConditionalBuyForm from './ConditionalBuyForm';
import SellIntentForm from './SellIntentForm';
import OrderNumberInput from './OrderNumberInput';
import TpSlButton from '../../features/conditional/tpsl/TpSlButton';
import { TpSlDraftSheet } from '../../features/conditional/tpsl/TpSlSheet';
import { getDraftTpSlError } from '../../features/conditional/tpsl/DraftTpSl';
import { getAccountEntryTpSlPlans, type EntryTpSlDraftDto } from '../../features/conditional/entryTpSlApi';
import { tpSlCountSummary } from '../../features/conditional/tpSlModel';
import {
  DEFAULT_ORDER_METHOD,
  getConditionalBuyGate,
  getConditionalSellGate,
  getLimitOnCloseGate,
  getLimitOnCloseSellGate,
  getLimitSellGate,
  getOrderMethodOptions,
  getOrderTypeForMethod,
  isEntryTpSlMarketSupported,
  isOrderMethodSelectable,
  type OrderMethod,
} from '../../features/order/orderMethods';
import { emitOrderFillEvent } from '../../features/order/fillEvents';
import { getConditionalBuyOrders } from '../../features/conditional/conditionalBuyApi';
import { getConditionalSellOrders } from '../../features/conditional/conditionalSellApi';
import { getSessionGeneration } from '../../services/api/sessionOwnership';
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
  useWindowDimensions,
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
  findAccountPosition,
  getAccountPositionAvailableQuantity,
  getAccountPositionQuantity,
  getTradingAccountPositions,
  getTradingAccountWallets,
  getTradingAccount,
  getTradingAccountOrderCapabilities,
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
import { formatCurrency, formatDisplayDecimal, formatKstDateTime } from '../../utils/format';

import SectionSkeleton from '../../components/states/SectionSkeleton';
import CTAButton from '../../components/common/CTAButton';
import OrderSuccessBottomSheet from './OrderSuccessBottomSheet';
import QuantityRatioSlider from './QuantityRatioSlider';
import { OrderAsidePortal } from './OrderAside';
import { OrderSummaryCard, SummaryRow, styles as asideStyles } from './StockOrderAside';
import { formatEnteredAmount, getOrderSummaryBadge } from './stockOrderSummary';
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
  /** Reports user side changes; the panel keeps owning the side. */
  onSideChange?: (side: OrderSide) => void;
};

/** One flow per asset/account/side. Unmounting invalidates pending callbacks. */
export default function OrderPanel({ onSideChange, ...props }: Props) {
  const [side, setSide] = useState<OrderSide>(props.initialSide ?? 'buy');
  const reduced = useReducedMotion();
  // Returning to this screen starts a fresh form (시장가, no draft, no
  // quote). Sheets, the keyboard and re-renders keep focus and the draft.
  const [entry, setEntry] = useState(0);
  const enabled = props.enabled ?? true;
  const wasEnabled = useRef(enabled);
  useEffect(() => {
    if (enabled && !wasEnabled.current) setEntry((value) => value + 1);
    wasEnabled.current = enabled;
  }, [enabled]);
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
          key={`${props.assetId}:${props.accountId}:${side}:${entry}:${getSessionGeneration()}`}
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

/** Decimal comparison of a preview total with the available cash; unknown is never "over". */
function exceedsAvailable(total: string | null | undefined, available: string | null) {
  if (!total || available === null) return false;
  try {
    return new Decimal(total).gt(new Decimal(available));
  } catch {
    return false;
  }
}

/** a − b on decimal strings; null when either is not a number. */
function decimalDifference(a: string, b: string) {
  try {
    return new Decimal(a).minus(new Decimal(b));
  } catch {
    return null;
  }
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
}: Props & { side: 'buy' | 'sell' }) {
  // accountId is immutable for this mounted form, supplied by the route or
  // the keyed inline panel. Selection changes never retarget a pending request.
  const rootNavigation = useRootNavigation();
  const learning = useLearningAccess(accountId);
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
  // Every new form (asset, side, account, session or a return) starts at 시장가.
  const [orderMethod, setOrderMethod] = useState<OrderMethod>(DEFAULT_ORDER_METHOD);
  const [methodSheetOpen, setMethodSheetOpen] = useState(false);
  // The ordinary order type behind market/limit/LOC; LOC is a limit order.
  const orderType = getOrderTypeForMethod(orderMethod) ?? 'market';
  const limitOnClose = orderMethod === 'loc';
  const [limitPrice, setLimitPrice] = useState('');
  // 손절가/익절가 plans sent with a new BUY Limit (they activate on its fill).
  const [tpSlDrafts, setTpSlDrafts] = useState<EntryTpSlDraftDto[]>([]);
  const [tpSlSheetOpen, setTpSlSheetOpen] = useState(false);
  const tpSlCapabilityQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.entryTpSl.list(accountId, 'open'),
    queryFn: ({ signal }) => getAccountEntryTpSlPlans(accountId, 'open', signal),
    enabled: accountKnown && side === 'buy' && orderMethod === 'limit',
    staleTime: 30_000,
    retry: false,
  });
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
    reportQuestCommand: ReturnType<typeof captureQuestGuideCommand>;
    accountId: string;
    epoch: number;
    revision: number;
    seasonUi: boolean;
    payload: Parameters<typeof quoteTradingAccountOrder>[1];
    entryTpSl?: EntryTpSlDraftDto[];
  };
  const orderActionRef = useRef<QuotedAction<
    OrderRequest,
    OrderQuoteDto
  > | null>(null);
  const submitLockRef = useRef(false);
  const tpSlPermission = useRef(false);
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
    enabled: accountKnown,
  });
  const tickerUrl = useMemo(() => buildWsUrl('/api/v1/ws'), []);
  const { latestTicker, runtime: tickerRuntime } = useAssetTicker({
    assetId,
    wsUrl: tickerUrl ?? '',
    enabled: enabled && !!tickerUrl,
  });
  useStaleRecheck(enabled, () => setQuoteNow(Date.now()));

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
            ...(request.entryTpSl ? { entryTpSl: request.entryTpSl } : {}),
            ...(request.payload.orderType === 'limit'
              ? { orderType: 'limit' as const, limitPrice: quote.limitPrice }
              : {}),
            // Quote and create carry the same LOC flag; absent otherwise.
            ...(request.payload.limitOnClose ? { limitOnClose: true as const } : {}),
            // LOC SELL accepted less than asked: keep what was asked (display only).
            ...(request.payload.limitOnClose && quote.quantityAdjustment
              ? { requestedQuantity: quote.quantityAdjustment.requestedQuantity }
              : {}),
          }),
        isCurrent: () => isActionCurrent(action.request) && (!action.request.entryTpSl?.length || tpSlPermission.current),
      }),
    retry: false,
    onSettled: () => {
      submitLockRef.current = false;
    },
    onSuccess: async (data, action) => {
      if (!data) return;
      const createdOrderId = data.result?.order?.orderId ?? data.result?.order?.id;
      const executed = data.result?.execution?.state === 'executed' || data.result?.execution?.state === 'already_executed';
      // An open limit/LOC order is watched app-wide for its later real fill.
      if (createdOrderId && data.result?.execution?.state === 'submitted')
        emitOrderFillEvent({ kind: 'order', accountId: action.request.accountId, orderId: createdOrderId });
      if (isActionCurrent(action.request)) {
        if (isOrderSuccess(data.result)) {
          const orderId = createdOrderId;
          const claimed = !!orderId && action.request.reportQuestCommand({ kind: 'spot', accountId: action.request.accountId,
            orderId, assetId, assetType: data.quote.asset.assetType ?? asset?.assetType ?? '', side: action.request.payload.side,
            orderType: action.request.payload.limitOnClose ? 'loc' : action.request.payload.orderType ?? 'market', summary: '주문 결과가 서버에서 확인됐어요.' });
          if (!claimed) setSuccessState(captureOrderSuccess(data.result, data.quote));
          setOrderInput('');
          setTpSlDrafts([]);
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
      } else if (executed && createdOrderId) {
        // The form that would show the detailed result is gone: the confirmed
        // execution is announced by the app-wide banner instead.
        emitOrderFillEvent({ kind: 'filled', accountId: action.request.accountId,
          order: { ...data.result.order, orderId: createdOrderId, executedAt: data.result.order.executedAt ?? data.result.execution.executedAt } });
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
      // The server's learning stage moved on (or the gate was stale): re-read it.
      if (code === ERROR_CODE.BEGINNER_FEATURE_LOCKED)
        void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.quests(action.request.accountId) });
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
    setOrderMethod(DEFAULT_ORDER_METHOD);
    setMethodSheetOpen(false);
    setTpSlDrafts([]);
    setTpSlSheetOpen(false);
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
  // Domestic and US stocks use the A-2 order card: this column keeps the
  // inputs, and the expected order is drawn in the card's right column.
  // Crypto keeps its form beside the live order book unchanged.
  const stockLayout = isStock;
  // Server answers whether NEW conditional/LOC orders may be created; the
  // live watch list doubles as the app-wide fill watcher's (same cache entry).
  const conditionalQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.conditionalBuy.list(accountId, { history: false, limit: 100 }),
    queryFn: ({ signal }) => getConditionalBuyOrders(accountId, { limit: 100 }, signal),
    enabled: accountKnown && side === 'buy' && (isStock || asset?.assetType === 'crypto'),
    retry: 1,
  });
  // LOC (stocks) and the SELL limit (stocks and Spot crypto) are server-gated.
  const orderCapabilitiesQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.orderCapabilities(accountId),
    queryFn: ({ signal }) => getTradingAccountOrderCapabilities(accountId, signal),
    enabled: accountKnown && (isStock || (side === 'sell' && asset?.assetType === 'crypto')),
    retry: 1,
    staleTime: 30_000,
  });
  // SELL intents (conditions, independent stop-loss/take-profit): the live
  // list carries the server gates and doubles as the fill watcher's entry.
  const sellIntentsQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.conditionalSell.list(accountId, { history: false, limit: 100 }),
    queryFn: ({ signal }) => getConditionalSellOrders(accountId, { limit: 100 }, signal),
    enabled: accountKnown && side === 'sell' && (isStock || asset?.assetType === 'crypto'),
    retry: 1,
  });
  const conditionalCapabilities = conditionalQuery.data?.tradingAccountId === accountId ? conditionalQuery.data.capabilities : null;
  const sellIntentData = sellIntentsQuery.data?.tradingAccountId === accountId ? sellIntentsQuery.data : null;
  const capabilityData = orderCapabilitiesQuery.data?.tradingAccountId === accountId ? orderCapabilitiesQuery.data : null;
  const methodOptions = getOrderMethodOptions(side === 'buy' ? {
    assetType: asset?.assetType,
    side,
    conditional: getConditionalBuyGate({ ...conditionalQuery, data: conditionalQuery.data?.tradingAccountId === accountId ? conditionalQuery.data : null }, asset?.assetType),
    loc: getLimitOnCloseGate({ ...orderCapabilitiesQuery, data: capabilityData }, asset?.assetType),
  } : {
    assetType: asset?.assetType,
    side,
    conditional: getConditionalSellGate({ ...sellIntentsQuery, data: sellIntentData }, asset?.assetType, 'condition'),
    loc: getLimitOnCloseSellGate({ ...orderCapabilitiesQuery, data: capabilityData }, asset?.assetType),
    limit: getLimitSellGate({ ...orderCapabilitiesQuery, data: capabilityData }),
  });
  const selectedMethodOption = methodOptions.find((option) => option.method === orderMethod) ?? null;
  const limitOption = methodOptions.find((option) => option.method === 'limit');
  const limitSelectable = !!limitOption && isOrderMethodSelectable(limitOption);
  // A method the server stopped allowing stays shown but cannot submit.
  const methodReady = !!selectedMethodOption && isOrderMethodSelectable(selectedMethodOption);
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
    !inputInvalidReason
      ? isAmountBuy
        ? amountBuyPreview(orderInput.trim(), tradeFeeRate)
        : orderPreview({
            side,
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
  // What a new sell can use (holding − other orders' reservations), as the
  // server reports it; null on an older server (then only the holding is known).
  const positionAvailable = getAccountPositionAvailableQuantity(positionQuery.data, assetId);
  const positionReserved = findAccountPosition(positionQuery.data, assetId)?.reservedQuantity ?? null;
  const sellCapacity = positionAvailable ?? positionQuantity;
  const automationForm = orderMethod === 'conditional';
  // 손절가/익절가 plans belong to an ordinary limit BUY of a market the server
  // lists (KRX, Spot crypto; US with its approved provider); never to LOC.
  const tpSlCapabilities = !tpSlCapabilityQuery.isError && tpSlCapabilityQuery.data?.tradingAccountId === accountId
    ? tpSlCapabilityQuery.data.capabilities.spot : null;
  const tpSlMarket = isEntryTpSlMarketSupported(tpSlCapabilities, asset?.assetType);
  const tpSlVisible = side === 'buy' && orderMethod === 'limit' && tpSlMarket && (!!tpSlCapabilities?.enabled || tpSlDrafts.length > 0);
  const tpSlAvailable = !!tpSlCapabilities?.canCreate;
  tpSlPermission.current = tpSlAvailable;


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
    stockMarketClosed && orderMethod === 'market'
      ? limitSelectable
        ? '정규장 외에는 시장가 주문을 할 수 없습니다. 지정가를 선택하면 다음 정규장을 기다리는 주문을 등록할 수 있습니다.'
        // The SELL limit is not available now, so nothing else is suggested.
        : '정규장 외에는 시장가 주문을 할 수 없습니다. 정규장에 다시 주문해주세요.'
      : stockMarketClosed && limitOnClose
        ? `LOC ${side === 'buy' ? '매수' : '매도'}는 정규장 중에만 등록할 수 있습니다. 서버가 등록 시점의 장 상태를 최종 확인합니다.`
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
          orderMethod === 'market' &&
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
          : side === 'sell' && !automationForm && Number(orderInput) > Number(positionQuantity)
            ? '보유 수량을 초과하여 매도할 수 없습니다.'
            : side === 'sell' && limitOnClose && positionAvailable !== null && Number(positionAvailable) < 1
              ? 'LOC 매도로 접수할 수 있는 수량이 없습니다. 다른 주문이 보유 수량을 예약하고 있습니다.'
              // A limit SELL reserves its quantity at submission: like a market
              // sell it can use only what other orders have not reserved.
              : side === 'sell' && (orderMethod === 'market' || orderMethod === 'limit') && positionAvailable !== null
                && Number(orderInput) > Number(positionAvailable)
                ? '매도 가능 수량을 초과했습니다. 다른 주문이 예약한 수량은 매도할 수 없습니다.'
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
  const sellCapacityValue = parsePositiveDecimal(sellCapacity);

  const ratioDisabledReason = useMemo(() => {
    if (accountBlockedReason || assetHardBlockedReason)
      return accountBlockedReason ?? assetHardBlockedReason;
    if (side === 'sell') {
      if (positionQuery.isLoading) return '보유 수량을 확인하는 중입니다.';
      if (positionUnavailable) return '보유 수량을 확인할 수 없습니다.';
      if (!positionQuantityValue) return '보유 수량이 없습니다.';
      if (!sellCapacityValue) return '다른 주문이 예약해 매도 가능한 수량이 없습니다.';
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
    sellCapacityValue,
    ratioPriceValue,
    settlementCurrency,
    side,
    walletsQuery.data,
    walletsQuery.isError,
    walletsQuery.isLoading,
  ]);

  // Live pre-check while typing (the server's quote and order still decide):
  // a known total, fee included, above the AVAILABLE cash (balance - reserved)
  // is insufficient. An unknown price, fee or balance never claims the order
  // fits, and a retained (uncertain) attempt keeps its same-key retry because
  // its own debit may already be reflected in the balance.
  const buyInsufficientReason =
    side === 'buy' && !inputInvalidReason && !orderActionRef.current &&
    !walletsQuery.isError && !!walletsQuery.data && exceedsAvailable(preview?.totalAmount, buyAvailable)
      ? '잔액이 부족합니다.'
      : null;

  // Beginner learning access mirrors the server (B차): conditional, LOC and a
  // user's own limit SELL need every quest complete; a market SELL stays risk
  // reduction; a BUY is open only at its quest's step (crypto market/limit,
  // Korean/US stock market) until then.
  const advancedGate = learning.gate('allTrading');
  // A crypto 손절가/익절가 opens with the TP/SL practice step (QUEST 04).
  const protectionGate = learning.gate(asset?.assetType === 'crypto' ? 'spotProtection' : 'allTrading');
  const marketBuyAction = asset?.assetType === 'crypto' ? 'cryptoMarketBuy'
    : asset?.assetType === 'domestic_stock' ? 'krStockMarketBuy' : asset?.assetType === 'us_stock' ? 'usStockMarketBuy' : 'allTrading';
  const limitGate = learning.gate(side === 'buy' && asset?.assetType === 'crypto' ? 'cryptoLimitBuy' : 'allTrading');
  const tradeGate = automationForm || limitOnClose ? advancedGate : orderType === 'limit' ? limitGate
    : learning.gate(side === 'sell' ? 'riskReduction' : marketBuyAction);
  const methodGate = (method: OrderMethod) =>
    method === 'market' ? learning.gate('riskReduction') : method === 'limit' ? limitGate : advancedGate;
  // The ordinary submit serves market/limit/LOC.
  const canExecute =
    methodReady &&
    !automationForm &&
    !preOrderBlockedReason &&
    !inputInvalidReason &&
    !buyInsufficientReason &&
    !successData &&
    !orderActionRef.current?.completed;
  useTradingGuideFacts({ screen: 'order', accountId, assetId, assetType: asset?.assetType, side, orderType: orderMethod, methodSheetOpen, amountValid: !inputInvalidReason && !buyInsufficientReason, canExecute, pending: orderPending, blocked: !!preOrderBlockedReason }, enabled);
  const inputErrorMessage =
    fieldError ?? (orderInput.trim() ? inputInvalidReason : null);

  // Stock ratios retain their existing fee buffer; crypto uses the server's
  // fee policy and writes gross amount, never a client execution quantity.
  const quantityAtRatio = (ratio: number) =>
    side === 'sell'
      ? (sellCapacityValue ?? 0) * ratio
      : ((buyAvailableValue ?? 0) * ratio) /
        // Never below the real fee, so 100% stays within the live balance check.
        ((ratioPriceValue ?? 0) * (1 + Math.max(BUY_FEE_BUFFER, Number(tradeFeeRate) || 0)));
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
    if (!tradeGate.allowed && !orderActionRef.current) { tradeGate.guard(() => undefined); return; }
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
    const plans = side === 'buy' && orderMethod === 'limit' ? tpSlDrafts : [];
    if (!orderActionRef.current && plans.length && !tpSlPermission.current) { setFieldError('현재 손절가/익절가를 함께 등록할 수 없어요. 설정을 지우고 주문해 주세요.'); return; }
    const plansError = !orderActionRef.current && plans.length ? getDraftTpSlError(plans, 'long', limitPrice.trim()) : null;
    if (plansError) { setFieldError(`손절가/익절가 설정을 확인해 주세요. ${plansError}`); return; }
    orderActionRef.current ??= {
      request: {
        accountId,
        reportQuestCommand: captureQuestGuideCommand(),
        epoch: scopeRef.current.epoch,
        revision: quoteRevisionRef.current,
        seasonUi: capabilities?.isSeason ?? false,
        ...(plans.length ? { entryTpSl: plans } : {}),
        payload: {
          assetId,
          side,
          ...(isAmountBuy
            ? { amount: orderInput.trim() }
            : { quantity: orderInput.trim() }),
          ...(orderType === 'limit'
            ? { orderType: 'limit', limitPrice: limitPrice.trim() }
            : {}),
          ...(limitOnClose ? { limitOnClose: true } : {}),
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
  const selectMethod = (next: OrderMethod) => {
    const option = methodOptions.find((item) => item.method === next);
    if (!option || !isOrderMethodSelectable(option)) return;
    methodGate(next).guard(() => {
      setMethodSheetOpen(false);
      if (next === orderMethod) return;
      // A new method never inherits the previous method's draft or quote.
      resetInput(() => {
        setOrderMethod(next);
        setOrderInput('');
        setLimitPrice('');
        setTpSlDrafts([]);
      });
    });
  };
  const ordinaryForm = orderMethod === 'market' || orderMethod === 'limit' || orderMethod === 'loc';
  const methodUnavailableReason = selectedMethodOption?.availability.state === 'unavailable'
    ? selectedMethodOption.availability.reason
    : !methodReady ? '이 주문방식은 지금 이용할 수 없어요.' : null;
  const locPreview = limitOnClose ? quotedPreview?.limitOnClose ?? null : null;
  const sellSettingBlockedReason = accountBlockedReason ?? assetHardBlockedReason ?? methodUnavailableReason
    ?? (positionQuery.isLoading ? '보유 수량을 확인하는 중입니다.'
      : positionUnavailable ? '보유 수량을 확인할 수 없어 매도 설정을 등록할 수 없습니다.'
      : Number(positionQuantity) <= 0 ? '보유 수량이 없어 매도 설정을 등록할 수 없습니다.' : null);
  // A-2 order card (stocks): the expected order before anything is sent. The
  // badge is the expected handling under the current session (a limit order
  // while the market is closed waits for the regular session), never an
  // accepted or filled state; amounts are the same preview/quote as before.
  const maxQuantity = side === 'buy' && !isAmountBuy && !ratioDisabledReason ? inputAtRatio(1) : null;
  const summaryBadge = stockLayout ? getOrderSummaryBadge(asset.marketStatus, orderMethod) : null;
  // An order the session does not accept (주문 불가) shows no amounts, as before.
  const summaryPreview = summaryBadge?.tone === 'error' ? null : preview;
  const summaryPrice = orderType === 'limit'
    ? limitPriceInvalidReason ? '-' : formatEnteredAmount(limitPrice.trim(), asset.settlementCurrency)
    : '시장가';
  const summaryQuantityValue = quotedPreview?.quantity ?? (validateQuantity(orderInput) ? null : orderInput.trim());
  const summaryQuantity = summaryQuantityValue ? `${formatEnteredAmount(summaryQuantityValue, null)}주` : '-';
  const totalLabel = side === 'sell' ? '예상 수령액' : orderType === 'limit' ? '예상 예약금액' : '예상 결제금액';
  // 주문 후 사용 가능 is a BUY row only (2026-10-18): a SELL card ends at 예상
  // 수령액. The sellable quantity and its checks (sellCapacity) are unchanged.
  const remaining = side === 'buy' && summaryPreview && buyAvailable !== null && !walletsQuery.isError
    ? decimalDifference(buyAvailable, summaryPreview.totalAmount) : null;
  const summaryAfter = side === 'buy' ? {
    label: '주문 후 사용 가능',
    testID: 'order-summary-after',
    value: remaining === null ? '-'
      : remaining.isNegative() ? '부족' : formatPreviewMoney(remaining.toFixed(), asset.settlementCurrency),
    short: !!remaining?.isNegative(),
  } : null;
  // Why there is no expected amount yet, and the reads that would give one.
  const previewProblem = (
    <>
      <Text style={styles.warningText}>{previewNotice}</Text>
      {orderMethod === 'market' && !previewPriceAvailable && !assetWarningReason ? (
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
      {orderMethod === 'market' && !previewPriceAvailable ? (
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
  );
  const summaryHint = stockMarketClosed && orderMethod !== 'limit' ? null
    : orderType === 'limit' && (!limitPrice.trim() || !orderInput.trim()) ? '가격과 수량을 입력하면 예상 금액을 보여 드려요.'
      : !orderInput.trim() ? '수량을 입력하면 예상 금액을 보여 드려요.' : null;
  return (
    <View style={styles.panel} testID={TEST_IDS.order.screen}>
      <QuestTarget id="order-type"><OrderTypeSelect
        method={orderMethod}
        options={methodOptions}
        disabled={pending}
        open={methodSheetOpen && !pending}
        onOpen={() => setMethodSheetOpen(true)}
        onClose={() => setMethodSheetOpen(false)}
        onSelect={selectMethod}
        learningHints={{
          limit: limitGate.locked ? limitGate.message : null,
          conditional: advancedGate.locked ? advancedGate.message : null,
          loc: advancedGate.locked ? advancedGate.message : null,
        }}
      /></QuestTarget>
      {orderMethod === 'conditional' && side === 'buy' ? (
        <ConditionalBuyForm
          accountId={accountId}
          asset={asset}
          capabilities={conditionalCapabilities}
          blockedReason={accountBlockedReason ?? assetHardBlockedReason ?? methodUnavailableReason}
          // Unknown (loading or failed) is not "nothing available".
          buyAvailable={walletsQuery.isError || !walletsQuery.data ? null : buyAvailable}
          feeRate={tradeFeeRate ?? null}
          currentPrice={previewPriceAvailable ? displayPrice.priceLocal : null}
          marketStatus={asset.marketStatus ?? null}
          learning={advancedGate}
          onInputFocus={onInputFocus}
          onInputBlur={onInputBlur}
          onRefreshPrice={() => void assetQuery.refetch()}
        />
      ) : null}
      {orderMethod === 'conditional' && side === 'sell' ? (
        <SellIntentForm
          key={orderMethod}
          accountId={accountId}
          asset={asset}
          capabilities={sellIntentData?.capabilities ?? null}
          blockedReason={sellSettingBlockedReason}
          holding={positionQuery.isLoading || positionUnavailable ? null : positionQuantity}
          available={positionQuery.isLoading || positionUnavailable ? null : positionAvailable}
          reserved={positionReserved}
          currentPrice={previewPriceAvailable ? displayPrice.priceLocal : null}
          marketStatus={asset.marketStatus ?? null}
          learning={advancedGate}
          onInputFocus={onInputFocus}
          onInputBlur={onInputBlur}
          onRefreshPrice={() => void assetQuery.refetch()}
        />
      ) : null}
      {ordinaryForm ? (
        <>
      <View style={styles.group}>
        <Text style={styles.label}>
          {limitOnClose ? 'LOC 지정가격' : '가격'} ({asset.settlementCurrency})
        </Text>
        {orderType === 'limit' ? (
          <OrderNumberInput
            testID={TEST_IDS.order.limitPriceInput}
            accessibilityLabel={`${limitOnClose ? 'LOC 지정가격' : '지정가 가격'} ${asset.settlementCurrency}`}
            editable={!pending}
            style={styles.input}
            value={limitPrice}
            onChangeText={(value) => resetInput(() => setLimitPrice(value))}
            keyboardType="decimal-pad"
            placeholder={limitOnClose ? '지정가격 입력' : '지정가 입력'}
            onFieldFocus={onInputFocus}
            onBlur={onInputBlur}
          />
        ) : (
          <Text style={styles.marketPrice}>시장가</Text>
        )}
      </View>
      <View ref={questGuideTarget('order-input')} collapsable={false} style={styles.group}>
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
          unit={stockLayout ? '주' : undefined}
          onFieldFocus={onInputFocus}
          onBlur={onInputBlur}
        />
      </View>
      {limitOnClose ? (
        <View style={styles.notice} testID="loc-order-notice">
          <Text testID="loc-reservation" style={styles.noticeLine}>
            {side === 'buy'
              ? '접수할 때 지정가 × 수량 + 수수료를 예약해요. 기한까지 체결되지 않으면 예약금이 해제돼요.'
              : '접수할 때 매도 수량만큼 보유 수량을 예약해요. 기한까지 체결되지 않으면 예약 수량이 해제돼요.'}
          </Text>
          {side === 'sell' && positionAvailable !== null && Number(orderInput) > Number(positionAvailable)
            && Number(orderInput) <= Number(positionQuantity) && Number(positionAvailable) >= 1 ? (
            <Text testID="loc-sell-adjust-notice" style={styles.warningText}>
              다른 주문이 예약한 수량({formatDisplayDecimal(positionReserved)})을 제외한 매도 가능 수량({formatDisplayDecimal(positionAvailable)})만 접수돼요.
            </Text>
          ) : null}
          {locPreview ? (
            <Text testID="loc-quote-session" style={styles.noticeLine}>
              {asset?.assetType === 'us_stock'
                // A New York session date beside Korean times: both labelled.
                ? `대상 세션 ${locPreview.sessionDate}(미국 현지) · 정규장 마감 ${formatKstDateTime(locPreview.sessionCloseAt)} · 판정 기한 ${formatKstDateTime(locPreview.evidenceDeadlineAt)}(한국시간)`
                : `대상 세션 ${locPreview.sessionDate} · 정규장 마감 ${formatKstDateTime(locPreview.sessionCloseAt)} · 판정 기한 ${formatKstDateTime(locPreview.evidenceDeadlineAt)}`}
            </Text>
          ) : null}
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
          tint={stockLayout ? side === 'buy' ? BUY_COLOR : SELL_COLOR : undefined}
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
        </>
      ) : null}
      {!automationForm && stockLayout ? (
        <View style={styles.capacity} testID="order-available-helper">
          {side === 'buy' ? (
            <>
              <SummaryRow testID="order-available-amount" label="주문 가능"
                value={`${walletsQuery.isError ? '-' : formatCurrency(buyAvailable, settlementCurrency)} ${settlementCurrency ?? ''}`.trim()} />
              <SummaryRow testID="order-max-quantity" label="최대 수량"
                value={maxQuantity ? `${formatEnteredAmount(maxQuantity, null)}주` : '-'} />
            </>
          ) : (
            <>
              <SummaryRow testID="order-sell-capacity" label="매도 가능"
                value={positionQuery.isLoading || positionUnavailable ? '-' : `${formatEnteredAmount(sellCapacity, null)}주`} />
              {positionReserved !== null && Number(positionReserved) > 0 ? (
                <SummaryRow testID="order-sell-reserved" label="다른 주문 예약" value={`${formatEnteredAmount(positionReserved, null)}주`} />
              ) : null}
            </>
          )}
        </View>
      ) : !automationForm ? (
        <Text style={styles.helper} testID="order-available-helper">
          {side === 'buy'
            ? `주문 가능 ${walletsQuery.isError ? '-' : formatCurrency(buyAvailable, settlementCurrency)} ${settlementCurrency ?? ''}`
            : positionAvailable !== null && positionReserved !== null && Number(positionReserved) > 0
              ? `보유 ${formatDisplayDecimal(positionQuantity)} · 매도 가능 ${formatDisplayDecimal(positionAvailable)} (다른 주문 예약 ${formatDisplayDecimal(positionReserved)})`
              : `보유 ${formatDisplayDecimal(positionQuantity)}`}
        </Text>
      ) : null}
      {/* After the amount controls: plans ride on the new limit BUY (activated by its fill). */}
      {tpSlVisible ? (
        <View style={styles.group} testID="order-tp-sl">
          <TpSlButton testID="order-tp-sl-button" summary={tpSlCountSummary(tpSlDrafts)} disabled={pending}
            learningHint={protectionGate.locked ? protectionGate.message : null}
            onPress={() => protectionGate.guard(() => setTpSlSheetOpen(true))} />
          {!tpSlAvailable ? <Text style={styles.helper}>현재 손절가/익절가를 새로 등록할 수 없어요.</Text> : null}
          <TpSlDraftSheet
            visible={tpSlSheetOpen && !pending && enabled}
            onClose={() => setTpSlSheetOpen(false)}
            scopeKey={`${accountId}:${assetId}`}
            drafts={tpSlDrafts}
            onChange={(drafts) => resetInput(() => setTpSlDrafts(drafts))}
            direction="long"
            entryPrice={limitPriceInvalidReason ? null : limitPrice.trim()}
            expectedQuantity={isAmountBuy ? estimatedQuantity ?? null : inputInvalidReason ? null : orderInput.trim()}
            scale={6}
            unit={asset.assetType === 'crypto' ? (asset.symbol ?? '').replace(/USDT$/u, '') : '주'}
            currency={asset.settlementCurrency ?? ''}
            blockedReason={tpSlAvailable ? null : '현재 손절가/익절가를 새로 등록할 수 없어요.'}
          />
        </View>
      ) : null}
      {methodUnavailableReason && !automationForm ? (
        <Text testID="order-method-unavailable" style={styles.errorText}>{methodUnavailableReason}</Text>
      ) : null}
      {buyInsufficientReason ? (
        <Text testID="order-balance-insufficient" accessibilityLiveRegion="polite" style={styles.errorText}>
          {buyInsufficientReason}
        </Text>
      ) : null}
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
      {ordinaryForm && stockLayout ? (
        <OrderAsidePortal name="preview">
          <OrderSummaryCard targetRef={questGuideTarget('order-preview')} badge={summaryBadge}
            rows={[
              { label: '주문 가격', value: summaryPrice, testID: 'order-summary-price' },
              { label: '수량', value: summaryQuantity, testID: 'order-summary-quantity' },
            ]}
            fee={{ label: '예상 수수료', value: summaryPreview ? formatPreviewMoney(summaryPreview.feeAmount, asset.settlementCurrency) : '-', testID: 'order-summary-fee' }}
            total={{ label: totalLabel, value: summaryPreview ? formatPreviewMoney(summaryPreview.totalAmount, asset.settlementCurrency) : '-', testID: 'order-summary-total' }}
            after={summaryAfter}
          >
            {summaryHint ? <Text style={asideStyles.stateText}>{summaryHint}</Text> : null}
            {!preview && !inputInvalidReason && summaryBadge?.tone !== 'error' ? previewProblem : null}
          </OrderSummaryCard>
        </OrderAsidePortal>
      ) : null}
      {ordinaryForm && !stockLayout && !(stockMarketClosed && orderMethod === 'market') ? (
        <>
          {!inputInvalidReason ? (
            <View ref={questGuideTarget('order-preview')} collapsable={false} style={styles.preview} testID="order-indicative-preview">
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
                      side === 'sell' ? '예상 수령액' : orderType === 'limit' ? '예상 예약금액' : '예상 결제금액'
                    }
                    value={formatPreviewMoney(
                      preview.totalAmount,
                      asset.settlementCurrency,
                    )}
                  />
                </>
              ) : (
                previewProblem
              )}
            </View>
          ) : null}
        </>
      ) : null}
      {!automationForm ? <View ref={submitRef} collapsable={false}><QuestTarget id="order-submit">
        <CTAButton
          testID={TEST_IDS.order.executeSubmit}
          label={stockLayout ? side === 'buy' ? '매수 주문' : '매도 주문' : side === 'buy' ? '매수' : '매도'}
          // 예상 주문 is in the card's right column, read after this button.
          accessibilityHint={stockLayout && summaryPreview ? `${totalLabel} ${formatPreviewMoney(summaryPreview.totalAmount, asset.settlementCurrency)}` : undefined}
          style={side === 'buy' ? styles.buyActive : styles.sellActive}
          state={pending ? 'loading' : canExecute ? 'enabled' : 'disabled'}
          learningHint={tradeGate.locked ? tradeGate.message : null}
          onPress={submitOrder}
        />
      </QuestTarget></View> : null}
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
  capacity: { gap: 4, minWidth: 0 },
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
  notice: { gap: 4, padding: 10, borderRadius: 10, backgroundColor: semantic.raised, minWidth: 0 },
  noticeLine: { fontSize: 12, lineHeight: 17, color: semantic.secondary },
});
