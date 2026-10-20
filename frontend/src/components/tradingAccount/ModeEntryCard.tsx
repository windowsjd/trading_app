import React from 'react';
import { StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import CTAButton from '../common/CTAButton';
import ErrorNotice from '../states/ErrorNotice';

/**
 * One mode the user can enter or create (초보모드, 일반모드): the title, one
 * sentence, then a full-width CTA. Nothing happens until that press; a failed
 * open keeps its original error for the shared diagnostic surface.
 */
export default function ModeEntryCard({
  testID,
  title,
  description,
  descriptionTestID,
  actionLabel,
  actionTestID,
  pending,
  onPress,
  error,
  errorTestID,
}: {
  testID: string;
  title: string;
  description: string;
  descriptionTestID?: string;
  actionLabel: string;
  actionTestID: string;
  pending: boolean;
  onPress: () => void;
  error: unknown;
  errorTestID: string;
}) {
  return (
    <View style={styles.card} testID={testID}>
      <Text style={styles.title}>{title}</Text>
      <Text testID={descriptionTestID} style={styles.body}>{description}</Text>
      <CTAButton
        testID={actionTestID}
        label={actionLabel}
        state={pending ? 'loading' : 'enabled'}
        onPress={onPress}
      />
      {error ? <ErrorNotice error={error} testID={errorTestID} style={styles.error} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 12, padding: 16, borderRadius: 16, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.surface },
  title: { fontSize: 20, fontWeight: '700', color: semantic.text },
  body: { fontSize: 14, lineHeight: 22, color: semantic.secondary },
  error: { fontSize: 14, lineHeight: 22, color: semantic.error },
});
