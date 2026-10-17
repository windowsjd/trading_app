import React, { createContext, useContext, useLayoutEffect, useState, useSyncExternalStore } from 'react';

/**
 * The stock order card's right column (A-2) shows two parts that belong to
 * other components: the current holding (owned by AccountHoldings: its query,
 * 손절가/익절가 sheet and guide facts) and the expected order (owned by the
 * keyed order form: its inputs, quote and wallet reads). Each owner keeps its
 * state and draws its part into a named slot here, so the part always comes
 * from the same render as the inputs it describes.
 *
 * Like SheetPortal, but the slot is a leaf: filling it re-renders only the
 * slot, never the owners. Without a provider (tests, other screens) the part
 * renders in place.
 */
export type OrderAsideSlotName = 'holding' | 'preview';

type Store = {
  get: (name: OrderAsideSlotName) => React.ReactNode | undefined;
  set: (name: OrderAsideSlotName, node: React.ReactNode | undefined) => void;
  subscribe: (listener: () => void) => () => void;
};

function createStore(): Store {
  const slots = new Map<OrderAsideSlotName, React.ReactNode>();
  const listeners = new Set<() => void>();
  return {
    get: (name) => slots.get(name),
    set: (name, node) => {
      if (slots.get(name) === node) return;
      if (node === undefined) slots.delete(name);
      else slots.set(name, node);
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const OrderAsideContext = createContext<Store | null>(null);
const noSubscription = () => () => {};

export function OrderAsideProvider({ children }: { children: React.ReactNode }) {
  const [store] = useState(createStore);
  return <OrderAsideContext.Provider value={store}>{children}</OrderAsideContext.Provider>;
}

/** Where a slot's part is drawn. */
export function OrderAsideSlot({ name }: { name: OrderAsideSlotName }) {
  const store = useContext(OrderAsideContext);
  const node = useSyncExternalStore(store?.subscribe ?? noSubscription, () => store?.get(name));
  return <>{node ?? null}</>;
}

/** Draws `children` in the slot (before paint), or in place without a provider. */
export function OrderAsidePortal({ name, children }: { name: OrderAsideSlotName; children: React.ReactNode }) {
  const store = useContext(OrderAsideContext);
  useLayoutEffect(() => {
    store?.set(name, children);
  });
  // The owner unmounting (another side, asset, account or method) empties the
  // slot: no part outlives the state it was drawn from.
  useLayoutEffect(() => () => store?.set(name, undefined), [store, name]);
  return store ? null : <>{children}</>;
}

/** Whether this screen draws the A-2 right column (a provider is mounted). */
export function useOrderAsideAvailable() {
  return useContext(OrderAsideContext) !== null;
}
