export interface ItemFlags { read: boolean; saved: boolean }
export type ItemPatch = Partial<ItemFlags>;

interface Pending {
  patch: ItemPatch;
  resolve: () => void;
  reject: (error: unknown) => void;
}
interface Queue {
  confirmed: ItemFlags;
  pending: Pending[];
}

/** Preserve click order per item, and rebase optimistic flags after a failed request. */
export function createItemUpdater(
  send: (id: string, patch: ItemPatch) => Promise<unknown>,
  publish: (id: string, flags: ItemFlags) => void,
) {
  const queues = new Map<string, Queue>();
  const show = (id: string, queue: Queue) => {
    const flags = queue.pending.reduce((state, op) => ({ ...state, ...op.patch }), queue.confirmed);
    publish(id, flags);
  };
  const drain = async (id: string, queue: Queue) => {
    while (queue.pending.length) {
      const op = queue.pending[0]!;
      let failure: unknown;
      let failed = false;
      try {
        await send(id, op.patch);
        queue.confirmed = { ...queue.confirmed, ...op.patch };
      } catch (error) {
        failed = true;
        failure = error;
      }
      queue.pending.shift();
      show(id, queue);
      if (failed) op.reject(failure);
      else op.resolve();
    }
    queues.delete(id);
  };
  return (id: string, current: ItemFlags, patch: ItemPatch): Promise<void> => {
    let queue = queues.get(id);
    const start = !queue;
    if (!queue) {
      queue = { confirmed: { read: current.read, saved: current.saved }, pending: [] };
      queues.set(id, queue);
    }
    const done = new Promise<void>((resolve, reject) => queue!.pending.push({ patch: { ...patch }, resolve, reject }));
    show(id, queue);
    if (start) void drain(id, queue);
    return done;
  };
}
