import { useTradingGuideFacts } from '../../features/quest/useTradingGuideFacts';
import { useLearningAccess } from '../../features/quest/useLearningAccess';
import { questNavigationAllowed } from '../../features/quest/questNavigationGuard';
import { walletFundingMessage, walletFundingState, type FundingAction } from '../../features/wallet/walletFunding';
import WalletFundingNotice from '../../components/tradingAccount/WalletFundingNotice';
import WalletFundingSheet, { type FundingRequest } from '../wallet/WalletFundingSheet';
import { FUTURES_PRACTICE_LEVERAGE_MESSAGE } from '../../features/quest/questProgress';
import { useQuestGuide } from '../../features/quest/QuestGuideProvider';
import { captureQuestGuideCommand, questGuideTarget, registerQuestGuideReveal } from '../../features/quest/questGuideBridge';
import QuestTarget from '../../features/quest/QuestTarget';
import FuturesLimitEntryForm from './FuturesLimitEntryForm';
import FuturesConditionalEntryForm, {
  FuturesConditionalFields,
  emptyFuturesConditionalDraft,
  type FuturesConditionalDraft,
} from './FuturesConditionalEntryForm';
import FuturesInstrumentSheet from './FuturesInstrumentSheet';
import FuturesCloseSheet, { type FuturesCloseRequest } from './FuturesCloseSheet';
import FuturesLeverageChangeSheet, { type FuturesLeverageChangeRequest } from './FuturesLeverageChangeSheet';
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
  Keyboard,
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
import { useAdminDiagnostics } from "../../features/auth/useAdminDiagnostics";
import { resolveAccountBinding } from "../../features/tradingAccount/accountBinding";
import { getTradingAccount } from "../../features/tradingAccount/api";
import { QUERY_KEYS } from "../../constants/queryKeys";
import {
  changeFuturesLeverage,
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
  type FuturesPosition,
} from "../../features/futures/api";
import {
  freshFuturesEvaluation,
  freshFuturesEvidence,
  freshFuturesReference,
  futuresPriceBasisLabel,
  futuresServerNow,
  futuresActionAllowed,
  futuresInputError,
  futuresMarkNotice,
  positionCommand,
} from "../../features/futures/policy";
import { COLLATERAL_SHORT, MAINTENANCE_SHORT, futuresErrorMessage } from "../../features/futures/orderFeedback";
import { futuresHolding, getFuturesPositionDisplay } from "../../features/futures/positionDisplay";
import {
  futuresAmountAtRatio,
  futuresAmountExceeds,
  futuresAmountRatio,
  futuresEntryCapacity,
  futuresEntryEstimate,
  futuresPrice,
  futuresQuantityForAmount,
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
import AdminDiagnosticPanel from "../../components/states/AdminDiagnosticPanel";
import FullPageLoading from "../../components/states/FullPageLoading";
import FuturesPositionCard from './FuturesPositionCard';
import FuturesOrderBookCard from './FuturesOrderBookCard';

export default function FuturesScreen(props: FuturesScreenProps) {
  const { accountId, instrumentId, direction } = props.route.params;
  return <BoundFuturesScreen key={`${accountId}:${instrumentId ?? ""}:${direction ?? ""}:${getSessionGeneration()}`} {...props} />;
}

type ListView = 'positions' | 'pending';
/** Longer than the screen's 1 s re-render: it was not on screen meanwhile. */
const MARK_WATCH_GAP_MS = 3000;

/**
 * The futures trading screen, laid out like the spot order screen: the
 * contract header (picker, 무기한, the full-screen chart button), then one row
 * with the trade form on the left (롱/숏, margin mode and leverage, 주문방식,
 * the USD order amount and its ratio, submit) and the contract's book with its
 * current price on the right — side by side on every phone width — then the
 * positions and the futures-only pending views (records are in the central
 * 거래 내역). The amount is the position's USD notional; it becomes the
 * contract quantity the existing commands take.
 * Two-way positions (2026-11-06): the form is the same whether or not a
 * position is held; an order of a direction opens it or adds to its open
 * position (never the other direction's), a held position's margin mode is
 * fixed, and another leverage changes the position's only after the user
 * confirms it. Reducing and closing stay in each card's 포지션 종료.
 * Futures keeps its own financial rules: execution on Futures Last, valuation
 * and liquidation on Mark (평가 기준가), an individual liquidation price for
 * isolated positions only.
 */
export function BoundFuturesScreen({ route, navigation }: FuturesScreenProps) {
  const accountId = route.params.accountId;
  const learning = useLearningAccess(accountId);
  const guide = useQuestGuide();
  const { colors } = useAppearance();
  const { width, fontScale } = useWindowDimensions();
  const isAdmin = useAdminDiagnostics();
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
  const [, setClock] = useState(Date.now());
  const clock = Date.now();
  // When this contract's Mark was last seen fresh (or first watched): only how
  // long a member has gone without one, for what the screen says. Written
  // during render like `scope`; no order or limit reads it.
  const markSeen = useRef({ instrumentId: "", at: clock, renderedAt: clock });
  const [selectedId, setSelectedId] = useState(route.params.instrumentId ?? "");
  const [instrumentSheetOpen, setInstrumentSheetOpen] = useState(false);
  // The detail's 매수하기 / 매도하기 open a new long / short entry; long otherwise.
  const [direction, setDirection] = useState<Direction>(route.params.direction ?? "long");
  // The user's own margin mode and leverage choices. Null follows the open
  // position of the selected direction (its fixed margin mode, its current
  // leverage), else 격리 and 1x: choosing never changes a position.
  const [marginChoice, setMarginChoice] = useState<MarginMode | null>(null);
  const [leverageChoice, setLeverageChoice] = useState<string | null>(null);
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
  // The position whose 포지션 종료 sheet is open, that sheet's last refusal,
  // and the result of its last command (shown over the positions).
  const [closeTarget, setCloseTarget] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<{ cause: unknown; message: string } | null>(null);
  const [closeNotice, setCloseNotice] = useState<string | null>(null);
  // 레버리지 변경 확인: the change the user is asked to confirm, what the
  // confirmation then sends (a limit or conditional form's own submit), and
  // the leverage-only command's last refusal.
  const [leverageConfirm, setLeverageConfirm] = useState<FuturesLeverageChangeRequest | null>(null);
  const leverageProceed = useRef<(() => void) | null>(null);
  const [leverageError, setLeverageError] = useState<{ cause: unknown; message: string } | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [collateralAttempted, setCollateralAttempted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [listView, setListView] = useState<ListView>('positions');
  // 이체 into the Futures wallet, opened over this screen (the selected account,
  // which a bound screen is); leaving the screen or the account closes it.
  const [funding, setFunding] = useState<FundingRequest | null>(null);
  useEffect(() => { if (!bound || !focused) setFunding(null); }, [bound, focused]);
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
    /** The trade form or a position's 포지션 종료 sheet: where its result is shown. */
    origin: 'form' | 'close';
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
  // The freshness clock runs while this screen is on screen: under the
  // full-screen chart or behind another tab it re-rendered this whole screen
  // every second for nothing (an unfocused screen already counts as unwatched).
  useEffect(() => {
    if (!focused) return undefined;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [focused]);
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
      if (request.origin === 'close') {
        // The sheet closes on its fill; the trade form's draft is left as it was.
        setCloseTarget(null);
        setCloseError(null);
        setCloseNotice(`${execution.operation === 'close' ? '포지션 종료' : '포지션 감소'} 체결 완료 · 수수료 $${formatUsd(execution.feeAmount)}`);
        return;
      }
      setFailure(null);
      setAmount("");
      setChosenRatio(null);
      // The chosen leverage stays: once the positions refresh it is the position's own.
      const change = result.leverageChange;
      setNotice(
        `${change ? `레버리지 ${change.fromLeverage}x → ${change.toLeverage}x 변경 · ` : ''}${operationLabel[result.execution.operation]} 체결 완료 · 수수료 $${formatUsd(result.execution.feeAmount)}`,
      );
    },
    onError: (error, request) => {
      if (current(request)) {
        const info = getApiErrorInfo(error);
        if (info.serverCode === 'BEGINNER_FEATURE_LOCKED')
          void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.quests(accountId) });
        // Only a lost or failed response may have executed: that one keeps its
        // key for the same-request check. A clear refusal (4xx) did not fill.
        request.uncertain = !info.hasResponse || (info.status ?? 0) >= 500;
        if (!request.uncertain) action.current = null;
        const message = futuresErrorMessage(info.serverCode, request.uncertain);
        if (request.origin === 'close') { setCloseError({ cause: error, message }); return; }
        setFailure(error);
        setNotice(message);
      }
    },
    onSettled: () => {
      submitLock.current = false;
    },
  });
  // 레버리지만 변경: its own idempotent command (the same key while its answer is unknown).
  const leverageAction = useRef<{
    signature: string;
    positionId: string;
    command: { leverage: number; fromLeverage: number; idempotencyKey: string };
    epoch: number;
    session: number;
    uncertain?: boolean;
  } | null>(null);
  const leverageMutation = useMutation({
    mutationFn: (request: NonNullable<typeof leverageAction.current>) =>
      changeFuturesLeverage(accountId, request.positionId, request.command),
    onSuccess: (result, request) => {
      if (!isCurrentSession(request.session)) return;
      for (const queryKey of [
        QUERY_KEYS.tradingAccount.futures.all(accountId),
        QUERY_KEYS.tradingAccount.futuresCollateral(accountId),
        QUERY_KEYS.tradingAccount.walletsAll(accountId),
        QUERY_KEYS.tradingAccount.portfolioAll(accountId),
      ])
        void queryClient.invalidateQueries({ queryKey });
      if (!scope.current.mounted || request.epoch !== scope.current.epoch) return;
      leverageAction.current = null;
      setLeverageConfirm(null);
      setLeverageError(null);
      setFailure(null);
      setNotice(`레버리지 ${result.leverageChange.fromLeverage}x → ${result.leverageChange.toLeverage}x 변경 완료`);
    },
    onError: (error, request) => {
      if (!scope.current.mounted || request.epoch !== scope.current.epoch || !isCurrentSession(request.session)) return;
      const info = getApiErrorInfo(error);
      // Only a lost or failed answer may have changed it: that one keeps its key.
      request.uncertain = !info.hasResponse || (info.status ?? 0) >= 500;
      if (!request.uncertain) leverageAction.current = null;
      setLeverageError({
        cause: error,
        message: request.uncertain
          ? '변경 여부를 확인해야 해요. 같은 요청으로 다시 확인해 주세요.'
          : futuresErrorMessage(info.serverCode, false),
      });
    },
  });
  const pendingResult = !!action.current?.uncertain && current(action.current);
  const retryResult = () => {
    if (!action.current || !pendingResult || submitLock.current) return;
    submitLock.current = true;
    mutation.mutate(action.current);
  };
  // The terms the form shows for a contract: the user's choices, else the
  // open position of the selected direction (two-way: each direction has its
  // own), else 격리 · 1x.
  const formTerms = (contractId: string | undefined) => {
    const held = positions.data?.positions.find((p) => p.instrumentId === contractId && p.direction === direction);
    return {
      held,
      marginMode: marginChoice ?? held?.marginMode ?? 'isolated',
      leverage: leverageChoice ?? (held ? String(held.leverage) : '1'),
    };
  };
  const guideTerms = formTerms(selectedId || instruments.data?.instruments[0]?.id || positions.data?.positions[0]?.instrumentId);
  const practicePosition = positions.data?.positions.find(p => p.id === guide?.active?.positionId)
    ?? positions.data?.positions.find(p => p.instrumentId === selectedId && p.direction === direction)
    ?? positions.data?.positions.find(p => p.instrumentId === selectedId);
  useTradingGuideFacts({ screen: 'futures', accountId, direction, leverage: Number(guideTerms.leverage), marginMode: guideTerms.marginMode,
    leverageSheet: leverageSheet ?? undefined, positionSheetOpen: !!closeTarget || !!tpSlTarget,
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
  // The open position of the selected contract AND direction: an order adds
  // to it; the other direction's position is never touched from the form.
  const { held: position, marginMode, leverage } = formTerms(instrument?.id);
  const selectedOperation: Operation = position ? "increase" : "open";
  // A position's margin mode is fixed for its lifetime: another mode cannot add to it.
  const marginLocked = !!position && marginMode !== position.marginMode;
  // Another leverage changes the position's own — only after the user confirms it.
  const leverageChange = position && /^(?:[1-9]\d?|100)$/u.test(leverage) && Number(leverage) !== position.leverage
    ? { fromLeverage: position.leverage, toLeverage: Number(leverage) } : null;
  // Each read is judged on its own server clock (evaluatedAt + time since the
  // request was sent), not on the device clock: a device a second or two ahead
  // of the server made a fresh Mark flash "Mark 확인 불가" before every poll.
  const positionsNow = futuresServerNow(data, clock);
  const instrumentsNow = futuresServerNow(instruments.data, clock);
  // The position the 포지션 종료 sheet is open for, read live (null once gone),
  // with its own Mark (as its card shows it) and its own Futures Last.
  const closePosition = closeTarget ? data.positions.find((p) => p.id === closeTarget) ?? null : null;
  const closeView = closePosition ? {
    markFresh: getFuturesPositionDisplay(futuresHolding(closePosition), data.evaluatedAt, positionsNow).fresh,
    referenceFresh: !!futuresPrice(closePosition.referencePrice)
      && freshFuturesReference(closePosition.referencePriceEvidence, positionsNow),
  } : { markFresh: false, referenceFresh: false };
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
  // The screen re-renders every second while in front. Out of focus (the chart
  // screen over it) or after a longer silence (the app in the background) it
  // was not reading, so a Mark gone stale meanwhile is timed again from now.
  const seen = markSeen.current;
  const unwatched = !focused || clock - seen.renderedAt > MARK_WATCH_GAP_MS;
  if (markFresh || unwatched || seen.instrumentId !== (instrument?.id ?? ""))
    markSeen.current = { instrumentId: instrument?.id ?? "", at: clock, renderedAt: clock };
  else seen.renderedAt = clock;
  // A short gap is the Mark's own recovery: an admin sees it at once, a member
  // only once it lasts (FUTURES_MARK_NOTICE_DELAY_MS); until then the Mark is
  // being checked. Orders still follow markFresh below, never this.
  const markMissingForMs = clock - markSeen.current.at;
  const markNotice = futuresMarkNotice(markFresh, markMissingForMs, isAdmin);
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
  const selectedLeverage = leverage;
  const orderDirection = direction;
  const orderMarginMode = marginMode;
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
  const sizing = futuresQuantityForAmount(amount, basisPrice, unpriced);
  // The form only enters (a new position or an add); a reduce or close is the
  // position card's 포지션 종료.
  const effectiveOperation: Operation = selectedOperation;
  const selectedQuantity = sizing.state === "ready" ? sizing.quantity : "";
  const amountError = sizing.state === "invalid" || sizing.state === "unpriced" || sizing.state === "tooSmall"
    ? sizing.message : null;
  const inputError = amountError ?? futuresInputError(
    selectedQuantity,
    selectedLeverage,
    effectiveOperation,
    position,
  );
  const covered = allInstruments.some((i) => i.id === instrument?.id);
  const allowed =
    focused &&
    !pendingResult &&
    covered &&
    !!instrument &&
    !marginLocked &&
    futuresActionAllowed(
      data.capabilities,
      effectiveOperation,
      markFresh,
      referenceFresh,
    );
  // A command in flight, an unresolved result or a held limit/conditional
  // entry keeps the contract, side and method that request was made with.
  const locked = mutation.isPending || pendingResult || limitBusy || conditionalBusy || leverageMutation.isPending;
  const collateralKnown = timely && crossFresh;
  // 100% of an entry: what the free collateral carries after margin, fee and
  // the server's Cross/maintenance checks (an estimate; the server decides).
  const capacity = method !== "conditional" && !markFresh
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
    });
  const ratioBase = capacity.state === "ready" ? capacity.max : null;
  const ratioReason = capacity.state === "unavailable"
    ? capacity.reason === "fee"
      ? tradingAccount.isError ? "수수료 정보를 확인할 수 없어 비율을 계산할 수 없습니다." : "수수료 정보를 확인하는 중입니다."
      : capacity.reason === "mark"
        ? markNotice ? "평가 기준가를 확인할 수 없어 주문 가능 금액을 계산할 수 없습니다." : "가격을 확인하는 중입니다."
        : capacity.reason === "price" ? unpriced
        : capacity.reason === "maintenance" ? MAINTENANCE_SHORT
          : "사용 가능한 담보를 평가하는 중입니다."
    : ratioBase === "0" ? "주문가능 금액이 없습니다." : null;
  const amountAtRatio = (ratio: number) => (ratioBase ? futuresAmountAtRatio(ratioBase, ratio) : null);
  // The chosen quick ratio survives cent rounding only while it still writes this amount.
  const activeRatio = !ratioReason && chosenRatio !== null
    && (chosenRatio === 0 ? amount === "" : amountAtRatio(chosenRatio) === amount.trim())
    ? chosenRatio : null;
  const displayedRatio = activeRatio ?? (ratioReason ? 0 : futuresAmountRatio(amount, ratioBase));
  // Live pre-checks (the server still decides): no free collateral, or an
  // amount above what it carries, is refused here; unknown is never short.
  const entryProblem = method === "conditional" || !markFresh || !selectedQuantity || inputError
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
    const next = amountAtRatio(ratio);
    if (!next || next === "0") { setRatioMessage("계산된 금액이 너무 작습니다."); return; }
    setAmount(next);
    setChosenRatio(ratio);
  };
  // The margin mode and leverage the form shows next: the open position of
  // that contract and direction if there is one (followed), else the values
  // shown now (kept, as before for a new position).
  const keepTerms = (contractId: string | undefined, side: Direction) => {
    const held = data.positions.some((p) => p.instrumentId === contractId && p.direction === side);
    setMarginChoice(held ? null : marginMode);
    setLeverageChoice(held ? null : leverage);
  };
  const switchDirection = (next: Direction) => {
    if (locked || next === direction) return;
    keepTerms(instrument?.id, next);
    setDirection(next);
    clearFailure();
  };
  const choose = (id: string, side: Direction = direction) => {
    if (submitLock.current || pendingResult || limitBusy || conditionalBusy || leverageMutation.isPending) return;
    setInstrumentSheetOpen(false);
    setLeverageSheet(null);
    keepTerms(id, side);
    setSelectedId(id);
    setDirection(side);
    // Another contract's amount and ratio never carry over.
    setAmount("");
    setChosenRatio(null);
    setRatioMessage(null);
    clearFailure();
    action.current = null;
    // Another contract starts at 시장가 without a limit draft (the spot rule).
    setMethod(DEFAULT_ORDER_METHOD);
    setMethodSheetOpen(false);
    setLimitPrice("");
    setConditionalDraft(emptyFuturesConditionalDraft);
  };
  // As on the server (B차): a new position opens in its quest's direction
  // (above 1x before every quest is complete); an increase needs every quest
  // complete (close/reduce is the position card's 포지션 종료).
  const openGate = learning.gate(direction === 'short' ? 'futuresShortOpen' : 'futuresLongOpen');
  const practiceLeverage = effectiveOperation === 'open' && openGate.allowed && !learning.gate('allTrading').allowed
    && !(Number(selectedLeverage) > 1);
  const entryGate = effectiveOperation === 'increase' ? learning.gate('allTrading')
    : practiceLeverage ? learning.lock(FUTURES_PRACTICE_LEVERAGE_MESSAGE) : openGate;
  const advancedGate = learning.gate('allTrading');
  const conditionalGate = getFuturesConditionalGate({
    isLoading: conditionalEntries.isPending,
    isError: conditionalEntries.isError,
    data: conditionalEntries.data?.tradingAccountId === accountId ? conditionalEntries.data : null,
  });
  const methodOptions = getFuturesOrderMethodOptions(conditionalGate);
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
    // Another leverage than the position's: the user confirms the change first.
    if (leverageChange && position && !action.current?.uncertain) {
      setLeverageError(null);
      setLeverageConfirm({ kind: 'add', method: 'market', position, toLeverage: leverageChange.toLeverage,
        quantity: selectedQuantity, price: null });
      return;
    }
    send(null);
  };
  /**
   * The market open or add, with the leverage the user confirmed changing from
   * (or none). A confirmed add sends the quantity its sheet showed, not one the
   * 2 s price poll recomputed while the sheet was open.
   */
  const send = (fromLeverage: number | null, quantity = selectedQuantity) => {
    if (!instrument || submitLock.current) return;
    const signature = JSON.stringify([
      scope.current.epoch,
      instrument.id,
      position?.id,
      effectiveOperation,
      quantity,
      selectedLeverage,
      direction,
      marginMode,
      fromLeverage,
    ]);
    if (action.current?.signature !== signature) {
      const key = createIdempotencyKey("futures");
      action.current = {
        origin: 'form',
        reportQuestCommand: captureQuestGuideCommand(),
        signature,
        epoch: scope.current.epoch,
        session,
        command: position
          ? {
              ...positionCommand(position, "increase", quantity, key),
              leverage: Number(leverage),
              ...(fromLeverage === null ? {} : { fromLeverage }),
            }
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
    setRatioMessage(null);
    mutation.mutate(action.current);
  };
  // A position's 포지션 종료 sheet sends the existing reduce or close command of
  // that position on this screen's one command path (same key on a retry, the
  // same lock, refresh and quest report); only where its result shows differs.
  const submitClose = (target: FuturesPosition, { operation: op, quantity }: FuturesCloseRequest) => {
    if (submitLock.current || pendingResult || limitBusy || conditionalBusy) return;
    const signature = JSON.stringify([scope.current.epoch, 'close', target.id, op, op === 'close' ? target.quantity : quantity]);
    if (action.current?.signature !== signature) {
      action.current = {
        origin: 'close',
        reportQuestCommand: captureQuestGuideCommand(),
        signature,
        epoch: scope.current.epoch,
        session,
        command: positionCommand(target, op, quantity, createIdempotencyKey("futures")),
      };
    }
    submitLock.current = true;
    setCloseError(null);
    setCloseNotice(null);
    mutation.mutate(action.current);
  };
  // The position sheets open over the screen without the form's keyboard; a
  // close waits like every other command (its card button is off meanwhile).
  const openTpSl = (positionId: string) => {
    Keyboard.dismiss();
    setTpSlTarget({ type: 'futures_position', accountId, positionId });
  };
  const openClose = (positionId: string) => {
    if (submitLock.current || pendingResult) return;
    Keyboard.dismiss();
    setCloseError(null);
    setCloseNotice(null);
    setCloseTarget(positionId);
  };
  // A position card's top (name and side, PnL, 수익률): trade that contract
  // in that direction — the form follows the position's terms, another
  // contract's draft never carries over, and nothing is ordered by the tap.
  const tradeFrom = (target: FuturesPosition) => {
    if (submitLock.current || pendingResult || limitBusy || conditionalBusy || leverageMutation.isPending) return;
    Keyboard.dismiss();
    if (target.instrumentId !== instrument?.id) choose(target.instrumentId, target.direction);
    else {
      if (target.direction !== direction) {
        setDirection(target.direction);
        clearFailure();
      }
      setMarginChoice(null);
      setLeverageChoice(null);
    }
    inputScroll.scrollRef.current?.scrollTo({ y: 0, animated: true });
  };
  // 레버리지만 변경: the confirmation sheet without an order.
  const openLeverageOnly = () => {
    if (locked || !position || !leverageChange) return;
    Keyboard.dismiss();
    setLeverageError(null);
    setLeverageConfirm({ kind: 'only', method: method === 'limit' || method === 'conditional' ? method : 'market', position,
      toLeverage: leverageChange.toLeverage, quantity: null, price: null });
  };
  // A limit or conditional form's submit, after the user confirms the change.
  const confirmEntryLeverage = (kind: 'limit' | 'conditional') => (proceed: () => void) => {
    if (!position || !leverageChange) { proceed(); return; }
    leverageProceed.current = proceed;
    setLeverageError(null);
    setLeverageConfirm({ kind: 'add', method: kind, position, toLeverage: leverageChange.toLeverage,
      quantity: selectedQuantity || null, price: basisPrice });
  };
  const confirmLeverage = () => {
    const request = leverageConfirm;
    if (!request) return;
    if (request.kind === 'only') {
      if (leverageMutation.isPending) return;
      const signature = JSON.stringify([scope.current.epoch, request.position.id, request.position.leverage, request.toLeverage]);
      if (leverageAction.current?.signature !== signature)
        leverageAction.current = { signature, positionId: request.position.id, epoch: scope.current.epoch, session,
          command: { leverage: request.toLeverage, fromLeverage: request.position.leverage,
            idempotencyKey: createIdempotencyKey('futures-leverage') } };
      setLeverageError(null);
      leverageMutation.mutate(leverageAction.current);
      return;
    }
    // An add: the order itself carries the leverage it confirmed changing from.
    // Only the add that was confirmed: a position closed meanwhile (손절가/익절가,
    // liquidation, another device) sends nothing, never a new position in its place.
    if (request.method === 'market' && position?.id !== request.position.id) {
      setLeverageError({ cause: null, message: '확인하는 동안 포지션이 바뀌어 주문하지 않았어요. 다시 확인해 주세요.' });
      return;
    }
    setLeverageConfirm(null);
    if (request.method === 'market') send(request.position.leverage, request.quantity ?? selectedQuantity);
    else {
      const proceed = leverageProceed.current;
      leverageProceed.current = null;
      proceed?.();
    }
  };
  const closeLeverage = () => {
    if (leverageMutation.isPending) return;
    setLeverageConfirm(null);
    setLeverageError(null);
    leverageProceed.current = null;
  };
  const estimateLines: string[] = [];
  if (sizing.state === "ready") {
    estimateLines.push(`예상 수량 ${formatDisplayDecimal(sizing.quantity)} ${baseSymbol}`);
    const estimate = futuresEntryEstimate(amount, Number(selectedLeverage), feeRate);
    if (estimate) {
      estimateLines.push(`${leverageChange ? '이번 주문 ' : ''}예상 증거금 $${formatUsd(estimate.margin)}`);
      if (estimate.fee !== null) estimateLines.push(`예상 수수료 $${formatUsd(estimate.fee)}`);
    }
  }
  const freeCollateral = collateralKnown ? data.collateral.freeCollateral : null;
  // The Futures wallet for a new entry or an increase only (a reduce or close
  // needs no money): empty when this read's balance is exactly zero; all held
  // as margin or by orders when a known free collateral is none; else silent.
  const fundingState = timely
    ? walletFundingState(data.collateral.balanceAmount, freeCollateral === null ? null : hasNoFreeCollateral(freeCollateral) ? '0' : freeCollateral)
    : null;
  const transferGate = learning.gate('transfer');
  const openFunding = (action: FundingAction) => {
    if (action.kind === 'transfer' && questNavigationAllowed('WalletTransfer'))
      transferGate.guard(() => setFunding({ kind: 'transfer', destination: action.destination }));
  };
  const availableText = freeCollateral === null ? "주문가능 평가 대기" : `주문가능 ${formatUsd(freeCollateral)} USD`;
  const amountLabel = selectedOperation === "increase" ? "추가 금액 (USD)" : "주문 금액 (USD)";
  const stackedControls = width / fontScale < 360;
  // "(Short)" cannot fit half the column at large fonts: the segment shows 롱/숏
  // (the spoken names keep Long/Short). This estimate only decides until the
  // segment has measured the full names in the device's font (OrderSideSegment).
  const compactSides = width < 220 * fontScale + 80;
  const compact = width < 600;
  return (
    // Android draws edge to edge, so the keyboard no longer resizes the
    // window (adjustResize): pad for it on both platforms.
    <KeyboardAvoidingView
      style={styles.screen}
      behavior="padding"
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
            // The spot order screen's chart button: the contract's chart on its
            // own screen, over this one (the form stays as it is underneath).
            <ActionPressable
              testID="futures-open-chart"
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel="전체화면 차트 열기"
              onPress={() => navigation.navigate('FuturesChart', {
                accountId,
                instrumentId: instrument.id,
                symbol: instrument.underlying.symbol,
                displayPriceDecimals: instrument.underlying.displayPriceDecimals,
              })}
            >
              <Svg width={22} height={22} viewBox="0 0 24 24" aria-hidden>
                <Path d="M5 3v18M2 8h6v7H2zM12 2v17M9 5h6v8H9zM19 6v16M16 11h6v7h-6z" fill="none"
                  stroke={colors.secondary} strokeWidth={1.5} />
              </Svg>
            </ActionPressable>
          ) : null}
        </View>
        {/* The contract's Last stays in the book beside the form and on the
            detail screen; this screen only says when a missing price limits
            new entries (orders still follow the fresh evidence checks). */}
        {instrument ? (
          <>
            {markNotice === "diagnostic" ? (
              <>
                <Text testID="futures-mark-diagnostic" style={styles.warning}>
                  Mark가 없거나 오래되었습니다. Open/Increase는 제한되며,
                  현재가가 유효하면 Reduce/Close를 요청할 수 있습니다.
                </Text>
                <AdminDiagnosticPanel runtime={{
                  instrumentId: instrument.id,
                  markState: position ? position.markState : instrument.markState,
                  markEffectiveAt: (position ? position.markEvidence : instrument.markEvidence)?.effectiveAt,
                  positionsEvaluatedAt: data.evaluatedAt,
                  instrumentsEvaluatedAt: instruments.data?.evaluatedAt,
                  readTimely: timely,
                  crossMarkFresh: crossFresh,
                  markMissingForMs,
                }} />
              </>
            ) : markNotice === "member" ? (
              <Text testID="futures-mark-notice" style={styles.warning}>
                가격 확인이 지연되어 신규 진입과 추가 주문이 잠시 제한될 수 있습니다.
              </Text>
            ) : null}
          </>
        ) : null}
        {/* The spot order screen's row: the form beside the book on every width. */}
        <View style={[styles.tradingRow, compact && styles.compactTradingRow]} testID="futures-trading-columns">
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
                {/* Two-way: 롱/숏, margin mode and leverage are always offered; an
                    order of a direction adds to its open position, never to the other. */}
                <View ref={questGuideTarget('futures-direction')} collapsable={false}>
                  <OrderSideSegment
                    testID="futures-direction"
                    side={direction === 'long' ? 'buy' : 'sell'}
                    labels={{ buy: directionLabel.long, sell: directionLabel.short }}
                    compactLabels={{ buy: '롱', sell: '숏' }}
                    compactAtFirst={compactSides}
                    accessibilityLabels={{ buy: directionLabel.long, sell: directionLabel.short }}
                    testIDs={{ buy: 'futures-direction-long', sell: 'futures-direction-short' }}
                    disabled={locked}
                    onChange={(side) => switchDirection(side === 'buy' ? 'long' : 'short')}
                  />
                </View>
                {position ? (
                  <Text testID="futures-position-add-hint" style={styles.helper}>
                    보유 {position.direction === 'long' ? '롱' : '숏'} 포지션에 추가 · {position.marginMode === 'cross' ? '교차' : '격리'} {position.leverage}x
                  </Text>
                ) : null}
                <View ref={questGuideTarget('futures-margin')} collapsable={false} style={styles.controls}>
                  <FuturesMarginModeField value={marginMode} onChange={(value) => { setMarginChoice(value); clearFailure(); }} disabled={locked} />
                  {marginLocked && position ? (
                    <Text testID="futures-margin-locked" accessibilityLiveRegion="polite" style={styles.error}>
                      보유 {position.direction === 'long' ? '롱' : '숏'} 포지션은 {position.marginMode === 'cross' ? '교차' : '격리'}로 고정돼 있어요.
                      {' '}{position.marginMode === 'cross' ? '교차' : '격리'}로만 추가할 수 있어요.
                    </Text>
                  ) : null}
                  <FuturesLeverageSelect
                    leverage={Number(leverage)}
                    disabled={locked}
                    sheet={locked ? null : leverageSheet}
                    onSheetChange={setLeverageSheet}
                    onChange={(value) => { setLeverageChoice(String(value)); clearFailure(); }}
                  />
                  {leverageChange && !marginLocked ? (
                    <View testID="futures-leverage-change-notice" style={styles.leverageNotice}>
                      <Text style={styles.leverageNoticeTitle}>
                        포지션 레버리지 {leverageChange.fromLeverage}x → {leverageChange.toLeverage}x
                      </Text>
                      <Text style={styles.helper}>
                        선택만으로는 바뀌지 않아요. 주문하거나 아래에서 변경할 때 확인 후 적용돼요.
                      </Text>
                      <ActionPressable testID="futures-leverage-only" accessibilityRole="button"
                        accessibilityLabel={`레버리지만 ${leverageChange.toLeverage}배로 변경`}
                        accessibilityState={{ disabled: locked || !data.capabilities.canIncrease }}
                        aria-disabled={locked || !data.capabilities.canIncrease}
                        disabled={locked || !data.capabilities.canIncrease} onPress={openLeverageOnly}
                        style={[styles.leverageOnly, (locked || !data.capabilities.canIncrease) && styles.disabledAction]}>
                        <Text style={styles.leverageOnlyText}>레버리지만 변경</Text>
                      </ActionPressable>
                    </View>
                  ) : null}
                </View>
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
                    {/* The beginner entry step spotlights the amount and its ratio controls (QUEST 09·10). */}
                    <FuturesAmountField
                      label={amountLabel}
                      amount={amount}
                      onChange={changeAmount}
                      editable={!locked}
                      estimate={estimateLines}
                      ratioLabel="주문 금액 비율"
                      ratio={displayedRatio}
                      activeRatio={activeRatio}
                      ratioDisabled={!!ratioReason}
                      ratioReason={ratioReason}
                      onRatio={applyRatio}
                      available={availableText}
                      availableTarget={questGuideTarget('futures-funding')}
                      amountTarget={questGuideTarget('futures-amount')}
                      ratioTarget={questGuideTarget('futures-ratio')}
                      onInputFocus={inputScroll.onInputFocus}
                      onInputBlur={inputScroll.onInputBlur}
                    />
                    {amount.trim() && inputError ? (
                      <Text testID="futures-amount-error" accessibilityLiveRegion="polite" style={styles.error}>{inputError}</Text>
                    ) : null}
                    {fundingState ? (
                      <WalletFundingNotice testID="futures-wallet-funding" product="crypto_futures"
                        message={walletFundingMessage('crypto_futures', fundingState)} onAction={openFunding} disabled={locked} />
                    ) : collateralShort || orderNotice === COLLATERAL_SHORT ? (
                      <WalletFundingNotice testID="futures-funding-actions" product="crypto_futures" message={null}
                        onAction={openFunding} disabled={locked} />
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
                        allowed={bound && focused && covered && data.capabilities[position ? 'canIncrease' : 'canOpen'] && markFresh
                          && !inputError && !riskBlocked && !pendingResult && !marginLocked && !leverageMutation.isPending}
                        collateralError={collateralShort ? COLLATERAL_SHORT : null}
                        leverageChange={leverageChange ? { fromLeverage: leverageChange.fromLeverage, confirm: confirmEntryLeverage('limit') } : null}
                        onBusy={setLimitBusy} />
                    ) : method === 'conditional' ? (
                      <FuturesConditionalEntryForm key={`${accountId}:${instrument.id}`} accountId={accountId} instrumentId={instrument.id}
                        direction={direction} marginMode={marginMode} leverage={leverage} quantity={selectedQuantity} draft={conditionalDraft}
                        onDraftChange={setConditionalDraft}
                        lastPrice={referenceFresh ? reference ?? null : null} displayDecimals={instrument.underlying.displayPriceDecimals}
                        allowed={bound && focused && covered && data.capabilities[position ? 'canIncrease' : 'canOpen'] && referenceFresh
                          && !inputError && !pendingResult && !marginLocked && !leverageMutation.isPending
                          && conditionalGate.state === 'ready' && conditionalGate.enabled}
                        leverageChange={leverageChange ? { fromLeverage: leverageChange.fromLeverage, confirm: confirmEntryLeverage('conditional') } : null}
                        onBusy={setConditionalBusy} />
                    ) : (
                      <View ref={inputScroll.submitRef}>
                        <QuestTarget id="futures-submit"><CTAButton
                          learningHint={entryGate.locked ? entryGate.message : null}
                          learningCaption={entryGate.locked ? entryGate.caption : null}
                          label={`${directionLabel[orderDirection]} ${operationVerb[effectiveOperation]}`}
                          testID="futures-submit"
                          style={{ backgroundColor: orderDirection === 'long' ? BUY_COLOR : SELL_COLOR }}
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
                평가 기준가를 확인할 수 없어 위험 평가를 표시하지 않습니다.
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
            <>
              {/* A 포지션 종료 sheet's fill reads here, also after the last position closed. */}
              {closeNotice ? (
                <Text accessibilityRole="alert" style={styles.notice} testID="futures-close-notice">{closeNotice}</Text>
              ) : null}
              {!data.positions.length ? (
                <Text style={styles.muted} testID="futures-positions-empty">포지션이 없습니다.</Text>
              ) : data.positions.map((p) => (
                <FuturesPositionCard key={p.id} position={p} evaluatedAt={data.evaluatedAt} now={positionsNow}
                  disabled={locked} capabilities={data.capabilities}
                  tpSlSummary={tpSlRows ? tpSlCountSummary(tpSlRows.filter((row) => row.positionId === p.id)) : null}
                  onTrade={() => tradeFrom(p)} onTpSl={() => openTpSl(p.id)} onClose={() => openClose(p.id)} />
              ))}
            </>
          ) : (
            // Futures orders and settings only (the other screens keep the whole list).
            <PendingOrders key={accountId} accountId={accountId} isFocused={focused} seasonUi={binding.account.mode === "season"} scope="futures" />
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
      <FuturesCloseSheet
        open={focused && !!closeTarget}
        position={closePosition}
        markFresh={closeView.markFresh}
        referenceFresh={closeView.referenceFresh}
        capabilities={data.capabilities}
        busy={mutation.isPending}
        held={limitBusy || conditionalBusy}
        uncertain={pendingResult}
        error={closeError}
        onSubmit={(request) => { if (closePosition) submitClose(closePosition, request); }}
        onRetry={retryResult}
        onClose={() => setCloseTarget(null)}
      />
      <FuturesLeverageChangeSheet
        accountId={accountId}
        request={focused && bound ? leverageConfirm : null}
        active={focused && bound}
        busy={leverageMutation.isPending}
        error={leverageError}
        onConfirm={confirmLeverage}
        onClose={closeLeverage}
      />
      {/* 이체 over this screen: closes on success; the next reads carry the new balance and margin. */}
      <WalletFundingSheet testID="futures" request={funding} visible={focused && bound} closeOnSuccess onClose={() => setFunding(null)} />
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
const operationLabel = {
  open: "신규 진입(Open)",
  increase: "수량 추가(Increase)",
  reduce: "수량 감소(Reduce)",
  close: "전량 종료(Close)",
};
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
  // The amount field as one guide target; never wider than its column (RN Web).
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
  // Rows wrap; on narrow widths and large fonts each item takes a full line.
  full: { flexBasis: '100%', width: '100%' },
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
  // Margin mode above leverage: the narrow form column stacks its controls.
  controls: { gap: 12, minWidth: 0 },
  label: { fontSize: 12, color: semantic.muted },
  helper: { fontSize: 12, color: semantic.secondary },
  // The position's leverage would change: shown under the selector, with the
  // explicit 레버리지만 변경 (choosing alone never changes the position).
  leverageNotice: { gap: 6, padding: 10, borderRadius: 10, backgroundColor: semantic.raised, minWidth: 0 },
  leverageNoticeTitle: { fontSize: 14, lineHeight: 20, fontWeight: '700', color: semantic.text, flexShrink: 1 },
  leverageOnly: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 8,
    borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.surface, maxWidth: '100%' },
  leverageOnlyText: { fontSize: 13, lineHeight: 19, fontWeight: '700', color: semantic.text, textAlign: 'center', flexShrink: 1 },
  disabledAction: { opacity: 0.5 },
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
