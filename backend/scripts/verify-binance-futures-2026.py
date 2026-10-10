"""Independent offline verification of the Futures research; stdlib, no HTTP/DB."""
import argparse
import datetime as dt
from decimal import Decimal, localcontext, ROUND_HALF_UP
import gzip
import hashlib
import json
from pathlib import Path
import re


def verify(directory):
    result = json.loads((directory / 'result.json').read_text())
    assert result['status'] == 'COMPLETE', 'unconfirmed ranking'
    start = int(dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc).timestamp()) * 1000
    end = int(dt.datetime(2026, 10, 10, tzinfo=dt.timezone.utc).timestamp()) * 1000
    day = 86400000
    exchange = json.loads((directory / 'exchange-info.json').read_text())
    contracts = {r['symbol']: r for r in exchange['symbols']
                 if r['contractType'] == 'PERPETUAL' and r['status'] == 'TRADING'
                 and r['quoteAsset'] == r['marginAsset'] == 'USDT'}
    reported = {r['symbol']: r for r in result['ranking']}
    totals = {}
    sample = []
    with localcontext() as context:
        context.prec = 80
        context.rounding = ROUND_HALF_UP
        with gzip.open(directory / 'klines.ndjson.gz', 'rt') as raw:
            for line in raw:
                record = json.loads(line)
                symbol, payload = record['symbol'], record['payload']
                assert symbol not in totals, f'duplicate symbol: {symbol}'
                unique = {}
                for row in payload:
                    opened = row[0]
                    assert start <= opened < end and opened % day == 0, f'UTC boundary: {symbol}'
                    assert row[6] == opened + day - 1 and row[6] < end, f'unclosed day: {symbol}'
                    assert isinstance(row[7], str) and re.fullmatch(r'\d+(?:\.\d+)?', row[7]), f'volume format: {symbol}'
                    if opened in unique:
                        assert unique[opened] == row, f'conflicting duplicate: {symbol}'
                    unique[opened] = row
                listing = contracts[symbol]['onboardDate'] // day * day
                first = max(start, min(listing, min(unique, default=listing)))
                assert set(unique) == set(range(first, end, day)), f'missing daily data: {symbol}'
                total = sum((Decimal(r[7]) for r in unique.values()), Decimal(0))
                assert total == Decimal(reported[symbol]['quoteVolumeUsdt']), f'sum mismatch: {symbol}'
                assert len(unique) == reported[symbol]['dailyBars'], f'bar count mismatch: {symbol}'
                canonical = json.dumps(payload, separators=(',', ':'), ensure_ascii=False)
                assert hashlib.sha256(canonical.encode()).hexdigest() == reported[symbol]['payloadSha256'], f'raw hash mismatch: {symbol}'
                totals[symbol] = total
                if symbol in {r['symbol'] for r in result['top25'][:5]}:
                    sample.append({'symbol': symbol, 'quoteVolumeUsdt': format(total, 'f'),
                                   'dailyBars': len(unique), 'firstRawKline': unique[min(unique)],
                                   'lastRawKline': unique[max(unique)]})
        assert set(totals) == set(contracts) == set(reported), 'universe mismatch'
        ranked = sorted(totals, key=lambda s: (-totals[s], s))
        assert ranked == [r['symbol'] for r in result['ranking']], 'ranking mismatch'
        grand_total = sum(totals.values(), Decimal(0))
        assert grand_total == Decimal(result['totalQuoteVolumeUsdt']), 'universe total mismatch'
        share = sum((totals[s] for s in ranked[:25]), Decimal(0)) / grand_total * 100
        assert share.quantize(Decimal('0.000000000001')) == Decimal(result['top25SharePercent']), 'share mismatch'
        crypto = [s for s in ranked if contracts[s]['underlyingType'] == 'COIN']
        policy = [s for s in crypto if re.fullmatch(r'[A-Z0-9]+USDT', s)
                  and s == contracts[s]['baseAsset'] + 'USDT' and contracts[s]['pair'] == s]
        for cohort, total_field, share_field in [
            (crypto, 'cryptoTotalQuoteVolumeUsdt', 'cryptoTop25SharePercent'),
            (policy, 'strictContractPolicyTotalQuoteVolumeUsdt', 'strictContractPolicyTop25SharePercent')]:
            cohort_total = sum((totals[s] for s in cohort), Decimal(0))
            assert cohort_total == Decimal(result[total_field]), 'cohort total mismatch'
            cohort_share = sum((totals[s] for s in cohort[:25]), Decimal(0)) / cohort_total * 100
            assert cohort_share.quantize(Decimal('0.000000000001')) == Decimal(result[share_field]), 'cohort share mismatch'
    proof = {'status': 'PASS', 'contracts': len(totals), 'windowDays': (end-start)//day,
             'rawHashesMatched': len(totals), 'independentDecimalSumsMatched': len(totals),
             'fullRankingMatched': True, 'duplicatesOrGaps': False,
             'topFiveOriginalKlineSamples': sorted(sample, key=lambda r: ranked.index(r['symbol']))}
    (directory / 'independent-verification.json').write_text(json.dumps(proof, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({k: v for k, v in proof.items() if k != 'topFiveOriginalKlineSamples'}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    verify(parser.parse_args().directory)
