import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTransferAmount, transferAmountFits, transferAvailableAmount, parseWalletTransferResponse, parseWalletFxTransferQuote, parseWalletFxTransferResponse, WalletTransferContractError } from './walletTransfer.ts';
import { TRANSFER_WALLETS, transferRouteKind } from './walletIdentity.ts';

test('amount and available cash preserve eight decimal digits without spending reservations', () => {
  assert.equal(parseTransferAmount(' 0500.10000000 '), '500.10000000');
  assert.equal(parseTransferAmount('0.00000001'), '0.00000001');
  for (const value of ['0', '-1', 'NaN', 'Infinity', '1e3', '1.000000001', '10000000000000000', '1,000']) assert.equal(parseTransferAmount(value), null);
  const wallet = { currencyCode: 'USD' as const, walletScope: 'crypto_spot' as const, balanceAmount: '1000.00000001', reservedAmount: '300' };
  const available = transferAvailableAmount(wallet);
  assert.equal(available, '700.00000001'); assert.equal(transferAmountFits('700.00000001', available), true);
  assert.equal(transferAmountFits('700.00000002', available), false);
  assert.equal(transferAvailableAmount({ ...wallet, reservedAmount: '1001' }), null);
  assert.equal(transferAvailableAmount({ ...wallet, currencyCode: 'KRW' }), '700.00000001');
  assert.equal(transferAvailableAmount({ ...wallet, reservedAmount: undefined }), null);
});

test('success must echo the command account, distinct canonical USD identities, amount and usable balances', () => {
  const request = { sourceWalletId: 'usd', destinationWalletId: 'spot', amount: '500', idempotencyKey: 'test' };
  const result = { tradingAccountId: 'A', transferId: 'transfer', currencyCode: 'USD', amount: '500.00000000', executedAt: '2026-10-06T00:00:00.000Z',
    source: { walletId: 'usd', walletScope: 'securities', balanceAfter: '500.00000000', availableAfter: '200.00000000' },
    destination: { walletId: 'spot', walletScope: 'crypto_spot', balanceAfter: '500.00000000', availableAfter: '500.00000000' } };
  assert.equal(parseWalletTransferResponse(result, 'A', request), result);
  for (const corrupt of [
    { ...result, tradingAccountId: 'B' }, { ...result, tradingAccountId: undefined }, { ...result, currencyCode: 'KRW' }, { ...result, amount: '501.00000000' },
    { ...result, source: { ...result.source, walletId: 'other' } }, { ...result, destination: { ...result.destination, walletScope: 'securities' } },
    { ...result, destination: { ...result.destination, walletScope: 'unknown' } }, { ...result, source: { ...result.source, availableAfter: '501.00000000' } },
  ]) assert.throws(() => parseWalletTransferResponse(corrupt, 'A', request), WalletTransferContractError);
});

test('all canonical identities expose only approved USD and cross-currency routes', () => {
  const expected = [
    ['invalid', 'fx', 'cross_currency', 'cross_currency'],
    ['fx', 'invalid', 'same_currency', 'same_currency'],
    ['cross_currency', 'same_currency', 'invalid', 'same_currency'],
    ['cross_currency', 'same_currency', 'same_currency', 'invalid'],
  ];
  for (const [from, source] of TRANSFER_WALLETS.entries()) for (const [to, destination] of TRANSFER_WALLETS.entries()) {
    assert.equal(transferRouteKind(source, destination), expected[from][to]);
  }
});

test('a cross quote and success must echo account, wallet route, source currency/amount and pinned fee', () => {
  const request = { sourceWalletId: 'krw', destinationWalletId: 'spot', amount: '140000' };
  const quote = { tradingAccountId: 'A', quoteId: 'quote', ...request, fromCurrency: 'KRW' as const, toCurrency: 'USD' as const,
    sourceAmount: '140000.00000000', appliedRate: '1400.00000000', grossTargetAmount: '100.00000000', netTargetAmount: '99.90000000',
    feeRate: '0.001000', feeAmount: '0.10000000', feeCurrency: 'USD' as const, maxChangeBps: '30.0000',
    expiresAt: '2026-10-07T00:00:15.000Z', rateCapturedAt: '2026-10-07T00:00:00.000Z', rateEffectiveAt: '2026-10-07T00:00:00.000Z', rateSource: null };
  assert.equal(parseWalletFxTransferQuote(quote, 'A', request, 'KRW'), quote);
  for (const corrupt of [
    { ...quote, tradingAccountId: 'B' }, { ...quote, sourceWalletId: 'usd' }, { ...quote, destinationWalletId: 'futures' },
    { ...quote, sourceAmount: '1.00000000' }, { ...quote, fromCurrency: 'USD' }, { ...quote, toCurrency: 'KRW' },
    { ...quote, netTargetAmount: 'NaN' }, { ...quote, appliedRate: '0.00000000' }, { ...quote, feeCurrency: 'KRW' },
    { ...quote, feeRate: '2.000000' }, { ...quote, expiresAt: 'yesterday' }, { ...quote, maxChangeBps: {} },
  ]) assert.throws(() => parseWalletFxTransferQuote(corrupt, 'A', request, 'KRW'), WalletTransferContractError);
  const result = { tradingAccountId: 'A', quoteId: quote.quoteId, commandId: 'command', transferId: 'transfer', executedAt: quote.rateCapturedAt,
    sourceAmount: quote.sourceAmount, receivedAmount: quote.netTargetAmount,
    source: { walletId: 'krw', walletScope: 'securities', currencyCode: 'KRW', balanceAfter: '100000.00000000', availableAfter: '50000.00000000' },
    destination: { walletId: 'spot', walletScope: 'crypto_spot', currencyCode: 'USD', balanceAfter: '99.90000000', availableAfter: '99.90000000' },
    fx: { ...quote, exchangeId: 'exchange', quotedRate: quote.appliedRate } };
  assert.equal(parseWalletFxTransferResponse(result, 'A', quote), result);
  for (const corrupt of [
    { ...result, tradingAccountId: 'B' }, { ...result, quoteId: 'other' }, { ...result, receivedAmount: '100.00000000' },
    { ...result, source: { ...result.source, walletScope: 'crypto_spot' } }, { ...result, destination: { ...result.destination, walletScope: 'securities' } },
    { ...result, destination: { ...result.destination, walletId: 'foreign' } }, { ...result, source: { ...result.source, availableAfter: '100001.00000000' } },
    { ...result, fx: { ...result.fx, feeRate: '0.020000' } }, { ...result, fx: { ...result.fx, sourceAmount: '1.00000000' } },
  ]) assert.throws(() => parseWalletFxTransferResponse(corrupt, 'A', quote), WalletTransferContractError);
});
