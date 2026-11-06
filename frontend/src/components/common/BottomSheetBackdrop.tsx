import { semantic } from '../../theme/tokens';
import React from 'react';
import { Modal, Pressable, StyleSheet, View, type ViewStyle } from '../../theme/native';
import { useSafeAreaInsets } from '../../theme/safeArea';
import { useOwnerScreenFocused } from './ScreenSheetHost';

interface BottomSheetBackdropProps {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Added to the sheet (e.g. a maxHeight that keeps a tall sheet on screen). */
  sheetStyle?: ViewStyle;
}

export default function BottomSheetBackdrop({
  visible,
  onClose,
  children,
  sheetStyle,
}: BottomSheetBackdropProps) {
  // React Native draws a Modal edge to edge on Android (edgeToEdgeEnabled), so this
  // bottom-anchored sheet would reach under the navigation bar: it ends above it
  // itself, as InlineBottomSheet does (and above iOS's home indicator). No inset: 20.
  const insets = useSafeAreaInsets();
  // A Modal is its own window above every screen: while another screen covers
  // this one (a push tap opened 거래 내역, the order screen opened its chart)
  // it hides instead of blocking that screen, and shows again on return.
  const focused = useOwnerScreenFocused();
  return (
    <Modal
      visible={visible && focused}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) + 8 }, sheetStyle]}>{children}</View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  backdrop: {
    flex: 1,
  },
  sheet: {
    backgroundColor: semantic.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    gap: 12,
  },
});