import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { AppState } from '../../theme/native';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { rootNavigationRef } from '../../app/navigation/navigationRef';
import { questNavigationAllowed } from '../quest/questNavigationGuard';
import { useTradingAccount } from '../tradingAccount/TradingAccountContext';
import type { MeDto } from '../me/api';
import { nativePush, type ReceivedPush } from './nativePush';
import { registerPushDevice, releasePushDevice } from './api';
import { bootstrapNotificationPermission, toDevicePermission } from './pushPermission';
import { createPushRegistrar } from './pushRegistration';
import { intentGuardName, parsePushData, resolvePushIntent, type PushIntent } from './pushIntent';
import { refreshForPush } from './pushRefresh';
import { emitOrderFillEvent } from '../order/fillEvents';

/** Root routes that are only reachable after sign-in and the mode choice. */
const MAIN_ROUTES = new Set(['MainTabs', 'TradeHistory', 'OrderFailure', 'AssetChart']);

/**
 * Push notifications (backend docs/push-notifications-contract.md), mounted
 * once beside the root navigator like the in-app fill banner:
 *
 * 1. First launch, before sign-in: create the Android channel, then ask the
 *    OS once if it has not decided yet. A denial blocks nothing.
 * 2. Server registration follows the session: register after sign-in or
 *    restore, release on logout/expiry or when the OS permission is off.
 * 3. In the foreground the OS banner is suppressed; the push only refreshes
 *    the reads it changed (the fill banner keeps announcing Spot fills). A
 *    Futures liquidation, which no in-app watcher sees, is handed to that
 *    same banner queue, once per liquidation event.
 * 4. A tap is applied after sign-in and the mode choice, only for the user it
 *    was sent to and only to an account that user owns.
 * Draws nothing. Web has no push and renders nothing.
 */
export default function PushNotificationsHost() {
  return nativePush.supported ? <NativePushHost /> : null;
}

function useSessionUserId(queryClient: QueryClient): string | null {
  const subscribe = useCallback(
    (notify: () => void) =>
      queryClient.getQueryCache().subscribe((event) => {
        const key = event.query.queryKey;
        if (key.length === 1 && key[0] === QUERY_KEYS.me[0]) notify();
      }),
    [queryClient],
  );
  const read = useCallback(
    () => queryClient.getQueryData<MeDto>(QUERY_KEYS.me)?.id ?? null,
    [queryClient],
  );
  return useSyncExternalStore(subscribe, read, read);
}

function currentRootRoute(): string | null {
  if (!rootNavigationRef.isReady()) return null;
  const state = rootNavigationRef.getRootState();
  return state?.routes[state.index]?.name ?? null;
}

function useRootRouteName(): string | null {
  const [name, setName] = useState<string | null>(currentRootRoute);
  useEffect(() => {
    const update = () => setName(currentRootRoute());
    update();
    return rootNavigationRef.addListener('state', update);
  }, []);
  return name;
}

/** `pushAt` differs per tap, so an already open screen selects the pushed
 * view again even when the rest of the params are the same. */
function navigateTo(intent: PushIntent, pushAt: number) {
  switch (intent.kind) {
    case 'trade_history':
      rootNavigationRef.navigate('TradeHistory', {
        accountId: intent.accountId,
        market: intent.market,
        ...(intent.futuresView ? { futuresView: intent.futuresView } : {}),
        pushAt,
      });
      return;
    case 'order_failure':
      rootNavigationRef.navigate('OrderFailure', {
        accountId: intent.accountId,
        kind: intent.failureKind,
        failureId: intent.failureId,
        pushAt,
      });
      return;
    case 'friend_requests':
      rootNavigationRef.navigate('MainTabs', {
        screen: 'MyTab',
        params: { screen: 'Friends', initial: false, params: { tab: 'requests', pushAt } },
      });
      return;
    case 'notice':
      rootNavigationRef.navigate('MainTabs', {
        screen: 'MyTab',
        params: { screen: 'Notices', initial: false, params: { noticeId: intent.noticeId, pushAt } },
      });
      return;
    case 'season_record':
      rootNavigationRef.navigate('MainTabs', {
        screen: 'MyTab',
        params: {
          screen: 'Record',
          initial: false,
          params: { screen: 'RecordSeasonDetail', initial: false, params: { seasonId: intent.seasonId } },
        },
      });
      return;
  }
}

