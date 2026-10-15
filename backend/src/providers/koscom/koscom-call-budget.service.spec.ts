import { Logger } from '@nestjs/common';
import {
  KoscomCallBudgetService,
  koscomCallKeys,
  koscomQuotaDay,
  koscomQuotaMonth,
} from './koscom-call-budget.service';

describe('KOSCOM quota day', () => {
  it('turns over at 09:00 KST (00:00 UTC), not at KST midnight', () => {
    expect(koscomQuotaDay(new Date('2026-10-15T08:59:59.999+09:00'))).toBe(
      '2026-10-14',
    );
    expect(koscomQuotaDay(new Date('2026-10-15T09:00:00.000+09:00'))).toBe(
      '2026-10-15',
    );
    expect(koscomQuotaDay(new Date('2026-10-16T00:30:00.000+09:00'))).toBe(
      '2026-10-15',
    );
    expect(koscomQuotaMonth('2026-10-31')).toBe('2026-10');
  });

  it('keys one namespace into one cluster slot and never embeds secrets', () => {
    const keys = koscomCallKeys('ns1', new Date('2026-11-02T01:00:00Z'));
    expect(keys).toEqual({
      day: 'koscom:{ns1}:calls:day:2026-11-02',
      month: 'koscom:{ns1}:calls:month:2026-11',
      quota: 'koscom:{ns1}:calls:quota:2026-11-02',
    });
  });
});

describe('KoscomCallBudgetService', () => {
  const at = new Date('2026-10-15T01:00:00Z');

  it('increments the category and total of the quota day and month in one script', async () => {
    const redis = { eval: jest.fn().mockResolvedValue(1) };
    const service = new KoscomCallBudgetService(redis as never);
    await expect(service.recordAttempt('ns', 'minute', at)).resolves.toBe(true);
    const [, keys, args] = redis.eval.mock.calls[0] as [
      string,
      string[],
      string[],
    ];
    expect(keys).toEqual([
      'koscom:{ns}:calls:day:2026-10-15',
      'koscom:{ns}:calls:month:2026-10',
    ]);
    expect(args[0]).toBe('minute');
  });

  it('swallows counter-store failures so observation never fails a call', async () => {
    const redis = { eval: jest.fn().mockRejectedValue(new Error('down')) };
    const service = new KoscomCallBudgetService(redis as never);
    await expect(service.recordAttempt('ns', 'price', at)).resolves.toBe(false);
    await expect(
      service.recordQuotaHeaders('ns', {
        limitDay: 50000,
        remainingDay: 1,
        observedAt: at,
      }),
    ).resolves.toBe(false);
  });

  it('reads counters and the lowest remaining-quota header of the day', async () => {
    const redis = {
      eval: jest.fn((_script: string, keys: string[]) =>
        Promise.resolve(
          keys[0].includes(':day:')
            ? ['price', '120', 'minute', '7', 'total', '127', 'bogus', 'x']
            : ['remainingMin', '33540', 'limit', '50000', 'observedAt', 'iso'],
        ),
      ),
    };
    const service = new KoscomCallBudgetService(redis as never);
    const snapshot = await service.readQuotaDay('ns', at);
    expect(snapshot.quotaDay).toBe('2026-10-15');
    expect(snapshot.counts.price).toBe(120);
    expect(snapshot.counts.minute).toBe(7);
    expect(snapshot.counts.total).toBe(127);
    expect(snapshot.counts.loc).toBe(0);
    expect(snapshot.headerRemainingMin).toBe(33540);
    expect(snapshot.headerLimit).toBe(50000);
  });
});

