import React from 'react';
import { Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../common/ActionPressable';
import { FUNDING_WALLET, type FundingAction, type FundingProduct } from '../../features/wallet/walletFunding';

const ACTION_LABEL = { transfer: '이체하기', fx: '환전하기' } as const;

/**
 * An order screen's line about the wallet it pays from, followed by small text
 * actions that open the money-moving sheet over the screen: only the routes
 * the app supports into that wallet (FUNDING_WALLET). Without a message it is
 * the actions alone (under an insufficient-balance error that says it already).
 * Wraps on a narrow screen; each action keeps a 44 dp touch target.
 */
export default function WalletFundingNotice({ product, message, onAction, testID, disabled = false }: {
  product: FundingProduct;
  message: string | null;
  onAction: (action: FundingAction) => void;
  testID: string;
  disabled?: boolean;
}) {
  return (
    <View testID={testID} style={styles.row}>
      {message ? <Text testID={`${testID}-message`} accessibilityLiveRegion="polite" style={styles.message}>{message}</Text> : null}
      {FUNDING_WALLET[product].actions.map((action) => (
        <ActionPressable key={action.kind} testID={`${testID}-${action.kind}`} accessibilityRole="button"
          accessibilityLabel={`${ACTION_LABEL[action.kind]}, ${FUNDING_WALLET[product].name}`}
          disabled={disabled} hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }} onPress={() => onAction(action)} style={styles.action}>
          <Text style={[styles.actionText, disabled && styles.disabled]}>{ACTION_LABEL[action.kind]} ›</Text>
        </ActionPressable>
      ))}
    </View>
  );
}

// Plain objects: order screens are rendered by harnesses with minimal native mocks.
const styles = {
  row: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, alignItems: 'center' as const, columnGap: 12, rowGap: 4 },
  message: { flexShrink: 1, fontSize: 14, lineHeight: 21, color: semantic.secondary },
  action: { minHeight: 24, justifyContent: 'center' as const, borderRadius: 6 },
  actionText: { fontSize: 14, lineHeight: 21, fontWeight: '700' as const, color: semantic.secondaryActionForeground },
  disabled: { opacity: 0.45 },
};
