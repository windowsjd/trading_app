import { createApiError } from '../common/api-error';
import { projectOpsFailure } from './ops-failure';

describe('Ops failure trust boundary', () => {
  it.each([
    { code: 'FAKE_PRIVATE_TOKEN', message: 'raw private data 987654.12345678' },
    Object.assign(new Error('raw private data 987654.12345678'), {
      code: 'FAKE_PRIVATE_TOKEN',
    }),
  ])('rejects arbitrary object and SDK codes equally', (error) => {
    const failure = projectOpsFailure(error);
    expect(failure.code).toBe('OPS_JOB_FAILED');
    expect(failure.message).toBe('Background operation failed.');
    expect(JSON.stringify(failure)).not.toMatch(
      /FAKE_PRIVATE_TOKEN|987654|raw private/,
    );
    expect(projectOpsFailure(error, 'DECLARED_DOMAIN_FAILURE').code).toBe(
      'DECLARED_DOMAIN_FAILURE',
    );
  });
  it.each(['P2034', '23505', '40P01', 'PROVIDER_TIMEOUT'])(
    'retains only allowlisted observed cause %s',
    (code) => {
      expect(projectOpsFailure({ code, message: 'private' })).toMatchObject({
        code,
        safeCause: { code },
      });
    },
  );
  it('preserves explicit domain HTTP codes and validates caller fallbacks', () => {
    expect(
      projectOpsFailure(
        createApiError('DECLARED_DOMAIN_FAILURE', 'Price is stale.', 503),
      ),
    ).toMatchObject({
      code: 'DECLARED_DOMAIN_FAILURE',
      message: 'Price is stale.',
    });
    expect(
      projectOpsFailure({ code: 'FAKE_PRIVATE_TOKEN' }, 'postgres://private')
        .code,
    ).toBe('OPS_JOB_FAILED');
  });
});
