// Single-user account, sessions and TOTP. Pure logic; HTTP lives in routes.ts.
import crypto from "node:crypto";
import * as OTPAuth from "otpauth";
import type { Db } from "../db/index.js";
import type { Selectable } from "kysely";
import type { UsersTable } from "../db/schema.js";

type UserRow = Selectable<UsersTable>;
import { randomToken, safeEqual, sha256, type SecretBox } from "../crypto.js";
import { getDummyHash, hashPassword, verifyPassword } from "./passwords.js";

const TOTP_PERIOD = 30;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const MINUTE = 60_000;
/** All password/code checks share one queue: a single-user app, so one at a time is plenty. */
const ACCOUNT_CHECKS = "account";

// Per-account limits (D-110). The login route's per-IP limit can be dodged by anyone the app
// trusts to send X-Forwarded-For (e.g. a device on the LAN); these can't.
/** Wrong passwords allowed in a row before each further try has to wait. */
const FREE_PASSWORD_FAILURES = 10;
/** The wait after that: 1 min, doubling with each further wrong password, at most an hour. */
const passwordLock = (failures: number) => Math.min(60 * MINUTE, MINUTE * 2 ** (failures - FREE_PASSWORD_FAILURES));
/** Wrong two-factor codes in a row before codes are refused for a while. */
const TOTP_FAILURES_PER_LOCK = 5;
/** 15 min after the 5th, doubling at every 5th after that, at most a day. */
const totpLock = (failures: number) => Math.min(24 * 60 * MINUTE, 15 * MINUTE * 2 ** (failures / TOTP_FAILURES_PER_LOCK - 1));

export interface AuthUser {
  id: string;
  username: string;
  totpEnabled: boolean;
}

export type LoginResult =
  /** deviceToken: set when this browser wasn't a known device yet; the route gives it the cookie. */
  | { ok: true; user: AuthUser; deviceToken?: string }
  | { ok: false; reason: "invalid_credentials" | "totp_required" | "invalid_totp" }
  /** Too many wrong passwords or codes in a row: refused until `retryAfterMs` has passed. */
  | { ok: false; reason: "locked" | "totp_locked"; retryAfterMs: number };

/** Outcome of a password- or code-protected account change. */
export type CheckResult = { ok: true } | { ok: false; reason: "invalid_credentials" | "invalid_totp" } | { ok: false; reason: "locked" | "totp_locked"; retryAfterMs: number };

/**
 * Where wrong passwords and codes are counted (D-111): a known device (one that has logged in
 * before) counts its own; every other browser shares the account's counters.
 */
interface Counters {
  table: "users" | "known_devices";
  id: string;
  failed_logins: number;
  login_locked_until: number | null;
  totp_failures: number;
  totp_locked_until: number | null;
}

export interface SessionInfo {
  /** The session's id (a hash of its cookie, never the cookie itself). */
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
}

function toAuthUser(row: Pick<UserRow, "id" | "username" | "totp_enabled">): AuthUser {
  return { id: row.id, username: row.username, totpEnabled: row.totp_enabled === 1 };
}

export class AuthService {
  /** Present only while no account exists. */
  private setupCode: string | undefined;

