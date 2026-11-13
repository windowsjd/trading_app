import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/** The overlays that may appear on their own after the app is entered. */
export type EntryOverlay = 'appUpdate' | 'notice';

type Slot = {
  owner: EntryOverlay | null;
  claim: (overlay: EntryOverlay) => void;
  release: (overlay: EntryOverlay) => void;
};

const SlotContext = createContext<Slot | null>(null);

/**
 * One entry overlay at a time (2026-11-13): the 업데이트 안내 sheet and the
 * 공지 팝업 never cover each other. The first that is ready takes the slot
 * (two in the same render: the first claim wins); the other waits and shows
 * after the first is closed. Lives in MainTabs, around both.
 */
export function EntryOverlayProvider({ children }: { children: React.ReactNode }) {
  const [owner, setOwner] = useState<EntryOverlay | null>(null);
  const claim = useCallback((overlay: EntryOverlay) => setOwner((current) => current ?? overlay), []);
  const release = useCallback((overlay: EntryOverlay) => setOwner((current) => (current === overlay ? null : current)), []);
  const value = useMemo(() => ({ owner, claim, release }), [owner, claim, release]);
  return <SlotContext.Provider value={value}>{children}</SlotContext.Provider>;
}

/**
 * Whether `overlay` may be on screen now. `wants` is true while it has
 * something to show or is showing it; it releases the slot when that ends or
 * it unmounts. Without a provider (a screen rendered alone) it never waits.
 */
export function useEntryOverlaySlot(overlay: EntryOverlay, wants: boolean): boolean {
  const slot = useContext(SlotContext);
  const owner = slot?.owner ?? null;
  const claim = slot?.claim;
  const release = slot?.release;
  useEffect(() => {
    if (!claim || !release) return;
    if (wants && owner === null) claim(overlay);
    else if (!wants && owner === overlay) release(overlay);
  }, [claim, release, overlay, owner, wants]);
  useEffect(() => () => release?.(overlay), [release, overlay]);
  return slot ? owner === overlay : wants;
}
