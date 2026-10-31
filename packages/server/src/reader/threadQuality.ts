import type { ForumThreadPage } from "./extract.js";

export type ThreadQualityStatus = "complete" | "empty" | "partial" | "access-blocked" | "unrecognized" | "wrong-page";
export interface ThreadInspection {
  value: ForumThreadPage | null;
  status: ThreadQualityStatus;
  codes: Array<"missing-body" | "empty-body" | "missing-id" | "truncated" | "login" | "challenge" | "deleted" | "unknown-layout" | "wrong-thread" | "wrong-page">;
  counts: { candidates: number; bodies: number; usable: number; stableIds: number; duplicates: number; deleted: number };
}

/** Compare known engine thread identities, not slugs, query credentials or post-number gaps. */
export function threadIdentity(raw: string): string | null {
  try {
    const url = new URL(raw);
    const xf = /^(.*\/threads\/)[^/]+\.(\d+)(?:\/|$)/.exec(url.pathname);
    if (xf) return `${url.origin}${xf[1]}${xf[2]}`;
    const id = url.searchParams.get("t");
    if (/\/showthread\.php$/i.test(url.pathname) && /^\d+$/.test(id ?? "")) return `${url.origin}${url.pathname}?t=${id}`;
    const vb = /^(.*\/)(\d+)-[^/]+\.html$/.exec(url.pathname);
    return vb ? `${url.origin}${vb[1]}${vb[2]}` : null;
  } catch { return null; }
}

export function validateThreadResponse(result: ThreadInspection, requested: string, final: string, expectedPage?: number | "last"): ThreadInspection {
  if (result.status === "access-blocked") return result;
  const expected = threadIdentity(requested);
  const actual = threadIdentity(final);
  const wrongThread = expected && actual !== expected;
  const page = result.value;
  const wrongPage = page && expectedPage !== undefined && page.page !==
    (expectedPage === "last" ? page.pages : Math.min(expectedPage, page.pages));
  return wrongThread || wrongPage
    ? { ...result, value: null, status: "wrong-page", codes: [wrongThread ? "wrong-thread" : "wrong-page"] }
    : result;
}

/** Stable user-facing reasons; never include source HTML, URLs, cookies or exception details. */
export function threadQualityMessage(result: ThreadInspection): string {
  switch (result.status) {
    case "complete": return "Thread page read successfully.";
    case "empty": return "The forum reports that this page has no available posts. Previously collected replies have been kept.";
    case "partial": return "Some replies on this page could not be read completely. Previously collected replies and reading position have been kept.";
    case "access-blocked": return result.codes.includes("login")
      ? "The forum requires signing in to read this page. Open the original to check access."
      : "The forum returned a bot check instead of replies. Try again later or check this source's FlareSolverr setting.";
    case "wrong-page": return "The forum returned a different thread or page. Will retry without skipping replies.";
    case "unrecognized": return "Couldn't recognize the thread's post layout. Previously collected replies have been kept; open the original to check the page.";
  }
}

export class ThreadExtractionError extends Error {
  constructor(readonly inspection: ThreadInspection) { super(threadQualityMessage(inspection)); }
}
