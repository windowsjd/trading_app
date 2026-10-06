import { semantic } from '../../theme/tokens';
import React from 'react';
import {
  SafeAreaView,
  ScrollView,
  Text,
  StyleSheet,
} from '../../theme/native';
import ActionPressable from '../common/ActionPressable';
import AdminDiagnosticPanel from './AdminDiagnosticPanel';
import type { RuntimeFacts } from '../../services/ws/runtimeDiagnostics';

interface ErrorStateProps {
  title?: string;
  message?: string;
  actionLabel?: string;
  onRetry?: () => void;
  diagnosticError?: unknown;
  diagnosticRuntime?: RuntimeFacts;
}

export default function ErrorState({
  title = '문제가 발생했습니다.',
  message = '잠시 후 다시 시도해주세요.',
  actionLabel = '다시 시도',
  onRetry,
  diagnosticError,
  diagnosticRuntime,
}: ErrorStateProps) {
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.center}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.message}>{message}</Text>
        <AdminDiagnosticPanel error={diagnosticError} runtime={diagnosticRuntime} includeRuntimeWithDiagnostic={!!diagnosticRuntime} />

        {onRetry ? (
          <ActionPressable accessibilityRole="button" feedback="button" style={styles.button} onPress={onRetry}>
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
