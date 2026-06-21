import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { UserRole } from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { BinancePriceIngestionService } from '../providers/binance/binance-price.ingestion.service';
import { ExchangeRateIngestionService } from '../providers/exchange-rate/exchange-rate.ingestion.service';
import { KisRestCurrentPriceIngestionService } from '../providers/kis/kis-rest-current-price.ingestion.service';
import { KisRestHogaIngestionService } from '../providers/kis/kis-rest-hoga.ingestion.service';
import { KisWebSocketClient } from '../providers/kis/kis-websocket.client';
import { KoreaEximExchangeIngestionService } from '../providers/korea-exim/korea-exim-exchange.ingestion.service';
import { OperatorAuditService } from './operator-audit.service';
import type { OperatorRequestContext } from './operator-account-management.service';
import { hasOperatorRole } from './operator.guard';

export type OperatorProviderIngestionBody = {
  dryRun?: unknown;
  symbols?: unknown;
  maxSnapshots?: unknown;
  reason?: unknown;
  note?: unknown;
  kisModes?: unknown;
  durationMs?: unknown;
};

type ProviderName = 'exchange-rate' | 'korea-exim' | 'binance' | 'kis';
type KisIngestionMode = 'rest_current_price' | 'rest_hoga' | 'websocket_trade';

type ProviderRunSummary = {
  provider: ProviderName;
  dryRun: boolean;
  state: 'completed' | 'skipped' | 'failed' | 'partial';
  received: number;
  created: number;
  wouldCreate: number;
  skipped: number;
  failed: number;
  snapshots: unknown[];
  results?: unknown[];
  errorCode?: string;
  errorMessage?: string;
};

const MAX_SYMBOLS = 100;
const MAX_SNAPSHOTS_LIMIT = 500;
const MAX_DURATION_MS = 60_000;
const DISABLED_OR_SKIPPED_CODES = new Set([
  'PROVIDER_INGESTION_DISABLED',
  'PROVIDER_DISABLED',
  'KOREA_EXIM_PROVIDER_DISABLED',
  'KIS_REST_BASE_URL_MISSING',
  'KIS_WS_BASE_URL_MISSING',
  'KIS_WATCHLIST_EMPTY',
  'WEBSOCKET_CLIENT_UNAVAILABLE',
]);

@Injectable()
export class OperatorProviderIngestionService {
  constructor(
    private readonly auditService: OperatorAuditService,
    private readonly exchangeRateIngestion: ExchangeRateIngestionService,
    private readonly koreaEximIngestion: KoreaEximExchangeIngestionService,
    private readonly binanceIngestion: BinancePriceIngestionService,
    private readonly kisRestCurrentPriceIngestion: KisRestCurrentPriceIngestionService,
    private readonly kisRestHogaIngestion: KisRestHogaIngestionService,
    private readonly kisWebSocketClient: KisWebSocketClient,
  ) {}

  async runProviderIngestion(
    actor: AuthenticatedUser | undefined,
    providerParam: string,
    body: OperatorProviderIngestionBody = {},
    context: OperatorRequestContext = {},
  ) {
    this.assertOperator(actor);
    let provider: ProviderName | null = null;
    let reason: string | null = null;
    let note: string | null = null;

    try {
      provider = this.parseProvider(providerParam);
      const dryRun = this.parseDryRun(body.dryRun);
      const symbols = this.parseSymbols(body.symbols);
      const maxSnapshots = this.parseMaxSnapshots(body.maxSnapshots);
      const durationMs = this.parseDurationMs(body.durationMs);
      const kisModes = this.parseKisModes(body.kisModes);
      reason = this.parseOptionalText(body.reason, 120);
      note = this.parseOptionalText(body.note, 1000);
      const requestedBy = actor.userId;

      const summary = await this.runProvider({
        provider,
        dryRun,
        symbols,
        maxSnapshots,
        durationMs,
        kisModes,
        requestedBy,
      });

      await this.auditService.recordSuccess({
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'operator.provider_ingestion.run',
        targetType: 'provider_ingestion',
        targetId: provider,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadataJson: {
          actorUserId: actor.userId,
          provider,
          dryRun,
          reason,
          note,
          state: summary.state,
          received: summary.received,
          created: summary.created,
          wouldCreate: summary.wouldCreate,
          skipped: summary.skipped,
          failed: summary.failed,
          errorCode: summary.errorCode ?? null,
          kisModes: provider === 'kis' ? kisModes : undefined,
          symbolCount: symbols?.length ?? null,
          maxSnapshots: maxSnapshots ?? null,
          requestId: context.requestId ?? null,
        },
      });

      return {
        success: true,
        data: summary,
      };
    } catch (error) {
      await this.recordFailureIfPossible({
        actor,
        provider: provider ?? providerParam,
        reason,
        note,
        context,
        error,
      });
      throw this.normalizeError(error);
    }
  }

