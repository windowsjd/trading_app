import { QUERY_KEYS } from '../../constants/queryKeys';
import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Text, TextInput, View, StyleSheet } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { formatDisplayDecimal } from '../../utils/format';
import CTAButton from '../../components/common/CTAButton';
import ErrorNotice from '../../components/states/ErrorNotice';
import { ProtectionEditor, emptyProtection, draftLegs, protectionInputError } from '../../features/conditional/ProtectionEditor';
import { getProtections } from '../../features/conditional/api';
import { createFuturesLimitOrder, type FuturesLimitCommand, type Direction, type MarginMode } from '../../features/futures/api';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { getSessionGeneration, isCurrentSession } from '../../services/api/sessionOwnership';
import { getApiErrorInfo } from '../../services/api/errorMapper';
import { createIdempotencyKey } from '../../utils/idempotency';
import { invalidateAfterOrderCreate } from '../../features/tradingAccount/invalidation';

export default function FuturesLimitEntryForm({ accountId, instrumentId, assetId, direction, marginMode, leverage, quantity, allowed, onBusy, onInputFocus, onInputBlur }: {
  accountId: string; instrumentId: string; assetId: string; direction: Direction; marginMode: MarginMode;
  leverage: string; quantity: string; allowed: boolean; onBusy: (busy: boolean) => void;
  onInputFocus?: (input: View | null) => void; onInputBlur?: () => void;
}) {
  const [limitPrice, setLimitPrice] = useState('');
  const [draft, setDraft] = useState(emptyProtection);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState<string | null>(null), [failure, setFailure] = useState<unknown>(null);
  const { selectedAccountId } = useTradingAccount();
  const client = useQueryClient();
  const alive = useRef(true), locked = useRef(false), input = useRef<TextInput>(null);
  const session = getSessionGeneration();
  const selected = useRef(selectedAccountId); selected.current = selectedAccountId;
  const request = useRef<FuturesLimitCommand | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const caps = useQuery({ queryKey: QUERY_KEYS.tradingAccount.protections.list(accountId, 'futures', assetId), queryFn: () => getProtections(accountId, 'futures', assetId), enabled: selectedAccountId === accountId, refetchInterval: 4000 });
  const canAttach = !caps.isError && caps.data?.tradingAccountId === accountId && !!caps.data.capabilities.canCreateFutures;
  const validPrice = /^\d{1,16}(\.\d{1,8})?$/.test(limitPrice) && Number(limitPrice) > 0;
  const permission = useRef({ allowed, canAttach });
  permission.current = { allowed, canAttach };
  const current = () => alive.current && selected.current === accountId && isCurrentSession(session);
  const submit = async () => {
    if (locked.current || !current() || (!uncertain && (!permission.current.allowed || !validPrice))) return;
    if (!uncertain) {
      const error = protectionInputError(draft, { direction, limitPrice });
      if (error) { setFailure(null); setMessage(error); return; }
      const legs = draftLegs(draft);
      if (legs.length && !permission.current.canAttach) { setMessage('현재 익절·손절을 등록할 수 없습니다.'); return; }
      request.current = { instrumentId, direction, marginMode, leverage: Number(leverage), quantity, limitPrice, idempotencyKey: createIdempotencyKey('futures-entry'), ...(legs.length ? { attachedProtection: legs } : {}) };
    }
    if (!request.current) return;
    locked.current = true; setBusy(true); onBusy(true); setFailure(null);
    try {
      await createFuturesLimitOrder(accountId, request.current);
      if (!current()) return;
      request.current = null; setUncertain(false); setMessage('지정가 진입 주문이 접수되었습니다. 체결 전까지 담보가 예약됩니다.');
      await Promise.all([client.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.futures.all(accountId) }), client.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.protections.all(accountId) }), invalidateAfterOrderCreate(client, accountId, { seasonUi: true })]);
    } catch (error) {
      if (!current()) return;
      const info = getApiErrorInfo(error); const retry = !info.hasResponse || (info.status ?? 0) >= 500;
      setUncertain(retry); if (!retry) request.current = null;
      setFailure(error); setMessage(retry ? '접수 여부를 확인해야 합니다. 동일 요청으로 다시 확인해주세요.' : info.serverCode === 'PROTECTION_ALREADY_TRIGGERED' ? `${direction.toUpperCase()} 조건 가격을 확인해주세요. ${direction === 'long' ? 'SL < 진입 지정가 < TP' : 'TP < 진입 지정가 < SL'} 관계가 필요합니다.` : '지정가 주문을 접수하지 못했습니다. 입력값과 사용 가능 담보를 확인해주세요.');
    } finally { locked.current = false; if (current()) { setBusy(false); onBusy(!!request.current); } }
  };
  return <View style={styles.stack} testID="futures-limit-entry">
    <Text style={styles.text}>진입 지정가 · USD</Text>
    <TextInput ref={input} accessibilityLabel="선물 진입 지정가" testID="futures-limit-price" value={limitPrice} onChangeText={setLimitPrice} editable={!busy && !uncertain} keyboardType="decimal-pad" style={styles.input} onFocus={() => onInputFocus?.(input.current)} onBlur={onInputBlur} />
    {limitPrice.length > 12 ? <Text style={styles.hint}>입력 지정가 {formatDisplayDecimal(limitPrice)}</Text> : null}
    <Text style={styles.hint}>새 포지션 진입만 지원합니다. 초기 증거금과 예상 수수료를 예약하며, 체결 시 담보와 Mark를 다시 확인합니다.</Text>
    <Text style={styles.text}>체결 후 TP/SL (선택)</Text>
    {!canAttach ? <Text style={styles.hint}>현재 운영 상태에서는 새 보호 조건을 등록할 수 없습니다.</Text> : null}
    <ProtectionEditor value={draft} onChange={setDraft} disabled={busy || uncertain || !canAttach} canLimit onInputFocus={onInputFocus} onInputBlur={onInputBlur} />
    <CTAButton testID="futures-limit-submit" label={uncertain ? '동일 진입 요청 확인' : `지정가 ${direction === 'long' ? 'Long' : 'Short'} 진입`} onPress={() => void submit()} state={busy ? 'loading' : uncertain || (allowed && validPrice) ? 'enabled' : 'disabled'} />
    {message ? failure ? <ErrorNotice error={failure} message={message} /> : <Text style={styles.text} accessibilityLiveRegion="polite">{message}</Text> : null}
  </View>;
}
const styles = StyleSheet.create({ stack: { gap: 12, minWidth: 0 }, text: { color: semantic.text, fontSize: 15, flexShrink: 1 }, hint: { color: semantic.secondary, fontSize: 13, flexShrink: 1 }, input: { borderWidth: 1, borderColor: semantic.border, borderRadius: 8, color: semantic.text, padding: 12, minWidth: 0, width: '100%' } });
