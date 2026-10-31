import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { canTrackThreadContent, reachedThreadPost, trackThreadPosition } from "../../web/src/threadPosition.js";
import type { ReaderContent } from "@fa/shared";

describe("thread reading position in the viewport", () => {
  it("pauses the entire view when any appended page is incomplete or stale", () => {
    const complete = { threadProgress: { tracking: true }, extraction: { status: "complete", stale: false } } as ReaderContent;
    expect(canTrackThreadContent(complete, [complete])).toBe(true);
    for (const status of ["partial", "wrong-page", "access-blocked", "unrecognized", "empty", "failed"] as const) {
      const partial = { ...complete, extraction: { status, stale: false } };
      expect(canTrackThreadContent(complete, [partial])).toBe(false);
      expect(canTrackThreadContent(partial)).toBe(false);
    }
    expect(canTrackThreadContent(complete, [{ ...complete, extraction: { status: "complete", stale: true } }])).toBe(false);
  });
  afterEach(() => vi.useRealTimers());
  function view() {
    vi.useFakeTimers();
    const dom = new JSDOM('<div id="root"><div class="reader-content"><section id="fa-post-1">First</section><section id="fa-post-2">Tall post</section></div></div>', { pretendToBeVisual: true });
    const root = dom.window.document.getElementById("root")!;
    root.getBoundingClientRect = () => ({ top: 0, bottom: 500 } as DOMRect);
    const first = root.querySelector<HTMLElement>("#fa-post-1")!;
    const second = root.querySelector<HTMLElement>("#fa-post-2")!;
    first.getBoundingClientRect = () => ({ bottom: 200 } as DOMRect);
    second.getBoundingClientRect = () => ({ bottom: 1200 } as DOMRect);
    return { dom, root, first, second };
  }

  it("counts only post ends inside the viewport", () => {
    expect(reachedThreadPost([{ id: 1, bottom: -10 }, { id: 2, bottom: 400 }, { id: 3, bottom: 900 }], 0, 500)).toBe(2);
    expect(reachedThreadPost([{ id: 3, bottom: 900 }], 0, 500)).toBeNull();
  });

  it("does not mark a tall post until its end is reached", async () => {
    const { dom, root, second } = view();
    const send = vi.fn(async (_id: number) => ({ saved: true }));
    const stop = trackThreadPosition(root, 0, send, () => {});
    await vi.advanceTimersByTimeAsync(750);
    expect(send.mock.calls.map(([id]) => id)).toEqual([1]);
    second.getBoundingClientRect = () => ({ bottom: 450 } as DOMRect);
    root.dispatchEvent(new dom.window.Event("scroll"));
    await vi.advanceTimersByTimeAsync(750);
    expect(send.mock.calls.map(([id]) => id)).toEqual([1, 2]);
    await stop();
    dom.window.close();
  });

  it("flushes the captured old post on close without inspecting replacement content", async () => {
    const { dom, root } = view();
    const send = vi.fn(async (_id: number) => ({ saved: true }));
    const stop = trackThreadPosition(root, 0, send, () => {});
    root.innerHTML = '<div class="reader-content"><section id="fa-post-999">Different thread</section></div>';
    await stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(send.mock.calls.map(([id]) => id)).toEqual([1]);
    dom.window.close();
  });

  it("does not advance past an unread image that is still loading", async () => {
    const { dom, root, first, second } = view();
    first.innerHTML = '<img src="https://images.example/chart.png">';
    const img = first.querySelector("img")!;
    Object.defineProperty(img, "complete", { configurable: true, value: false });
    second.getBoundingClientRect = () => ({ bottom: 450 } as DOMRect);
    const send = vi.fn(async (_id: number) => ({ saved: true }));
    const stop = trackThreadPosition(root, 0, send, () => {});
    await vi.advanceTimersByTimeAsync(750);
    expect(send).not.toHaveBeenCalled();
    Object.defineProperty(img, "complete", { configurable: true, value: true });
    img.dispatchEvent(new dom.window.Event("load"));
    await vi.advanceTimersByTimeAsync(750);
    expect(send).toHaveBeenCalledWith(2);
    await stop();
    dom.window.close();
  });

  it("retries a failed save on further scrolling and flushes on pagehide", async () => {
    const { dom, root } = view();
    const send = vi.fn(async (_id: number) => ({ saved: true })).mockRejectedValueOnce(new Error("offline"));
    const errors = vi.fn();
    const stop = trackThreadPosition(root, 0, send, errors);
    await vi.advanceTimersByTimeAsync(750);
    expect(errors).toHaveBeenLastCalledWith(true);
    root.dispatchEvent(new dom.window.Event("scroll"));
    dom.window.dispatchEvent(new dom.window.Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenLastCalledWith(false);
    await stop();
    dom.window.close();
  });
});