  private async runProvider(input: {
    provider: ProviderName;
    dryRun: boolean;
    symbols?: string[];
    maxSnapshots?: number;
    durationMs?: number;
    kisModes: KisIngestionMode[];
    requestedBy: string;
  }): Promise<ProviderRunSummary> {
    switch (input.provider) {
      case 'exchange-rate':
        return summaryFromResult(
          input.provider,
          input.dryRun,
          await this.exchangeRateIngestion.ingestUsdKrw({
            dryRun: input.dryRun,
            requestedBy: input.requestedBy,
          }),
        );
      case 'korea-exim':
        return summaryFromResult(
          input.provider,
          input.dryRun,
          await this.koreaEximIngestion.ingestUsdKrw({
            dryRun: input.dryRun,
            requestedBy: input.requestedBy,
          }),
        );
      case 'binance':
        return summaryFromResult(
          input.provider,
          input.dryRun,
          await this.binanceIngestion.ingestPrices({
            dryRun: input.dryRun,
            requestedBy: input.requestedBy,
            symbols: input.symbols,
          }),
        );
      case 'kis':
        return this.runKisProvider(input);
    }
  }

  private async runKisProvider(input: {
    provider: ProviderName;
    dryRun: boolean;
    symbols?: string[];
    maxSnapshots?: number;
    durationMs?: number;
    kisModes: KisIngestionMode[];
    requestedBy: string;
  }): Promise<ProviderRunSummary> {
    const splitSymbols = splitKisSymbols(input.symbols);
    const results: unknown[] = [];

    for (const mode of input.kisModes) {
      if (mode === 'rest_current_price') {
        results.push(
          await this.kisRestCurrentPriceIngestion.ingestCurrentPrices({
            dryRun: input.dryRun,
            requestedBy: input.requestedBy,
            domesticSymbols: splitSymbols?.domesticSymbols,
            usSymbols: splitSymbols?.usSymbols,
            maxSnapshots: input.maxSnapshots,
          }),
        );
        continue;
      }

      if (mode === 'rest_hoga') {
        results.push(
          await this.kisRestHogaIngestion.ingestHogaSnapshots({
            dryRun: input.dryRun,
            requestedBy: input.requestedBy,
            domesticSymbols: splitSymbols?.domesticSymbols,
            usSymbols: splitSymbols?.usSymbols,
            maxSnapshots: input.maxSnapshots,
          }),
        );
        continue;
      }

      results.push(
        await this.kisWebSocketClient.runTradePriceIngestion({
          dryRun: input.dryRun,
          requestedBy: input.requestedBy,
          domesticSymbols: splitSymbols?.domesticSymbols,
          usSymbols: splitSymbols?.usSymbols,
          maxSnapshots: input.maxSnapshots,
          durationMs: input.durationMs,
        }),
      );
    }

    const aggregate = results.map(normalizeCounts);
    const snapshots = results.flatMap(readSnapshots);
    const errorCode = aggregate.find((item) => item.errorCode)?.errorCode;
    const errorMessage = aggregate.find(
      (item) => item.errorMessage,
    )?.errorMessage;
    const failed = aggregate.reduce((sum, item) => sum + item.failed, 0);
    const created = aggregate.reduce((sum, item) => sum + item.created, 0);
    const wouldCreate = aggregate.reduce(
      (sum, item) => sum + item.wouldCreate,
      0,
    );
    const skipped = aggregate.reduce((sum, item) => sum + item.skipped, 0);
    const received = aggregate.reduce((sum, item) => sum + item.received, 0);

    return {
      provider: 'kis',
      dryRun: input.dryRun,
      state: stateFromCounts({
        failed,
        created,
        wouldCreate,
        skipped,
        errorCode,
      }),
      received,
      created,
      wouldCreate,
      skipped,
      failed,
      snapshots,
      results,
      errorCode,
      errorMessage,
    };
  }

  private parseProvider(provider: string): ProviderName {
    const normalized = provider.trim().toLowerCase().replace(/_/g, '-');
    switch (normalized) {
      case 'exchange-rate':
      case 'exchange-rate-api':
        return 'exchange-rate';
      case 'korea-exim':
      case 'korea-exim-exchange':
        return 'korea-exim';
      case 'binance':
        return 'binance';
      case 'kis':
        return 'kis';
      default:
        throw this.badRequest(
          'INVALID_PROVIDER',
          'Provider must be exchange-rate, korea-exim, binance, or kis.',
        );
    }
  }

