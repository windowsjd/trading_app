import { useTradingGuideFacts } from '../../features/quest/useTradingGuideFacts';
import { useLearningAccess } from '../../features/quest/useLearningAccess';
import { useQuestGuide } from '../../features/quest/QuestGuideProvider';
import { captureQuestGuideCommand, questGuideTarget, registerQuestGuideReveal } from '../../features/quest/questGuideBridge';
import QuestTarget from '../../features/quest/QuestTarget';
import FuturesLimitEntryForm from './FuturesLimitEntryForm';
import FuturesCandleChart from './FuturesCandleChart';
import FuturesHistory from './FuturesHistory';
import FuturesInstrumentSheet from './FuturesInstrumentSheet';
import PendingOrders from '../asset/PendingOrders';
import OrderSideSegment from '../order/OrderSideSegment';
import OrderTypeSelect from '../order/OrderTypeSelect';
import OrderNumberInput, { orderInputStyle } from '../order/OrderNumberInput';
import React, { useEffect, useRef, useState } from "react";
import ProtectionPanel from "../../features/conditional/ProtectionPanel";
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
import { QUERY_KEYS } from "../../constants/queryKeys";
import {
  executeFutures,
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
  futuresActionAllowed,
  futuresInputError,
  positionCommand,
} from "../../features/futures/policy";
import {
  DEFAULT_ORDER_METHOD,
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
import { formatAssetPrice, formatUsd } from "../../utils/format";
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

type ListView = 'positions' | 'pending' | 'history';

/**
 * The futures trading screen, laid out like the spot order screen: the
 * contract header (picker, 무기한, chart), its Last and Mark prices, one trade
 * card (롱/숏, margin mode and leverage, 주문방식, inputs, submit), then the
 * futures wallet and the positions/pending/history views. Futures keeps its
 * own financial rules: execution on Futures Last, valuation and liquidation on
 * Mark, an individual liquidation price for isolated positions only.
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
  const tradeOffset = useRef(0);
  const [, setClock] = useState(Date.now());
  const clock = Date.now();
  const [selectedId, setSelectedId] = useState(route.params.instrumentId ?? "");
  const [instrumentSheetOpen, setInstrumentSheetOpen] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
  const [direction, setDirection] = useState<Direction>("long");
  const [marginMode, setMarginMode] = useState<MarginMode>("isolated");
  const [leverage, setLeverage] = useState("1");
  const [quantity, setQuantity] = useState("");
  // Like the spot order form, every contract starts at 시장가.
  const [method, setMethod] = useState<OrderMethod>(DEFAULT_ORDER_METHOD);
  const [methodSheetOpen, setMethodSheetOpen] = useState(false);
  const [limitPrice, setLimitPrice] = useState("");
  const [limitBusy, setLimitBusy] = useState(false);
  const [operation, setOperation] = useState<Operation>("open");
  const [failure, setFailure] = useState<unknown>(null);
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
  const final = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.finalSettlement(accountId),
    queryFn: ({ signal }) => getFuturesFinalSettlement(accountId, signal),
    enabled: bound && focused,
    retry: false,
  });
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
      setQuantity("");
      setNotice(
        `${operationLabel[result.execution.operation]} 체결 완료 · 수수료 $${formatUsd(result.execution.feeAmount)}`,
      );
    },
    onError: (error, request) => {
      if (current(request)) {
        setFailure(error);
        const info = getApiErrorInfo(error);
        request.uncertain = !info.hasResponse || (info.status ?? 0) >= 500;
        setNotice(futuresErrorMessage(info.serverCode));
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
  const timely = freshFuturesEvaluation(data.evaluatedAt, clock);
  const crossFresh = data.positions
    .filter((p) => p.marginMode === "cross")
    .every(
      (p) =>
        p.markState === "fresh" && freshFuturesEvidence(p.markEvidence, clock),
    );
  const markFresh =
    timely &&
    crossFresh &&
    (position
      ? position.markState === "fresh" &&
        freshFuturesEvidence(position.markEvidence, clock)
      : freshFuturesEvaluation(instruments.data?.evaluatedAt, clock) &&
        instrument?.markState === "fresh" &&
        freshFuturesEvidence(instrument.markEvidence, clock));
  const reference = position
    ? position.referencePrice
    : instrument?.referencePrice;
  const referenceFresh =
    !!reference &&
    freshFuturesReference(
      position
        ? position.referencePriceEvidence
        : instrument?.referencePriceEvidence,
      clock,
    );
  const selectedQuantity =
    selectedOperation === "close" ? (position?.quantity ?? "") : quantity;
  const selectedLeverage = position ? String(position.leverage) : leverage;
  const inputError = futuresInputError(
    selectedQuantity,
    selectedLeverage,
    selectedOperation,
    position,
  );
  const covered =
    selectedOperation === "reduce" ||
    selectedOperation === "close" ||
    allInstruments.some((i) => i.id === instrument?.id);
  const allowed =
    !pendingResult &&
    covered &&
    !!instrument &&
    futuresActionAllowed(
      data.capabilities,
      selectedOperation,
      markFresh,
      referenceFresh,
    );
  // A command in flight, an unresolved result or a held limit entry keeps
  // the contract, side and method that request was made with.
  const locked = mutation.isPending || pendingResult || limitBusy;
  const choose = (id: string) => {
    if (submitLock.current || pendingResult || limitBusy) return;
    setInstrumentSheetOpen(false);
    setSelectedId(id);
    setQuantity("");
    setOperation("open");
    setNotice(null);
    action.current = null;
    // Another contract starts at 시장가 without a limit draft (the spot rule).
    setMethod(DEFAULT_ORDER_METHOD);
    setMethodSheetOpen(false);
    setLimitPrice("");
  };
  // Certain-only live check: opening or increasing needs some free collateral.
  // The margin a positive amount needs (Mark, leverage, fees) stays the
  // server's; the uncertain-result retry is a separate path (pendingResult).
  const collateralShort = (selectedOperation === 'open' || selectedOperation === 'increase') &&
    !!selectedQuantity.trim() && !inputError && hasNoFreeCollateral(data.collateral.freeCollateral);
  const entryGate = learning.gate(selectedOperation === 'close' || selectedOperation === 'reduce' ? 'riskReduction' : 'allTrading');
  const advancedGate = learning.gate('allTrading');
  const methodOptions = getFuturesOrderMethodOptions(!!position);
  const selectedMethodOption = methodOptions.find((option) => option.method === method);
  // A method the position state no longer allows stays shown, never submits.
  const methodUnavailableReason = selectedMethodOption?.availability.state === 'unavailable'
    ? selectedMethodOption.availability.reason : null;
  const selectMethod = (next: OrderMethod) => {
    const option = methodOptions.find((item) => item.method === next);
    if (!option || !isOrderMethodSelectable(option) || submitLock.current || pendingResult || limitBusy) return;
    (next === 'market' ? learning.gate('riskReduction') : advancedGate).guard(() => {
      setMethodSheetOpen(false);
      if (next === method) return;
      // A new method never inherits the previous method's limit draft.
      setMethod(next);
      setLimitPrice("");
      setNotice(null);
    });
  };
  const submit = () => {
    if (!entryGate.allowed) { entryGate.guard(() => undefined); return; }
    if (method !== 'market' || !allowed || inputError || collateralShort || submitLock.current || !instrument) return;
    const signature = JSON.stringify([
      scope.current.epoch,
      instrument.id,
      position?.id,
      selectedOperation,
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
              selectedOperation === "open" ? "increase" : selectedOperation,
              selectedQuantity,
              key,
            )
          : {
              instrumentId: instrument.id,
              operation: "open",
              direction,
              marginMode,
              leverage: Number(leverage),
              quantity,
              idempotencyKey: key,
            },
      };
    }
    submitLock.current = true;
    setFailure(null);
    setNotice(null);
    mutation.mutate(action.current);
  };
  const focusTrade = () => inputScroll.scrollRef.current?.scrollTo({ y: tradeOffset.current, animated: true });
  const orderDirection = position?.direction ?? direction;
  const entering = selectedOperation === 'open' || selectedOperation === 'increase';
  const stackedControls = width / fontScale < 360;
  const accountLabel = binding.account.mode === "beginner" ? "초보모드" : binding.account.mode === "general"
    ? "일반모드"
    : (binding.account.season?.seasonName ?? "시즌 투자");
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
        <Text style={styles.muted}>
          {instrument ? `${instrument.underlying.name} · ` : ''}{accountLabel} · USD 가상 무기한 계약
        </Text>
        {instrument ? (
          <>
            <View style={styles.prices} testID="futures-prices">
              <View style={[styles.priceCell, stackedControls && styles.full]}>
                <Text style={styles.priceLabel}>현재가 · 선물 Last 거래 기준</Text>
                <Text selectable style={styles.price} testID="futures-last-price">
                  {referenceFresh ? price(reference, instrument) : "시세 확인 불가"}
                </Text>
              </View>
              <View style={[styles.priceCell, stackedControls && styles.full]}>
                <Text style={styles.priceLabel}>Mark Price · 평가/청산 기준</Text>
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
            <FuturesOrderBookCard
              key={instrument.id}
              instrumentId={instrument.id}
              lastPrice={referenceFresh ? price(reference, instrument) : "시세 확인 불가"}
              active={bound && focused}
            />
          </>
        ) : null}
        <View style={styles.tradeCard} testID="futures-trade" onLayout={event => { tradeOffset.current = event.nativeEvent.layout.y; }}>
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
                      labels={{ buy: directionLabel.long, sell: directionLabel.short }}
                      testIDs={{ buy: 'futures-direction-long', sell: 'futures-direction-short' }}
                      disabled={locked}
                      onChange={(side) => setDirection(side === 'buy' ? 'long' : 'short')}
                    />
                  </View>
                  <View ref={questGuideTarget('futures-margin')} collapsable={false} style={styles.controls}>
                    <View style={[styles.marginGroup, stackedControls && styles.full]}>
                      <Text style={styles.label}>증거금 모드</Text>
                      <SegmentedControl testID="futures-margin-mode" accessibilityLabel="증거금 모드" compact value={marginMode}
                        onChange={setMarginMode}
                        options={(['isolated', 'cross'] as const).map((mode) => ({
                          key: mode, label: mode === 'isolated' ? '격리' : '교차', accessibilityLabel: marginLabel[mode],
                          testID: `futures-margin-${mode}`, disabled: locked,
                        }))} />
                    </View>
                    <View style={[styles.leverageGroup, stackedControls && styles.full]}>
                      <Text style={styles.label}>레버리지 (1~100)</Text>
                      <OrderNumberInput
                        accessibilityLabel="레버리지"
                        testID="futures-leverage"
                        value={leverage}
                        onChangeText={setLeverage}
                        editable={!locked}
                        keyboardType="number-pad"
                        style={[styles.input, styles.leverageInput]}
                        onFieldFocus={inputScroll.onInputFocus}
                        onBlur={inputScroll.onInputBlur}
                      />
                    </View>
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
              ) : method === 'conditional' && position ? (
                <ProtectionPanel
                  accountId={accountId}
                  assetId={instrument.underlying.assetId}
                  domain="futures"
                  positionId={position.id}
                  currency="USD"
                  onInputFocus={inputScroll.onInputFocus}
                  onInputBlur={inputScroll.onInputBlur}
                />
              ) : (
                <>
                  {position ? (
                    <SegmentedControl testID="futures-operation" accessibilityLabel="포지션 조작" value={selectedOperation === 'open' ? 'increase' : selectedOperation}
                      onChange={(op) => { setOperation(op); setNotice(null); }}
                      options={(['increase', 'reduce', 'close'] as const).map((op) => ({
                        key: op, label: operationShortLabel[op], accessibilityLabel: operationLabel[op],
                        testID: `futures-operation-${op}`, disabled: locked,
                      }))} />
                  ) : null}
                  <View style={styles.group}>
                    <Text style={styles.label}>{method === 'limit' ? '진입 지정가' : '가격'} (USD)</Text>
                    {method === 'limit' ? (
                      <OrderNumberInput
                        accessibilityLabel="선물 진입 지정가"
                        testID="futures-limit-price"
                        value={limitPrice}
                        onChangeText={setLimitPrice}
                        editable={!locked}
                        keyboardType="decimal-pad"
                        placeholder="지정가 입력"
                        style={styles.input}
                        onFieldFocus={inputScroll.onInputFocus}
                        onBlur={inputScroll.onInputBlur}
                      />
                    ) : (
                      <Text style={styles.marketPrice}>시장가 · 선물 Last 기준 체결</Text>
                    )}
                  </View>
                  <View style={styles.group}>
                    <Text style={styles.label}>{selectedOperation === "close" ? "전량 종료 수량" : "거래 수량"}</Text>
                    <OrderNumberInput
                      accessibilityLabel="거래 수량"
                      testID="futures-quantity"
                      value={selectedQuantity}
                      onChangeText={setQuantity}
                      editable={selectedOperation !== "close" && !locked}
                      keyboardType="decimal-pad"
                      placeholder="수량 입력"
                      style={styles.input}
                      onFieldFocus={inputScroll.onInputFocus}
                      onBlur={inputScroll.onInputBlur}
                    />
                  </View>
                  {selectedQuantity && inputError ? (
                    <Text style={styles.error}>{inputError}</Text>
                  ) : null}
                  {collateralShort ? (
                    <Text testID="futures-collateral-insufficient" accessibilityLiveRegion="polite" style={styles.error}>
                      {futuresErrorMessage('FUTURES_INSUFFICIENT_FREE_COLLATERAL')}
                    </Text>
                  ) : null}
                  <Text style={styles.helper} testID="futures-available-collateral">
                    사용 가능 담보 {timely && crossFresh ? usd(data.collateral.freeCollateral) : '평가 대기'}
                  </Text>
                  {method === 'limit' ? (
                    <FuturesLimitEntryForm key={`${accountId}:${instrument.id}`} accountId={accountId} instrumentId={instrument.id}
                      assetId={instrument.underlying.assetId} direction={direction} marginMode={marginMode} leverage={leverage}
                      quantity={quantity} limitPrice={limitPrice}
                      allowed={bound && focused && covered && data.capabilities.canOpen && markFresh && !inputError && !collateralShort && !pendingResult}
                      onBusy={setLimitBusy} onInputFocus={inputScroll.onInputFocus} onInputBlur={inputScroll.onInputBlur} />
                  ) : (
                    <View ref={inputScroll.submitRef}>
                      <QuestTarget id="futures-submit"><CTAButton
                        learningHint={entryGate.locked ? entryGate.message : null}
                        label={`${directionLabel[orderDirection]} ${operationVerb[selectedOperation]}`}
                        testID="futures-submit"
                        style={entering ? { backgroundColor: orderDirection === 'long' ? BUY_COLOR : SELL_COLOR } : undefined}
                        onPress={submit}
                        state={
                          mutation.isPending
                            ? "loading"
                            : allowed && !inputError && !collateralShort
                              ? "enabled"
                              : "disabled"
                        }
                      /></QuestTarget>
                    </View>
                  )}
                </>
              )}
              {notice ? (
                failure ? (
                  <ErrorNotice
                    error={failure}
                    message={notice}
                    style={styles.notice}
                  />
                ) : (
                  <Text accessibilityRole="alert" style={styles.notice}>
                    {notice}
                  </Text>
                )
              ) : null}
            </>
          )}
        </View>
        {instrument && !position ? (
          // Completed TP/SL history stays readable after the position is flat.
          <ProtectionPanel
            accountId={accountId}
            assetId={instrument.underlying.assetId}
            domain="futures"
            currency="USD"
          />
        ) : null}
        <View ref={questGuideTarget('futures-funding')} collapsable={false} style={styles.card} testID="futures-wallet">
          <View style={styles.cardHeader}>
            <Text accessibilityRole="header" style={styles.heading}>선물 지갑</Text>
            <Text style={[styles.modeBadge, data.capabilities.tradingMode !== 'ENABLED' && styles.modeBadgeLimited]}>
              {modeLabel[data.capabilities.tradingMode]}
            </Text>
          </View>
          <Text style={styles.muted}>교차 담보도 선물 USD 지갑만 사용합니다.</Text>
          <View style={styles.metrics}>
            <Metric columns={stackedControls ? 1 : 3} label="선물 USD 현금" value={usd(data.collateral.balanceAmount)} />
            <Metric columns={stackedControls ? 1 : 3} label="격리 할당 담보" value={usd(data.collateral.totalMarginUsed)} />
            <Metric columns={stackedControls ? 1 : 3} label="사용 가능 담보" value={timely && crossFresh ? usd(data.collateral.freeCollateral) : "평가 대기"} />
          </View>
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
            {listView === 'pending' ? '대기 주문' : listView === 'history' ? '선물 기록' : `포지션 ${data.positions.length}`}
          </Text>
          <SegmentedControl testID="futures-lists-view" accessibilityLabel="선물 목록 보기" compact value={listView} onChange={setListView}
            options={[
              { key: 'positions', label: '포지션', testID: 'futures-view-positions' },
              { key: 'pending', label: '대기 주문', testID: 'futures-view-pending' },
              { key: 'history', label: '기록', testID: 'futures-view-history' },
            ]} />
          {listView === 'positions' ? (
            !data.positions.length ? (
              <Text style={styles.muted}>보유 중인 선물 포지션이 없습니다.</Text>
            ) : (
              data.positions.map((p) => (
                <FuturesPositionCard key={p.id} position={p} accountId={accountId} evaluatedAt={data.evaluatedAt} now={clock}
                  disabled={locked} capabilities={data.capabilities}
                  onSelect={op => {
                    if (submitLock.current || pendingResult || limitBusy) return;
                    choose(p.instrumentId); setOperation(op);
                    focusTrade();
                  }}
                  onProtection={() => {
                    if (submitLock.current || pendingResult || limitBusy) return;
                    choose(p.instrumentId); setMethod('conditional');
                    focusTrade();
                  }} />
              ))
            )
          ) : listView === 'pending' ? (
            <PendingOrders key={accountId} accountId={accountId} isFocused={focused} seasonUi={binding.account.mode === "season"} />
          ) : (
            <FuturesHistory key={accountId} accountId={accountId} instruments={allInstruments} />
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

function futuresErrorMessage(code: string | null) {
  if (code === "FUTURES_INSTRUMENT_UNVERIFIED")
    return "현재 이 상품은 신규 진입할 수 없습니다. 보유 포지션의 Reduce/Close는 가능합니다.";
  if (code === "FUTURES_PRICE_UNAVAILABLE")
    return "현재 거래 기준 시세를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.";
  if (code === "FUTURES_LIQUIDATION_REQUIRED")
    return "현재 손실과 수수료가 담보 범위를 초과합니다. 위험 관리 시스템의 전량 청산이 필요합니다.";
  if (code === "FUTURES_REDUCE_ONLY") return "현재 Reduce/Close만 가능합니다.";
  if (code === "FUTURES_TRADING_DISABLED")
    return "현재 선물 거래가 비활성 상태입니다.";
  if (code?.includes("MARK"))
    return "Mark 정보를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.";
  if (code?.includes("COLLATERAL"))
    return "사용 가능한 선물 담보가 부족합니다.";
  if (code === "FUTURES_POSITION_NOT_FOUND")
    return "포지션이 이미 종료되었거나 변경되었습니다. 최신 상태를 확인해주세요.";
  return "체결을 확인하지 못했습니다. 같은 요청을 다시 누르면 중복 체결 없이 결과를 확인합니다.";
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
  tradeCard: {
    padding: 12,
    paddingVertical: 14,
    borderRadius: 12,
    borderTopWidth: 1,
    borderColor: semantic.border,
    backgroundColor: semantic.surface,
    gap: 12,
    minWidth: 0,
  },
  pendingResult: { gap: 10, padding: 12, borderRadius: 10, backgroundColor: semantic.warningSurface, minWidth: 0 },
  group: { gap: 4, minWidth: 0 },
  terms: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 2 },
  termsDirection: { fontSize: 15, lineHeight: 22, fontWeight: '800' },
  termsText: { fontSize: 14, lineHeight: 21, fontWeight: '600', color: semantic.text, flexShrink: 1 },
  controls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', columnGap: 10, rowGap: 10, minWidth: 0 },
  marginGroup: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, gap: 4 },
  leverageGroup: { width: 116, gap: 4 },
  // The segmented control's height, so both controls line up.
  leverageInput: { minHeight: 44, paddingVertical: 4 },
  label: { fontSize: 12, color: semantic.muted },
  helper: { fontSize: 12, color: semantic.secondary },
  input: { ...orderInputStyle },
  marketPrice: { fontSize: 14, color: semantic.muted, backgroundColor: semantic.raised, borderRadius: 8, padding: 12, minHeight: 46 },
  error: { fontSize: 12, color: semantic.error },
  warning: { color: semantic.warning, fontSize: 13, lineHeight: 20 },
  notice: { fontSize: 14, lineHeight: 23, color: semantic.text },
  card: { padding: 14, borderRadius: 12, backgroundColor: semantic.surface, gap: 10, minWidth: 0 },
  unbound: { margin: 16 },
  cardHeader: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 8, rowGap: 4 },
  heading: { fontSize: 16, fontWeight: "700", lineHeight: 24, color: semantic.text },
  modeBadge: { fontSize: 11, lineHeight: 15, fontWeight: '600', color: semantic.success, backgroundColor: semantic.successSurface, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 5, overflow: 'hidden' },
  modeBadgeLimited: { color: semantic.warning, backgroundColor: semantic.warningSurface },
  muted: { color: semantic.secondary, fontSize: 13, lineHeight: 20, flexShrink: 1 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 10 },
  metric: { minWidth: 0, gap: 2 },
  value: { fontSize: 15, lineHeight: 23, color: semantic.text, flexShrink: 1, fontVariant: ["tabular-nums"] },
  section: { borderTopWidth: 1, borderColor: semantic.border, paddingTop: 16, marginTop: 8, gap: 12, minWidth: 0 },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: semantic.text },
});
