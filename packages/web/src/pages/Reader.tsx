// Reader: one item at a time, in the feed's current order. Either full screen ("overlay", where
// Back closes it) or as the right-hand pane of the split layout ("pane", D-070).
// Next/previous via buttons, swipe (phone) or keys (→/j, ←/k); Esc closes.
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { FeedItem, ReaderComments, ReaderContent, ReaderPagination } from "@fa/shared";
import { api, errorMessage } from "../api";
import { AudioPlayer } from "../AudioPlayer";
import { RedditMediaView } from "../RedditMedia";
import { KIND_LABEL } from "../kinds";
import { readPrefs } from "../prefs";
import { fullDate, relativeTime } from "../time";
import { canTrackThreadContent, trackThreadPosition } from "../threadPosition";
import { enhanceQuotes } from "../quoteContext";

interface Props {
  mode: "overlay" | "pane";
  items: FeedItem[];
  index: number;
  hasMore: boolean;
  onIndexChange: (index: number) => void;
  onLoadMore: () => Promise<void>;
  onUpdate: (item: FeedItem, patch: { read?: boolean; saved?: boolean }) => void;
  onClose: () => void;
}

/**
 * Content already loaded this visit. Keyed by the item *as listed*, not just its ID: a followed
 * thread keeps one card whose date and summary change with new replies (D-084).
 */
const cache = new Map<string, ReaderContent>();
const cacheKey = (item: FeedItem) => `${item.id}|${item.publishedAt}|${item.summary ?? ""}`;

/** A page of a forum thread: a number, the newest ("last"), or undefined for the item's default. */
type Page = number | "last" | undefined;

/** XenForo thread links, and vBulletin ones (D-099; the server only pages those from a vBulletin board's feed). */
const THREAD_LINK = /\/threads\/[^/]+\.\d+(\/|$)|\/\d+-[^/]+\.html$|\/showthread\.php$/;

/** Where an item opens (D-088): forum threads on the page chosen in Settings; a followed thread's card on its new replies. */
function startPage(item: FeedItem): Page {
  if (item.sourceKind === "thread" || !item.url) return undefined;
  // A board's thread card is about its new replies (D-123): the newest page, whatever the setting.
  if (item.sourceKind === "board") return "last";
  try {
    return THREAD_LINK.test(new URL(item.url).pathname) && readPrefs().threadStart === "last" ? "last" : undefined;
  } catch {
    return undefined;
  }
}

async function loadContent(item: FeedItem, page: Page): Promise<ReaderContent> {
  const key = `${cacheKey(item)}|${page ?? ""}`;
  const hit = cache.get(key);
  if (hit && item.sourceKind !== "thread") return hit;
  const content = await api<ReaderContent>("GET", `/api/items/${item.id}/reader${page === undefined ? "" : `?page=${page}`}`);
  if (item.sourceKind !== "thread" && (!content.extraction || content.extraction.status === "complete")) {
    cache.set(key, content);
    if (content.pagination && page === "last") cache.set(`${cacheKey(item)}|${content.pagination.page}`, content);
  }
  return content;
}

