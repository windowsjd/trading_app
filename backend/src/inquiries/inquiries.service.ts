import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InquiryCategory, Prisma } from '../generated/prisma/client';
import { buildPagination, type Pagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

export const INQUIRY_CATEGORIES = Object.values(InquiryCategory);
export const INQUIRY_TITLE_LIMITS = { min: 2, max: 100 } as const;
export const INQUIRY_CONTENT_LIMITS = { min: 10, max: 2000 } as const;
/** A form resubmitting within this window is spam control, not idempotency. */
export const INQUIRY_RATE_LIMIT = { count: 5, windowMs: 10 * 60_000 } as const;
const CLIENT_REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
// Control characters other than tab/newline/carriage return never belong in a form.
const hasControlCharacter = (value: string) =>
  [...value].some((char) => {
    const code = char.charCodeAt(0);
    return (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127
    );
  });

export type InquiryBody = {
  clientRequestId?: unknown;
  category?: unknown;
  title?: unknown;
  content?: unknown;
};
export type InquiriesQuery = { limit?: string; offset?: string };

type InquiryView = {
  id: string;
  category: InquiryCategory;
  title: string;
  content: string;
  createdAt: string;
};

const SELECT = {
  id: true,
  category: true,
  title: true,
  content: true,
  createdAt: true,
} satisfies Prisma.InquirySelect;

/**
 * Support inquiries. Only the authenticated author can create or read their
 * own inquiries; there is no lookup by id and no other user's data. A form
 * submit carries a client request id: the same id returns the stored inquiry
 * (a retried tap after a lost response never files twice), a different body
 * under the same id is a conflict.
 */
@Injectable()
export class InquiriesService {
  constructor(private readonly prisma: PrismaService) {}

  private fail(status: HttpStatus, code: string, message: string): never {
    throw new HttpException(
      { success: false, error: { code, message } },
      status,
    );
  }

  private author(userId: string | undefined): string {
    if (!userId)
      this.fail(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Unauthorized');
    return userId;
  }

  private text(
    value: unknown,
    field: 'title' | 'content',
    limits: { min: number; max: number },
  ) {
    if (typeof value !== 'string') {
      this.fail(
        HttpStatus.BAD_REQUEST,
        'INVALID_INQUIRY',
        `${field} must be a string.`,
      );
    }
    const trimmed = value.trim();
    const length = [...trimmed].length;
    if (
      length < limits.min ||
      length > limits.max ||
      hasControlCharacter(trimmed)
    ) {
      this.fail(
        HttpStatus.BAD_REQUEST,
        'INVALID_INQUIRY',
        `${field} must be ${limits.min}-${limits.max} characters.`,
      );
    }
    return trimmed;
  }

  parse(body: InquiryBody | undefined) {
    const input = body ?? {};
    if (
      typeof input.clientRequestId !== 'string' ||
      !CLIENT_REQUEST_ID.test(input.clientRequestId)
    ) {
      this.fail(
        HttpStatus.BAD_REQUEST,
        'INVALID_INQUIRY',
        'clientRequestId is invalid.',
      );
    }
    if (
      typeof input.category !== 'string' ||
      !INQUIRY_CATEGORIES.includes(input.category as InquiryCategory)
    ) {
      this.fail(
        HttpStatus.BAD_REQUEST,
        'INVALID_INQUIRY',
        'category is invalid.',
      );
    }
    return {
      clientRequestId: input.clientRequestId,
      category: input.category as InquiryCategory,
      title: this.text(input.title, 'title', INQUIRY_TITLE_LIMITS),
      content: this.text(input.content, 'content', INQUIRY_CONTENT_LIMITS),
    };
  }

  private view(row: {
    id: string;
    category: InquiryCategory;
    title: string;
    content: string;
    createdAt: Date;
  }): InquiryView {
    return { ...row, createdAt: row.createdAt.toISOString() };
  }

  async create(userId: string | undefined, body: InquiryBody | undefined) {
    const author = this.author(userId);
    const input = this.parse(body);
    const replay = await this.findReplay(author, input);
    if (replay) return replay;
    const since = new Date(Date.now() - INQUIRY_RATE_LIMIT.windowMs);
    const recent = await this.prisma.inquiry.count({
      where: { userId: author, createdAt: { gte: since } },
    });
    if (recent >= INQUIRY_RATE_LIMIT.count) {
      this.fail(
        HttpStatus.TOO_MANY_REQUESTS,
        'INQUIRY_RATE_LIMITED',
        'Too many inquiries. Please try again later.',
      );
    }
    try {
      const row = await this.prisma.inquiry.create({
        data: { userId: author, ...input },
        select: SELECT,
      });
      return {
        success: true as const,
        data: { inquiry: this.view(row), replayed: false },
      };
    } catch (error) {
      // A concurrent submit with the same request id won the insert.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.findReplay(author, input);
        if (winner) return winner;
      }
      throw error;
    }
  }

  private async findReplay(
    author: string,
    input: ReturnType<InquiriesService['parse']>,
  ) {
    const existing = await this.prisma.inquiry.findUnique({
      where: {
        userId_clientRequestId: {
          userId: author,
          clientRequestId: input.clientRequestId,
        },
      },
      select: SELECT,
    });
    if (!existing) return null;
    if (
      existing.category !== input.category ||
      existing.title !== input.title ||
      existing.content !== input.content
    ) {
      this.fail(
        HttpStatus.CONFLICT,
        'INQUIRY_IDEMPOTENCY_CONFLICT',
        'This request id was already used for a different inquiry.',
      );
    }
    return {
      success: true as const,
      data: { inquiry: this.view(existing), replayed: true },
    };
  }

  async listMine(userId: string | undefined, query: InquiriesQuery = {}) {
    const author = this.author(userId);
    const limit = this.integer(query.limit, 20, 1, 50, 'limit');
    const offset = this.integer(query.offset, 0, 0, 10_000, 'offset');
    const where = { userId: author };
    const [rows, total] = await Promise.all([
      this.prisma.inquiry.findMany({
        where,
        select: SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.inquiry.count({ where }),
    ]);
    const pagination: Pagination = buildPagination({
      limit,
      offset,
      total,
      returned: rows.length,
    });
    return {
      success: true as const,
      data: { items: rows.map((row) => this.view(row)), pagination },
    };
  }

  private integer(
    value: string | undefined,
    fallback: number,
    min: number,
    max: number,
    field: string,
  ) {
    if (value === undefined || value === '') return fallback;
    if (!/^\d+$/.test(value))
      this.fail(
        HttpStatus.BAD_REQUEST,
        'INVALID_PAGINATION',
        `${field} is invalid.`,
      );
    const parsed = Number(value);
    if (parsed < min || parsed > max)
      this.fail(
        HttpStatus.BAD_REQUEST,
        'INVALID_PAGINATION',
        `${field} is out of range.`,
      );
    return parsed;
  }
}
