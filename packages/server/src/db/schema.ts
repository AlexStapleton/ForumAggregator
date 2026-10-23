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
  kind: "feed" | "youtube" | "reddit" | "thread";
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
  /** Days to keep unsaved items; null = global default, 0 = forever. */
  retention_days: number | null;
  /** Reader: CSS selectors applied to the original page; null = automatic (Readability). */
  article_selector: Generated<string | null>;
  remove_selector: Generated<string | null>;
  /** 1 = fetched through the user's FlareSolverr (D-080). */
  via_flaresolverr: Generated<number>;
  /** Thread sources: posts fetched at or after this time are "new" on the thread's card (D-084). */
  thread_batch_from: Generated<number | null>;
  /** HTTP validators for conditional requests (304 Not Modified). */
  etag: string | null;
  last_modified: string | null;
  created_at: number;
  updated_at: number;
}

/** Posts of followed threads (D-084), newest kept per thread. */
export interface ThreadPostsTable {
  source_id: string;
  /** The forum's post ID (numeric in XenForo). */
  post_id: string;
  author: string | null;
  /** When the post was written (ms), if the page said. */
  posted_at: number | null;
  /** As the page shows it, e.g. "Today at 8:00 AM". */
  posted_label: string | null;
  /** Sanitised. */
  html: string;
  fetched_at: number;
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
  /** Podcast episode audio (D-093). */
  audio_url: string | null;
  /** Its length in seconds, when the feed says. */
  audio_duration: number | null;
  published_at: number;
  fetched_at: number;
  read: Generated<number>;
  saved: Generated<number>;
  read_at: number | null;
}

export interface SourceTagsTable {
  source_id: string;
  tag: string;
}

/** Full text for the reader: from the feed (raw until first shown) or extracted from the page. */
export interface ItemContentTable {
  item_id: string;
  /** feed = came with the feed; page = extracted from the article page. */
  origin: "feed" | "page";
  /** raw = unsanitised feed HTML; ok = sanitised and ready; failed = couldn't get it. */
  status: "raw" | "ok" | "failed";
  html: string | null;
  error: string | null;
  fetched_at: number;
}

/** Items removed by retention, so a later check doesn't add them back as new. */
export interface ItemTombstonesTable {
  source_id: string;
  guid: string;
  deleted_at: number;
}

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  settings: SettingsTable;
  sources: SourcesTable;
  thread_posts: ThreadPostsTable;
  items: ItemsTable;
  source_tags: SourceTagsTable;
  item_content: ItemContentTable;
  item_tombstones: ItemTombstonesTable;
}
