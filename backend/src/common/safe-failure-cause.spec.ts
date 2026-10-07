import { classifyFailureCause } from './safe-failure-cause';

describe('safe failure classification', () => {
  it.each([
    ['P2002', 'db_unique_constraint'],
    ['P1001', 'db_connection_failed'],
    ['P2034', 'db_transaction_conflict'],
    ['40P01', 'db_deadlock'],
    ['PROVIDER_TIMEOUT', 'provider_timeout'],
  ])(
    'retains observed classification for %s without its payload',
    (code, category) => {
      expect(
        classifyFailureCause(
          Object.assign(new Error('fake-private-value'), { code }),
        ),
      ).toEqual({ category, code, errorType: 'Error' });
    },
  );

  it('classifies a known DB type without inventing a specific root cause', () => {
    const error = Object.assign(new Error('private connection failure'), {
      name: 'PrismaClientInitializationError',
    });
    expect(classifyFailureCause(error)).toEqual({
      category: 'database_failure',
      errorType: 'PrismaClientInitializationError',
    });
  });

  it('does not trust arbitrary codes, names, messages or nested cause strings', () => {
    const error = Object.assign(
      new Error('exact balance 298327.448899', {
        cause: 'https://provider.invalid/fake-secret',
      }),
      { code: 'private-code', name: 'private-name' },
    );
    expect(classifyFailureCause(error)).toEqual({
      category: 'unexpected_error',
      errorType: 'Error',
    });
  });

  it('keeps only observed nested cause classification and bounds cyclic causes', () => {
    const inner = Object.assign(new Error('private cause'), { code: 'P1002' });
    expect(
      classifyFailureCause(new Error('private wrapper', { cause: inner })),
    ).toEqual({ category: 'db_timeout', code: 'P1002', errorType: 'Error' });
    const cyclic = new Error('private cycle');
    cyclic.cause = cyclic;
    expect(classifyFailureCause(cyclic)).toEqual({
      category: 'unexpected_error',
      errorType: 'Error',
    });
  });
});
