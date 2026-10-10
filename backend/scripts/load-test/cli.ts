import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  defaultManifest,
  gitIdentity,
  readInputs,
  ROOT,
  observerCredentials,
  isLocal,
} from './manifest';
import { Metrics, writeJson } from './metrics';
import { installNetworkGuard } from './network-guard';
import { preflight } from './preflight';

async function main() {
  const command = process.argv[2];
  const option = (name: string, fallback?: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
  };
  if (
    ![
      'template',
      'migrate',
      'guard',
      'serve',
      'prepare',
      'run',
      'audit',
    ].includes(command)
  )
    throw new Error(
      'Usage: load-test <template|migrate|guard|serve|prepare|run|audit> --manifest PATH --credentials PATH --out DIR [--fixture PATH] [--smoke]',
    );
  const manifestFile = resolve(option('manifest') ?? 'load-test.manifest.json');
  const credentialFile = resolve(
    option('credentials') ?? 'load-test.credentials.json',
  );
  if (command === 'template') {
    if (existsSync(manifestFile) || existsSync(credentialFile))
      throw new Error('TEMPLATE_REFUSES_OVERWRITE');
    const m = defaultManifest(
      gitIdentity().sha,
      process.argv.includes('--smoke'),
    );
    const secret = () => `load-test-${randomBytes(24).toString('hex')}`;
    writeJson(manifestFile, m);
    writeJson(credentialFile, {
      databaseUrl: `postgresql://${m.target.databaseUser}:load-test-local-only@${m.target.databaseHost}:${m.target.databasePort}/${m.target.databaseName}`,
      valkeyUrl: `redis://${m.target.valkeyHost}:${m.target.valkeyPort}/0`,
      jwtSecret: secret(),
      userPassword: secret(),
      controlSecret: secret(),
    });
    console.log('Template files created with mode 0600; no resources created.');
    return;
  }
  const inputs = readInputs(manifestFile, credentialFile);
  const { m, git, manifestHash } = inputs;
  const c = command === 'serve' ? inputs.c : observerCredentials(inputs.c);
  if (
    command === 'run' &&
    !isLocal(m) &&
    m.target.apiResourceId.startsWith('srv-') &&
    !c.renderApiKey
  )
    throw new Error('RENDER_RESOURCE_METRICS_CREDENTIAL_REQUIRED');
  const out = resolve(
    option('out') ?? resolve(ROOT, 'artifacts/load-test', m.runId, command),
  );
  mkdirSync(out, { recursive: true });
  if (existsSync(resolve(out, 'identity.json')))
    throw new Error('OUTPUT_REFUSES_OVERWRITE_USE_FRESH_DIRECTORY');
  const fixtureFile = resolve(
    option('fixture') ?? resolve(out, 'fixture.json'),
  );
  const metrics = new Metrics();
  if (command === 'migrate') {
    await preflight(m, c, false, true);
    // Guard BEFORE Prisma can connect. Existing migrations only, no seed or
    // schema change; this operation is explicit, never run by serve/run.
    execFileSync(
      resolve(ROOT, 'node_modules/.bin/prisma'),
      [
        'migrate',
        'deploy',
        '--config',
        resolve(ROOT, 'scripts/load-test/prisma.config.ts'),
      ],
      {
        cwd: ROOT,
        stdio: 'inherit',
        env: {
          PATH: process.env.PATH,
          LANG: process.env.LANG,
          LOAD_TEST_MANIFEST: manifestFile,
          LOAD_TEST_CREDENTIALS: credentialFile,
        },
      },
    );
    return;
  }
  const restore = await installNetworkGuard(
    m,
    () => metrics.failure('LOAD_TEST_NETWORK_BLOCKED'),
    command !== 'serve',
    !!c.renderApiKey,
  );
  try {
    writeJson(resolve(out, 'identity.json'), {
      git,
      manifestHash,
      command,
      target: m.target,
      profile: m.profile,
      at: new Date().toISOString(),
    });
    if (command === 'guard') {
      await preflight(m, c);
      console.log('Target guard PASS');
    } else if (command === 'serve') {
      const { serve } = require('./server');
      await serve(m, c, manifestHash, out, metrics);
    } else if (command === 'prepare') {
      const { prepare } = require('./prepare');
      await prepare(m, c, manifestHash, out, metrics);
      const { audit } = require('./audit');
      const fixture = JSON.parse(
        readFileSync(resolve(out, 'fixture.json'), 'utf8'),
      );
      const result = await audit(m, c, fixture, out);
      if (result.verdict !== 'CORRECTNESS PASS')
        throw new Error('PREPARE_FINANCIAL_AUDIT_FAILED');
      console.log('Fixture and starting financial audit PASS');
    } else if (command === 'run') {
      const { run } = require('./run');
      const result = await run(m, c, manifestHash, fixtureFile, out, metrics);
      console.log(
        JSON.stringify({
          validity: result.runValidity,
          correctness: result.correctness,
          performance: result.performance,
        }),
      );
      if (
        result.runValidity === 'INVALID RUN' ||
        result.correctness !== 'CORRECTNESS PASS' ||
        result.performance !== 'PERFORMANCE PASS'
      )
        process.exitCode = 1;
    } else if (command === 'audit') {
      const { audit } = require('./audit');
      const result = await audit(
        m,
        c,
        JSON.parse(readFileSync(fixtureFile, 'utf8')),
        out,
      );
      console.log(result.verdict);
      if (result.verdict !== 'CORRECTNESS PASS') process.exitCode = 1;
    }
  } finally {
    restore();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : 'LOAD_TEST_ERROR');
  process.exitCode = 1;
});
