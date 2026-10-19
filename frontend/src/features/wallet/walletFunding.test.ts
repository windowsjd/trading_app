import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FUNDING_WALLET, isZeroAmount, walletFundingMessage, walletFundingState } from './walletFunding.ts';

describe('the wallet an order pays from', () => {
  it('empty only when the TOTAL balance is exactly zero; usable money says nothing', () => {
    assert.equal(walletFundingState('0', '0'), 'empty');
    assert.equal(walletFundingState('0.00000000', null), 'empty');
    assert.equal(walletFundingState('100', '100'), null);
    assert.equal(walletFundingState('100', '0.01'), null);
  });

  it('money there but none usable (reserved or held as margin) is its own state', () => {
    assert.equal(walletFundingState('100', '0'), 'committed');
    assert.equal(walletFundingState('0.00000001', '0.00000000'), 'committed');
  });

  it('loading, failed, missing or unreadable is unknown, never empty', () => {
    for (const balance of [undefined, null, '', 'NaN', '1e', '-']) assert.equal(walletFundingState(balance, '0'), null, String(balance));
    assert.equal(walletFundingState('100', null), null, 'an unknown usable amount is not "nothing usable"');
    assert.equal(walletFundingState('100', undefined), null);
    assert.equal(isZeroAmount('-0'), true);
    assert.equal(isZeroAmount('0.1'), false);
  });

  it('names each product\'s own wallet, and offers only the routes the app supports into it', () => {
    assert.equal(walletFundingMessage('domestic_stock', 'empty'), '증권 원화 지갑이 비어 있습니다.');
    assert.equal(walletFundingMessage('us_stock', 'empty'), '증권 달러 지갑이 비어 있습니다.');
    assert.equal(walletFundingMessage('crypto_spot', 'empty'), '암호화폐 현물 지갑이 비어 있습니다.');
    assert.equal(walletFundingMessage('crypto_futures', 'empty'), '암호화폐 선물 지갑이 비어 있습니다.');
    assert.match(walletFundingMessage('crypto_futures', 'committed'), /포지션 증거금이나 주문에 쓰이고 있어/);
    assert.match(walletFundingMessage('us_stock', 'committed'), /다른 주문에 예약되어 있어/);
    for (const product of ['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures'] as const) {
      assert.doesNotMatch(walletFundingMessage(product, 'committed'), /비어 있습니다/, product);
    }
    // 증권 KRW takes no USD transfer: 환전 (USD → KRW) is its only route.
    assert.deepEqual(FUNDING_WALLET.domestic_stock.actions, [{ kind: 'fx', fromCurrency: 'USD' }]);
    assert.deepEqual(FUNDING_WALLET.us_stock.actions, [{ kind: 'fx', fromCurrency: 'KRW' }, { kind: 'transfer', destination: 'securities' }]);
    assert.deepEqual(FUNDING_WALLET.crypto_spot.actions, [{ kind: 'transfer', destination: 'crypto_spot' }]);
    assert.deepEqual(FUNDING_WALLET.crypto_futures.actions, [{ kind: 'transfer', destination: 'crypto_futures' }]);
  });
});
