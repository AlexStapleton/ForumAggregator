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
};

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};
