/**
 * Maps over `items` with at most `limit` operations in flight, preserving order.
 *
 * Failures are the caller's business: `worker` is expected to handle its own errors,
 * so one unanalysable test never cancels the others.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const size = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const run = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: size }, run));
  return results;
}
