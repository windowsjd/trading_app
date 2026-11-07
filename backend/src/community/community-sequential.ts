/**
 * Runs queries of one interactive transaction one after another. A
 * transaction is one connection: concurrent calls on it only queue inside
 * the driver (deprecated by pg), so new code awaits each in turn.
 */
export async function sequential<T extends readonly (() => Promise<unknown>)[]>(
  tasks: T,
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const results: unknown[] = [];
  for (const task of tasks) results.push(await task());
  return results as { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
}
