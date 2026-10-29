import React from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from '../../theme/native';
import { SafeAreaView } from '../../theme/safeArea';
import { semantic } from '../../theme/tokens';
import { getHeaderScreenContentStyle } from '../../theme/screenLayout';
import { GuestSignInActions } from '../../components/guest/GuestSignIn';

/**
 * 지갑 in guest browsing (2026-10-30): a wallet belongs to an investment
 * account, so this says what one holds and offers 로그인 / 회원가입. Nothing
 * is read: no balance, wallet list, FX, transfer or ledger.
 */
export default function GuestWalletScreen() {
  return (
    <SafeAreaView edges={['left', 'right']} style={styles.screen}>
      <ScrollView testID="guest-wallet" contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.title}>지갑은 로그인 후 이용할 수 있습니다</Text>
          <Text style={styles.message}>
            가상투자 계정을 만들면 원화·달러 잔액과 환전, 이체, 거래 원장을 이곳에서 관리할 수 있습니다.
          </Text>
          <GuestSignInActions testID="guest-wallet" />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  content: getHeaderScreenContentStyle(Platform.OS),
  card: { borderRadius: 14, padding: 16, gap: 8, backgroundColor: semantic.surface },
  title: { fontSize: 18, lineHeight: 27, fontWeight: '700', color: semantic.text },
  message: { fontSize: 15, lineHeight: 23, color: semantic.secondary },
});
