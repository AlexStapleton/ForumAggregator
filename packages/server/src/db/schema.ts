// Table types for Kysely. Timestamps are epoch milliseconds; booleans are 0/1 integers,
// so the same queries run unchanged on SQLite and Postgres.
import type { Generated } from "kysely";

export interface UsersTable {
  id: string;
  username: string;
  password_hash: string;
  /** Encrypted with SecretBox. Set (but not yet enabled) during TOTP enrolment. */
  totp_secret: string | null;
  totp_enabled: Generated<number>;
  /** Last accepted TOTP time step, to reject replayed codes. */
  totp_last_step: number | null;
  created_at: number;
  updated_at: number;
}

export interface SessionsTable {
  /** sha256 of the cookie token; the token itself is never stored. */
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  ip: string | null;
  user_agent: string | null;
}

export interface SettingsTable {
  key: string;
  value: string;
}

export interface SourcesTable {
  id: string;
  kind: "feed" | "youtube";
  title: string;
  site_url: string | null;
  feed_url: string;
  enabled: Generated<number>;
  status: Generated<"ok" | "error" | "paused" | "challenged" | "pending">;
  last_error: string | null;
  consecutive_failures: Generated<number>;
  last_checked_at: number | null;
  last_success_at: number | null;
  next_check_at: number | null;
  poll_interval_minutes: number | null;
  /** HTTP validators for conditional requests (304 Not Modified). */
  etag: string | null;
  last_modified: string | null;
  created_at: number;
  updated_at: number;
}

export interface ItemsTable {
  id: string;
  source_id: string;
  /** Stable identity from the feed (guid / id / link), unique per source. */
  guid: string;
  url: string | null;
  title: string;
  author: string | null;
  summary: string | null;
  image_url: string | null;
  published_at: number;
  fetched_at: number;
  read: Generated<number>;
  saved: Generated<number>;
  read_at: number | null;
}

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  settings: SettingsTable;
  sources: SourcesTable;
  items: ItemsTable;
}
