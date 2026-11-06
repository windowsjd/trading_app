import React, { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppearanceProvider } from '../../src/theme/appearance';
import TradeShareCard from '../../src/components/share/TradeShareCard';
import TradeShareSheet from '../../src/screens/history/TradeShareSheet';
import { getTradeShareCard } from '../../src/features/share/tradeShareDisplay';

// 수익 공유 card and sheet over fixture trades. `?view=card&scenario=…` draws the
// card alone at 1080 × 1920 CSS px (the device capture's own grid at DPR 1);
// `?view=sheet&scenario=…` opens the real sheet over a phone-sized screen.
const futures = (overrides = {}) => ({
  kind: 'futures', key: 'futures:lifetime-1', assetId: 'asset-btc', symbol: 'BTCUSDT', name: 'Bitcoin', market: 'BINANCE',
  direction: 'long', currencyCode: 'USD', entryMargin: '4454.20000000', realizedPnl: '152.34000000', returnRate: '3.42000000',
  positionId: 'lifetime-1', leverage: 10, marginMode: 'isolated', closeKind: 'closed', completedAt: '2026-11-05T12:44:04.000Z',
  averageEntryPrice: '80958.27000000', averageExitPrice: '85681.22000000', displayPriceDecimals: 2, ...overrides,
});
const spot = (overrides = {}) => ({
  kind: 'spot', key: 'spot:asset-samsung', assetId: 'asset-samsung', symbol: '005930', name: 'Samsung Electronics', market: 'KRX',
  assetType: 'domestic_stock', currencyCode: 'KRW', buyAmount: '1061060.00000000', realizedPnl: '-62815.00000005',
  returnRate: '-5.92002337', completedAt: '2026-11-05T06:30:00.000Z', averageBuyPrice: '70666.66666667',
  averageSellPrice: '75000.00000000', displayPriceDecimals: null, ...overrides,
});
const LONG_NICKNAME = '트레이딩클래스에서가장오래버틴사람의아주긴닉네임입니다';
export const SCENARIOS = {
  design: { trade: futures(), metric: 'amount', nickname: 'User-923a3' },
  rate: { trade: futures(), metric: 'rate', nickname: 'User-923a3' },
  'loss-big': { trade: futures({ symbol: '1000PEPEUSDT', direction: 'short', leverage: 125, closeKind: 'liquidated',
    realizedPnl: '-1234567.89000000', returnRate: '-98.76000000', averageEntryPrice: '0.01234500', averageExitPrice: '0.01345600',
    displayPriceDecimals: 7 }), metric: 'amount', nickname: '손절의달인' },
  'loss-rate-big': { trade: futures({ direction: 'short', leverage: 125, realizedPnl: '-9999999.99000000', returnRate: '-12345.67000000' }),
    metric: 'rate', nickname: 'User-923a3' },
  'spot-krw': { trade: spot(), metric: 'amount', nickname: '주식왕' },
  'spot-usd': { trade: spot({ key: 'spot:asset-googl', symbol: 'GOOGL', name: 'Alphabet Inc. Class A Common Stock', market: 'NAS',
    assetType: 'us_stock', currencyCode: 'USD', realizedPnl: '0.00000000', returnRate: '0.00000000', averageBuyPrice: '182.4',
    averageSellPrice: '182.40000000' }), metric: 'amount', nickname: LONG_NICKNAME },
  'krw-huge': { trade: spot({ realizedPnl: '123456789012.00000000', returnRate: '1234.56000000', averageBuyPrice: '1234567.89',
    averageSellPrice: '9876543.21' }), metric: 'amount', nickname: 'abcdefghijklmnopqrstuvwxyz0123' },
  'no-prices': { trade: futures({ averageEntryPrice: null, averageExitPrice: null, returnRate: null }), metric: 'rate', nickname: 'User-923a3' },
  photo: { trade: futures(), metric: 'amount', nickname: 'User-923a3', photo: true },
};

const params = new URLSearchParams(location.search);
const scenario = SCENARIOS[params.get('scenario') ?? 'design'];
const profile = { id: 'user-1', email: 'member@example.com', nickname: scenario.nickname, role: 'user', status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z', portfolioPublic: true,
  profileImageUrl: scenario.photo ? `${location.origin}/avatar.png` : null };
window.fixture = { ready: false, readiness: [] };

function CardOnly() {
  const onReadiness = useCallback((readiness) => {
    window.fixture.readiness.push(readiness);
    window.fixture.ready = readiness === 'ready';
  }, []);
  return (
    <View style={{ width: 1080, height: 1920 }}>
      <TradeShareCard card={getTradeShareCard(scenario.trade, scenario.metric)} nickname={profile.nickname}
        profileImageUrl={profile.profileImageUrl} width={1080} onReadinessChange={onReadiness} />
    </View>
  );
}

function SheetOnly() {
  const [trade, setTrade] = useState(scenario.trade);
  return (
    <View style={{ height: innerHeight }}>
      <TradeShareSheet accountId="season-1" trade={trade} onClose={() => setTrade(null)} />
    </View>
  );
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
client.setQueryData(['me'], profile);
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><AppearanceProvider><SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: innerWidth, height: innerHeight }, insets: { top: 24, left: 0, right: 0, bottom: 24 } }}>
    {params.get('view') === 'sheet' ? <SheetOnly /> : <CardOnly />}
  </SafeAreaProvider></AppearanceProvider></QueryClientProvider>,
);
