/** A profile photo URL the app will load (http/https with a host), or null for the default avatar. */
export function profileImageUri(value?: string | null): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname
      ? url.href : null;
  } catch {
    return null;
  }
}
