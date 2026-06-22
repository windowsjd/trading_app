import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { GlobalHttpExceptionFilter } from './global-http-exception.filter';

describe('GlobalHttpExceptionFilter', () => {
  const createHost = () => {
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
      }),
    } as ArgumentsHost;

    return { host, response };
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
    const { host, response } = createHost();

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
    expect(JSON.stringify(response.json.mock.calls[0][0])).not.toContain(
      'secret',
    );
  });
});
