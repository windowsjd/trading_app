import { Injectable } from '@nestjs/common';
import {
  OperatorAuditResult,
  Prisma,
  UserRole,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  isSensitiveDiagnosticKey,
  REDACTED,
  redactStoredText,
} from '../common/sensitive-data';
const UNSUPPORTED_VALUE = '[UNSUPPORTED_METADATA_VALUE]';

export type OperatorAuditLogInput = {
  actorUserId: string;
  actorRole: UserRole;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadataJson?: unknown;
  result: OperatorAuditResult;
  errorCode?: string | null;
};

type OperatorAuditClient = Pick<PrismaService, 'operatorAuditLog'>;

@Injectable()
export class OperatorAuditService {
  constructor(private readonly prisma: PrismaService) {}

  recordSuccess(
    input: Omit<OperatorAuditLogInput, 'result' | 'errorCode'>,
    client?: OperatorAuditClient,
  ) {
    return this.record(
      {
        ...input,
        result: OperatorAuditResult.success,
        errorCode: null,
      },
      client,
    );
  }

  recordFailure(
    input: Omit<OperatorAuditLogInput, 'result'> & { errorCode: string },
    client?: OperatorAuditClient,
  ) {
    return this.record(
      {
        ...input,
        result: OperatorAuditResult.failure,
      },
      client,
    );
  }

  async record(input: OperatorAuditLogInput, client?: OperatorAuditClient) {
    const auditClient = client ?? this.prisma;

    return auditClient.operatorAuditLog.create({
      data: {
        actorUserId: this.requireNonEmpty(input.actorUserId, 'actorUserId'),
        actorRole: input.actorRole,
        action: this.requireNonEmpty(input.action, 'action'),
        targetType: this.optionalString(input.targetType),
        targetId: this.optionalString(input.targetId),
        requestId: this.optionalString(input.requestId),
        ipAddress: this.optionalString(input.ipAddress),
        userAgent: this.optionalString(input.userAgent),
        metadataJson: this.sanitizeMetadata(input.metadataJson),
        result: input.result,
        errorCode: this.optionalString(input.errorCode),
      },
      select: {
        id: true,
        createdAt: true,
      },
    });
  }

  private requireNonEmpty(value: string, field: string) {
    const normalized = value.trim();
    if (!normalized) {
      throw new Error(`${field} is required`);
    }

    return normalized;
  }

  private optionalString(value: string | null | undefined) {
    if (value === null || value === undefined) {
      return value;
    }

    const normalized = value.trim();
    return normalized || null;
  }

  private sanitizeMetadata(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined) {
      return undefined;
    }

    return this.sanitizeJsonValue(value) as Prisma.InputJsonValue;
  }

  private sanitizeJsonValue(value: unknown): unknown {
    if (value === null) {
      return null;
    }

    if (typeof value === 'string') {
      return redactStoredText(value);
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeJsonValue(item));
    }

    if (typeof value === 'object') {
      if (!this.isPlainObject(value)) {
        return UNSUPPORTED_VALUE;
      }

      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .map(([key, item]) => [
            key,
            isSensitiveDiagnosticKey(key)
              ? REDACTED
              : this.sanitizeJsonValue(item),
          ]),
      );
    }

    return UNSUPPORTED_VALUE;
  }

  private isPlainObject(value: object) {
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }
}
