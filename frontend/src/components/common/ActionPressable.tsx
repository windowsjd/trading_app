import React, { useEffect, useMemo, useRef } from 'react';
import { primaryGradient, resolveSemanticColor, resolveSemanticStyle, type ActionGradient } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import { useReducedMotion } from '../../theme/useReducedMotion';
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  processColor,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from '../../theme/native';
import { buttonFeedback, getFeedbackPalette, getRipplePalette, splitButtonStyle, type RippleTone } from './pressFeedback';
import { InkRippleLayer, useInkRipple, type InkRipple } from './InkRipple';
import PrimaryButtonBackground from './PrimaryButtonBackground';

type Props = Omit<PressableProps, 'android_ripple'> & {
  ref?: React.Ref<View>;
  /** Opt in only for general primary actions; disabled surfaces stay unchanged. */
  primary?: boolean;
  gradient?: ActionGradient;
  /** Place the decorative wash on a smaller surface inside the hit target. */
  feedbackStyle?: StyleProp<ViewStyle>;
  /** Trade-executing commands use `subtle`: feedback without emphasis. */
  ripple?: RippleTone;
};
/** Row/card decoration painted beneath the press ink (default feedback only). */
type UnderlayProps = { underlay?: React.ReactNode };

/**
 * Buttons scale slightly and show ink from the touch point; rows/cards show
 * the same ink without scaling. Selection controls keep one static tint (their
 * sliding indicator is the feedback).
 */
export default function ActionPressable({ feedback, primary = false, gradient, underlay, ...props }: Props & UnderlayProps & {
  /** `none` is reserved for Market sort; `button` requires a visual surface. */
  feedback?: 'default' | 'button' | 'selection' | 'none';
}) {
  if (feedback === 'none') return <Pressable {...props} />;
  if (feedback === 'button' || (feedback === undefined && primary)) {
    return <ButtonActionPressable {...props} gradient={gradient ?? (primary ? primaryGradient : undefined)} />;
  }
  return <FeedbackActionPressable {...props} primary={primary} ink={feedback !== 'selection'} underlay={underlay} />;
}

const isBlocked = (disabled: PressableProps['disabled'], props: Props) =>
  !!disabled || !!props['aria-disabled'] || !!props.accessibilityState?.disabled;
// A busy action (login, order in flight) refuses input but keeps its look.
const isBusy = (props: Props) => !!props.accessibilityState?.busy || !!props['aria-busy'];

function ButtonActionPressable({ children, style, disabled, onPress, onPressIn, onPressOut, gradient, ripple: tone, ...props }: Props) {
  const { colors, mode, financialPreference } = useAppearance();
  const reduced = useReducedMotion();
  const ink = useInkRipple(reduced);
  const blocked = isBlocked(disabled, props);
  const painted = !blocked || isBusy(props);
  const visualStyle = (state: { pressed: boolean }) => StyleSheet.flatten(resolveSemanticStyle(
    [typeof style === 'function' ? style(state) : style, gradient && painted && { backgroundColor: gradient.colors[0] }],
    colors, mode, financialPreference,
  )) ?? {};
  return (
    <Pressable {...props} disabled={blocked} onPress={onPress}
      onPressIn={(event) => {
        // The surface ignores touches, so the location is relative to this target.
        ink.press(event?.nativeEvent?.locationX, event?.nativeEvent?.locationY);
        onPressIn?.(event);
      }}
      onPressOut={(event) => { ink.release(); onPressOut?.(event); }}
      style={(state) => splitButtonStyle(visualStyle(state)).target}>
      {(state) => <ButtonSurface pressed={state.pressed} enabled={!blocked && !!onPress} reduced={reduced} ink={ink} tone={tone}
        style={splitButtonStyle(visualStyle(state)).surface} gradient={painted ? gradient : undefined}>
        {typeof children === 'function' ? children(state) : children}
      </ButtonSurface>}
    </Pressable>
  );
}

