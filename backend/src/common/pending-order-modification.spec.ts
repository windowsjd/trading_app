import {
  assertExpectedRevision,
  assertTermsChanged,
  evidenceFloor,
  isReplayedModification,
  modificationHash,
  parseModificationEnvelope,
  recordModification,
} from './pending-order-modification';
import { apiErrorCode } from './api-error-code';

const codeOf = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    return apiErrorCode(error, 'UNKNOWN');
  }
  return 'RESOLVED';
};
const codeOfAsync = async (work: () => Promise<unknown>) => {
  try {
    await work();
  } catch (error) {
    return apiErrorCode(error, 'UNKNOWN');
  }
  return 'RESOLVED';
};

describe('pending order modification envelope', () => {
  it('needs a well-formed key and the revision the change was made from', () => {
    expect(
      parseModificationEnvelope({
        idempotencyKey: 'modify-12345678',
        expectedRevision: 0,
      }),
    ).toEqual({ idempotencyKey: 'modify-12345678', expectedRevision: 0 });
    for (const body of [
      undefined,
      {},
      { idempotencyKey: 'short', expectedRevision: 0 },
      { idempotencyKey: 'modify 12345678', expectedRevision: 0 },
    ])
      expect(codeOf(() => parseModificationEnvelope(body))).toBe(
        'INVALID_IDEMPOTENCY_KEY',
      );
    for (const expectedRevision of [undefined, -1, 1.5, '0', 1_000_001])
      expect(
        codeOf(() =>
          parseModificationEnvelope({
            idempotencyKey: 'modify-12345678',
            expectedRevision,
          }),
        ),
      ).toBe('INVALID_PENDING_ORDER_MODIFICATION');
  });

  it('hashes the target, the revision changed from and the terms', () => {
    const base = modificationHash('conditional_buy', 'id-1', 0, {
      triggerPrice: '90.00000000',
    });
    expect(
      modificationHash('conditional_buy', 'id-1', 0, {
        triggerPrice: '90.00000000',
      }),
    ).toBe(base);
    expect(
      modificationHash('conditional_buy', 'id-1', 1, {
        triggerPrice: '90.00000000',
      }),
    ).not.toBe(base);
    expect(
      modificationHash('conditional_buy', 'id-2', 0, {
        triggerPrice: '90.00000000',
      }),
    ).not.toBe(base);
    expect(
      modificationHash('conditional_sell', 'id-1', 0, {
        triggerPrice: '90.00000000',
      }),
    ).not.toBe(base);
    expect(
      modificationHash('conditional_buy', 'id-1', 0, {
        triggerPrice: '91.00000000',
      }),
    ).not.toBe(base);
  });
});

describe('pending order modification guards', () => {
  it('a changed revision and identical terms are refused', () => {
    expect(codeOf(() => assertExpectedRevision(2, 1))).toBe(
      'PENDING_ORDER_CHANGED',
    );
    expect(codeOf(() => assertExpectedRevision(1, 1))).toBe('RESOLVED');
    expect(
      codeOf(() =>
        assertTermsChanged({ a: '1', b: null }, { a: '1', b: null }),
      ),
    ).toBe('PENDING_ORDER_UNCHANGED');
    expect(
      codeOf(() =>
        assertTermsChanged({ a: '1', b: null }, { a: '2', b: null }),
      ),
    ).toBe('RESOLVED');
  });

  it('replays only the exact committed change under its key', async () => {
    const committed = {
      requestHash: 'h1',
      targetType: 'spot_order',
      targetId: 'o1',
    };
    const tx = {
      pendingOrderModification: {
        findUnique: jest.fn().mockResolvedValue(committed),
        create: jest.fn(),
      },
    };
    const input = {
      accountId: 'a1',
      target: 'spot_order' as const,
      targetId: 'o1',
      idempotencyKey: 'k-12345678',
      requestHash: 'h1',
    };
    await expect(isReplayedModification(tx, input)).resolves.toBe(true);
    for (const patch of [
      { requestHash: 'h2' },
      { targetId: 'o2' },
      { target: 'futures_limit_order' as const },
    ])
      expect(
        await codeOfAsync(() =>
          isReplayedModification(tx, { ...input, ...patch }),
        ),
      ).toBe('PENDING_ORDER_MODIFY_IDEMPOTENCY_CONFLICT');
    tx.pendingOrderModification.findUnique.mockResolvedValue(null);
    await expect(isReplayedModification(tx, input)).resolves.toBe(false);
  });

  it('records the change with its terms before and after, at the change time', async () => {
    const tx = {
      pendingOrderModification: { findUnique: jest.fn(), create: jest.fn() },
    };
    const at = new Date('2026-11-05T01:00:00.000Z');
    await recordModification(tx, {
      accountId: 'a1',
      target: 'futures_tp_sl',
      targetId: 's1',
      idempotencyKey: 'k-12345678',
      requestHash: 'h',
      revision: 3,
      before: { triggerPrice: '90.00000000' },
      after: { triggerPrice: '85.00000000' },
      at,
    });
    expect(tx.pendingOrderModification.create).toHaveBeenCalledWith({
      data: {
        tradingAccountId: 'a1',
        targetType: 'futures_tp_sl',
        targetId: 's1',
        idempotencyKey: 'k-12345678',
        requestHash: 'h',
        revision: 3,
        beforeJson: { triggerPrice: '90.00000000' },
        afterJson: { triggerPrice: '85.00000000' },
        createdAt: at,
      },
    });
  });

  it('a key that lost a race on another target is the conflict a replay would get, not a 500', async () => {
    const record = (create: jest.Mock) =>
      codeOfAsync(() =>
        recordModification(
          { pendingOrderModification: { findUnique: jest.fn(), create } },
          {
            accountId: 'a1',
            target: 'spot_order',
            targetId: 'o2',
            idempotencyKey: 'k-12345678',
            requestHash: 'h2',
            revision: 1,
            before: {},
            after: {},
            at: new Date(),
          },
        ),
      );
    const unique = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
    });
    expect(await record(jest.fn().mockRejectedValue(unique))).toBe(
      'PENDING_ORDER_MODIFY_IDEMPOTENCY_CONFLICT',
    );
    // Any other failure stays what it was.
    const other = Object.assign(new Error('deadlock'), { code: 'P2034' });
    await expect(
      recordModification(
        {
          pendingOrderModification: {
            findUnique: jest.fn(),
            create: jest.fn().mockRejectedValue(other),
          },
        },
        {
          accountId: 'a1',
          target: 'spot_order',
          targetId: 'o2',
          idempotencyKey: 'k-12345678',
          requestHash: 'h2',
          revision: 1,
          before: {},
          after: {},
          at: new Date(),
        },
      ),
    ).rejects.toBe(other);
  });
});

describe('evidence floor', () => {
  const registered = new Date('2026-11-05T01:00:00.000Z');
  it('is the latest change after registration, else the registration', () => {
    expect(evidenceFloor({ revisedAt: null }, registered)).toBe(registered);
    expect(evidenceFloor({}, registered)).toBe(registered);
    const changed = new Date('2026-11-05T01:05:00.000Z');
    expect(evidenceFloor({ revisedAt: changed }, registered)).toBe(changed);
    // A clock that stepped back can never move the floor before the registration.
    expect(
      evidenceFloor(
        { revisedAt: new Date('2026-11-05T00:59:00.000Z') },
        registered,
      ),
    ).toBe(registered);
  });
});
