import { futuresErrorMessage } from '../../features/futures/orderFeedback';
import { useLearningAccess } from '../../features/quest/useLearningAccess';
import { QUERY_KEYS } from '../../constants/queryKeys';
import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Text, View, StyleSheet } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { BUY_COLOR, SELL_COLOR } from '../../features/order/sideColors';
import CTAButton from '../../components/common/CTAButton';
import ErrorNotice from '../../components/states/ErrorNotice';
import TpSlButton from '../../features/conditional/tpsl/TpSlButton';
import { TpSlDraftSheet } from '../../features/conditional/tpsl/TpSlSheet';
import { getDraftTpSlError } from '../../features/conditional/tpsl/DraftTpSl';
import { getAccountEntryTpSlPlans, type EntryTpSlDraftDto } from '../../features/conditional/entryTpSlApi';
import { tpSlCountSummary } from '../../features/conditional/tpSlModel';
import { createFuturesLimitOrder, type FuturesLimitCommand, type Direction, type MarginMode } from '../../features/futures/api';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { getSessionGeneration, isCurrentSession } from '../../services/api/sessionOwnership';
import { getApiErrorInfo, getErrorMessageFromCode } from '../../services/api/errorMapper';
import { createIdempotencyKey } from '../../utils/idempotency';
import { invalidateAfterOrderCreate } from '../../features/tradingAccount/invalidation';

/**
 * 지정가 진입 (Futures Limit Entry v1): the screen owns direction, margin mode,
 * leverage, quantity and the limit price fields; this form adds the optional
 * 손절가/익절가 plans (sent with the entry, activated on its fill, for their
 * share of the filled quantity) and owns the idempotent submit. `onBusy` holds
 * the screen's inputs while a request or an uncertain result keeps this exact
 * intent.
 */
