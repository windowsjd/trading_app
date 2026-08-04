import React, { useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import CTAButton from '../common/CTAButton';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import { openGeneralAccount } from '../../features/tradingAccount/api';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { getApiErrorDisplayMessage } from '../../services/api/errorMapper';

/**
 * What a user with NO trading account sees (작업 11 §3.3).
 *
 * Before this, that user reached the season screen and — if no season was open,
 * or the open one had closed for entry — had nowhere to go. They owned nothing,
 * so every financial screen was empty, and the app offered no way to change
 * that. This panel is the way: it names both real entrances and can take the
 * general one itself.
 *
 * NOTHING IS CREATED IMPLICITLY. The account is opened by a POST that only a
 * press can issue. Opening grants starting capital and writes wallets and a
 * ledger row, so it must be an act the user took, not a side effect of a screen
 * they happened to land on. The server is idempotent, so a double press yields
 * one account.
 *
 * The season entrance stays OPTIONAL: whether a joinable season exists is the
 * caller's knowledge, and a user with no account must not be told to join a
 * season that is not open.
 */

type Props = {
  title?: string;
  message: string;
  /** Called after the account exists and is selected. */
  onOpened: () => void;
  /** Offered only when the caller knows a season can actually be joined. */
  seasonAction?: {
    label: string;
    onPress: () => void;
    pending?: boolean;
  };
};

export default function AccountSetupPanel({
  title = '아직 투자 계정이 없습니다.',
  message,
  onOpened,
  seasonAction,
}: Props) {
  const queryClient = useQueryClient();
  const { selectAccount } = useTradingAccount();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const openMutation = useMutation({
    mutationFn: openGeneralAccount,
    onSuccess: async (result) => {
      setErrorMessage(null);
      // The list is the source of truth for what this user owns; refetch it
      // before selecting so the selection lands on an account the provider can
      // actually see.
      await queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.tradingAccount.listAll,
      });
      selectAccount(result.account.id);
      onOpened();
    },
    onError: (error: unknown) => {
      setErrorMessage(getApiErrorDisplayMessage(error));
    },
  });

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.content}
        testID={TEST_IDS.tradingAccount.setupPanel}
      >
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.message}>{message}</Text>
        </View>

        <CTAButton
          label={
            openMutation.isPending
              ? '계정을 여는 중입니다...'
              : '일반 투자 계정 시작하기'
          }
          state={openMutation.isPending ? 'loading' : 'enabled'}
          onPress={() => {
            setErrorMessage(null);
            openMutation.mutate();
          }}
        />
        <Text style={styles.helper}>
          일반 투자 계정은 시즌과 무관하게 유지되며, 시간가중 수익률로 성과를
          확인할 수 있습니다. 매매와 환전 기능은 아직 준비 중입니다.
        </Text>

        {seasonAction ? (
          <>
            <CTAButton
              label={seasonAction.label}
              state={seasonAction.pending ? 'loading' : 'enabled'}
              onPress={seasonAction.onPress}
            />
            <Text style={styles.helper}>
              시즌 계정은 해당 시즌에만 유효하며 랭킹과 등급이 함께 제공됩니다.
            </Text>
          </>
        ) : null}

        {errorMessage ? (
          <Text style={styles.error}>{errorMessage}</Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  // flexGrow (not flex) so the copy scrolls instead of clipping at large font
  // scales, which is where the longest sentence here stops fitting (§20).
  content: { flexGrow: 1, padding: 20, gap: 12, justifyContent: 'center' },
  card: {
    borderWidth: 1,
    borderColor: '#e5e5e5',
    borderRadius: 12,
    padding: 16,
    backgroundColor: '#fafafa',
    gap: 8,
  },
  title: { fontSize: 22, fontWeight: '700', lineHeight: 30 },
  message: { fontSize: 14, color: '#444', lineHeight: 21 },
  helper: { fontSize: 13, color: '#666', lineHeight: 19 },
  error: { fontSize: 14, color: '#c62828', lineHeight: 21 },
});
