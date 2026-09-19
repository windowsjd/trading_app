"""One-off, public Binance research. No DB, credentials, or runtime imports.

python3 scripts/research-binance-universe-2026.py --cache-dir /tmp/binance-ytd \
    --output-dir /tmp/binance-ytd-result
Use --replay to recompute from an existing complete raw cache without network.
The period and original ten are frozen research inputs, not runtime defaults.
"""

import argparse
import csv
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal, localcontext

START = 1767225600000  # 2026-01-01T00:00:00Z
END = 1789776000000  # 2026-09-19T00:00:00Z (exclusive)
DAY = 86400000
REST = 'https://api.binance.com'
METADATA = 'https://www.binance.com/bapi/asset/v2/public/asset/asset/get-all-asset'
EXISTING = ('BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'TRX', 'DOGE', 'ZEC', 'XLM', 'LINK')
WRAPPED = {'WBTC', 'WBETH', 'BNSOL'}


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def spot_allowed(info):
    # Matches the project's hasSpotPermission(exchangeInfo) contract.
    return (info.get('isSpotTradingAllowed') is True
            or 'SPOT' in info.get('permissions', [])
            or any('SPOT' in group for group in info.get('permissionSets', [])))


def eligible_pair(info):
    return (info['quoteAsset'] == 'USDT' and info['status'] == 'TRADING'
            and spot_allowed(info))


def exclusion(base, metadata):
    tags = set(metadata.get('tags', []))
    if base in EXISTING:
        return 'existing_universe'
    if 'stablecoin' in tags or base == 'USTC':
        return 'stablecoin (including depegged stablecoin designs)'
    if metadata.get('isLegalMoney'):
        return 'fiat, not a plain crypto asset'
    if base in WRAPPED:
        return 'wrapped/staked representation of another crypto asset'
    if 'tCommodities' in tags:
        return 'commodity-pegged representation'
    if 'bStocks' in tags:
        return 'tokenized stock/ETF representation (including leveraged ETFs)'
    if metadata.get('etf'):
        return 'leveraged/derivative token'
    return ''


def summarize(klines):
    if not isinstance(klines, list) or len(klines) > (END - START) // DAY:
        raise ValueError('invalid daily kline response')
    # Exact for the bounded accepted decimal shape, including 261-day summation.
    with localcontext() as context:
        context.prec = 80
        total = Decimal(0)
        previous = None
        for kline in klines:
            if (not isinstance(kline, list) or len(kline) != 12
                    or not isinstance(kline[0], int)
                    or not START <= kline[0] < END or kline[0] % DAY
                    or kline[6] != kline[0] + DAY - 1
                    or (previous is not None and kline[0] != previous + DAY)):
                raise ValueError('out-of-period, duplicate, unordered or gapped daily klines')
            quote = kline[7]  # NOT kline[5] (base volume), NOT rolling 24h volume.
            if not isinstance(quote, str) or not re.fullmatch(r'\d{1,40}(?:\.\d{1,20})?', quote):
                raise ValueError('invalid quote volume decimal string')
            total += Decimal(quote)
            previous = kline[0]
        if klines and previous != END - DAY:
            raise ValueError('missing final completed UTC day')
    return dict(quoteVolume=format(total, 'f'), days=len(klines),
                firstOpenTime=klines[0][0] if klines else None,
                lastOpenTime=klines[-1][0] if klines else None)


def ranked(rows):
    # copy_negate is exact and does not apply Decimal's default context.
    return sorted(rows, key=lambda row: (Decimal(row['quoteVolume']).copy_negate(), row['symbol']))


def fetch(url):
    # Concurrency=1; <= 6.7 requests/s, far below the observed 6000 weight/min.
    for attempt in range(4):
        time.sleep(0.15)
        try:
            with urllib.request.urlopen(url, timeout=25) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code == 418 or error.code not in (429, 500, 502, 503, 504):
                raise
            retry_after = error.headers.get('Retry-After', '0')
            delay = max(2 ** (attempt + 1), int(retry_after))
            if delay > 60 or attempt == 3:
                raise
            time.sleep(delay)
        except (TimeoutError, urllib.error.URLError):
            if attempt == 3:
                raise
            time.sleep(2 ** (attempt + 1))
    raise RuntimeError('request retries exhausted')


def run(cache, output, replay):
    started = utc_now()
    cache.mkdir(parents=True, exist_ok=True)
    acquisition = json.loads((cache / 'collection.json').read_text()) if replay else None
    hashes = {}

    def read(name, url):
        path = cache / (name + '.json')
        raw = path.read_bytes() if replay else fetch(url)
        if not replay:
            path.write_bytes(raw)
        hashes[name] = hashlib.sha256(raw).hexdigest()
        return json.loads(raw)

    info = read('exchange-info', REST + '/api/v3/exchangeInfo')
    metadata = read('asset-metadata', METADATA)
    if metadata.get('code') != '000000':
        raise ValueError('official asset metadata unavailable')
    meta = {a['assetCode']: a for a in metadata['data']}
    if len(meta) != len(metadata['data']):
        raise ValueError('ambiguous asset metadata')
    candidates = [s for s in info['symbols'] if eligible_pair(s)]
    if len({s['symbol'] for s in candidates}) != len(candidates):
        raise ValueError('duplicate exchangeInfo symbols')
    rows = []
    for index, symbol in enumerate(candidates):
        base = symbol['baseAsset']
        if symbol['symbol'] != base + 'USDT' or base not in meta:
            raise ValueError('unverified base asset or missing classification: ' + base)
        query = urllib.parse.urlencode(dict(symbol=symbol['symbol'], interval='1d',
                                            startTime=START, endTime=END - 1, limit=1000))
        klines = read(symbol['symbol'], REST + '/api/v3/klines?' + query)
        summary = summarize(klines)
        tick = next(f['tickSize'] for f in symbol['filters'] if f['filterType'] == 'PRICE_FILTER')
        if not re.fullmatch(r'\d+(?:\.\d+)?', tick) or Decimal(tick) <= 0:
            raise ValueError('invalid tickSize')
        rows.append(dict(symbol=symbol['symbol'], baseAsset=base,
                         name=meta[base].get('assetName') or base, **summary,
                         tickSize=tick, displayPriceDecimals=len(tick.partition('.')[2].rstrip('0')),
                         status=symbol['status'], spotAllowed=spot_allowed(symbol), quoteAsset='USDT',
                         exclusion=exclusion(base, meta[base]), metadataTags=meta[base].get('tags', []),
                         sha256=hashes[symbol['symbol']]))
        if (index + 1) % 25 == 0:
            print(f'{index + 1}/{len(candidates)} verified', flush=True)
    # Re-check eligibility and precision at completion, without taking a stale
    # high-volume symbol if trading stopped during the survey.
    final_info = read('final-exchange-info', REST + '/api/v3/exchangeInfo')
    final_symbols = {entry['symbol']: entry for entry in final_info['symbols']}
    for row in rows:
        current = final_symbols.get(row['symbol'])
        if not current or not eligible_pair(current) or current['baseAsset'] != row['baseAsset']:
            if row['baseAsset'] in EXISTING:
                raise ValueError('original universe failed final provider validation')
            row['exclusion'] = 'no longer eligible at final exchangeInfo validation'
            continue
        tick = next(f['tickSize'] for f in current['filters'] if f['filterType'] == 'PRICE_FILTER')
        if not re.fullmatch(r'\d+(?:\.\d+)?', tick) or Decimal(tick) <= 0:
            raise ValueError('invalid final tickSize')
        row['tickSize'] = tick
        row['displayPriceDecimals'] = len(tick.partition('.')[2].rstrip('0'))
    if acquisition is None:
        acquisition = dict(startedAt=started, completedAt=utc_now(), source=REST,
                           candidateCount=len(candidates))
        (cache / 'collection.json').write_text(json.dumps(acquisition, indent=2) + '\n')
    ordered = ranked(rows)
    eligible = [row for row in ordered if not row['exclusion'] and row['days'] > 0]
    if len(eligible) < 16:
        raise ValueError('insufficient eligible candidates')
    for index, row in enumerate(eligible):
        row['rank'] = index + 1
    result = dict(startedAt=started, completedAt=utc_now(), replay=replay, acquisition=acquisition,
                  startInclusive='2026-01-01T00:00:00Z', endExclusive='2026-09-19T00:00:00Z',
                  restSource=REST, metadataSource=METADATA, exchangeInfoServerTime=info.get('serverTime'),
                  exchangeInfoSha256=hashes['exchange-info'], metadataSha256=hashes['asset-metadata'],
                  finalExchangeInfoServerTime=final_info.get('serverTime'),
                  finalExchangeInfoSha256=hashes['final-exchange-info'],
                  calculation='SUM(1d kline[7]); exact decimal strings; no annualization',
                  tieBreaker='symbol ascending Unicode code point order',
                  existingSymbols=[base + 'USDT' for base in EXISTING],
                  candidateCount=len(candidates), eligibleCount=len(eligible),
                  selected=eligible[:15], top30=eligible[:30],
                  excluded=[row for row in ordered if row['exclusion'] and row['exclusion'] != 'existing_universe'],
                  zeroDaySymbols=[row['symbol'] for row in rows if row['days'] == 0])
    output.mkdir(parents=True, exist_ok=True)
    (output / 'selection.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    columns = ['symbol', 'baseAsset', 'name', 'quoteVolume', 'days', 'firstOpenTime', 'lastOpenTime',
               'tickSize', 'displayPriceDecimals', 'status', 'spotAllowed', 'quoteAsset', 'exclusion',
               'metadataTags', 'sha256', 'rank']
    with (output / 'all-candidates.csv').open('w', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(ordered)
    print('Selected: ' + ', '.join(row['symbol'] for row in eligible[:15]))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-dir', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--replay', action='store_true')
    args = parser.parse_args()
    run(args.cache_dir, args.output_dir, args.replay)
