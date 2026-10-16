import { useTradingGuideFacts } from '../../features/quest/useTradingGuideFacts';
import { useLearningAccess } from '../../features/quest/useLearningAccess';
import { useQuestGuide } from '../../features/quest/QuestGuideProvider';
import { captureQuestGuideCommand, questGuideTarget, registerQuestGuideReveal } from '../../features/quest/questGuideBridge';
import QuestTarget from '../../features/quest/QuestTarget';
import FuturesLimitEntryForm from './FuturesLimitEntryForm';
import FuturesConditionalEntryForm, {
  FuturesConditionalFields,
  emptyFuturesConditionalDraft,
  type FuturesConditionalDraft,
} from './FuturesConditionalEntryForm';
import FuturesCandleChart from './FuturesCandleChart';
import FuturesInstrumentSheet from './FuturesInstrumentSheet';
import FuturesAmountField from './FuturesAmountField';
import FuturesLeverageSelect, { type FuturesLeverageSheet } from './FuturesLeverageSelect';
import FuturesMarginModeField from './FuturesMarginModeField';
import PendingOrders from '../asset/PendingOrders';
import OrderSideSegment from '../order/OrderSideSegment';
import OrderTypeSelect from '../order/OrderTypeSelect';
import OrderNumberInput, { orderInputStyle } from '../order/OrderNumberInput';
import React, { useEffect, useRef, useState } from "react";
import TpSlSheet, { type TpSlTarget } from "../../features/conditional/tpsl/TpSlSheet";
import { tpSlCountSummary } from "../../features/conditional/tpSlModel";
import { getFuturesTpSlSettings } from "../../features/futures/tpSlApi";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "../../theme/native";
import Svg, { Path } from 'react-native-svg';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useIsFocused } from "@react-navigation/native";
import { useHeaderHeight } from "@react-navigation/elements";
import type { FuturesScreenProps } from "../../app/navigation/types";
import { useTradingAccount } from "../../features/tradingAccount/TradingAccountContext";
import { resolveAccountBinding } from "../../features/tradingAccount/accountBinding";
import { getTradingAccount } from "../../features/tradingAccount/api";
import { QUERY_KEYS } from "../../constants/queryKeys";
import {
  executeFutures,
  getFuturesConditionalEntries,
  getFuturesInstruments,
  getFuturesPositions,
  getFuturesFinalSettlement,
  type Direction,
  type MarginMode,
  type Operation,
  type FuturesCommand,
  type FuturesInstrument,
} from "../../features/futures/api";
import {
  freshFuturesEvaluation,
  freshFuturesEvidence,
  freshFuturesReference,
  futuresPriceBasisLabel,
  futuresServerNow,
  futuresActionAllowed,
  futuresInputError,
  positionCommand,
} from "../../features/futures/policy";
import { COLLATERAL_SHORT, MAINTENANCE_SHORT, futuresErrorMessage } from "../../features/futures/orderFeedback";
import {
  futuresAmountAtRatio,
  futuresAmountExceeds,
  futuresAmountRatio,
  futuresEntryCapacity,
  futuresEntryEstimate,
  futuresNotional,
  futuresPrice,
  futuresQuantityForAmount,
  futuresWholePosition,
} from "../../features/futures/orderSizing";
import {
  DEFAULT_ORDER_METHOD,
  getFuturesConditionalGate,
  getFuturesOrderMethodOptions,
  isOrderMethodSelectable,
  type OrderMethod,
} from '../../features/order/orderMethods';
import { BUY_COLOR, SELL_COLOR } from '../../features/order/sideColors';
import {
  getSessionGeneration,
  isCurrentSession,
} from "../../services/api/sessionOwnership";
import { getApiErrorInfo } from "../../services/api/errorMapper";
import { createIdempotencyKey } from "../../utils/idempotency";
import { formatAssetPrice, formatDisplayDecimal, formatUsd } from "../../utils/format";
import { useFocusedInputScroll } from "../../hooks/useFocusedInputScroll";
import { getScreenContentStyle } from "../../theme/screenLayout";
import { semantic } from "../../theme/tokens";
import { useAppearance } from '../../theme/appearance';
import CTAButton from "../../components/common/CTAButton";
import ActionPressable from "../../components/common/ActionPressable";
import SegmentedControl from '../../components/common/SegmentedControl';
import ErrorNotice from "../../components/states/ErrorNotice";
import ErrorState from "../../components/states/ErrorState";
import FullPageLoading from "../../components/states/FullPageLoading";
import FuturesPositionCard from './FuturesPositionCard';
import FuturesOrderBookCard from './FuturesOrderBookCard';

export default function FuturesScreen(props: FuturesScreenProps) {
  return <BoundFuturesScreen key={`${props.route.params.accountId}:${props.route.params.instrumentId ?? ""}:${getSessionGeneration()}`} {...props} />;
}

type ListView = 'positions' | 'pending';
/** RN and RN-web ScrollView: the content container (absent from RN's legacy typings). */
type InnerViewScroll = { getInnerViewRef?: () => View | null };

/**
 * The futures trading screen, laid out like the spot order screen: the
 * contract header (picker, 무기한, chart), its Last and Mark prices, then one
 * row with the trade form on the left (롱/숏, margin mode and leverage,
 * 주문방식, the USD order amount and its ratio, submit) and the contract's book
 * on the right — side by side on every phone width — then the positions and
 * pending views (records are in the central 거래 내역). The amount is the position's USD
 * notional; it becomes the contract quantity the existing commands take.
 * Futures keeps its own financial rules: execution on Futures Last, valuation
 * and liquidation on Mark, an individual liquidation price for isolated
 * positions only.
 */
