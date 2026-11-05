import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppearanceProvider } from '../../src/theme/appearance';
import FriendRequestNotifier from '../../src/features/friends/FriendRequestNotifier';
import { fixture } from './friendRequestBannerMocks';
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
fixture.client = client;
// A screen under the banner, so the shot shows what it covers.
const Screen = () => <div style={{ padding: 16, paddingTop: 120, font: '16px sans-serif', color: '#888' }}>{'화면 내용 '.repeat(80)}</div>;
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><AppearanceProvider><Screen /><FriendRequestNotifier /></AppearanceProvider></QueryClientProvider>
);
