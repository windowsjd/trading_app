import React from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useHeaderHeight } from '@react-navigation/elements';
import { useIsFocused } from '@react-navigation/native';
import type { OrderScreenProps } from '../../app/navigation/types';
import OrderPanel from './OrderPanel';

export default function OrderScreen({ route, navigation }: OrderScreenProps) {
  const { assetId, accountId, side } = route.params;
  const headerHeight = useHeaderHeight();
  const isFocused = useIsFocused();
  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.screen}>
      <KeyboardAvoidingView
        style={styles.screen}
        keyboardVerticalOffset={headerHeight}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
        >
          <OrderPanel
            key={`${assetId}:${accountId}:${side}`}
            assetId={assetId}
            accountId={accountId}
            initialSide={side}
            enabled={isFocused}
            onReturnToAsset={() => navigation.goBack()}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, paddingBottom: 32 },
});
