import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ScrollView, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import InlineBottomSheet from '../../components/common/InlineBottomSheet';
import { SheetPortal } from '../../components/common/ScreenSheetHost';
import CTAButton from '../../components/common/CTAButton';
import ErrorNotice from '../../components/states/ErrorNotice';
import FuturesPositionSheetSummary from '../../components/tradingAccount/FuturesPositionSheetSummary';
import { QUERY_KEYS } from '../../constants/queryKeys';
import {
  getFuturesLeveragePreview,
  type FuturesLeveragePreview,
  type FuturesPosition,
} from '../../features/futures/api';
import { futuresErrorMessage } from '../../features/futures/orderFeedback';
import { formatAssetPrice, formatDisplayDecimal, formatMoneyDecimal } from '../../utils/format';

/**
 * What the user is asked to confirm: the open position of the selected
 * direction changing from its leverage to `toLeverage`, alone (`only`) or
 * together with the order being placed (`add`). `quantity`/`price` are the
 * add's contracts and the price its estimate uses (null price: the current
 * Futures Last, as a market add fills).
 */
export type FuturesLeverageChangeRequest = {
  kind: 'add' | 'only';
  method: 'market' | 'limit' | 'conditional';
  position: FuturesPosition;
  toLeverage: number;
  quantity: string | null;
  price: string | null;
};

type Props = {
  accountId: string;
  /** Open while set. */
  request: FuturesLeverageChangeRequest | null;
  /** The bound, focused screen: the estimate is read only then. */
  active: boolean;
  busy: boolean;
  /** The last refusal or lost answer of the confirmed command. */
  error: { cause: unknown; message: string } | null;
  onConfirm: () => void;
  onClose: () => void;
};

const METHOD_NOTE = {
  market: '체결 가격에 따라 실제 증거금과 청산가는 조금 달라질 수 있어요.',
  limit: '레버리지는 지금 바뀌지 않고, 지정가가 체결될 때 함께 바뀌어요. 그때 포지션 레버리지가 지금과 다르면 이 주문은 자동으로 취소돼요.',
  conditional: '레버리지는 지금 바뀌지 않고, 조건이 충족돼 주문이 실행될 때 함께 바뀌어요. 그때 포지션 레버리지가 지금과 다르면 실행되지 않아요.',
} as const;

const REFUSAL = {
  INSUFFICIENT_FUTURES_FREE_COLLATERAL: '담보가 부족해 이 레버리지로 바꿀 수 없어요. 레버리지나 주문 금액을 조정해 주세요.',
  FUTURES_MAINTENANCE_UNSAFE: '바꾸면 유지 증거금을 충족하지 못해 바로 청산될 위험이 있어요. 더 낮은 레버리지를 선택해 주세요.',
  FUTURES_MARK_UNAVAILABLE: '평가 기준가를 확인할 수 없어 예상 값을 표시하지 않아요. 잠시 후 다시 시도해 주세요.',
  FUTURES_PRICE_UNAVAILABLE: '현재 선물 Last를 확인할 수 없어 예상 값을 계산할 수 없어요.',
} as Record<string, string>;

/**
 * 레버리지 변경 확인 over the futures screen. Choosing another leverage in the
 * form never changes a position; this sheet is the explicit confirmation. It
 * shows the server's own estimate (the same plan and checks as the command):
 * current → new leverage, the margin the position needs, the collateral the
 * change adds or releases, the free collateral and the liquidation price
 * (Isolated) or the Cross buffer. A value the server cannot verify (no fresh
 * 평가 기준가 or price) is never estimated here, and the change is not offered.
 */
export default function FuturesLeverageChangeSheet({ request, onClose, busy, ...body }: Props) {
  return (
    <SheetPortal>
      <InlineBottomSheet testID="futures-leverage-change-sheet" title="레버리지 변경" visible={!!request}
        dismissible={!busy} onClose={onClose}>
        <ScrollView testID="futures-leverage-change-scroll" style={styles.scroll} contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled">
          {request ? <ChangeBody key={`${request.position.id}:${request.toLeverage}:${request.kind}`} request={request}
            busy={busy} onClose={onClose} {...body} /> : null}
        </ScrollView>
      </InlineBottomSheet>
    </SheetPortal>
  );
}

