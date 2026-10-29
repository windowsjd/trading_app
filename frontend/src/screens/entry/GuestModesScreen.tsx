import React, { useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from '../../theme/native';
import { SafeAreaView } from '../../theme/safeArea';
import { semantic } from '../../theme/tokens';
import { getHeaderScreenContentStyle } from '../../theme/screenLayout';
import CTAButton from '../../components/common/CTAButton';
import GuestSignInSheet from '../../components/guest/GuestSignInSheet';

type GuestMode = { key: 'season' | 'general' | 'beginner'; title: string; description: string; points: string[] };

/**
 * The three investment modes in the account selection screen's order. Copy
 * only: what each mode is, never a promise about a particular season.
 */
const MODES: GuestMode[] = [
  {
    key: 'season',
    title: '시즌모드',
    description: '정해진 기간 동안 다른 참가자들과 가상투자 수익률을 경쟁합니다.',
    points: ['시즌 참가자 모두 같은 가상자금으로 시작합니다.', '랭킹에서 순위와 티어를 확인할 수 있습니다.'],
  },
  {
    key: 'general',
    title: '일반모드',
    description: '나의 가상자산을 자유롭게 운용하고 투자 성과를 관리합니다.',
    points: ['시즌 기간 제한 없이 가상투자를 연습합니다.', '가이드에서 투자 개념을 함께 익힐 수 있습니다.'],
  },
  {
    key: 'beginner',
    title: '초보모드',
    description: '투자의 기초를 배우고 단계별 퀘스트를 수행합니다.',
    points: ['퀘스트를 따라 기초부터 다양한 거래 방법까지 연습합니다.', '퀘스트를 마칠수록 더 많은 거래 기능이 열립니다.'],
  },
];

/**
 * 투자모드 in guest browsing (2026-10-30), in MY's place. Reading it creates
 * nothing; 시작하기 asks the visitor to sign in or sign up, after which the
 * existing account selection screen lets them choose the mode themselves.
 */
export default function GuestModesScreen() {
  const [starting, setStarting] = useState<GuestMode | null>(null);
  // The sheet keeps its copy while it slides away.
  const [shown, setShown] = useState<GuestMode>(MODES[0]);
  const start = (mode: GuestMode) => {
    setShown(mode);
    setStarting(mode);
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={styles.screen}>
      <ScrollView testID="guest-modes" contentContainerStyle={styles.content}>
        <Text style={styles.intro}>
          세 가지 투자모드로 가상투자를 시작할 수 있습니다. 로그인하거나 회원가입한 뒤 계정 선택 화면에서 원하는 모드를 직접 고르세요.
        </Text>
        {MODES.map((mode) => (
          <View key={mode.key} testID={`guest-mode-${mode.key}`} style={styles.card}>
            <Text accessibilityRole="header" style={styles.cardTitle}>{mode.title}</Text>
            <Text style={styles.cardBody}>{mode.description}</Text>
            <View style={styles.points}>
              {mode.points.map((point) => (
                <View key={point} style={styles.point}>
                  <Text style={styles.bullet} accessible={false}>•</Text>
                  <Text style={styles.pointText}>{point}</Text>
                </View>
              ))}
            </View>
            <CTAButton testID={`guest-mode-${mode.key}-start`} label={`${mode.title} 시작하기`} onPress={() => start(mode)} />
          </View>
        ))}
      </ScrollView>
      <GuestSignInSheet
        testID="guest-mode-sign-in"
        visible={starting !== null}
        message={`${shown.title}는 로그인 후 시작할 수 있습니다. 로그인하거나 회원가입한 뒤 계정 선택 화면에서 ${shown.title}를 선택해 주세요.`}
        onClose={() => setStarting(null)}
      />
    </SafeAreaView>
  );
}

// The account selection screen's card (ModeSelectionScreen): every text wraps.
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  content: getHeaderScreenContentStyle(Platform.OS),
  intro: { fontSize: 15, lineHeight: 23, color: semantic.secondary },
  card: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 12,
    padding: 16,
    backgroundColor: semantic.surface,
    gap: 8,
  },
  cardTitle: { fontSize: 17, fontWeight: '700', color: semantic.text, lineHeight: 24 },
  cardBody: { fontSize: 14, color: semantic.secondary, lineHeight: 21 },
  points: { gap: 4, marginBottom: 4 },
  point: { flexDirection: 'row', gap: 6, minWidth: 0 },
  bullet: { fontSize: 14, lineHeight: 21, color: semantic.muted },
  pointText: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 21, color: semantic.secondary },
});