export default function FuturesLimitEntryForm({ accountId, instrumentId, unit, direction, marginMode, leverage, quantity, amount, limitPrice, allowed, collateralError, onBusy }: {
  accountId: string; instrumentId: string; unit: string; direction: Direction; marginMode: MarginMode;
  leverage: string; quantity: string; amount: string; limitPrice: string; allowed: boolean; collateralError: string | null; onBusy: (busy: boolean) => void;
}) {
  const learning = useLearningAccess(accountId).gate('allTrading');
  const [collateralAttempted, setCollateralAttempted] = useState(false);
  const [drafts, setDrafts] = useState<EntryTpSlDraftDto[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState<string | null>(null), [failure, setFailure] = useState<unknown>(null);
  const { selectedAccountId } = useTradingAccount();
  const client = useQueryClient();
  const alive = useRef(true), locked = useRef(false);
  const session = getSessionGeneration();
  const selected = useRef(selectedAccountId); selected.current = selectedAccountId;
  const request = useRef<FuturesLimitCommand | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const caps = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.entryTpSl.list(accountId, 'open'),
    queryFn: ({ signal }) => getAccountEntryTpSlPlans(accountId, 'open', signal),
    enabled: selectedAccountId === accountId,
    staleTime: 30_000,
    retry: false,
  });
  const planCapability = !caps.isError && caps.data?.tradingAccountId === accountId ? caps.data.capabilities.futures : null;
  const canAttach = !!planCapability?.canCreate;
  const validPrice = /^\d{1,16}(\.\d{1,8})?$/.test(limitPrice) && Number(limitPrice) > 0;
  const permission = useRef({ allowed, canAttach, collateralError });
  permission.current = { allowed, canAttach, collateralError };
  const current = () => alive.current && selected.current === accountId && isCurrentSession(session);
  useEffect(() => {
    if (!locked.current && !request.current) {
      setFailure(null); setMessage(null); setCollateralAttempted(false);
    }
  }, [amount, quantity, leverage, limitPrice, direction, marginMode, drafts]);
  const shownMessage = collateralAttempted ? collateralError : message;
  const submit = async () => {
    if (locked.current || !current() || (!uncertain && (!permission.current.allowed || !validPrice))) return;
    if (!uncertain) {
      if (permission.current.collateralError) {
        setFailure(null); setMessage(null); setCollateralAttempted(true); return;
      }
      setCollateralAttempted(false);
      const error = drafts.length ? getDraftTpSlError(drafts, direction, limitPrice) : null;
      if (error) { setFailure(null); setMessage(`손절가/익절가 설정을 확인해 주세요. ${error}`); return; }
      if (drafts.length && !permission.current.canAttach) { setMessage('현재 손절가/익절가를 함께 등록할 수 없어요. 설정을 지우고 주문해 주세요.'); return; }
      request.current = { instrumentId, direction, marginMode, leverage: Number(leverage), quantity, limitPrice, idempotencyKey: createIdempotencyKey('futures-entry'), ...(drafts.length ? { entryTpSl: drafts } : {}) };
    }
    if (!request.current) return;
    locked.current = true; setBusy(true); onBusy(true); setFailure(null);
    try {
      await createFuturesLimitOrder(accountId, request.current);
      if (!current()) return;
      const withPlans = !!request.current.entryTpSl?.length;
      request.current = null; setUncertain(false); setDrafts([]);
      setMessage(withPlans ? '지정가 진입 주문이 접수되었습니다. 체결 전까지 담보가 예약되고, 손절가/익절가는 체결 후 활성화됩니다.' : '지정가 진입 주문이 접수되었습니다. 체결 전까지 담보가 예약됩니다.');
      await Promise.all([client.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.futures.all(accountId) }), client.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.entryTpSl.all(accountId) }), invalidateAfterOrderCreate(client, accountId, { seasonUi: true })]);
    } catch (error) {
      if (!current()) return;
      const info = getApiErrorInfo(error); const retry = !info.hasResponse || (info.status ?? 0) >= 500;
      setUncertain(retry); if (!retry) request.current = null;
      setFailure(error); setMessage(retry ? '접수 여부를 확인해야 합니다. 동일 요청으로 다시 확인해주세요.'
        : info.serverCode?.startsWith('ENTRY_TP_SL') || info.serverCode === 'INVALID_ENTRY_TP_SL' || info.serverCode === 'FUTURES_TP_SL_DISABLED'
          ? getErrorMessageFromCode(info.serverCode) : futuresErrorMessage(info.serverCode, false));
    } finally { locked.current = false; if (current()) { setBusy(false); onBusy(!!request.current); } }
  };
  const validLimit = /^\d{1,16}(\.\d{1,8})?$/.test(limitPrice.trim()) && Number(limitPrice) > 0;
  return <View style={styles.stack} testID="futures-limit-entry">
    <Text style={styles.hint}>접수 시 초기 증거금과 예상 수수료를 예약해요.</Text>
    {planCapability?.enabled || drafts.length ? (
      <View style={styles.attached} testID="futures-limit-tp-sl">
        <TpSlButton testID="futures-limit-tp-sl-button" summary={tpSlCountSummary(drafts)} disabled={busy || uncertain}
          onPress={() => setSheetOpen(true)} />
        {!canAttach ? <Text style={styles.hint}>현재 손절가/익절가를 새로 등록할 수 없어요.</Text> : null}
        <TpSlDraftSheet
          visible={sheetOpen && !busy}
          onClose={() => setSheetOpen(false)}
          scopeKey={`${accountId}:${instrumentId}:${direction}`}
          drafts={drafts}
          onChange={setDrafts}
          direction={direction}
          entryPrice={validLimit ? limitPrice.trim() : null}
          expectedQuantity={/^\d+(\.\d+)?$/.test(quantity) && Number(quantity) > 0 ? quantity : null}
          scale={8}
          unit={unit}
          currency="USD"
          blockedReason={canAttach ? null : '현재 손절가/익절가를 새로 등록할 수 없어요.'}
        />
      </View>
    ) : null}
    <CTAButton testID="futures-limit-submit" label={uncertain ? '동일 진입 요청 확인' : `${direction === 'long' ? '롱(Long)' : '숏(Short)'} 지정가 진입`}
      style={{ backgroundColor: direction === 'long' ? BUY_COLOR : SELL_COLOR }}
      learningHint={learning.locked ? learning.message : null} onPress={() => learning.guard(() => void submit())} state={busy ? 'loading' : uncertain || (allowed && validPrice) ? 'enabled' : 'disabled'} />
    {shownMessage ? failure ? <ErrorNotice testID="futures-limit-notice" error={failure} message={shownMessage} style={styles.text} /> : <Text testID="futures-limit-notice" style={styles.text} accessibilityLiveRegion="polite">{shownMessage}</Text> : null}
  </View>;
}
const styles = StyleSheet.create({ stack: { gap: 12, minWidth: 0 }, attached: { gap: 8, minWidth: 0 }, label: { color: semantic.muted, fontSize: 12 }, text: { color: semantic.text, fontSize: 14, flexShrink: 1 }, hint: { color: semantic.secondary, fontSize: 12, flexShrink: 1 } });
