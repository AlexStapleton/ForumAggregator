// A fake internet for tests: URL → response, with request logging.
import type { Fetcher, FetchOptions } from "../src/feeds/fetch.js";
import { FetchError } from "../src/feeds/fetch.js";

type Route =
  | { body: string; contentType?: string; etag?: string; finalUrl?: string }
  | { error: FetchError };

export class FakeWeb {
  routes = new Map<string, Route>();
  requests: Array<{ url: string; options: FetchOptions }> = [];

  set(url: string, route: Route) {
    this.routes.set(url, route);
    return this;
  }

  fetcher: Fetcher = async (url, options) => {
    this.requests.push({ url, options });
    const route = this.routes.get(url);
    if (!route) throw new FetchError("not_found", "not found [HTTP 404]", 404);
    if ("error" in route) throw route.error;
    if (route.etag && options.etag === route.etag) return { kind: "not_modified" };
    return {
      kind: "ok",
      status: 200,
      url: route.finalUrl ?? url,
      body: route.body,
      contentType: route.contentType ?? "application/xml",
      etag: route.etag ?? null,
      lastModified: null,
    };
  };
}

export function rss(title: string, items: Array<{ guid: string; title: string; date: string; link?: string }>): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>https://site.example/</link>${items
    .map(
      (i) =>
        `<item><guid isPermaLink="false">${i.guid}</guid><title>${i.title}</title><link>${i.link ?? `https://site.example/${i.guid}`}</link><pubDate>${new Date(i.date).toUTCString()}</pubDate></item>`,
    )
    .join("")}</channel></rss>`;
}
