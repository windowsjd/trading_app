import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { STATUS_CODES } from 'node:http';
import { Response } from 'express';

type ErrorEnvelope = {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    response.status(status).json(this.toErrorEnvelope(exception, status));
  }

  private toErrorEnvelope(exception: unknown, status: number): ErrorEnvelope {
    if (exception instanceof HttpException) {
      const body = exception.getResponse();

      if (this.isErrorEnvelope(body)) {
        return body;
      }

      return this.fromHttpExceptionBody(body, status);
    }

    return {
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error.',
      },
    };
  }

  private fromHttpExceptionBody(body: unknown, status: number): ErrorEnvelope {
    if (typeof body === 'string') {
      return this.errorEnvelope(this.defaultCode(status), body);
    }

    if (this.isRecord(body)) {
      const message = this.safeMessage(body.message, status);
      const details = Array.isArray(body.message)
        ? {
            messages: body.message.filter(
              (item): item is string => typeof item === 'string',
            ),
          }
        : undefined;

      return this.errorEnvelope(this.defaultCode(status), message, details);
    }

    return this.errorEnvelope(
      this.defaultCode(status),
      this.defaultMessage(status),
    );
  }

  private errorEnvelope(
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): ErrorEnvelope {
    return {
      success: false,
      error: {
        code,
        message,
        ...(details && Object.keys(details).length > 0 ? { details } : {}),
      },
    };
  }

  private safeMessage(value: unknown, status: number): string {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    if (
      Array.isArray(value) &&
      value.every((item) => typeof item === 'string')
    ) {
      return value.length === 1 ? value[0] : 'Validation failed.';
    }

    return this.defaultMessage(status);
  }

  private defaultCode(status: number): string {
    if (status === HttpStatus.BAD_REQUEST) {
      return 'VALIDATION_ERROR';
    }

    if (status === HttpStatus.UNAUTHORIZED) {
      return 'UNAUTHORIZED';
    }

    if (status === HttpStatus.FORBIDDEN) {
      return 'FORBIDDEN';
    }

    if (status === HttpStatus.NOT_FOUND) {
      return 'NOT_FOUND';
    }

    if (status === HttpStatus.CONFLICT) {
      return 'CONFLICT';
    }

    if (status === HttpStatus.GONE) {
      return 'GONE';
    }

    if (status === HttpStatus.TOO_MANY_REQUESTS) {
      return 'TOO_MANY_REQUESTS';
    }

    if (status >= 500) {
      return 'INTERNAL_SERVER_ERROR';
    }

    return 'HTTP_ERROR';
  }

  private defaultMessage(status: number): string {
    return STATUS_CODES[status] ?? 'HTTP error.';
  }

  private isErrorEnvelope(value: unknown): value is ErrorEnvelope {
    return (
      this.isRecord(value) &&
      value.success === false &&
      this.isRecord(value.error) &&
      typeof value.error.code === 'string' &&
      typeof value.error.message === 'string'
    );
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }
}