function ButtonSurface({ children, pressed, enabled, reduced, ink, tone, style, gradient }: {
  children: React.ReactNode; pressed: boolean; enabled: boolean; reduced: boolean; ink: InkRipple; tone?: RippleTone;
  style: ViewStyle; gradient?: ActionGradient;
}) {
  useInkReleaseWhileBlocked(ink, enabled);
  const progress = useRef(new Animated.Value(0)).current;
  // Press and release re-render this surface; one node keeps the native graph.
  const scale = useMemo(() => progress.interpolate({ inputRange: [0, 1], outputRange: [1, buttonFeedback.scale], extrapolate: 'clamp' }), [progress]);
  useEffect(() => {
    if (reduced || !enabled) { progress.setValue(0); return; }
    const animation = Animated.timing(progress, {
      toValue: pressed ? 1 : 0,
      duration: pressed ? buttonFeedback.pressDuration : buttonFeedback.releaseDuration,
      easing: Easing.out(Easing.quad),
      useNativeDriver: Platform.OS !== 'web',
      isInteraction: false,
    });
    animation.start();
    return () => animation.stop();
  }, [enabled, pressed, progress, reduced]);
  // Ink and gradient lie inside the surface's border.
  const shape = clipShape(style, true);
  const color = processColor(gradient ? gradient.colors[0] : style.backgroundColor);
  const palette = getRipplePalette(typeof color === 'number' ? color : null, tone);
  return (
    <Animated.View pointerEvents="none" style={[styles.buttonSurface, style, {
      transform: [{ scale: reduced || !enabled ? 1 : scale }],
    }]}>
      {gradient ? <PrimaryButtonBackground shape={shape} gradient={gradient} /> : null}
      <InkRippleLayer ripple={ink} color={palette.rippleColor} opacity={palette.rippleOpacity} style={[styles.clip, shape]} />
      {children}
    </Animated.View>
  );
}

/**
 * A press may turn its target busy or disabled before the ink has faded (an
 * order button starts loading on release). The ink layer therefore stays
 * mounted: unmounting detaches its Animated values, which stops the running
 * fade/spread where they are, and the next enable would paint that frozen,
 * half-spread ink again. A target that stops accepting input fades its ink.
 */
function useInkReleaseWhileBlocked(ink: InkRipple, enabled: boolean) {
  const { release } = ink;
  useEffect(() => {
    if (!enabled) release();
  }, [enabled, release]);
}

/**
 * The surface's corner shape for a layer laid over it. An absolute fill starts
 * inside the surface's border, so a layer there takes the border's inner curve
 * (each radius less the border width): with the outer radius a bordered card
 * (Market and ranking rows) kept a hairline crescent of un-inked surface at
 * every corner while its ink showed. A corner subtracts only its own sides'
 * width; more would push the layer past the card's outline there.
 */
function clipShape(base: ViewStyle, insideBorder = false): ViewStyle {
  const width = (...values: unknown[]) => {
    const value = values.find((candidate) => typeof candidate === 'number');
    return insideBorder && typeof value === 'number' ? value : 0;
  };
  // Logical sides win over physical ones (the app is left-to-right).
  const top = width(base.borderTopWidth, base.borderWidth);
  const bottom = width(base.borderBottomWidth, base.borderWidth);
  const left = width(base.borderStartWidth, base.borderLeftWidth, base.borderWidth);
  const right = width(base.borderEndWidth, base.borderRightWidth, base.borderWidth);
  const inner = <T,>(radius: T, border: number): T => (typeof radius === 'number' ? Math.max(0, radius - border) as T : radius);
  return {
    // One radius for every corner: the thinnest side, so no corner leaves the outline.
    borderRadius: inner(base.borderRadius, Math.min(top, bottom, left, right)),
    borderTopLeftRadius: inner(base.borderTopLeftRadius, Math.max(top, left)),
    borderTopRightRadius: inner(base.borderTopRightRadius, Math.max(top, right)),
    borderBottomLeftRadius: inner(base.borderBottomLeftRadius, Math.max(bottom, left)),
    borderBottomRightRadius: inner(base.borderBottomRightRadius, Math.max(bottom, right)),
    borderTopStartRadius: inner(base.borderTopStartRadius, Math.max(top, left)),
    borderTopEndRadius: inner(base.borderTopEndRadius, Math.max(top, right)),
    borderBottomStartRadius: inner(base.borderBottomStartRadius, Math.max(bottom, left)),
    borderBottomEndRadius: inner(base.borderBottomEndRadius, Math.max(bottom, right)),
    borderCurve: base.borderCurve,
  };
}

type Measurable = { measure?: (callback: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) => void };

