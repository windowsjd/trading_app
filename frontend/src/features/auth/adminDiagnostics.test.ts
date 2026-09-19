import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { AdminDiagnosticDto } from '../../models/dto/common.ts';
import { getApiErrorDiagnostic } from '../../services/api/errorMapper.ts';
import { shouldShowAdminDiagnostic } from './adminDiagnostics.ts';

const diagnostic: AdminDiagnosticDto = {
  version: 1,
  code: 'PRICE_STALE',
  httpStatus: 503,
  timestamp: '2026-09-14T06:30:25.000Z',
  requestId: 'request-1',
  domain: 'ORDER',
  operation: 'ORDER_CREATE',
  failureStage: 'execution_price_selection',
  exception: {
    type: 'HttpException',
    message: 'Provider asset price is stale.',
    applicationStack: ['backend/src/orders/orders.service.ts:1:1'],
    stack: [],
    truncated: false,
  },
  diagnosticEvents: { events: [], truncated: false },
  serverLogs: { entries: [], truncated: false },
  truncated: false,
};

describe('admin inline diagnostics visibility', () => {
  it('shows only an admin diagnostic attached to an error', () => {
    assert.equal(shouldShowAdminDiagnostic('admin', diagnostic), true);
    assert.equal(shouldShowAdminDiagnostic('user', diagnostic), false);
    assert.equal(shouldShowAdminDiagnostic('operator', diagnostic), false);
    assert.equal(shouldShowAdminDiagnostic('admin', null), false);
  });

  it('extracts a valid diagnostic from the server error envelope', () => {
    const error = {
      response: {
        status: 503,
        data: { error: { code: 'PRICE_STALE', diagnostic } },
      },
    };
    assert.deepEqual(getApiErrorDiagnostic(error), diagnostic);
  });

  it('rejects malformed or absent diagnostic objects', () => {
    assert.equal(getApiErrorDiagnostic({ response: { data: {} } }), null);
    assert.equal(
      getApiErrorDiagnostic({
        response: { data: { error: { diagnostic: { version: 1 } } } },
      }),
      null,
    );
  });

  it('keeps the inline panel collapsed, bounded on narrow layouts, and attached to error surfaces', () => {
    const read = (sourcePath: string) =>
      readFileSync(path.join(process.cwd(), 'src', sourcePath), 'utf8');
    const panel = read('components/states/AdminDiagnosticPanel.tsx');

    assert.match(panel, /useState\(false\)/u);
    assert.match(panel, /accessibilityState=\{\{ expanded \}\}/u);
    assert.match(panel, /flexShrink:\s*1/u);
    assert.match(panel, /minWidth:\s*0/u);
    assert.doesNotMatch(panel, /horizontal/u);
    assert.match(panel, /title="진단 이벤트"/u);
    assert.match(panel, /title="관련 Server Logs"/u);
    assert.match(panel, /serverLogs\.entries/u);

    for (const sourcePath of [
      'screens/home/PortfolioScreen.tsx',
      'screens/order/OrderPanel.tsx',
      'screens/wallet/WalletFxScreen.tsx',
      'screens/asset/AccountHoldings.tsx',
    ]) {
      assert.match(read(sourcePath), /AdminDiagnosticPanel/u, sourcePath);
    }
  });
});
