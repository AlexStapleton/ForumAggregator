// Schema migrations, written with Kysely's schema builder so they run on SQLite and Postgres.
// Never edit a migration once released; add a new one.
import type { Kysely } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";

const migrations: Record<string, Migration> = {
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
};

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};
