import React, { useState } from 'react';
import Svg, { Path } from 'react-native-svg';
import { Keyboard, ScrollView, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import ActionPressable from '../../components/common/ActionPressable';
import InlineBottomSheet from '../../components/common/InlineBottomSheet';
import { SheetPortal } from '../../components/common/ScreenSheetHost';
import { TRIGGER_PRICE_HELP } from '../../features/conditional/triggerPriceHelp';

/**
 * The price field's title on a Spot condition (조건부 매수 감시가격, 조건 매도
 * 매도 기준가) with a small ⓘ: the 증거금 모드 ⓘ of FuturesMarginModeField —
 * a 24pt mark with a 44pt target opening a short floating sheet. The typed
 * price stays as it is; only the keyboard steps aside while the sheet is
 * open. Used by ConditionalBuyForm and SellIntentForm only.
 */
export default function TriggerPriceLabel({ side, currency, testID }: {
  side: 'buy' | 'sell';
  currency: string;
  testID: string;
}) {
  const { colors } = useAppearance();
  const [open, setOpen] = useState(false);
  const help = TRIGGER_PRICE_HELP[side];
  return (
    <View style={styles.title}>
      <Text style={styles.label}>{help.term} ({currency})</Text>
      <ActionPressable
        testID={`${testID}-info`}
        accessibilityRole="button"
        accessibilityLabel={`${help.term} 설명`}
        accessibilityHint="자동 주문을 시작하는 기준가격 설명을 엽니다"
        hitSlop={10}
        onPress={() => { Keyboard.dismiss(); setOpen(true); }}
        style={styles.info}
      >
        <Svg width={16} height={16} viewBox="0 0 24 24" aria-hidden>
          <Path d="M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 11v6M12 7.5v.5" fill="none" stroke={colors.secondary}
            strokeWidth={2} strokeLinecap="round" />
        </Svg>
      </ActionPressable>
      <SheetPortal>
        <InlineBottomSheet testID={`${testID}-info-sheet`} title={help.title} floating visible={open} onClose={() => setOpen(false)}>
          <ScrollView style={styles.scroll} bounces={false}>
            <View style={styles.help} testID={`${testID}-info-body`}>
              {help.paragraphs.map((paragraph) => <Text key={paragraph} style={styles.text}>{paragraph}</Text>)}
            </View>
          </ScrollView>
        </InlineBottomSheet>
      </SheetPortal>
    </View>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  title: { flexDirection: 'row', alignItems: 'center', gap: 2, minWidth: 0 },
  label: { fontSize: 12, color: semantic.muted, flexShrink: 1 },
  info: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  scroll: { flexGrow: 0, flexShrink: 1 },
  help: { gap: 8, paddingHorizontal: 4, paddingBottom: 8 },
  text: { fontSize: 14, lineHeight: 21, color: semantic.secondary },
} as const;
