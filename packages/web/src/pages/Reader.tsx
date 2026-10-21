// Reader: one item at a time, in the feed's current order. Either full screen ("overlay", where
// Back closes it) or as the right-hand pane of the split layout ("pane", D-070).
// Next/previous via buttons, swipe (phone) or keys (→/j, ←/k); Esc closes.
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { FeedItem, ReaderComments, ReaderContent, ReaderPagination } from "@fa/shared";
import { api, errorMessage } from "../api";
import { KIND_LABEL } from "../kinds";
import { readPrefs } from "../prefs";
import { fullDate, relativeTime } from "../time";

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

const THREAD_LINK = /\/threads\/[^/]+\.\d+(\/|$)/;

/** Where an item opens (D-088): forum threads on the page chosen in Settings; a followed thread's card on its new replies. */
function startPage(item: FeedItem): Page {
  if (item.sourceKind === "thread" || !item.url) return undefined;
  try {
    return THREAD_LINK.test(new URL(item.url).pathname) && readPrefs().threadStart === "last" ? "last" : undefined;
  } catch {
    return undefined;
  }
}

async function loadContent(item: FeedItem, page: Page): Promise<ReaderContent> {
  const key = `${cacheKey(item)}|${page ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const content = await api<ReaderContent>("GET", `/api/items/${item.id}/reader${page === undefined ? "" : `?page=${page}`}`);
  cache.set(key, content);
  if (content.pagination && page === "last") cache.set(`${cacheKey(item)}|${content.pagination.page}`, content);
  return content;
}

export function Reader({ mode, items, index, hasMore, onIndexChange, onLoadMore, onUpdate, onClose }: Props) {
  const item = items[index];
  const [content, setContent] = useState<ReaderContent>();
  const [error, setError] = useState<string>();
  const [page, setPage] = useState<Page>(() => (item ? startPage(item) : undefined));
  // The pager stays put while the next page loads.
  const [pager, setPager] = useState<ReaderPagination | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const closing = useRef(false);

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
  if (shownKey.current !== itemKey) {
    shownKey.current = itemKey;
    setPage(item ? startPage(item) : undefined);
    setPager(null);
  }

  // Load the current item (or another page of a thread); mark it read; warm up the next item.
  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    setContent(undefined);
    setError(undefined);
    scroller.current?.scrollTo({ top: 0 });
    if (!item.read) onUpdate(item, { read: true });
    loadContent(item, page)
      .then((c) => {
        if (cancelled) return;
        setContent(c);
        setPager(c.pagination && c.pagination.pages > 1 ? c.pagination : null);
      })
      .catch((err) => !cancelled && setError(errorMessage(err)));
    const next = items[index + 1];
    if (next) void loadContent(next, startPage(next)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [itemKey, page]); // only when the item (or a thread card's replies) or the page changes

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
                <button className="secondary" onClick={() => setPage(readPrefs().threadStart === "last" ? "last" : 1)}>
                  Read the whole thread
                </button>
              ) : (
                <button className="secondary" onClick={() => setPage(undefined)}>
                  ← Back to the new replies
                </button>
              )}
            </p>
          )}

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

          {content?.html && (
            // Sanitised on the server (reader/sanitize.ts); the CSP blocks scripts as a second line of defence.
            <div className="reader-content" dangerouslySetInnerHTML={{ __html: content.html }} />
          )}

          {content && !content.html && content.summary && <p className="reader-summary">{content.summary}</p>}

          {content?.notice && (
            <div className="alert alert-info">
              {content.notice} {item.url && !/original/i.test(content.notice) && "Use “Open original” to read it on the site."}
            </div>
          )}

          {item.sourceKind === "reddit" && <Comments key={item.id} itemId={item.id} site="Reddit" />}
          {/* YouTube: loads by itself (1 unit of the user's API quota, cached); without a key the server just says how to add one. */}
          {item.sourceKind === "youtube" && <Comments key={item.id} itemId={item.id} site="YouTube" autoLoad />}
        </article>
      </div>

      {pager && <Pager pagination={pager} onGo={(n) => setPage(n)} />}
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
