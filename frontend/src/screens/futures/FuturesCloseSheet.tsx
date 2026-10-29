import React, { useRef, useState } from 'react';
import { ScrollView, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { financial } from '../../theme/financialColors';
import InlineBottomSheet from '../../components/common/InlineBottomSheet';
import { SheetPortal } from '../../components/common/ScreenSheetHost';
import CTAButton from '../../components/common/CTAButton';
import ErrorNotice from '../../components/states/ErrorNotice';
import FuturesPositionSheetSummary from '../../components/tradingAccount/FuturesPositionSheetSummary';
import { useFocusedInputScroll } from '../../hooks/useFocusedInputScroll';
import type { FuturesCapabilities, FuturesPosition } from '../../features/futures/api';
import { futuresActionAllowed, futuresInputError } from '../../features/futures/policy';
import {
  futuresAmountAtRatio,
  futuresAmountRatio,
  futuresNotional,
  futuresPositionShare,
  futuresPrice,
  futuresQuantityForAmount,
  futuresWholePosition,
} from '../../features/futures/orderSizing';
import { formatAssetPrice, formatDisplayDecimal, formatMoneyDecimal, formatUsd, getFinancialDirection } from '../../utils/format';
import FuturesAmountField from './FuturesAmountField';

/** What the sheet asks the screen to execute: the existing reduce or close command. */
export type FuturesCloseRequest = { operation: 'reduce' | 'close'; quantity: string };

type Props = {
  /** The live row of the position the sheet is open for; null once it is gone (closed elsewhere). */
  position: FuturesPosition | null;
  open: boolean;
  /** Mark as the card shows it: the Mark Price and the Mark estimates only while fresh. */
  markFresh: boolean;
  /** The position's Futures Last is usable: a market close executes on it. */
  referenceFresh: boolean;
  capabilities: FuturesCapabilities;
  /** A futures command from this screen is in flight. */
  busy: boolean;
  /** Another entry (지정가 / 조건주문) is being submitted from the form. */
  held: boolean;
  /** The previous command's result is unknown: it is confirmed (same request) before anything else. */
  uncertain: boolean;
  /** This sheet's last refusal or lost answer. */
  error: { cause: unknown; message: string } | null;
  onSubmit: (request: FuturesCloseRequest) => void;
  onRetry: () => void;
  onClose: () => void;
};

const UNPRICED = '현재 선물 Last를 확인할 수 없어 계약 수량을 계산할 수 없습니다.';

/**
 * 포지션 종료 over the futures screen, laid out like an exchange's close
 * sheet: the position (contract, side, 진입가, Mark Price), the price (시장가,
 * on Futures Last), the USD amount with its 0–100% slider (100% by default),
 * 포지션 규모 with the estimated 손익 and 수수료, and the confirm. 100% — or an
 * amount that is the whole position — is the existing close of the whole
 * quantity; less is the existing reduce, sized on Futures Last as in the
 * trade form. The screen executes it on its own futures command path.
 */
export default function FuturesCloseSheet({ position, open, ...body }: Props) {
  // The last position stays rendered through the closing motion; one gone
  // while open (closed elsewhere, liquidated) only says so.
  const last = useRef<FuturesPosition | null>(null);
  if (position) last.current = position;
  const shown = position ?? (open ? null : last.current);
  // Every opening starts a fresh draft, also one during the closing motion.
  const openings = useRef({ count: 0, open: false });
  if (open && !openings.current.open) openings.current.count += 1;
  openings.current.open = open;
  return (
    <SheetPortal>
      <InlineBottomSheet testID="futures-close-sheet" title="포지션 종료" visible={open} dismissible={!body.busy} onClose={body.onClose}>
        <CloseScroll>
          {(scroll) => shown ? (
            // Each position (and each opening) starts at 100% with no typed amount.
            <CloseBody key={`${shown.id}:${openings.current.count}`} position={shown} {...body} {...scroll} />
          ) : (
            <Text testID="futures-close-gone" style={styles.error}>이 포지션은 이미 종료됐어요.</Text>
          )}
        </CloseScroll>
      </InlineBottomSheet>
    </SheetPortal>
  );
}

type ScrollProps = { onInputFocus: (input: View | null) => void; onInputBlur: () => void; submitRef: React.RefObject<View | null> };

/** Mounted with the open sheet only: it scrolls within the sheet and keeps the amount and confirm above the keyboard. */
function CloseScroll({ children }: { children: (scroll: ScrollProps) => React.ReactNode }) {
  const scroll = useFocusedInputScroll();
  return (
    <View style={styles.viewport}>
      <ScrollView testID="futures-close-scroll" ref={scroll.scrollRef} onLayout={scroll.revealFocusedInput}
        onContentSizeChange={scroll.revealFocusedInput} onScroll={scroll.onScroll} scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="none" style={styles.scroll} contentContainerStyle={styles.content}>
        {children({ onInputFocus: scroll.onInputFocus, onInputBlur: scroll.onInputBlur, submitRef: scroll.submitRef })}
      </ScrollView>
    </View>
  );
}

function CloseBody({ position, markFresh, referenceFresh, capabilities, busy, held, uncertain, error, onSubmit, onRetry,
  onInputFocus, onInputBlur, submitRef }: Omit<Props, 'position' | 'open' | 'onClose'> & ScrollProps & {
  position: FuturesPosition;
}) {
  // 100% (the whole position) until a share or an amount is chosen.
  const [whole, setWhole] = useState(true);
  const [amount, setAmount] = useState('');
  const [chosenRatio, setChosenRatio] = useState<number | null>(null);
  const [ratioMessage, setRatioMessage] = useState<string | null>(null);
  const base = position.instrument.underlying.symbol.replace(/USDT$/u, '');
  const lastPrice = referenceFresh ? futuresPrice(position.referencePrice) : null;
  // 100% is the position at the current Futures Last, as in the trade form's reduce.
  const positionNotional = lastPrice ? futuresNotional(position.quantity, lastPrice) : null;
  const sizing = whole ? null : futuresQuantityForAmount(amount, lastPrice, UNPRICED);
  const quantity = whole ? position.quantity : sizing?.state === 'ready' ? sizing.quantity : '';
  const operation: FuturesCloseRequest['operation'] = whole || (!!quantity && futuresWholePosition(quantity, position.quantity))
    ? 'close' : 'reduce';
  const amountError = sizing && (sizing.state === 'invalid' || sizing.state === 'unpriced' || sizing.state === 'tooSmall')
    ? sizing.message : null;
  const inputError = amountError ?? (quantity ? futuresInputError(quantity, String(position.leverage), operation, position) : null);
  const ratioReason = positionNotional ? null : '현재 선물 Last를 확인할 수 없어 비율을 계산할 수 없습니다.';
  const amountAtRatio = (ratio: number) => (positionNotional ? futuresAmountAtRatio(positionNotional, ratio) : null);
  // A chosen share survives cent rounding only while it still writes this amount.
  const activeRatio = whole ? 1 : !ratioReason && chosenRatio !== null
    && (chosenRatio === 0 ? amount === '' : amountAtRatio(chosenRatio) === amount.trim()) ? chosenRatio : null;
  const displayedRatio = activeRatio ?? (ratioReason ? 0 : futuresAmountRatio(amount, positionNotional));
  const locked = busy || held || uncertain;
  const changeAmount = (value: string) => {
    if (locked) return;
    setWhole(false);
    setAmount(value);
    setChosenRatio(null);
    setRatioMessage(null);
  };
  const applyRatio = (value: number) => {
    if (locked || !Number.isFinite(value)) return;
    const ratio = Math.max(0, Math.min(1, value));
    if (ratioReason) { setRatioMessage(ratioReason); return; }
    setRatioMessage(null);
    if (ratio === 1) { setWhole(true); setAmount(''); setChosenRatio(null); return; }
    setWhole(false);
    if (ratio === 0) { setAmount(''); setChosenRatio(0); return; }
    const next = amountAtRatio(ratio);
    if (!next || next === '0') { setRatioMessage('계산된 금액이 너무 작습니다.'); return; }
    setAmount(next);
    setChosenRatio(ratio);
  };
  // Estimates from the server's own whole-position figures (on Mark, as on
  // the card), in the part being closed. The fill itself is on Futures Last.
  const share = (value: string | null | undefined) => markFresh && quantity && !inputError
    ? futuresPositionShare(value, quantity, position.quantity) : null;
  const pnl = share(position.markUnrealizedPnl);
  const fee = share(position.risk?.estimatedCloseFee);
  const pnlDirection = pnl === null ? 'neutral' : getFinancialDirection(pnl);
  const estimate = quantity && !inputError ? [
    `종료 수량 ${formatDisplayDecimal(quantity)} ${base}`,
    ...(operation === 'close' ? ['포지션 전체 · 포지션 종료로 처리돼요.'] : []),
  ] : [];
  const blocked = !capabilities[operation === 'close' ? 'canClose' : 'canReduce'] ? '지금은 선물 포지션을 종료할 수 없어요. 운영 상태를 확인해 주세요.'
    : !referenceFresh ? '현재 선물 Last를 확인할 수 없어 종료할 수 없어요. 잠시 후 다시 시도해 주세요.'
    : null;
  const allowed = !locked && !inputError && !!quantity && futuresActionAllowed(capabilities, operation, markFresh, referenceFresh);
  const submit = () => {
    if (uncertain) { if (!busy) onRetry(); return; }
    if (allowed) onSubmit({ operation, quantity });
  };
  return (
    <View style={styles.body} testID="futures-close-body">
      <FuturesPositionSheetSummary testID="futures-close-position" position={position} markFresh={markFresh} />
      <View style={styles.group}>
        <Text style={styles.label}>가격</Text>
        {/* A position closes at market only: the price is the fill's, on Futures Last. */}
        <View style={styles.priceBox} testID="futures-close-price">
          <Text style={styles.priceValue}>시장가</Text>
          <Text style={styles.priceHint}>
            선물 Last {lastPrice ? formatAssetPrice(lastPrice, 'USD', position.instrument.underlying.displayPriceDecimals) : '확인 불가'}
          </Text>
        </View>
      </View>
      <FuturesAmountField
        testID="futures-close-amount"
        label="종료 금액 (USD)"
        amount={whole ? amountAtRatio(1) ?? '' : amount}
        onChange={changeAmount}
        editable={!locked}
        estimate={estimate}
        ratioLabel="종료 비율"
        ratio={whole ? 1 : displayedRatio}
        activeRatio={activeRatio}
        ratioDisabled={!!ratioReason}
        ratioReason={ratioReason}
        onRatio={applyRatio}
        available={`보유 ${formatDisplayDecimal(position.quantity)} ${base}${positionNotional ? ` · 약 ${formatUsd(positionNotional)} USD` : ''}`}
        onInputFocus={onInputFocus}
        onInputBlur={onInputBlur}
      />
      {amount.trim() && !whole && inputError ? (
        <Text testID="futures-close-amount-error" accessibilityLiveRegion="polite" style={styles.error}>{inputError}</Text>
      ) : null}
      {ratioMessage ? <Text testID="futures-close-ratio-message" accessibilityLiveRegion="polite" style={styles.error}>{ratioMessage}</Text> : null}
      <View style={styles.rows}>
        <View style={styles.row}>
          <Text style={styles.label}>포지션 규모</Text>
          <Text testID="futures-close-notional" selectable style={styles.value}>
            {markFresh ? formatMoneyDecimal(position.markNotional, 'USD') : '-'}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>예상 손익</Text>
          <Text testID="futures-close-pnl" selectable
            style={[styles.value, pnlDirection !== 'neutral' && { color: financial[pnlDirection] }]}>
            {pnl === null ? '-' : formatMoneyDecimal(pnl, 'USD', true)}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>예상 수수료</Text>
          <Text testID="futures-close-fee" selectable style={styles.value}>{fee === null ? '-' : formatMoneyDecimal(fee, 'USD')}</Text>
        </View>
      </View>
      <Text style={styles.helper}>시장가로 바로 체결돼요. 예상 손익과 수수료는 Mark 기준이고, 실제 결과는 체결 시점의 선물 Last로 정해져요.</Text>
      {blocked ? <Text testID="futures-close-blocked" style={styles.error}>{blocked}</Text> : null}
      {uncertain ? (
        <Text testID="futures-close-uncertain" style={styles.warning}>
          이전 요청의 체결 여부를 확인해야 해요. 같은 요청으로 결과를 확인해 주세요.
        </Text>
      ) : null}
      {error ? <ErrorNotice testID="futures-close-error" error={error.cause} message={error.message} style={styles.error} /> : null}
      <View ref={submitRef} collapsable={false}>
        <CTAButton
          testID="futures-close-submit"
          ripple="subtle"
          label={uncertain ? '이전 체결 결과 확인' : operation === 'close' ? '포지션 종료' : '포지션 감소'}
          state={busy ? 'loading' : uncertain || allowed ? 'enabled' : 'disabled'}
          onPress={submit}
        />
      </View>
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks. A value too
// long for one line (minWidth 0) breaks inside it instead of running past the sheet.
const styles = {
  viewport: { flexShrink: 1, minHeight: 0 },
  scroll: { flexGrow: 0 },
  content: { gap: 12, paddingTop: 4, paddingBottom: 8 },
  body: { gap: 14, minWidth: 0 },
  group: { gap: 4, minWidth: 0 },
  label: { flexShrink: 1, fontSize: 13, lineHeight: 20, color: semantic.secondary },
  priceBox: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', columnGap: 12, rowGap: 2,
    minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, backgroundColor: semantic.raised, minWidth: 0 },
  priceValue: { fontSize: 15, lineHeight: 22, fontWeight: '700', color: semantic.text },
  priceHint: { flexShrink: 1, minWidth: 0, fontSize: 12, lineHeight: 18, color: semantic.secondary, textAlign: 'right', fontVariant: ['tabular-nums'] as 'tabular-nums'[] },
  rows: { gap: 6, minWidth: 0 },
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', columnGap: 12, rowGap: 2, minWidth: 0 },
  value: { flexShrink: 1, minWidth: 0, marginLeft: 'auto', fontSize: 14, lineHeight: 21, fontWeight: '600', color: semantic.text, textAlign: 'right', fontVariant: ['tabular-nums'] as 'tabular-nums'[] },
  helper: { fontSize: 12, lineHeight: 18, color: semantic.secondary },
  warning: { fontSize: 13, lineHeight: 20, color: semantic.warning },
  error: { fontSize: 12, lineHeight: 18, color: semantic.error },
} as const;
