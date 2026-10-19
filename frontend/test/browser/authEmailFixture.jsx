import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppearanceProvider } from '../../src/theme/appearance';
import LoginScreen from '../../src/screens/auth/LoginScreen';
import SignupScreen from '../../src/screens/auth/SignupScreen';
import PasswordResetScreen from '../../src/screens/auth/PasswordResetScreen';

const screen = new URLSearchParams(location.search).get('screen') ?? 'Login';
const Component = { Login: LoginScreen, Signup: SignupScreen, PasswordReset: PasswordResetScreen }[screen];
const navigation = { navigate: (name, params) => { window.lastNavigation = { name, params }; }, replace: name => { window.lastNavigation = { name }; } };
const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><AppearanceProvider><SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: innerWidth, height: innerHeight }, insets: { top: 24, left: 0, right: 0, bottom: 24 } }}>
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Component navigation={navigation} route={{ params: { email: 'fixture@example.com' } }} />
    </div>
  </SafeAreaProvider></AppearanceProvider></QueryClientProvider>
);
