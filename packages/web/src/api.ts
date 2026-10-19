import { CSRF_HEADER, type ApiError } from "@fa/shared";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.message);
  }
}

/** Calls the server API. Throws ApiRequestError with the server's message on failure. */
export async function api<T = unknown>(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers[CSRF_HEADER] = "1";
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiRequestError(0, { error: "network", message: "Can't reach the server. Check your connection." });
  }
  const data = res.headers.get("content-type")?.includes("application/json") ? await res.json() : undefined;
  if (!res.ok) {
    throw new ApiRequestError(res.status, data ?? { error: "http", message: `Request failed (${res.status})` });
  }
  return data as T;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

export function fieldErrors(err: unknown): Record<string, string> {
  return err instanceof ApiRequestError ? (err.body.fields ?? {}) : {};
}
