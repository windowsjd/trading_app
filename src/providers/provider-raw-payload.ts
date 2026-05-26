import { Buffer } from 'node:buffer';
import { redactJsonValue, redactText } from './provider-secret-redaction';

export type ProviderRawPayloadInput = {
  payload: unknown;
  maxBytes: number;
  secrets?: readonly string[];
};

export type ProviderRawPayloadJson =
  | {
      truncated: false;
      payload: unknown;
    }
  | {
      truncated: true;
      maxBytes: number;
      originalBytes: number;
      payloadPreview: string;
    };

export function buildProviderRawPayloadJson(
  input: ProviderRawPayloadInput,
): ProviderRawPayloadJson {
  const sanitized = redactJsonValue(input.payload, {
    secrets: input.secrets,
  });
  const json = JSON.stringify(sanitized);
  const originalBytes = Buffer.byteLength(json, 'utf8');

  if (originalBytes <= input.maxBytes) {
    return {
      truncated: false,
      payload: sanitized,
    };
  }

  return {
    truncated: true,
    maxBytes: input.maxBytes,
    originalBytes,
    payloadPreview: truncateUtf8(
      redactText(json, { secrets: input.secrets }),
      input.maxBytes,
    ),
  };
}

export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }

  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) {
    return text;
  }

  return buffer.toString('utf8', 0, maxBytes).replace(/\uFFFD$/u, '');
}
