import { buildKisWatchlist } from './kis-watchlist.policy';

describe('KIS watchlist policy', () => {
  it('allows at most 41 unique normalized symbols', () => {
    const domesticSymbols = Array.from({ length: 20 }, (_, index) =>
      String(index).padStart(6, '0'),
    );
    const usSymbols = Array.from({ length: 21 }, (_, index) => `us${index}`);

    const watchlist = buildKisWatchlist({
      domesticSymbols,
      usSymbols,
      maxSize: 41,
    });

    expect(watchlist.allSymbols).toHaveLength(41);
    expect(watchlist.usSymbols[0]).toBe('US0');
  });

  it('fails when unique normalized symbols exceed 41', () => {
    const symbols = Array.from({ length: 42 }, (_, index) => `A${index}`);

    expect(() =>
      buildKisWatchlist({
        domesticSymbols: symbols,
        maxSize: 41,
      }),
    ).toThrow('KIS watchlist allows at most 41 symbols.');
  });

  it('removes empty and duplicate symbols across domestic and US lists', () => {
    const watchlist = buildKisWatchlist({
      domesticSymbols: [' 005930 ', '', 'AAPL'],
      usSymbols: ['aapl', 'MSFT'],
      maxSize: 41,
    });

    expect(watchlist.domesticSymbols).toEqual(['005930', 'AAPL']);
    expect(watchlist.usSymbols).toEqual(['MSFT']);
    expect(watchlist.allSymbols).toEqual(['005930', 'AAPL', 'MSFT']);
  });
});