export function Reader({ mode, items, index, hasMore, onIndexChange, onLoadMore, onUpdate, onClose }: Props) {
  const item = items[index];
  const [content, setContent] = useState<ReaderContent>();
  const [error, setError] = useState<string>();
  const [positionError, setPositionError] = useState<string>();
  const [reload, setReload] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [page, setPage] = useState<Page>(() => (item ? startPage(item) : undefined));
  // The pager stays put while the next page loads.
  const [pager, setPager] = useState<ReaderPagination | null>(null);
  // Thread pages added below the current one with "Load next page" (D-100).
  const [more, setMore] = useState<ReaderContent[]>([]);
  const [moreState, setMoreState] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const scroller = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const closing = useRef(false);
  const pendingPositions = useRef(new Map<string, Promise<unknown>>());

  // Full screen: browser/phone Back closes the reader instead of leaving the page.
  useEffect(() => {
    if (mode !== "overlay") return;
    closing.current = false;
    history.pushState({ faReader: true }, "");
    const onPop = () => {
      closing.current = true;
      onClose();
    };
    window.addEventListener("popstate", onPop);
    document.body.classList.add("reader-open");
    return () => {
      window.removeEventListener("popstate", onPop);
      document.body.classList.remove("reader-open");
    };
  }, [onClose, mode]);

  const close = useCallback(() => {
    if (mode === "pane") return onClose();
    if (closing.current) return;
    closing.current = true;
    history.back(); // triggers popstate → onClose
  }, [mode, onClose]);

  // A different item starts on its own start page.
  const itemKey = item ? cacheKey(item) : null;
  const shownKey = useRef(itemKey);
  const shownItem = useRef(item?.id);
  if (shownKey.current !== itemKey) {
    shownKey.current = itemKey;
    if (shownItem.current !== item?.id) {
      shownItem.current = item?.id;
      setPage(item ? startPage(item) : undefined);
      setPager(null);
    }
  }
  const requestKey = `${itemKey}|${page ?? ""}|${reload}`;
  const currentRequest = useRef(requestKey);
  currentRequest.current = requestKey;

  // Load the current item (or another page of a thread); mark it read; warm up the next item.
  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    setContent(undefined);
    setError(undefined);
    setPositionError(undefined);
    setRetrying(false);
    setMore([]);
    setMoreState({ busy: false });
    scroller.current?.scrollTo({ top: 0 });
    if (!item.read) onUpdate(item, { read: true });
    (pendingPositions.current.get(item.id) ?? Promise.resolve()).then(() => loadContent(item, page))
      .then((c) => {
        if (cancelled) return;
        setContent(c);
        setPager(c.pagination && c.pagination.pages > 1 ? c.pagination : null);
      })
      .catch((err) => !cancelled && setError(errorMessage(err)));
    const next = items[index + 1];
    if (next && next.sourceKind !== "thread") void loadContent(next, startPage(next)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [itemKey, page, reload]); // only when the item (or a thread card's replies) or the page changes

  // Account-specific resume target; leave a little preceding context visible.
  useEffect(() => {
    const root = scroller.current;
    const target = content?.threadProgress?.firstUnreadPostId;
    if (!root || !target) return;
    const post = root.querySelector(`#fa-post-${target}`);
    if (post) root.scrollTo({ top: root.scrollTop + post.getBoundingClientRect().top - root.getBoundingClientRect().top - 80 });
  }, [content]);

  // Quote controls persist while pages append; a new reading request resets the excursion.
  useEffect(() => {
    const root = scroller.current;
    if (!root || !item?.url) return;
    return enhanceQuotes(root, item.url);
  }, [item?.id, item?.url, requestKey]);

  // Save after scrolling settles, and send the last visible position when leaving the page.
  useEffect(() => {
    const root = scroller.current;
    if (!root || !item || content?.itemId !== item.id || !canTrackThreadContent(content, more)) return;
    const stop = trackThreadPosition(root, content.threadProgress!.readPostId ?? 0,
      (postId) => api<{ saved: boolean }>("PUT", `/api/items/${item.id}/thread-position`, { postId }, { keepalive: true }),
      (failed) => setPositionError(failed ? "Couldn't save your reading position. Scroll again to retry." : undefined));
    return () => {
      const pending = Promise.all([pendingPositions.current.get(item.id), stop()]);
      pendingPositions.current.set(item.id, pending);
      void pending.then(() => {
        if (pendingPositions.current.get(item.id) === pending) pendingPositions.current.delete(item.id);
      });
    };
  }, [content, more, item?.id, requestKey]);

  // Forum post times in this device's time zone, from the exact time (D-102): the forum's own label
  // ("2d ago", "Today at 8:00 AM") was right only when the page was read.
  useEffect(() => {
    for (const el of Array.from(scroller.current?.querySelectorAll(".reader-content time[datetime]") ?? [])) {
      const at = Date.parse(el.getAttribute("datetime") ?? "");
      if (!Number.isFinite(at)) continue;
      el.textContent = new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      el.setAttribute("title", relativeTime(at));
    }
  }, [content, more]);

  // The last thread page shown, and whether there's one after it.
  const lastShown = more.at(-1)?.pagination ?? content?.pagination ?? null;
  const incomplete = [content, ...more].some((c) => c?.extraction && c.extraction.status !== "complete");
  const nextPage = !incomplete && lastShown && lastShown.page < lastShown.pages ? lastShown.page + 1 : null;
  const retry = async () => {
    if (!item || retrying) return;
    const forRequest = currentRequest.current;
    setRetrying(true);
    try {
      if (item.sourceKind === "thread") await api("POST", `/api/sources/${item.sourceId}/check`);
      if (currentRequest.current === forRequest) {
        cache.delete(`${cacheKey(item)}|${page ?? ""}`);
        setReload((n) => n + 1);
      }
    } catch (err) {
      if (currentRequest.current === forRequest) setError(errorMessage(err));
    } finally { if (currentRequest.current === forRequest) setRetrying(false); }
  };
  const loadNextPage = async () => {
    if (!item || nextPage === null || moreState.busy) return;
    const forRequest = currentRequest.current;
    setMoreState({ busy: true });
    try {
      const c = await loadContent(item, nextPage);
      if (currentRequest.current !== forRequest) return;
      setMore((m) => [...m, c]);
      // The pager follows the bottom of what's shown, so › continues from there.
      if (c.pagination) setPager(c.pagination);
      setMoreState({ busy: false });
    } catch (err) {
      if (currentRequest.current !== forRequest) return;
      setMoreState({ busy: false, error: errorMessage(err) });
    }
  };

  // A page from the pager. The page the reader opened on (with pages added below it) only needs those removed.
  const goToPage = (n: number) => {
    if (n !== page || !content) return setPage(n);
    setMore([]);
    setMoreState({ busy: false });
    setPager(content.pagination && content.pagination.pages > 1 ? content.pagination : null);
    scroller.current?.scrollTo({ top: 0 });
  };

  const go = useCallback(
    async (delta: 1 | -1) => {
      const target = index + delta;
      if (target < 0) return;
      if (target >= items.length) {
        if (!hasMore) return;
        await onLoadMore();
      }
      onIndexChange(target);
    },
    [index, items.length, hasMore, onLoadMore, onIndexChange],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Includes the podcast player's position slider: arrow keys seek there instead of changing items.
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "ArrowRight" || e.key === "j") void go(1);
      else if (e.key === "ArrowLeft" || e.key === "k") void go(-1);
      else if (e.key === "Escape") close();
      else if (e.key === "s" && item) onUpdate(item, { saved: !item.saved });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, close, item, onUpdate]);

  if (!item) return null;
  const atEnd = index >= items.length - 1 && !hasMore;

  return (
    <div
      className={mode === "pane" ? "reader reader-pane" : "reader"}
      role={mode === "overlay" ? "dialog" : "region"}
      aria-modal={mode === "overlay" || undefined}
      aria-label={mode === "overlay" ? item.title : "Reader"}
      onTouchStart={(e) => {
        const t = e.touches[0];
        touch.current = t ? { x: t.clientX, y: t.clientY } : null;
      }}
      onTouchEnd={(e) => {
        const start = touch.current;
        const t = e.changedTouches[0];
        touch.current = null;
        if (!start || !t) return;
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        // A deliberate horizontal swipe: far enough, and clearly more sideways than up/down.
        if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.8) void go(dx < 0 ? 1 : -1);
      }}
    >
      <header className="reader-bar">
        <button className="link" onClick={close} aria-label="Close reader">
          ✕ Close
        </button>
        <span className="muted small">
          {index + 1} / {items.length}
          {hasMore ? "+" : ""}
        </span>
      </header>

      <div className="reader-scroll" ref={scroller}>
        <article className="reader-article">
          <div className="item-meta">
            <span className={`kind kind-${item.sourceKind}`}>{KIND_LABEL[item.sourceKind]}</span>
            <span>{item.sourceTitle}</span>
            {(content?.author ?? item.author) && <span>· {content?.author ?? item.author}</span>}
            <time title={fullDate(item.publishedAt)}>· {relativeTime(item.publishedAt)}</time>
          </div>
          <h1 className="reader-title">{item.title}</h1>
          {item.tags.length > 0 && (
            <div className="tags">
              {item.tags.map((t) => (
                <span key={t} className="tag">
                  #{t}
                </span>
              ))}
            </div>
          )}

          {item.sourceKind === "thread" && (
            // A followed thread's card shows its new replies; this switches to the thread itself (D-088).
            <p className="thread-switch">
              {page === undefined ? (
                // On the newest page, where the new replies are (D-102); ‹ and the page bar go further back.
                <button className="secondary" onClick={() => setPage("last")}>
                  Read the whole thread
                </button>
              ) : (
                <button className="secondary" onClick={() => setPage(undefined)}>
                  ← Back to the new replies
                </button>
              )}
            </p>
          )}

          {/* From the feed: shown straight away. Found on the story's page (D-096): once that's read. */}
          {(item.audio ?? content?.audio) && <AudioPlayer key={`audio-${item.id}`} itemId={item.id} audio={(item.audio ?? content?.audio)!} />}

          {error && <div className="alert alert-error">{error}</div>}
          {!content && !error && <p className="muted reader-loading">Loading…</p>}

          {content?.kind === "video" && content.videoId && (
            <div className="video">
              <iframe
                src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(content.videoId)}`}
                title={item.title}
                allow="encrypted-media; picture-in-picture; fullscreen"
                allowFullScreen
                // YouTube's player needs to know the embedding origin; the app's default is no-referrer.
                referrerPolicy="strict-origin-when-cross-origin"
              />
            </div>
          )}

          {/* Keys differ between these siblings: the same key twice makes React duplicate one. */}
          {content?.redditMedia && <RedditMediaView key={`media-${item.id}`} itemId={item.id} hint={content.redditMedia} postUrl={item.url} />}

          {content?.extraction && content.notice && (
            <div className="alert alert-info" role="status">
              <p>{content.notice}</p>
              <button className="secondary" disabled={retrying} onClick={() => void retry()}>{retrying ? "Retrying…" : "Retry"}</button>
              {item.url && <> <a href={item.url} target="_blank" rel="noopener noreferrer">Open original ↗</a></>}
            </div>
          )}
          {content?.html && (
            // Sanitised on the server (reader/sanitize.ts); the CSP blocks scripts as a second line of defence.
            <div className="reader-content" dangerouslySetInnerHTML={{ __html: content.html }} />
          )}

          {positionError && <div className="alert alert-error">{positionError}</div>}
          {content?.threadProgress?.hasMore && page === undefined && (
            <button className="secondary" disabled={!content.threadProgress.tracking} onClick={async () => {
              const forRequest = currentRequest.current;
              const ids = [...(content.html ?? "").matchAll(/<section id="fa-post-(\d+)"/g)].map((m) => Number(m[1]));
              if (!ids.length) return;
              try {
                await api("PUT", `/api/items/${item.id}/thread-position`, { postId: Math.max(...ids) });
                if (currentRequest.current === forRequest) setReload((n) => n + 1);
              } catch { if (currentRequest.current === forRequest) setPositionError("Couldn't save your reading position. Try continuing again."); }
            }}>Continue to more unread replies</button>
          )}

          {more.map((c) => (
            <section key={c.pagination?.page} aria-label={`Page ${c.pagination?.page}`}>
              <p className="page-divider">Page {c.pagination?.page}</p>
              {c.notice && <div className="alert alert-info" role="status">{c.notice}
                {c.extraction && c.extraction.status !== "complete" && c.pagination &&
                  <button className="secondary" onClick={() => goToPage(c.pagination!.page)}>Retry this page</button>}
              </div>}
              {c.html && <div className="reader-content" dangerouslySetInnerHTML={{ __html: c.html }} />}
            </section>
          ))}
          {content && nextPage !== null && (
            <div className="load-next">
              {moreState.error && <div className="alert alert-error">{moreState.error}</div>}
              <button className="secondary" onClick={() => void loadNextPage()} disabled={moreState.busy}>
                {moreState.busy ? "Loading…" : `Load next page (${nextPage} of ${lastShown!.pages})`}
              </button>
            </div>
          )}

          {content && !content.html && content.summary && <p className="reader-summary">{content.summary}</p>}

          {content?.notice && !content.extraction && (
            <div className="alert alert-info">
              {content.notice} {item.url && !/original/i.test(content.notice) && "Use “Open original” to read it on the site."}
            </div>
          )}

          {item.sourceKind === "reddit" && <Comments key={`reddit-${item.id}`} itemId={item.id} site="Reddit" />}
          {/* YouTube: loads by itself (1 unit of the user's API quota, cached); without a key the server just says how to add one. */}
          {item.sourceKind === "youtube" && <Comments key={`youtube-${item.id}`} itemId={item.id} site="YouTube" autoLoad />}
        </article>
      </div>

      {pager && <Pager pagination={pager} onGo={goToPage} />}
      <footer className="reader-bar reader-nav">
        <button className="secondary" onClick={() => void go(-1)} disabled={index === 0} aria-label="Previous item">
          ← Prev
        </button>
        <button className="secondary" aria-pressed={item.saved} onClick={() => onUpdate(item, { saved: !item.saved })}>
          {item.saved ? "★ Saved" : "☆ Save"}
        </button>
        {item.url && (
          <a className="button secondary" href={item.url} target="_blank" rel="noopener noreferrer">
            Open original ↗
          </a>
        )}
        <button onClick={() => void go(1)} disabled={atEnd} aria-label="Next item">
          {atEnd ? "End" : "Next →"}
        </button>
      </footer>
    </div>
  );
}

/**
 * Comments under the article. Reddit: loaded only when asked (each load is a request against
 * Reddit's limit). YouTube: top comments via the API key from Settings, loaded straight away.
 */
function Comments({ itemId, site, autoLoad = false }: { itemId: string; site: "Reddit" | "YouTube"; autoLoad?: boolean }) {
  const [state, setState] = useState<"idle" | "loading" | "done">(autoLoad ? "loading" : "idle");
  const [data, setData] = useState<ReaderComments>();
  const [error, setError] = useState<string>();

  const load = async () => {
    setState("loading");
    setError(undefined);
    try {
      setData(await api<ReaderComments>("GET", `/api/items/${itemId}/comments`));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setState("done");
    }
  };

  useEffect(() => {
    if (autoLoad) void load();
  }, []); // once: the component is keyed by item

  // No key set: a one-line hint instead of an empty section.
  if (data && !data.available) {
    return (
      <p className="muted small comments-hint">
        {data.notice} <a href="#/settings">Open Settings</a>
      </p>
    );
  }

  return (
    <section className="comments" aria-label="Comments">
      <h2 className="comments-title">{site === "YouTube" ? "Top comments" : "Comments"}</h2>
      {state === "idle" && (
        <button className="secondary" onClick={() => void load()}>
          Show comments
        </button>
      )}
      {state === "loading" && <p className="muted">Loading comments…</p>}
      {error && <div className="alert alert-error">{error}</div>}
      {data?.notice && <p className="muted">{data.notice}</p>}
      {data && data.comments.length > 0 && (
        <ol className="comment-list">
          {data.comments.map((c, i) => (
            <li key={c.url ?? i} className="comment">
              <div className="item-meta">
                <strong>{c.author ?? "someone"}</strong>
                {c.publishedAt && <time title={fullDate(c.publishedAt)}>· {relativeTime(c.publishedAt)}</time>}
                {c.likes ? <span title="Likes">· 👍 {c.likes.toLocaleString()}</span> : null}
              </div>
              {/* Sanitised on the server, like the article. */}
              <div className="reader-content comment-body" dangerouslySetInnerHTML={{ __html: c.html }} />
            </li>
          ))}
        </ol>
      )}
      {data?.discussionUrl && state === "done" && (
        <a href={data.discussionUrl} target="_blank" rel="noopener noreferrer" className="small">
          Full discussion on {site} ↗
        </a>
      )}
    </section>
  );
}

/**
 * Pages of a forum thread (D-088), like the forum's own: first, previous, nearby page numbers,
 * next, last, and a box to type a page number.
 */
function Pager({ pagination, onGo }: { pagination: ReaderPagination; onGo: (page: number) => void }) {
  const { page, pages } = pagination;
  const [draft, setDraft] = useState(String(page));
  useEffect(() => setDraft(String(page)), [page]);
  const go = (n: number) => {
    const target = Math.min(Math.max(1, Math.round(n)), pages);
    if (target !== page) onGo(target);
    else setDraft(String(page));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(draft);
    if (Number.isFinite(n)) go(n);
  };
  // 1 … p-1 p p+1 … last
  const numbers: Array<number | "gap"> = [];
  for (const n of [1, page - 1, page, page + 1, pages]) {
    if (n < 1 || n > pages || numbers.includes(n)) continue;
    const prev = numbers[numbers.length - 1];
    if (typeof prev === "number" && n > prev + 1) numbers.push("gap");
    numbers.push(n);
  }
  return (
    <nav className="reader-bar reader-pager" aria-label="Thread pages">
      <button className="secondary" onClick={() => go(1)} disabled={page <= 1} aria-label="First page">«</button>
      <button className="secondary" onClick={() => go(page - 1)} disabled={page <= 1} aria-label="Previous page">‹</button>
      <span className="pager-numbers">
        {numbers.map((n, i) =>
          n === "gap" ? (
            <span key={`gap${i}`} className="muted" aria-hidden="true">…</span>
          ) : (
            <button key={n} className={n === page ? "" : "secondary"} aria-current={n === page ? "page" : undefined} onClick={() => go(n)}>
              {n}
            </button>
          ),
        )}
      </span>
      <form className="pager-jump" onSubmit={submit} noValidate>
        <label>
          <span className="visually-hidden">Go to page</span>
          <input type="number" inputMode="numeric" min={1} max={pages} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={`Page, 1 to ${pages}`} />
        </label>
        <span className="muted small">of {pages}</span>
      </form>
      <button className="secondary" onClick={() => go(page + 1)} disabled={page >= pages} aria-label="Next page">›</button>
      <button className="secondary" onClick={() => go(pages)} disabled={page >= pages} aria-label="Last page">»</button>
    </nav>
  );
}
