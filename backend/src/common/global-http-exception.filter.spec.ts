import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
} from '@nestjs/common';
import { adminDiagnosticRequestMiddleware } from './admin-diagnostics';
import { GlobalHttpExceptionFilter } from './global-http-exception.filter';

describe('GlobalHttpExceptionFilter', () => {
  const createHost = (request?: unknown) => {
    let jsonBody: unknown;
    const response = {
      status: jest.fn<(status: number) => unknown>(),
      json: jest.fn<(body: unknown) => void>((body) => {
        jsonBody = body;
      }),
      setHeader: jest.fn(),
    };
    response.status.mockReturnValue(response);
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => request,
      }),
    } as ArgumentsHost;

    return { host, response, getJsonBody: () => jsonBody };
  };

  it('preserves existing API error envelopes', () => {
    const filter = new GlobalHttpExceptionFilter();
    const { host, response } = createHost();
    const envelope = {
      success: false,
      error: {
        code: 'ORDER_IDEMPOTENCY_CONFLICT',
        message: 'Same idempotencyKey was used with a different request.',
      },
    };

    filter.catch(new HttpException(envelope, HttpStatus.CONFLICT), host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(response.json).toHaveBeenCalledWith(envelope);
  });

  it('wraps Nest BadRequestException string responses', () => {
    const filter = new GlobalHttpExceptionFilter();
    const { host, response } = createHost();

    filter.catch(new BadRequestException('x'), host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'x',
      },
    });
  });

  it('wraps unknown errors without exposing raw details', () => {
    const filter = new GlobalHttpExceptionFilter();
    const { host, response, getJsonBody } = createHost();

    filter.catch(new Error('raw provider payload secret stack'), host);

    expect(response.status).toHaveBeenCalledWith(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error.',
      },
    });
    expect(JSON.stringify(getJsonBody())).not.toContain('secret');
  });
  it.each(['user', 'operator', 'admin'])(
    'does not publish diagnostic-only legacy 503 envelope text for %s',
    (role) => {
      const message = 'Trading account access service unavailable';
      const request = {
        method: 'GET',
        originalUrl: '/api/v1/portfolio',
        headers: {},
        user: { userId: 'user-1', role },
      };
      const { host, response, getJsonBody } = createHost(request);
      adminDiagnosticRequestMiddleware(
        request as never,
        response as never,
        () => {
          new GlobalHttpExceptionFilter().catch(
            new HttpException(
              {
                success: false,
                error: { code: 'ACCOUNT_UNAVAILABLE', message },
              },
              503,
            ),
            host,
          );
        },
      );
      const body = getJsonBody() as {
        error: {
          message: string;
          diagnostic?: { exception: { message: string } };
        };
      };
      expect(body.error.message).toBe('Service Unavailable');
      expect(Boolean(body.error.diagnostic)).toBe(role === 'admin');
      if (role === 'admin')
        expect(body.error.diagnostic?.exception.message).toBe(message);
    },
  );

  it.each(['user', 'operator', 'admin'] as const)(
    'keeps raw HTTP wrappers and attached diagnostics out of the %s public envelope',
    (role) => {
      const request = {
        method: 'GET',
        originalUrl: '/api/v1/portfolio',
        headers: {},
        user: { userId: 'user-1', role },
      };
      for (const exception of [
        new InternalServerErrorException(
          'https://db.invalid/secret balance 198234.123456',
        ),
        new HttpException(
          {
            success: false,
            error: {
              code: 'PORTFOLIO_FAILED',
              message: 'https://db.invalid/secret balance 198234.123456',
              details: { raw: 'foreign-private-id' },
              diagnostic: { raw: 'injected-diagnostic' },
            },
          },
          503,
        ),
      ]) {
        const { host, response, getJsonBody } = createHost(request);
        adminDiagnosticRequestMiddleware(
          request as never,
          response as never,
          () => new GlobalHttpExceptionFilter().catch(exception, host),
        );
        const body = getJsonBody() as {
          error: { code: string; diagnostic?: unknown };
        };
        expect(JSON.stringify(body)).not.toMatch(
          /db.invalid|198234|foreign-private-id|injected-diagnostic/,
        );
        expect(Boolean(body.error.diagnostic)).toBe(role === 'admin');
        if (exception.getStatus() === 503)
          expect(body.error.code).toBe('PORTFOLIO_FAILED');
      }
    },
  );

  it.each([
    ['user', false],
    ['operator', false],
    ['admin', true],
  ] as const)(
    'emits diagnostics according to the current DB-backed %s role',
    (role, expectedDiagnostic) => {
      const filter = new GlobalHttpExceptionFilter();
      const request = {
        method: 'POST',
        originalUrl: '/api/v1/trading-accounts/account-1/orders',
        headers: { 'x-request-id': `req-${role}` },
        user: { userId: `${role}-1`, role },
      };
      const { host, response, getJsonBody } = createHost(request);

      adminDiagnosticRequestMiddleware(
        request as never,
        response as never,
        () =>
          filter.catch(
            new HttpException(
              {
                success: false,
                error: { code: 'PRICE_STALE', message: 'Price is stale.' },
              },
              HttpStatus.SERVICE_UNAVAILABLE,
            ),
            host,
          ),
      );

      const body = getJsonBody() as {
        success: boolean;
        error: {
          code: string;
          message: string;
          diagnostic?: { requestId: string; exception: { message: string } };
        };
      };
      expect(body).toMatchObject({
        success: false,
        error: { code: 'PRICE_STALE', message: 'Price is stale.' },
      });
      expect(response.status).toHaveBeenCalledWith(503);
      expect(Boolean(body.error.diagnostic)).toBe(expectedDiagnostic);
      if (expectedDiagnostic) {
        expect(body.error.diagnostic?.requestId).toBe(`req-${role}`);
        expect(body.error.diagnostic?.exception.message).toBe(
          'Price is stale.',
        );
      }
    },
  );
});
