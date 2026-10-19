// API contract shared by the server, the web UI and (later) an Android client.
/** Header every state-changing API request must carry (CSRF defence, see server/src/app.ts). */
export const CSRF_HEADER = "x-fa-request";

export const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;
export const PASSWORD_MIN_LENGTH = 12;

export type {
  SetupRequest,
  LoginRequest,
  ChangePasswordRequest,
  TotpEnableRequest,
  TotpDisableRequest,
  AddSourceRequest,
  UpdateSourceRequest,
  UpdateItemRequest,
  MarkReadRequest,
} from "./schemas.js";

export type AuthMode = "local" | "proxy" | "both";

export interface AuthStatus {
  setupRequired: boolean;
  authenticated: boolean;
  authMode: AuthMode;
  username?: string;
  totpEnabled?: boolean;
  /** How the current request was authenticated. */
  via?: "session" | "proxy";
}

export interface TotpBeginResponse {
  secret: string;
  otpauthUri: string;
  qrDataUrl: string;
}

/** Error body returned by every failing API call. */
export interface ApiError {
  error: string;
  message: string;
  /** Per-field validation messages, when error === "validation". */
  fields?: Record<string, string>;
}

export interface VersionInfo {
  name: string;
  version: string;
  database: "sqlite" | "postgres";
}

// ---- Sources and feed items (M1) -------------------------------------------------------

export type SourceKind = "feed" | "youtube";

/**
 * ok          last check succeeded
 * error       last check failed; retrying with backoff
 * paused      paused by you, or by the app after repeated failures (circuit breaker)
 * challenged  the site answered with a bot check; the app stops instead of retrying hard
 */
export type SourceStatus = "ok" | "error" | "paused" | "challenged" | "pending";

export interface Source {
  id: string;
  kind: SourceKind;
  title: string;
  /** The page or channel the user added. */
  siteUrl: string | null;
  /** The RSS/Atom URL actually polled. */
  feedUrl: string;
  enabled: boolean;
  status: SourceStatus;
  lastError: string | null;
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  nextCheckAt: number | null;
  /** Per-source override; null = the default from config.yaml. */
  pollIntervalMinutes: number | null;
  unreadCount: number;
  itemCount: number;
  createdAt: number;
}

export interface FeedItem {
  id: string;
  sourceId: string;
  sourceTitle: string;
  sourceKind: SourceKind;
  /** Always http(s); never rendered as anything but a link. */
  url: string | null;
  title: string;
  author: string | null;
  /** Plain text, already stripped of HTML and shortened. */
  summary: string | null;
  /** http(s) image URL (e.g. a YouTube thumbnail). */
  imageUrl: string | null;
  publishedAt: number;
  read: boolean;
  saved: boolean;
}

export interface ItemsPage {
  items: FeedItem[];
  /** Pass as `cursor` to load the next (older) page; null when there is nothing more. */
  nextCursor: string | null;
}

export type ItemsFilter = "unread" | "all" | "saved";
