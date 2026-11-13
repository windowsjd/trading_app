// 관리자 전용 콘솔·공지 팝업 fixture (2026-11-13): production screens on RN-Web with
// adminNoticeMocks.js. `?screen=popup|list|editor|console&fontScale=`.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NavigationContext } from '@react-navigation/core';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppearanceProvider } from '../../src/theme/appearance';
import NoticePopupHost from '../../src/features/notice/NoticePopupHost';
import AdminNoticesScreen from '../../src/screens/admin/AdminNoticesScreen';
import AdminNoticeEditorScreen from '../../src/screens/admin/AdminNoticeEditorScreen';
import AdminConsoleScreen from '../../src/screens/admin/AdminConsoleScreen';

const screen = new URLSearchParams(location.search).get('screen') ?? 'popup';
window.navigations = [];
const navigation = { navigate: (name, params) => window.navigations.push({ name, params }), goBack: () => window.navigations.push({ name: 'goBack' }),
  addListener: () => () => {}, isFocused: () => true, getParent: () => undefined, getState: () => ({ routes: [], index: 0 }) };
const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
client.setQueryData(['me'], { id: 'admin-1', role: 'admin', nickname: '관리자', email: 'admin@example.test' });
const Screen = { list: AdminNoticesScreen, editor: AdminNoticeEditorScreen, console: AdminConsoleScreen }[screen];
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><AppearanceProvider><NavigationContext.Provider value={navigation}>
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: innerWidth, height: innerHeight }, insets: { top: 24, left: 0, right: 0, bottom: 24 } }}>
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {screen === 'popup' ? <><div data-testid="behind" style={{ padding: 16 }}>홈 화면</div><NoticePopupHost enabled /></> : <Screen navigation={navigation} route={{ params: undefined }} />}
      </div>
    </SafeAreaProvider>
  </NavigationContext.Provider></AppearanceProvider></QueryClientProvider>
);
