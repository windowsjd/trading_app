// Real Binance exchangeInfo, local Redis coordinator. Any batch that contains
// ASTERUSDT also carries an unknown symbol, as if Binance had removed ASTERUSDT.
import { ProviderConfigService } from '../../../../backend/src/providers/provider-config.service';
import { ProviderHttpClient } from '../../../../backend/src/providers/provider-http.client';
import { BinancePublicClient } from '../../../../backend/src/providers/binance/binance-public.client';
import { BinanceSymbolMetadataService } from '../../../../backend/src/providers/binance/binance-symbol-metadata.service';
import { BINANCE_FIXED_SYMBOLS } from '../../../../backend/src/providers/binance/binance-fixed-asset-universe';
import { RedisService } from '../../../../backend/src/redis/redis.service';
import { readRedisConfig } from '../../../../backend/src/redis/redis.config';

async function main() {
  const redis = new RedisService(readRedisConfig({ REDIS_URL: 'redis://127.0.0.1:57101' }));
  const http = new ProviderHttpClient(redis);
  const real = new BinancePublicClient(new ProviderConfigService(), http);
  const calls: { size: number; status: string }[] = [];
  const client = {
    fetchExchangeInfo: async (symbols: readonly string[]) => {
      const sent = symbols.includes('ASTERUSDT') ? [...symbols, 'ZZZZNOTREALUSDT'] : [...symbols];
      try {
        const result = await real.fetchExchangeInfo(sent);
        calls.push({ size: symbols.length, status: '200' });
        return result;
      } catch (error) {
        calls.push({ size: symbols.length, status: String((error as { httpStatus?: number }).httpStatus ?? (error as { code?: string }).code) });
        throw error;
      }
    },
  };
  const service = new BinanceSymbolMetadataService(client as never);
  const first = await service.refresh();
  const sources = BINANCE_FIXED_SYMBOLS.map((symbol) => service.getPrecision({ market: 'BINANCE', symbol })?.source);
  const live = sources.filter((s) => s === 'exchange_info').length;
  const aster = service.getPrecision({ market: 'BINANCE', symbol: 'ASTERUSDT' });
  const firstCalls = calls.length;
  await service.refresh();
  console.log(JSON.stringify({ firstRefreshOk: first, liveSymbols: live, fallbackSymbols: sources.length - live,
    aster: { source: aster?.source, tick: aster?.priceTickSize, decimals: aster?.displayPriceDecimals },
    firstRefreshCalls: calls.slice(0, firstCalls), secondRefreshCalls: calls.slice(firstCalls), status: service.getStatus() }));
  await http.onModuleDestroy();
  await redis.onModuleDestroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
