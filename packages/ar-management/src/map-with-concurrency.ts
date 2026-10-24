/**
 * Runs `work` over `items` with at most `size` running at once, keeping the order of the items in
 * the results. For handlers that do a few subrequests per tenant over a list of tenants.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}
