import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.types';

const MAX_DIAGNOSTIC_EVENTS = 20;
const MAX_SERVER_LOG_ENTRIES = 20;
const MAX_STACK_FRAMES = 24;
const MAX_APPLICATION_STACK_FRAMES = 12;
const MAX_STRING_LENGTH = 1_000;
const MAX_COLLECTION_ITEMS = 30;
const MAX_OBJECT_DEPTH = 5;
const MAX_DIAGNOSTIC_BYTES = 24 * 1024;

type DiagnosticScalar = string | number | boolean | null;
type DiagnosticValue =
  | DiagnosticScalar
  | DiagnosticValue[]
  | { [key: string]: DiagnosticValue };

export type AdminDiagnosticLogEvent = {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  message: string;
  context?: Record<string, DiagnosticValue>;
};

export type AdminDiagnosticServerLogEntry = {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  context?: string;
  message: string;
  details?: DiagnosticValue[];
};

export type AdminDiagnostic = {
  version: 1;
  code: string;
  httpStatus: number;
  timestamp: string;
  requestId: string;
  domain: string;
  operation: string;
  failureStage: string;
  entities?: Record<string, DiagnosticValue>;
  evidence?: Record<string, DiagnosticValue>;
  exception: {
    type: string;
    message: string;
    cause?: string;
    applicationStack: string[];
    stack: string[];
    truncated: boolean;
  };
  diagnosticEvents: {
    events: AdminDiagnosticLogEvent[];
    truncated: boolean;
  };
  serverLogs: {
    entries: AdminDiagnosticServerLogEntry[];
    truncated: boolean;
  };
  nextInvestigation?: string[];
  truncated: boolean;
};

type RequestDiagnosticContext = {
  request: AuthenticatedRequest;
  requestId: string;
  requestEntities: Record<string, unknown>;
  requestNextInvestigation: string[];
  domain: string;
  operation: string;
  failureStage: string;
  entities: Record<string, unknown>;
  evidence: Record<string, unknown>;
  nextInvestigation: string[];
  events: Array<{
    timestamp: string;
    level: AdminDiagnosticLogEvent['level'];
    event: string;
    message: string;
    context?: Record<string, unknown>;
  }>;
  diagnosticEventsTruncated: boolean;
  serverLogs: Array<{
    timestamp: string;
    level: AdminDiagnosticServerLogEntry['level'];
    context?: string;
    message: string;
    details?: DiagnosticValue[];
  }>;
  serverLogsTruncated: boolean;
};

export type DiagnosticContextUpdate = {
  domain?: string;
  operation?: string;
  failureStage?: string;
  entities?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  nextInvestigation?: string[];
};

const requestDiagnostics = new AsyncLocalStorage<RequestDiagnosticContext>();

export function adminDiagnosticRequestMiddleware(
  request: AuthenticatedRequest,
  response: Response,
  next: NextFunction,
): void {
  const requestId = resolveRequestId(request.headers['x-request-id']);
  const route = inferRouteContext(request.method, request.originalUrl);
  const context: RequestDiagnosticContext = {
    request,
    requestId,
    requestEntities: { ...route.entities },
    requestNextInvestigation: [...route.nextInvestigation],
    domain: route.domain,
    operation: route.operation,
    failureStage: 'request_processing',
    entities: route.entities,
    evidence: {},
    nextInvestigation: route.nextInvestigation,
    events: [],
    diagnosticEventsTruncated: false,
    serverLogs: [],
    serverLogsTruncated: false,
  };

  response.setHeader('x-request-id', requestId);
  requestDiagnostics.run(context, () => {
    recordAdminDiagnosticEvent(
      'info',
      'HTTP_REQUEST_RECEIVED',
      `${request.method.toUpperCase()} ${safePath(request.originalUrl)}`,
    );
    next();
  });
}

