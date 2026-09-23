// Runtime ownership is independent of whether persisted credentials can be read
// or removed. A repeated login by the same user is still a new generation.
let generation = 0;
let phase: 'restoring' | 'installing' | 'active' | 'ended' = 'restoring';

export class SessionSupersededError extends Error {
  constructor() {
    super('The request belongs to an inactive session.');
    this.name = 'SessionSupersededError';
  }
}

export const getSessionGeneration = () => generation;
export const isCurrentSession = (owner: number) => owner === generation;
export const canUseSessionCredentials = (owner: number) =>
  isCurrentSession(owner) && (phase === 'restoring' || phase === 'active');

export function assertCurrentSession(owner: number) {
  if (!isCurrentSession(owner)) throw new SessionSupersededError();
}

export function startSessionInstall(expected: number) {
  assertCurrentSession(expected);
  generation++;
  phase = 'installing';
  return generation;
}

export function activateSession(owner: number) {
  assertCurrentSession(owner);
  if (phase !== 'installing') throw new SessionSupersededError();
  phase = 'active';
}

/** Returns an owner for cleanup; repeated termination keeps the same owner. */
export function invalidateSession(expected: number): number | null {
  if (!isCurrentSession(expected)) return null;
  if (phase !== 'ended') {
    generation++;
    phase = 'ended';
  }
  return generation;
}

export function reportSessionStorageFailure(operation: string) {
  // Never log credentials or native error payloads, which may contain values.
  console.warn(
    `Session storage operation failed: ${operation}. Persistence is not confirmed.`,
  );
}
