import FuturesLimitEntryForm from './FuturesLimitEntryForm';
import PendingOrders from '../asset/PendingOrders';
import React, { useEffect, useRef, useState } from "react";
import ProtectionPanel from "../../features/conditional/ProtectionPanel";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "../../theme/native";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useIsFocused } from "@react-navigation/native";
import { useHeaderHeight } from "@react-navigation/elements";
import type { FuturesScreenProps } from "../../app/navigation/types";
import { useTradingAccount } from "../../features/tradingAccount/TradingAccountContext";
import { resolveAccountBinding } from "../../features/tradingAccount/accountBinding";
import { QUERY_KEYS } from "../../constants/queryKeys";
import {
  executeFutures,
  getFuturesHistory,
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
  getSessionGeneration,
  isCurrentSession,
} from "../../services/api/sessionOwnership";
import { getApiErrorInfo } from "../../services/api/errorMapper";
import { createIdempotencyKey } from "../../utils/idempotency";
import {
  formatAssetPrice,
  formatDisplayDecimal,
  formatUsd,
} from "../../utils/format";
import { useFocusedInputScroll } from "../../hooks/useFocusedInputScroll";
import { getScreenContentStyle } from "../../theme/screenLayout";
import { semantic } from "../../theme/tokens";
import { financial } from "../../theme/financialColors";
import CTAButton from "../../components/common/CTAButton";
import ActionPressable from "../../components/common/ActionPressable";
import ErrorNotice from "../../components/states/ErrorNotice";
import ErrorState from "../../components/states/ErrorState";
import FullPageLoading from "../../components/states/FullPageLoading";
import FuturesPositionCard from './FuturesPositionCard';

