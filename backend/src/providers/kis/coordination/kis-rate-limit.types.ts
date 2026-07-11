export type KisApiEnvironment = 'real' | 'virtual';
export type KisTrafficClass = 'oauth' | 'rest';

export class KisRateLimitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KisRateLimitConfigError';
  }
}

export class KisRateLimitQueueFullError extends Error {
  constructor() {
    super('KIS rate-limit local queue is full.');
    this.name = 'KisRateLimitQueueFullError';
  }
}

export class KisRateLimitWaitTimeoutError extends Error {
  constructor() {
    super('KIS rate-limit wait timeout exceeded.');
    this.name = 'KisRateLimitWaitTimeoutError';
  }
}

export class KisRateLimitShutdownError extends Error {
  constructor() {
    super('KIS request coordinator is shutting down.');
    this.name = 'KisRateLimitShutdownError';
  }
}