export function setAdminDiagnosticContext(
  update: DiagnosticContextUpdate,
): void {
  const context = requestDiagnostics.getStore();
  if (!context) return;
  if (update.domain) context.domain = update.domain;
  if (update.operation) context.operation = update.operation;
  if (update.failureStage) context.failureStage = update.failureStage;
  if (update.entities) Object.assign(context.entities, update.entities);
  if (update.evidence) Object.assign(context.evidence, update.evidence);
  if (update.nextInvestigation) {
    context.nextInvestigation = unique([
      ...context.nextInvestigation,
      ...update.nextInvestigation,
    ]).slice(0, 8);
  }
}

export function recordAdminDiagnosticEvent(
  level: AdminDiagnosticLogEvent['level'],
  event: string,
  message: string,
  eventContext?: Record<string, unknown>,
): void {
  const context = requestDiagnostics.getStore();
  if (!context) return;
  if (context.events.length >= MAX_DIAGNOSTIC_EVENTS) {
    context.events.shift();
    context.diagnosticEventsTruncated = true;
  }
  context.events.push({
    timestamp: new Date().toISOString(),
    level,
    event,
    message,
    ...(eventContext ? { context: eventContext } : {}),
  });
}

export function recordAdminApplicationLog(
  level: AdminDiagnosticServerLogEntry['level'],
  message: unknown,
  optionalParams: unknown[] = [],
): void {
  const context = requestDiagnostics.getStore();
  if (!context || context.request.user?.role !== 'admin') return;
  if (context.serverLogs.length >= MAX_SERVER_LOG_ENTRIES) {
    context.serverLogs.shift();
    context.serverLogsTruncated = true;
  }
  const loggerContext =
    typeof optionalParams.at(-1) === 'string'
      ? (optionalParams.at(-1) as string)
      : undefined;
  const details = loggerContext ? optionalParams.slice(0, -1) : optionalParams;
  if (
    hasSanitizationLoss(message) ||
    hasSanitizationLoss(details) ||
    (loggerContext?.length ?? 0) > MAX_STRING_LENGTH
  ) {
    context.serverLogsTruncated = true;
  }
  context.serverLogs.push({
    timestamp: new Date().toISOString(),
    level,
    ...(loggerContext ? { context: sanitizeString(loggerContext) } : {}),
    message: sanitizeLogMessage(message),
    ...(details.length
      ? { details: sanitizeValue(details, 0) as DiagnosticValue[] }
      : {}),
  });
}

export function getAdminDiagnosticRequestId(): string | undefined {
  return requestDiagnostics.getStore()?.requestId;
}

export function isAdminDiagnosticRequest(): boolean {
  return requestDiagnostics.getStore()?.request.user?.role === 'admin';
}

export function buildAdminDiagnostic(
  exception: unknown,
  code: string,
  httpStatus: number,
  update?: DiagnosticContextUpdate,
): AdminDiagnostic | undefined {
  return buildAdminDiagnosticInternal(
    exception,
    code,
    httpStatus,
    update,
    false,
  );
}

