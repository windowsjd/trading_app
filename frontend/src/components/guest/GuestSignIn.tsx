import React, { useContext } from 'react';
import { Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../common/ActionPressable';
import CTAButton from '../common/CTAButton';
import { GuestExitContext } from './guestExit';

/**
 * 로그인 (the primary action) and the 회원가입 link: guest browsing's only
 * ways out, each to the existing auth screen.
 */
export function GuestSignInActions({ testID }: { testID: string }) {
  const exit = useContext(GuestExitContext);
  if (!exit) return null;
  return (
    <View style={styles.actions}>
      <CTAButton testID={`${testID}-login`} label="로그인" onPress={exit.signIn} />
      <ActionPressable testID={`${testID}-signup`} accessibilityRole="button" style={styles.link} onPress={exit.signUp}>
        <Text style={styles.linkText}>회원가입</Text>
      </ActionPressable>
    </View>
  );
}

/**
 * In guest browsing, a section whose data needs a signed-in member: what
 * signing in shows here, then the way in. Never a failure state.
 */
export function GuestSignInPanel({ title, message, testID }: {
  title: string;
  message?: string;
  testID: string;
}) {
  return (
    <View testID={testID} style={styles.panel}>
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      <GuestSignInActions testID={testID} />
    </View>
  );
}

// Plain objects: shared screens load this under minimal native test mocks.
const styles = {
  actions: { gap: 4, marginTop: 4 },
  link: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12, paddingHorizontal: 12 },
  linkText: { fontSize: 15, lineHeight: 22, fontWeight: '600', color: semantic.secondaryActionForeground, textAlign: 'center' },
  panel: { borderWidth: 1, borderColor: semantic.border, borderRadius: 12, padding: 14, gap: 6, backgroundColor: semantic.raised },
  // Full sentences: they wrap at any width and text size, never clip.
  title: { fontSize: 15, lineHeight: 22, fontWeight: '700', color: semantic.text },
  message: { fontSize: 14, lineHeight: 21, color: semantic.secondary },
} as const;
