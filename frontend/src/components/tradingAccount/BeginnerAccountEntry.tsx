import React from 'react';
import { StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import CTAButton from '../common/CTAButton';
import ErrorNotice from '../states/ErrorNotice';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { useOpenBeginnerAccount } from '../../features/tradingAccount/useOpenGeneralAccount';

/** Explicit beginner creation or selection for every authenticated user. */
export default function BeginnerAccountEntry({ onEntered }: { onEntered: () => void }) {
  const { accounts, selectAccount } = useTradingAccount();
  const existing = accounts.find(account => account.mode === 'beginner');
  const open = useOpenBeginnerAccount({ onOpened: onEntered });
  return (
    <View style={styles.card} testID="beginner-account-entry">
      <Text style={styles.title}>초보모드</Text>
      <Text style={styles.body}>초보 계정의 자산과 거래 기록은 다른 계정과 별도로 관리됩니다.</Text>
      <CTAButton
        testID="beginner-account-start"
        label={existing ? '초보모드 계속하기' : '초보 계정 만들기'}
        state={open.isPending ? 'loading' : 'enabled'}
        onPress={existing ? () => { selectAccount(existing.id); onEntered(); } : open.start}
      />
      {open.error ? <ErrorNotice error={open.error} testID="beginner-account-error" style={styles.error} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 12, padding: 16, borderRadius: 16, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.surface },
  title: { fontSize: 20, fontWeight: '700', color: semantic.text },
  body: { fontSize: 14, lineHeight: 22, color: semantic.secondary },
  error: { fontSize: 14, lineHeight: 22, color: semantic.error },
});