function ChangeBody({ accountId, request, active, busy, error, onConfirm, onClose }: Omit<Props, 'request'> & {
  request: FuturesLeverageChangeRequest;
}) {
  const { position, toLeverage } = request;
  const quantity = request.kind === 'add' ? request.quantity : null;
  const price = request.kind === 'add' ? request.price : null;
  const preview = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.leveragePreview(accountId, position.id, toLeverage, quantity, price),
    queryFn: ({ signal }) => getFuturesLeveragePreview(accountId, position.id, { leverage: toLeverage, quantity, price }, signal),
    enabled: active,
    // The estimate follows Mark: the screen's 2 s cadence.
    refetchInterval: active ? 2000 : false,
    retry: false,
  });
  // The key carries the leverage, quantity and price: an answer is this request's.
  const data: FuturesLeveragePreview | null = !preview.isError && preview.data?.positionId === position.id
    ? preview.data : null;
  const isolated = position.marginMode === 'isolated';
  const decimals = position.instrument.underlying.displayPriceDecimals;
  const base = position.instrument.underlying.symbol.replace(/USDT$/u, '');
  const usd = (value: string | null | undefined) => value == null ? '-' : formatMoneyDecimal(value, 'USD');
  const priceText = (value: string | null | undefined) => value == null ? '-' : formatAssetPrice(value, 'USD', decimals);
  const after = data?.after ?? null;
  const collateral = data?.collateral ?? null;
  const delta = collateral ? (isolated ? collateral.isolatedMarginDelta : collateral.initialRequirementDelta) : null;
  const deltaValue = delta === null ? null : Number(delta);
  const refusal = data?.refusal ?? null;
  const unknown = !data ? (preview.isError ? '예상 값을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.' : '예상 값을 확인하는 중이에요.')
    : !after || !collateral ? REFUSAL[refusal ?? 'FUTURES_MARK_UNAVAILABLE'] ?? REFUSAL.FUTURES_MARK_UNAVAILABLE : null;
  const refused = refusal && after ? REFUSAL[refusal] ?? futuresErrorMessage(refusal, false) : null;
  const ready = !!data && !!after && !!collateral && !refusal;
  return (
    <View style={styles.body} testID="futures-leverage-change">
      <FuturesPositionSheetSummary position={position} markFresh={data?.markState === 'fresh'} testID="futures-leverage-change-summary" />
      <View style={styles.rows}>
        <Row label="레버리지" testID="futures-leverage-change-leverage" strong
          value={`${position.leverage}x → ${toLeverage}x`} />
        {request.kind === 'add' && quantity ? (
          <Row label="추가 수량" testID="futures-leverage-change-quantity" value={`${formatDisplayDecimal(quantity)} ${base}`} />
        ) : null}
        <Row label={isolated ? '필요 증거금 (격리)' : '필요 증거금 (교차 · 평가 기준가)'} testID="futures-leverage-change-margin"
          value={data && after ? `${usd(isolated ? data.before.isolatedMargin : data.before.initialRequirement)} → ${usd(isolated ? after.isolatedMargin : after.initialRequirement)}` : '-'} />
        <Row testID="futures-leverage-change-delta"
          label={deltaValue === null || deltaValue === 0 ? '담보 변화' : deltaValue > 0 ? '추가로 필요한 담보' : '해제되는 담보'}
          value={deltaValue === null ? '-' : deltaValue === 0 ? '없음' : usd(String(Math.abs(deltaValue)))} />
        {request.kind === 'add' && collateral ? (
          <Row label="예상 수수료" testID="futures-leverage-change-fee" value={usd(collateral.estimatedFee)} />
        ) : null}
        <Row label="주문가능 담보" testID="futures-leverage-change-free"
          value={collateral ? `${usd(collateral.freeCollateralBefore)} → ${usd(collateral.freeCollateralAfter)}` : '-'} />
        {isolated ? (
          <Row label="예상 청산가" testID="futures-leverage-change-liquidation"
            value={data && after ? `${liquidation(data.before.liquidationPrice, priceText)} → ${liquidation(after.liquidationPrice, priceText)}` : '-'} />
        ) : (
          <Row label="교차 청산 여유" testID="futures-leverage-change-buffer"
            value={collateral ? `${usd(collateral.crossLiquidationBufferBefore)} → ${usd(collateral.crossLiquidationBufferAfter)}` : '-'} />
        )}
      </View>
      {isolated ? null : (
        <Text style={styles.helper}>교차 포지션은 개별 청산가 없이 선물 지갑의 공동 담보로 평가돼요. 레버리지는 필요 증거금에만 영향을 줘요.</Text>
      )}
      <Text testID="futures-leverage-change-apply" style={styles.notice}>
        {request.kind === 'add'
          ? '레버리지 변경과 추가 진입이 함께 적용돼요.'
          : '보유 수량·평균 진입가·체결 내역과 손절가/익절가 설정은 그대로이고, 레버리지와 증거금만 바뀌어요.'}
      </Text>
      {request.kind === 'add' ? <Text style={styles.helper}>{METHOD_NOTE[request.method]}</Text> : null}
      {unknown ? <Text testID="futures-leverage-change-unknown" style={styles.warning}>{unknown}</Text> : null}
      {refused ? <Text testID="futures-leverage-change-refused" accessibilityLiveRegion="polite" style={styles.error}>{refused}</Text> : null}
      {error ? <ErrorNotice testID="futures-leverage-change-error" error={error.cause} message={error.message} style={styles.error} /> : null}
      <View style={styles.actions}>
        <CTAButton testID="futures-leverage-change-cancel" variant="secondary" label="취소" style={styles.action}
          state={busy ? 'disabled' : 'enabled'} onPress={onClose} />
        <CTAButton testID="futures-leverage-change-confirm" style={styles.action}
          label={request.kind === 'add' ? '변경하고 주문' : '레버리지 변경'}
          state={busy ? 'loading' : ready ? 'enabled' : 'disabled'} onPress={() => { if (ready && !busy) onConfirm(); }} />
      </View>
    </View>
  );
}

