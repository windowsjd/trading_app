import type { QueryClient } from '@tanstack/react-query';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { isCurrentSession } from '../../services/api/sessionOwnership';
import type { MeDto } from './api';

export async function applyProfileImageResponse(client: QueryClient, me: MeDto, owner: number) {
  if (!isCurrentSession(owner) || client.getQueryData<MeDto>(QUERY_KEYS.me)?.id !== me.id) return;
  await client.cancelQueries({ queryKey: QUERY_KEYS.me, exact: true });
  if (!isCurrentSession(owner)) return;
  // Apply only the field this mutation owns; a late response cannot undo a
  // concurrent nickname/privacy save or repopulate a logged-out user's cache.
  client.setQueryData<MeDto>(QUERY_KEYS.me, (current) =>
    current?.id === me.id ? { ...current, profileImageUrl: me.profileImageUrl } : current,
  );
  if (client.getQueryData<MeDto>(QUERY_KEYS.me)?.id !== me.id) return;
  invalidateIdentityViews(client, me.id);
}

/**
 * Re-read what shows this user's photo or nickname besides /me: every ranking
 * list shape and the user's own season summary (friends DTOs exclude the
 * viewer; records list/detail carry no identity). A ranking entry with nothing
 * shown yet (a failed read) is left alone: re-reading it only puts it back to
 * loading, and on MY (whose own rank is such an entry) that is the whole
 * screen's loader, which would drop the profile editor mid-edit.
 */
export function invalidateIdentityViews(client: QueryClient, userId: string) {
  void client.invalidateQueries({ queryKey: ['ranking', 'list'], predicate: (query) => query.state.data !== undefined });
  void client.invalidateQueries({ queryKey: QUERY_KEYS.ranking.userSeasonSummary(userId), exact: true });
}
