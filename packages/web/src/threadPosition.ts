/** Only posts whose end is visible count as reached; a tall, partly read post does not. */
export function reachedThreadPost(posts: Array<{ id: number; bottom: number }>, top: number, bottom: number): number | null {
  const visible = posts.filter((post) => Number.isSafeInteger(post.id) && post.id > 0 && post.bottom > top && post.bottom <= bottom);
  return visible.length ? Math.max(...visible.map((post) => post.id)) : null;
}

/** Capture IDs while the old content is mounted; cleanup must never inspect replacement HTML. */
export function trackThreadPosition(root: HTMLElement, initial: number, send: (id: number) => Promise<{ saved: boolean }>, onError: (failed: boolean) => void) {
  let saved = initial;
  let reached: number | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let pending: Promise<unknown> = Promise.resolve();
  const save = (leaving = false) => {
    if ((root.ownerDocument.hidden && !leaving) || reached === null || reached <= saved) return pending;
    const id = reached;
    const request = send(id).then((result) => {
      if (result.saved) saved = Math.max(saved, id);
      if (!stopped) onError(false);
    }).catch(() => { if (!stopped) onError(true); });
    pending = Promise.all([pending, request]);
    return pending;
  };
  const sample = () => {
    if (root.ownerDocument.hidden || root.dataset.quotePause) return;
    const bounds = root.getBoundingClientRect();
    const posts = [];
    for (const post of Array.from(root.querySelectorAll<HTMLElement>('.reader-content section[id^="fa-post-"]'))) {
      const id = Number(post.id.slice(8));
      if (id > saved && Array.from(post.querySelectorAll("img")).some((img) => !img.complete)) break;
      posts.push({ id, bottom: post.getBoundingClientRect().bottom });
    }
    const visible = reachedThreadPost(posts, bounds.top, bounds.bottom);
    if (visible !== null) reached = Math.max(reached ?? 0, visible);
    clearTimeout(timer);
    timer = setTimeout(() => { void save(); }, 750);
  };
  const leaving = () => { void save(true); };
  root.addEventListener("scroll", sample);
  root.addEventListener("load", sample, true);
  root.ownerDocument.defaultView?.addEventListener("pagehide", leaving);
  sample();
  return () => {
    clearTimeout(timer);
    stopped = true;
    root.removeEventListener("scroll", sample);
    root.removeEventListener("load", sample, true);
    root.ownerDocument.defaultView?.removeEventListener("pagehide", leaving);
    return save(true);
  };
}
