// The feed: listing items (newest or oldest first), and read/saved state.
import type { FeedItem, ItemsFilter, ItemsOrder, ItemsPage, MarkReadRequest, UpdateItemRequest } from "@fa/shared";
import type { Db } from "../db/index.js";
import { cleanRedditSummary } from "./reddit.js";

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

  async list(opts: { filter: ItemsFilter; order?: ItemsOrder; sourceId?: string; excludeSourceIds?: string[]; tag?: string; cursor?: string; limit?: number }): Promise<ItemsPage> {
    const asc = opts.order === "oldest";
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
    // The feed's source checkboxes (D-077): unticked sources are left out.
    if (opts.excludeSourceIds?.length) q = q.where("items.source_id", "not in", opts.excludeSourceIds);
    const tag = opts.tag;
    if (tag) {
      q = q.where("items.source_id", "in", (eb) => eb.selectFrom("source_tags").select("source_tags.source_id").where("source_tags.tag", "=", tag));
    }
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    if (cursor) {
      // Keyset pagination: strictly after the last item of the previous page, in the chosen order.
      const op = asc ? ">" : "<";
      q = q.where((eb) =>
        eb.or([
          eb("items.published_at", op, cursor.publishedAt),
          eb.and([eb("items.published_at", "=", cursor.publishedAt), eb("items.id", op, cursor.id)]),
        ]),
      );
    }
    const dir = asc ? "asc" : "desc";
    const rows = await q.orderBy("items.published_at", dir).orderBy("items.id", dir).limit(limit + 1).execute();
    const page = rows.slice(0, limit);
    // Tags come from the source at read time, so editing a source's tags applies to old items too.
    const sourceIds = [...new Set(page.map((r) => r.source_id))];
    const tagRows = sourceIds.length
      ? await this.db.kysely.selectFrom("source_tags").select(["source_id", "tag"]).where("source_id", "in", sourceIds).orderBy("tag").execute()
      : [];
    const tagsBySource = new Map<string, string[]>();
    for (const t of tagRows) tagsBySource.set(t.source_id, [...(tagsBySource.get(t.source_id) ?? []), t.tag]);
    const items: FeedItem[] = page.map((r) => ({
      id: r.id,
      sourceId: r.source_id,
      sourceTitle: r.source_title,
      sourceKind: r.source_kind,
      url: r.url,
      title: r.title,
      author: r.author,
      // Items stored before the clean-up existed still carry Reddit's footer.
      summary: r.source_kind === "reddit" ? cleanRedditSummary(r.summary) : r.summary,
      imageUrl: r.image_url,
      publishedAt: r.published_at,
      read: r.read === 1,
      saved: r.saved === 1,
      tags: tagsBySource.get(r.source_id) ?? [],
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

  /** Marks unread items read; optionally only one source or tag, and only up to what the user saw. */
  async markRead(req: MarkReadRequest): Promise<number> {
    let q = this.db.kysely.updateTable("items").set({ read: 1, read_at: this.now() }).where("read", "=", 0);
    if (req.sourceId) q = q.where("source_id", "=", req.sourceId);
    if (req.excludeSourceIds?.length) q = q.where("source_id", "not in", req.excludeSourceIds);
    const tag = req.tag;
    if (tag) q = q.where("source_id", "in", (eb) => eb.selectFrom("source_tags").select("source_tags.source_id").where("source_tags.tag", "=", tag));
    if (req.upTo !== undefined) q = q.where("published_at", "<=", req.upTo);
    const res = await q.executeTakeFirst();
    return Number(res.numUpdatedRows);
  }
}
