jest.mock('ioredis', () => jest.fn());
jest.mock('../redis/redis.config', () => ({
  readRedisConfig: () => ({
    url: 'redis://test',
    connectTimeoutMs: 100,
    commandTimeoutMs: 100,
  }),
}));

import { EventEmitter } from 'node:events';
import IORedis from 'ioredis';
import {
  ProviderPricePubSubService,
  parseProviderEvent,
  PROVIDER_PRICE_PUBSUB_CHANNEL,
} from './provider-price-pubsub.service';
import { FX_RATE_UPDATE_EVENT } from '../providers/fx-rate-update-event';

describe('provider realtime transport', () => {
  it('accepts only USD/KRW invalidations and never forwards raw rate fields', () => {
    expect(
      parseProviderEvent(
        JSON.stringify({
          ...FX_RATE_UPDATE_EVENT,
          rate: '9999',
          source: 'raw',
        }),
      ),
    ).toEqual(FX_RATE_UPDATE_EVENT);
    expect(
      parseProviderEvent(
        JSON.stringify({ type: 'fx_rate_updated', pair: 'EUR/KRW' }),
      ),
    ).toBeNull();
    expect(parseProviderEvent('null')).toBeNull();
    expect(parseProviderEvent('invalid')).toBeNull();
  });

  it('resyncs after Redis recovery even with live candles disabled and shares the price channel', async () => {
    const client = Object.assign(new EventEmitter(), {
      subscribe: jest.fn().mockResolvedValue(1),
      unsubscribe: jest.fn().mockResolvedValue(0),
      connect: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
    });
    (IORedis as unknown as jest.Mock).mockImplementation(() => client);
    const service = new ProviderPricePubSubService(
      { publish: jest.fn() } as never,
      { enabled: false, reconnectMinMs: 100, reconnectMaxMs: 1000 } as never,
    );
    const receive = jest.fn();
    service.subscribe(receive);
    service.onModuleInit();
    client.emit('ready');
    await Promise.resolve();
    expect(client.subscribe).toHaveBeenCalledWith(
      PROVIDER_PRICE_PUBSUB_CHANNEL,
    );
    expect(receive).toHaveBeenLastCalledWith(FX_RATE_UPDATE_EVENT);
    client.emit(
      'message',
      PROVIDER_PRICE_PUBSUB_CHANNEL,
      JSON.stringify(FX_RATE_UPDATE_EVENT),
    );
    expect(receive).toHaveBeenCalledTimes(2);
    client.emit('ready');
    await Promise.resolve();
    expect(receive).toHaveBeenCalledTimes(3);
    await service.onModuleDestroy();
    expect(client.quit).toHaveBeenCalledTimes(1);
  });
});