export function BoundFuturesScreen({ route, navigation }: FuturesScreenProps) {
  const accountId = route.params.accountId;
  const learning = useLearningAccess(accountId);
  const guide = useQuestGuide();
  const { colors } = useAppearance();
  const { width, fontScale } = useWindowDimensions();
  const { accounts, selectedAccountId, isLoading, isError, error, refetchAccounts } = useTradingAccount();
  const binding = resolveAccountBinding({
    boundAccountId: accountId,
    selectedAccountId,
    accounts,
    accountsLoading: isLoading,
  });
  const bound = binding.state === "bound";
  const focused = useIsFocused();
  const queryClient = useQueryClient();
  const inputScroll = useFocusedInputScroll();
  const { revealView } = inputScroll;
  useEffect(() => { registerQuestGuideReveal('futures', node => revealView(node, 'start')); return () => { registerQuestGuideReveal('futures', null); }; }, [revealView]);
  const headerHeight = useHeaderHeight();
  // A position card's action brings the trade form to the top, measured after
  // the commit that selected it, as a position inside the content: a browser
  // may shift the scroll offset itself when the content above changes size.
  const tradeRow = useRef<View>(null);
  const [tradeReveal, setTradeReveal] = useState(0);
  const { scrollRef } = inputScroll;
  useEffect(() => {
    const scroll = scrollRef.current, row = tradeRow.current;
    const content = (scroll as unknown as InnerViewScroll | null)?.getInnerViewRef?.();
    if (!tradeReveal || !scroll || !row || !content) return;
    row.measureLayout(content, (_x, y) => scroll.scrollTo({ y: Math.max(0, y - 12), animated: true }), () => undefined);
  }, [tradeReveal, scrollRef]);
  const [, setClock] = useState(Date.now());
  const clock = Date.now();
  const [selectedId, setSelectedId] = useState(route.params.instrumentId ?? "");
  const [instrumentSheetOpen, setInstrumentSheetOpen] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
  const [direction, setDirection] = useState<Direction>("long");
  const [marginMode, setMarginMode] = useState<MarginMode>("isolated");
  const [leverage, setLeverage] = useState("1");
  const [leverageSheet, setLeverageSheet] = useState<FuturesLeverageSheet>(null);
  // The USD order amount: the notional to open, add or reduce (never contracts).
  const [amount, setAmount] = useState("");
  // The quick ratio the amount was written from (kept through cent rounding).
  const [chosenRatio, setChosenRatio] = useState<number | null>(null);
  const [ratioMessage, setRatioMessage] = useState<string | null>(null);
  // Like the spot order form, every contract starts at 시장가.
  const [method, setMethod] = useState<OrderMethod>(DEFAULT_ORDER_METHOD);
  const [methodSheetOpen, setMethodSheetOpen] = useState(false);
  const [limitPrice, setLimitPrice] = useState("");
  const [limitBusy, setLimitBusy] = useState(false);
  const [conditionalDraft, setConditionalDraft] = useState<FuturesConditionalDraft>(emptyFuturesConditionalDraft);
  const [conditionalBusy, setConditionalBusy] = useState(false);
  // The one position card whose TP/SL panel is open.
  const [tpSlTarget, setTpSlTarget] = useState<TpSlTarget | null>(null);
  const [operation, setOperation] = useState<Operation>("open");
  const [failure, setFailure] = useState<unknown>(null);
  const [collateralAttempted, setCollateralAttempted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [listView, setListView] = useState<ListView>('positions');
  const scope = useRef({ key: "", epoch: 0, mounted: true });
  const session = getSessionGeneration();
  const scopeKey = `${accountId}:${selectedAccountId}:${bound}:${session}`;
  if (scope.current.key !== scopeKey)
    scope.current = {
      key: scopeKey,
      epoch: scope.current.epoch + 1,
      mounted: true,
    };
  const action = useRef<{
    reportQuestCommand: ReturnType<typeof captureQuestGuideCommand>;
    signature: string;
    command: FuturesCommand;
    epoch: number;
    session: number;
    uncertain?: boolean;
  } | null>(null);
  const submitLock = useRef(false);
  useEffect(() => {
    scope.current.mounted = true;
    return () => {
      scope.current.mounted = false;
    };
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const instruments = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.instruments(accountId),
    queryFn: ({ signal }) => getFuturesInstruments(accountId, signal),
    enabled: bound && focused,
    refetchInterval: 2000,
    retry: false,
  });
  const positions = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.positions(accountId),
    queryFn: ({ signal }) => getFuturesPositions(accountId, signal),
    enabled: bound && focused,
    refetchInterval: 2000,
    retry: false,
  });
  // Live conditional entries; their capabilities gate a new 조건주문.
  const conditionalEntries = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.conditionalEntries(accountId, 'open'),
    queryFn: ({ signal }) => getFuturesConditionalEntries(accountId, 'open', signal),
    enabled: bound && focused,
    refetchInterval: 4000,
    retry: false,
  });
  // Live independent 손절가/익절가 of the open lifetimes (counts on the cards).
  const tpSl = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.tpSl(accountId, 'open'),
    queryFn: ({ signal }) => getFuturesTpSlSettings(accountId, 'open', signal),
    enabled: bound && focused,
    refetchInterval: 4000,
    retry: false,
  });
  const tpSlRows = !tpSl.isError && tpSl.data?.tradingAccountId === accountId ? tpSl.data.settings : null;
  const final = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.finalSettlement(accountId),
    queryFn: ({ signal }) => getFuturesFinalSettlement(accountId, signal),
    enabled: bound && focused,
    retry: false,
  });
  // The account's trade fee rate, the policy the server charges (shared with
  // the spot order form's cache entry). The ratio slider keeps room for it.
  const tradingAccount = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.detail(accountId),
    queryFn: () => getTradingAccount(accountId),
    enabled: bound,
  });
  const feeRate = !tradingAccount.isError && tradingAccount.data?.id === accountId
    ? tradingAccount.data.feePolicy?.tradeFeeRate ?? null
    : null;
  const current = (request: NonNullable<typeof action.current>) =>
    scope.current.mounted &&
    request.epoch === scope.current.epoch &&
    isCurrentSession(request.session);
  const mutation = useMutation({
    mutationFn: (request: NonNullable<typeof action.current>) =>
      executeFutures(accountId, request.command),
    onSuccess: (result, request) => {
      if (!isCurrentSession(request.session)) return;
      for (const queryKey of [
        QUERY_KEYS.tradingAccount.quests(accountId),
        QUERY_KEYS.tradingAccount.futures.all(accountId),
        QUERY_KEYS.tradingAccount.protections.all(accountId),
        QUERY_KEYS.tradingAccount.futuresCollateral(accountId),
        QUERY_KEYS.tradingAccount.walletsAll(accountId),
        QUERY_KEYS.tradingAccount.portfolioAll(accountId),
        QUERY_KEYS.ranking.all,
        QUERY_KEYS.record.all,
      ])
        void queryClient.invalidateQueries({ queryKey });
      if (!current(request)) return;
      const execution = result.execution;
      request.reportQuestCommand({ kind: 'futures', accountId, positionId: execution.positionId, direction: execution.direction, operation: execution.operation, leverage: execution.leverage, quantityAfter: execution.positionAfter.quantity, summary: '선물 실행 기록이 확인됐어요.' });
      action.current = null;
      setFailure(null);
      setAmount("");
      setChosenRatio(null);
      setNotice(
        `${operationLabel[result.execution.operation]} 체결 완료 · 수수료 $${formatUsd(result.execution.feeAmount)}`,
      );
    },
    onError: (error, request) => {
      if (current(request)) {
        setFailure(error);
        const info = getApiErrorInfo(error);
        // Only a lost or failed response may have executed: that one keeps its
        // key for the same-request check. A clear refusal (4xx) did not fill.
        request.uncertain = !info.hasResponse || (info.status ?? 0) >= 500;
        if (!request.uncertain) action.current = null;
        setNotice(futuresErrorMessage(info.serverCode, request.uncertain));
      }
    },
    onSettled: () => {
      submitLock.current = false;
    },
  });
  const pendingResult = !!action.current?.uncertain && current(action.current);
  const retryResult = () => {
    if (!action.current || !pendingResult || submitLock.current) return;
    submitLock.current = true;
    mutation.mutate(action.current);
  };
  const practicePosition = positions.data?.positions.find(p => p.id === guide?.active?.positionId)
    ?? positions.data?.positions.find(p => p.instrumentId === selectedId);
  useTradingGuideFacts({ screen: 'futures', accountId, direction, leverage: Number(leverage), marginMode,
    leverageSheet: leverageSheet ?? undefined,
    positionId: practicePosition?.id, positionDirection: practicePosition?.direction, pending: mutation.isPending,
    blocked: (guide?.active?.step === 5 ? positions.data?.capabilities.canClose : positions.data?.capabilities.canOpen) !== true }, focused && bound);
  if (binding.state === "loading")
    return <FullPageLoading message="선물 계정을 확인하고 있습니다." />;
  if (isError)
    return <ErrorState error={error} title="계정 정보를 불러오지 못했습니다." onRetry={() => void refetchAccounts()} />;
  if (!bound)
    return (
      <View style={[styles.card, styles.unbound]}>
        <Text style={styles.heading}>선택한 계정이 변경되었습니다.</Text>
        <Text style={styles.muted}>마켓에서 선물 상품을 다시 선택해주세요.</Text>
        <CTAButton label="마켓으로" onPress={() => navigation.navigate("Market")} />
      </View>
    );
  if (positions.isPending || instruments.isPending)
    return <FullPageLoading message="선물 정보를 불러오고 있습니다." />;
  // Do not render a previous successful financial value after a failed refresh.
  if (positions.isError || !positions.data)
    return (
      <ErrorState
        error={positions.error}
        title="선물 정보를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => void positions.refetch()}
      />
    );
  const data = positions.data;
  const allInstruments = instruments.isError
    ? []
    : (instruments.data?.instruments ?? []);
  const instrument =
    allInstruments.find((i) => i.id === selectedId) ??
    data.positions.find((p) => p.instrumentId === selectedId)?.instrument ??
    (selectedId ? undefined : allInstruments[0] ?? data.positions[0]?.instrument);
  const position = data.positions.find(
    (p) => p.instrumentId === instrument?.id,
  );
  const selectedOperation = position
    ? operation === "open"
      ? "increase"
      : operation
    : "open";
  // Each read is judged on its own server clock (evaluatedAt + time since the
  // request was sent), not on the device clock: a device a second or two ahead
  // of the server made a fresh Mark flash "Mark 확인 불가" before every poll.
  const positionsNow = futuresServerNow(data, clock);
  const instrumentsNow = futuresServerNow(instruments.data, clock);
  const timely = freshFuturesEvaluation(data.evaluatedAt, positionsNow);
  const crossFresh = data.positions
    .filter((p) => p.marginMode === "cross")
    .every(
      (p) =>
        p.markState === "fresh" && freshFuturesEvidence(p.markEvidence, positionsNow),
    );
  const markFresh =
    !!futuresPrice(position ? position.markPrice : instrument?.markPrice) &&
    timely &&
    crossFresh &&
    (position
      ? position.markState === "fresh" &&
        freshFuturesEvidence(position.markEvidence, positionsNow)
      : freshFuturesEvaluation(instruments.data?.evaluatedAt, instrumentsNow) &&
        instrument?.markState === "fresh" &&
        freshFuturesEvidence(instrument.markEvidence, instrumentsNow));
  const reference = position
    ? position.referencePrice
    : instrument?.referencePrice;
  const referenceFresh =
    !!reference &&
    freshFuturesReference(
      position
        ? position.referencePriceEvidence
        : instrument?.referencePriceEvidence,
      position ? positionsNow : instrumentsNow,
    );
  const selectedLeverage = position ? String(position.leverage) : leverage;
  const orderDirection = position?.direction ?? direction;
  const orderMarginMode = position?.marginMode ?? marginMode;
  const baseSymbol = instrument?.underlying.symbol.replace(/USDT$/u, "") ?? "";
  // The price an amount becomes contracts at: the current Futures Last for
  // 시장가, the entry price for 지정가, and for 조건주문 the watch (시장가 after
  // the trigger) or its limit price. Without a valid one nothing is converted.
  const marketPrice = futuresPrice(referenceFresh ? reference : null);
  const conditionalLimit = conditionalDraft.executionType === "limit";
  const basisPrice = method === "limit"
    ? futuresPrice(limitPrice)
    : method === "conditional"
      ? futuresPrice(conditionalLimit ? conditionalDraft.limitPrice : conditionalDraft.triggerPrice)
      : marketPrice;
  const unpriced = method === "limit"
    ? "진입 지정가를 입력하면 계약 수량을 계산합니다."
    : method === "conditional"
      ? conditionalLimit ? "주문가격(지정가)을 입력하면 계약 수량을 계산합니다." : "감시가격을 입력하면 계약 수량을 계산합니다."
      : "현재 선물 Last를 확인할 수 없어 계약 수량을 계산할 수 없습니다.";
  const sizing = selectedOperation === "close" ? null : futuresQuantityForAmount(amount, basisPrice, unpriced);
  // A reduce of the whole position is the existing full close.
  const wholePosition = selectedOperation === "reduce" && !!position && sizing?.state === "ready"
    && futuresWholePosition(sizing.quantity, position.quantity);
  const effectiveOperation: Operation = wholePosition ? "close" : selectedOperation;
  const selectedQuantity = selectedOperation === "close"
    ? (position?.quantity ?? "")
    : sizing?.state === "ready" ? sizing.quantity : "";
  const amountError = sizing && (sizing.state === "invalid" || sizing.state === "unpriced" || sizing.state === "tooSmall")
    ? sizing.message : null;
  const inputError = amountError ?? futuresInputError(
    selectedQuantity,
    selectedLeverage,
    effectiveOperation,
    position,
  );
  const covered =
    selectedOperation === "reduce" ||
    selectedOperation === "close" ||
    allInstruments.some((i) => i.id === instrument?.id);
  const allowed =
    focused &&
    !pendingResult &&
    covered &&
    !!instrument &&
    futuresActionAllowed(
      data.capabilities,
      effectiveOperation,
      markFresh,
      referenceFresh,
    );
  // A command in flight, an unresolved result or a held limit/conditional
  // entry keeps the contract, side and method that request was made with.
  const locked = mutation.isPending || pendingResult || limitBusy || conditionalBusy;
  const entering = effectiveOperation === "open" || effectiveOperation === "increase";
  const collateralKnown = timely && crossFresh;
  // 100% of an entry: what the free collateral carries after margin, fee and
  // the server's Cross/maintenance checks (an estimate; the server decides).
  const capacity = entering
    ? method !== "conditional" && !markFresh
      ? { state: "unavailable" as const, reason: "mark" as const }
      : futuresEntryCapacity({
        freeCollateral: collateralKnown ? data.collateral.freeCollateral : null,
        crossBase: collateralKnown ? data.cross.metrics?.crossBaseCollateral : null,
        liquidationBuffer: collateralKnown ? data.cross.metrics?.liquidationBuffer : null,
        leverage: Number(selectedLeverage),
        feeRate,
        marginMode: orderMarginMode,
        direction: orderDirection,
        price: basisPrice,
        // Deferred estimates keep the existing fill-time pricing assumption.
        // Market/limit entries still require fresh Mark evidence above.
        deferred: method !== "market",
        mark: method === "market" && markFresh ? (position?.markPrice ?? instrument?.markPrice ?? null) : null,
        opening: !position,
      })
    : null;
  // 100% of a reduce is the position (its notional at the current Last).
  const positionNotional = position && marketPrice ? futuresNotional(position.quantity, marketPrice) : null;
  const ratioBase = entering
    ? capacity?.state === "ready" ? capacity.max : null
    : selectedOperation === "reduce" ? positionNotional : null;
  const ratioReason = selectedOperation === "close"
    ? null
    : entering
      ? capacity?.state === "unavailable"
        ? capacity.reason === "fee"
          ? tradingAccount.isError ? "수수료 정보를 확인할 수 없어 비율을 계산할 수 없습니다." : "수수료 정보를 확인하는 중입니다."
          : capacity.reason === "mark" ? "Mark 정보를 확인할 수 없어 주문 가능 금액을 계산할 수 없습니다."
            : capacity.reason === "price" ? unpriced
            : capacity.reason === "maintenance" ? MAINTENANCE_SHORT
              : "사용 가능한 담보를 평가하는 중입니다."
        : ratioBase === "0" ? "주문가능 금액이 없습니다." : null
      : positionNotional ? null : "현재 선물 Last를 확인할 수 없어 비율을 계산할 수 없습니다.";
  const amountAtRatio = (ratio: number) => (ratioBase ? futuresAmountAtRatio(ratioBase, ratio) : null);
  // The chosen quick ratio survives cent rounding only while it still writes this amount.
  const activeRatio = !ratioReason && chosenRatio !== null
    && (chosenRatio === 0 ? amount === "" : amountAtRatio(chosenRatio) === amount.trim())
    ? chosenRatio : null;
  const displayedRatio = activeRatio ?? (ratioReason ? 0 : futuresAmountRatio(amount, ratioBase));
  // Live pre-checks (the server still decides): no free collateral, or an
  // amount above what it carries, is refused here; unknown is never short.
  const entryProblem = !entering || method === "conditional" || !markFresh || !selectedQuantity || inputError
    ? null
    : capacity?.state === "unavailable" && capacity.reason === "maintenance"
      ? MAINTENANCE_SHORT
      : (collateralKnown && hasNoFreeCollateral(data.collateral.freeCollateral))
          || (capacity?.state === "ready" && futuresAmountExceeds(amount, capacity.limit))
        ? COLLATERAL_SHORT : null;
  const collateralShort = entryProblem === COLLATERAL_SHORT;
  const riskBlocked = entryProblem === MAINTENANCE_SHORT;
  const orderNotice = collateralAttempted ? (collateralShort ? COLLATERAL_SHORT : null) : notice;
  const clearFailure = () => {
    setCollateralAttempted(false);
    setFailure(null);
    setNotice(null);
  };
  const changeAmount = (value: string) => {
    if (locked) return;
    setAmount(value);
    setChosenRatio(null);
    setRatioMessage(null);
    clearFailure();
  };
  const applyRatio = (value: number) => {
    if (locked || !Number.isFinite(value)) return;
    const ratio = Math.max(0, Math.min(1, value));
    clearFailure();
    if (ratioReason) { setRatioMessage(ratioReason); return; }
    setRatioMessage(null);
    if (ratio === 0) { setAmount(""); setChosenRatio(0); return; }
    // 100% of a reduce is the whole position: the existing 전량 종료.
    if (selectedOperation === "reduce" && ratio === 1) { setOperation("close"); setAmount(""); setChosenRatio(null); return; }
    const next = amountAtRatio(ratio);
    if (!next || next === "0") { setRatioMessage("계산된 금액이 너무 작습니다."); return; }
    setAmount(next);
    setChosenRatio(ratio);
  };
  const changeOperation = (op: Exclude<Operation, "open">) => {
    if (locked) return;
    // An add and a reduce amount mean different things: start over.
    setOperation(op);
    clearFailure();
    setAmount("");
    setChosenRatio(null);
    setRatioMessage(null);
  };
  const choose = (id: string) => {
    if (submitLock.current || pendingResult || limitBusy || conditionalBusy) return;
    setInstrumentSheetOpen(false);
    setLeverageSheet(null);
    setSelectedId(id);
    // Another contract's amount and ratio never carry over.
    setAmount("");
    setChosenRatio(null);
    setRatioMessage(null);
    setOperation("open");
    clearFailure();
    action.current = null;
    // Another contract starts at 시장가 without a limit draft (the spot rule).
    setMethod(DEFAULT_ORDER_METHOD);
    setMethodSheetOpen(false);
    setLimitPrice("");
    setConditionalDraft(emptyFuturesConditionalDraft);
  };
  const entryGate = learning.gate(effectiveOperation === 'close' || effectiveOperation === 'reduce' ? 'riskReduction' : 'allTrading');
  const advancedGate = learning.gate('allTrading');
  const conditionalGate = getFuturesConditionalGate({
    isLoading: conditionalEntries.isPending,
    isError: conditionalEntries.isError,
    data: conditionalEntries.data?.tradingAccountId === accountId ? conditionalEntries.data : null,
  });
  const methodOptions = getFuturesOrderMethodOptions(!!position, conditionalGate);
  const selectedMethodOption = methodOptions.find((option) => option.method === method);
  // A method the position state no longer allows stays shown, never submits.
  const methodUnavailableReason = selectedMethodOption?.availability.state === 'unavailable'
    ? selectedMethodOption.availability.reason : null;
  const selectMethod = (next: OrderMethod) => {
    const option = methodOptions.find((item) => item.method === next);
    if (!option || !isOrderMethodSelectable(option) || submitLock.current || pendingResult || limitBusy || conditionalBusy) return;
    (next === 'market' ? learning.gate('riskReduction') : advancedGate).guard(() => {
      setMethodSheetOpen(false);
      if (next === method) return;
      // A new method never inherits the previous method's limit or trigger draft.
      setMethod(next);
      setLimitPrice("");
      setConditionalDraft(emptyFuturesConditionalDraft);
      clearFailure();
      setRatioMessage(null);
    });
  };
  const submit = () => {
    if (!entryGate.allowed) { entryGate.guard(() => undefined); return; }
    if (method !== 'market' || !allowed || inputError || riskBlocked || submitLock.current || !instrument) return;
    if (collateralShort) {
      setFailure(null);
      setNotice(null);
      setCollateralAttempted(true);
      return;
    }
    setCollateralAttempted(false);
    const signature = JSON.stringify([
      scope.current.epoch,
      instrument.id,
      position?.id,
      effectiveOperation,
      selectedQuantity,
      selectedLeverage,
      direction,
      marginMode,
    ]);
    if (action.current?.signature !== signature) {
      const key = createIdempotencyKey("futures");
      action.current = {
        reportQuestCommand: captureQuestGuideCommand(),
        signature,
        epoch: scope.current.epoch,
        session,
        command: position
          ? positionCommand(
              position,
              effectiveOperation === "open" ? "increase" : effectiveOperation,
              selectedQuantity,
              key,
            )
          : {
              instrumentId: instrument.id,
              operation: "open",
              direction,
              marginMode,
              leverage: Number(leverage),
              quantity: selectedQuantity,
              idempotencyKey: key,
            },
      };
    }
    submitLock.current = true;
    setFailure(null);
    setNotice(null);
    setRatioMessage(null);
    mutation.mutate(action.current);
  };
  const focusTrade = () => setTradeReveal((count) => count + 1);
  const estimateLines: string[] = [];
  if (sizing?.state === "ready") {
    estimateLines.push(`예상 수량 ${formatDisplayDecimal(sizing.quantity)} ${baseSymbol}`);
    const estimate = entering ? futuresEntryEstimate(amount, Number(selectedLeverage), feeRate) : null;
    if (estimate) {
      estimateLines.push(`예상 증거금 $${formatUsd(estimate.margin)}`);
      if (estimate.fee !== null) estimateLines.push(`예상 수수료 $${formatUsd(estimate.fee)}`);
    }
    if (wholePosition) estimateLines.push("보유 수량 전체 · 전량 종료로 처리됩니다.");
  }
  const freeCollateral = collateralKnown ? data.collateral.freeCollateral : null;
  const availableText = selectedOperation === "reduce" && position
    ? `보유 ${formatDisplayDecimal(position.quantity)} ${baseSymbol}${positionNotional ? ` · 약 ${formatUsd(positionNotional)} USD` : ""}`
    : freeCollateral === null ? "주문가능 평가 대기" : `주문가능 ${formatUsd(freeCollateral)} USD`;
  const amountLabel = selectedOperation === "reduce" ? "감소 금액 (USD)" : selectedOperation === "increase" ? "추가 금액 (USD)" : "주문 금액 (USD)";
  const stackedControls = width / fontScale < 360;
  // Three operation segments break words in the narrow form column at large
  // fonts; there they become a vertical choice list.
  const stackedOperations = width < 160 * fontScale + 100;
  // "(Short)" cannot fit half the column at large fonts: the segment shows 롱/숏
  // (the spoken names keep Long/Short).
  const compactSides = width < 220 * fontScale + 80;
  const compact = width < 600;
  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={headerHeight}
    >
      <View ref={questGuideTarget('futures-viewport')} collapsable={false} style={{ flex: 1 }}>
      <ScrollView
        ref={inputScroll.scrollRef}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        onScroll={inputScroll.onScroll}
        scrollEventThrottle={16}
        onLayout={inputScroll.revealFocusedInput}
        onContentSizeChange={inputScroll.revealFocusedInput}
        testID="futures-screen"
      >
        <View style={styles.header}>
          <View ref={questGuideTarget('futures-instrument')} collapsable={false} style={styles.pairGroup}>
            <ActionPressable
              testID="futures-instrument-select"
              style={styles.pairButton}
              accessibilityRole="button"
              accessibilityLabel={instrument ? `선물 상품 변경, ${instrument.underlying.symbol}` : '선물 상품 선택'}
              accessibilityHint="선물 상품 목록을 엽니다"
              accessibilityState={{ disabled: locked || !allInstruments.length, expanded: instrumentSheetOpen }}
              disabled={locked || !allInstruments.length}
              onPress={() => setInstrumentSheetOpen(true)}
            >
              <Text style={styles.pair}>{instrument?.underlying.symbol ?? '선물 상품'}{allInstruments.length ? ' ▾' : ''}</Text>
            </ActionPressable>
            <Text style={styles.badge}>무기한</Text>
          </View>
          {instrument ? (
            <ActionPressable
              testID="futures-chart-toggle"
              style={[styles.iconButton, chartOpen && styles.iconButtonActive]}
              accessibilityRole="button"
              accessibilityLabel={chartOpen ? '4시간봉 차트 접기' : '4시간봉 차트 보기'}
              accessibilityState={{ selected: chartOpen }}
              aria-pressed={chartOpen}
              onPress={() => setChartOpen((open) => !open)}
            >
              <Svg width={22} height={22} viewBox="0 0 24 24" aria-hidden>
                <Path d="M5 3v18M2 8h6v7H2zM12 2v17M9 5h6v8H9zM19 6v16M16 11h6v7h-6z" fill="none"
                  stroke={chartOpen ? colors.onAccent : colors.secondary} strokeWidth={1.5} />
              </Svg>
            </ActionPressable>
          ) : null}
        </View>
        {instrument ? (
          <>
            <View style={styles.prices} testID="futures-prices">
              <View style={[styles.priceCell, stackedControls && styles.full]}>
                <Text style={styles.priceLabel} accessibilityLabel="현재가 Last">Last</Text>
                <Text selectable style={styles.price} testID="futures-last-price">
                  {referenceFresh ? price(reference, instrument) : "시세 확인 불가"}
                </Text>
              </View>
              <View style={[styles.priceCell, stackedControls && styles.full]}>
                <Text style={styles.priceLabel} accessibilityLabel="Mark 가격">Mark</Text>
                <Text selectable style={styles.price} testID="futures-mark-price">
                  {markFresh ? price(position?.markPrice ?? instrument.markPrice, instrument) : "Mark 확인 불가"}
                </Text>
              </View>
            </View>
            {!markFresh ? (
              <Text style={styles.warning}>
                Mark가 없거나 오래되었습니다. Open/Increase는 제한되며,
                현재가가 유효하면 Reduce/Close를 요청할 수 있습니다.
              </Text>
            ) : null}
            {chartOpen ? (
              <View style={styles.card}>
                <FuturesCandleChart
                  key={instrument.id}
                  instrumentId={instrument.id}
                  displayPriceDecimals={instrument.underlying.displayPriceDecimals}
                  currentPrice={referenceFresh && reference ? reference : null}
                />
              </View>
            ) : null}
          </>
        ) : null}
        {/* The spot order screen's row: the form beside the book on every width. */}
        <View ref={tradeRow} collapsable={false} style={[styles.tradingRow, compact && styles.compactTradingRow]} testID="futures-trading-columns">
          <View style={styles.orderColumn} testID="futures-trade">
            {pendingResult ? (
              <View style={styles.pendingResult}>
                <Text style={styles.warning}>
                  이전 요청의 체결 여부를 확인해야 합니다. 포지션이나 운영 모드가
                  바뀌어도 같은 요청으로 결과를 확인합니다.
                </Text>
                <CTAButton
                  testID="futures-retry"
                  label="이전 체결 결과 확인"
                  onPress={retryResult}
                  state={mutation.isPending ? "loading" : "enabled"}
                />
              </View>
            ) : null}
            {data.capabilities.tradingMode !== 'ENABLED' ? (
              <Text testID="futures-mode-notice" style={styles.warning}>{modeLabel[data.capabilities.tradingMode]}</Text>
            ) : null}
            {instruments.isError ? (
              <ErrorNotice error={instruments.error} style={styles.warning}
                message="상품 목록을 불러오지 못했습니다. 보유 포지션에서 다시 선택할 수 있습니다." />
            ) : null}
            {!instrument ? (
              <Text style={styles.muted}>현재 검증된 선물 상품이 없습니다.</Text>
            ) : (
              <>
                {position ? (
                  <View style={styles.group} testID="futures-position-terms">
                    <View style={styles.terms}>
                      <Text style={[styles.termsDirection, { color: position.direction === 'long' ? BUY_COLOR : SELL_COLOR }]}>
                        {directionLabel[position.direction]}
                      </Text>
                      <Text style={styles.termsText}>{marginLabel[position.marginMode]} · {position.leverage}x 고정</Text>
                    </View>
                    <Text style={styles.helper}>
                      방향·레버리지·증거금 모드는 전량 종료 후 새 포지션에서
                      선택할 수 있습니다.
                    </Text>
                  </View>
                ) : (
                  <>
                    <View ref={questGuideTarget('futures-direction')} collapsable={false}>
                      <OrderSideSegment
                        testID="futures-direction"
                        side={direction === 'long' ? 'buy' : 'sell'}
                        labels={compactSides ? { buy: '롱', sell: '숏' } : { buy: directionLabel.long, sell: directionLabel.short }}
                        accessibilityLabels={{ buy: directionLabel.long, sell: directionLabel.short }}
                        testIDs={{ buy: 'futures-direction-long', sell: 'futures-direction-short' }}
                        disabled={locked}
                        onChange={(side) => { setDirection(side === 'buy' ? 'long' : 'short'); clearFailure(); }}
                      />
                    </View>
                    <View ref={questGuideTarget('futures-margin')} collapsable={false} style={styles.controls}>
                      <FuturesMarginModeField value={marginMode} onChange={(value) => { setMarginMode(value); clearFailure(); }} disabled={locked} />
                      <FuturesLeverageSelect
                        leverage={Number(leverage)}
                        disabled={locked}
                        sheet={locked ? null : leverageSheet}
                        onSheetChange={setLeverageSheet}
                        onChange={(value) => { setLeverage(String(value)); clearFailure(); }}
                      />
                    </View>
                  </>
                )}
                <OrderTypeSelect
                  method={method}
                  options={methodOptions}
                  disabled={locked}
                  open={methodSheetOpen && !locked}
                  onOpen={() => setMethodSheetOpen(true)}
                  onClose={() => setMethodSheetOpen(false)}
                  onSelect={selectMethod}
                  learningHints={{
                    limit: advancedGate.locked ? advancedGate.message : null,
                    conditional: advancedGate.locked ? advancedGate.message : null,
                  }}
                />
                {methodUnavailableReason ? (
                  <Text testID="futures-method-unavailable" style={styles.error}>{methodUnavailableReason}</Text>
                ) : (
                  <>
                    {position ? (
                      stackedOperations ? (
                        <View testID="futures-operation" accessibilityRole="radiogroup" accessibilityLabel="포지션 조작" style={styles.operations}>
                          {(['increase', 'reduce', 'close'] as const).map((op) => {
                            const selected = (selectedOperation === 'open' ? 'increase' : selectedOperation) === op;
                            return (
                              <ActionPressable key={op} feedback="selection" testID={`futures-operation-${op}`} accessibilityRole="radio"
                                accessibilityLabel={operationLabel[op]} accessibilityState={{ selected, checked: selected, disabled: locked }}
                                aria-selected={selected} disabled={locked} onPress={() => { if (!selected) changeOperation(op); }}
                                style={[styles.operation, selected && styles.operationSelected]}>
                                <Text style={[styles.operationText, selected && styles.operationTextSelected]}>{operationShortLabel[op]}</Text>
                              </ActionPressable>
                            );
                          })}
                        </View>
                      ) : (
                        <SegmentedControl testID="futures-operation" accessibilityLabel="포지션 조작" value={selectedOperation === 'open' ? 'increase' : selectedOperation}
                          onChange={changeOperation}
                          options={(['increase', 'reduce', 'close'] as const).map((op) => ({
                            key: op, label: operationShortLabel[op], accessibilityLabel: operationLabel[op],
                            testID: `futures-operation-${op}`, disabled: locked,
                          }))} />
                      )
                    ) : null}
                    {method === 'conditional' ? (
                      <FuturesConditionalFields draft={conditionalDraft} onChange={setConditionalDraft} disabled={locked}
                        lastPrice={referenceFresh ? reference ?? null : null}
                        onInputFocus={inputScroll.onInputFocus} onInputBlur={inputScroll.onInputBlur} />
                    ) : method === 'limit' ? (
                      <View style={styles.group}>
                        <Text style={styles.label}>진입 지정가 (USD)</Text>
                        <OrderNumberInput
                          accessibilityLabel="선물 진입 지정가"
                          testID="futures-limit-price"
                          value={limitPrice}
                          onChangeText={(value) => { setLimitPrice(value); clearFailure(); }}
                          editable={!locked}
                          keyboardType="decimal-pad"
                          placeholder="지정가 입력"
                          style={styles.input}
                          onFieldFocus={inputScroll.onInputFocus}
                          onBlur={inputScroll.onInputBlur}
                        />
                      </View>
                    ) : null}
                    {selectedOperation === 'close' && position ? (
                      // 전량 종료 always sends the whole position; no amount can shrink it.
                      <View style={styles.closeSummary} testID="futures-close-summary">
                        <Text style={styles.label}>전량 종료</Text>
                        <Text selectable style={styles.closeValue} testID="futures-close-quantity">
                          보유 수량 {formatDisplayDecimal(position.quantity)} {baseSymbol} 전체
                        </Text>
                        {positionNotional ? (
                          <Text style={styles.helper}>약 {formatUsd(positionNotional)} USD · 선물 Last 기준</Text>
                        ) : null}
                      </View>
                    ) : (
                      <FuturesAmountField
                        label={amountLabel}
                        amount={amount}
                        onChange={changeAmount}
                        editable={!locked}
                        estimate={estimateLines}
                        ratioLabel={selectedOperation === 'reduce' ? '감소 비율' : '주문 금액 비율'}
                        ratio={displayedRatio}
                        activeRatio={activeRatio}
                        ratioDisabled={!!ratioReason}
                        ratioReason={ratioReason}
                        onRatio={applyRatio}
                        available={availableText}
                        availableTarget={questGuideTarget('futures-funding')}
                        onInputFocus={inputScroll.onInputFocus}
                        onInputBlur={inputScroll.onInputBlur}
                      />
                    )}
                    {amount.trim() && inputError ? (
                      <Text testID="futures-amount-error" accessibilityLiveRegion="polite" style={styles.error}>{inputError}</Text>
                    ) : null}
                    {ratioMessage ? (
                      <Text testID="futures-ratio-message" accessibilityLiveRegion="polite" style={styles.error}>{ratioMessage}</Text>
                    ) : null}
                    {riskBlocked && method !== 'conditional' ? (
                      <Text testID="futures-collateral-insufficient" accessibilityLiveRegion="polite" style={styles.error}>
                        {entryProblem}
                      </Text>
                    ) : null}
                    {method === 'limit' ? (
                      <FuturesLimitEntryForm key={`${accountId}:${instrument.id}`} accountId={accountId} instrumentId={instrument.id}
                        unit={instrument.underlying.symbol.replace(/USDT$/u, '')} direction={direction} marginMode={marginMode} leverage={leverage}
                        quantity={selectedQuantity} amount={amount} limitPrice={limitPrice}
                        allowed={bound && focused && covered && data.capabilities.canOpen && markFresh && !inputError && !riskBlocked && !pendingResult}
                        collateralError={collateralShort ? COLLATERAL_SHORT : null}
                        onBusy={setLimitBusy} />
                    ) : method === 'conditional' ? (
                      <FuturesConditionalEntryForm key={`${accountId}:${instrument.id}`} accountId={accountId} instrumentId={instrument.id}
                        direction={direction} marginMode={marginMode} leverage={leverage} quantity={selectedQuantity} draft={conditionalDraft}
                        onDraftChange={setConditionalDraft}
                        lastPrice={referenceFresh ? reference ?? null : null} displayDecimals={instrument.underlying.displayPriceDecimals}
                        allowed={bound && focused && covered && data.capabilities.canOpen && referenceFresh && !inputError && !pendingResult
                          && conditionalGate.state === 'ready' && conditionalGate.enabled}
                        onBusy={setConditionalBusy} />
                    ) : (
                      <View ref={inputScroll.submitRef}>
                        <QuestTarget id="futures-submit"><CTAButton
                          learningHint={entryGate.locked ? entryGate.message : null}
                          label={`${directionLabel[orderDirection]} ${operationVerb[effectiveOperation]}`}
                          testID="futures-submit"
                          style={entering ? { backgroundColor: orderDirection === 'long' ? BUY_COLOR : SELL_COLOR } : undefined}
                          onPress={submit}
                          state={
                            mutation.isPending
                              ? "loading"
                              : allowed && !inputError && !riskBlocked
                                ? "enabled"
                                : "disabled"
                          }
                        /></QuestTarget>
                      </View>
                    )}
                  </>
                )}
                {/* A refusal or the fill result reads right under the button. */}
                {orderNotice ? (
                  failure ? (
                    <ErrorNotice
                      error={failure}
                      message={orderNotice}
                      style={styles.notice}
                      testID="futures-order-notice"
                    />
                  ) : (
                    <Text accessibilityRole="alert" style={styles.notice} testID="futures-order-notice">
                      {orderNotice}
                    </Text>
                  )
                ) : null}
              </>
            )}
          </View>
          {instrument ? (
            <View style={styles.priceColumn} testID="futures-price-column">
              <FuturesOrderBookCard
                key={instrument.id}
                instrumentId={instrument.id}
                lastPrice={referenceFresh ? price(reference, instrument) : "시세 확인 불가"}
                active={bound && focused}
              />
            </View>
          ) : null}
        </View>
        {data.cross.positionIds.length > 0 ? (
          <View style={styles.card} testID="futures-cross">
            <Text style={styles.heading}>교차(Cross) 공동 담보</Text>
            {timely && crossFresh && data.cross.metrics ? (
              <View style={styles.metrics}>
                <Metric columns={stackedControls ? 1 : 2} label="교차 equity" value={usd(data.cross.metrics.crossEquity)} />
                <Metric columns={stackedControls ? 1 : 2} label="초기 증거금 요구액" value={usd(data.cross.metrics.crossInitialMarginRequirement)} />
                <Metric columns={stackedControls ? 1 : 2} label="유지 증거금 + 종료 수수료" value={usd(data.cross.metrics.crossMaintenanceRequirement)} />
                <Metric columns={stackedControls ? 1 : 2} label="청산 여유" value={usd(data.cross.metrics.liquidationBuffer)} />
              </View>
            ) : (
              <Text style={styles.warning}>
                Mark 정보를 확인할 수 없어 위험 평가를 표시하지 않습니다.
              </Text>
            )}
            <Text style={styles.muted}>
              교차 포지션은 공동 평가되며, 개별 청산가는 제공하지 않습니다.
            </Text>
          </View>
        ) : null}
        <View style={styles.section} testID="futures-lists">
          <Text accessibilityRole="header" style={styles.sectionTitle} testID="futures-lists-title">
            {listView === 'pending' ? '대기 주문' : `포지션 ${data.positions.length}`}
          </Text>
          <SegmentedControl testID="futures-lists-view" accessibilityLabel="선물 목록 보기" compact value={listView} onChange={setListView}
            options={[
              { key: 'positions', label: '포지션', testID: 'futures-view-positions' },
              { key: 'pending', label: '대기 주문', testID: 'futures-view-pending' },
            ]} />
          {listView === 'positions' ? (
            !data.positions.length ? (
              <Text style={styles.muted}>보유 중인 선물 포지션이 없습니다.</Text>
            ) : (
              data.positions.map((p) => (
                <FuturesPositionCard key={p.id} position={p} accountId={accountId} evaluatedAt={data.evaluatedAt} now={positionsNow}
                  disabled={locked} capabilities={data.capabilities}
                  onSelect={op => {
                    if (submitLock.current || pendingResult || limitBusy || conditionalBusy) return;
                    choose(p.instrumentId); setOperation(op);
                    focusTrade();
                  }}
                  tpSlSummary={tpSlRows ? tpSlCountSummary(tpSlRows.filter((row) => row.positionId === p.id)) : null}
                  onTpSl={() => setTpSlTarget({ type: 'futures_position', accountId, positionId: p.id })} />
              ))
            )
          ) : (
            <PendingOrders key={accountId} accountId={accountId} isFocused={focused} seasonUi={binding.account.mode === "season"} conditional />
          )}
        </View>
        {!final.isError && final.data?.settlement ? (
          <View style={styles.card}>
            <Text style={styles.heading}>
              {[
                "시즌 최종 종료",
                futuresPriceBasisLabel(
                  final.data.settlement.closes?.some(
                    (c) => !!c.price?.lastPriceSnapshot,
                  )
                    ? "futures_last"
                    : final.data.settlement.closes?.length
                      ? "spot_last"
                      : undefined,
                ),
              ]
                .filter(Boolean)
                .join(" · ")}{" "}
              체결
            </Text>
            <View style={styles.metrics}>
              <Metric columns={stackedControls ? 1 : 2} label="실현 손익" value={usd(final.data.settlement.realizedPnl)} />
              <Metric columns={stackedControls ? 1 : 2} label="종료 수수료" value={usd(final.data.settlement.feeAmount)} />
              <Metric columns={stackedControls ? 1 : 2} label="실제 현금 정산" value={usd(final.data.settlement.settledCash)} />
              <Metric columns={stackedControls ? 1 : 2} label="미충당 손실" value={usd(final.data.settlement.bankruptcyShortfall)} />
            </View>
          </View>
        ) : null}
      </ScrollView>
      <TpSlSheet target={focused && tpSlTarget?.accountId === accountId ? tpSlTarget : null} onClose={() => setTpSlTarget(null)} />
      <FuturesInstrumentSheet
        visible={instrumentSheetOpen && !locked}
        instruments={allInstruments}
        selectedId={instrument?.id}
        onSelect={choose}
        onClose={() => setInstrumentSheetOpen(false)}
      />
    </View>
    </KeyboardAvoidingView>
  );
}
const directionLabel = { long: "롱(Long)", short: "숏(Short)" };
const marginLabel = { isolated: "격리(Isolated)", cross: "교차(Cross)" };
const operationLabel = {
  open: "신규 진입(Open)",
  increase: "수량 추가(Increase)",
  reduce: "수량 감소(Reduce)",
  close: "전량 종료(Close)",
};
const operationShortLabel = { increase: "수량 추가", reduce: "수량 감소", close: "전량 종료" };
const operationVerb = { open: "진입", increase: "수량 추가", reduce: "수량 감소", close: "전량 종료" };
const modeLabel = {
  ENABLED: "거래 가능",
  REDUCE_ONLY: "위험 축소만 가능 · Reduce/Close",
  DISABLED: "선물 거래 비활성 · 조회만 가능",
};
function usd(value: string | null | undefined) {
  return value == null ? "평가 대기" : `$${formatUsd(value)}`;
}
function price(
  value: string | null | undefined,
  instrument: FuturesInstrument,
) {
  return value == null
    ? "시세 확인 불가"
    : formatAssetPrice(
        value,
        "USD",
        instrument.underlying.displayPriceDecimals,
      );
}
/** Fixed columns keep a short last row aligned with the rows above it. */
const COLUMN_WIDTH = { 1: '100%', 2: '46%', 3: '30%' } as const;
function Metric({ label, value, columns }: { label: string; value: string; columns: 1 | 2 | 3 }) {
  return (
    <View style={[styles.metric, { width: COLUMN_WIDTH[columns] }]}>
      <Text style={styles.muted}>{label}</Text>
      <Text selectable style={styles.value}>{value}</Text>
    </View>
  );
}
/** A known zero/negative free collateral; unknown (null) never counts as short. */
function hasNoFreeCollateral(value: string | null) {
  if (value === null || !/^-?\d+(\.\d+)?$/.test(value.trim())) return false;
  return Number(value) <= 0;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  // The spot order screen's spacing (12px sides, 12px between sections).
  content: {
    ...getScreenContentStyle(Platform.OS),
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 32,
    gap: 12,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  pairGroup: { flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8 },
  pairButton: { flexShrink: 1, minWidth: 0, minHeight: 44, justifyContent: 'center' },
  pair: { fontSize: 20, fontWeight: '700', color: semantic.text },
  badge: { fontSize: 11, color: semantic.muted, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: semantic.raised, borderRadius: 5 },
  iconButton: { minWidth: 44, minHeight: 44, padding: 8, borderRadius: 8, backgroundColor: semantic.raised, alignItems: 'center', justifyContent: 'center' },
  iconButtonActive: { backgroundColor: semantic.selected },
  // Rows wrap; on narrow widths and large fonts each item takes a full line.
  full: { flexBasis: '100%', width: '100%' },
  prices: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 8, minWidth: 0 },
  priceCell: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, gap: 2 },
  priceLabel: { fontSize: 11, lineHeight: 16, color: semantic.muted },
  price: { fontSize: 18, lineHeight: 26, fontWeight: '700', color: semantic.text, fontVariant: ['tabular-nums'] },
  // The spot order screen's row (OrderScreen tradingRow/orderColumn/priceColumn).
  tradingRow: {
    borderRadius: 12,
    paddingTop: 14,
    paddingBottom: 14,
    borderTopWidth: 1,
    borderColor: semantic.border,
    backgroundColor: semantic.surface,
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 12,
  },
  compactTradingRow: { gap: 6 },
  orderColumn: { flex: 1.15, minWidth: 0, gap: 12 },
  priceColumn: { flex: 1, minWidth: 0, overflow: 'hidden' },
  pendingResult: { gap: 10, padding: 12, borderRadius: 10, backgroundColor: semantic.warningSurface, minWidth: 0 },
  group: { gap: 4, minWidth: 0 },
  terms: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 2 },
  termsDirection: { fontSize: 15, lineHeight: 22, fontWeight: '800' },
  termsText: { fontSize: 14, lineHeight: 21, fontWeight: '600', color: semantic.text, flexShrink: 1 },
  // Margin mode above leverage: the narrow form column stacks its controls.
  controls: { gap: 12, minWidth: 0 },
  operations: { gap: 2, padding: 3, borderRadius: 11, backgroundColor: semantic.raised, minWidth: 0 },
  operation: { minHeight: 44, paddingHorizontal: 8, paddingVertical: 8, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  operationSelected: { backgroundColor: semantic.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: semantic.border },
  operationText: { fontSize: 14, lineHeight: 20, fontWeight: '600', color: semantic.secondary, textAlign: 'center' },
  operationTextSelected: { color: semantic.text, fontWeight: '700' },
  closeSummary: { gap: 2, padding: 12, borderRadius: 10, backgroundColor: semantic.raised, minWidth: 0 },
  closeValue: { fontSize: 15, lineHeight: 22, fontWeight: '700', color: semantic.text, fontVariant: ['tabular-nums'] },
  label: { fontSize: 12, color: semantic.muted },
  helper: { fontSize: 12, color: semantic.secondary },
  input: { ...orderInputStyle },
  error: { fontSize: 12, color: semantic.error },
  warning: { color: semantic.warning, fontSize: 13, lineHeight: 20 },
  notice: { fontSize: 14, lineHeight: 23, color: semantic.text },
  card: { padding: 14, borderRadius: 12, backgroundColor: semantic.surface, gap: 10, minWidth: 0 },
  unbound: { margin: 16 },
  heading: { fontSize: 16, fontWeight: "700", lineHeight: 24, color: semantic.text },
  muted: { color: semantic.secondary, fontSize: 13, lineHeight: 20, flexShrink: 1 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 10 },
  metric: { minWidth: 0, gap: 2 },
  value: { fontSize: 15, lineHeight: 23, color: semantic.text, flexShrink: 1, fontVariant: ["tabular-nums"] },
  section: { borderTopWidth: 1, borderColor: semantic.border, paddingTop: 16, marginTop: 8, gap: 12, minWidth: 0 },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: semantic.text },
});
