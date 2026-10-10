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

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  settings: SettingsTable;
}
