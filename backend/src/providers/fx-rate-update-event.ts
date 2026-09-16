import type { RedisService } from '../redis/redis.service';

// Reuse the provider-price transport; no dedicated FX Redis keys or subscriber.
export const PROVIDER_PRICE_PUBSUB_CHANNEL =
  'candles:live:v1:provider-price-fanout';
export type FxRateUpdateEvent = { type: 'fx_rate_updated'; pair: 'USD/KRW' };
export const FX_RATE_UPDATE_EVENT: FxRateUpdateEvent = {
  type: 'fx_rate_updated',
  pair: 'USD/KRW',
};

/** A committed observation invalidates display selection; it is NOT a rate. */
export async function publishFxRateUpdate(
  redis: Pick<RedisService, 'publish'> | undefined,
): Promise<void> {
  try {
    await redis?.publish(
      PROVIDER_PRICE_PUBSUB_CHANNEL,
      JSON.stringify(FX_RATE_UPDATE_EVENT),
    );
  } catch {
    // PubSub is best-effort. It cannot turn a committed ingestion into a failure.
    // Reconnect and the display's low-frequency REST fallback recover loss.
  }
}