function buildAdminDiagnosticInternal(
  exception: unknown,
  code: string,
  httpStatus: number,
  update: DiagnosticContextUpdate | undefined,
  isolateFailure: boolean,
): AdminDiagnostic | undefined {
  const context = requestDiagnostics.getStore();
  if (!context || context.request.user?.role !== 'admin') {
    return undefined;
  }
  if (update && !isolateFailure) setAdminDiagnosticContext(update);
  if (!isolateFailure && context.failureStage === 'request_processing') {
    context.failureStage = inferFailureStage(code);
  }

  const domain = isolateFailure
    ? (update?.domain ?? context.domain)
    : context.domain;
  const operation = isolateFailure
    ? (update?.operation ?? context.operation)
    : context.operation;
  const failureStage = isolateFailure
    ? (update?.failureStage ?? inferFailureStage(code))
    : context.failureStage;
  const entities = isolateFailure
    ? { ...context.requestEntities, ...update?.entities }
    : context.entities;
  const evidence = isolateFailure ? (update?.evidence ?? {}) : context.evidence;
  const nextInvestigation = isolateFailure
    ? unique([
        ...context.requestNextInvestigation,
        ...(update?.nextInvestigation ?? []),
      ]).slice(0, 8)
    : context.nextInvestigation;
  const serverLogSource = isolateFailure
    ? selectFailureRelatedServerLogs(context.serverLogs, update, code)
    : context.serverLogs;

  const failureEvent = {
    timestamp: new Date().toISOString(),
    level: 'error' as const,
    event: isolateFailure ? 'PARTIAL_FAILURE_RECORDED' : 'REQUEST_FAILED',
    message: `${code} (${httpStatus})`,
    context: {
      failureStage,
    },
  };
  let diagnosticEventSource = context.events;
  if (isolateFailure) {
    diagnosticEventSource = [
      ...context.events.filter(
        (event) => event.event === 'HTTP_REQUEST_RECEIVED',
      ),
      failureEvent,
    ];
  } else {
    recordAdminDiagnosticEvent(
      failureEvent.level,
      failureEvent.event,
      failureEvent.message,
      failureEvent.context,
    );
  }

  const exceptionDetails = describeException(exception);
  const contentTruncated =
    hasSanitizationLoss(entities) ||
    hasSanitizationLoss(evidence) ||
    diagnosticEventSource.some(
      (entry) =>
        entry.message.length > MAX_STRING_LENGTH ||
        hasSanitizationLoss(entry.context),
    ) ||
    serverLogSource.some(
      (entry) =>
        entry.message.length > MAX_STRING_LENGTH ||
        hasSanitizationLoss(entry.details),
    );

  const diagnostic: AdminDiagnostic = {
    version: 1,
    code: sanitizeString(code),
    httpStatus,
    timestamp: new Date().toISOString(),
    requestId: context.requestId,
    domain: sanitizeString(domain),
    operation: sanitizeString(operation),
    failureStage: sanitizeString(failureStage),
    ...(nonEmptyRecord(entities) ? { entities: sanitizeRecord(entities) } : {}),
    ...(nonEmptyRecord(evidence) ? { evidence: sanitizeRecord(evidence) } : {}),
    exception: exceptionDetails,
    diagnosticEvents: {
      events: diagnosticEventSource.map((entry) => ({
        timestamp: entry.timestamp,
        level: entry.level,
        event: sanitizeString(entry.event),
        message: sanitizeString(entry.message),
        ...(entry.context ? { context: sanitizeRecord(entry.context) } : {}),
      })),
      truncated: isolateFailure ? false : context.diagnosticEventsTruncated,
    },
    serverLogs: {
      entries: serverLogSource.map((entry) => ({
        timestamp: entry.timestamp,
        level: entry.level,
        ...(entry.context ? { context: entry.context } : {}),
        message: entry.message,
        ...(entry.details?.length ? { details: entry.details } : {}),
      })),
      truncated: context.serverLogsTruncated,
    },
    ...(nextInvestigation.length
      ? {
          nextInvestigation: nextInvestigation.map(sanitizeString),
        }
      : {}),
    truncated:
      context.diagnosticEventsTruncated ||
      context.serverLogsTruncated ||
      contentTruncated ||
      exceptionDetails.truncated,
  };

  return enforceTotalBound(diagnostic);
}

export function buildAdminPartialFailureDiagnostic(
  exception: unknown,
  code: string,
  update: DiagnosticContextUpdate,
): AdminDiagnostic | undefined {
  return buildAdminDiagnosticInternal(exception, code, 200, update, true);
}

function resolveRequestId(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  const normalized = candidate?.trim();
  return normalized && /^[A-Za-z0-9._:-]{1,100}$/u.test(normalized)
    ? normalized
    : randomUUID();
}

