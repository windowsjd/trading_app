import React, { useEffect, useRef } from 'react';
import { useNavigationState, type ParamListBase, type RouteProp } from '@react-navigation/native';
import ScreenErrorBoundary, { type ErrorBack } from '../../components/states/ScreenErrorBoundary';
import { Animated, Platform, useWindowDimensions } from '../../theme/native';
import { webPushMotion } from './transitionPolicy';

type LayoutProps = { children: React.ReactElement; route: RouteProp<ParamListBase>; navigation: ErrorBack };

/**
 * Native stacks animate push/pop themselves. The web native-stack swaps screens
 * without motion, so on web the screen that becomes the top of its stack eases
 * in with the same direction cue: from the right on push, from the left on back.
 */
export function stackScreenLayout({ children, route, navigation }: LayoutProps): React.ReactElement {
  // A render failure stays inside its own screen: the tabs and the stack around it remain, and
  // the error offers the screen before it — retrying a failure the screen's state keeps
  // reproducing would otherwise be the only way out (the root boundary replaces every tab).
  const guarded = <ScreenErrorBoundary back={navigation}>{children}</ScreenErrorBoundary>;
  return Platform.OS === 'web' ? <WebPushLayout routeKey={route.key}>{guarded}</WebPushLayout> : guarded;
}

// Read at the moment of the transition: the shared hook starts as "reduced"
// until its effect resolves, which would hide the first push.
function prefersReducedMotion() {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
}

function WebPushLayout({ routeKey, children }: { routeKey: string; children: React.ReactElement }) {
  const { width } = useWindowDimensions();
  const top = useNavigationState(state => state.routes[state.index]?.key === routeKey);
  const root = useNavigationState(state => state.routes[0]?.key === routeKey);
  const shift = useRef(new Animated.Value(0)).current;
  const seen = useRef(false);
  const rootRef = useRef(root);
  rootRef.current = root;

  useEffect(() => {
    if (!top) return;
    const returning = seen.current;
    seen.current = true;
    // A stack's first screen appears with its tab; only real push/back move.
    if ((!returning && rootRef.current) || prefersReducedMotion()) {
      shift.setValue(0);
      return;
    }
    shift.setValue(returning ? -1 : 1);
    const animation = Animated.timing(shift, {
      toValue: 0,
      duration: webPushMotion.duration,
      easing: easeOutCubic,
      useNativeDriver: false,
      isInteraction: false,
    });
    animation.start();
    return () => animation.stop();
  }, [shift, top]);

  const distance = Math.min(width * webPushMotion.widthShare, webPushMotion.maxDistance);
  return (
    <Animated.View style={[styles.fill, {
      opacity: shift.interpolate({ inputRange: [-1, 0, 1], outputRange: [webPushMotion.backOpacity, 1, webPushMotion.pushOpacity] }),
      transform: [{ translateX: shift.interpolate({ inputRange: [-1, 0, 1], outputRange: [-distance * webPushMotion.backShare, 0, distance] }) }],
    }]}>
      {children}
    </Animated.View>
  );
}

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
// A plain object: this wrapper sits around every web stack screen.
const styles = { fill: { flex: 1 } } as const;
