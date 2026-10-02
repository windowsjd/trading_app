import React, { useEffect, useRef, useState } from 'react';
import { RefreshControl } from '../theme/native';
import { useAppearance } from '../theme/appearance';

type RefreshQuery = {
  isFetching: boolean;
  refetch: (options?: { cancelRefetch?: boolean }) => Promise<unknown>;
  enabled?: boolean;
};

/** The outer vertical scroll owns the native top-only pull/threshold gesture.
 * Capture this render's queries so a late response stays in its original scope. */
export function usePullToRefresh(queries: RefreshQuery[], beforeRefresh?: () => void, afterRefresh?: () => void) {
  const { colors } = useAppearance();
  const [refreshing, setRefreshing] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const active = queries.filter((query) => query.enabled !== false);
  const onRefresh = async () => {
    if (locked.current || !active.length || active.some((query) => query.isFetching)) return;
    locked.current = true;
    setRefreshing(true);
    try {
      beforeRefresh?.();
      await Promise.allSettled(active.map((query) => query.refetch({ cancelRefetch: false })));
    } finally {
      afterRefresh?.();
      locked.current = false;
      if (mounted.current) setRefreshing(false);
    }
  };
  return {
    refreshing,
    onRefresh,
    refreshControl: <RefreshControl refreshing={refreshing} onRefresh={() => { void onRefresh(); }}
      enabled={active.length > 0} tintColor={colors.text} colors={[colors.text]}
      progressBackgroundColor={colors.surface} />,
  };
}
