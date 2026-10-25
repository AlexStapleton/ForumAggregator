import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Viewer } from "../auth/service.js";
import type { ItemsFilter } from "@fa/shared";
import { AddSourceRequest, MarkReadRequest, OpmlImportRequest, ReaderPreviewRequest, UpdateItemRequest, UpdateSourceRequest } from "@fa/shared/schemas";
import { parseBody, sendError } from "../http.js";
import type { ReaderService } from "../reader/service.js";
import type { ItemService } from "./items.js";
import { OpmlError } from "./opml.js";
import { checkSelectors, SourceError, type FeedService } from "./service.js";

/** The logged-in account: everything here is theirs only (D-115). The auth hook guarantees one. */
export function viewer(request: FastifyRequest): Viewer {
  return request.auth!.user;
}

function handleSourceError(reply: FastifyReply, err: unknown) {
  if (err instanceof SourceError) return sendError(reply, err.status, err.code, err.message, err.fields);
  throw err;
}

export function registerFeedRoutes(app: FastifyInstance, feeds: FeedService, items: ItemService, reader: ReaderService): void {
  // ---- sources ----
  app.get("/api/sources", async (request) => feeds.listSources(viewer(request)));

  app.post("/api/sources", async (request, reply) => {
    const body = parseBody(AddSourceRequest, request, reply);
    if (!body) return;
    try {
      return reply.code(201).send(await feeds.addSource(viewer(request), body));
    } catch (err) {
      return handleSourceError(reply, err);
    }
  });

  // ---- OPML (D-073) ----
  app.get("/api/sources/opml", async (request, reply) => {
    const date = new Date().toISOString().slice(0, 10);
    return reply
      .header("content-type", "text/x-opml; charset=utf-8")
      .header("content-disposition", `attachment; filename="forumaggregator-${date}.opml"`)
      .send(await feeds.exportOpml(viewer(request)));
  });

  app.post("/api/sources/opml", { bodyLimit: 3 * 1024 * 1024 }, async (request, reply) => {
    const body = parseBody(OpmlImportRequest, request, reply);
    if (!body) return;
    try {
      return await feeds.importOpml(viewer(request), body.opml);
    } catch (err) {
      if (err instanceof OpmlError) return sendError(reply, 400, "invalid_opml", err.message);
      throw err;
    }
  });

  // Try reader selectors on one of the source's items before saving them (D-074).
  app.post<{ Params: { id: string } }>("/api/sources/:id/reader-preview", async (request, reply) => {
    const body = parseBody(ReaderPreviewRequest, request, reply);
    if (!body) return;
    try {
      checkSelectors(body);
    } catch (err) {
      return handleSourceError(reply, err);
    }
    const preview = await reader.preview(viewer(request), request.params.id, body);
    if (!preview) return sendError(reply, 404, "not_found", "Source not found");
    if ("error" in preview) return sendError(reply, 400, "preview_unavailable", preview.error);
    return preview;
  });

  app.patch<{ Params: { id: string } }>("/api/sources/:id", async (request, reply) => {
    const body = parseBody(UpdateSourceRequest, request, reply);
    if (!body) return;
    try {
      return await feeds.updateSource(viewer(request), request.params.id, body);
    } catch (err) {
      return handleSourceError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/sources/:id", async (request, reply) => {
    if (!(await feeds.removeSource(viewer(request), request.params.id))) return sendError(reply, 404, "not_found", "Source not found");
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/sources/:id/check", async (request, reply) => {
    if (!(await feeds.follows(viewer(request), request.params.id))) return sendError(reply, 404, "not_found", "Source not found");
    const result = await feeds.checkSource(request.params.id);
    return { result, source: await feeds.getSource(viewer(request), request.params.id) };
  });

  // ---- items ----
  app.get("/api/tags", async (request) => feeds.listTags(viewer(request)));

  app.get<{ Querystring: { filter?: string; order?: string; sourceId?: string; excludeSourceIds?: string; tag?: string; cursor?: string; limit?: string } }>("/api/items", async (request) => {
    const q = request.query;
    const filter: ItemsFilter = q.filter === "all" || q.filter === "saved" ? q.filter : "unread";
    return items.list(viewer(request), {
      filter,
      order: q.order === "oldest" ? "oldest" : "newest",
      sourceId: q.sourceId || undefined,
      // Comma-separated source IDs to leave out.
      excludeSourceIds: q.excludeSourceIds ? q.excludeSourceIds.split(",").filter(Boolean).slice(0, 1000) : undefined,
      tag: q.tag || undefined,
      cursor: q.cursor || undefined,
      limit: q.limit ? Number(q.limit) : undefined,
    });
  });

  app.get<{ Params: { id: string } }>("/api/items/:id/comments", async (request, reply) => {
    const comments = await reader.comments(viewer(request), request.params.id);
    if (!comments) return sendError(reply, 404, "not_found", "Item not found");
    return comments;
  });

  // A Reddit post's video or gallery (D-117).
  app.get<{ Params: { id: string } }>("/api/items/:id/media", async (request, reply) => {
    const media = await reader.media(viewer(request), request.params.id);
    if (!media) return sendError(reply, 404, "not_found", "No video or gallery for this item");
    return media;
  });

  app.get<{ Params: { id: string }; Querystring: { page?: string } }>("/api/items/:id/reader", async (request, reply) => {
    // Forum threads: ?page=N or ?page=last (D-088); ignored for everything else.
    const raw = request.query.page;
    const page = raw === "last" ? "last" : raw && /^\d{1,6}$/.test(raw) && Number(raw) >= 1 ? Number(raw) : undefined;
    const content = await reader.get(viewer(request), request.params.id, page);
    if (!content) return sendError(reply, 404, "not_found", "Item not found");
    return content;
  });

  app.patch<{ Params: { id: string } }>("/api/items/:id", async (request, reply) => {
    const body = parseBody(UpdateItemRequest, request, reply);
    if (!body) return;
    if (!(await items.update(viewer(request), request.params.id, body))) return sendError(reply, 404, "not_found", "Item not found");
    return { ok: true };
  });

  app.post("/api/items/mark-read", async (request, reply) => {
    const body = parseBody(MarkReadRequest, request, reply);
    if (!body) return;
    return { updated: await items.markRead(viewer(request), body) };
  });
}
