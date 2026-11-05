import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Linking, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { QUERY_KEYS } from '../../constants/queryKeys';
import InlineBottomSheet from '../../components/common/InlineBottomSheet';
import { SheetPortal } from '../../components/common/ScreenSheetHost';
import CTAButton from '../../components/common/CTAButton';
import { useQuestGuide } from '../quest/QuestGuideProvider';
import { getAppRelease } from './api';
import { decideAppUpdate, type AppUpdateNotice as Notice, type InstalledApp } from './appUpdate';
import { readInstalledApp } from './installedApp';

/** Shown once per platform and version for the whole app run (a remount does not repeat it). */
const shownThisRun = new Set<string>();

/**
 * 앱 업데이트 안내 after the app's normal entry (inside MainTabs): a newer
 * version the store actually publishes (appUpdate.ts), never forced. It waits
 * while a beginner guide is on screen, and any failure (no manifest, no store
 * app, a read error) simply shows nothing or says so, never blocking the app.
 */
export default function AppUpdateNotice() {
  const guiding = !!useQuestGuide()?.active;
  const [installed, setInstalled] = useState<InstalledApp | null>(null);
  useEffect(() => {
    let alive = true;
    readInstalledApp().then((app) => { if (alive) setInstalled(app); }, () => undefined);
    return () => { alive = false; };
  }, []);
  // Only a store build asks; everything else never reads the manifest.
  const eligible = !!installed?.production && (installed.platform === 'android' || installed.platform === 'ios');
  const release = useQuery({
    queryKey: QUERY_KEYS.appRelease,
    queryFn: ({ signal }) => getAppRelease(signal),
    enabled: eligible,
    staleTime: 30 * 60_000,
    retry: false,
  });
  const notice = useMemo(() => (installed && release.data ? decideAppUpdate(release.data, installed) : null), [installed, release.data]);
  const [open, setOpen] = useState<Notice | null>(null);
  useEffect(() => {
    if (!notice || guiding || shownThisRun.has(notice.key)) return;
    shownThisRun.add(notice.key);
    setOpen(notice);
  }, [guiding, notice]);
  const last = useRef<Notice | null>(null);
  if (open) last.current = open;
  const shown = open ?? last.current;
  const [failed, setFailed] = useState(false);
  const later = () => { setOpen(null); setFailed(false); };
  const update = async () => {
    if (!open) return;
    setFailed(false);
    for (const url of [open.storeUrl, open.webUrl]) {
      try {
        await Linking.openURL(url);
        setOpen(null);
        return;
      } catch {
        // No store app (or no handler): try the store's web page next.
      }
    }
    setFailed(true);
  };
  return (
    <SheetPortal>
      <InlineBottomSheet testID="app-update-sheet" title="업데이트 안내" visible={!!open} onClose={later}>
        {shown ? (
          <View style={styles.body}>
            <Text style={styles.lead}>{shown.store}에 새 버전이 나왔어요. 업데이트하면 최신 기능과 수정 사항을 사용할 수 있어요.</Text>
            <View style={styles.versions}>
              <View style={styles.row} testID="app-update-current">
                <Text style={styles.label}>현재 버전</Text>
                <Text style={styles.value}>{shown.currentVersion}</Text>
              </View>
              <View style={styles.row} testID="app-update-latest">
                <Text style={styles.label}>새 버전</Text>
                <Text style={[styles.value, styles.latest]}>{shown.latestVersion}</Text>
              </View>
            </View>
            {shown.notes ? <Text testID="app-update-notes" style={styles.notes}>{shown.notes}</Text> : null}
            {failed ? (
              <Text testID="app-update-error" accessibilityLiveRegion="polite" style={styles.error}>
                {shown.store}를 열지 못했어요. {shown.store}에서 ‘트레이딩 클래스’를 검색해 업데이트해 주세요.
              </Text>
            ) : null}
            <View style={styles.actions}>
              <CTAButton testID="app-update-later" variant="neutral" label="나중에" style={styles.flex} onPress={later} />
              <CTAButton testID="app-update-open" label="업데이트하기" style={styles.flex} onPress={() => void update()} />
            </View>
          </View>
        ) : null}
      </InlineBottomSheet>
    </SheetPortal>
  );
}

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  body: { gap: 14, paddingTop: 4, paddingBottom: 8 },
  lead: { fontSize: 15, lineHeight: 22, color: semantic.text, flexShrink: 1 },
  versions: { gap: 8, borderWidth: 1, borderColor: semantic.border, borderRadius: 12, padding: 14 },
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 },
  label: { fontSize: 14, lineHeight: 20, color: semantic.secondary },
  value: { fontSize: 15, lineHeight: 21, fontWeight: '600', color: semantic.text },
  latest: { color: semantic.success },
  notes: { fontSize: 14, lineHeight: 20, color: semantic.secondary, flexShrink: 1 },
  error: { fontSize: 13, lineHeight: 19, color: semantic.warning, flexShrink: 1 },
  actions: { flexDirection: 'row', gap: 10 },
  flex: { flex: 1 },
} as const;
