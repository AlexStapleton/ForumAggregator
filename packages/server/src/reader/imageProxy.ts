// http:// images in posts and articles (D-140). An https page can't show them (the CSP allows
// only https images, and browsers block or warn about mixed content), so the sanitizer points
// them here and this server fetches them. Only http:// addresses: https images load straight
// from their site, so this never becomes a general-purpose proxy.
import type { FastifyInstance } from "fastify";
import { sendError } from "../http.js";
import { FetchError, readCapped } from "../feeds/fetch.js";
import { OutboundBlocked, type OutboundPolicy } from "../feeds/outbound.js";
import { USER_AGENT } from "../sites/userAgent.js";
import { IMAGE_PROXY_PATH } from "./images.js";

/** Raster formats only. SVG is left out: served from this origin it could carry script. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon", "image/vnd.microsoft.icon"]);
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export function registerImageProxy(app: FastifyInstance, outbound: OutboundPolicy): void {
  app.get<{ Querystring: { url?: string } }>(IMAGE_PROXY_PATH, {
    // Login is required like every /api route; this only bounds how hard one client can push it.
    config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    let url: URL;
    try { url = new URL(request.query.url ?? ""); } catch { return sendError(reply, 400, "invalid_url", "A valid image address is required"); }
    if (url.protocol !== "http:" || url.username || url.password) return sendError(reply, 400, "invalid_url", "Only http:// images are fetched here");

    let res: Response;
    try {
      // Private and internal addresses are refused, redirects included (D-127).
      res = await outbound.fetch(url.href, {
        headers: { "user-agent": USER_AGENT, accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      if (err instanceof OutboundBlocked) return sendError(reply, 403, "blocked_destination", err.message);
      return sendError(reply, 502, "image_unavailable", "The image's site didn't answer");
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!res.ok || !IMAGE_TYPES.has(type) || Number(res.headers.get("content-length")) > IMAGE_MAX_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      return !res.ok ? sendError(reply, 502, "image_unavailable", `The image's site answered ${res.status}`)
        : !IMAGE_TYPES.has(type) ? sendError(reply, 415, "not_an_image", "That address isn't a supported image")
        : sendError(reply, 413, "too_large", "The image is too large");
    }
    let body: Uint8Array;
    try { body = await readCapped(res, IMAGE_MAX_BYTES); }
    catch (err) {
      if (err instanceof FetchError && err.kind === "too_large") return sendError(reply, 413, "too_large", "The image is too large");
      return sendError(reply, 502, "image_unavailable", "The image couldn't be downloaded");
    }
    return reply
      .header("content-type", type)
      // Each person's browser keeps it for a day; nothing is stored on the server.
      .header("cache-control", "private, max-age=86400")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("content-disposition", "inline")
      .send(Buffer.from(body));
  });
}
