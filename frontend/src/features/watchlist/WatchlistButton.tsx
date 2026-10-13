import React from 'react';
import { StyleSheet, Text } from '../../theme/native';
import ActionPressable from '../../components/common/ActionPressable';
import { semantic } from '../../theme/tokens';

export type WatchlistButtonProps = {
  assetId: string;
  name: string;
  registered: boolean | undefined;
  pending: boolean;
  disabled: boolean;
  onChange: (assetId: string, registered: boolean) => void;
};

export default function WatchlistButton({
  assetId,
  name,
  registered,
  pending,
  disabled,
  onChange,
}: WatchlistButtonProps) {
  return (
    <ActionPressable
      testID={`watchlist-button-${assetId}`}
      accessibilityRole="button"
      accessibilityLabel={`${name} 관심종목 ${registered === undefined ? '확인 중' : registered ? '해제' : '등록'}`}
      accessibilityState={{
        disabled: disabled || pending,
        busy: pending,
        selected: registered === true,
      }}
      disabled={disabled || pending}
      onPress={() => onChange(assetId, !registered)}
      style={[styles.button, registered && styles.selected]}
    >
      <Text style={styles.label}>
        {pending ? '…' : registered === undefined ? '…' : registered ? '★' : '☆'}
      </Text>
    </ActionPressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minWidth: 48,
    minHeight: 48,
    padding: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: semantic.border,
    backgroundColor: semantic.surface,
  },
  selected: { borderColor: semantic.selected },
  label: { fontSize: 24, color: semantic.text },
});
