import { useEffect, useState } from 'react';
import {
  TRIGGER_DIRECTION_CHANGED,
  getTriggerDirectionText,
  isTriggerDirectionValid,
  resolveTriggerDirection,
  type TriggerCondition,
  type TriggerDirection,
} from './autoDirection';

/**
 * The automatic 이상/이하 of one watch price input. The direction is decided
 * once per entered price, against the reference price at that moment, and
 * kept while only the market moves; `recheck` compares it with the latest
 * price right before sending and, when it no longer holds, re-decides it and
 * returns the message that asks the user to confirm again (nothing is sent).
 * A `.tsx` module so test harnesses load it with their React mocks.
 */
export function useTriggerDirection(triggerPrice: string, reference: string | null | undefined) {
  const key = triggerPrice.trim();
  const [decided, setDecided] = useState<{ key: string; condition: TriggerCondition } | null>(null);
  const stored = decided && decided.key === key ? decided : null;
  const live = resolveTriggerDirection(triggerPrice, reference);
  const liveCondition = live.state === 'ready' ? live.condition : null;
  useEffect(() => {
    if (!stored && liveCondition) setDecided({ key, condition: liveCondition });
  }, [key, stored, liveCondition]);
  const direction: TriggerDirection = stored ? { state: 'ready', condition: stored.condition } : live;
  return {
    direction,
    condition: direction.state === 'ready' ? direction.condition : null,
    /** Null when the decided direction still holds; otherwise the confirm-again message. */
    recheck(latest: string | null | undefined): string | null {
      if (direction.state === 'ready' && isTriggerDirectionValid(direction.condition, triggerPrice, latest)) return null;
      const next = resolveTriggerDirection(triggerPrice, latest);
      setDecided(next.state === 'ready' ? { key, condition: next.condition } : null);
      return next.state === 'ready' ? TRIGGER_DIRECTION_CHANGED : getTriggerDirectionText(next, triggerPrice, '') ?? TRIGGER_DIRECTION_CHANGED;
    },
    /** After the server found the condition already met: decide again from the latest price. */
    reset() {
      setDecided(null);
    },
  };
}
