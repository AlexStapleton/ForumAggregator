// Settings → Accounts (D-114): the admin invites people, resets passwords, turns accounts off or
// deletes them. The admin sees each account's name, activity and how many sources it follows;
// never what it follows or reads.
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AccountView, InviteCreated, InviteView } from "@fa/shared";
import { AccountUpdateRequest, InviteRequest } from "@fa/shared/schemas";
import { AccountError, type AuthService } from "./auth/service.js";
import type { FeedService } from "./feeds/service.js";
import { parseBody, sendError } from "./http.js";

/** Only the admin reaches these, and the server-wide settings (checking, FlareSolverr, YouTube key). */
export const ADMIN_ONLY = /^\/api\/(admin|settings)\//;

function accountError(reply: FastifyReply, err: unknown) {
  if (err instanceof AccountError) return sendError(reply, err.status, err.code, err.message, err.fields);
  throw err;
}

const ID = /^[0-9a-f-]{36}$/;
const LINK_ID = /^[0-9a-f]{64}$/;

export function registerAdminRoutes(app: FastifyInstance, auth: AuthService, feeds: FeedService): void {
  app.addHook("onRequest", async (request, reply) => {
    if (ADMIN_ONLY.test(request.url) && request.auth && request.auth.user.role !== "admin") {
      return sendError(reply, 403, "admin_only", "Only the admin can do this");
    }
  });

  app.get("/api/admin/accounts", async (request): Promise<AccountView[]> =>
    (await auth.listAccounts()).map((a) => ({ ...a, you: a.id === request.auth!.user.id })),
  );

  app.patch<{ Params: { id: string } }>("/api/admin/accounts/:id", async (request, reply) => {
    const body = parseBody(AccountUpdateRequest, request, reply);
    if (!body) return;
    if (!ID.test(request.params.id)) return sendError(reply, 404, "not_found", "No such account");
    try {
      await auth.setDisabled(request.auth!.user.id, request.params.id, body.disabled);
    } catch (err) {
      return accountError(reply, err);
    }
    // A turned-off account's sources stop being checked unless someone else follows them.
    await feeds.resyncEnabled();
    request.log.info({ account: request.params.id, disabled: body.disabled }, body.disabled ? "account turned off" : "account turned on");
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/admin/accounts/:id", async (request, reply) => {
    if (!ID.test(request.params.id)) return sendError(reply, 404, "not_found", "No such account");
    try {
      await auth.deleteAccount(request.auth!.user.id, request.params.id);
    } catch (err) {
      return accountError(reply, err);
    }
    const removed = await feeds.removeUnfollowed();
    await feeds.resyncEnabled();
    request.log.info({ account: request.params.id, sourcesRemoved: removed }, "account deleted");
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/admin/accounts/:id/reset-link", async (request, reply): Promise<InviteCreated | void> => {
    if (!ID.test(request.params.id)) return sendError(reply, 404, "not_found", "No such account");
    if (request.params.id === request.auth!.user.id) return sendError(reply, 400, "own_account", "Change your own password in Settings → Password");
    try {
      const created = await auth.createInvite("reset", { userId: request.params.id });
      request.log.info({ account: request.params.id }, "password reset link created");
      return created;
    } catch (err) {
      return accountError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/admin/accounts/:id/totp-off", async (request, reply) => {
    if (!ID.test(request.params.id)) return sendError(reply, 404, "not_found", "No such account");
    try {
      await auth.adminDisableTotp(request.auth!.user.id, request.params.id);
    } catch (err) {
      return accountError(reply, err);
    }
    request.log.info({ account: request.params.id }, "two-factor login turned off by the admin");
    return { ok: true };
  });

  app.get("/api/admin/invites", async (): Promise<InviteView[]> => auth.listInvites());

  app.post("/api/admin/invites", async (request, reply): Promise<InviteCreated | void> => {
    const body = parseBody(InviteRequest, request, reply);
    if (!body) return;
    const created = await auth.createInvite("invite", { note: body.note ?? null });
    request.log.info({ note: created.invite.note }, "invitation link created");
    return created;
  });

  app.delete<{ Params: { id: string } }>("/api/admin/invites/:id", async (request, reply) => {
    if (!LINK_ID.test(request.params.id) || !(await auth.revokeInvite(request.params.id))) return sendError(reply, 404, "not_found", "No such link");
    return { ok: true };
  });
}
