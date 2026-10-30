import { describe, expect, it } from "vitest";
import { createFeedPagination } from "../../web/src/feedPagination.js";

type Page = { items: string[]; nextCursor: string | null };
function harness() {
  const requests: Array<{ cursor: string; resolve: (page: Page) => void; reject: (error: Error) => void }> = [];
  const pages: Page[] = [];
  const errors: unknown[] = [];
  const loading: boolean[] = [];
  const pager = createFeedPagination<Page>(
    (cursor) => new Promise((resolve, reject) => requests.push({ cursor, resolve, reject })),
    (page) => pages.push(page), (error) => errors.push(error), (value) => loading.push(value),
  );
  pager.setCursor("first");
  return { pager, requests, pages, errors, loading };
}

describe("feed pagination", () => {
  it("shares a pending page between repeated button and reader requests", async () => {
    const h = harness();
    const first = h.pager.loadMore();
    expect(h.pager.loadMore()).toBe(first);
    await Promise.resolve();
    expect(h.requests).toHaveLength(1);
    h.requests[0]!.resolve({ items: ["older"], nextCursor: "second" });
    await first;
    expect(h.pages).toHaveLength(1);
    const second = h.pager.loadMore();
    await Promise.resolve();
    expect(h.requests[1]!.cursor).toBe("second");
    h.requests[1]!.resolve({ items: ["last"], nextCursor: null });
    await second;
    await h.pager.loadMore();
    expect(h.requests).toHaveLength(2);
    expect(h.loading).toEqual([true, false, true, false]);
  });

  it.each(["success", "failure"])("ignores a stale %s after refresh without unlocking a newer request", async (outcome) => {
    const h = harness();
    const old = h.pager.loadMore();
    await Promise.resolve();
    h.pager.reset();
    await h.pager.loadMore(); // Refresh has not supplied its cursor yet.
    expect(h.requests).toHaveLength(1);
    h.pager.setCursor("refreshed");
    const current = h.pager.loadMore();
    await Promise.resolve();
    if (outcome === "success") h.requests[0]!.resolve({ items: ["stale"], nextCursor: "wrong" });
    else h.requests[0]!.reject(new Error("stale error"));
    await old;
    expect(h.pages).toEqual([]);
    expect(h.errors).toEqual([]);
    expect(h.loading).toEqual([true, true]);
    expect(h.pager.loadMore()).toBe(current);
    h.requests[1]!.resolve({ items: ["current"], nextCursor: null });
    await current;
    expect(h.pages).toEqual([{ items: ["current"], nextCursor: null }]);
    expect(h.requests[1]!.cursor).toBe("refreshed");
  });

  it("discards an old query response arriving after the new query completes", async () => {
    const old = harness();
    const request = old.pager.loadMore();
    await Promise.resolve();
    old.pager.reset(); // Effect cleanup on filter/source/order/tag change or unmount.
    const next = harness();
    const current = next.pager.loadMore();
    await Promise.resolve();
    next.requests[0]!.resolve({ items: ["new filter"], nextCursor: null });
    await current;
    old.requests[0]!.resolve({ items: ["old filter"], nextCursor: "old cursor" });
    await request;
    await old.pager.loadMore();
    expect(old.pages).toEqual([]);
    expect(old.requests).toHaveLength(1);
    expect(next.pages[0]!.items).toEqual(["new filter"]);
  });

  it("releases a failed current request and retries the same cursor", async () => {
    const h = harness();
    const first = h.pager.loadMore();
    await Promise.resolve();
    h.requests[0]!.reject(new Error("offline"));
    await first;
    expect(h.errors).toHaveLength(1);
    expect(h.loading).toEqual([true, false]);
    const retry = h.pager.loadMore();
    await Promise.resolve();
    expect(h.requests[1]!.cursor).toBe("first");
    h.requests[1]!.resolve({ items: ["retried"], nextCursor: null });
    await retry;
    expect(h.pages[0]!.items).toEqual(["retried"]);
  });
});
