import type { FilledOrderFacts, FillOrigin } from './fillTracker';

/**
 * Hand-off from order screens to the app-wide fill notifier, which is not
 * their ancestor. Events carry their own accountId; the notifier ignores any
 * account the current session does not watch.
 *
 * - `order`: an order this screen just submitted and that is still open
 *   (limit/LOC), so its later fill is found even before the next list read.
 * - `watch`: a Conditional BUY watch just registered.
 * - `filled`: a confirmed immediate execution whose detailed result could not
 *   be shown (the submitting form was gone). A result the user is looking at
 *   in the order result sheet is not repeated as a banner.
 */
export type OrderFillEvent =
  | { kind: 'order'; accountId: string; orderId: string; origin?: FillOrigin }
  | { kind: 'watch'; accountId: string; watchId: string }
  | { kind: 'filled'; accountId: string; order: FilledOrderFacts };

type Listener = (event: OrderFillEvent) => void;
const listeners = new Set<Listener>();

export function emitOrderFillEvent(event: OrderFillEvent) {
  listeners.forEach((listener) => listener(event));
}

export function subscribeOrderFillEvents(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