function inferRouteContext(method: string, originalUrl: string) {
  const path = safePath(originalUrl);
  const segments = path.split('/').filter(Boolean);
  const apiIndex = segments.findIndex((segment) => segment === 'v1');
  const route = apiIndex >= 0 ? segments.slice(apiIndex + 1) : segments;
  const entities: Record<string, unknown> = {};
  let domain = 'HTTP';
  let operation = `${method.toUpperCase()} ${path}`;
  let nextInvestigation = [
    'backend/src/common/global-http-exception.filter.ts',
  ];

  if (route[0] === 'trading-accounts' && route[1]) {
    entities.tradingAccountId = decodeSegment(route[1]);
    if (route[2] === 'orders') {
      domain = 'ORDER';
      operation = operationForOrders(method, route.slice(3));
      if (route[3] && route[3] !== 'quote')
        entities.orderId = decodeSegment(route[3]);
      nextInvestigation = ['backend/src/orders/orders.service.ts'];
    } else if (route[2] === 'fx') {
      domain = 'FX';
      operation = operationForFx(method, route.slice(3));
      nextInvestigation = ['backend/src/fx/fx.service.ts'];
    } else if (route[2] === 'portfolio') {
      domain = 'PORTFOLIO';
      operation =
        route[3] === 'equity' ? 'PORTFOLIO_EQUITY_READ' : 'PORTFOLIO_VALUATION';
      nextInvestigation = [
        'backend/src/portfolio/trading-account-portfolio.service.ts',
        'backend/src/portfolio/portfolio-valuation.service.ts',
      ];
    }
  } else if (route[0] === 'orders') {
    domain = 'ORDER';
    operation = operationForOrders(method, route.slice(1));
    if (route[1] && route[1] !== 'quote')
      entities.orderId = decodeSegment(route[1]);
    nextInvestigation = ['backend/src/orders/orders.service.ts'];
  } else if (route[0] === 'fx') {
    domain = 'FX';
    operation = operationForFx(method, route.slice(1));
    nextInvestigation = ['backend/src/fx/fx.service.ts'];
  } else if (route[0] === 'portfolio') {
    domain = 'PORTFOLIO';
    operation =
      route[1] === 'equity' ? 'PORTFOLIO_EQUITY_READ' : 'PORTFOLIO_VALUATION';
    nextInvestigation = ['backend/src/portfolio/portfolio.service.ts'];
  } else if (route[0] === 'assets' && route[1]) {
    entities.assetId = decodeSegment(route[1]);
    domain = route[2] === 'candles' ? 'CANDLE' : 'MARKET_DATA';
    operation =
      route[2] === 'candles'
        ? 'CANDLE_READ'
        : route[2] === 'price'
          ? 'ASSET_PRICE_READ'
          : 'ASSET_READ';
    nextInvestigation = [
      route[2] === 'candles'
        ? 'backend/src/assets/asset-candles.service.ts'
        : 'backend/src/assets/assets.service.ts',
    ];
  }

  return { domain, operation, entities, nextInvestigation };
}

function operationForOrders(method: string, route: string[]): string {
  if (route[0] === 'quote') return 'ORDER_QUOTE';
  if (route[1] === 'cancel') return 'ORDER_CANCEL';
  return method.toUpperCase() === 'POST' ? 'ORDER_CREATE' : 'ORDER_READ';
}

function operationForFx(method: string, route: string[]): string {
  if (route[0] === 'quote') return 'FX_QUOTE';
  if (route[0] === 'execute') return 'FX_EXECUTE';
  if (route.includes('rates')) return 'FX_RATE_READ';
  return method.toUpperCase() === 'GET' ? 'FX_HISTORY_READ' : 'FX_OPERATION';
}

