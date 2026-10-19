// App settings kept in the database (the `settings` key/value table). Secrets are encrypted
// with the SecretBox, like the TOTP secret, so a copied database alone doesn't reveal them.
import type { FastifyInstance } from "fastify";
import type { FlareSolverrStatus, YouTubeKeyStatus } from "@fa/shared";
import { FlareSolverrRequest, YouTubeKeyRequest } from "@fa/shared/schemas";
import type { SecretBox } from "./crypto.js";
import type { Db } from "./db/index.js";
import { FetchError, type JsonFetcher } from "./feeds/fetch.js";
import type { FlareSolverr } from "./feeds/flaresolverr.js";
import { parseBody, sendError } from "./http.js";
import { checkApiKey, YouTubeApiError } from "./reader/youtubeApi.js";

const YOUTUBE_KEY = "youtube_api_key";
const FLARESOLVERR_URL = "flaresolverr_url";
const FLARESOLVERR_VERSION = "flaresolverr_version";

export class SettingsService {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly log?: { warn: (obj: object, msg: string) => void },
  ) {}

  /** The YouTube Data API key, or null if none is set (or it can't be decrypted any more). */
  async youtubeApiKey(): Promise<string | null> {
    const row = await this.db.kysely.selectFrom("settings").select("value").where("key", "=", YOUTUBE_KEY).executeTakeFirst();
    if (!row) return null;
    try {
      return this.box.decrypt(row.value);
    } catch {
      // The secret key changed since it was saved (e.g. a new /data/secret.key).
      this.log?.warn({}, "the saved YouTube API key can't be decrypted; enter it again in Settings");
      return null;
    }
  }

  async youtubeKeyStatus(): Promise<YouTubeKeyStatus> {
    const key = await this.youtubeApiKey();
    // Only the last 4 characters are ever sent back to the browser.
    return key ? { configured: true, keyHint: `…${key.slice(-4)}` } : { configured: false, keyHint: null };
  }

  private async get(key: string): Promise<string | null> {
    const row = await this.db.kysely.selectFrom("settings").select("value").where("key", "=", key).executeTakeFirst();
    return row?.value ?? null;
  }

  private async set(key: string, value: string | null): Promise<void> {
    await this.db.kysely.deleteFrom("settings").where("key", "=", key).execute();
    if (value !== null) await this.db.kysely.insertInto("settings").values({ key, value }).execute();
  }

  /** The FlareSolverr base URL (not a secret: a LAN address). */
  flaresolverrUrl(): Promise<string | null> {
    return this.get(FLARESOLVERR_URL);
  }

  async flaresolverrStatus(): Promise<FlareSolverrStatus> {
    return { url: await this.get(FLARESOLVERR_URL), version: await this.get(FLARESOLVERR_VERSION) };
  }

  async setFlaresolverr(url: string | null, version: string | null): Promise<void> {
    await this.set(FLARESOLVERR_URL, url);
    await this.set(FLARESOLVERR_VERSION, url ? version : null);
  }

  async setYoutubeApiKey(key: string | null): Promise<void> {
    await this.db.kysely.deleteFrom("settings").where("key", "=", YOUTUBE_KEY).execute();
    if (key) await this.db.kysely.insertInto("settings").values({ key: YOUTUBE_KEY, value: this.box.encrypt(key) }).execute();
  }
}

export function registerSettingsRoutes(app: FastifyInstance, settings: SettingsService, fetchJson: JsonFetcher, flare: FlareSolverr): void {
  app.get("/api/settings/flaresolverr", async () => settings.flaresolverrStatus());

  // Saving checks the address answers like FlareSolverr first.
  app.put("/api/settings/flaresolverr", async (request, reply) => {
    const body = parseBody(FlareSolverrRequest, request, reply);
    if (!body) return;
    if (!body.url) {
      await settings.setFlaresolverr(null, null);
      return settings.flaresolverrStatus();
    }
    const url = body.url.replace(/\/+$/, "");
    try {
      const version = await flare.ping(url);
      await settings.setFlaresolverr(url, version);
    } catch (err) {
      if (err instanceof FetchError) return sendError(reply, 400, "flaresolverr_unreachable", err.message, { url: err.message });
      throw err;
    }
    return settings.flaresolverrStatus();
  });

  app.get("/api/settings/youtube", async () => settings.youtubeKeyStatus());

  // Saving checks the key with one request first, so a typo is caught here, not in the reader.
  app.put("/api/settings/youtube", async (request, reply) => {
    const body = parseBody(YouTubeKeyRequest, request, reply);
    if (!body) return;
    if (body.apiKey) {
      try {
        await checkApiKey(fetchJson, body.apiKey);
      } catch (err) {
        if (err instanceof YouTubeApiError) return sendError(reply, 400, `youtube_${err.reason}`, err.message, { apiKey: err.message });
        if (err instanceof FetchError) return sendError(reply, 502, "youtube_unreachable", `Couldn't reach YouTube to check the key (${err.message}).`);
        throw err;
      }
    }
    await settings.setYoutubeApiKey(body.apiKey);
    return settings.youtubeKeyStatus();
  });
}
