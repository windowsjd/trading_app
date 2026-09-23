import { spawnSync } from 'node:child_process';

// The child has the strict Node policy and no unhandledRejection listener.
// Only the timer delay and snapshot provider are replaced, not the callback.
const RUNNER = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const filename = path.resolve('src/realtime/asset-ticker.gateway.ts');
let source = fs.readFileSync(filename, 'utf8');
if (process.env.LEGACY_POLL === '1') {
  source = source.replace('void this.runTickerPoll();', 'void this.pushChangedTickers();');
  const assetBoundary = /let ticker:[\s\S]+?continue;\s*\}/;
  if (!assetBoundary.test(source)) throw new Error('missing mutation target');
  source = source.replace(assetBoundary, 'const ticker = await this.buildSnapshotTickerMessage(assetId);');
}
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  experimentalDecorators: true, emitDecoratorMetadata: true,
} }).outputText;
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(compiled, filename);
const { AssetTickerGateway } = loaded.exports;
const interval = global.setInterval;
global.setInterval = (fn, delay) => interval(fn, delay === 3000 ? 5 : delay);
let reads = 0;
const events = { subscribe: () => () => undefined };
const assets = { getAssetPriceForTicker: async () => {
  reads++;
  if (reads === 3) setImmediate(() => {
    gateway.onModuleDestroy(); clearTimeout(deadline); console.log('poll survived and retried');
  });
  throw new Error('synthetic snapshot failure');
} };
const gateway = new AssetTickerGateway({}, {}, {}, assets, {}, events, events);
gateway.clients.set({ readyState: 1, bufferedAmount: 0, send() {} }, {
  subscriptions: new Map([['asset-A', null]]), pendingTickers: new Map(),
  candleSubscriptions: new Map(), pendingCandles: new Map(),
  orderBookSubscriptions: new Map(), pendingOrderBooks: new Map(),
});
const deadline = setTimeout(() => { gateway.onModuleDestroy(); process.exitCode = 2; }, 2000);
gateway.onModuleInit();
`;

describe('ticker fallback process rejection policy', () => {
  it.each([false, true])(
    'strict child process, legacy behavior=%s',
    (legacy) => {
      const result = spawnSync(
        process.execPath,
        ['--unhandled-rejections=strict', '--import', 'tsx', '-e', RUNNER],
        {
          cwd: process.cwd(),
          env: { ...process.env, LEGACY_POLL: legacy ? '1' : '0' },
          encoding: 'utf8',
          timeout: 15000,
        },
      );
      if (legacy) {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('synthetic snapshot failure');
      } else {
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('poll survived and retried');
        expect(result.stderr).toBe('');
      }
    },
  );
});
