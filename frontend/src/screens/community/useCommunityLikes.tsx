import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { setCommunityPostLike, type CommunityPostDto } from '../../features/community/api';
import { patchCommunityPost } from '../../features/community/communityCache';
import { withLike } from '../../features/community/listUtils';
import type { useCommunityWrite } from './useCommunityWrite';

type CommunityWrite = ReturnType<typeof useCommunityWrite>;

/**
 * A post's like, shown at once and confirmed by the server: the server's
 * count replaces the guess, a failure puts the previous state back. One
 * request per post at a time; a tap while one is in flight is ignored. A
 * like needs the write gate (rules, restriction); taking a like back never does.
 */
export function useCommunityPostLike(userId: string | null, write: CommunityWrite, onError: (error: unknown) => void) {
  const client = useQueryClient();
  const busy = useRef(new Set<string>());
  const [, setRevision] = useState(0);
  const toggle = useCallback((post: CommunityPostDto) => {
    if (!userId || post.mine || busy.current.has(post.id)) return;
    const liked = !post.likedByMe;
    const run = () => {
      if (busy.current.has(post.id)) return;
      busy.current.add(post.id);
      setRevision((value) => value + 1);
      patchCommunityPost(client, userId, post.id, (current) => withLike(current, liked));
      setCommunityPostLike(post.id, liked)
        .then(({ likeCount }) => patchCommunityPost(client, userId, post.id, (current) => ({ ...current, likedByMe: liked, likeCount })))
        .catch((error: unknown) => {
          patchCommunityPost(client, userId, post.id, (current) => withLike(current, !liked));
          write.handleWriteError(error);
          onError(error);
        })
        .finally(() => {
          busy.current.delete(post.id);
          setRevision((value) => value + 1);
        });
    };
    if (liked) write.requireWrite(run);
    else run();
  }, [client, onError, userId, write]);
  return { toggle, isBusy: (postId: string) => busy.current.has(postId) };
}
