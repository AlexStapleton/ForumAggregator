import type { FastifyInstance, FastifyReply } from "fastify";
import type { ItemsFilter } from "@fa/shared";
import { AddSourceRequest, MarkReadRequest, UpdateItemRequest, UpdateSourceRequest } from "@fa/shared/schemas";
import { parseBody, sendError } from "../http.js";
import type { ItemService } from "./items.js";
import { SourceError, type FeedService } from "./service.js";

function handleSourceError(reply: FastifyReply, err: unknown) {
  if (err instanceof SourceError) return sendError(reply, err.status, err.code, err.message);
  throw err;
}

export function registerFeedRoutes(app: FastifyInstance, feeds: FeedService, items: ItemService): void {
  // ---- sources ----
  app.get("/api/sources", async () => feeds.listSources());

  app.post("/api/sources", async (request, reply) => {
    const body = parseBody(AddSourceRequest, request, reply);
    if (!body) return;
    try {
      return reply.code(201).send(await feeds.addSource(body));
    } catch (err) {
      return handleSourceError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/sources/:id", async (request, reply) => {
    const body = parseBody(UpdateSourceRequest, request, reply);
    if (!body) return;
    try {
      return await feeds.updateSource(request.params.id, body);
    } catch (err) {
      return handleSourceError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/sources/:id", async (request, reply) => {
    if (!(await feeds.removeSource(request.params.id))) return sendError(reply, 404, "not_found", "Source not found");
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/sources/:id/check", async (request, reply) => {
    if (!(await feeds.getSource(request.params.id))) return sendError(reply, 404, "not_found", "Source not found");
    const result = await feeds.checkSource(request.params.id);
    return { result, source: await feeds.getSource(request.params.id) };
  });

  // ---- items ----
  app.get<{ Querystring: { filter?: string; sourceId?: string; cursor?: string; limit?: string } }>("/api/items", async (request) => {
    const q = request.query;
    const filter: ItemsFilter = q.filter === "all" || q.filter === "saved" ? q.filter : "unread";
    return items.list({ filter, sourceId: q.sourceId || undefined, cursor: q.cursor || undefined, limit: q.limit ? Number(q.limit) : undefined });
  });

  app.patch<{ Params: { id: string } }>("/api/items/:id", async (request, reply) => {
    const body = parseBody(UpdateItemRequest, request, reply);
    if (!body) return;
    if (!(await items.update(request.params.id, body))) return sendError(reply, 404, "not_found", "Item not found");
    return { ok: true };
  });

  app.post("/api/items/mark-read", async (request, reply) => {
    const body = parseBody(MarkReadRequest, request, reply);
    if (!body) return;
    return { updated: await items.markRead(body) };
  });
}