  /** One password/code check at a time per account, so parallel guesses can't outrun the limits. */
  private checking = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly sessionTtlMs: number,
    private readonly now: () => number = Date.now,
    /** A session ends this long after login even if in use (D-110). */
    private readonly sessionMaxMs = 90 * 24 * 60 * MINUTE,
  ) {}

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.checking.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.checking.set(key, next);
    void next.catch(() => undefined).finally(() => {
      if (this.checking.get(key) === next) this.checking.delete(key);
    });
    return next;
  }

  private async updateCounters(c: Counters, set: Partial<Omit<Counters, "table" | "id">>): Promise<void> {
    Object.assign(c, set);
    if (c.table === "users") await this.db.kysely.updateTable("users").set(set).where("id", "=", c.id).execute();
    else await this.db.kysely.updateTable("known_devices").set(set).where("id", "=", c.id).execute();
  }

  /**
   * The counters for this attempt (D-111): the known device's own if the browser presents a valid
   * device cookie for this account, else the account's (shared by every unknown browser).
   */
  private async countersFor(row: UserRow, deviceToken?: string): Promise<Counters> {
    if (deviceToken) {
      const device = await this.db.kysely.selectFrom("known_devices").selectAll().where("id", "=", sha256(deviceToken)).where("user_id", "=", row.id).executeTakeFirst();
      if (device) return { table: "known_devices", ...pickCounters(device) };
    }
    return { table: "users", ...pickCounters(row) };
  }

  /** Password check with the limit for wherever it's counted. */
  private async checkPassword(row: UserRow, password: string, c: Counters): Promise<CheckResult> {
    const now = this.now();
    if (c.login_locked_until && c.login_locked_until > now) return { ok: false, reason: "locked", retryAfterMs: c.login_locked_until - now };
    if (!(await verifyPassword(row.password_hash, password))) {
      // After FREE_PASSWORD_FAILURES in a row, each one makes the next try wait.
      const failures = c.failed_logins + 1;
      await this.updateCounters(c, { failed_logins: failures, login_locked_until: failures >= FREE_PASSWORD_FAILURES ? now + passwordLock(failures) : null });
      return { ok: false, reason: "invalid_credentials" };
    }
    if (c.failed_logins || c.login_locked_until) await this.updateCounters(c, { failed_logins: 0, login_locked_until: null });
    return { ok: true };
  }

  /** Two-factor code check with the limit for wherever it's counted; a good code is used up. */
  private async checkCode(row: UserRow, code: string, c: Counters): Promise<CheckResult> {
    const now = this.now();
    if (c.totp_locked_until && c.totp_locked_until > now) return { ok: false, reason: "totp_locked", retryAfterMs: c.totp_locked_until - now };
    if (!(await this.consumeTotp(row, code))) {
      // Every TOTP_FAILURES_PER_LOCK-th wrong code in a row locks codes for a while.
      const failures = c.totp_failures + 1;
      const lockMs = failures % TOTP_FAILURES_PER_LOCK === 0 ? totpLock(failures) : null;
      await this.updateCounters(c, { totp_failures: failures, totp_locked_until: lockMs === null ? c.totp_locked_until : now + lockMs });
      return lockMs === null ? { ok: false, reason: "invalid_totp" } : { ok: false, reason: "totp_locked", retryAfterMs: lockMs };
    }
    if (c.totp_failures || c.totp_locked_until) await this.updateCounters(c, { totp_failures: 0, totp_locked_until: null });
    return { ok: true };
  }

  /** Makes this browser a known device of the account (D-111); returns the cookie value. */
  async rememberDevice(userId: string): Promise<string> {
    const token = randomToken();
    const now = this.now();
    await this.db.kysely.insertInto("known_devices").values({ id: sha256(token), user_id: userId, created_at: now, last_used_at: now }).execute();
    // Keep the 20 most recently used: enough for anyone's phones and computers.
    const all = await this.db.kysely.selectFrom("known_devices").select("id").where("user_id", "=", userId).orderBy("last_used_at", "desc").execute();
    const drop = all.slice(KNOWN_DEVICES_KEPT).map((d) => d.id);
    if (drop.length) await this.db.kysely.deleteFrom("known_devices").where("id", "in", drop).execute();
    return token;
  }

  /** Forgets every known device but this browser's (after a password change: maybe it leaked). */
  async forgetOtherDevices(userId: string, keepDeviceToken?: string): Promise<void> {
    let q = this.db.kysely.deleteFrom("known_devices").where("user_id", "=", userId);
    if (keepDeviceToken) q = q.where("id", "!=", sha256(keepDeviceToken));
    await q.execute();
  }

  // ---- first-run setup -------------------------------------------------------------

  /** Returns the setup code to print if no account exists yet, otherwise undefined. */
  async initSetup(fixedCode?: string): Promise<string | undefined> {
    const existing = await this.db.kysely.selectFrom("users").select("id").limit(1).executeTakeFirst();
    if (existing) {
      this.setupCode = undefined;
      return undefined;
    }
    // 10 chars from an unambiguous alphabet, grouped for readability: ABCDE-FGHJK.
    this.setupCode = fixedCode ?? generateSetupCode();
    return this.setupCode;
  }

  isSetupRequired(): boolean {
    return this.setupCode !== undefined;
  }

  checkSetupCode(code: string): boolean {
    if (!this.setupCode) return false;
    const norm = (s: string) => s.replace(/[\s-]/g, "").toUpperCase();
    return safeEqual(norm(code), norm(this.setupCode));
  }

  async createInitialUser(username: string, password: string): Promise<AuthUser> {
    const now = this.now();
    const row = {
      id: crypto.randomUUID(),
      username,
      password_hash: await hashPassword(password),
      totp_secret: null,
      totp_enabled: 0,
      totp_last_step: null,
      created_at: now,
      updated_at: now,
    };
    await this.db.kysely.transaction().execute(async (trx) => {
      // Guard against two concurrent setup requests.
      const existing = await trx.selectFrom("users").select("id").limit(1).executeTakeFirst();
      if (existing) throw new Error("An account already exists");
      await trx.insertInto("users").values(row).execute();
    });
    this.setupCode = undefined;
    return toAuthUser(row);
  }

  // ---- login -----------------------------------------------------------------------

  login(username: string, password: string, totpCode?: string, deviceToken?: string): Promise<LoginResult> {
    return this.serial(ACCOUNT_CHECKS, async () => {
      const row = await this.db.kysely.selectFrom("users").selectAll().where("username", "=", username).executeTakeFirst();
      if (!row) {
        await verifyPassword(await getDummyHash(), password);
        return { ok: false, reason: "invalid_credentials" };
      }
      const counters = await this.countersFor(row, deviceToken);
      const pw = await this.checkPassword(row, password, counters);
      if (!pw.ok) return pw;
      if (row.totp_enabled === 1) {
        if (!totpCode) return { ok: false, reason: "totp_required" };
        const code = await this.checkCode(row, totpCode, counters);
        if (!code.ok) return code;
      }
      if (counters.table === "known_devices") {
        await this.db.kysely.updateTable("known_devices").set({ last_used_at: this.now() }).where("id", "=", counters.id).execute();
        return { ok: true, user: toAuthUser(row) };
      }
      return { ok: true, user: toAuthUser(row), deviceToken: await this.rememberDevice(row.id) };
    });
  }

  async getUserByUsername(username: string): Promise<AuthUser | undefined> {
    const row = await this.db.kysely
      .selectFrom("users")
      .select(["id", "username", "totp_enabled"])
      .where("username", "=", username)
      .executeTakeFirst();
    return row && toAuthUser(row);
  }

  changePassword(userId: string, current: string, next: string, keepSessionId?: string, deviceToken?: string): Promise<CheckResult> {
    return this.serial(ACCOUNT_CHECKS, () => this.doChangePassword(userId, current, next, keepSessionId, deviceToken));
  }

  private async doChangePassword(userId: string, current: string, next: string, keepSessionId?: string, deviceToken?: string): Promise<CheckResult> {
    const row = await this.db.kysely.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirst();
    if (!row) return { ok: false, reason: "invalid_credentials" };
    const pw = await this.checkPassword(row, current, await this.countersFor(row, deviceToken));
    if (!pw.ok) return pw;
    await this.db.kysely
      .updateTable("users")
      .set({ password_hash: await hashPassword(next), updated_at: this.now() })
      .where("id", "=", userId)
      .execute();
    await this.signOutOthers(userId, keepSessionId);
    await this.forgetOtherDevices(userId, deviceToken);
    return { ok: true };
  }

  /** Signs out every device but the given session. Returns how many were signed out. */
  async signOutOthers(userId: string, keepSessionId?: string): Promise<number> {
    let q = this.db.kysely.deleteFrom("sessions").where("user_id", "=", userId);
    if (keepSessionId) q = q.where("id", "!=", keepSessionId);
    return Number((await q.executeTakeFirst()).numDeletedRows);
  }

  async listSessions(userId: string): Promise<SessionInfo[]> {
    const rows = await this.db.kysely
      .selectFrom("sessions")
      .select(["id", "created_at", "last_seen_at", "expires_at", "ip", "user_agent"])
      .where("user_id", "=", userId)
      .where("expires_at", ">", this.now())
      .orderBy("last_seen_at", "desc")
      .execute();
    return rows.map((r) => ({ id: r.id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at, ip: r.ip, userAgent: r.user_agent }));
  }

  /** Ends one of the user's sessions. False if it isn't theirs (or is gone). */
  async endSession(userId: string, sessionId: string): Promise<boolean> {
    const res = await this.db.kysely.deleteFrom("sessions").where("user_id", "=", userId).where("id", "=", sessionId).executeTakeFirst();
    return Number(res.numDeletedRows) === 1;
  }

  // ---- sessions --------------------------------------------------------------------

  /** Creates a session and returns the cookie token (only its hash is stored). */
  async createSession(userId: string, meta: { ip?: string; userAgent?: string }): Promise<{ token: string; expiresAt: number }> {
    const token = randomToken();
    const now = this.now();
    const expiresAt = now + Math.min(this.sessionTtlMs, this.sessionMaxMs);
    await this.db.kysely
      .insertInto("sessions")
      .values({
        id: sha256(token),
        user_id: userId,
        created_at: now,
        expires_at: expiresAt,
        last_seen_at: now,
        ip: meta.ip ?? null,
        user_agent: meta.userAgent?.slice(0, 300) ?? null,
      })
      .execute();
    return { token, expiresAt };
  }

  /**
   * Resolves a cookie token to its user. Sliding expiry: the session is extended at most
   * once an hour so normal browsing doesn't write to the database on every request.
   */
  async resolveSession(token: string): Promise<{ user: AuthUser; sessionId: string; renewedExpiresAt?: number } | undefined> {
    const id = sha256(token);
    const now = this.now();
    const row = await this.db.kysely
      .selectFrom("sessions")
      .innerJoin("users", "users.id", "sessions.user_id")
      .select([
        "sessions.id as sid",
        "sessions.created_at",
        "sessions.expires_at",
        "sessions.last_seen_at",
        "users.id",
        "users.username",
        "users.totp_enabled",
      ])
      .where("sessions.id", "=", id)
      .executeTakeFirst();
    if (!row) return undefined;
    const hardEnd = row.created_at + this.sessionMaxMs;
    if (row.expires_at <= now || hardEnd <= now) {
      await this.db.kysely.deleteFrom("sessions").where("id", "=", id).execute();
      return undefined;
    }
    let renewedExpiresAt: number | undefined;
    if (now - row.last_seen_at >= TOUCH_INTERVAL_MS) {
      // Sliding, but never past the session's absolute end (D-110).
      renewedExpiresAt = Math.min(now + this.sessionTtlMs, hardEnd);
      await this.db.kysely
        .updateTable("sessions")
        .set({ last_seen_at: now, expires_at: renewedExpiresAt })
        .where("id", "=", id)
        .execute();
    }
    return { user: toAuthUser(row), sessionId: id, renewedExpiresAt };
  }

  async deleteSessionByToken(token: string): Promise<void> {
    await this.db.kysely.deleteFrom("sessions").where("id", "=", sha256(token)).execute();
  }

  async purgeExpiredSessions(): Promise<number> {
    const res = await this.db.kysely.deleteFrom("sessions").where("expires_at", "<=", this.now()).executeTakeFirst();
    return Number(res.numDeletedRows);
  }

  // ---- TOTP ------------------------------------------------------------------------

  /** Starts enrolment: stores a new (not yet active) secret and returns it for the QR code. */
  async beginTotp(userId: string): Promise<{ secret: string; uri: string }> {
    const user = await this.db.kysely.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirstOrThrow();
    if (user.totp_enabled === 1) throw new Error("Two-factor login is already enabled");
    const secret = new OTPAuth.Secret({ size: 20 });
    await this.db.kysely
      .updateTable("users")
      .set({ totp_secret: this.box.encrypt(secret.base32), totp_last_step: null, updated_at: this.now() })
      .where("id", "=", userId)
      .execute();
    return { secret: secret.base32, uri: this.totp(user.username, secret.base32).toString() };
  }

  /**
   * Activates TOTP once the user proves their authenticator produces valid codes. Every other
   * device is signed out: a session that existed before two-factor was on shouldn't outlive it.
   */
  enableTotp(userId: string, code: string, keepSessionId?: string, deviceToken?: string): Promise<CheckResult> {
    return this.serial(ACCOUNT_CHECKS, async () => {
      const user = await this.db.kysely.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirstOrThrow();
      if (user.totp_enabled === 1 || !user.totp_secret) return { ok: false, reason: "invalid_totp" };
      const checked = await this.checkCode(user, code, await this.countersFor(user, deviceToken));
      if (!checked.ok) return checked;
      await this.db.kysely.updateTable("users").set({ totp_enabled: 1, updated_at: this.now() }).where("id", "=", userId).execute();
      await this.signOutOthers(userId, keepSessionId);
      return { ok: true };
    });
  }

  /** Turns TOTP off (password and a current code required); signs out every other device. */
  disableTotp(userId: string, password: string, code: string, keepSessionId?: string, deviceToken?: string): Promise<CheckResult> {
    return this.serial(ACCOUNT_CHECKS, async () => {
      const user = await this.db.kysely.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirstOrThrow();
      if (user.totp_enabled !== 1) return { ok: false, reason: "invalid_totp" };
      const counters = await this.countersFor(user, deviceToken);
      const pw = await this.checkPassword(user, password, counters);
      if (!pw.ok) return pw;
      const checked = await this.checkCode(user, code, counters);
      if (!checked.ok) return checked;
      await this.db.kysely
        .updateTable("users")
        .set({ totp_enabled: 0, totp_secret: null, totp_last_step: null, totp_failures: 0, totp_locked_until: null, updated_at: this.now() })
        .where("id", "=", userId)
        .execute();
      await this.signOutOthers(userId, keepSessionId);
      return { ok: true };
    });
  }

  private totp(username: string, base32: string): OTPAuth.TOTP {
    return new OTPAuth.TOTP({
      issuer: "ForumAggregator",
      label: username,
      algorithm: "SHA1",
      digits: 6,
      period: TOTP_PERIOD,
      secret: OTPAuth.Secret.fromBase32(base32),
    });
  }

  /** Validates a code (±1 step for clock drift) and records its step so it can't be reused. */
  private async consumeTotp(user: UserRow, code: string): Promise<boolean> {
    if (!user.totp_secret) return false;
    const now = this.now();
    const totp = this.totp(user.username, this.box.decrypt(user.totp_secret));
    const delta = totp.validate({ token: code, timestamp: now, window: 1 });
    if (delta === null) return false;
    const step = Math.floor(now / 1000 / TOTP_PERIOD) + delta;
    if (user.totp_last_step !== null && step <= user.totp_last_step) return false;
    // Conditional update so two concurrent requests can't both use the same code.
    const res = await this.db.kysely
      .updateTable("users")
      .set({ totp_last_step: step })
      .where("id", "=", user.id)
      .where((eb) => eb.or([eb("totp_last_step", "is", null), eb("totp_last_step", "<", step)]))
      .executeTakeFirst();
    return Number(res.numUpdatedRows) === 1;
  }
}

/** Known devices kept per account (D-111). */
const KNOWN_DEVICES_KEPT = 20;

function pickCounters(r: { id: string; failed_logins: number; login_locked_until: number | null; totp_failures: number; totp_locked_until: number | null }) {
  return { id: r.id, failed_logins: r.failed_logins, login_locked_until: r.login_locked_until, totp_failures: r.totp_failures, totp_locked_until: r.totp_locked_until };
}

const SETUP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateSetupCode(): string {
  const chars = Array.from({ length: 10 }, () => SETUP_ALPHABET[crypto.randomInt(SETUP_ALPHABET.length)]);
  return `${chars.slice(0, 5).join("")}-${chars.slice(5).join("")}`;
}
