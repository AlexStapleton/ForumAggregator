import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiError } from "@fa/shared";
import type { z } from "zod";

export function sendError(reply: FastifyReply, status: number, error: string, message: string, fields?: Record<string, string>) {
  const body: ApiError = { error, message, ...(fields ? { fields } : {}) };
  return reply.code(status).send(body);
}

/** Validates the JSON body; on failure sends a 400 and returns undefined. */
export function parseBody<T extends z.ZodType>(schema: T, request: FastifyRequest, reply: FastifyReply): z.infer<T> | undefined {
  const result = schema.safeParse(request.body ?? {});
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join(".") || "_";
    fields[key] ??= issue.message;
  }
  void sendError(reply, 400, "validation", "Some fields are invalid", fields);
  return undefined;
}
