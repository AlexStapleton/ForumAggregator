import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FeedItem, ItemsFilter, ItemsOrder, ItemsPage, Source, TagCount } from "@fa/shared";
import { api, errorMessage } from "../api";
import { KIND_LABEL } from "../kinds";
import { Alert } from "../components";
import { usePrefs, useSplitView } from "../prefs";
import { dayLabel, durationLabel, fullDate, relativeTime, startOfDay } from "../time";
import { Reader } from "./Reader";
import { SourcePicker } from "./SourcePicker";
import { createItemUpdater } from "../itemUpdates";

const FILTERS: Array<{ value: ItemsFilter; label: string }> = [
  { value: "unread", label: "Unread" },
  { value: "all", label: "All" },
  { value: "saved", label: "Saved" },
];

export function FeedPage() {
  const [filter, setFilter] = useState<ItemsFilter>("unread");
  const [tag, setTag] = useState("");
  const [tags, setTags] = useState<TagCount[]>([]);
  const [prefs, setPrefs] = usePrefs();
  const order = prefs.order;
  const split = useSplitView(prefs.layout);
  const hidden = prefs.hiddenSources;
  const hiddenKey = hidden.join(",");
  // The open item is tracked by id, so a refresh or "load older" keeps it open in the split view.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>();
  const [items, setItemsState] = useState<FeedItem[]>([]);
  // Mirrors `items` synchronously, so the reader can step onto items that "load older" just added.
  const itemsRef = useRef<FeedItem[]>([]);
  const setItems = useCallback((next: FeedItem[] | ((prev: FeedItem[]) => FeedItem[])) => {
    itemsRef.current = typeof next === "function" ? next(itemsRef.current) : next;
    setItemsState(itemsRef.current);
  }, []);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // Ignore responses from a previous filter if the user switches quickly.
  const requestId = useRef(0);

  const query = useCallback(
    (after?: string | null) => {
      const p = new URLSearchParams({ filter, order, limit: "40" });
      if (hiddenKey) p.set("excludeSourceIds", hiddenKey);
      if (tag) p.set("tag", tag);
      if (after) p.set("cursor", after);
      return `/api/items?${p}`;
    },
    [filter, order, hiddenKey, tag],
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
  }, [query, setItems]);

  useEffect(() => {
    void load();
  }, [load]);

  const index = selectedId === null ? -1 : items.findIndex((i) => i.id === selectedId);
  const readerIndex = index >= 0 ? index : null;

  // Pick up new items when the app comes back to the foreground (e.g. on the phone).
  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && readerIndex === null && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load, readerIndex]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    try {
      const page = await api<ItemsPage>("GET", query(cursor));
      setItems((prev) => [...prev, ...page.items.filter((n) => !prev.some((p) => p.id === n.id))]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [cursor, query, setItems]);

  const itemUpdater = useMemo(() => createItemUpdater(
    (id, patch) => api("PATCH", `/api/items/${id}`, patch),
    (id, flags) => setItems((prev) => prev.map((i) => i.id === id ? { ...i, ...flags } : i)),
  ), [setItems]);
  const update = useCallback(async (item: FeedItem, patch: { read?: boolean; saved?: boolean }) => {
    try {
      await itemUpdater(item.id, itemsRef.current.find((i) => i.id === item.id) ?? item, patch);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [itemUpdater]);
  const closeReader = useCallback(() => setSelectedId(null), []);
  const openIndex = useCallback((i: number) => setSelectedId(itemsRef.current[i]?.id ?? null), []);

  // Split view with nothing open: j / → opens the first item.
  useEffect(() => {
    if (!split || readerIndex !== null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.key === "j" || e.key === "ArrowRight") && items.length) openIndex(0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [split, readerIndex, items.length, openIndex]);

  // Keep the open item visible in the list while stepping through with j / k.
  useEffect(() => {
    if (split && selectedId) document.getElementById(`item-${selectedId}`)?.scrollIntoView({ block: "nearest" });
  }, [split, selectedId]);

  // The split view needs the page's full width.
  useEffect(() => {
    document.body.classList.toggle("feed-wide", split);
    return () => document.body.classList.remove("feed-wide");
  }, [split]);

  const markAllRead = async () => {
    if (!items.length) return;
    // Only up to the newest item on screen (whichever end of the list it is at),
    // so anything that arrived meanwhile stays unread.
    const upTo = Math.max(...items.map((i) => i.publishedAt));
    await api("POST", "/api/items/mark-read", { ...(hidden.length ? { excludeSourceIds: hidden } : {}), ...(tag ? { tag } : {}), upTo });
    await load();
  };

  // Timeline: consecutive items grouped under a heading per day, in the list's order.
  const groups = useMemo(() => {
    const out: Array<{ day: number; label: string; entries: Array<{ item: FeedItem; index: number }> }> = [];
    const now = Date.now();
    items.forEach((item, i) => {
      const day = startOfDay(item.publishedAt);
      const last = out[out.length - 1];
      if (last && last.day === day) last.entries.push({ item, index: i });
      else out.push({ day, label: dayLabel(item.publishedAt, now), entries: [{ item, index: i }] });
    });
    return out;
  }, [items]);

  const unreadTotal = sources?.reduce((n, s) => n + (hidden.includes(s.id) ? 0 : s.unreadCount), 0) ?? 0;
  const noneSelected = !!sources?.length && sources.every((s) => hidden.includes(s.id));

  if (sources && sources.length === 0) {
    return (
      <section className="card empty">
        <h1>Your feed</h1>
        <p className="muted">You're not following anything yet.</p>
        <a className="button" href="#/sources">Add your first source</a>
      </section>
    );
  }

  const overlayOpen = !split && readerIndex !== null;

  return (
    <div className={split ? "feed-split" : undefined}>
      {/* While the full-screen reader is open, the list behind it is inert (no focus, hidden from screen readers). */}
      <div className="feed-list" inert={overlayOpen} aria-hidden={overlayOpen || undefined}>
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
        <SourcePicker sources={sources ?? []} hidden={hidden} onChange={(next) => setPrefs({ hiddenSources: next })} />
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
        <select aria-label="Order" value={order} onChange={(e) => setPrefs({ order: e.target.value as ItemsOrder })}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
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
          {noneSelected ? "No sources are ticked. Choose some in the Sources list above."
          : filter === "unread" ? "All caught up. Nothing unread." : filter === "saved" ? "Nothing saved yet." : "No items yet."}
        </p>
      )}

      {groups.map((g) => (
        <section key={`${g.day}-${g.entries[0]?.item.id}`} className="day" aria-label={g.label}>
          <h2 className="day-heading">{g.label}</h2>
          <ul className="items">
            {g.entries.map(({ item, index: i }) => (
              <ItemCard
                key={item.id}
                item={item}
                index={i}
                selected={split && item.id === selectedId}
                onUpdate={update}
                onOpen={openIndex}
                onTag={setTag}
              />
            ))}
          </ul>
        </section>
      ))}

      {cursor && (
        <button className="secondary load-more" onClick={() => void loadMore()}>
          Load older items
        </button>
      )}
      </div>

      {readerIndex !== null ? (
        <Reader
          mode={split ? "pane" : "overlay"}
          items={items}
          index={readerIndex}
          hasMore={cursor !== null}
          onIndexChange={openIndex}
          onLoadMore={loadMore}
          onUpdate={(item, patch) => void update(item, patch)}
          onClose={closeReader}
        />
      ) : (
        split && (
          <aside className="reader-pane reader-empty muted" aria-label="Reader">
            <p>Select an item to read it here.</p>
            <p className="small">
              Keys: <kbd>j</kbd>/<kbd>k</kbd> or <kbd>→</kbd>/<kbd>←</kbd> next and previous, <kbd>s</kbd> save, <kbd>Esc</kbd> close.
            </p>
          </aside>
        )
      )}
    </div>
  );
}

/**
 * One card. Memoised with stable callbacks (D-086): marking one item read or selecting one only
 * re-renders the cards that changed, not every card in a long list.
 */
function HeadphonesIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
      <path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z" />
    </svg>
  );
}