export default function FuturesScreen(props: FuturesScreenProps) {
  return <BoundFuturesScreen key={`${props.route.params.accountId}:${props.route.params.instrumentId ?? ""}:${getSessionGeneration()}`} {...props} />;
}
export function BoundFuturesScreen({ route, navigation }: FuturesScreenProps) {
  const accountId = route.params.accountId;
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
  const headerHeight = useHeaderHeight();
  const quantityRef = useRef<TextInput>(null);
  const leverageRef = useRef<TextInput>(null);
  const tradeOffset = useRef(0);
  const [, setClock] = useState(Date.now());
  const clock = Date.now();
  const [selectedId, setSelectedId] = useState(route.params.instrumentId ?? "");
  const [instrumentSearch, setInstrumentSearch] = useState("");
  const [direction, setDirection] = useState<Direction>("long");
  const [marginMode, setMarginMode] = useState<MarginMode>("isolated");
  const [leverage, setLeverage] = useState("1");
  const [quantity, setQuantity] = useState("");
  const [entryType, setEntryType] = useState<"market" | "limit">("market");
  const [limitBusy, setLimitBusy] = useState(false);
  const [operation, setOperation] = useState<Operation>("open");
  const [failure, setFailure] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [historyKind, setHistoryKind] = useState<"executions" | "liquidations">(
    "executions",
  );
  const [offset, setOffset] = useState(0);
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
  const history = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.history(
      accountId,
      historyKind,
      offset,
    ),
    queryFn: ({ signal }) =>
      getFuturesHistory(accountId, historyKind, offset, signal),
    enabled: bound && focused,
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
  if (binding.state === "loading")
    return <FullPageLoading message="선물 계정을 확인하고 있습니다." />;
  if (isError)
    return <ErrorState error={error} title="계정 정보를 불러오지 못했습니다." onRetry={() => void refetchAccounts()} />;
  if (!bound)
    return (
      <View style={styles.card}>
        <Text style={styles.heading}>선택한 계정이 변경되었습니다.</Text>
        <Text>마켓에서 선물 상품을 다시 선택해주세요.</Text>
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
  const search =
    allInstruments.length > 12 ? instrumentSearch.trim().toLowerCase() : "";
  const matchingInstruments = allInstruments.filter((i) =>
    `${i.underlying.symbol} ${i.underlying.name}`
      .toLowerCase()
      .includes(search),
  );
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
  const choose = (id: string) => {
    if (submitLock.current || pendingResult || limitBusy) return;
    setSelectedId(id);
    setQuantity("");
    setOperation("open");
    setNotice(null);
    action.current = null;
  };
  const submit = () => {
    if (!allowed || inputError || submitLock.current || !instrument) return;
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
  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={headerHeight}
    >
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
        <Text style={styles.title}>암호화폐 선물</Text>
        <Text style={styles.muted}>
          {binding.account.mode === "beginner" ? "초보 투자" : binding.account.mode === "general"
            ? "일반 투자"
            : (binding.account.season?.seasonName ?? "시즌 투자")}{" "}
          · USD 가상 무기한 계약
        </Text>
        <View style={styles.card}>
          <Text style={styles.heading}>
            {modeLabel[data.capabilities.tradingMode]}
          </Text>
          <Text style={styles.muted}>
            시장가로 전량 체결됩니다. 교차 담보도 선물 USD 지갑만 사용합니다.
          </Text>
          <Metric
            label="선물 USD 현금"
            value={usd(data.collateral.balanceAmount)}
          />
          <Metric
            label="격리 할당 담보"
            value={usd(data.collateral.totalMarginUsed)}
          />
          <Metric
            label="사용 가능 담보"
            value={
              timely && crossFresh
                ? usd(data.collateral.freeCollateral)
                : "평가 대기"
            }
          />
        </View>
        {data.cross.positionIds.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.heading}>교차(Cross) 공동 담보</Text>
            {timely && crossFresh && data.cross.metrics ? (
              <>
                <Metric
                  label="교차 equity"
                  value={usd(data.cross.metrics.crossEquity)}
                />
                <Metric
                  label="초기 증거금 요구액"
                  value={usd(data.cross.metrics.crossInitialMarginRequirement)}
                />
                <Metric
                  label="유지 증거금 + 종료 수수료"
                  value={usd(data.cross.metrics.crossMaintenanceRequirement)}
                />
                <Metric
                  label="청산 여유"
                  value={usd(data.cross.metrics.liquidationBuffer)}
                />
              </>
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
        {pendingResult ? (
          <View style={styles.card}>
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
        <Text accessibilityRole="header" style={styles.heading}>포지션</Text>
        {!data.positions.length ? (
          <Text style={styles.muted}>보유 중인 선물 포지션이 없습니다.</Text>
        ) : (
          data.positions.map((p) => (
            <FuturesPositionCard key={p.id} position={p} accountId={accountId} evaluatedAt={data.evaluatedAt} now={clock}
              disabled={mutation.isPending || pendingResult || limitBusy} capabilities={data.capabilities}
              onSelect={op => {
                if (submitLock.current || pendingResult || limitBusy) return;
                choose(p.instrumentId); setEntryType('market'); setOperation(op);
                inputScroll.scrollRef.current?.scrollTo({ y: tradeOffset.current, animated: true });
              }}
              onInputFocus={inputScroll.onInputFocus} onInputBlur={inputScroll.onInputBlur} />
          ))
        )}
        <View style={styles.card} onLayout={event => { tradeOffset.current = event.nativeEvent.layout.y; }}>
          <Text style={styles.heading}>선물 거래</Text>
          {!position ? <View style={styles.choices}>{(["market", "limit"] as const).map(type => <Choice key={type} label={type === "market" ? "시장가" : "지정가 진입"} selected={entryType === type} disabled={mutation.isPending || pendingResult || limitBusy} onPress={() => setEntryType(type)} />)}</View> : null}
          {instruments.isError ? (
            <ErrorNotice error={instruments.error} style={styles.warning}
              message="상품 목록을 불러오지 못했습니다. 보유 포지션에서 다시 선택할 수 있습니다." />
          ) : null}
          {allInstruments.length > 12 ? (
            <>
              <Text style={styles.label}>상품 검색</Text>
              <TextInput
                accessibilityLabel="선물 상품 검색"
                value={instrumentSearch}
                onChangeText={setInstrumentSearch}
                placeholder="이름 또는 심볼"
                style={styles.input}
                autoCapitalize="none"
              />
            </>
          ) : null}
          <View style={styles.choices}>
            {matchingInstruments.slice(0, 12).map((i) => (
              <Choice
                key={i.id}
                label={i.underlying.symbol}
                selected={i.id === instrument?.id}
                disabled={mutation.isPending || pendingResult || limitBusy}
                onPress={() => choose(i.id)}
              />
            ))}
          </View>
          {matchingInstruments.length > 12 ? (
            <Text style={styles.muted}>
              검색어를 입력하면 다른 상품을 찾을 수 있습니다.
            </Text>
          ) : search && !matchingInstruments.length ? (
            <Text style={styles.muted}>검색 결과가 없습니다.</Text>
          ) : null}
          {!instrument ? (
            <Text style={styles.muted}>현재 검증된 선물 상품이 없습니다.</Text>
          ) : (
            <>
              <Text style={styles.heading}>{instrument.underlying.name}</Text>
              <Metric
                label="현재가 · 선물 Last 거래 기준"
                value={
                  referenceFresh
                    ? price(reference, instrument)
                    : "시세 확인 불가"
                }
              />
              <Metric
                label="Mark Price · 평가/청산 기준"
                value={
                  markFresh
                    ? price(
                        position?.markPrice ?? instrument.markPrice,
                        instrument,
                      )
                    : "Mark 확인 불가"
                }
              />
              {!markFresh ? (
                <Text style={styles.warning}>
                  Mark가 없거나 오래되었습니다. Open/Increase는 제한되며,
                  현재가가 유효하면 Reduce/Close를 요청할 수 있습니다.
                </Text>
              ) : null}
              {position ? (
                <>
                  <Text style={styles.muted}>
                    {directionLabel[position.direction]} ·{" "}
                    {marginLabel[position.marginMode]} · {position.leverage}x
                    고정
                  </Text>
                  <Text style={styles.muted}>
                    방향·레버리지·증거금 모드는 전량 종료 후 새 포지션에서
                    선택할 수 있습니다.
                  </Text>
                  <View style={styles.choices}>
                    {(["increase", "reduce", "close"] as const).map((op) => (
                      <Choice
                        key={op}
                        label={operationLabel[op]}
                        selected={selectedOperation === op}
                        disabled={mutation.isPending || pendingResult || limitBusy}
                        onPress={() => {
                          setOperation(op);
                          setNotice(null);
                        }}
                      />
                    ))}
                  </View>
                </>
              ) : (
                <>
                  <View style={styles.choices}>
                    {(["long", "short"] as const).map((dir) => (
                      <Choice
                        key={dir}
                        label={directionLabel[dir]}
                        selected={direction === dir}
                        disabled={mutation.isPending || pendingResult || limitBusy}
                        onPress={() => setDirection(dir)}
                      />
                    ))}
                  </View>
                  <View style={styles.choices}>
                    {(["isolated", "cross"] as const).map((m) => (
                      <Choice
                        key={m}
                        label={marginLabel[m]}
                        selected={marginMode === m}
                        disabled={mutation.isPending || pendingResult || limitBusy}
                        onPress={() => setMarginMode(m)}
                      />
                    ))}
                  </View>
                  <Text style={styles.label}>레버리지 · 1~100 정수</Text>
                  <TextInput
                    ref={leverageRef}
                    accessibilityLabel="레버리지"
                    testID="futures-leverage"
                    value={leverage}
                    onChangeText={setLeverage}
                    editable={!mutation.isPending && !pendingResult && !limitBusy}
                    keyboardType="number-pad"
                    style={styles.input}
                    onFocus={() =>
                      inputScroll.onInputFocus(leverageRef.current)
                    }
                    onBlur={inputScroll.onInputBlur}
                  />
                </>
              )}
              <Text style={styles.label}>
                {selectedOperation === "close" ? "전량 종료 수량" : "거래 수량"}
              </Text>
              <TextInput
                ref={quantityRef}
                accessibilityLabel="거래 수량"
                testID="futures-quantity"
                value={selectedQuantity}
                onChangeText={setQuantity}
                editable={
                  selectedOperation !== "close" &&
                  !mutation.isPending &&
                  !pendingResult && !limitBusy
                }
                keyboardType="decimal-pad"
                style={styles.input}
                onFocus={() => inputScroll.onInputFocus(quantityRef.current)}
                onBlur={inputScroll.onInputBlur}
              />
              {selectedQuantity && inputError ? (
                <Text style={styles.warning}>{inputError}</Text>
              ) : null}
              {!position && entryType === 'limit' ? <FuturesLimitEntryForm key={`${accountId}:${instrument.id}`} accountId={accountId} instrumentId={instrument.id} assetId={instrument.underlying.assetId} direction={direction} marginMode={marginMode} leverage={leverage} quantity={quantity} allowed={bound && focused && covered && data.capabilities.canOpen && markFresh && !inputError && !pendingResult} onBusy={setLimitBusy} onInputFocus={inputScroll.onInputFocus} onInputBlur={inputScroll.onInputBlur} /> : <View ref={inputScroll.submitRef}>
                <CTAButton
                  label={`${operationLabel[selectedOperation]} · ${directionLabel[position?.direction ?? direction]}`}
                  testID="futures-submit"
                  onPress={submit}
                  state={
                    mutation.isPending
                      ? "loading"
                      : allowed && !inputError
                        ? "enabled"
                        : "disabled"
                  }
                />
              </View>}
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
          <ProtectionPanel
            accountId={accountId}
            assetId={instrument.underlying.assetId}
            domain="futures"
            currency="USD"
          />
        ) : null}
        <View style={styles.card}><Text style={styles.heading}>대기 주문</Text><PendingOrders key={accountId} accountId={accountId} isFocused={focused} seasonUi={binding.state === "bound" && binding.account.mode === "season"} /></View>
        <View style={styles.card}>
          <Text style={styles.heading}>선물 기록</Text>
          <View style={styles.choices}>
            {(["executions", "liquidations"] as const).map((kind) => (
              <Choice
                key={kind}
                label={kind === "executions" ? "체결 기록" : "강제청산 기록"}
                selected={kind === historyKind}
                onPress={() => {
                  setHistoryKind(kind);
                  setOffset(0);
                }}
              />
            ))}
          </View>
          {history.isError ? (
            <>
            <ErrorNotice error={history.error} message="기록을 불러오지 못했습니다." style={styles.warning} />
            <CTAButton
              label="기록 다시 불러오기"
              variant="secondary"
              onPress={() => void history.refetch()}
            />
            </>
          ) : history.isPending ? (
            <Text>기록을 불러오고 있습니다.</Text>
          ) : (
            <>
              {(history.data.executions ?? []).map((e) => (
                <View key={e.id} style={styles.history}>
                  <Text>
                    {e.instrument.underlying.symbol} ·{" "}
                    {operationLabel[e.operation]} ·{" "}
                    {directionLabel[e.direction]}
                  </Text>
                  <Metric
                    label={[
                      "수량 / 체결가",
                      futuresPriceBasisLabel(e.priceEvidence?.priceBasis),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    value={`${formatDisplayDecimal(e.quantity)} / ${price(e.executionPrice, e.instrument)}`}
                  />
                  <Metric
                    label="실현 손익 / 수수료"
                    value={`${usd(e.realizedPnl)} / ${usd(e.feeAmount)}`}
                  />
                  <Text style={styles.muted}>
                    {new Date(e.executedAt).toLocaleString("ko-KR")}
                  </Text>
                </View>
              ))}
              {(history.data.liquidations ?? []).map((e) => (
                <View key={e.id} style={styles.history}>
                  <Text>
                    {marginLabel[e.marginMode]} 전량 강제청산 ·{" "}
                    {e.closes.length}개 포지션
                  </Text>
                  <Metric label="경제적 실현 손익" value={usd(e.realizedPnl)} />
                  <Metric label="경제적 종료 수수료" value={usd(e.feeAmount)} />
                  {e.settledFee !== undefined ? (
                    <Metric
                      label="실제 정산 수수료"
                      value={usd(e.settledFee)}
                    />
                  ) : null}
                  <Metric label="실제 현금 정산" value={usd(e.settledCash)} />
                  <Metric
                    label="미충당 손실 · 부채 이월 없음"
                    value={usd(e.bankruptcyShortfall)}
                  />
                  {e.closes.map((c) => (
                    <View key={c.positionId} style={styles.history}>
                      <Text>
                        {c.markSnapshot?.symbol ?? "종료 포지션"} ·{" "}
                        {directionLabel[c.direction]}
                      </Text>
                      <Metric
                        label="종료 수량"
                        value={formatDisplayDecimal(c.quantity)}
                      />
                      <Metric
                        label="Mark 청산가"
                        value={formatAssetPrice(
                          c.executionPrice,
                          "USD",
                          allInstruments.find((i) => i.id === c.instrumentId)
                            ?.underlying.displayPriceDecimals ?? 8,
                        )}
                      />
                    </View>
                  ))}
                  <Text style={styles.muted}>
                    {new Date(e.executedAt).toLocaleString("ko-KR")}
                  </Text>
                </View>
              ))}
              {history.data.pagination.returned === 0 ? (
                <Text style={styles.muted}>기록이 없습니다.</Text>
              ) : null}
              <View style={styles.choices}>
                <Choice
                  label="이전"
                  disabled={offset === 0}
                  onPress={() => setOffset(Math.max(0, offset - 20))}
                />
                <Choice
                  label="다음"
                  disabled={history.data.pagination.nextOffset == null}
                  onPress={() =>
                    setOffset(history.data.pagination.nextOffset ?? offset)
                  }
                />
              </View>
            </>
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
            <Metric
              label="실현 손익"
              value={usd(final.data.settlement.realizedPnl)}
            />
            <Metric
              label="종료 수수료"
              value={usd(final.data.settlement.feeAmount)}
            />
            <Metric
              label="실제 현금 정산"
              value={usd(final.data.settlement.settledCash)}
            />
            <Metric
              label="미충당 손실"
              value={usd(final.data.settlement.bankruptcyShortfall)}
            />
          </View>
        ) : null}
      </ScrollView>
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
function Metric({
  label,
  value,
  pnl,
}: {
  label: string;
  value: string;
  pnl?: string | null;
}) {
  return (
    <View style={styles.metric}>
      <Text style={styles.muted}>{label}</Text>
      <Text
        selectable
        style={[
          styles.value,
          pnl && Number(pnl) !== 0
            ? { color: Number(pnl) > 0 ? financial.rise : financial.fall }
            : undefined,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}
function Choice({
  label,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <ActionPressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.choice,
        selected && styles.selected,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.choiceText, selected && styles.selectedText]}>
        {label}
      </Text>
    </ActionPressable>
  );
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
  content: {
    ...getScreenContentStyle(Platform.OS),
    gap: 16,
    padding: 16,
    paddingBottom: 40,
  },
  title: { fontSize: 24, fontWeight: "700", lineHeight: 34 },
  heading: { fontSize: 17, fontWeight: "700", lineHeight: 26 },
  card: {
    padding: 16,
    borderRadius: 16,
    backgroundColor: semantic.surface,
    gap: 12,
    minWidth: 0,
  },
  muted: {
    color: semantic.secondary,
    fontSize: 13,
    lineHeight: 21,
    flexShrink: 1,
  },
  label: { fontSize: 14, lineHeight: 22 },
  metric: { gap: 3, minWidth: 0 },
  value: {
    fontSize: 16,
    lineHeight: 25,
    flexShrink: 1,
    fontVariant: ["tabular-nums"],
  },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice: {
    minHeight: 44,
    padding: 12,
    borderRadius: 10,
    backgroundColor: semantic.raised,
    flexShrink: 1,
  },
  choiceText: { fontSize: 14, lineHeight: 22, textAlign: "center" },
  selected: { backgroundColor: semantic.secondaryActionSurface },
  selectedText: {
    color: semantic.secondaryActionForeground,
    fontWeight: "700",
  },
  disabled: { opacity: 0.45 },
  input: {
    padding: 12,
    fontSize: 17,
    minHeight: 48,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 10,
    backgroundColor: semantic.raised,
  },
  warning: { color: semantic.secondary, fontSize: 14, lineHeight: 23 },
  notice: { fontSize: 14, lineHeight: 23 },
  history: {
    gap: 8,
    borderTopWidth: 1,
    borderColor: semantic.border,
    paddingTop: 12,
  },
});
