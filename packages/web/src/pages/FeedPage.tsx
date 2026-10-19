import { useCallback, useEffect, useRef, useState } from "react";
import type { FeedItem, ItemsFilter, ItemsPage, Source, TagCount } from "@fa/shared";
import { api, errorMessage } from "../api";
import { KIND_LABEL } from "../kinds";
import { Alert } from "../components";
import { fullDate, relativeTime } from "../time";
import { Reader } from "./Reader";

const FILTERS: Array<{ value: ItemsFilter; label: string }> = [
  { value: "unread", label: "Unread" },
  { value: "all", label: "All" },
  { value: "saved", label: "Saved" },
];

export function FeedPage() {
  const [filter, setFilter] = useState<ItemsFilter>("unread");
  const [sourceId, setSourceId] = useState("");
  const [tag, setTag] = useState("");
  const [tags, setTags] = useState<TagCount[]>([]);
  const [readerIndex, setReaderIndex] = useState<number | null>(null);
  const [sources, setSources] = useState<Source[]>();
  const [items, setItems] = useState<FeedItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // Ignore responses from a previous filter if the user switches quickly.
  const requestId = useRef(0);

  const query = useCallback(
    (after?: string | null) => {
      const p = new URLSearchParams({ filter, limit: "40" });
      if (sourceId) p.set("sourceId", sourceId);
      if (tag) p.set("tag", tag);
      if (after) p.set("cursor", after);
      return `/api/items?${p}`;
    },
    [filter, sourceId, tag],
  );

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(undefined);
    try {
      const [page, srcs, tagList] = await Promise.all([
        api<ItemsPage>("GET", query()),
        api<Source[]>("GET", "/api/sources"),
        api<TagCount[]>("GET", "/api/tags"),
      ]);
      if (id !== requestId.current) return;
      setItems(page.items);
      setCursor(page.nextCursor);
      setSources(srcs);
      setTags(tagList);
    } catch (err) {
      if (id === requestId.current) setError(errorMessage(err));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  // Pick up new items when the app comes back to the foreground (e.g. on the phone).
  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && readerIndex === null && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load, readerIndex]);

  const loadMore = async () => {
    if (!cursor) return;
    try {
      const page = await api<ItemsPage>("GET", query(cursor));
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const update = useCallback(async (item: FeedItem, patch: { read?: boolean; saved?: boolean }) => {
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, ...patch } : i)));
    try {
      await api("PATCH", `/api/items/${item.id}`, patch);
    } catch (err) {
      setItems((prev) => prev.map((i) => (i.id === item.id ? item : i)));
      setError(errorMessage(err));
    }
  }, []);
  const closeReader = useCallback(() => setReaderIndex(null), []);

  const markAllRead = async () => {
    const newest = items[0];
    if (!newest) return;
    // Only up to the newest item on screen, so anything that arrived meanwhile stays unread.
    await api("POST", "/api/items/mark-read", { ...(sourceId ? { sourceId } : {}), upTo: newest.publishedAt });
    await load();
  };

  const unreadTotal = sources?.reduce((n, s) => n + s.unreadCount, 0) ?? 0;

  if (sources && sources.length === 0) {
    return (
      <section className="card empty">
        <h1>Your feed</h1>
        <p className="muted">You're not following anything yet.</p>
        <a className="button" href="#/sources">Add your first source</a>
      </section>
    );
  }

  return (
    <>
      {/* While the reader is open, the list behind it is inert (no focus, hidden from screen readers). */}
      <div inert={readerIndex !== null} aria-hidden={readerIndex !== null || undefined}>
      <div className="toolbar">
        <div className="segmented" role="tablist" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              role="tab"
              aria-selected={filter === f.value}
              className={filter === f.value ? "active" : ""}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
              {f.value === "unread" && unreadTotal > 0 && <span className="count">{unreadTotal}</span>}
            </button>
          ))}
        </div>
        <select aria-label="Source" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
          <option value="">All sources</option>
          {sources?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
              {s.unreadCount ? ` (${s.unreadCount})` : ""}
            </option>
          ))}
        </select>
        {tags.length > 0 && (
          <select aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">All tags</option>
            {tags.map((t) => (
              <option key={t.tag} value={t.tag}>
                #{t.tag}
                {t.unread ? ` (${t.unread})` : ""}
              </option>
            ))}
          </select>
        )}
        <div className="toolbar-actions">
          <button className="secondary" onClick={() => void load()} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
          {filter === "unread" && items.length > 0 && (
            <button className="secondary" onClick={() => void markAllRead()}>
              Mark all read
            </button>
          )}
        </div>
      </div>

      {error && <Alert>{error}</Alert>}

      {!loading && items.length === 0 && (
        <p className="muted empty">
          {filter === "unread" ? "All caught up. Nothing unread." : filter === "saved" ? "Nothing saved yet." : "No items yet."}
        </p>
      )}

      <ul className="items">
        {items.map((item, index) => (
          <ItemCard
            key={item.id}
            item={item}
            onUpdate={(p) => void update(item, p)}
            onOpen={() => setReaderIndex(index)}
            onTag={(t) => setTag(t)}
          />
        ))}
      </ul>

      {cursor && (
        <button className="secondary load-more" onClick={() => void loadMore()}>
          Load older items
        </button>
      )}
      </div>

      {readerIndex !== null && (
        <Reader
          items={items}
          index={readerIndex}
          hasMore={cursor !== null}
          onIndexChange={setReaderIndex}
          onLoadMore={loadMore}
          onUpdate={(item, patch) => void update(item, patch)}
          onClose={closeReader}
        />
      )}
    </>
  );
}

function ItemCard({
  item,
  onUpdate,
  onOpen,
  onTag,
}: {
  item: FeedItem;
  onUpdate: (p: { read?: boolean; saved?: boolean }) => void;
  onOpen: () => void;
  onTag: (tag: string) => void;
}) {
  return (
    <li className={`item card${item.read ? " read" : ""}`}>
      <div className="item-body">
        <div className="item-meta">
          <span className={`kind kind-${item.sourceKind}`}>{KIND_LABEL[item.sourceKind]}</span>
          <span>{item.sourceTitle}</span>
          {item.author && item.author !== item.sourceTitle && <span>· {item.author}</span>}
          <time dateTime={new Date(item.publishedAt).toISOString()} title={fullDate(item.publishedAt)}>
            · {relativeTime(item.publishedAt)}
          </time>
        </div>
        <h2 className="item-title">
          <button className="title-button" onClick={onOpen}>
            {item.title}
          </button>
        </h2>
        {item.summary && <p className="item-summary">{item.summary}</p>}
        {item.tags.length > 0 && (
          <div className="tags">
            {item.tags.map((t) => (
              <button key={t} className="tag" onClick={() => onTag(t)} title={`Show only #${t}`}>
                #{t}
              </button>
            ))}
          </div>
        )}
        <div className="item-actions">
          <button className="link" onClick={() => onUpdate({ read: !item.read })}>
            {item.read ? "Mark unread" : "Mark read"}
          </button>
          <button className="link" aria-pressed={item.saved} onClick={() => onUpdate({ saved: !item.saved })}>
            {item.saved ? "★ Saved" : "☆ Save"}
          </button>
          {item.url && (
            <a className="link small" href={item.url} target="_blank" rel="noopener noreferrer" onClick={() => !item.read && onUpdate({ read: true })}>
              Original ↗
            </a>
          )}
        </div>
      </div>
      {item.imageUrl && (
        <button className="item-thumb" onClick={onOpen} tabIndex={-1} aria-hidden="true">
          <img src={item.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
        </button>
      )}
    </li>
  );
}
