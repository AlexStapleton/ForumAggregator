// Schema migrations, written with Kysely's schema builder so they run on SQLite and Postgres.
// Never edit a migration once released; add a new one.
import { sql, type Kysely } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";

export const migrations: Record<string, Migration> = {
  "0001_auth": {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable("users")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("username", "text", (c) => c.notNull().unique())
        .addColumn("password_hash", "text", (c) => c.notNull())
        .addColumn("totp_secret", "text")
        .addColumn("totp_enabled", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("totp_last_step", "bigint")
        .addColumn("created_at", "bigint", (c) => c.notNull())
        .addColumn("updated_at", "bigint", (c) => c.notNull())
        .execute();

      await db.schema
        .createTable("sessions")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("user_id", "text", (c) =>
          c.notNull().references("users.id").onDelete("cascade"),
        )
        .addColumn("created_at", "bigint", (c) => c.notNull())
        .addColumn("expires_at", "bigint", (c) => c.notNull())
        .addColumn("last_seen_at", "bigint", (c) => c.notNull())
        .addColumn("ip", "text")
        .addColumn("user_agent", "text")
        .execute();
      await db.schema.createIndex("sessions_user_id").on("sessions").column("user_id").execute();
      await db.schema.createIndex("sessions_expires_at").on("sessions").column("expires_at").execute();

      await db.schema
        .createTable("settings")
        .addColumn("key", "text", (c) => c.primaryKey())
        .addColumn("value", "text", (c) => c.notNull())
        .execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable("settings").execute();
      await db.schema.dropTable("sessions").execute();
      await db.schema.dropTable("users").execute();
    },
  },
  "0002_sources_items": {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable("sources")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("kind", "text", (c) => c.notNull())
        .addColumn("title", "text", (c) => c.notNull())
        .addColumn("site_url", "text")
        .addColumn("feed_url", "text", (c) => c.notNull().unique())
        .addColumn("enabled", "integer", (c) => c.notNull().defaultTo(1))
        .addColumn("status", "text", (c) => c.notNull().defaultTo("pending"))
        .addColumn("last_error", "text")
        .addColumn("consecutive_failures", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("last_checked_at", "bigint")
        .addColumn("last_success_at", "bigint")
        .addColumn("next_check_at", "bigint")
        .addColumn("poll_interval_minutes", "integer")
        .addColumn("etag", "text")
        .addColumn("last_modified", "text")
        .addColumn("created_at", "bigint", (c) => c.notNull())
        .addColumn("updated_at", "bigint", (c) => c.notNull())
        .execute();
      await db.schema.createIndex("sources_next_check").on("sources").columns(["enabled", "next_check_at"]).execute();

      await db.schema
        .createTable("items")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("source_id", "text", (c) => c.notNull().references("sources.id").onDelete("cascade"))
        .addColumn("guid", "text", (c) => c.notNull())
        .addColumn("url", "text")
        .addColumn("title", "text", (c) => c.notNull())
        .addColumn("author", "text")
        .addColumn("summary", "text")
        .addColumn("image_url", "text")
        .addColumn("published_at", "bigint", (c) => c.notNull())
        .addColumn("fetched_at", "bigint", (c) => c.notNull())
        .addColumn("read", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("saved", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("read_at", "bigint")
        .addUniqueConstraint("items_source_guid", ["source_id", "guid"])
        .execute();
      // Feed listing is "newest first", optionally unread-only or per source.
      await db.schema.createIndex("items_published").on("items").columns(["published_at", "id"]).execute();
      await db.schema.createIndex("items_read_published").on("items").columns(["read", "published_at"]).execute();
      await db.schema.createIndex("items_source_published").on("items").columns(["source_id", "published_at"]).execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable("items").execute();
      await db.schema.dropTable("sources").execute();
    },
  },
  "0003_tags_reader_retention": {
    async up(db: Kysely<any>) {
      await db.schema.alterTable("sources").addColumn("retention_days", "integer").execute();

      await db.schema
        .createTable("source_tags")
        .addColumn("source_id", "text", (c) => c.notNull().references("sources.id").onDelete("cascade"))
        .addColumn("tag", "text", (c) => c.notNull())
        .addPrimaryKeyConstraint("source_tags_pk", ["source_id", "tag"])
        .execute();
      await db.schema.createIndex("source_tags_tag").on("source_tags").column("tag").execute();

      await db.schema
        .createTable("item_content")
        .addColumn("item_id", "text", (c) => c.primaryKey().references("items.id").onDelete("cascade"))
        .addColumn("origin", "text", (c) => c.notNull())
        .addColumn("status", "text", (c) => c.notNull())
        .addColumn("html", "text")
        .addColumn("error", "text")
        .addColumn("fetched_at", "bigint", (c) => c.notNull())
        .execute();

      await db.schema
        .createTable("item_tombstones")
        .addColumn("source_id", "text", (c) => c.notNull().references("sources.id").onDelete("cascade"))
        .addColumn("guid", "text", (c) => c.notNull())
        .addColumn("deleted_at", "bigint", (c) => c.notNull())
        .addPrimaryKeyConstraint("item_tombstones_pk", ["source_id", "guid"])
        .execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable("item_tombstones").execute();
      await db.schema.dropTable("item_content").execute();
      await db.schema.dropTable("source_tags").execute();
      await db.schema.alterTable("sources").dropColumn("retention_days").execute();
    },
  },
  "0004_reader_selectors": {
    async up(db: Kysely<any>) {
      // Per-source CSS selectors for the reader (D-074); null = automatic extraction.
      await db.schema.alterTable("sources").addColumn("article_selector", "text").execute();
      await db.schema.alterTable("sources").addColumn("remove_selector", "text").execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.alterTable("sources").dropColumn("remove_selector").execute();
      await db.schema.alterTable("sources").dropColumn("article_selector").execute();
    },
  },
  "0005_flaresolverr": {
    async up(db: Kysely<any>) {
      // Fetch this source through the user's FlareSolverr (D-080); 0 = directly.
      await db.schema.alterTable("sources").addColumn("via_flaresolverr", "integer", (c) => c.notNull().defaultTo(0)).execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.alterTable("sources").dropColumn("via_flaresolverr").execute();
    },
  },
  "0006_thread_following": {
    async up(db: Kysely<any>) {
      // Followed forum threads (D-084).
      await db.schema.alterTable("sources").addColumn("thread_batch_from", "bigint").execute();
      await db.schema
        .createTable("thread_posts")
        .addColumn("source_id", "text", (c) => c.notNull().references("sources.id").onDelete("cascade"))
        .addColumn("post_id", "text", (c) => c.notNull())
        .addColumn("author", "text")
        .addColumn("posted_at", "bigint")
        .addColumn("posted_label", "text")
        .addColumn("html", "text", (c) => c.notNull())
        .addColumn("fetched_at", "bigint", (c) => c.notNull())
        .addPrimaryKeyConstraint("thread_posts_pk", ["source_id", "post_id"])
        .execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable("thread_posts").execute();
      await db.schema.alterTable("sources").dropColumn("thread_batch_from").execute();
    },
  },
  "0007_performance": {
    async up(db: Kysely<any>) {
      // Per-source total/unread counts and tag unread counts read only this index (D-086).
      await db.schema.createIndex("items_source_read").on("items").columns(["source_id", "read"]).execute();
      // The Saved filter, newest first.
      await db.schema.createIndex("items_saved_published").on("items").columns(["saved", "published_at"]).execute();
      // Fresh statistics, so the planner picks these.
      await sql`analyze`.execute(db);
    },
    async down(db: Kysely<any>) {
      await db.schema.dropIndex("items_saved_published").execute();
      await db.schema.dropIndex("items_source_read").execute();
    },
  },
  "0008_refetch_misdecoded_feeds": {
    async up(db: Kysely<any>) {
      // Feeds whose stored bodies kept &#34; in their tags (D-091): forget the feed's ETag and
      // Last-Modified so the next check reads it in full and re-stores those bodies.
      await sql`update sources set etag = null, last_modified = null where id in (
        select i.source_id from items i join item_content c on c.item_id = i.id
        where c.origin = 'feed' and (c.html like '%=&#34;%' or c.html like '%=&#x22;%' or c.html like '%!%22http%' escape '!'))`.execute(db);
    },
    async down() {
      // Nothing to undo: the next check stores fresh validators.
    },
  },
  "0009_podcast_audio": {
    async up(db: Kysely<any>) {
      // A podcast episode's audio file and its length in seconds (D-093).
      await db.schema.alterTable("items").addColumn("audio_url", "text").execute();
      await db.schema.alterTable("items").addColumn("audio_duration", "integer").execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.alterTable("items").dropColumn("audio_duration").execute();
      await db.schema.alterTable("items").dropColumn("audio_url").execute();
    },
  },
  "0010_reread_audio_story_pages": {
    async up(db: Kysely<any>) {
      // Article pages stored before the reader looked for a story's audio (D-096) that link to an
      // audio file (e.g. NPR's Download link): read again on the next open, to find the audio.
      await sql`delete from item_content where origin = 'page' and status = 'ok'
        and (html like '%.mp3%' or html like '%.m4a%')
        and item_id in (select id from items where audio_url is null)`.execute(db);
    },
    async down() {
      // Nothing to undo: those pages are read again when opened.
    },
  },
  "0011_reread_forum_pages_with_member_details": {
    async up(db: Kysely<any>) {
      // Forum threads read as a generic article before vBulletin threads were understood (D-098)
      // kept each poster's sidebar ("Joined:", "Posts:"): read them again on the next open.
      await sql`delete from item_content where origin = 'page' and status = 'ok'
        and html like '%Joined:%' and html like '%Posts:%'`.execute(db);
    },
    async down() {
      // Nothing to undo: those pages are read again when opened.
    },
  },
  "0012_resume_paused_youtube": {
    async up(db: Kysely<any>) {
      // YouTube channels paused by YouTube's on-and-off feed failures (D-105): checked again now.
      await sql`update sources set status = 'error', consecutive_failures = 0, next_check_at = ${Date.now()}
        where kind = 'youtube' and status = 'paused'`.execute(db);
    },
    async down() {
      // Nothing to undo.
    },
  },
  "0013_login_throttle": {
    async up(db: Kysely<any>) {
      // Per-account limits on wrong passwords and wrong two-factor codes (D-110): unlike the
      // per-IP limit, a forged X-Forwarded-For can't get around them.
      await db.schema.alterTable("users").addColumn("failed_logins", "integer", (c) => c.notNull().defaultTo(0)).execute();
      await db.schema.alterTable("users").addColumn("login_locked_until", "bigint").execute();
      await db.schema.alterTable("users").addColumn("totp_failures", "integer", (c) => c.notNull().defaultTo(0)).execute();
      await db.schema.alterTable("users").addColumn("totp_locked_until", "bigint").execute();
    },
    async down(db: Kysely<any>) {
      for (const c of ["totp_locked_until", "totp_failures", "login_locked_until", "failed_logins"]) {
        await db.schema.alterTable("users").dropColumn(c).execute();
      }
    },
  },
  "0014_known_devices": {
    async up(db: Kysely<any>) {
      // Browsers that have logged in before (D-111): their login attempts are counted on their own,
      // so someone spamming wrong passwords or codes can't lock the owner out.
      await db.schema
        .createTable("known_devices")
        .addColumn("id", "text", (c) => c.primaryKey()) // sha256 of the device cookie
        .addColumn("user_id", "text", (c) => c.notNull().references("users.id").onDelete("cascade"))
        .addColumn("created_at", "bigint", (c) => c.notNull())
        .addColumn("last_used_at", "bigint", (c) => c.notNull())
        .addColumn("failed_logins", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("login_locked_until", "bigint")
        .addColumn("totp_failures", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("totp_locked_until", "bigint")
        .execute();
      await db.schema.createIndex("known_devices_user_id").on("known_devices").column("user_id").execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable("known_devices").execute();
    },
  },
  "0015_multi_user": {
    async up(db: Kysely<any>) {
      // Several accounts (D-114). The account that exists becomes the admin.
      await db.schema.alterTable("users").addColumn("role", "text", (c) => c.notNull().defaultTo("user")).execute();
      await db.schema.alterTable("users").addColumn("disabled", "integer", (c) => c.notNull().defaultTo(0)).execute();
      await db.schema.alterTable("users").addColumn("last_login_at", "bigint").execute();
      await sql`update users set role = 'admin'`.execute(db);

      // One-time links: an invitation to create an account, or a password reset.
      await db.schema
        .createTable("invites")
        .addColumn("id", "text", (c) => c.primaryKey()) // sha256 of the link's token
        .addColumn("kind", "text", (c) => c.notNull()) // invite | reset
        .addColumn("user_id", "text", (c) => c.references("users.id").onDelete("cascade")) // reset: whose
        .addColumn("note", "text")
        .addColumn("created_at", "bigint", (c) => c.notNull())
        .addColumn("expires_at", "bigint", (c) => c.notNull())
        .addColumn("used_at", "bigint")
        .execute();

      // A source is fetched once however many accounts follow it; each follower has their own
      // name for it, tags, pause switch, and thread batch (D-115).
      await db.schema
        .createTable("subscriptions")
        .addColumn("user_id", "text", (c) => c.notNull().references("users.id").onDelete("cascade"))
        .addColumn("source_id", "text", (c) => c.notNull().references("sources.id").onDelete("cascade"))
        .addColumn("title", "text", (c) => c.notNull())
        .addColumn("enabled", "integer", (c) => c.notNull().defaultTo(1))
        .addColumn("thread_batch_from", "bigint")
        .addColumn("created_at", "bigint", (c) => c.notNull())
        .addColumn("updated_at", "bigint", (c) => c.notNull())
        .addPrimaryKeyConstraint("subscriptions_pk", ["user_id", "source_id"])
        .execute();
      await db.schema.createIndex("subscriptions_source").on("subscriptions").column("source_id").execute();
      await sql`insert into subscriptions (user_id, source_id, title, enabled, thread_batch_from, created_at, updated_at)
        select u.id, s.id, s.title, s.enabled, s.thread_batch_from, s.created_at, s.updated_at
        from sources s cross join users u where u.role = 'admin'`.execute(db);

      // Read and saved, per account: a row for each item of each source the account follows (like
      // Tiny Tiny RSS's user entries), so unread counts read an index, as items(source_id, read) did.
      await db.schema
        .createTable("item_states")
        .addColumn("user_id", "text", (c) => c.notNull().references("users.id").onDelete("cascade"))
        .addColumn("item_id", "text", (c) => c.notNull().references("items.id").onDelete("cascade"))
        .addColumn("source_id", "text", (c) => c.notNull())
        .addColumn("read", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("saved", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("read_at", "bigint")
        .addPrimaryKeyConstraint("item_states_pk", ["user_id", "item_id"])
        .execute();
      await db.schema.createIndex("item_states_item").on("item_states").column("item_id").execute();
      await db.schema.createIndex("item_states_counts").on("item_states").columns(["user_id", "source_id", "read"]).execute();
      await db.schema.createIndex("item_states_saved").on("item_states").columns(["user_id", "saved"]).execute();
      await sql`insert into item_states (user_id, item_id, source_id, read, saved, read_at)
        select u.id, i.id, i.source_id, i.read, i.saved, i.read_at
        from items i cross join users u where u.role = 'admin'`.execute(db);

      await db.schema
        .createTable("subscription_tags")
        .addColumn("user_id", "text", (c) => c.notNull().references("users.id").onDelete("cascade"))
        .addColumn("source_id", "text", (c) => c.notNull().references("sources.id").onDelete("cascade"))
        .addColumn("tag", "text", (c) => c.notNull())
        .addPrimaryKeyConstraint("subscription_tags_pk", ["user_id", "source_id", "tag"])
        .execute();
      await db.schema.createIndex("subscription_tags_tag").on("subscription_tags").columns(["user_id", "tag"]).execute();
      await sql`insert into subscription_tags (user_id, source_id, tag)
        select u.id, t.source_id, t.tag from source_tags t cross join users u where u.role = 'admin'`.execute(db);
      await db.schema.dropTable("source_tags").execute();

      // Moved to item_states and subscriptions.
      for (const index of ["items_read_published", "items_source_read", "items_saved_published"]) await db.schema.dropIndex(index).execute();
      for (const column of ["read", "saved", "read_at"]) await db.schema.alterTable("items").dropColumn(column).execute();
      await db.schema.alterTable("sources").dropColumn("thread_batch_from").execute();
      await sql`analyze`.execute(db);
    },
    async down(db: Kysely<any>) {
      // Back to one account's view: the admin's.
      await db.schema.alterTable("sources").addColumn("thread_batch_from", "bigint").execute();
      await db.schema.alterTable("items").addColumn("read", "integer", (c) => c.notNull().defaultTo(0)).execute();
      await db.schema.alterTable("items").addColumn("saved", "integer", (c) => c.notNull().defaultTo(0)).execute();
      await db.schema.alterTable("items").addColumn("read_at", "bigint").execute();
      const admin = sql`(select id from users where role = 'admin' limit 1)`;
      await sql`update items set
        read = coalesce((select st.read from item_states st where st.item_id = items.id and st.user_id = ${admin}), 0),
        saved = coalesce((select st.saved from item_states st where st.item_id = items.id and st.user_id = ${admin}), 0),
        read_at = (select st.read_at from item_states st where st.item_id = items.id and st.user_id = ${admin})`.execute(db);
      await db.schema.createIndex("items_read_published").on("items").columns(["read", "published_at"]).execute();
      await db.schema.createIndex("items_source_read").on("items").columns(["source_id", "read"]).execute();
      await db.schema.createIndex("items_saved_published").on("items").columns(["saved", "published_at"]).execute();
      await db.schema
        .createTable("source_tags")
        .addColumn("source_id", "text", (c) => c.notNull().references("sources.id").onDelete("cascade"))
        .addColumn("tag", "text", (c) => c.notNull())
        .addPrimaryKeyConstraint("source_tags_pk", ["source_id", "tag"])
        .execute();
      await db.schema.createIndex("source_tags_tag").on("source_tags").column("tag").execute();
      await sql`insert into source_tags (source_id, tag) select source_id, tag from subscription_tags where user_id = ${admin}`.execute(db);
      await db.schema.dropTable("subscription_tags").execute();
      await db.schema.dropTable("item_states").execute();
      await db.schema.dropTable("subscriptions").execute();
      await db.schema.dropTable("invites").execute();
      for (const column of ["last_login_at", "disabled", "role"]) await db.schema.alterTable("users").dropColumn(column).execute();
    },
  },
  "0016_board_threads": {
    async up(db: Kysely<any>) {
      // The threads a followed board lists (D-123): what each had at the last check, so a thread's
      // card comes back only when its newest post changes.
      await db.schema
        .createTable("board_threads")
        .addColumn("source_id", "text", (c) => c.notNull().references("sources.id").onDelete("cascade"))
        .addColumn("thread_id", "text", (c) => c.notNull())
        .addColumn("last_post_id", "text", (c) => c.notNull())
        .addColumn("replies", "integer")
        .addColumn("base_replies", "integer")
        .addColumn("last_page_url", "text")
        .addColumn("seen_at", "bigint", (c) => c.notNull())
        .addPrimaryKeyConstraint("board_threads_pk", ["source_id", "thread_id"])
        .execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable("board_threads").execute();
    },
  },
};

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};