function safePath(originalUrl: string): string {
  return (originalUrl || '/').split('?')[0] || '/';
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function describeException(exception: unknown): AdminDiagnostic['exception'] {
  const error = exception instanceof Error ? exception : null;
  const rawMessage = error?.message ?? 'Non-Error exception';
  const stack = error?.stack?.split('\n').map((line) => line.trim()) ?? [];
  const applicationStack = stack.filter((line) =>
    /(?:backend[\\/](?:src|dist)|[\\/](?:src|dist)[\\/](?:orders|fx|portfolio|assets|providers|common))[\\/]/u.test(
      line,
    ),
  );
  const cause =
    error && 'cause' in error ? describeCause(error.cause) : undefined;

  return {
    type: sanitizeString(error?.name ?? typeof exception),
    message: sanitizeString(rawMessage),
    ...(cause ? { cause } : {}),
    applicationStack: applicationStack
      .slice(0, MAX_APPLICATION_STACK_FRAMES)
      .map(sanitizeString),
    stack: stack.slice(0, MAX_STACK_FRAMES).map(sanitizeString),
    truncated:
      rawMessage.length > MAX_STRING_LENGTH ||
      stack.length > MAX_STACK_FRAMES ||
      applicationStack.length > MAX_APPLICATION_STACK_FRAMES ||
      stack.some((line) => line.length > MAX_STRING_LENGTH),
  };
}

function describeCause(value: unknown): string | undefined {
  if (value instanceof Error) {
    return sanitizeString(`${value.name}: ${value.message}`);
  }
  if (typeof value === 'string') return sanitizeString(value);
  return undefined;
}

function sanitizeRecord(
  value: Record<string, unknown>,
): Record<string, DiagnosticValue> {
  return sanitizeValue(value, 0) as Record<string, DiagnosticValue>;
}

function sanitizeValue(value: unknown, depth: number): DiagnosticValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_OBJECT_DEPTH) return '[TRUNCATED_DEPTH]';
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_COLLECTION_ITEMS)
      .map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .slice(0, MAX_COLLECTION_ITEMS);
    return Object.fromEntries(
      entries.map(([key, item]) => [
        sanitizeString(key),
        isSensitiveKey(key) ? '[REDACTED]' : sanitizeValue(item, depth + 1),
      ]),
    );
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol') return value.description ?? '[SYMBOL]';
  return '[UNSUPPORTED_VALUE]';
}

