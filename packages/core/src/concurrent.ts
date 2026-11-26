// A poll's reads side by side, a few at a time: each one is a network round
// trip, so in a row they add up to seconds, and all at once they trip a
// rate limit. Results keep the input's order, so whatever is built from them
// reads as if the calls ran one after another. The first error rejects the
// whole run, after the calls already in flight finish.

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed: { err: unknown } | null = null;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]!, i);
      } catch (err) {
        failed ??= { err };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker),
  );
  if (failed) {
    throw (failed as { err: unknown }).err;
  }
  return out;
}
