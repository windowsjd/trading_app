import {
  adRewardErrorCodes,
  throwAdRewardError,
} from './ad-reward-error-policy';

/**
 * The body of every ad-redeeming COMMAND — the KRW top-up claim and the
 * general-account reset (2026-10-20) take the same three fields.
 *
 * The request may carry ONLY a provider key, an opaque proof, and a client
 * idempotency key. There is deliberately no reward amount, provider event
 * id, user id, account id, granted timestamp, request hash, or response
 * payload field — a client cannot influence what it is paid or what a reset
 * does.
 *
 * `provider` is REQUIRED (작업 6 보완 1): a replay must not depend on what
 * AD_REWARD_PROVIDER happens to say at retry time.
 */
export type AdRewardCommandBody = {
  provider?: unknown;
  proof?: unknown;
  verificationToken?: unknown;
  idempotencyKey?: unknown;
};

export type AdRewardCommand = {
  provider: string;
  proof: string;
  idempotencyKey: string;
};

export function parseAdRewardCommand(
  body: AdRewardCommandBody,
): AdRewardCommand {
  const provider = parseText(body.provider);
  if (!provider) {
    throwAdRewardError(
      adRewardErrorCodes.AD_REWARD_INVALID_REQUEST,
      'provider is required.',
    );
  }
  if (provider.length > 64) {
    throwAdRewardError(
      adRewardErrorCodes.AD_REWARD_INVALID_REQUEST,
      'provider is too long.',
    );
  }

  const proof = parseText(body.proof) ?? parseText(body.verificationToken);
  if (!proof) {
    throwAdRewardError(
      adRewardErrorCodes.AD_REWARD_INVALID_REQUEST,
      'proof (or verificationToken) is required.',
    );
  }
  if (proof.length > 4096) {
    throwAdRewardError(
      adRewardErrorCodes.AD_REWARD_INVALID_REQUEST,
      'proof is too long.',
    );
  }

  const idempotencyKey = parseText(body.idempotencyKey);
  if (!idempotencyKey) {
    throwAdRewardError(
      adRewardErrorCodes.AD_REWARD_INVALID_REQUEST,
      'idempotencyKey is required.',
    );
  }
  if (idempotencyKey.length > 255) {
    throwAdRewardError(
      adRewardErrorCodes.AD_REWARD_INVALID_REQUEST,
      'idempotencyKey is too long.',
    );
  }
  // Control characters would make the key unloggable and unsafe to echo.
  // Matching control characters IS the check here; the rule exists to catch
  // them being typed into a pattern by accident.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(idempotencyKey)) {
    throwAdRewardError(
      adRewardErrorCodes.AD_REWARD_INVALID_REQUEST,
      'idempotencyKey must not contain control characters.',
    );
  }

  return { provider, proof, idempotencyKey };
}

function parseText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
