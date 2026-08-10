import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { QUERY_KEYS } from '../../constants/queryKeys';
import { getApiErrorDisplayMessage } from '../../services/api/errorMapper';
import { openGeneralAccount, type TradingAccountDto } from './api';
import { completeGeneralAccountOpen } from './generalAccountOpen';
import { useTradingAccount } from './TradingAccountContext';

/**
 * THE way a screen opens the user's general account (작업 13 §3.1 · §7).
 *
 * The mode-selection screen, the account switcher, and the setup panel all
 * offer "일반 투자 시작하기"; this hook is the one implementation behind all
 * three, so the rules cannot drift between them:
 *
 *   - the POST fires only from `start()` — an explicit press, never a mount;
 *   - `start()` is a no-op while a request is in flight, so a double tap is
 *     one request even before the button's disabled state kicks in (the server
 *     is idempotent besides — belt and braces);
 *   - after success the list is refetched, the RETURNED account is selected,
 *     and only then does the caller's `onOpened` run — the ordering lives in
 *     `completeGeneralAccountOpen`;
 *   - `isPending` stays true through that whole tail (react-query awaits the
 *      onSuccess callback), so the button cannot re-enable between "created"
 *      and "selected".
 *
 * A failure surfaces as a display message and changes nothing else: no
 * selection is made, the caller's screen stays where it was, and every other
 * option on it (season continue, season join) remains usable.
 */
export function useOpenGeneralAccount(options?: {
  onOpened?: (account: TradingAccountDto) => void;
}) {
  const queryClient = useQueryClient();
  const { selectAccount } = useTradingAccount();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const onOpened = options?.onOpened;

  const mutation = useMutation({
    mutationFn: openGeneralAccount,
    onSuccess: (result) =>
      completeGeneralAccountOpen(result, {
        refreshOwnedAccounts: () =>
          queryClient.invalidateQueries({
            queryKey: QUERY_KEYS.tradingAccount.listAll,
          }),
        selectAccount,
        onOpened,
      }),
    onError: (error: unknown) => {
      setErrorMessage(getApiErrorDisplayMessage(error));
    },
  });

  const { mutate, isPending } = mutation;

  const start = useCallback(() => {
    if (isPending) return;
    setErrorMessage(null);
    mutate();
  }, [isPending, mutate]);

  return { start, isPending, errorMessage };
}
