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

export type SourceKind = "feed" | "youtube" | "reddit";

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
  /** Days to keep unsaved items. null = the global default, 0 = forever. */
  retentionDays: number | null;
  tags: string[];
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
  /** The source's tags (so editing them applies to existing items too). */
  tags: string[];
}

export interface ItemsPage {
  items: FeedItem[];
  /** Pass as `cursor` (with the same `order`) to load the next page; null when there is nothing more. */
  nextCursor: string | null;
}

export type ItemsFilter = "unread" | "all" | "saved";

/** Sort by publish date: "newest" first (default) or "oldest" first (timeline). */
export type ItemsOrder = "newest" | "oldest";

export interface TagCount {
  tag: string;
  sources: number;
  unread: number;
}

/** What the in-app reader shows for an item. */
export interface ReaderContent {
  itemId: string;
  title: string;
  url: string | null;
  sourceTitle: string;
  author: string | null;
  publishedAt: number;
  /**
   * feed     full text that came with the feed
   * page     extracted from the article page ("reader mode")
   * video    a YouTube video to embed
   * summary  only the feed summary is available (see `notice`)
   */
  kind: "feed" | "page" | "video" | "summary";
  /** Sanitised HTML: only basic formatting, http(s) links and https images. */
  html: string | null;
  /** Plain-text summary from the feed. */
  summary: string | null;
  videoId: string | null;
  /** Why only the summary is shown (blocked, paywall, …). */
  notice: string | null;
}

/** Lower-case, dashes for spaces, only letters/digits/-/+/./#; max 30 characters. */
export function normaliseTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{L}\p{N}\-+.#]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
}

export const MAX_TAGS = 12;

/** Choices offered for "keep items for" (days; 0 = forever). */
export const RETENTION_CHOICES = [0, 7, 30, 90, 365] as const;

export interface ReaderComment {
  author: string | null;
  /** Sanitised HTML. */
  html: string;
  publishedAt: number | null;
  url: string | null;
}

export interface ReaderComments {
  /** False when this kind of item has no comments the app can show. */
  available: boolean;
  comments: ReaderComment[];
  /** Why comments couldn't be loaded, if they couldn't. */
  notice: string | null;
  /** Where to read the full discussion. */
  discussionUrl: string | null;
}
