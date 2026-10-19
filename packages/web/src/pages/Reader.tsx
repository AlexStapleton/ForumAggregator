// Full-screen reader: one item at a time, in the feed's current order.
// Next/previous via buttons, swipe (phone) or keys (→/j, ←/k); Esc or Back closes.
import { useCallback, useEffect, useRef, useState } from "react";
import type { FeedItem, ReaderContent } from "@fa/shared";
import { api, errorMessage } from "../api";
import { KIND_LABEL } from "../kinds";
import { fullDate, relativeTime } from "../time";

interface Props {
  items: FeedItem[];
  index: number;
  hasMore: boolean;
  onIndexChange: (index: number) => void;
  onLoadMore: () => Promise<void>;
  onUpdate: (item: FeedItem, patch: { read?: boolean; saved?: boolean }) => void;
  onClose: () => void;
}

const cache = new Map<string, ReaderContent>();

async function loadContent(itemId: string): Promise<ReaderContent> {
  const hit = cache.get(itemId);
  if (hit) return hit;
  const content = await api<ReaderContent>("GET", `/api/items/${itemId}/reader`);
  cache.set(itemId, content);
  return content;
}

export function Reader({ items, index, hasMore, onIndexChange, onLoadMore, onUpdate, onClose }: Props) {
  const item = items[index];
  const [content, setContent] = useState<ReaderContent>();
  const [error, setError] = useState<string>();
  const scroller = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const closing = useRef(false);

  // Browser/phone Back closes the reader instead of leaving the page.
  useEffect(() => {
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
  }, [onClose]);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    history.back(); // triggers popstate → onClose
  }, []);

  // Load the current item; mark it read; warm up the next one.
  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    setContent(undefined);
    setError(undefined);
    scroller.current?.scrollTo({ top: 0 });
    if (!item.read) onUpdate(item, { read: true });
    loadContent(item.id)
      .then((c) => !cancelled && setContent(c))
      .catch((err) => !cancelled && setError(errorMessage(err)));
    const next = items[index + 1];
    if (next) void loadContent(next.id).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [item?.id]); // only when the item changes

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
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
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
      className="reader"
      role="dialog"
      aria-modal="true"
      aria-label={item.title}
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
              {content.notice} {item.url && "Use “Open original” to read it on the site."}
            </div>
          )}
        </article>
      </div>

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