describe('KOSCOM budget governor admission (stage 3c)', () => {
  // 01:00 KST after the 10-15 session: no reservations, so P2 = hard cap.
  const night = new Date('2026-10-15T16:00:00Z');
  const caps = { dailyCap: 50_000, monthlyCap: 1_000_000 };
  const redisWith = (admitResult: unknown, total = '100') => {
    const evals: { keys: string[]; args: string[] }[] = [];
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      eval: jest.fn((script: string, keys: string[], args: string[] = []) => {
        if (script.includes('HGETALL'))
          return Promise.resolve(
            keys[0].includes(':quota:') ? [] : ['total', total],
          );
        evals.push({ keys, args });
        return admitResult instanceof Error
          ? Promise.reject(admitResult)
          : Promise.resolve(admitResult);
      }),
    };
    return { redis, evals };
  };

  it('checks and counts atomically against the priority limit and maps the script result', async () => {
    const { redis, evals } = redisWith(0);
    const service = new KoscomCallBudgetService(redis as never);
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    await expect(
      service.admitAttempt({
        namespace: 'ns',
        category: 'loc',
        enforce: true,
        caps,
        now: night,
      }),
    ).resolves.toBe('denied');
    expect(evals[0].keys).toEqual([
      'koscom:{ns}:calls:day:2026-10-15',
      'koscom:{ns}:calls:month:2026-10',
      'koscom:{ns}:calls:quota:2026-10-15',
    ]);
    // [category, day ttl, month ttl, limit (P2 = hard 49,000), enforce]
    expect(evals[0].args[0]).toBe('loc');
    expect(evals[0].args[3]).toBe('49000');
    expect(evals[0].args[4]).toBe('1');
    // Denials alert at most once a minute per category.
    await service.admitAttempt({
      namespace: 'ns',
      category: 'loc',
      enforce: true,
      caps,
      now: new Date(night.getTime() + 30_000),
    });
    const alerts = warn.mock.calls.filter((call) =>
      String(call[0]).includes('koscom_budget_denied'),
    );
    expect(alerts.length).toBe(1);
    warn.mockRestore();

    const admitted = redisWith(1);
    await expect(
      new KoscomCallBudgetService(admitted.redis as never).admitAttempt({
        namespace: 'ns',
        category: 'backfill',
        enforce: true,
        caps,
        now: night,
      }),
    ).resolves.toBe('admitted');
    expect(admitted.evals[0].args[3]).toBe('45000');
  });

  it('only records the decision in shadow mode and never fails the call there', async () => {
    const shadow = redisWith(2);
    const service = new KoscomCallBudgetService(shadow.redis as never);
    await expect(
      service.admitAttempt({
        namespace: 'ns',
        category: 'minute',
        enforce: false,
        caps,
        now: night,
      }),
    ).resolves.toBe('shadow_denied');
    expect(shadow.evals[0].args[4]).toBe('0');

    const down = redisWith(new Error('down'));
    await expect(
      new KoscomCallBudgetService(down.redis as never).admitAttempt({
        namespace: 'ns',
        category: 'minute',
        enforce: false,
        caps,
        now: night,
      }),
    ).resolves.toBe('admitted');
    await expect(
      new KoscomCallBudgetService(down.redis as never).admitAttempt({
        namespace: 'ns',
        category: 'minute',
        enforce: true,
        caps,
        now: night,
      }),
    ).rejects.toThrow('down');
  });

  it('recomputes limits at most once a second and at the 09:00 KST quota turnover', async () => {
    const { redis } = redisWith(1);
    const service = new KoscomCallBudgetService(redis as never);
    const reads = () =>
      (redis.eval.mock.calls as unknown[][]).filter((call) =>
        String(call[0]).includes('HGETALL'),
      ).length;
    await service.limits('ns', caps, night);
    const first = reads();
    await service.limits('ns', caps, new Date(night.getTime() + 999));
    expect(reads()).toBe(first);
    await service.limits('ns', caps, new Date(night.getTime() + 1_000));
    expect(reads()).toBe(2 * first);
    // 08:59:59.900 → 09:00:00.100 KST: a new quota day is never served
    // from the previous day's cache.
    await service.limits('ns', caps, new Date('2026-10-15T23:59:59.900Z'));
    await service.limits('ns', caps, new Date('2026-10-16T00:00:00.100Z'));
    expect(reads()).toBe(4 * first);
  });
});
