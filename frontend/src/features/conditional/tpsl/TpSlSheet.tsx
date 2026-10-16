import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from '../../../theme/native';
import InlineBottomSheet from '../../../components/common/InlineBottomSheet';
import { SheetPortal } from '../../../components/common/ScreenSheetHost';
import { useFocusedInputScroll } from '../../../hooks/useFocusedInputScroll';
import type { EntryTpSlDraftDto, EntryTpSlEntryType } from '../entryTpSlApi';
import { TP_SL_TITLE, type TpSlDirection } from '../tpSlModel';
import SpotHoldingTpSl from './SpotHoldingTpSl';
import FuturesPositionTpSl from './FuturesPositionTpSl';
import EntryTpSl from './EntryTpSl';
import DraftTpSl from './DraftTpSl';

/** What the 손절가/익절가 sheet is opened for. */
export type TpSlTarget =
  | { type: 'spot_holding'; accountId: string; assetId: string }
  | { type: 'futures_position'; accountId: string; positionId: string }
  | { type: 'entry'; accountId: string; entryType: EntryTpSlEntryType; entryId: string };

export function tpSlTargetKey(target: TpSlTarget) {
  return target.type === 'spot_holding' ? `${target.accountId}:holding:${target.assetId}`
    : target.type === 'futures_position' ? `${target.accountId}:position:${target.positionId}`
    : `${target.accountId}:${target.entryType}:${target.entryId}`;
}

type Common = {
  onBusyChange: (busy: boolean) => void;
  onInputFocus: (input: View | null) => void;
  onInputBlur: () => void;
  submitRef: React.RefObject<View | null>;
};

/**
 * The 손절가/익절가 bottom sheet, the same for a holding, a position and a
 * pending entry. It rises from the bottom in the app's sheet layer (below the
 * beginner guide), scrolls inside its own height, keeps the focused price
 * input and the submit above the keyboard, and never closes while a command
 * is in flight. Each target mounts a fresh body: another account, asset or
 * order never inherits a draft.
 */
export default function TpSlSheet({ target, onClose }: { target: TpSlTarget | null; onClose: () => void }) {
  // The last target stays rendered through the closing motion.
  const last = useRef<TpSlTarget | null>(null);
  if (target) last.current = target;
  const shown = target ?? last.current;
  const [busy, setBusy] = useState(false);
  return (
    <SheetPortal>
      <InlineBottomSheet testID="tp-sl-sheet" title={TP_SL_TITLE} visible={!!target} dismissible={!busy} onClose={onClose}>
        {shown ? (
          <SheetScroll key={tpSlTargetKey(shown)} onBusyChange={setBusy}>
            {(common) => shown.type === 'spot_holding'
              ? <SpotHoldingTpSl accountId={shown.accountId} assetId={shown.assetId} {...common} />
              : shown.type === 'futures_position'
                ? <FuturesPositionTpSl accountId={shown.accountId} positionId={shown.positionId} {...common} />
                : <EntryTpSl accountId={shown.accountId} entryType={shown.entryType} entryId={shown.entryId} {...common} />}
          </SheetScroll>
        ) : null}
      </InlineBottomSheet>
    </SheetPortal>
  );
}

/** The order forms' sheet: plans that will be sent with the new entry. */
export function TpSlDraftSheet({ visible, onClose, scopeKey, ...draft }: {
  visible: boolean;
  onClose: () => void;
  /** A new form (account, asset, side, entry) starts a fresh draft body. */
  scopeKey: string;
  drafts: readonly EntryTpSlDraftDto[];
  onChange: (drafts: EntryTpSlDraftDto[]) => void;
  direction: TpSlDirection;
  entryPrice: string | null;
  expectedQuantity: string | null;
  scale: number;
  unit: string;
  currency: string;
  blockedReason: string | null;
}) {
  return (
    <SheetPortal>
      <InlineBottomSheet testID="tp-sl-sheet" title={TP_SL_TITLE} visible={visible} onClose={onClose}>
        <SheetScroll key={scopeKey} onBusyChange={() => undefined}>
          {({ onInputFocus, onInputBlur, submitRef }) => (
            <DraftTpSl {...draft} onInputFocus={onInputFocus} onInputBlur={onInputBlur} submitRef={submitRef} />
          )}
        </SheetScroll>
      </InlineBottomSheet>
    </SheetPortal>
  );
}

function SheetScroll({ onBusyChange, children }: { onBusyChange: (busy: boolean) => void; children: (common: Common) => React.ReactNode }) {
  const scroll = useFocusedInputScroll();
  const report = useCallback((busy: boolean) => onBusyChange(busy), [onBusyChange]);
  // A body that goes away is never "busy" (its sheet may close again).
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  return (
    <View style={styles.viewport}>
      <ScrollView testID="tp-sl-scroll" ref={scroll.scrollRef} onLayout={scroll.revealFocusedInput}
        onContentSizeChange={scroll.revealFocusedInput} onScroll={scroll.onScroll} scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="none" style={styles.scroll} contentContainerStyle={styles.content}>
        {children({ onBusyChange: report, onInputFocus: scroll.onInputFocus, onInputBlur: scroll.onInputBlur, submitRef: scroll.submitRef })}
      </ScrollView>
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  viewport: { flexShrink: 1, minHeight: 0 },
  scroll: { flexGrow: 0 },
  content: { gap: 12, paddingTop: 4, paddingBottom: 8 },
} as const;
