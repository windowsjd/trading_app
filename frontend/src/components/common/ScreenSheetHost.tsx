import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
// Core's context is the one @react-navigation/native re-exports; core itself is plain JS.
import { NavigationContext } from '@react-navigation/core';
import { View } from '../../theme/native';

type SetSheet = (key: number, node: React.ReactNode | null) => void;
const SheetHostContext = createContext<SetSheet | null>(null);
let nextPortalKey = 0;

/**
 * A layer above the tab screens (their native headers and the tab bar) but
 * below the beginner quest overlay, which MainTabs renders after it. A screen
 * presents a bottom sheet here so the sheet covers the whole app area while
 * the quest spotlight can still point into it.
 *
 * Inactive tabs stay mounted, so several portals (Wallet's 이체, the order
 * screen's 주문방식) can be alive at once: each owns its own keyed slot.
 */
export function ScreenSheetHost({ children }: { children: React.ReactNode }) {
  const [sheets, setSheets] = useState<ReadonlyMap<number, React.ReactNode>>(() => new Map());
  const setSheet = useCallback<SetSheet>((key, node) => setSheets((previous) => {
    if (node === null) {
      if (!previous.has(key)) return previous;
      const next = new Map(previous);
      next.delete(key);
      return next;
    }
    if (previous.get(key) === node) return previous;
    return new Map(previous).set(key, node);
  }), []);
  return (
    <SheetHostContext.Provider value={setSheet}>
      <View style={styles.host}>
        {children}
        {sheets.size ? (
          <View pointerEvents="box-none" style={styles.layer}>
            {[...sheets].map(([key, node]) => <React.Fragment key={key}>{node}</React.Fragment>)}
          </View>
        ) : null}
      </View>
    </SheetHostContext.Provider>
  );
}

type FocusSource = {
  isFocused?: () => boolean;
  addListener?: (type: 'focus' | 'blur', listener: () => void) => () => void;
};

/**
 * Whether the screen this renders in is the one on screen: false while
 * another tab or a screen pushed over it covers it. Outside a screen (MainTabs'
 * own update notice) it is always true. `useIsFocused` without its throw.
 */
export function useOwnerScreenFocused(): boolean {
  const navigation = useContext(NavigationContext) as FocusSource | undefined;
  const [focused, setFocused] = useState(() => navigation?.isFocused?.() ?? true);
  useEffect(() => {
    if (!navigation?.addListener) return undefined;
    setFocused(navigation.isFocused?.() ?? true);
    const offFocus = navigation.addListener('focus', () => setFocused(true));
    const offBlur = navigation.addListener('blur', () => setFocused(false));
    return () => {
      offFocus();
      offBlur();
    };
  }, [navigation]);
  return focused;
}

const SheetOwnerFocusContext = createContext(true);

/** Inside a sheet: whether the screen that opened it is on screen (see SheetPortal). */
export function useSheetOwnerFocused(): boolean {
  return useContext(SheetOwnerFocusContext);
}

/**
 * Renders its children in the nearest host (or in place without one). The
 * children keep their state across the owner's re-renders; they must not rely
 * on screen-only context such as the header height.
 *
 * The host lies over every tab, so the children also learn whether their
 * screen is on screen (2026-11-06): a sheet left open when a banner or push
 * tap moved to another tab or screen stayed drawn over that screen, its dim
 * swallowing every touch and its Back listener taking the next Back.
 */
export function SheetPortal({ children }: { children: React.ReactNode }) {
  const setSheet = useContext(SheetHostContext);
  const focused = useOwnerScreenFocused();
  const key = useRef(0);
  if (!key.current) key.current = ++nextPortalKey;
  const node = <SheetOwnerFocusContext.Provider value={focused}>{children}</SheetOwnerFocusContext.Provider>;
  useEffect(() => {
    setSheet?.(key.current, node);
  });
  useEffect(() => () => setSheet?.(key.current, null), [setSheet]);
  return setSheet ? null : node;
}

// Plain objects: this host wraps the navigator and needs nothing native.
const styles = {
  host: { flex: 1 },
  layer: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
} as const;
