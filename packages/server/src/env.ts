// Process-level settings, read from environment variables (see .env.example).
// Things that describe *what to follow* live in config.yaml instead (config.ts).
import path from "node:path";
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

const EnvSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    HOST: z.string().default("0.0.0.0"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATA_DIR: z.string().default("/data"),
    /** postgres://… for Postgres. Empty means SQLite at $DATA_DIR/forumaggregator.db. */
    DATABASE_URL: z.string().optional(),
    CONFIG_FILE: z.string().optional(),
    /**
     * Encrypts stored secrets (forum passwords, TOTP secret). Optional: when unset, a key is
     * generated on first start and kept in $DATA_DIR/secret.key (see secretKey.ts).
     */
    FA_SECRET_KEY: z
      .string()
      .min(32, "FA_SECRET_KEY must be at least 32 characters (openssl rand -base64 48)")
      .optional(),
    /** Optional fixed first-run setup code; otherwise a random one is printed to the log. */
    FA_SETUP_CODE: z.string().min(8).optional(),
    /**
     * Which upstream proxies may set X-Forwarded-For/-Proto. Comma-separated IPs, CIDRs or
     * the presets loopback, linklocal, uniquelocal (private ranges). "false" disables.
     */
    TRUST_PROXY: z.string().default("loopback,uniquelocal"),
    /** auto = Secure cookie when the request arrived over HTTPS (as reported by a trusted proxy). */
    COOKIE_SECURE: z.enum(["auto", "true", "false"]).default("auto"),
    SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    /** A session must log in again (with its two-factor code) after this long, even if in use (D-110). */
    SESSION_MAX_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
    /** local = app's own login; proxy = trust a header from an SSO proxy; both = either. */
    AUTH_MODE: z.enum(["local", "proxy", "both"]).default("local"),
    AUTH_PROXY_HEADER: z.string().default("Remote-User"),
    /** Direct-peer IPs/CIDRs allowed to assert AUTH_PROXY_HEADER. Required for proxy/both. */
    AUTH_PROXY_TRUSTED: z.string().optional(),
    /** Where the built web UI lives. Defaults to ../../web/dist relative to the server build. */
    WEB_DIST: z.string().optional(),
    /** Enable the login rate limiter (only ever disabled by tests). */
    LOGIN_RATE_LIMIT: bool.default(true),
    /** Exact origins an administrator intentionally allows for internal feeds/articles. */
    FA_ALLOWED_INTERNAL_ORIGINS: z.string().default(""),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_MODE !== "local" && !env.AUTH_PROXY_TRUSTED) {
      ctx.addIssue({
        code: "custom",
        path: ["AUTH_PROXY_TRUSTED"],
        message: `AUTH_PROXY_TRUSTED is required when AUTH_MODE=${env.AUTH_MODE}`,
      });
    }
  });

export type Env = z.infer<typeof EnvSchema> & {
  /** Resolved path of config.yaml. */
  configFile: string;
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Treat empty strings (common in .env files and compose) as "not set".
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== ""),
  );
  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join("\n")}`);
  }
  const env = result.data;
  return {
    ...env,
    configFile: env.CONFIG_FILE ?? path.join(env.DATA_DIR, "config.yaml"),
  };
}

/** Splits "a, b ,c" into ["a","b","c"]. */
export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
