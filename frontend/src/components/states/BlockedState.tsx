import { semantic } from '../../theme/tokens';
import React from 'react';
import {
  ScrollView,
  Text,
  StyleSheet,
} from '../../theme/native';
// The safe-area-context view, not React Native's (iOS only): it pads only where it
// meets a system bar, so as the whole (headerless) season join screen its
// scrolled-to end stays above Android's navigation bar; in a tab it adds nothing.
import { SafeAreaView } from '../../theme/safeArea';
import ActionPressable from '../common/ActionPressable';

interface BlockedStateProps {
  title?: string;
  titleContent?: React.ReactNode;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export default function BlockedState({
  title = '현재 진행할 수 없습니다.',
  titleContent,
  message,
  actionLabel,
  onAction,
}: BlockedStateProps) {
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.center}>
        {titleContent ?? <Text style={styles.title}>{title}</Text>}
        <Text style={styles.message}>{message}</Text>

        {actionLabel && onAction ? (
          <ActionPressable style={styles.button} onPress={onAction}>
            <Text style={styles.buttonText}>{actionLabel}</Text>
          </ActionPressable>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * The message is the whole point of this screen, so it must be fully readable
 * at any font scale (작업 10 §B-8).
 *
 * `flex: 1` + `justifyContent: 'center'` centres nicely at default sizes and
 * CLIPS at large accessibility scales — the longest copy here is the structural
 * integrity message, which is exactly the one a user must be able to read and
 * report. A ScrollView whose content is centred while it fits and scrolls when
 * it does not keeps both behaviours.
 */
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: semantic.screen },
  center: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  message: {
    fontSize: 14,
    color: semantic.secondary,
    lineHeight: 20,
    textAlign: 'center',
  },
  button: {
    marginTop: 16,
    backgroundColor: semantic.selected,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 18,
    alignItems: 'center',
  },
  buttonText: {
    color: semantic.onAccent,
    fontWeight: '700',
  },
});
