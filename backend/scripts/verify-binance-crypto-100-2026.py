"""Independent offline verification of the 2026 YTD Spot 100 + USDⓈ-M 100 research.

Standard library only; no HTTP, DB or application import. It re-derives every
candidate, daily-bar check, Decimal sum, ranking, policy decision and the two
final catalogs from the raw response cache, then compares them with the
TypeScript result.

python3 -I scripts/verify-binance-crypto-100-2026.py <cache-dir> <result-dir>
"""
import argparse
import csv
import datetime as dt
from decimal import Decimal, localcontext
import hashlib
import json
from pathlib import Path
import re
import urllib.parse

START = int(dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc).timestamp()) * 1000
END = int(dt.datetime(2026, 10, 16, tzinfo=dt.timezone.utc).timestamp()) * 1000
DAY = 86_400_000
TARGET = 100
# Frozen research inputs: the catalogs before this expansion, in order.
SPOT_EXISTING = [
    'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'SOLUSDT', 'TRXUSDT', 'DOGEUSDT', 'ZECUSDT',
    'XLMUSDT', 'LINKUSDT', 'SUIUSDT', 'NIGHTUSDT', 'NEARUSDT', 'PEPEUSDT', 'ADAUSDT', 'TAOUSDT',
    'WLDUSDT', 'ENAUSDT', 'AVAXUSDT', 'UNIUSDT', 'CHIPUSDT', 'LTCUSDT', 'ASTERUSDT',
    '币安人生USDT', 'TRUMPUSDT']
FUTURES_EXISTING = [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ZECUSDT', 'XRPUSDT', 'HYPEUSDT', 'DOGEUSDT', 'BNBUSDT',
    'SUIUSDT', 'NEARUSDT', 'ADAUSDT', 'WLDUSDT', 'TAOUSDT', 'ENAUSDT', 'LINKUSDT', 'AVAXUSDT',
    'UNIUSDT', 'PUMPUSDT', 'BCHUSDT', 'TRUMPUSDT', 'FILUSDT', 'AAVEUSDT', 'LTCUSDT', 'ASTERUSDT',
    'XLMUSDT']
SPOT_SYMBOL = re.compile(r'^[A-Z0-9㐀-䶿一-鿿豈-﫿]+USDT$')
FUTURES_SYMBOL = re.compile(r'^[A-Z0-9]+USDT$')


def load(cache, name):
    raw = (cache / (name + '.json')).read_bytes()
    return json.loads(raw), hashlib.sha256(raw).hexdigest()


def spot_permission(row):
    return (row.get('isSpotTradingAllowed') is True
            or 'SPOT' in (row.get('permissions') or [])
            or any('SPOT' in group for group in (row.get('permissionSets') or [])))


def spot_candidate(row):
    return row['quoteAsset'] == 'USDT' and row['status'] == 'TRADING' and spot_permission(row)


def futures_candidate(row):
    return (row['contractType'] == 'PERPETUAL' and row['status'] == 'TRADING'
            and row['quoteAsset'] == 'USDT' and row['marginAsset'] == 'USDT')


def futures_accepted(row):
    return (futures_candidate(row) and FUTURES_SYMBOL.match(row['symbol'])
            and row['symbol'] == row['baseAsset'] + 'USDT' and row.get('pair') == row['symbol']
            and row['underlyingType'] == 'COIN')


def tick_decimals(row):
    tick = next((f.get('tickSize') for f in row.get('filters', [])
                 if f.get('filterType') == 'PRICE_FILTER'), None)
    if not isinstance(tick, str) or not re.fullmatch(r'\d+(?:\.\d+)?', tick) or Decimal(tick) == 0:
        return None
    return len(tick.partition('.')[2].rstrip('0'))


def plain_crypto_exclusion(base, meta):
    if meta is None:
        return 'asset_metadata_missing'
    tags = set(meta.get('tags') or [])
    if 'stablecoin' in tags or base == 'USTC':
        return 'stablecoin'
    if meta.get('isLegalMoney'):
        return 'fiat'
    if base in ('WBTC', 'WBETH', 'BNSOL'):
        return 'wrapped_or_staked_representation'
    if 'tCommodities' in tags:
        return 'commodity_pegged_representation'
    if 'bStocks' in tags:
        return 'tokenized_stock_or_etf'
    if meta.get('etf'):
        return 'leveraged_or_derivative_token'
    return None


def spot_policy(row, meta):
    if row['symbol'] != row['baseAsset'] + 'USDT':
        return 'symbol_identity_mismatch'
    if not SPOT_SYMBOL.match(row['symbol']):
        return 'symbol_identity_unsupported'
    excluded = plain_crypto_exclusion(row['baseAsset'], meta)
    if excluded:
        return excluded
    decimals = tick_decimals(row)
    if decimals is None or decimals > 8:
        return 'price_precision_unsupported'
    return None


