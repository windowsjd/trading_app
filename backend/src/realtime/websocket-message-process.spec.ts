import { spawnSync } from 'node:child_process';

describe('TC-E01 strict Node process with real WebSocket connections', () => {
  it('survives injected DB failures, retries, and cancels pending subscriptions', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--unhandled-rejections=strict',
        '--max-old-space-size=512',
        '--import',
        'tsx',
        'scripts/websocket-message-rejection-regression.ts',
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 20000,
      },
    );
    if (result.status !== 0)
      throw new Error(
        `Child status=${result.status}, signal=${result.signal}\n${result.stdout}${result.stderr}`,
      );
    expect(result.stdout).toContain(
      'websocket message rejection process survived',
    );
    expect(result.stderr).toBe('');
  }, 25000);
});
