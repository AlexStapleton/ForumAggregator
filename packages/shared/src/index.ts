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