def summarize(cache, market, symbol, listing):
    payload, digest = load(cache, f'{market}-klines-{urllib.parse.quote(symbol, safe="")}')
    unique = {}
    with localcontext() as context:
        context.prec = 80
        for row in payload:
            opened = row[0]
            assert isinstance(opened, int) and START <= opened < END and opened % DAY == 0, symbol
            assert row[6] == opened + DAY - 1 and row[6] < END, f'unclosed day: {symbol}'
            assert isinstance(row[7], str) and re.fullmatch(r'\d+(?:\.\d+)?', row[7]), symbol
            if opened in unique:
                assert unique[opened] == row, f'conflicting duplicate: {symbol}'
            unique[opened] = row
        if listing is None:
            first = min(unique, default=None)
        else:
            listing_day = listing // DAY * DAY
            first = max(START, min(listing_day, min(unique, default=listing_day)))
        expected = set(range(first, END, DAY)) if first is not None else set()
        assert set(unique) == expected, f'missing or extra daily bars: {market} {symbol}'
        total = sum((Decimal(r[7]) for r in unique.values()), Decimal(0))
    return total, len(unique), digest


def ranked(totals):
    return sorted(totals, key=lambda s: (-totals[s], s))


def verify(cache, result_dir):
    result = json.loads((result_dir / 'result.json').read_text())
    assert result['status'] == 'COMPLETE'
    assert result['window'] == {'startInclusive': '2026-01-01T00:00:00.000Z',
                                'endExclusive': '2026-10-16T00:00:00.000Z',
                                'completedUtcDays': 288}
    metadata, _ = load(cache, 'asset-metadata')
    assert metadata['code'] == '000000'
    meta = {row['assetCode']: row for row in metadata['data']}
    spot, _ = load(cache, 'spot-exchange-info')
    spot_final, _ = load(cache, 'spot-exchange-info-final')
    futures, _ = load(cache, 'futures-exchange-info')
    futures_final, _ = load(cache, 'futures-exchange-info-final')
    spot_final_by = {r['symbol']: r for r in spot_final['symbols']}
    spot_by = {r['symbol']: r for r in spot['symbols']}
    futures_final_by = {r['symbol']: r for r in futures_final['symbols']}

    def csv_rows(name):
        with (result_dir / name).open(newline='') as handle:
            return {row['symbol']: row for row in csv.DictReader(handle)}
    spot_rows = csv_rows('spot-all-candidates.csv')
    futures_rows = csv_rows('futures-all-contracts.csv')

    proof = {}
    # ------------------------------------------------------------- Spot
    totals, policy = {}, {}
    for row in [r for r in spot['symbols'] if spot_candidate(r)]:
        total, bars, digest = summarize(cache, 'spot', row['symbol'], None)
        totals[row['symbol']] = total
        final = spot_final_by.get(row['symbol'])
        policy[row['symbol']] = (spot_policy(row, meta.get(row['baseAsset']))
                                 or ('no_completed_daily_bar_in_window' if bars == 0 else None)
                                 or (None if final and spot_candidate(final)
                                     and final['baseAsset'] == row['baseAsset']
                                     else 'no_longer_eligible_at_final_validation'))
        reported = spot_rows[row['symbol']]
        assert Decimal(reported['quoteVolumeUsdt']) == total, row['symbol']
        assert int(reported['dailyBars']) == bars and reported['payloadSha256'] == digest
    order = ranked(totals)
    assert [r['symbol'] for r in result['spot']['binanceTop100']] == order[:TARGET], 'spot top 100'
    eligible = [s for s in order if not policy[s]]
    assert len(eligible) == result['spot']['policyEligible']
    added = [s for s in eligible if s not in SPOT_EXISTING][:TARGET - len(SPOT_EXISTING)]
    spot_final_list = SPOT_EXISTING + added
    assert [r['symbol'] for r in result['spot']['added']] == added, 'spot additions'
    assert spot_final_list == result['spot']['final'], 'spot final 100'
    assert len(set(spot_final_list)) == TARGET
    assert all(not policy[s] for s in SPOT_EXISTING), 'an existing Spot entry failed policy'
    reported_exclusions = {r['symbol']: r['exclusion'] for r in result['spot']['exclusions']}
    assert reported_exclusions == {s: policy[s] for s in order if policy[s]}, 'spot exclusions'
    assert len(set(totals[s] for s in eligible[:TARGET + 10])) == len(eligible[:TARGET + 10]), 'tie near boundary'
    proof['spot'] = dict(candidates=len(totals), eligible=len(eligible), added=len(added),
                         boundary=[added[-1], eligible[eligible.index(added[-1]) + 1]],
                         total=format(sum(totals.values(), Decimal(0)), 'f'))
    assert Decimal(result['spot']['totalQuoteVolumeUsdt']) == sum(totals.values(), Decimal(0))

    # ---------------------------------------------------------- Futures
    totals, policy, coin = {}, {}, {}
    final_spot_set = set(spot_final_list)
    for row in [r for r in futures['symbols'] if futures_candidate(r)]:
        total, bars, digest = summarize(cache, 'futures', row['symbol'], row['onboardDate'])
        totals[row['symbol']] = total
        reported = futures_rows[row['symbol']]
        assert Decimal(reported['quoteVolumeUsdt']) == total, row['symbol']
        assert int(reported['dailyBars']) == bars and reported['payloadSha256'] == digest
        coin[row['symbol']] = row['underlyingType'] == 'COIN'
        spot_row = spot_by.get(row['symbol'])
        final_spot = spot_final_by.get(row['symbol'])
        final_contract = futures_final_by.get(row['symbol'])
        exact_spot = (spot_row is not None and spot_candidate(spot_row)
                      and spot_row['baseAsset'] == row['baseAsset']
                      and final_spot is not None and spot_candidate(final_spot)
                      and final_spot['baseAsset'] == row['baseAsset'])
        decimals = tick_decimals(row)
        final_decimals = tick_decimals(final_contract) if final_contract else None
        if not futures_accepted(row):
            reason = 'contract_policy_rejected'
        elif not (final_contract and futures_accepted(final_contract)):
            reason = 'no_longer_eligible_at_final_validation'
        elif not exact_spot:
            reason = 'exact_spot_underlying_unavailable'
        else:
            reason = (spot_policy(spot_row, meta.get(row['baseAsset']))
                      or ('price_precision_unsupported' if decimals is None or decimals > 8
                          or final_decimals is None or final_decimals > 8 else None)
                      or ('no_completed_daily_bar_in_window' if bars == 0 else None))
        policy[row['symbol']] = reason
    order = ranked(totals)
    assert [r['symbol'] for r in result['futures']['binanceTop100']] == order[:TARGET], 'futures top 100'
    assert [r['symbol'] for r in result['futures']['binanceTop100Coin']] == \
        [s for s in order if coin[s]][:TARGET], 'futures COIN top 100'
    for row in result['futures']['binanceTop100']:
        assert Decimal(row['quoteVolumeUsdt']) == totals[row['symbol']]
    eligible = [s for s in order if not policy[s]]
    assert len(eligible) == result['futures']['policyEligible']
    added = [s for s in eligible if s not in FUTURES_EXISTING][:TARGET - len(FUTURES_EXISTING)]
    futures_final_list = FUTURES_EXISTING + added
    assert [r['symbol'] for r in result['futures']['added']] == added, 'futures additions'
    assert futures_final_list == result['futures']['final'], 'futures final 100'
    assert len(set(futures_final_list)) == TARGET
    assert all(not policy[s] for s in FUTURES_EXISTING), 'an existing Futures contract failed policy'
    reported_exclusions = {r['symbol']: r['exclusion'] for r in result['futures']['exclusions']}
    assert reported_exclusions == {s: policy[s] for s in order if policy[s]}, 'futures exclusions'
    futures_only = [s for s in futures_final_list if s not in final_spot_set]
    assert futures_only == [r['symbol'] for r in result['futures']['futuresOnlyUnderlyings']]
    assert Decimal(result['futures']['totalQuoteVolumeUsdt']) == sum(totals.values(), Decimal(0))
    proof['futures'] = dict(candidates=len(totals), eligible=len(eligible), added=len(added),
                            boundary=[added[-1], eligible[eligible.index(added[-1]) + 1]],
                            futuresOnly=futures_only,
                            total=format(sum(totals.values(), Decimal(0)), 'f'))
    selection = json.loads((result_dir / 'selection.json').read_text())
    assert selection['spot']['final'] == spot_final_list
    assert selection['futures']['final'] == futures_final_list
    assert selection['resultSha256'] == hashlib.sha256(
        (result_dir / 'result.json').read_bytes()).hexdigest()
    proof['status'] = 'PASS'
    (result_dir / 'independent-verification.json').write_text(
        json.dumps(proof, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps(proof, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('cache', type=Path)
    parser.add_argument('result', type=Path)
    args = parser.parse_args()
    verify(args.cache, args.result)
