import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Text, View } from '../../../theme/native';
import { semantic } from '../../../theme/tokens';
import CTAButton from '../../../components/common/CTAButton';
import ErrorNotice from '../../../components/states/ErrorNotice';
import { QUERY_KEYS } from '../../../constants/queryKeys';
import { getProtections } from '../api';
import {
  cancelConditionalSellOrder,
  createConditionalSellOrder,
  getConditionalSellOrders,
  type ConditionalSellCreateDto,
  type ConditionalSellOrderDto,
} from '../conditionalSellApi';
import { getOpenConditionalSellOrders } from '../conditionalSellLists';
import { getConditionalSellCancelPath, getConditionalSellStateLabel } from '../conditionalSellDisplay';
import {
  EMPTY_TP_SL_LEG,
  TP_SL_KINDS,
  TP_SL_KIND_LABEL,
  formatTpSlQuantity,
  getTpSlLegError,
  isTpSlAlreadyMet,
  quantityForPercent,
  sellableUsdEstimate,
  tpSlCountSummary,
  type TpSlKind,
  type TpSlLegDraft,
} from '../tpSlModel';
import { getAccountHoldings } from '../../tradingAccount/holdings';
import { cancelTradingAccountOrder, getTradingAccountPositions } from '../../tradingAccount/api';
import { invalidateAfterOrderCancel } from '../../tradingAccount/invalidation';
import { getCurrentFxRate } from '../../wallet/api';
import { isPreviewFxAvailable } from '../../tradingAccount/indicativePreview';
import { emitOrderFillEvent } from '../../order/fillEvents';
import { captureQuestGuideCommand } from '../../quest/questGuideBridge';
import { useQuestGuide } from '../../quest/QuestGuideProvider';
import QuestTarget from '../../quest/QuestTarget';
import { useTradingGuideFacts } from '../../quest/useTradingGuideFacts';
import { useLearningAccess } from '../../quest/useLearningAccess';
import { getApiErrorCode, getApiErrorInfo, getErrorMessageFromCode } from '../../../services/api/errorMapper';
import { createIdempotencyKey } from '../../../utils/idempotency';
import { formatDisplayDecimal, getAssetNameDisplay } from '../../../utils/format';
import TpSlLegFields from './TpSlLegFields';
import TpSlRow from './TpSlRow';

const USD_KRW = { baseCurrency: 'USD', quoteCurrency: 'KRW', refresh: false } as const;
const BODY_KEY: Record<TpSlKind, 'takeProfit' | 'stopLoss'> = { take_profit: 'takeProfit', stop_loss: 'stopLoss' };
const UNCERTAIN_CREATE = '등록 결과를 확인하지 못했어요. 위 목록을 먼저 확인해 주세요. 같은 내용으로 다시 누르면 중복 없이 다시 확인해요.';
const freshLegs = (): Record<TpSlKind, TpSlLegDraft> => ({ take_profit: EMPTY_TP_SL_LEG, stop_loss: EMPTY_TP_SL_LEG });
type Request = { accountId: string; epoch: number; body: ConditionalSellCreateDto; reportQuestCommand: ReturnType<typeof captureQuestGuideCommand> };

/**
 * 손절가/익절가 of one Spot holding (KRX stock, crypto): the live independent
 * settings with cancel, and new ones — a take-profit and/or a stop-loss, each
 * a trigger price and a whole-percent share of today's holding fixed into a
 * quantity when registered. They sell at market through the ordinary SELL
 * when reached; nothing is reserved while watching, and a fired setting never
 * cancels the others. A live whole-position OCO group on the holding blocks
 * new settings (server PROTECTION_CONFLICT).
 */