  private parseDryRun(value: unknown): boolean {
    if (value === undefined) {
      return true;
    }

    if (typeof value !== 'boolean') {
      throw this.badRequest('INVALID_DRY_RUN', 'dryRun must be a boolean.');
    }

    return value;
  }

  private parseSymbols(value: unknown): string[] | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (!Array.isArray(value)) {
      throw this.badRequest('INVALID_SYMBOLS', 'symbols must be an array.');
    }

    if (value.length > MAX_SYMBOLS) {
      throw this.badRequest(
        'TOO_MANY_SYMBOLS',
        `symbols must include at most ${MAX_SYMBOLS} items.`,
      );
    }

    const seen = new Set<string>();
    const symbols: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') {
        throw this.badRequest('INVALID_SYMBOL', 'symbols must be strings.');
      }

      const symbol = item.trim().toUpperCase();
      if (!symbol || !/^[A-Z0-9:._-]{1,32}$/u.test(symbol)) {
        throw this.badRequest('INVALID_SYMBOL', 'Invalid provider symbol.');
      }

      if (!seen.has(symbol)) {
        seen.add(symbol);
        symbols.push(symbol);
      }
    }

    return symbols;
  }

  private parseMaxSnapshots(value: unknown): number | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > MAX_SNAPSHOTS_LIMIT
    ) {
      throw this.badRequest(
        'INVALID_MAX_SNAPSHOTS',
        `maxSnapshots must be an integer between 1 and ${MAX_SNAPSHOTS_LIMIT}.`,
      );
    }

    return value;
  }

  private parseDurationMs(value: unknown): number | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > MAX_DURATION_MS
    ) {
      throw this.badRequest(
        'INVALID_DURATION_MS',
        `durationMs must be an integer between 1 and ${MAX_DURATION_MS}.`,
      );
    }

    return value;
  }

  private parseKisModes(value: unknown): KisIngestionMode[] {
    if (value === undefined) {
      return ['rest_current_price', 'rest_hoga'];
    }

    if (!Array.isArray(value) || value.length === 0) {
      throw this.badRequest(
        'INVALID_KIS_MODES',
        'kisModes must be a non-empty array.',
      );
    }

    const modes: KisIngestionMode[] = [];
    const seen = new Set<KisIngestionMode>();
    for (const item of value) {
      if (typeof item !== 'string') {
        throw this.badRequest('INVALID_KIS_MODE', 'kisModes must be strings.');
      }

      const mode = normalizeKisMode(item);
      if (!mode) {
        throw this.badRequest(
          'INVALID_KIS_MODE',
          'kisModes supports rest_current_price, rest_hoga, and websocket_trade.',
        );
      }

      if (!seen.has(mode)) {
        seen.add(mode);
        modes.push(mode);
      }
    }

    return modes;
  }

  private parseOptionalText(value: unknown, maxLength: number): string | null {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value !== 'string') {
      throw this.badRequest('INVALID_TEXT', 'Text fields must be strings.');
    }

    const text = value.trim();
    if (!text) {
      return null;
    }

    if (text.length > maxLength) {
      throw this.badRequest(
        'TEXT_TOO_LONG',
        `Text fields must be ${maxLength} characters or fewer.`,
      );
    }

    return text;
  }

  private assertOperator(
    actor: AuthenticatedUser | undefined,
  ): asserts actor is AuthenticatedUser {
    if (!actor || !hasOperatorRole(actor.role)) {
      throw this.badRequest(
        'OPERATOR_REQUIRED',
        'Operator or admin role is required.',
      );
    }
  }

  private async recordFailureIfPossible(input: {
    actor: AuthenticatedUser;
    provider: string;
    reason: string | null;
    note: string | null;
    context: OperatorRequestContext;
    error: unknown;
  }) {
    const errorCode = errorCodeFromError(input.error);
    await this.auditService.recordFailure({
      actorUserId: input.actor.userId,
      actorRole: input.actor.role as UserRole,
      action: 'operator.provider_ingestion.run.failed',
      targetType: 'provider_ingestion',
      targetId: input.provider,
      requestId: input.context.requestId,
      ipAddress: input.context.ipAddress,
      userAgent: input.context.userAgent,
      errorCode,
      metadataJson: {
        actorUserId: input.actor.userId,
        provider: input.provider,
        reason: input.reason,
        note: input.note,
        errorCode,
        requestId: input.context.requestId ?? null,
      },
    });
  }

  private normalizeError(error: unknown): HttpException {
    if (error instanceof HttpException) {
      return error;
    }

    return new InternalServerErrorException({
      success: false,
      error: {
        code: 'PROVIDER_INGESTION_TRIGGER_FAILED',
        message: 'Provider ingestion trigger failed.',
      },
    });
  }

  private badRequest(code: string, message: string): BadRequestException {
    return new BadRequestException({
      success: false,
      error: {
        code,
        message,
      },
    });
  }
}

