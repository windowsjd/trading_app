import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTransferAmount, transferAmountFits, transferAvailableAmount, parseWalletTransferResponse, WalletTransferContractError } from './walletTransfer.ts';

test('amount and available cash preserve eight decimal digits without spending reservations', () => {
  assert.equal(parseTransferAmount(' 0500.10000000 '), '500.10000000');
  assert.equal(parseTransferAmount('0.00000001'), '0.00000001');
  for (const value of ['0', '-1', 'NaN', 'Infinity', '1e3', '1.000000001', '10000000000000000', '1,000']) assert.equal(parseTransferAmount(value), null);
  const wallet = { currencyCode: 'USD' as const, walletScope: 'crypto_spot' as const, balanceAmount: '1000.00000001', reservedAmount: '300' };
  const available = transferAvailableAmount(wallet);
  assert.equal(available, '700.00000001'); assert.equal(transferAmountFits('700.00000001', available), true);
  assert.equal(transferAmountFits('700.00000002', available), false);
  assert.equal(transferAvailableAmount({ ...wallet, reservedAmount: '1001' }), null);
  assert.equal(transferAvailableAmount({ ...wallet, currencyCode: 'KRW' }), null);
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