export default function SpotHoldingTpSl({ accountId, assetId, onBusyChange, onInputFocus, onInputBlur, submitRef }: {
  accountId: string;
  assetId: string;
  onBusyChange: (busy: boolean) => void;
  onInputFocus?: (input: View | null) => void;
  onInputBlur?: () => void;
  submitRef?: React.RefObject<View | null>;
}) {
  const queryClient = useQueryClient();
  const guide = useQuestGuide();
  // The same holdings read as the list under the order form (shared cache).
  const holdingsQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.holdings(accountId),
    queryFn: () => getAccountHoldings(accountId, getTradingAccountPositions),
    refetchInterval: 4000,
  });
  const position = holdingsQuery.data?.tradingAccountId === accountId
    ? holdingsQuery.data.positions.find((row) => row.assetId === assetId) ?? null : null;
  const settingsQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.conditionalSell.open(accountId, 'protection'),
    queryFn: ({ signal }) => getOpenConditionalSellOrders(accountId, 'protection', getConditionalSellOrders, signal),
    refetchInterval: 4000,
  });
  const settingsData = settingsQuery.data?.tradingAccountId === accountId ? settingsQuery.data : null;
  const settings = (settingsData?.conditionalOrders ?? []).filter((row) => row.assetId === assetId);
  const live = settings.filter((row) => row.state === 'watching' || row.state === 'triggered');
  const ocoQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.protections.list(accountId, 'spot', assetId),
    queryFn: ({ signal }) => getProtections(accountId, 'spot', assetId, false, signal),
    retry: false,
  });
  const ocoActive = !ocoQuery.isError && ocoQuery.data?.tradingAccountId === accountId
    && ocoQuery.data.groups.some((group) => group.status === 'active' || group.status === 'holding');
  const krw = position?.currencyCode === 'KRW';
  const fxQuery = useQuery({
    queryKey: QUERY_KEYS.wallet.fxRate(USD_KRW),
    queryFn: () => getCurrentFxRate(USD_KRW.baseCurrency, USD_KRW.quoteCurrency, USD_KRW.refresh),
    enabled: krw,
  });
  const learning = useLearningAccess(accountId).gate(position?.assetType === 'crypto' ? 'spotProtection' : 'allTrading');

  const [legs, setLegs] = useState(freshLegs);
  const [registered, setRegistered] = useState<ConditionalSellOrderDto[] | null>(null);
  const [error, setError] = useState<{ cause: unknown; uncertain: boolean } | null>(null);
  // An uncertain create keeps its exact key and body for a same-intent retry;
  // any edit makes a new intent with a new key.
  const actionRef = useRef<Request | null>(null);
  const scopeRef = useRef({ epoch: 0, mounted: true });
  useEffect(() => {
    const scope = scopeRef.current;
    scope.mounted = true;
    return () => { scope.mounted = false; };
  }, []);
  const isCurrent = (request: Request) => scopeRef.current.mounted && request.epoch === scopeRef.current.epoch;

  const mutation = useMutation({
    mutationFn: (request: Request) => createConditionalSellOrder(request.accountId, request.body),
    retry: false,
    onSuccess: async (result, request) => {
      for (const row of result.conditionalOrders)
        emitOrderFillEvent({ kind: 'watch', side: 'sell', accountId: request.accountId, watchId: row.id });
      request.reportQuestCommand({ kind: 'protection', accountId: request.accountId, assetId, summary: '손절가/익절가 설정이 서버에 등록됐어요.' });
      if (isCurrent(request)) {
        actionRef.current = null;
        setRegistered(result.conditionalOrders);
        setError(null);
        setLegs(freshLegs());
      }
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.conditionalSell.all(request.accountId) });
    },
    onError: (cause, request) => {
      if (!isCurrent(request)) return;
      const info = getApiErrorInfo(cause);
      const uncertain = !info.hasResponse || (info.status ?? 0) >= 500;
      if (!uncertain) actionRef.current = null;
      setError({ cause, uncertain });
    },
  });
  const cancel = useMutation({
    mutationFn: async (row: ConditionalSellOrderDto): Promise<unknown> => {
      const path = getConditionalSellCancelPath(row);
      return path?.kind === 'order' ? cancelTradingAccountOrder(accountId, path.orderId) : cancelConditionalSellOrder(accountId, row.id);
    },
    retry: false,
    onSettled: async (_result, _error, row) => {
      if (getConditionalSellCancelPath(row)?.kind === 'order') await invalidateAfterOrderCancel(queryClient, accountId, { seasonUi: false });
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.conditionalSell.all(accountId) });
    },
  });
  const pending = mutation.isPending;
  useEffect(() => { onBusyChange(pending || cancel.isPending); }, [cancel.isPending, onBusyChange, pending]);

  const holding = position?.quantity ?? null;
  const available = position?.availableQuantity ?? null;
  const currency = position?.currencyCode ?? '';
  const unit = position?.assetType === 'crypto' ? (position.symbol ?? '').replace(/USDT$/u, '') : '주';
  const valuation = position?.valuation.state === 'available' ? position.valuation : null;
  const sellable = sellableUsdEstimate({
    available: available ?? holding,
    price: valuation?.currentPrice ?? null,
    priceCurrency: valuation?.priceCurrency ?? null,
    usdKrw: !fxQuery.isError && isPreviewFxAvailable(fxQuery.data, Date.now()) ? fxQuery.data?.rate ?? null : null,
  });
  const currentPrice = valuation?.currentPrice ?? null;

  const edit = (update: () => void) => {
    if (pending) return;
    update();
    actionRef.current = null;
    scopeRef.current.epoch += 1;
    setRegistered(null);
    setError(null);
  };
  const patch = (kind: TpSlKind, value: Partial<TpSlLegDraft>) =>
    edit(() => setLegs((previous) => ({ ...previous, [kind]: { ...previous[kind], ...value } })));
  const active = TP_SL_KINDS.filter((kind) => legs[kind].enabled);
  const legError = (kind: TpSlKind) => getTpSlLegError({ kind, draft: legs[kind], direction: 'long', mode: 'quantity', basis: holding, scale: 6, existing: live });
  const draftError = active.length === 0 ? '익절가 또는 손절가 중 하나 이상을 선택해주세요.' : active.map(legError).find((message) => message !== null) ?? null;
  const unsupported = position && position.assetType !== 'domestic_stock' && position.assetType !== 'crypto';
  const blockedReason = !position
    ? holdingsQuery.isError ? '보유 수량을 확인하지 못했어요.' : holdingsQuery.data ? '보유 수량이 없어 설정할 수 없어요.' : '보유 수량을 확인하는 중이에요.'
    : unsupported ? '이 종목은 손절가/익절가 설정을 지원하지 않아요.'
    : settingsQuery.isError && !settingsData ? '등록된 설정을 확인하지 못했어요.'
    : !settingsData ? '등록된 설정을 확인하는 중이에요.'
    : !settingsData.capabilities.protection?.canCreate ? '현재 손절가/익절가를 새로 등록할 수 없어요.'
    : ocoActive ? '이 종목에는 기존 TP/SL(OCO) 보호가 있어 함께 설정할 수 없어요. 대기 목록의 TP/SL에서 기존 보호를 취소한 뒤 등록해 주세요.'
    : null;
  const canSubmit = !blockedReason && !draftError && !pending;
  // Still reading the holding or its settings: not a block for the guide.
  const checking = !position ? !holdingsQuery.isError && !holdingsQuery.data : !unsupported && !settingsData && !settingsQuery.isError;
  const guided = guide?.active?.quest === 'protection' && guide.active.accountId === accountId && guide.active.assetId === assetId;
  useTradingGuideFacts({ screen: 'protection', accountId, assetId, protectionEditing: true, tpSlReady: canSubmit, pending,
    blocked: !!blockedReason && !checking }, guided);

  const submit = () => {
    if (!learning.allowed && !actionRef.current) { learning.guard(() => undefined); return; }
    if (!canSubmit && !(actionRef.current && error)) return;
    if (pending || blockedReason) return;
    setError(null);
    if (!actionRef.current) {
      // Each share becomes a fixed quantity now; the server stores exactly this.
      const leg = (kind: TpSlKind) => ({ triggerPrice: legs[kind].triggerPrice.trim(), executionType: 'market' as const,
        quantity: quantityForPercent(holding, legs[kind].percent, 6) ?? '' });
      actionRef.current = { accountId, epoch: scopeRef.current.epoch, reportQuestCommand: captureQuestGuideCommand(), body: {
        kind: 'protection', assetId,
        ...Object.fromEntries(active.map((kind) => [BODY_KEY[kind], leg(kind)])),
        idempotencyKey: createIdempotencyKey('sell_protection'),
      } };
    }
    mutation.mutate(actionRef.current);
  };

  const name = getAssetNameDisplay(position ?? { symbol: null, name: null });
  return (
    <View style={styles.body} testID="tp-sl-spot-holding">
      <View style={styles.header}>
        <Text style={styles.name}>{name.primary}{name.secondary ? ` · ${name.secondary}` : ''}</Text>
        <Text testID="tp-sl-holding" style={styles.helper}>
          보유 {holding !== null ? `${formatDisplayDecimal(holding)} ${unit}` : '-'}
          {available !== null ? ` · 매도 가능 ${formatDisplayDecimal(available)} ${unit}` : ''}
        </Text>
        <Text testID="tp-sl-sellable-amount" style={styles.sellable}>
          {sellable !== null ? `매도 가능 금액 $${formatDisplayDecimal(sellable)}` : '매도 가능 금액 확인 불가'}
        </Text>
        {sellable !== null ? <Text style={styles.helper}>현재가 기준 평가금액이며 실제 수령액과 다를 수 있어요.</Text> : null}
      </View>
      {live.length || settings.length ? (
        <View style={styles.list} testID="tp-sl-live">
          <Text style={styles.section}>등록된 설정{tpSlCountSummary(live) ? ` · ${tpSlCountSummary(live)}` : ''}</Text>
          {settings.map((row) => {
            const path = getConditionalSellCancelPath(row);
            return (
              <TpSlRow key={row.id} testID={`tp-sl-setting-${row.id}`}
                title={`${TP_SL_KIND_LABEL[row.kind === 'stop_loss' ? 'stop_loss' : 'take_profit']} · ${formatDisplayDecimal(row.triggerPrice)} ${row.currencyCode} ${row.kind === 'stop_loss' ? '이하' : '이상'}`}
                detail={`수량 ${formatTpSlQuantity(row.quantity, 6)} ${unit} · 시장가 매도`}
                state={getConditionalSellStateLabel(row.state)}
                cancelLabel={path ? path.kind === 'order' ? '지정가 매도 취소' : '취소' : null}
                canceling={cancel.isPending && cancel.variables?.id === row.id}
                onCancel={() => cancel.mutate(row)} />
            );
          })}
          {cancel.isError ? <ErrorNotice error={cancel.error} message={getErrorMessageFromCode(getApiErrorCode(cancel.error))} testID="tp-sl-cancel-error" /> : null}
        </View>
      ) : null}
      <QuestTarget id="protection-editor"><View>
        <TpSlLegFields
          legs={legs}
          onPatch={patch}
          disabled={pending || !!blockedReason}
          ratioDisabled={holding === null}
          currency={currency}
          shareLabel="보유 수량"
          quantityText={(kind, leg) => {
            const quantity = quantityForPercent(holding, leg.percent, 6);
            return `매도 수량 ${quantity ? `${formatTpSlQuantity(quantity, 6)} ${unit}` : '-'}`;
          }}
          error={legError}
          warning={(kind) => isTpSlAlreadyMet('long', kind, legs[kind].triggerPrice, currentPrice)
            ? '현재가가 이미 이 가격에 도달해 등록되지 않을 수 있어요.' : null}
          placeholder={(kind) => kind === 'take_profit' ? '현재가보다 높은 가격' : '현재가보다 낮은 가격'}
          onInputFocus={onInputFocus}
          onInputBlur={onInputBlur}
        />
      </View></QuestTarget>
      {blockedReason ? <Text testID="tp-sl-blocked" style={styles.error}>{blockedReason}</Text> : null}
      {error ? (
        <ErrorNotice error={error.cause} message={error.uncertain ? UNCERTAIN_CREATE : getErrorMessageFromCode(getApiErrorCode(error.cause))}
          testID="tp-sl-error" style={styles.error} />
      ) : null}
      {registered ? (
        <Text testID="tp-sl-registered" accessibilityLiveRegion="polite" style={styles.success}>
          {registered.length === 2 ? '익절가와 손절가를 등록했어요.' : `${TP_SL_KIND_LABEL[registered[0]?.kind === 'stop_loss' ? 'stop_loss' : 'take_profit']}가를 등록했어요.`}
        </Text>
      ) : null}
      <View ref={submitRef} collapsable={false}>
        <QuestTarget id="protection-submit"><CTAButton
          testID="tp-sl-submit"
          label={actionRef.current && error ? '같은 내용으로 다시 등록' : '등록하기'}
          state={pending ? 'loading' : canSubmit || (actionRef.current && error && !blockedReason) ? 'enabled' : 'disabled'}
          learningHint={learning.locked ? learning.message : null}
          onPress={submit}
        /></QuestTarget>
      </View>
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  body: { gap: 12, minWidth: 0 },
  header: { gap: 2, minWidth: 0 },
  name: { fontSize: 16, lineHeight: 23, fontWeight: '700', color: semantic.text, flexShrink: 1 },
  helper: { fontSize: 12, lineHeight: 17, color: semantic.secondary, flexShrink: 1 },
  sellable: { fontSize: 14, lineHeight: 20, fontWeight: '600', color: semantic.text, fontVariant: ['tabular-nums'] as 'tabular-nums'[] },
  section: { fontSize: 13, lineHeight: 19, fontWeight: '700', color: semantic.text },
  list: { gap: 8, minWidth: 0 },
  error: { fontSize: 12, lineHeight: 17, color: semantic.error },
  success: { fontSize: 13, lineHeight: 19, fontWeight: '600', color: semantic.success },
} as const;
