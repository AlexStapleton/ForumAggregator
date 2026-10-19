import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Source } from "@fa/shared";
import { api, errorMessage, fieldErrors } from "../api";
import { KIND_LABEL } from "../kinds";
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
  const [newTags, setNewTags] = useState("");
  const [editing, setEditing] = useState<string>();
  const [defaults, setDefaults] = useState<Defaults>({ intervalMinutes: 30, keepDays: 0 });
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
    api<{ polling: { intervalMinutes: number }; retention: { keepDays: number } }>("GET", "/api/config")
      .then((c) => setDefaults({ intervalMinutes: c.polling.intervalMinutes, keepDays: c.retention.keepDays }))
      .catch(() => undefined);
  }, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setAdding(true);
    setMessage(undefined);
    try {
      const source = await api<Source>("POST", "/api/sources", { url, tags: splitTags(newTags) });
      setUrl("");
      setNewTags("");
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
          <Field label="Tags (optional)" name="tags" value={newTags} onChange={setNewTags} hint="Comma-separated, e.g. news, politics" autoComplete="off" />
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
            {editing === s.id ? (
              <EditSource
                source={s}
                defaults={defaults}
                onCancel={() => setEditing(undefined)}
                onSaved={async (updated) => {
                  setEditing(undefined);
                  setMessage({ kind: "ok", text: `Saved “${updated.title}”.` });
                  await load();
                }}
              />
            ) : (
              <>
            <div className="source-head">
              <div>
                <span className={`kind kind-${s.kind}`}>{KIND_LABEL[s.kind]}</span>
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
            {s.tags.length > 0 && (
              <div className="tags">
                {s.tags.map((t) => (
                  <span key={t} className="tag">
                    #{t}
                  </span>
                ))}
              </div>
            )}
            {(s.retentionDays ?? defaults.keepDays) > 0 && (
              <p className="muted small">Keeps items for {s.retentionDays ?? defaults.keepDays} days (saved items are kept).</p>
            )}
            {s.lastError && <Alert kind={s.status === "paused" || s.status === "challenged" ? "error" : "info"}>{s.lastError}</Alert>}
            <div className="row">
              <button className="secondary" disabled={busy === s.id} onClick={() => setEditing(s.id)}>
                Edit
              </button>
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
              </>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function splitTags(text: string): string[] {
  return text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export interface Defaults {
  intervalMinutes: number;
  keepDays: number;
}

function minutesLabel(m: number): string {
  if (m % 1440 === 0) return m === 1440 ? "once a day" : `every ${m / 1440} days`;
  if (m % 60 === 0) return m === 60 ? "every hour" : `every ${m / 60} hours`;
  return `every ${m} minutes`;
}

const INTERVALS: Array<[number | null, string]> = [
  [15, "Every 15 minutes"],
  [30, "Every 30 minutes"],
  [60, "Every hour"],
  [180, "Every 3 hours"],
  [360, "Every 6 hours"],
  [720, "Every 12 hours"],
  [1440, "Once a day"],
];

const RETENTION: Array<[number | null, string]> = [
  [0, "Forever"],
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],
  [365, "1 year"],
];

function EditSource({
  source,
  defaults,
  onCancel,
  onSaved,
}: {
  source: Source;
  defaults: Defaults;
  onCancel: () => void;
  onSaved: (s: Source) => void;
}) {
  const [title, setTitle] = useState(source.title);
  const [address, setAddress] = useState(source.siteUrl ?? source.feedUrl);
  const [tags, setTags] = useState(source.tags.join(", "));
  const [pollInterval, setPollInterval] = useState<number | null>(source.pollIntervalMinutes);
  const [retention, setRetention] = useState<number | null>(source.retentionDays);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [fields, setFields] = useState<Record<string, string>>({});

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(undefined);
    setFields({});
    const patch: Record<string, unknown> = {
      title,
      tags: splitTags(tags),
      pollIntervalMinutes: pollInterval,
      retentionDays: retention,
    };
    const originalAddress = source.siteUrl ?? source.feedUrl;
    if (address.trim() !== originalAddress) patch.url = address.trim();
    const shrinking = retention !== null && retention > 0 && (source.retentionDays === null || source.retentionDays === 0 || retention < source.retentionDays);
    if (shrinking && !confirm(`Delete unsaved items older than ${retention} days from “${source.title}” now? Saved items are kept.`)) {
      setSaving(false);
      return;
    }
    try {
      onSaved(await api<Source>("PATCH", `/api/sources/${source.id}`, patch));
    } catch (err) {
      setError(errorMessage(err));
      setFields(fieldErrors(err));
    } finally {
      setSaving(false);
    }
  };

  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  return (
    <form onSubmit={save} noValidate className="edit-source" ref={formRef}>
      <h2>Edit source</h2>
      {error && <Alert>{error}</Alert>}
      <Field label="Name" name="title" value={title} onChange={setTitle} error={fields.title} />
      <Field
        label="Address"
        name="address"
        value={address}
        onChange={setAddress}
        error={fields.url}
        hint="Changing it re-checks the new address before saving. Existing items are kept."
        autoComplete="url"
      />
      <Field label="Tags" name="tags" value={tags} onChange={setTags} hint="Comma-separated. Changes apply to existing items too." autoComplete="off" />
      <div className="field">
        <label htmlFor="f-interval">Check for new items</label>
        <select id="f-interval" value={pollInterval ?? ""} onChange={(e) => setPollInterval(e.target.value === "" ? null : Number(e.target.value))}>
          <option value="">Default ({minutesLabel(defaults.intervalMinutes)})</option>
          {INTERVALS.map(([v, label]) => (
            <option key={label} value={v ?? ""}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="f-retention">Keep items for</label>
        <select id="f-retention" value={retention ?? ""} onChange={(e) => setRetention(e.target.value === "" ? null : Number(e.target.value))}>
          <option value="">Default ({defaults.keepDays ? `${defaults.keepDays} days` : "forever"})</option>
          {RETENTION.map(([v, label]) => (
            <option key={label} value={v ?? ""}>
              {label}
            </option>
          ))}
        </select>
        <small className="hint">Saved items are never deleted.</small>
      </div>
      <div className="row">
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
