jest.mock('../../generated/prisma/client', () => ({
  Prisma: {},
  PrismaClient: class PrismaClient {},
}));
import {
  TIINGO_COLLECTOR_LEASE_KEY,
  TiingoCollectorLeaseService,
} from './tiingo-collector-lease.service';

function setup(
  options: { trialMode?: boolean; enabled?: boolean } = {},
  acquire: jest.Mock = jest.fn(),
  extend: jest.Mock = jest.fn(),
) {
  const release = jest.fn().mockResolvedValue(true);
  const stream = { start: jest.fn(), stop: jest.fn() };
  const service = new TiingoCollectorLeaseService(
    {
      getConfig: () => ({
        enabled: options.enabled ?? true,
        trialMode: options.trialMode ?? false,
      }),
    } as never,
    { acquire, extend, release } as never,
    stream as never,
  );
  return { service, stream, acquire, extend, release };
}

describe('TiingoCollectorLeaseService (official mode, one collector)', () => {
  afterEach(() => jest.useRealTimers());

  it('opens the socket only after acquiring the lease, and closes it when the lease is lost', async () => {
    jest.useFakeTimers();
    const lock = { key: TIINGO_COLLECTOR_LEASE_KEY, token: 't', ttlMs: 30_000 };
    const { service, stream, acquire, extend } = setup(
      {},
      jest.fn().mockResolvedValue({ status: 'acquired', lock }),
      jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
    );
    await service.cycle();
    expect(acquire).toHaveBeenCalledWith(TIINGO_COLLECTOR_LEASE_KEY, 30_000);
    expect(service.owned()).toBe(true);
    expect(service.getStatus().state).toBe('owner');
    expect(stream.start).toHaveBeenCalledTimes(1);
    await service.cycle();
    expect(service.owned()).toBe(true);
    await service.cycle();
    expect(extend).toHaveBeenCalledTimes(2);
    expect(service.owned()).toBe(false);
    expect(stream.stop).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toMatchObject({
      state: 'standby',
      lastErrorCode: 'TIINGO_COLLECTOR_LEASE_LOST',
    });
    await service.onModuleDestroy();
  });

  it('stays on standby while another instance holds the lease, and fails closed without Redis', async () => {
    jest.useFakeTimers();
    const busy = setup({}, jest.fn().mockResolvedValue({ status: 'busy' }));
    await busy.service.cycle();
    expect(busy.service.owned()).toBe(false);
    expect(busy.service.getStatus().state).toBe('standby');
    expect(busy.stream.start).not.toHaveBeenCalled();
    await busy.service.onModuleDestroy();

    const down = setup({}, jest.fn().mockResolvedValue({ status: 'error' }));
    await down.service.cycle();
    expect(down.service.getStatus()).toMatchObject({
      state: 'unavailable',
      lastErrorCode: 'TIINGO_COLLECTOR_LEASE_UNAVAILABLE',
    });
    expect(down.stream.start).not.toHaveBeenCalled();
    await down.service.onModuleDestroy();

    // An owner whose renewal throws stops collecting at once.
    const lock = { key: TIINGO_COLLECTOR_LEASE_KEY, token: 't', ttlMs: 30_000 };
    const flaky = setup(
      {},
      jest.fn().mockResolvedValue({ status: 'acquired', lock }),
      jest.fn().mockRejectedValue(new Error('redis down')),
    );
    await flaky.service.cycle();
    await flaky.service.cycle();
    expect(flaky.service.owned()).toBe(false);
    expect(flaky.stream.stop).toHaveBeenCalledTimes(1);
    await flaky.service.onModuleDestroy();
  });

  it('takes no lease in trial mode or when Tiingo is off', () => {
    for (const options of [{ trialMode: true }, { enabled: false }]) {
      const { service, acquire } = setup(options);
      service.onModuleInit();
      expect(acquire).not.toHaveBeenCalled();
      expect(service.getStatus().state).toBe('disabled');
    }
  });

  it('releases a held lease on shutdown', async () => {
    jest.useFakeTimers();
    const lock = { key: TIINGO_COLLECTOR_LEASE_KEY, token: 't', ttlMs: 30_000 };
    const { service, release } = setup(
      {},
      jest.fn().mockResolvedValue({ status: 'acquired', lock }),
    );
    await service.cycle();
    await service.onModuleDestroy();
    expect(release).toHaveBeenCalledWith(lock);
    expect(service.owned()).toBe(false);
  });
});
