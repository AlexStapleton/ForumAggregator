/** Coordinates cursor requests for one feed query, including refreshes of that query. */
export function createFeedPagination<T extends { nextCursor: string | null }>(
  fetchPage: (cursor: string) => Promise<T>,
  append: (page: T) => void,
  onError: (error: unknown) => void,
  onLoading: (loading: boolean) => void,
) {
  let generation = 0;
  let cursor: string | null = null;
  let pending: Promise<void> | undefined;
  return {
    // A refresh or effect cleanup invalidates both successes and failures already in flight.
    reset() {
      generation++;
      cursor = null;
      pending = undefined;
    },
    setCursor(next: string | null) { cursor = next; },
    loadMore(): Promise<void> {
      if (pending) return pending;
      if (cursor === null) return Promise.resolve();
      const id = generation;
      const after = cursor;
      onLoading(true);
      // Defer the fetch so even synchronous failures share the same pending promise.
      pending = Promise.resolve().then(() => fetchPage(after)).then((page) => {
        if (id !== generation) return;
        cursor = page.nextCursor;
        append(page);
      }).catch((error: unknown) => {
        if (id === generation) onError(error);
      }).finally(() => {
        if (id !== generation) return;
        pending = undefined;
        onLoading(false);
      });
      return pending;
    },
  };
}
