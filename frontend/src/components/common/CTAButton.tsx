import { logoutGradient, primaryGradient, semantic } from '../../theme/tokens';
import React from 'react';
import {
  Alert,
  Text,
  StyleSheet,
  View,
  ViewStyle,
} from '../../theme/native';
import ActionPressable from './ActionPressable';
import WhaleLoader from '../states/WhaleLoader';
import type { RippleTone } from './pressFeedback';
import LearningLock from '../../features/quest/LearningLock';
import { QUEST_LOCK_CAPTION } from '../../features/quest/questProgress';

type CTAState = 'enabled' | 'disabled' | 'loading' | 'blocked';

interface CTAButtonProps {
  label: string;
  /** Only server-confirmed learning restrictions; operational disabled remains separate. */
  learningHint?: string | null;
  /** The line shown under a learning-locked button; the quest lock's copy by default. */
  learningCaption?: string | null;
  leadingIcon?: React.ReactNode;
  state?: CTAState;
  onPress?: () => void;
  style?: ViewStyle;
  testID?: string;
  /** History entry uses secondary; back and recovery actions keep neutral. */
  variant?: 'primary' | 'secondary' | 'neutral' | 'logout';
  /** Trade-executing commands pass `subtle`. */
  ripple?: RippleTone;
  /** What pressing does, read after the label (e.g. the expected order total). */
  accessibilityHint?: string;
}

export default function CTAButton({
  label,
  learningHint,
  learningCaption,
  leadingIcon,
  state = 'enabled',
  onPress,
  style,
  testID,
  variant = 'primary',
  ripple,
  accessibilityHint,
}: CTAButtonProps) {
  const disabled = state === 'disabled' || state === 'loading' || state === 'blocked';
  // A locked button carries its reason underneath: the pair takes the button's
  // place in its parent, and the button keeps its own size and look.
  const locked = learningHint ? splitPlacement(style) : null;

  const button = (
    <ActionPressable
      feedback="button"
      primary={!learningHint && variant === 'primary' && style?.backgroundColor === undefined}
      gradient={variant === 'logout' ? logoutGradient : undefined}
      ripple={ripple}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={learningHint ? `${label}, 학습 제한. ${learningHint}` : label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled || !!learningHint, busy: state === 'loading' }}
      style={[
        styles.button,
        variant === 'logout' && styles.logout,
        variant === 'secondary' && styles.secondary,
        state === 'blocked' && styles.blocked,
        state === 'disabled' && styles.disabled,
        locked ? locked.own : style,
        learningHint && styles.learning,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      {state === 'loading' ? (
        // Same line height as the label, so the button keeps its size.
        <View style={styles.loading}>
          <WhaleLoader size={21} tone={variant === 'secondary' ? 'brand' : 'onAction'} accessibilityLabel={`${label} 처리 중`} />
        </View>
      ) : leadingIcon || learningHint ? (
        <View style={styles.labelGroup}>
          <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.icon}>{leadingIcon}</View>
          {learningHint ? <LearningLock /> : null}
          <Text style={[styles.text, styles.iconLabel, variant === 'secondary' && styles.secondaryText, !!learningHint && styles.learningText]}>{label}</Text>
        </View>
      ) : (
        <Text style={variant === 'secondary' ? [styles.text, styles.secondaryText] : styles.text}>{label}</Text>
      )}
    </ActionPressable>
  );
  if (!locked) return button;
  const caption = learningCaption ?? QUEST_LOCK_CAPTION;
  return (
    <View style={[styles.lockedGroup, locked.placement]}>
      {button}
      {/* The locked button takes no press, so its quest's own guidance opens from here. */}
      <ActionPressable testID={testID && `${testID}-learning-caption`} accessibilityRole="button" style={styles.learningCaptionPress}
        accessibilityLabel={`${caption} 자세히 보기`} onPress={() => Alert.alert('기능 안내', learningHint ?? caption)}>
        <Text style={styles.learningCaption}>{caption}</Text>
      </ActionPressable>
    </View>
  );
}

// Where the button sits in its parent (moved to the button + caption pair), as opposed to its own box.
const PLACEMENT_KEYS = new Set(['flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf', 'width', 'minWidth', 'maxWidth',
  'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'marginHorizontal', 'marginVertical', 'marginStart',
  'marginEnd', 'position', 'top', 'right', 'bottom', 'left', 'start', 'end', 'zIndex']);

function splitPlacement(style?: ViewStyle) {
  const placement: Record<string, unknown> = {};
  const own: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(StyleSheet.flatten(style) ?? {})) (PLACEMENT_KEYS.has(key) ? placement : own)[key] = value;
  return { placement: placement as ViewStyle, own: own as ViewStyle };
}

const styles = StyleSheet.create({
  learning: { backgroundColor: semantic.raised, borderWidth: 1, borderColor: semantic.border },
  learningText: { color: semantic.secondary },
  lockedGroup: { gap: 6 },
  learningCaption: { fontSize: 12, lineHeight: 17, color: semantic.secondary, textAlign: 'center' },
  learningCaptionPress: { minHeight: 24, justifyContent: 'center', borderRadius: 6 },
  labelGroup: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, maxWidth: '100%' },
  icon: { flexShrink: 0 },
  loading: { minHeight: 21, alignItems: 'center', justifyContent: 'center' },
  iconLabel: { flexShrink: 1 },
  button: {
    backgroundColor: semantic.selected,
    borderRadius: 12,
    paddingVertical: 14,
    // Horizontal padding so a long Korean label does not run to the edges, and
    // no numberOfLines so it wraps instead of being cut (작업 10 §B-8).
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: 0.45,
  },
  logout: { backgroundColor: logoutGradient.colors[0] },
  secondary: { backgroundColor: semantic.secondaryActionSurface },
  secondaryText: { color: semantic.secondaryActionForeground },
  blocked: {
    opacity: 0.45,
  },
  text: {
    color: primaryGradient.foreground,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 21,
  },
});
