import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { resetToHome } from '../../app/navigation/seasonRouting';
import { isCurrentSession } from '../../services/api/sessionOwnership';
import { beginGuestBrowsing } from './session';

/**
 * The login screen's 「로그인 없이 둘러보기」 (2026-10-30): end the pre-login
 * session, then open the main tabs as a guest. One entry per tap burst;
 * `pending` lets the screen hold its sign-in buttons meanwhile.
 */
export function useBrowseAsGuest() {
  const rootNavigation = useRootNavigation();
  const queryClient = useQueryClient();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);

  const start = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const owner = await beginGuestBrowsing(queryClient);
      // A sign-in begun meanwhile owns the session and the next screen.
      if (isCurrentSession(owner)) resetToHome(rootNavigation);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, [queryClient, rootNavigation]);

  return { pending, start };
}
