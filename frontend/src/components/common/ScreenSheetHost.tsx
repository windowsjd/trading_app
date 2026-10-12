import React, { createContext, useContext, useEffect, useState } from 'react';
import { View } from '../../theme/native';

type SetSheet = (node: React.ReactNode) => void;
const SheetHostContext = createContext<SetSheet | null>(null);

/**
 * A layer above the tab screens (their native headers and the tab bar) but
 * below the beginner quest overlay, which MainTabs renders after it. A screen
 * presents a bottom sheet here so the sheet covers the whole app area while
 * the quest spotlight can still point into it.
 */
export function ScreenSheetHost({ children }: { children: React.ReactNode }) {
  const [sheet, setSheet] = useState<React.ReactNode>(null);
  return (
    <SheetHostContext.Provider value={setSheet}>
      <View style={styles.host}>
        {children}
        {sheet ? <View pointerEvents="box-none" style={styles.layer}>{sheet}</View> : null}
      </View>
    </SheetHostContext.Provider>
  );
}

/**
 * Renders its children in the nearest host (or in place without one). The
 * children keep their state across the owner's re-renders; they must not rely
 * on screen-only context such as the header height. The host has one slot
 * (today only Wallet's 이체 sheet): a second portal would need keyed slots.
 */
export function SheetPortal({ children }: { children: React.ReactNode }) {
  const setSheet = useContext(SheetHostContext);
  useEffect(() => {
    setSheet?.(children);
  });
  useEffect(() => () => setSheet?.(null), [setSheet]);
  return setSheet ? null : <>{children}</>;
}

// Plain objects: this host wraps the navigator and needs nothing native.
const styles = {
  host: { flex: 1 },
  layer: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
} as const;
