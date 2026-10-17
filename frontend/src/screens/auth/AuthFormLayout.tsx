import React, { useRef } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TextInput,
  View,
  type TextInputProps,
} from '../../theme/native';
import { useSafeAreaInsets } from '../../theme/safeArea';
import { semantic } from '../../theme/tokens';
import { useFocusedInputScroll } from '../../hooks/useFocusedInputScroll';
import { useKeyboardCover } from '../../hooks/useKeyboardCover';

export type AuthFormScroll = ReturnType<typeof useFocusedInputScroll>;

/**
 * Login/sign-up frame. The form stays centred, but it scrolls, so a field or
 * the submit button under the keyboard can always be reached.
 *
 * Android draws edge to edge (`edgeToEdgeEnabled`): `adjustResize` no longer
 * shrinks the window, so the keyboard covers the screen instead of resizing
 * it. KeyboardAvoidingView therefore pads on both platforms. On Android it
 * only runs while the keyboard is up: its hide event reports the visible
 * area's height, which would leave status/navigation bar padding behind on a
 * full-window screen. The safe-area padding is applied from the insets
 * context (the RN SafeAreaView is a no-op on Android).
 */
export default function AuthFormLayout({ testID, scroll, children }: {
  testID: string;
  scroll: AuthFormScroll;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardCover();
  return (
    <View style={styles.container}>
      <KeyboardAvoidingView style={styles.flex} behavior="padding" enabled={Platform.OS !== 'android' || keyboard > 0}>
        <ScrollView
          ref={scroll.scrollRef}
          style={styles.flex}
          contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
          keyboardShouldPersistTaps="handled"
          onScroll={scroll.onScroll}
          scrollEventThrottle={16}
          onLayout={scroll.revealFocusedInput}
          onContentSizeChange={scroll.revealFocusedInput}
        >
          <View testID={testID} style={styles.content}>
            {children}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

/** A form field that keeps itself (and the submit) in view while focused. */
export function AuthField({ scroll, onFocus, onBlur, ...props }: TextInputProps & { scroll: AuthFormScroll }) {
  const fieldRef = useRef<View>(null);
  return (
    <View ref={fieldRef} collapsable={false}>
      <TextInput
        {...props}
        onFocus={(event) => {
          onFocus?.(event);
          scroll.onInputFocus(fieldRef.current);
        }}
        onBlur={(event) => {
          onBlur?.(event);
          scroll.onInputBlur();
        }}
      />
    </View>
  );
}

/** The submit button's box, measured with the focused field. */
export function AuthSubmitBox({ scroll, children }: { scroll: AuthFormScroll; children: React.ReactNode }) {
  return <View ref={scroll.submitRef} collapsable={false}>{children}</View>;
}

// Plain objects: the auth screen tests load this with minimal native mocks.
const styles = {
  container: { flex: 1, backgroundColor: semantic.screen },
  flex: { flex: 1 },
  scrollContent: { flexGrow: 1, justifyContent: 'center' },
  content: { padding: 24, gap: 12 },
} as const;
