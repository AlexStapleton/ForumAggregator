// The feed: listing items newest first, and read/saved state.
import type { FeedItem, ItemsFilter, ItemsPage, MarkReadRequest, UpdateItemRequest } from "@fa/shared";
import type { Db } from "../db/index.js";

const MAX_LIMIT = 100;

function encodeCursor(publishedAt: number, id: string): string {
  return Buffer.from(`${publishedAt}:${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { publishedAt: number; id: string } | null {
  const [ts, id] = Buffer.from(cursor, "base64url").toString("utf8").split(":", 2);
  const publishedAt = Number(ts);
  return Number.isFinite(publishedAt) && id ? { publishedAt, id } : null;
}

export class ItemService {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  async list(opts: { filter: ItemsFilter; sourceId?: string; cursor?: string; limit?: number }): Promise<ItemsPage> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_LIMIT);
    let q = this.db.kysely
      .selectFrom("items")
      .innerJoin("sources", "sources.id", "items.source_id")
      .select([
        "items.id",
        "items.source_id",
        "items.url",
        "items.title",
        "items.author",
        "items.summary",
        "items.image_url",
        "items.published_at",
        "items.read",
        "items.saved",
        "sources.title as source_title",
        "sources.kind as source_kind",
      ]);
    if (opts.filter === "unread") q = q.where("items.read", "=", 0);
    if (opts.filter === "saved") q = q.where("items.saved", "=", 1);
    if (opts.sourceId) q = q.where("items.source_id", "=", opts.sourceId);
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    if (cursor) {
      // Keyset pagination: strictly older than the last item of the previous page.
      q = q.where((eb) =>
        eb.or([
          eb("items.published_at", "<", cursor.publishedAt),
          eb.and([eb("items.published_at", "=", cursor.publishedAt), eb("items.id", "<", cursor.id)]),
        ]),
      );
    }
    const rows = await q.orderBy("items.published_at", "desc").orderBy("items.id", "desc").limit(limit + 1).execute();
    const page = rows.slice(0, limit);
    const items: FeedItem[] = page.map((r) => ({
      id: r.id,
      sourceId: r.source_id,
      sourceTitle: r.source_title,
      sourceKind: r.source_kind,
      url: r.url,
      title: r.title,
      author: r.author,
      summary: r.summary,
      imageUrl: r.image_url,
      publishedAt: r.published_at,
      read: r.read === 1,
      saved: r.saved === 1,
    }));
    const last = page[page.length - 1];
    return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.published_at, last.id) : null };
  }

  async update(id: string, patch: UpdateItemRequest): Promise<boolean> {
    const set: { read?: number; read_at?: number | null; saved?: number } = {};
    if (patch.read !== undefined) {
      set.read = patch.read ? 1 : 0;
      set.read_at = patch.read ? this.now() : null;
    }
    if (patch.saved !== undefined) set.saved = patch.saved ? 1 : 0;
    if (!Object.keys(set).length) return true;
    const res = await this.db.kysely.updateTable("items").set(set).where("id", "=", id).executeTakeFirst();
    return Number(res.numUpdatedRows) > 0;
  }

  /** Marks unread items read; optionally only one source and only up to what the user saw. */
  async markRead(req: MarkReadRequest): Promise<number> {
    let q = this.db.kysely.updateTable("items").set({ read: 1, read_at: this.now() }).where("read", "=", 0);
    if (req.sourceId) q = q.where("source_id", "=", req.sourceId);
    if (req.upTo !== undefined) q = q.where("published_at", "<=", req.upTo);
    const res = await q.executeTakeFirst();
    return Number(res.numUpdatedRows);
  }
}
