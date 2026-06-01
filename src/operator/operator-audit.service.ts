import { Injectable } from '@nestjs/common';
import {
  OperatorAuditResult,
  Prisma,
  UserRole,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const REDACTED = '[REDACTED]';
const UNSUPPORTED_VALUE = '[UNSUPPORTED_METADATA_VALUE]';
const SENSITIVE_KEY_PATTERNS = [
  'access_token',
  'accesstoken',
  'api_key',
  'apikey',
  'app_key',
  'appkey',
  'app_secret',
  'appsecret',
  'approval_key',
  'approvalkey',
  'authorization',
  'database_url',
  'databaseurl',
  'password',
  'private_key',
  'privatekey',
  'provider_payload',
  'providerpayload',
  'raw_payload',
  'rawpayload',
  'refresh_token',
  'refreshtoken',
  'secret',
  'token',
];

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

@Injectable()
export class OperatorAuditService {
  constructor(private readonly prisma: PrismaService) {}

  recordSuccess(input: Omit<OperatorAuditLogInput, 'result' | 'errorCode'>) {
    return this.record({
      ...input,
      result: OperatorAuditResult.success,
      errorCode: null,
    });
  }

  recordFailure(
    input: Omit<OperatorAuditLogInput, 'result'> & { errorCode: string },
  ) {
    return this.record({
      ...input,
      result: OperatorAuditResult.failure,
    });
  }

  async record(input: OperatorAuditLogInput) {
    return this.prisma.operatorAuditLog.create({
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
      return this.isSensitiveString(value) ? REDACTED : value;
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
            this.isSensitiveKey(key) ? REDACTED : this.sanitizeJsonValue(item),
          ]),
      );
    }

    return UNSUPPORTED_VALUE;
  }

  private isPlainObject(value: object) {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  private isSensitiveKey(key: string) {
    const normalized = key.replace(/[\s.-]/g, '_').toLowerCase();
    return SENSITIVE_KEY_PATTERNS.some((pattern) =>
      normalized.includes(pattern),
    );
  }

  private isSensitiveString(value: string) {
    return (
      /^bearer\s+/i.test(value.trim()) ||
      /postgres(?:ql)?:\/\//i.test(value) ||
      /mysql:\/\//i.test(value) ||
      /mongodb(?:\+srv)?:\/\//i.test(value)
    );
  }
}
