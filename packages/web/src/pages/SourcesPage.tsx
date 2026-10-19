import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Source } from "@fa/shared";
import { api, errorMessage } from "../api";
import { Alert, Field } from "../components";
import { fullDate, relativeTime } from "../time";

const STATUS_LABEL: Record<Source["status"], string> = {
  ok: "OK",
  pending: "Waiting",
  error: "Error",
  paused: "Paused",
  challenged: "Blocked by bot check",
};

export function SourcesPage() {
  const [sources, setSources] = useState<Source[]>();
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string }>();
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    try {
      setSources(await api<Source[]>("GET", "/api/sources"));
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setAdding(true);
    setMessage(undefined);
    try {
      const source = await api<Source>("POST", "/api/sources", { url });
      setUrl("");
      setMessage({ kind: "ok", text: `Added “${source.title}” with ${source.itemCount} items (${source.unreadCount} unread).` });
      await load();
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err) });
    } finally {
      setAdding(false);
    }
  };

  const act = async (source: Source, action: "check" | "pause" | "resume" | "delete") => {
    if (action === "delete" && !confirm(`Stop following “${source.title}”? Its items, including saved ones, will be removed.`)) return;
    setBusy(source.id);
    setMessage(undefined);
    try {
      if (action === "check") {
        const res = await api<{ result: { ok: boolean; newItems: number; error?: string } }>("POST", `/api/sources/${source.id}/check`);
        setMessage(
          res.result.ok
            ? { kind: "ok", text: res.result.newItems ? `${res.result.newItems} new from “${source.title}”.` : `Nothing new from “${source.title}”.` }
            : { kind: "error", text: res.result.error ?? "Check failed" },
        );
      } else if (action === "delete") {
        await api("DELETE", `/api/sources/${source.id}`);
      } else {
        await api("PATCH", `/api/sources/${source.id}`, { enabled: action === "resume" });
      }
      await load();
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      <h1>Sources</h1>
      <section className="card">
        <h2>Add a source</h2>
        <form onSubmit={add} noValidate>
          <Field
            label="Address"
            name="url"
            value={url}
            onChange={setUrl}
            hint="A YouTube channel (link or @handle), a website, or an RSS/Atom feed address. Forum board RSS works too, e.g. …/forums/board-name.12/index.rss"
            autoComplete="url"
          />
          <button type="submit" disabled={adding || !url.trim()}>
            {adding ? "Adding…" : "Add"}
          </button>
        </form>
      </section>

      {message && <Alert kind={message.kind}>{message.text}</Alert>}

      {sources && sources.length === 0 && <p className="muted">No sources yet.</p>}

      <ul className="sources">
        {sources?.map((s) => (
          <li key={s.id} className="card source">
            <div className="source-head">
              <div>
                <span className={`kind kind-${s.kind}`}>{s.kind === "youtube" ? "YouTube" : "Feed"}</span>
                <strong className="source-title">{s.title}</strong>
              </div>
              <span className={`status status-${s.status}`}>{STATUS_LABEL[s.status]}</span>
            </div>
            <p className="muted small break">
              {s.siteUrl ? (
                <a href={s.siteUrl} target="_blank" rel="noopener noreferrer">
                  {s.siteUrl}
                </a>
              ) : (
                s.feedUrl
              )}
            </p>
            <p className="muted small">
              {s.unreadCount} unread · {s.itemCount} items
              {s.lastCheckedAt && (
                <>
                  {" "}· checked <span title={fullDate(s.lastCheckedAt)}>{relativeTime(s.lastCheckedAt)}</span>
                </>
              )}
              {s.nextCheckAt && s.enabled && (
                <>
                  {" "}· next <span title={fullDate(s.nextCheckAt)}>{relativeTime(s.nextCheckAt)}</span>
                </>
              )}
            </p>
            {s.lastError && <Alert kind={s.status === "paused" || s.status === "challenged" ? "error" : "info"}>{s.lastError}</Alert>}
            <div className="row">
              <button className="secondary" disabled={busy === s.id} onClick={() => void act(s, "check")}>
                {busy === s.id ? "Working…" : "Check now"}
              </button>
              {s.status === "paused" ? (
                <button className="secondary" disabled={busy === s.id} onClick={() => void act(s, "resume")}>
                  Resume
                </button>
              ) : (
                <button className="secondary" disabled={busy === s.id} onClick={() => void act(s, "pause")}>
                  Pause
                </button>
              )}
              <button className="secondary danger-text" disabled={busy === s.id} onClick={() => void act(s, "delete")}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
