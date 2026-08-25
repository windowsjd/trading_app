import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const source = readFileSync(
  path.join(process.cwd(), 'src/screens/asset/AssetDetailScreen.tsx'),
  'utf8',
);

describe('AssetDetailScreen display contract', () => {
  it('hides market and internal price metadata while retaining settlement currency', () => {
    assert.doesNotMatch(source, /시장\s+\{asset\.market\}/);
    assert.doesNotMatch(source, /가격 통화/);
    assert.match(source, /결제 통화\s+\{asset\.settlementCurrency\}/);

    assert.doesNotMatch(source, /가격 수집/);
    assert.doesNotMatch(source, /가격 기준/);
    assert.doesNotMatch(source, /최신성\s+\{/);
    assert.doesNotMatch(source, /실시간 연결\s+\{connectionState\}/);
    assert.doesNotMatch(source, /가격 소스\s+\{/);
    assert.doesNotMatch(source, /환율 소스\s+\{/);
  });

  it('does not render the asset trading note', () => {
    assert.doesNotMatch(source, /\btradingNote\b/);
    assert.doesNotMatch(source, /Domestic stock orders use the KRW wallet\./);
  });

  it('keeps dynamic market and tradable values after colon labels', () => {
    assert.match(source, /시장 상태:\s+\{asset\.marketStatus\}/);
    assert.match(
      source,
      /거래 상태:\s+\{asset\.tradable\s+\?\s+"거래 가능"\s+:\s+"거래 제한"\}/,
    );
  });
});
