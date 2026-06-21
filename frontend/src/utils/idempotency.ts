type RandomUuidProvider = {
  randomUUID?: () => string;
};

function getRandomUuid() {
  return (globalThis as typeof globalThis & { crypto?: RandomUuidProvider })
    .crypto?.randomUUID?.();
}

function normalizeScope(scope: string) {
  return scope.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_') || 'action';
}

export function createIdempotencyKey(scope = 'user_action') {
  const randomPart =
    getRandomUuid() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

  return `${normalizeScope(scope)}_${randomPart}`;
}

// Reuse the same key when retrying the same user action.
// Generate a new key when the quote or user input changes.
