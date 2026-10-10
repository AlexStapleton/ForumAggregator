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

export interface AuthUser {
  id: string;
  username: string;
  totpEnabled: boolean;
}

export type LoginResult =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: "invalid_credentials" | "totp_required" | "invalid_totp" };

function toAuthUser(row: Pick<UserRow, "id" | "username" | "totp_enabled">): AuthUser {
  return { id: row.id, username: row.username, totpEnabled: row.totp_enabled === 1 };
}

export class AuthService {
  /** Present only while no account exists. */
  private setupCode: string | undefined;

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly sessionTtlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

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

  async login(username: string, password: string, totpCode?: string): Promise<LoginResult> {
    const row = await this.db.kysely
      .selectFrom("users")
      .selectAll()
      .where("username", "=", username)
      .executeTakeFirst();
    if (!row) {
      await verifyPassword(await getDummyHash(), password);
      return { ok: false, reason: "invalid_credentials" };
    }
    if (!(await verifyPassword(row.password_hash, password))) {
      return { ok: false, reason: "invalid_credentials" };
    }
    if (row.totp_enabled === 1) {
      if (!totpCode) return { ok: false, reason: "totp_required" };
      if (!(await this.consumeTotp(row, totpCode))) return { ok: false, reason: "invalid_totp" };
    }
    return { ok: true, user: toAuthUser(row) };
  }

  async getUserByUsername(username: string): Promise<AuthUser | undefined> {
    const row = await this.db.kysely
      .selectFrom("users")
      .select(["id", "username", "totp_enabled"])
      .where("username", "=", username)
      .executeTakeFirst();
    return row && toAuthUser(row);
  }

  async changePassword(userId: string, current: string, next: string, keepSessionId?: string): Promise<boolean> {
    const row = await this.db.kysely.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirst();
    if (!row || !(await verifyPassword(row.password_hash, current))) return false;
    await this.db.kysely
      .updateTable("users")
      .set({ password_hash: await hashPassword(next), updated_at: this.now() })
      .where("id", "=", userId)
      .execute();
    // Sign out every other device.
    let q = this.db.kysely.deleteFrom("sessions").where("user_id", "=", userId);
    if (keepSessionId) q = q.where("id", "!=", keepSessionId);
    await q.execute();
    return true;
  }

  // ---- sessions --------------------------------------------------------------------

  /** Creates a session and returns the cookie token (only its hash is stored). */
  async createSession(userId: string, meta: { ip?: string; userAgent?: string }): Promise<{ token: string; expiresAt: number }> {
    const token = randomToken();
    const now = this.now();
    const expiresAt = now + this.sessionTtlMs;
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
        "sessions.expires_at",
        "sessions.last_seen_at",
        "users.id",
        "users.username",
        "users.totp_enabled",
      ])
      .where("sessions.id", "=", id)
      .executeTakeFirst();
    if (!row) return undefined;
    if (row.expires_at <= now) {
      await this.db.kysely.deleteFrom("sessions").where("id", "=", id).execute();
      return undefined;
    }
    let renewedExpiresAt: number | undefined;
    if (now - row.last_seen_at >= TOUCH_INTERVAL_MS) {
      renewedExpiresAt = now + this.sessionTtlMs;
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

  /** Activates TOTP once the user proves their authenticator produces valid codes. */
  async enableTotp(userId: string, code: string): Promise<boolean> {
    const user = await this.db.kysely.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirstOrThrow();
    if (user.totp_enabled === 1 || !user.totp_secret) return false;
    if (!(await this.consumeTotp(user, code))) return false;
    await this.db.kysely.updateTable("users").set({ totp_enabled: 1, updated_at: this.now() }).where("id", "=", userId).execute();
    return true;
  }

  async disableTotp(userId: string, password: string, code: string): Promise<boolean> {
    const user = await this.db.kysely.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirstOrThrow();
    if (user.totp_enabled !== 1) return false;
    if (!(await verifyPassword(user.password_hash, password))) return false;
    if (!(await this.consumeTotp(user, code))) return false;
    await this.db.kysely
      .updateTable("users")
      .set({ totp_enabled: 0, totp_secret: null, totp_last_step: null, updated_at: this.now() })
      .where("id", "=", userId)
      .execute();
    return true;
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

const SETUP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateSetupCode(): string {
  const chars = Array.from({ length: 10 }, () => SETUP_ALPHABET[crypto.randomInt(SETUP_ALPHABET.length)]);
  return `${chars.slice(0, 5).join("")}-${chars.slice(5).join("")}`;
}
