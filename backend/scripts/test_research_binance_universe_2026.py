"""Offline checks: python3 -m unittest discover -s scripts -p 'test_research_*.py'."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'research', Path(__file__).with_name('research-binance-universe-2026.py'))
research = importlib.util.module_from_spec(spec)
spec.loader.exec_module(research)


def candle(open_time, quote, base='999999999999999999999999999'):
    return [open_time, '1', '1', '1', '1', base,
            open_time + research.DAY - 1, quote, 1, '0', '0', '0']


class ResearchTest(unittest.TestCase):
    def test_quote_volume_exact_beyond_float_and_default_decimal_precision(self):
        rows = [candle(research.END - 2 * research.DAY, '123456789012345678901234567890.00000001'),
                candle(research.END - research.DAY, '0.00000002')]
        self.assertEqual(research.summarize(rows)['quoteVolume'],
                         '123456789012345678901234567890.00000003')
        self.assertEqual(research.summarize(rows)['days'], 2)  # no annualization

    def test_rejects_current_day_gap_duplicate_and_missing_last_day(self):
        last = candle(research.END - research.DAY, '1')
        for rows in [[candle(research.END, '1')], [last, last],
                     [candle(research.END - 3 * research.DAY, '1'), last],
                     [candle(research.END - 2 * research.DAY, '1')],
                     [candle(research.START - research.DAY, '1')]]:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                research.summarize(rows)

    def test_rejects_float_negative_nonfinite_or_excess_precision(self):
        for quote in [0.1, '-1', 'NaN', 'Infinity', '1e4', '0.' + '1' * 21]:
            with self.subTest(quote=quote), self.assertRaises(ValueError):
                research.summarize([candle(research.END - research.DAY, quote)])

    def test_exact_ranking_and_deterministic_ties(self):
        rows = [{'symbol': 'B', 'quoteVolume': '999999999999999999999999999999.00000001'},
                {'symbol': 'A', 'quoteVolume': '999999999999999999999999999999.00000001'},
                {'symbol': 'C', 'quoteVolume': '999999999999999999999999999999.00000002'}]
        self.assertEqual([row['symbol'] for row in research.ranked(rows)], ['C', 'A', 'B'])

    def test_spot_eligibility_matches_all_provider_shapes(self):
        for permission in [{'isSpotTradingAllowed': True}, {'permissions': ['SPOT']},
                           {'permissionSets': [['MARGIN'], ['SPOT']]}]:
            self.assertTrue(research.eligible_pair(dict(status='TRADING', quoteAsset='USDT', **permission)))
        for status, quote in [('BREAK', 'USDT'), ('TRADING', 'BTC')]:
            self.assertFalse(research.eligible_pair(dict(status=status, quoteAsset=quote, isSpotTradingAllowed=True)))
        self.assertFalse(research.spot_allowed({'isSpotTradingAllowed': False}))

    def test_exclusions_do_not_remove_meme_or_governance_tokens(self):
        for base, meta in [('USDC', {'tags': ['stablecoin']}), ('WBTC', {}), ('USTC', {}),
                           ('XAUT', {'tags': ['tCommodities']}), ('NVDAB', {'tags': ['bStocks']}),
                           ('EUR', {'isLegalMoney': True}), ('BTC', {})]:
            self.assertTrue(research.exclusion(base, meta))
        for base, tags in [('PEPE', ['meme']), ('SHIB', ['meme']), ('FRAX', ['defi'])]:
            self.assertEqual(research.exclusion(base, {'tags': tags}), '')


if __name__ == '__main__':
    unittest.main()
