import type { QueryClient } from '@tanstack/react-query';
import { QUERY_KEYS } from '../../constants/queryKeys';
import type { FriendAction } from './api';
export async function refreshFriendship(
  client: QueryClient,
  change: FriendAction,
) {
  const updates: Promise<unknown>[] = [
    client.invalidateQueries({ queryKey: QUERY_KEYS.friends.all }),
  ];
  if (change.action === 'accept' || change.action === 'remove') {
    const summary = QUERY_KEYS.ranking.userSeasonSummary(change.user.userId);
    await client.cancelQueries({ queryKey: summary, exact: true });
    updates.push(client.resetQueries({ queryKey: summary, exact: true }));
    updates.push(
      client.resetQueries({
        predicate: (query) =>
          query.queryKey[0] === 'ranking' &&
          query.queryKey[1] === 'list' &&
          query.queryKey[3] === 'friends',
      }),
    );
  }
  await Promise.all(updates);
}