function liquidation(value: string | null, price: (value: string | null) => string) {
  return value === null ? '없음' : price(value);
}

function Row({ label, value, testID, strong }: { label: string; value: string; testID: string; strong?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text testID={testID} selectable style={[styles.value, strong && styles.strong]}>{value}</Text>
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks. Rows wrap
// (value under its label) at narrow widths and large fonts; a long value
// breaks inside it (minWidth 0) instead of running past the sheet.
const styles = {
  scroll: { flexGrow: 0 },
  content: { gap: 12, paddingTop: 4, paddingBottom: 8 },
  body: { gap: 14, minWidth: 0 },
  rows: { gap: 8, minWidth: 0 },
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', columnGap: 12, rowGap: 2, minWidth: 0 },
  label: { flexShrink: 1, fontSize: 13, lineHeight: 20, color: semantic.secondary },
  value: { flexShrink: 1, minWidth: 0, marginLeft: 'auto', fontSize: 14, lineHeight: 21, fontWeight: '600', color: semantic.text, textAlign: 'right', fontVariant: ['tabular-nums'] as 'tabular-nums'[] },
  strong: { fontSize: 16, lineHeight: 23, fontWeight: '800' },
  notice: { fontSize: 14, lineHeight: 21, fontWeight: '700', color: semantic.text },
  helper: { fontSize: 12, lineHeight: 18, color: semantic.secondary },
  warning: { fontSize: 13, lineHeight: 20, color: semantic.warning },
  error: { fontSize: 13, lineHeight: 20, color: semantic.error },
  actions: { flexDirection: 'row', gap: 8 },
  action: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
} as const;
