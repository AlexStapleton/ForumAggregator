// Exercise the UI's async state coordinator without a browser or React rendering.
import { describe, expect, it } from "vitest";
import { createItemUpdater, type ItemFlags, type ItemPatch } from "../../web/src/itemUpdates.js";

function harness() {
  let shown: ItemFlags = { read: false, saved: false };
  const requests: Array<{ id: string; patch: ItemPatch; resolve: () => void; reject: (error: Error) => void }> = [];
  const update = createItemUpdater((id, patch) => new Promise<void>((resolve, reject) => requests.push({ id, patch, resolve, reject })), (_id, flags) => { shown = flags; });
  return { requests, update: (patch: ItemPatch, id = "item") => update(id, shown, patch), shown: () => shown };
}

describe("optimistic item updates", () => {
  it("preserves a newer save when marking read fails", async () => {
    const h = harness();
    const read = h.update({ read: true }).catch(() => undefined);
    const save = h.update({ saved: true });
    expect(h.shown()).toEqual({ read: true, saved: true });
    expect(h.requests).toHaveLength(1);
    h.requests[0]!.reject(new Error("offline"));
    await read;
    expect(h.shown()).toEqual({ read: false, saved: true });
    h.requests[1]!.resolve();
    await save;
    expect(h.shown()).toEqual({ read: false, saved: true });
  });

  it("rebases two failed changes to the same flag onto confirmed state", async () => {
    const h = harness();
    const first = h.update({ saved: true }).catch(() => undefined);
    const second = h.update({ saved: false }).catch(() => undefined);
    h.requests[0]!.reject(new Error("first failed"));
    await first;
    expect(h.shown().saved).toBe(false);
    h.requests[1]!.reject(new Error("second failed"));
    await second;
    expect(h.shown().saved).toBe(false);
  });

  it("sends same-item toggles in click order and retains the last successful state", async () => {
    const h = harness();
    const first = h.update({ saved: true });
    const second = h.update({ saved: false }).catch(() => undefined);
    expect(h.requests).toHaveLength(1);
    h.requests[0]!.resolve();
    await first;
    expect(h.requests[1]!.patch).toEqual({ saved: false });
    expect(h.shown().saved).toBe(false);
    h.requests[1]!.reject(new Error("failed"));
    await second;
    expect(h.shown().saved).toBe(true);
  });

  it("allows different items to save independently", async () => {
    const h = harness();
    const first = h.update({ saved: true }, "one");
    const second = h.update({ read: true }, "two");
    expect(h.requests.map((r) => r.id)).toEqual(["one", "two"]);
    h.requests.forEach((r) => r.resolve());
    await Promise.all([first, second]);
  });
});