function FeedbackActionPressable({ children, style, disabled, onPress, onPressIn, onPressOut, primary = false, feedbackStyle, ink: inked, ripple: tone, underlay, ref, ...props }: Props & UnderlayProps & { ink: boolean }) {
  const { colors, mode, financialPreference } = useAppearance();
  const reduced = useReducedMotion();
  const ink = useInkRipple(reduced);
  const target = useRef<View | null>(null);
  const pending = useRef<{ released: boolean } | null>(null);
  const showPrimary = primary && !isBlocked(disabled, props);
  const surfaceStyle: PressableProps['style'] = showPrimary
    ? typeof style === 'function'
      ? (state: Parameters<typeof style>[0]) => [style(state), styles.primary]
      : [style, styles.primary]
    : style;
  const enabled = !isBlocked(disabled, props) && !!onPress;
  useInkReleaseWhileBlocked(ink, enabled);
  // Rows may contain other touchables, so native touch coordinates can belong
  // to a child; the row's own page offset gives the location inside it.
  const startInk = (event: GestureResponderEvent) => {
    const { pageX, pageY, locationX, locationY } = event?.nativeEvent ?? {};
    const node = target.current as unknown as Measurable | null;
    pending.current = null;
    // A compact feedback surface inks from its center; web reports the
    // location relative to this target already.
    if (feedbackStyle || Platform.OS === 'web' || typeof pageX !== 'number' || !node?.measure) {
      ink.press(feedbackStyle ? undefined : locationX, feedbackStyle ? undefined : locationY);
      return;
    }
    const token = { released: false };
    pending.current = token;
    node.measure((_x, _y, _width, _height, left, top) => {
      if (pending.current !== token) return;
      pending.current = null;
      ink.press(pageX - left, pageY - top);
      // Released before the measurement arrived: the ink still shows briefly.
      if (token.released) ink.release();
    });
  };
  const setRef = (node: View | null) => {
    target.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };

  return (
    <Pressable {...props} ref={setRef} style={surfaceStyle} disabled={disabled} onPress={onPress}
      onPressIn={(event) => { if (inked) startInk(event); onPressIn?.(event); }}
      onPressOut={(event) => {
        if (inked) {
          if (pending.current) pending.current.released = true;
          ink.release();
        }
        onPressOut?.(event);
      }}>
      {(state) => {
        const base = StyleSheet.flatten(feedbackStyle ?? (typeof surfaceStyle === 'function' ? surfaceStyle(state) : surfaceStyle)) ?? {};
        const color = processColor(resolveSemanticColor(base.backgroundColor, colors, mode, financialPreference) ?? colors.screen);
        const surface = typeof color === 'number' ? color : null;
        // Copy only the clip shape; never clip the root's border/shadow/content.
        // A fill lies inside the root's border; a compact surface is its own box.
        const shape = clipShape(base, !feedbackStyle);
        // The ink takes only the compact surface's geometry; its paint stays below.
        const layer = feedbackStyle ? [styles.target, shape, feedbackStyle, styles.unpainted] : [styles.clip, shape];
        const palette = getFeedbackPalette(surface);
        const ripple = getRipplePalette(surface, tone);
        return (
          <>
            {underlay}
            {showPrimary ? <PrimaryButtonBackground shape={shape} /> : null}
            {inked ? <InkRippleLayer ripple={ink} color={ripple.rippleColor} opacity={ripple.rippleOpacity} style={layer} /> : null}
            {enabled && !inked ? (
              <View
                pointerEvents="none"
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[
                  feedbackStyle ? styles.target : styles.clip,
                  shape,
                  feedbackStyle,
                  {
                    backgroundColor: palette.washColor,
                    // Pressable owns cancel, release, keyboard input and accessibility activation.
                    opacity: state.pressed ? palette.washOpacity : 0,
                  },
                ]}
              />
            ) : null}
            {typeof children === 'function' ? children(state) : children}
          </>
        );
      }}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  buttonSurface: { alignSelf: 'stretch', flexGrow: 1 },
  primary: { backgroundColor: primaryGradient.colors[0] },
  clip: { ...StyleSheet.absoluteFillObject, overflow: 'hidden' },
  target: { position: 'absolute', overflow: 'hidden' },
  unpainted: { backgroundColor: 'transparent', borderWidth: 0, shadowOpacity: 0, elevation: 0 },
});
