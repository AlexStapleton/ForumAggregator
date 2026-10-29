// The feed: listing items (newest or oldest first), and read/saved state, per account (D-115).
import type { FeedItem, ItemsFilter, ItemsOrder, ItemsPage, MarkReadRequest, UpdateItemRequest } from "@fa/shared";
import type { Viewer } from "../auth/service.js";
import type { Db } from "../db/index.js";
import { cleanRedditSummary } from "./reddit.js";
import { readFor, unreadFor } from "./state.js";
import { htmlToText } from "./text.js";
import { postNumber, threadSummary } from "./thread.js";

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

  /** The viewer's feed: items of the sources they follow, with their own read/saved marks (D-115). */
  async list(viewer: Viewer, opts: { filter: ItemsFilter; order?: ItemsOrder; sourceId?: string; excludeSourceIds?: string[]; tag?: string; cursor?: string; limit?: number }): Promise<ItemsPage> {
    const asc = opts.order === "oldest";
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_LIMIT);
    let q = this.db.kysely
      .selectFrom("items")
      .innerJoin("subscriptions as s", (j) => j.onRef("s.source_id", "=", "items.source_id").on("s.user_id", "=", viewer.id))
      .innerJoin("sources", "sources.id", "items.source_id")
      .leftJoin("item_states as st", (j) => j.onRef("st.item_id", "=", "items.id").on("st.user_id", "=", viewer.id))
      .select([
        "items.id",
        "items.source_id",
        "items.url",
        "items.title",
        "items.author",
        "items.summary",
        "items.image_url",
        "items.audio_url",
        "items.audio_duration",
        "items.published_at",
        readFor().as("read"),
        "st.saved",
        "s.title as source_title",
        "s.thread_batch_from",
        "sources.kind as source_kind",
      ]);
    if (opts.filter === "unread") q = q.where(unreadFor());
    if (opts.filter === "saved") q = q.where("st.saved", "=", 1);
    if (opts.sourceId) q = q.where("items.source_id", "=", opts.sourceId);
    // The feed's source checkboxes (D-077): unticked sources are left out.
    if (opts.excludeSourceIds?.length) q = q.where("items.source_id", "not in", opts.excludeSourceIds);
    const tag = opts.tag;
    if (tag) {
      // EXISTS, not IN: the planner then walks items newest first and stops at the page size,
      // instead of collecting and sorting every item of the tag's sources (D-086).
      q = q.where(({ exists, selectFrom }) =>
        exists(
          selectFrom("subscription_tags")
            .select("subscription_tags.source_id")
            .whereRef("subscription_tags.source_id", "=", "items.source_id")
            .where("subscription_tags.user_id", "=", viewer.id)
            .where("subscription_tags.tag", "=", tag),
        ),
      );
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
      ? await this.db.kysely
          .selectFrom("subscription_tags")
          .select(["source_id", "tag"])
          .where("user_id", "=", viewer.id)
          .where("source_id", "in", sourceIds)
          .orderBy("tag")
          .execute()
      : [];
    const tagsBySource = new Map<string, string[]>();
    for (const t of tagRows) tagsBySource.set(t.source_id, [...(tagsBySource.get(t.source_id) ?? []), t.tag]);
    const items: FeedItem[] = [];
    for (const r of page) {
      items.push({
        id: r.id,
        sourceId: r.source_id,
        sourceTitle: r.source_title,
        sourceKind: r.source_kind,
        url: r.url,
        title: r.title,
        author: r.author,
        summary:
          r.source_kind === "thread" ? await this.threadCardSummary(r.source_id, r.thread_batch_from, r.summary)
          // Items stored before the clean-up existed still carry Reddit's footer.
          : r.source_kind === "reddit" ? cleanRedditSummary(r.summary)
          : r.summary,
        imageUrl: r.image_url,
        audio: r.audio_url ? { url: r.audio_url, durationSeconds: r.audio_duration } : null,
        publishedAt: r.published_at,
        read: Number(r.read) === 1,
        saved: r.saved === 1,
        tags: tagsBySource.get(r.source_id) ?? [],
      });
    }
    const last = page[page.length - 1];
    return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.published_at, last.id) : null };
  }

  /**
   * A followed thread's card summary for this follower (D-115): the replies since they last read
   * it ("N new replies"), or, before their first batch, the newest stored ("N latest replies").
   */
  private async threadCardSummary(sourceId: string, batchFrom: number | null, stored: string | null): Promise<string | null> {
    let q = this.db.kysely.selectFrom("thread_posts").select(["post_id"]).where("source_id", "=", sourceId);
    if (batchFrom !== null) q = q.where("fetched_at", ">=", batchFrom);
    const ids = (await q.execute()).map((r) => r.post_id);
    if (!ids.length) return stored;
    const newest = ids.reduce((a, b) => (postNumber(b) > postNumber(a) ? b : a));
    const latest = await this.db.kysely.selectFrom("thread_posts").select(["author", "html"]).where("source_id", "=", sourceId).where("post_id", "=", newest).executeTakeFirst();
    const summary = threadSummary(ids.length, latest ? { author: latest.author, text: htmlToText(latest.html) } : null);
    return batchFrom === null ? summary.replace(/new (reply|replies)/, "latest $1") : summary;
  }

  /** Whether the viewer may see the item: they follow its source. */
  private async visible(viewer: Viewer, id: string) {
    return this.db.kysely
      .selectFrom("items")
      .innerJoin("subscriptions as s", (j) => j.onRef("s.source_id", "=", "items.source_id").on("s.user_id", "=", viewer.id))
      .leftJoin("item_states as st", (j) => j.onRef("st.item_id", "=", "items.id").on("st.user_id", "=", viewer.id))
      .select(["items.id", "items.source_id", readFor().as("read"), "st.saved", "st.read_at"])
      .where("items.id", "=", id)
      .executeTakeFirst();
  }

  async update(viewer: Viewer, id: string, patch: UpdateItemRequest): Promise<boolean> {
    const item = await this.visible(viewer, id);
    if (!item) return false;
    if (patch.read === undefined && patch.saved === undefined) return true;
    const read = patch.read ?? Number(item.read) === 1;
    const row = {
      source_id: item.source_id,
      read: read ? 1 : 0,
      saved: (patch.saved ?? item.saved === 1) ? 1 : 0,
      read_at: patch.read === undefined ? (item.read_at ?? null) : read ? this.now() : null,
    };
    await this.db.kysely
      .insertInto("item_states")
      .values({ user_id: viewer.id, item_id: id, ...row })
      // The visibility snapshot can already be stale when another device updates this item.
      // On conflict, only touch the fields the caller actually supplied.
      .onConflict((oc) => oc.columns(["user_id", "item_id"]).doUpdateSet({
        ...(patch.read === undefined ? {} : { read: row.read, read_at: row.read_at }),
        ...(patch.saved === undefined ? {} : { saved: row.saved }),
      }))
      .execute();
    return true;
  }

  /** Marks the viewer's unread items read; optionally only one source or tag, and only up to what they saw. */
  async markRead(viewer: Viewer, req: MarkReadRequest): Promise<number> {
    const now = this.now();
    // The viewer's unread items in scope.
    let scope = this.db.kysely
      .selectFrom("items")
      .innerJoin("subscriptions as s", (j) => j.onRef("s.source_id", "=", "items.source_id").on("s.user_id", "=", viewer.id))
      .leftJoin("item_states as st", (j) => j.onRef("st.item_id", "=", "items.id").on("st.user_id", "=", viewer.id))
      .where(unreadFor());
    if (req.sourceId) scope = scope.where("items.source_id", "=", req.sourceId);
    if (req.excludeSourceIds?.length) scope = scope.where("items.source_id", "not in", req.excludeSourceIds);
    const tag = req.tag;
    if (tag) {
      scope = scope.where(({ exists, selectFrom }) =>
        exists(
          selectFrom("subscription_tags")
            .select("subscription_tags.source_id")
            .whereRef("subscription_tags.source_id", "=", "items.source_id")
            .where("subscription_tags.user_id", "=", viewer.id)
            .where("subscription_tags.tag", "=", tag),
        ),
      );
    }
    if (req.upTo !== undefined) scope = scope.where("items.published_at", "<=", req.upTo);
    const ids = await scope.select(["items.id", "items.source_id"]).execute();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      await this.db.kysely
        .insertInto("item_states")
        .values(chunk.map((r) => ({ user_id: viewer.id, item_id: r.id, source_id: r.source_id, read: 1, saved: 0, read_at: now })))
        .onConflict((oc) => oc.columns(["user_id", "item_id"]).doUpdateSet({ read: 1, read_at: now }))
        .execute();
    }
    return ids.length;
  }
}
