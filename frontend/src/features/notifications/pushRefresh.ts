import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import {
  invalidateAfterOrderCreate,
  type InvalidatorClient,
} from '../tradingAccount/invalidation.ts';
import type { PushIntent } from './pushIntent.ts';

/**
 * A push received while the app is in the foreground shows no OS banner and
 * opens nothing. It refreshes only the cached reads the event changed, so the
 * screen on display (and the existing in-app fill banner, which reads the
 * same order lists) catches up immediately.
 */
export function refreshForPush(
  client: InvalidatorClient,
  intent: PushIntent,
  options: { seasonUi: boolean },
) {
  const invalidate = (queryKey: readonly unknown[]) => client.invalidateQueries({ queryKey });
  switch (intent.kind) {
    case 'trade_history':
      if (intent.market === 'spot') {
        void invalidateAfterOrderCreate(client, intent.accountId, options);
        return;
      }
      invalidate(QUERY_KEYS.tradingAccount.futures.all(intent.accountId));
      invalidate(QUERY_KEYS.tradingAccount.walletsAll(intent.accountId));
      invalidate(QUERY_KEYS.tradingAccount.portfolioAll(intent.accountId));
      if (options.seasonUi) {
        invalidate(QUERY_KEYS.record.all);
        invalidate(QUERY_KEYS.ranking.all);
      }
      return;
    case 'order_failure':
      // The ended lists of the order/futures screens hold the row; the
      // failure lookup itself is read on open.
      invalidate(QUERY_KEYS.tradingAccount.entryTpSl.all(intent.accountId));
      if (intent.market === 'spot') {
        void invalidateAfterOrderCreate(client, intent.accountId, options);
        return;
      }
      invalidate(QUERY_KEYS.tradingAccount.futures.all(intent.accountId));
      return;
    case 'friend_requests':
      invalidate(QUERY_KEYS.friends.all);
      return;
    case 'notice':
      invalidate(QUERY_KEYS.notices.important);
      return;
    case 'season_record':
      invalidate(QUERY_KEYS.record.all);
      invalidate(QUERY_KEYS.season.current);
      return;
  }
}
