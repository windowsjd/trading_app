import { useEffect } from 'react';
import { getQuestGuideFacts, publishQuestGuideFacts, type TradeGuideFacts } from './questGuideBridge';
/** Each actual screen owns and cleans up its own facts. */
export function useTradingGuideFacts(facts: TradeGuideFacts, enabled = true) {
  const serialized = JSON.stringify(facts);
  const screen = facts.screen;
  useEffect(() => {
    if (!enabled) return;
    const value = JSON.parse(serialized) as TradeGuideFacts;
    publishQuestGuideFacts(screen, value);
    return () => { if (getQuestGuideFacts(screen) === value) publishQuestGuideFacts(screen, null); };
  }, [screen, serialized, enabled]);
}