function NativePushHost() {
  const queryClient = useQueryClient();
  const userId = useSessionUserId(queryClient);
  const rootRoute = useRootRouteName();
  const { accounts, isLoading: accountsLoading, selectedAccount } = useTradingAccount();
  const [permissionReady, setPermissionReady] = useState(false);
  const [wake, setWake] = useState(0);
  const pending = useRef<{ intent: PushIntent; receivedAt: number } | null>(null);
  const handled = useRef(new Set<string>());
  const latest = useRef({ userId, accounts });
  useEffect(() => {
    latest.current = { userId, accounts };
  }, [userId, accounts]);

  const registrar = useMemo(
    () =>
      createPushRegistrar({
        supported: nativePush.supported,
        platform: nativePush.platform,
        isPermissionGranted: async () =>
          toDevicePermission(await nativePush.getPermission()) === 'granted',
        getToken: () => nativePush.getToken(),
        register: registerPushDevice,
        release: releasePushDevice,
        readStoredToken: () => nativePush.readStoredToken(),
        writeStoredToken: (token) => nativePush.writeStoredToken(token),
        now: () => Date.now(),
      }),
    [],
  );

  // 1. Before any sign-in: foreground presentation and the first-launch prompt.
  useEffect(() => {
    nativePush.suppressForegroundPresentation();
    let mounted = true;
    void bootstrapNotificationPermission({
      ensureChannel: () => nativePush.ensureChannel(),
      getPermission: () => nativePush.getPermission(),
      requestPermission: () => nativePush.requestPermission(),
      readRequested: () => nativePush.readPermissionRequested(),
      writeRequested: () => nativePush.writePermissionRequested(),
      clearRequested: () => nativePush.clearPermissionRequested(),
    }).finally(() => {
      if (mounted) setPermissionReady(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // 2. Taps (including the one that launched the app), foreground pushes,
  // token rotation and returns from the OS settings.
  useEffect(() => {
    const accept = (push: ReceivedPush) => {
      if (handled.current.has(push.identifier)) return;
      handled.current.add(push.identifier);
      const intent = parsePushData(push.data);
      if (!intent) return;
      pending.current = { intent, receivedAt: Date.now() };
      setWake((value) => value + 1);
    };
    const launch = nativePush.takeLaunchTap();
    if (launch) accept(launch);
    const tapped = nativePush.onTapped(accept);
    const received = nativePush.onReceived((push) => {
      const intent = parsePushData(push.data);
      const current = latest.current;
      if (!intent || !current.userId || intent.uid !== current.userId) return;
      if (intent.kind !== 'trade_history' && intent.kind !== 'order_failure')
        return refreshForPush(queryClient, intent, { seasonUi: false });
      const account = current.accounts.find((item) => item.id === intent.accountId);
      if (!account) return;
      refreshForPush(queryClient, intent, { seasonUi: account.mode === 'season' });
      if (intent.kind === 'trade_history' && intent.type === 'futures_liquidation' && intent.liquidationId)
        emitOrderFillEvent({
          kind: 'liquidation',
          accountId: intent.accountId,
          liquidationId: intent.liquidationId,
          title: push.title?.trim() || '선물 강제청산',
          detail: push.body?.trim() || null,
        });
    });
    const token = nativePush.onTokenChanged(() => setWake((value) => value + 1));
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') setWake((value) => value + 1);
    });
    return () => {
      tapped.remove();
      received.remove();
      token.remove();
      appState.remove();
    };
  }, [queryClient]);

  // 3. Server registration. Splash (restoring) is neither signed in nor out.
  const session = userId ? `user:${userId}` : rootRoute === 'AuthStack' ? 'signed_out' : null;
  useEffect(() => {
    if (!permissionReady || !session) return;
    void registrar.reconcile(session === 'signed_out' ? null : { userId: session.slice(5) });
  }, [permissionReady, session, wake, registrar]);

  // 4. A pending tap waits for its user, the main tabs and the account list.
  useEffect(() => {
    const entry = pending.current;
    if (!entry) return;
    const resolution = resolvePushIntent(entry.intent, {
      userId,
      mainReady: !!rootRoute && MAIN_ROUTES.has(rootRoute) && !!selectedAccount,
      ownedAccountIds: accountsLoading ? null : accounts.map((account) => account.id),
      receivedAt: entry.receivedAt,
      now: Date.now(),
    });
    if (resolution.action === 'wait') return;
    pending.current = null;
    if (resolution.action === 'discard') return;
    // A beginner's active quest holds other screens; its guide shows why.
    if (!rootNavigationRef.isReady() || !questNavigationAllowed(intentGuardName(resolution.intent)))
      return;
    navigateTo(resolution.intent, entry.receivedAt);
  }, [wake, userId, rootRoute, selectedAccount, accounts, accountsLoading]);

  return null;
}