function sanitizeString(value: string): string {
  const redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(
      /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s'"}]+/giu,
      '[REDACTED_DATABASE_URL]',
    )
    .replace(
      /\b(access[_-]?token|refresh[_-]?token|password|authorization|cookie|secret|api[_-]?key|app[_-]?key|app[_-]?secret|approval[_-]?key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/giu,
      '$1=[REDACTED]',
    );
  return redacted.length <= MAX_STRING_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_STRING_LENGTH - 3)}...`;
}

function sanitizeLogMessage(value: unknown): string {
  if (value instanceof Error) {
    return sanitizeString(`${value.name}: ${value.message}`);
  }
  if (typeof value === 'string') return sanitizeString(value);
  const sanitized = sanitizeValue(value, 0);
  try {
    return sanitizeString(JSON.stringify(sanitized));
  } catch {
    return '[UNSERIALIZABLE_LOG_MESSAGE]';
  }
}

function selectFailureRelatedServerLogs(
  entries: RequestDiagnosticContext['serverLogs'],
  update: DiagnosticContextUpdate | undefined,
  code: string,
): RequestDiagnosticContext['serverLogs'] {
  const failureEntityKeys = new Set([
    'assetId',
    'snapshotId',
    'quoteId',
    'orderId',
    'exchangeTransactionId',
    'fxExecuteRequestId',
  ]);
  const entityEntries = Object.entries(update?.entities ?? {})
    .filter(([key]) => failureEntityKeys.has(key))
    .filter((entry): entry is [string, string | number] => {
      const value = entry[1];
      return (
        (typeof value === 'string' && value.length > 0) ||
        typeof value === 'number'
      );
    });

  return entries.filter((entry) => {
    const searchable = [
      entry.message,
      ...(entry.details ?? []).map(sanitizeLogMessage),
    ].join(' ');
    if (!entityEntries.length) return searchable.includes(code);
    return entityEntries.some(([key, value]) =>
      searchable.includes(`${JSON.stringify(key)}:${JSON.stringify(value)}`),
    );
  });
}

function hasSanitizationLoss(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): boolean {
  if (typeof value === 'string') return value.length > MAX_STRING_LENGTH;
  if (value === null || value === undefined || typeof value !== 'object') {
    return typeof value === 'function';
  }
  if (value instanceof Date) return false;
  if (depth >= MAX_OBJECT_DEPTH || seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) {
    return (
      value.length > MAX_COLLECTION_ITEMS ||
      value.some((item) => hasSanitizationLoss(item, depth + 1, seen))
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return (
    entries.length > MAX_COLLECTION_ITEMS ||
    entries.some(
      ([key, item]) =>
        key.length > MAX_STRING_LENGTH ||
        hasSanitizationLoss(item, depth + 1, seen),
    )
  );
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[\s.-]/gu, '_').toLowerCase();
  return /(?:password|authorization|cookie|credential|database_url|token|secret|api_key|apikey|app_key|appkey|private_key|raw_payload|provider_payload)/u.test(
    normalized,
  );
}

function enforceTotalBound(diagnostic: AdminDiagnostic): AdminDiagnostic {
  if (byteLength(diagnostic) <= MAX_DIAGNOSTIC_BYTES) return diagnostic;
  diagnostic.truncated = true;
  diagnostic.exception.truncated = true;
  diagnostic.exception.stack = diagnostic.exception.applicationStack;
  if (byteLength(diagnostic) <= MAX_DIAGNOSTIC_BYTES) return diagnostic;
  diagnostic.diagnosticEvents.events =
    diagnostic.diagnosticEvents.events.slice(-8);
  diagnostic.diagnosticEvents.truncated = true;
  diagnostic.serverLogs.entries = diagnostic.serverLogs.entries.slice(-8);
  diagnostic.serverLogs.truncated = true;
  if (byteLength(diagnostic) <= MAX_DIAGNOSTIC_BYTES) return diagnostic;
  diagnostic.evidence = { truncated: true };
  if (byteLength(diagnostic) <= MAX_DIAGNOSTIC_BYTES) return diagnostic;
  diagnostic.entities = { truncated: true };
  if (byteLength(diagnostic) <= MAX_DIAGNOSTIC_BYTES) return diagnostic;
  delete diagnostic.nextInvestigation;
  if (byteLength(diagnostic) <= MAX_DIAGNOSTIC_BYTES) return diagnostic;
  diagnostic.diagnosticEvents.events = [];
  diagnostic.diagnosticEvents.truncated = true;
  diagnostic.serverLogs.entries = [];
  diagnostic.serverLogs.truncated = true;
  if (byteLength(diagnostic) <= MAX_DIAGNOSTIC_BYTES) return diagnostic;
  diagnostic.exception.stack = [];
  diagnostic.exception.applicationStack = [];
  return diagnostic;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function nonEmptyRecord(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function inferFailureStage(code: string): string {
  if (/QUOTE_(?:EXPIRED|NOT_FOUND|NOT_ACTIVE|MISMATCH|REQUIRED)/u.test(code)) {
    return 'quote_validation';
  }
  if (/PRICE_(?:STALE|UNAVAILABLE)|ASSET_PRICE/u.test(code)) {
    return 'execution_price_selection';
  }
  if (/FX_RATE|PROVIDER_RATE|EXECUTION_SOURCE/u.test(code)) {
    return 'fx_rate_selection';
  }
  if (/MARKET_(?:CLOSED|CALENDAR_UNAVAILABLE)/u.test(code)) {
    return 'market_session_validation';
  }
  if (/CANDLE/u.test(code)) return 'candle_serving';
  if (/BALANCE|QUANTITY|RESERVATION/u.test(code))
    return 'funds_or_position_validation';
  if (/IDEMPOTENCY/u.test(code)) return 'idempotency_validation';
  if (/INTERNAL|TRANSACTION|INTEGRITY|SCOPE/u.test(code))
    return 'backend_execution';
  return 'request_validation';
}
