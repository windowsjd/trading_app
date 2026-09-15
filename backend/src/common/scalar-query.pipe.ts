import { HttpException, HttpStatus, type PipeTransform } from '@nestjs/common';

/**
 * HTTP shape boundary only. Services retain their existing string parsing,
 * defaults, normalization and domain checks. Unknown query keys stay ignored.
 */
export class ScalarQueryPipe implements PipeTransform<unknown> {
  constructor(private readonly errors: Readonly<Record<string, string>>) {}

  transform(query: unknown): Record<string, unknown> {
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
      this.reject('VALIDATION_ERROR', 'query');
    }

    const values = query as Record<string, unknown>;
    for (const key of Object.keys(values)) {
      // Express's simple parser preserves bracket notation as literal keys;
      // extended parsers instead produce arrays/objects. Reject both shapes
      // for declared scalar fields, without selecting or coercing a value.
      const field = key.split(/[[\]]/u, 1)[0];
      if (!Object.hasOwn(this.errors, field)) continue;
      if (
        key !== field ||
        (values[key] !== undefined && typeof values[key] !== 'string')
      ) {
        this.reject(this.errors[field], field);
      }
    }
    return values;
  }

  private reject(code: string, field: string): never {
    throw new HttpException(
      {
        success: false,
        error: { code, message: `${field} must be a single string value.` },
      },
      HttpStatus.BAD_REQUEST,
    );
  }
}
