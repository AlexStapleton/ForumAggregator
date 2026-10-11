import fs from "node:fs";
import path from "node:path";
import SQLite from "better-sqlite3";
import { Kysely, PostgresDialect, SqliteDialect } from "kysely";
import { Migrator } from "kysely/migration";
import pg from "pg";
import { migrationProvider } from "./migrations.js";
import type { Database } from "./schema.js";

export type DbKind = "sqlite" | "postgres";

export interface Db {
  kysely: Kysely<Database>;
  kind: DbKind;
  /** Human-readable location, without credentials. */
  location: string;
  ping(): Promise<void>;
  close(): Promise<void>;
}

// Postgres returns BIGINT as a string by default; our values are epoch ms and fit in a double.
pg.types.setTypeParser(20, (v) => Number(v));

export function openDb(opts: { databaseUrl?: string; dataDir: string }): Db {
  const url = opts.databaseUrl;
  if (url && /^postgres(ql)?:\/\//.test(url)) {
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    const kysely = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const u = new URL(url);
    return {
      kysely,
      kind: "postgres",
      location: `postgres://${u.host}${u.pathname}`,
      ping: async () => {
        await pool.query("select 1");
      },
      close: () => kysely.destroy(),
    };
  }

  const file = url ? url.replace(/^sqlite:(\/\/)?/, "") : path.join(opts.dataDir, "forumaggregator.db");
  if (url && !/^sqlite:/.test(url)) {
    throw new Error(`DATABASE_URL must start with postgres:// or sqlite:, got "${url.split(":")[0]}:"`);
  }
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new SQLite(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const kysely = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  return {
    kysely,
    kind: "sqlite",
    location: file,
    ping: async () => {
      sqlite.prepare("select 1").get();
    },
    close: () => kysely.destroy(),
  };
}

export async function migrate(db: Db): Promise<string[]> {
  const migrator = new Migrator({ db: db.kysely, provider: migrationProvider });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error;
  return (results ?? []).filter((r) => r.status === "Success").map((r) => r.migrationName);
}
