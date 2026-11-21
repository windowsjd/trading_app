import type { MetaMeasurementSdk } from './controller';

/**
 * Web and Node have no Meta SDK (the native adapter is metaSdk.native.ts):
 * the measurement is unsupported there, so nothing is ever asked or sent.
 */
const unsupported = () => Promise.reject(new Error('Meta measurement needs an iOS or Android build.'));

export const metaSdk: MetaMeasurementSdk = {
  available: () => false,
  keepsWithdrawals: false,
  getTracking: () => Promise.resolve(null),
  requestTracking: () => Promise.resolve(null),
  start: unsupported,
  stop: unsupported,
};
