/**
 * Parsing for EXPO_PUBLIC_* boolean feature flags.
 *
 * Deliberately free of any react-native import so it runs under
 * `node --test` (the project's test runner cannot resolve the RN module
 * graph). constants/env.ts does the actual `process.env` reads — which must
 * stay static dot notation for the Expo bundler to inline them — and hands the
 * raw values here.
 */

/**
 * Public boolean flag policy: default OFF. Only an explicit `true` or `1`
 * (trimmed, case-insensitive) enables a flag; `false`, `0`, an unrecognized
 * value, an empty value, and an unset variable all read as false.
 *
 * Unlike the backend's LIMIT_ORDER_ENABLED — which refuses to boot on an
 * unrecognized value — a client bundle has no bootstrap step that could fail,
 * so it stays fail-closed here. Strict validation lives on the server, which
 * is the side that actually authorizes the request.
 */
export function parsePublicBooleanFlag(rawValue: string | undefined) {
  const value = rawValue?.trim().toLowerCase();
  return value === 'true' || value === '1';
}