const ItemCard = memo(function ItemCard({
  item,
  index,
  selected,
  onUpdate: update,
  onOpen: openIndex,
  onTag,
}: {
  item: FeedItem;
  index: number;
  selected: boolean;
  onUpdate: (item: FeedItem, p: { read?: boolean; saved?: boolean }) => Promise<void>;
  onOpen: (index: number) => void;
  onTag: (tag: string) => void;
}) {
  const onUpdate = (p: { read?: boolean; saved?: boolean }) => void update(item, p);
  const onOpen = () => openIndex(index);
  return (
    <li
      id={`item-${item.id}`}
      className={`item card clickable${item.read ? " read" : ""}${selected ? " selected" : ""}`}
      aria-current={selected || undefined}
      // Anywhere on the card opens it (D-078), except its own links and buttons, or when selecting text.
      // Keyboard users have the title button, so the card itself isn't another tab stop.
      onClick={(e) => {
        if ((e.target as Element).closest("a, button, input, select, label")) return;
        if (window.getSelection()?.toString()) return;
        onOpen();
      }}
    >
      <div className="item-body">
        <div className="item-meta">
          <span className={`kind kind-${item.sourceKind}`}>{KIND_LABEL[item.sourceKind]}</span>
          <span>{item.sourceTitle}</span>
          {item.author && item.author !== item.sourceTitle && <span>· {item.author}</span>}
          <time dateTime={new Date(item.publishedAt).toISOString()} title={fullDate(item.publishedAt)}>
            · {relativeTime(item.publishedAt)}
          </time>
          {item.audio && (
            <span className="item-audio" title="Podcast episode: plays in the reader">
              · <HeadphonesIcon /> {item.audio.durationSeconds ? durationLabel(item.audio.durationSeconds) : "Audio"}
            </span>
          )}
        </div>
        <h3 className="item-title">
          <button className="title-button" onClick={onOpen}>
            {item.title}
          </button>
        </h3>
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
});
