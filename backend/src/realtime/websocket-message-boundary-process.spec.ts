import { spawnSync } from 'node:child_process';
// Execute the actual Gateway source under strict Node rejection policy. Legacy
// mode replaces only the message listener with the exact pre-fix listener.
const RUNNER = String.raw`
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript');
const filename = path.resolve('src/realtime/asset-ticker.gateway.ts');
let source = fs.readFileSync(filename, 'utf8');
if (process.env.LEGACY_MESSAGE === '1') {
  const boundary = /void this.handleMessage\(client, rawMessage\)\.catch\(\(\) => \{[\s\S]*?\n      \}\);/;
  if (!boundary.test(source)) throw new Error('missing message boundary mutation target');
  source = source.replace(boundary, 'void this.handleMessage(client, rawMessage);');
}
const compiled = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true, emitDecoratorMetadata: true}}).outputText;
const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename)); loaded._compile(compiled, filename);
const { AssetTickerGateway } = loaded.exports;
const { EventEmitter } = require('node:events');
const assets = { getAssetPriceForTicker: async () => { throw new Error('TC_E01_DB_FAILURE'); } };
const gateway = new AssetTickerGateway({user:{findUnique:async()=>({status:'active'})}}, {verifyAsync:async()=>({sub:'user'})}, {get:()=> 'test-secret'}, assets, {}, {});
const messages = [];
const socket = Object.assign(new EventEmitter(), {readyState:1, bufferedAmount:0, send(raw){messages.push(JSON.parse(raw));},close(){}});
(async()=> {
  await gateway.handleConnection(socket, {url:'/',headers:{authorization:'Bearer test'}});
  socket.emit('message', Buffer.from(JSON.stringify({type:'subscribe',channel:'asset_ticker',assetId:'asset'})));
  setTimeout(()=> {
    if (messages.length !== 1 || messages[0].code !== 'SUBSCRIPTION_FAILED') process.exitCode = 2;
    else console.log('message boundary survived identical DB failure');
  }, 100);
})();
`;
describe('TC-E01 before/after identical strict child DB failure', () => {
  it.each([true, false])('legacy message listener=%s', (legacy) => {
    const result = spawnSync(
      process.execPath,
      [
        '--unhandled-rejections=strict',
        '--max-old-space-size=512',
        '--import',
        'tsx',
        '-e',
        RUNNER,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LEGACY_MESSAGE: legacy ? '1' : '0' },
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    expect(result.status).toBe(legacy ? 1 : 0);
    if (legacy) expect(result.stderr).toContain('TC_E01_DB_FAILURE');
    else {
      expect(result.stdout).toContain(
        'message boundary survived identical DB failure',
      );
      expect(result.stdout + result.stderr).not.toContain('TC_E01_DB_FAILURE');
    }
  });
});
