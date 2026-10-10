import {
  Prisma,
  type FuturesLastPriceSnapshot,
  type FuturesMarkSnapshot,
} from '../generated/prisma/client';
import type { InstrumentWithAsset } from './futures.presenter';
import { validFuturesLastPrice } from './futures-last-price';
import { MARK_SOURCES, validMark } from './futures-mark';

/** Read API only: two indexed queries for the whole catalog. No shared cache,
 * TTL or finance authority. Select the same newest trade/per-source Mark as
 * the individual readers, THEN validate; never filter stale rows before LIMIT
 * and accidentally resurrect an older trade. Commands keep locked re-reads. */
export async function readFuturesReferencePrices(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>,
  instruments: InstrumentWithAsset[],
  now: Date,
) {
  const result = new Map<
    string,
    {
      last: FuturesLastPriceSnapshot | null;
      mark: FuturesMarkSnapshot | null;
    }
  >();
  if (!instruments.length) return result;
  const targets = Prisma.join(instruments.map((i) => Prisma.sql`(${i.id})`));
  const [lastRows, markRows] = await Promise.all([
    client.$queryRaw<FuturesLastPriceSnapshot[]>(Prisma.sql`
      SELECT m.id, m.instrument_id AS "instrumentId", m.symbol,
        m.provider_product AS "providerProduct", m.currency_code AS "currencyCode",
        m.source, m.price, m.effective_at AS "effectiveAt", m.captured_at AS "capturedAt"
      FROM (VALUES ${targets}) AS target(instrument_id)
      CROSS JOIN LATERAL (
        SELECT s.* FROM futures_last_price_snapshots s
        WHERE s.instrument_id = target.instrument_id AND s.effective_at <= ${now} AND s.captured_at <= ${now}
        ORDER BY s.effective_at DESC, s.captured_at DESC, s.id DESC LIMIT 1
      ) m`),
    client.$queryRaw<FuturesMarkSnapshot[]>(Prisma.sql`
      SELECT m.id, m.instrument_id AS "instrumentId", m.symbol,
        m.provider_product AS "providerProduct", m.currency_code AS "currencyCode",
        m.source, m.price, m.effective_at AS "effectiveAt", m.captured_at AS "capturedAt"
      FROM (VALUES ${targets}) AS target(instrument_id)
      CROSS JOIN (VALUES ('binance_usdm_mark_ws'::"FuturesMarkSource"), ('binance_usdm_mark_rest'::"FuturesMarkSource")) AS sources(source)
      CROSS JOIN LATERAL (
        SELECT s.* FROM futures_mark_snapshots s
        WHERE s.instrument_id = target.instrument_id AND s.source = sources.source
          AND s.effective_at <= ${now} AND s.captured_at <= ${now}
        ORDER BY s.effective_at DESC, s.captured_at DESC, s.id DESC LIMIT 1
      ) m`),
  ]);
  for (const instrument of instruments) {
    const last = lastRows.find((row) => row.instrumentId === instrument.id);
    const mark = MARK_SOURCES.map((source) =>
      markRows.find(
        (row) => row.instrumentId === instrument.id && row.source === source,
      ),
    ).find(
      (row): row is FuturesMarkSnapshot =>
        !!row && validMark(row, instrument, now),
    );
    result.set(instrument.id, {
      last: last && validFuturesLastPrice(last, instrument, now) ? last : null,
      mark: mark ?? null,
    });
  }
  return result;
}
