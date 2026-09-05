/**
 * Fan-out helper for the dashboard's bulk actions (#68).
 *
 * There is no batch endpoint: a bulk delete or expiry change is N calls to the
 * existing per-link endpoints. That keeps the API surface small, which is the
 * right trade for a single-operator instance. The two things a raw
 * `Promise.all` would get wrong are what this adds: a cap on requests in
 * flight, and per-item outcomes instead of one rejection swallowing the rest.
 */

export interface BulkResult<T> {
  succeeded: T[];
  /** Items whose call rejected, each with the message to show the operator. */
  failed: { item: T; message: string }[];
}

/** Requests in flight at once. Enough to feel instant, gentle on one server. */
const DEFAULT_CONCURRENCY = 4;

/**
 * Run `task` over every item with at most `concurrency` in flight, in input
 * order. Never rejects — a failing item lands in `failed` and the rest of the
 * batch continues, so the caller can report "8 of 10" honestly.
 */
export async function runBulk<T>(
  items: readonly T[],
  task: (item: T) => Promise<unknown>,
  concurrency = DEFAULT_CONCURRENCY,
): Promise<BulkResult<T>> {
  const succeeded: T[] = [];
  const failed: { item: T; message: string }[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        await task(item);
        succeeded.push(item);
      } catch (err) {
        failed.push({
          item,
          message: err instanceof Error ? err.message : 'Request failed.',
        });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return { succeeded, failed };
}
