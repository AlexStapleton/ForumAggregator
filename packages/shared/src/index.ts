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
  OpmlImportRequest,
  ReaderPreviewRequest,
  YouTubeKeyRequest,
  FlareSolverrRequest,
} from "./schemas.js";

export type AuthMode = "local" | "proxy" | "both";

export interface AuthStatus {
  setupRequired: boolean;
  authenticated: boolean;
  authMode: AuthMode;
  username?: string;
  /** admin: manages accounts and the server-wide settings (D-114). */
  role?: "admin" | "user";
  totpEnabled?: boolean;
  /** How the current request was authenticated. */
  via?: "session" | "proxy";
  /** What the app sees of this connection, to check a reverse proxy is set up right (D-110). Logged in only. */
  connection?: ConnectionInfo;
}

export interface ConnectionInfo {
  /** The client address the app uses (from X-Forwarded-For when the proxy is trusted). */
  ip: string;
  /** Whether the request reached the proxy over HTTPS (or the app directly over HTTPS). */
  https: boolean;
  /** Whether the session cookie is marked Secure on this connection. */
  secureCookie: boolean;
  /**
   * through-trusted-proxy: forwarded headers were used; untrusted-proxy: a proxy sent them but
   * its address isn't in TRUST_PROXY, so they were ignored; direct: no proxy.
   */
  proxy: "through-trusted-proxy" | "untrusted-proxy" | "direct";
}

/** A signed-in device (D-110). */
export interface SessionView {
  id: string;
  current: boolean;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
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

/**
 * "thread": one forum thread followed for new replies (D-084).
 * "board": a vBulletin board's threads, one card each that comes back with new replies (D-123).
 */
export type SourceKind = "feed" | "youtube" | "reddit" | "thread" | "board";

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
  /** Reader overrides (D-074): CSS selectors applied to the original page; null = automatic. */
  articleSelector: string | null;
  removeSelector: string | null;
  /** Fetched through the user's FlareSolverr, for sites behind a Cloudflare check (D-080). */
  viaFlareSolverr: boolean;
  /**
   * Whether this account may change how the source is checked and read (interval, keep items,
   * selectors, FlareSolverr): the admin, or its only follower (D-115). Name, tags, pause: always.
   */
  canEditShared: boolean;
  tags: string[];
  unreadCount: number;
  itemCount: number;
  createdAt: number;
}

/** What the reader would show for one item with the given selectors (nothing is saved). */
export interface ReaderPreview {
  extraction?: ReaderExtraction;
  itemId: string;
  itemTitle: string;
  url: string;
  html: string | null;
  /** Elements the article selector matched (null when not set). */
  matched: number | null;
  /** Elements the remove selector took out (null when not set). */
  removed: number | null;
  notice: string | null;
}

export interface OpmlImportResult {
  /** Sources created; they're checked by the scheduler over the next minutes. */
  added: number;
  skipped: Array<{ url: string; title: string | null; reason: string }>;
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
  /** A podcast episode's audio, played in the reader (D-093). */
  audio: ItemAudio | null;
  publishedAt: number;
  read: boolean;
  saved: boolean;
  /** The source's tags (so editing them applies to existing items too). */
  tags: string[];
}

export interface ItemAudio {
  /** http(s) audio file. */
  url: string;
  /** Length in seconds, when the feed gives it. */
  durationSeconds: number | null;
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
export interface ReaderExtraction {
  status: "complete" | "empty" | "partial" | "access-blocked" | "unrecognized" | "wrong-page" | "failed";
  /** A previously successful copy is being shown after a failed refresh. */
  stale: boolean;
}

export interface ReaderContent {
  extraction?: ReaderExtraction;
  /** Followed threads: account-specific reading position, never stored in shared page caches. */
  threadProgress?: { readPostId: number | null; firstUnreadPostId: string | null; hasMore: boolean; tracking: boolean };
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
  /** Forum threads (D-088): which page this is, out of how many. Absent for everything else. */
  pagination?: ReaderPagination | null;
  /** The story's audio: from the feed (D-093) or found on its page (D-096). */
  audio?: ItemAudio | null;
  /**
   * A Reddit video or gallery post (D-117): the reader shows a player or the pictures, loaded
   * from /api/items/:id/media. Absent for everything else.
   */
  redditMedia?: RedditMediaHint | null;
}

export interface RedditMediaHint {
  kind: "video" | "gallery";
  /** The feed's preview picture: the video's poster, or a small crop of the gallery's first picture. */
  poster: string | null;
}

/** One picture of a Reddit gallery; animated ones are also an mp4 that loops. */
export interface RedditGalleryImage {
  url: string;
  width: number | null;
  height: number | null;
  caption: string | null;
  /** Animated pictures: the same as a silent looping video. */
  mp4: string | null;
}

export type RedditMedia =
  | {
      kind: "video";
      /** HLS stream (with sound): Safari and Android play it themselves, other browsers through hls.js. */
      hlsUrl: string;
      /** A single mp4 without sound, if the stream doesn't load. */
      mp4Url: string | null;
      poster: string | null;
      width: number | null;
      height: number | null;
      durationSeconds: number | null;
      /** Read from the post (true), or only guessed from its address because Reddit didn't answer. */
      fromPost: boolean;
      notice: string | null;
    }
  | {
      kind: "gallery";
      images: RedditGalleryImage[];
      /** False when only the first picture is known (Reddit didn't answer). */
      complete: boolean;
      notice: string | null;
    };

export interface ReaderPagination {
  page: number;
  pages: number;
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
  /** YouTube only. */
  likes?: number | null;
}

/** Whether a YouTube Data API key is saved (the key itself never leaves the server). */
export interface YouTubeKeyStatus {
  configured: boolean;
  /** e.g. "…x9Qz" */
  keyHint: string | null;
}

/** The FlareSolverr instance the app uses for opted-in sources (D-080). */
/** How often sources are checked (Settings → Checking, D-095). */
export interface CheckingValues {
  /** Feeds, boards, channels and subreddits: minutes between checks. */
  intervalMinutes: number;
  /** Followed forum threads: minutes between checks. */
  threadIntervalMinutes: number;
  /** Pages a thread check may read: the newest, plus earlier ones when a whole page is new. */
  threadPagesPerCheck: number;
}

export interface CheckingSettings extends CheckingValues {
  /** What each setting is when not set here (config.yaml, else the built-in default). */
  defaults: CheckingValues;
}

export interface FlareSolverrStatus {
  url: string | null;
  /** Reported by the instance when it was last checked (on save). */
  version: string | null;
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

/** An account, as the admin sees it in Settings → Accounts (D-114): nothing it follows or reads. */
export interface AccountView {
  id: string;
  username: string;
  role: "admin" | "user";
  disabled: boolean;
  totpEnabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  /** Last request from any of its signed-in devices. */
  lastSeenAt: number | null;
  sourceCount: number;
  /** The admin's own account. */
  you: boolean;
}

/** A one-time link not used yet: an invitation, or a password reset. */
export interface InviteView {
  id: string;
  kind: "invite" | "reset";
  /** Reset: whose password. */
  username: string | null;
  note: string | null;
  createdAt: number;
  expiresAt: number;
}

/** A link just made. The token is shown once; only its hash is kept. */
export interface InviteCreated {
  token: string;
  invite: InviteView;
}

/** What an invitation or reset link opens (before logging in). */
export interface InviteLinkInfo {
  kind: "invite" | "reset";
  username: string | null;
  expiresAt: number;
}
