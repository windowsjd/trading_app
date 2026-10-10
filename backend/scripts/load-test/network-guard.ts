import net from 'node:net';
import dns from 'node:dns/promises';
import type { Manifest } from './manifest';

/** Defense in depth against missed provider transports (http/https/ws/net).
 * Installed only by isolated executables, before any application import.
 * It never exists in the production entry point. */
export async function installNetworkGuard(
  m: Manifest,
  onBlocked: () => void,
  generator = false,
  renderObserver = false,
) {
  const entries = [
    { host: m.target.databaseHost, port: m.target.databasePort },
    { host: m.target.valkeyHost, port: m.target.valkeyPort },
  ];
  if (generator && m.target.databaseObserverHost)
    entries.push({
      host: m.target.databaseObserverHost,
      port: m.target.databaseObserverPort ?? m.target.databasePort,
    });
  if (generator && m.target.valkeyObserverHost)
    entries.push({
      host: m.target.valkeyObserverHost,
      port: m.target.valkeyObserverPort ?? m.target.valkeyPort,
    });
  if (generator) {
    const u = new URL(m.target.apiOrigin);
    entries.push({
      host: u.hostname,
      port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
    });
  }
  if (renderObserver) entries.push({ host: 'api.render.com', port: 443 });
  const allow = new Set<string>();
  for (const { host, port } of entries) {
    allow.add(`${host}:${port}`);
    for (const row of await dns.lookup(host.replace(/^\[|\]$/g, ''), {
      all: true,
    }))
      allow.add(`${row.address}:${port}`);
  }
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args: any[]) {
    // Node may pass its pre-normalized argument array internally.
    const values = Array.isArray(args[0]) ? args[0] : args;
    const opts =
      typeof values[0] === 'object'
        ? values[0]
        : {
            port: values[0],
            host: typeof values[1] === 'string' ? values[1] : 'localhost',
          };
    if (
      opts.path ||
      !allow.has(`${opts.host ?? 'localhost'}:${Number(opts.port)}`)
    ) {
      onBlocked();
      throw new Error('LOAD_TEST_NETWORK_BLOCKED');
    }
    return original.apply(this, args as any);
  } as typeof original;
  return () => {
    net.Socket.prototype.connect = original;
  };
}
