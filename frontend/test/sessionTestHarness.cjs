// Real Axios interceptors, auth/session modules and QueryClient; only transport,
// native storage, navigation and hook rendering are controlled by the tests.
const { readFileSync, existsSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const ts = require('typescript');
const axios = require('axios');
const { QueryClient } = require('@tanstack/react-query');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function createSessionHarness({ mutateSource } = {}) {
  const files = new Map();
  const disk = new Map();
  const operations = [];
  const plans = new Map();
  const requests = [];
  const navigation = [];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const clear = queryClient.clear.bind(queryClient);
  queryClient.clear = () => {
    operations.push('cache.clear');
    clear();
  };
  let transport = async (config) => ({
    status: 200,
    data: { success: true, data: {} },
    headers: {},
    statusText: 'OK',
    config,
  });
  const http = axios.create({
    adapter: async (config) => {
      requests.push(config);
      return transport(config);
    },
  });
  http.isAxiosError = axios.isAxiosError;
  async function io(name, action) {
    operations.push(name);
    const plan = plans.get(name)?.shift();
    if (plan) {
      plan.entered.resolve();
      await plan.gate.promise;
    }
    return action();
  }
  const storage = {
    getItem: (key) => io(`get:${key}`, () => disk.get(key) ?? null),
    multiSet: (pairs) =>
      io('tokens.set', () => {
        for (const [k, v] of pairs) disk.set(k, v);
      }),
    multiRemove: (keys) =>
      io('tokens.remove', () => {
        for (const k of keys) disk.delete(k);
      }),
    setItem: (key, value) => io(`set:${key}`, () => disk.set(key, value)),
    removeItem: (key) => io(`remove:${key}`, () => disk.delete(key)),
  };
  const mocks = new Map([
    ['axios', http],
    ['@react-native-async-storage/async-storage', storage],
    [resolve('src/constants/env.ts'), { API_BASE_URL: 'http://fixture.invalid/api/v1' }],
  ]);
  function load(name) {
    const file = resolve(name);
    if (mocks.has(file)) return mocks.get(file);
    if (files.has(file)) return files.get(file).exports;
    const module = { exports: {} };
    files.set(file, module);
    let source = readFileSync(file, 'utf8');
    if (mutateSource) source = mutateSource(file, source);
    const code = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
      },
    }).outputText;
    const localRequire = (id) => {
      if (mocks.has(id)) return mocks.get(id);
      if (id.startsWith('.')) {
        let path = resolve(dirname(file), id);
        if (!existsSync(path)) path += existsSync(path + '.ts') ? '.ts' : '.tsx';
        return load(path);
      }
      return require(id);
    };
    new Function('require', 'module', 'exports', code)(
      localRequire,
      module,
      module.exports,
    );
    return module.exports;
  }
  const owner = load('src/services/api/sessionOwnership.ts');
  const tokens = load('src/services/storage/tokenStorage.ts');
  const expiry = load('src/services/api/sessionExpiry.ts');
  const session = load('src/features/auth/session.ts');
  const api = load('src/services/api/client.ts').apiClient;
  const auth = load('src/features/auth/api.ts');
  const keys = load('src/constants/queryKeys.ts').QUERY_KEYS;
  const resetToLogin = () => {
    operations.push('navigation.login');
    navigation.push('Login');
  };
  let expiryCalls = 0;
  let expiryDone = Promise.resolve();
  const attachExpiry = () =>
    expiry.setSessionExpiredHandler((generation) => {
      expiryCalls++;
      expiryDone = session.endSession(queryClient, undefined, {
        generation,
        resetToLogin,
      });
    });
  function block(name) {
    const plan = { entered: deferred(), gate: deferred() };
    plans.set(name, [...(plans.get(name) ?? []), plan]);
    return plan;
  }
  const user = (id) => ({
    id,
    email: `${id}@example.invalid`,
    nickname: id,
    role: 'user',
    status: 'active',
  });
  const credentials = (id) => ({
    accessToken: `${id}-access`,
    refreshToken: `${id}-refresh`,
  });
  const install = (id) => session.beginSession(queryClient, user(id), credentials(id));
  return {
    owner,
    tokens,
    expiry,
    session,
    api,
    auth,
    keys,
    queryClient,
    disk,
    operations,
    requests,
    navigation,
    storage,
    mocks,
    load,
    block,
    user,
    credentials,
    install,
    attachExpiry,
    resetToLogin,
    get expiryCalls() {
      return expiryCalls;
    },
    waitForExpiry: () => expiryDone,
    setTransport: (next) => {
      transport = next;
    },
    logout: () =>
      session.endSession(queryClient, queryClient.getQueryData(keys.me)?.id, {
        revoke: auth.logout,
        resetToLogin,
      }),
    ok: (config, data) => ({
      status: 200,
      data: { success: true, data },
      headers: {},
      statusText: 'OK',
      config,
    }),
    unauthorized: (config) =>
      new axios.AxiosError(
        '401',
        'ERR_BAD_REQUEST',
        config,
        {},
        { status: 401, data: {}, headers: {}, statusText: 'Unauthorized', config },
      ),
    close: () => {
      expiry.setSessionExpiredHandler(null);
      queryClient.clear();
    },
  };
}
module.exports = { createSessionHarness, deferred };