function summaryFromResult(
  provider: ProviderName,
  dryRun: boolean,
  result: unknown,
): ProviderRunSummary {
  const counts = normalizeCounts(result);
  const errorCode = counts.errorCode;
  return {
    provider,
    dryRun,
    state: stateFromCounts({
      failed: counts.failed,
      created: counts.created,
      wouldCreate: counts.wouldCreate,
      skipped: counts.skipped,
      errorCode,
    }),
    received: counts.received,
    created: counts.created,
    wouldCreate: counts.wouldCreate,
    skipped: counts.skipped,
    failed: counts.failed,
    snapshots: readSnapshots(result),
    results: [result],
    errorCode,
    errorMessage: counts.errorMessage,
  };
}

function normalizeCounts(result: unknown): {
  received: number;
  created: number;
  wouldCreate: number;
  skipped: number;
  failed: number;
  errorCode?: string;
  errorMessage?: string;
} {
  const record = isRecord(result) ? result : {};
  return {
    received:
      readNumber(record.received) ??
      readNumber(record.symbolCount) ??
      readArray(record.snapshots)?.length ??
      0,
    created: readNumber(record.created) ?? 0,
    wouldCreate: readNumber(record.wouldCreate) ?? 0,
    skipped: readNumber(record.skipped) ?? 0,
    failed: readNumber(record.failed) ?? (record.success === false ? 1 : 0),
    errorCode:
      typeof record.errorCode === 'string' ? record.errorCode : undefined,
    errorMessage:
      typeof record.errorMessage === 'string' ? record.errorMessage : undefined,
  };
}

function readSnapshots(result: unknown): unknown[] {
  if (!isRecord(result)) {
    return [];
  }

  return (
    readArray(result.snapshots) ??
    readArray(result.symbols) ??
    (result.rate || result.effectiveAt
      ? [
          {
            state: result.created
              ? 'created'
              : result.wouldCreate
                ? 'would_create'
                : result.skipped
                  ? 'skipped'
                  : result.success === false
                    ? 'failed'
                    : 'completed',
            sourceName: result.provider,
            rate: result.rate ?? null,
            effectiveAt: result.effectiveAt ?? null,
            reason: result.errorCode ?? undefined,
          },
        ]
      : [])
  );
}

function stateFromCounts(input: {
  failed: number;
  created: number;
  wouldCreate: number;
  skipped: number;
  errorCode?: string;
}): ProviderRunSummary['state'] {
  if (input.errorCode && DISABLED_OR_SKIPPED_CODES.has(input.errorCode)) {
    return 'skipped';
  }

  if (input.failed > 0) {
    const successful = input.created + input.wouldCreate + input.skipped;
    return successful > 0 ? 'partial' : 'failed';
  }

  if (input.created + input.wouldCreate === 0 && input.skipped > 0) {
    return 'skipped';
  }

  return 'completed';
}

function splitKisSymbols(symbols: string[] | undefined):
  | {
      domesticSymbols: string[];
      usSymbols: string[];
    }
  | undefined {
  if (!symbols) {
    return undefined;
  }

  const domesticSymbols: string[] = [];
  const usSymbols: string[] = [];
  for (const symbol of symbols) {
    if (/^\d{6}$/u.test(symbol)) {
      domesticSymbols.push(symbol);
    } else {
      usSymbols.push(symbol);
    }
  }

  return { domesticSymbols, usSymbols };
}

function normalizeKisMode(value: string): KisIngestionMode | null {
  const normalized = value.trim().toLowerCase().replace(/-/g, '_');
  switch (normalized) {
    case 'rest_current_price':
    case 'current_price':
      return 'rest_current_price';
    case 'rest_hoga':
    case 'hoga':
    case 'orderbook':
      return 'rest_hoga';
    case 'websocket_trade':
    case 'ws_trade':
    case 'trade':
      return 'websocket_trade';
    default:
      return null;
  }
}

function errorCodeFromError(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (isRecord(response) && isRecord(response.error)) {
      const code = response.error.code;
      if (typeof code === 'string') {
        return code;
      }
    }
  }

  return 'PROVIDER_INGESTION_TRIGGER_FAILED';
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function readArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]'
  );
}
