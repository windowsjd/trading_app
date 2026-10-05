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
  // All ranking list shapes include identity, as does this user's summary.
  // Friends DTOs exclude the viewer; records list/detail contain no avatar.
  void client.invalidateQueries({ queryKey: ['ranking', 'list'] });
  void client.invalidateQueries({ queryKey: QUERY_KEYS.ranking.userSeasonSummary(me.id), exact: true });
}
