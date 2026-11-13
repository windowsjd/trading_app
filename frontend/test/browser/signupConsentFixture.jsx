// 회원가입 동의(2026-11-13): the production SignupScreen and LegalDocumentScreen on
// RN-Web with mock transport (authEmailMocks.js). `?screen=Signup|terms|privacy`.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NavigationContext } from '@react-navigation/core';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppearanceProvider } from '../../src/theme/appearance';
import SignupScreen from '../../src/screens/auth/SignupScreen';
import LegalDocumentScreen from '../../src/screens/auth/LegalDocumentScreen';

const screen = new URLSearchParams(location.search).get('screen') ?? 'Signup';
window.navigations = [];
const navigation = {
  navigate: (name, params) => { window.navigations.push({ name, params }); },
  replace: name => { window.navigations.push({ name }); },
  goBack: () => { window.navigations.push({ name: 'goBack' }); },
  addListener: () => () => {}, isFocused: () => true, getParent: () => undefined, getState: () => ({ routes: [], index: 0 }),
};
const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
const body = screen === 'Signup'
  ? <SignupScreen navigation={navigation} route={{ params: undefined }} />
  : <LegalDocumentScreen navigation={navigation} route={{ params: { document: screen } }} />;
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><AppearanceProvider><NavigationContext.Provider value={navigation}>
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: innerWidth, height: innerHeight }, insets: { top: 24, left: 0, right: 0, bottom: 24 } }}>
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>{body}</div>
    </SafeAreaProvider>
  </NavigationContext.Provider></AppearanceProvider></QueryClientProvider>
);
