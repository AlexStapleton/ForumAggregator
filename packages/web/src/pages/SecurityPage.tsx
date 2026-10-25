import { useEffect, useState, type FormEvent } from "react";
import type { AccountView, AuthStatus, CheckingSettings, CheckingValues, ConnectionInfo, FlareSolverrStatus, InviteCreated, InviteView, SessionView, TotpBeginResponse, YouTubeKeyStatus } from "@fa/shared";
import { api, errorMessage, fieldErrors } from "../api";
import { Alert, Field } from "../components";
import { fullDate, relativeTime } from "../time";
import { AUTO_SPLIT_MIN_PX, SPLIT_MIN_PX, usePrefs, type ReaderLayout, type Theme } from "../prefs";

export function SecurityPage({ status, onChange }: { status: AuthStatus; onChange: () => void }) {
  // The server-wide settings and accounts are the admin's (D-114); everyone has their own login settings.
  const admin = status.role === "admin";
  return (
    <>
      <h1>Settings</h1>
      <p className="muted">
        Signed in as <strong>{status.username}</strong>
        {admin ? " (admin)" : ""}
        {status.via === "proxy" ? " through your SSO proxy" : ""}.
      </p>
      <ThisDevice />
      {admin && <Accounts proxyOnly={status.authMode === "proxy"} />}
      {admin && <Checking />}
      {admin && <YouTubeComments />}
      {admin && <FlareSolverrSettings />}
      {status.via === "session" && <ChangePassword />}
      <TwoFactor enabled={!!status.totpEnabled} onChange={onChange} />
      {status.via === "session" && <Devices connection={status.connection} />}
    </>
  );
}

/** A one-time link as a full address to send someone. */
const linkUrl = (kind: "invite" | "reset", token: string) => `${location.origin}${location.pathname}#/${kind}/${token}`;

/** Settings → Accounts (D-114): invite people, reset passwords, turn accounts off or delete them. */
function Accounts({ proxyOnly }: { proxyOnly: boolean }) {
  const [accounts, setAccounts] = useState<AccountView[]>();
  const [invites, setInvites] = useState<InviteView[]>([]);
  const [note, setNote] = useState("");
  const [created, setCreated] = useState<{ url: string; text: string }>();
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string }>();
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [a, i] = await Promise.all([api<AccountView[]>("GET", "/api/admin/accounts"), api<InviteView[]>("GET", "/api/admin/invites")]);
      setAccounts(a);
      setInvites(i);
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err) });
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage(undefined);
    try {
      await fn();
      await load();
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const invite = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<InviteCreated>("POST", "/api/admin/invites", { note: note.trim() || null });
      setNote("");
      setCreated({ url: linkUrl("invite", r.token), text: `Invitation link${r.invite.note ? ` for ${r.invite.note}` : ""}. Send it to them; it works once, for 7 days.` });
    });
  };
  const resetLink = (a: AccountView) =>
    run(async () => {
      const r = await api<InviteCreated>("POST", `/api/admin/accounts/${a.id}/reset-link`);
      setCreated({ url: linkUrl("reset", r.token), text: `Password reset link for ${a.username}. Send it to them; it works once, for 24 hours. Their current password keeps working until they use it.` });
    });

  return (
    <section className="card accounts">
      <h2>Accounts</h2>
      <p className="muted small">
        Each account has its own sources, tags, and read and saved items. A site several accounts follow is checked once for all of them. You see who has an
        account and how active it is, not what it follows or reads.
      </p>
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
      {created && (
        <div>
          <Alert kind="ok">{created.text}</Alert>
          <CopyBox value={created.url} />
        </div>
      )}
      {!accounts ? (
        <p className="muted">Loading…</p>
      ) : (
        <ul className="sessions">
          {accounts.map((a) => (
            <li key={a.id}>
              <div>
                <strong>{a.username}</strong>
                {a.you && <span className="badge">You</span>}
                {a.role === "admin" && <span className="badge">Admin</span>}
                {a.disabled && <span className="badge">Turned off</span>}
                {a.totpEnabled && <span className="badge">Two-factor</span>}
                <div className="muted small">
                  {a.sourceCount} source{a.sourceCount === 1 ? "" : "s"} · {a.lastSeenAt ? <>active <span title={fullDate(a.lastSeenAt)}>{relativeTime(a.lastSeenAt)}</span></> : "not signed in"} · joined{" "}
                  <span title={fullDate(a.createdAt)}>{relativeTime(a.createdAt)}</span>
                </div>
                {!a.you && (
                  <div className="actions">
                    {!proxyOnly && (
                      <button className="secondary" disabled={busy} onClick={() => void resetLink(a)}>
                        Password reset link
                      </button>
                    )}
                    {a.totpEnabled && (
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => {
                          if (confirm(`Turn off two-factor login for ${a.username}? Do this if they lost their phone; they can turn it on again in their settings.`)) {
                            void run(async () => {
                              await api("POST", `/api/admin/accounts/${a.id}/totp-off`);
                              setMessage({ kind: "ok", text: `Two-factor login is off for ${a.username}, and their devices were signed out.` });
                            });
                          }
                        }}
                      >
                        Turn off two-factor
                      </button>
                    )}
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api("PATCH", `/api/admin/accounts/${a.id}`, { disabled: !a.disabled });
                          setMessage({ kind: "ok", text: a.disabled ? `${a.username} can log in again.` : `${a.username} can't log in any more, and was signed out everywhere.` });
                        })
                      }
                    >
                      {a.disabled ? "Turn on" : "Turn off"}
                    </button>
                    <button
                      className="secondary danger-text"
                      disabled={busy}
                      onClick={() => {
                        if (confirm(`Delete the account ${a.username}? Its sources, tags and read and saved items are deleted too. This can't be undone.`)) {
                          void run(async () => {
                            await api("DELETE", `/api/admin/accounts/${a.id}`);
                            setMessage({ kind: "ok", text: `Deleted ${a.username}.` });
                          });
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={invite} noValidate>
        <Field
          label="Invite someone"
          name="note"
          value={note}
          onChange={setNote}
          hint={
            proxyOnly
              ? "Optional: who it's for. Logins go through your SSO proxy, so they must pick the same username as their SSO login (the password they set here isn't used)."
              : "Optional: who it's for, to tell links apart. They choose their own username."
          }
          autoComplete="off"
        />
        <div className="row">
          <button type="submit" disabled={busy}>
            Create invitation link
          </button>
        </div>
      </form>
      {invites.length > 0 && (
        <>
          <h3 className="small">Links not used yet</h3>
          <ul className="sessions">
            {invites.map((i) => (
              <li key={i.id}>
                <div>
                  <strong>{i.kind === "invite" ? `Invitation${i.note ? ` for ${i.note}` : ""}` : `Password reset for ${i.username}`}</strong>
                  <div className="muted small">
                    made <span title={fullDate(i.createdAt)}>{relativeTime(i.createdAt)}</span> · expires {new Date(i.expiresAt).toLocaleString()}
                  </div>
                </div>
                <button className="secondary" disabled={busy} onClick={() => void run(async () => void (await api("DELETE", `/api/admin/invites/${i.id}`)))}>
                  Cancel
                </button>
              </li>
            ))}
          </ul>
          <p className="muted small">A link is shown only when it's made. Lost one? Cancel it and make a new one.</p>
        </>
      )}
    </section>
  );
}

/** A link to copy, with a Copy button (which needs HTTPS; the text can always be selected). */
function CopyBox({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="link-box">
      <input readOnly value={value} aria-label="Link" onFocus={(e) => e.target.select()} />
      <button
        type="button"
        className="secondary"
        onClick={() =>
          void navigator.clipboard?.writeText(value).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

const LAYOUTS: Array<{ value: ReaderLayout; label: string; hint: string }> = [
  { value: "auto", label: "Automatic", hint: `List and reader side by side on wide screens (${AUTO_SPLIT_MIN_PX}px and up), full-screen reader otherwise.` },
  { value: "split", label: "Side by side", hint: `List on the left, reader on the right whenever the window is at least ${SPLIT_MIN_PX}px wide.` },
  { value: "full", label: "Full-screen reader", hint: "Items open over the list, as on a phone." },
];

/** Layout preferences stored in this browser only, so phone and desktop can differ. */
const THEMES: Array<{ value: Theme; label: string; hint: string }> = [
  { value: "auto", label: "Automatic", hint: "Follows this device's light or dark setting." },
  { value: "dark", label: "Dark", hint: "Always dark on this device." },
  { value: "light", label: "Light", hint: "Always light on this device." },
];

function ThisDevice() {
  const [prefs, setPrefs] = usePrefs();
  return (
    <section className="card">
      <h2>This device</h2>
      <p className="muted small">Saved in this browser only. Your other devices keep their own choice.</p>
      <fieldset className="choices">
        <legend>Reading layout</legend>
        {LAYOUTS.map((l) => (
          <label key={l.value} className="choice">
            <input type="radio" name="layout" value={l.value} checked={prefs.layout === l.value} onChange={() => setPrefs({ layout: l.value })} />
            <span>
              <strong>{l.label}</strong>
              <span className="muted small block">{l.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="choices">
        <legend>Appearance</legend>
        {THEMES.map((t) => (
          <label key={t.value} className="choice">
            <input type="radio" name="theme" value={t.value} checked={prefs.theme === t.value} onChange={() => setPrefs({ theme: t.value })} />
            <span>
              <strong>{t.label}</strong>
              <span className="muted small block">{t.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="choices">
        <legend>Forum threads open on</legend>
        {THREAD_STARTS.map((t) => (
          <label key={t.value} className="choice">
            <input type="radio" name="threadStart" value={t.value} checked={prefs.threadStart === t.value} onChange={() => setPrefs({ threadStart: t.value })} />
            <span>
              <strong>{t.label}</strong>
              <span className="muted small block">{t.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}

const THREAD_STARTS: Array<{ value: "first" | "last"; label: string; hint: string }> = [
  { value: "first", label: "First page", hint: "Start with the opening post, like reading the thread from the beginning." },
  { value: "last", label: "Last page", hint: "Start with the newest replies. Either way, the pager at the bottom moves between pages." },
];

/** Optional FlareSolverr instance for forums behind a Cloudflare check (D-080). */
const FEED_MINUTES = [15, 30, 60, 180, 360, 720, 1440];
const THREAD_MINUTES = [5, 10, 15, 30, 60, 180, 360, 720, 1440];
const THREAD_PAGES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** Just the three values (the server refuses unknown fields, like the defaults). */
const valuesOf = (c: CheckingValues): CheckingValues => ({ intervalMinutes: c.intervalMinutes, threadIntervalMinutes: c.threadIntervalMinutes, threadPagesPerCheck: c.threadPagesPerCheck });

function minutesText(m: number): string {
  if (m === 1440) return "Once a day";
  if (m % 60 === 0) return m === 60 ? "Every hour" : `Every ${m / 60} hours`;
  return `Every ${m} minutes`;
}

/** Settings → Checking (D-095): how often sources are checked, for the whole app (stored on the server). */
function Checking() {
  const [saved, setSaved] = useState<CheckingSettings>();
  const [form, setForm] = useState<CheckingValues>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string }>();

  useEffect(() => {
    api<CheckingSettings>("GET", "/api/settings/checking").then(
      (c) => {
        setSaved(c);
        setForm(valuesOf(c));
      },
      (err) => setMessage({ kind: "error", text: errorMessage(err) }),
    );
  }, []);
  if (!saved || !form) {
    return (
      <section className="card">
        <h2>Checking</h2>
        {message ? <Alert kind={message.kind}>{message.text}</Alert> : <p className="muted">Loading…</p>}
      </section>
    );
  }

  const choice = (field: keyof CheckingValues, values: number[], label: (n: number) => string) => {
    // A value from config.yaml that isn't in the list still shows.
    const all = [...new Set([...values, form[field], saved.defaults[field]])].sort((a, b) => a - b);
    return (
      <select id={`c-${field}`} aria-describedby={field === "threadPagesPerCheck" ? "c-pages-hint" : undefined} value={form[field]} onChange={(e) => setForm({ ...form, [field]: Number(e.target.value) })}>
        {all.map((n) => (
          <option key={n} value={n}>
            {label(n)}
            {n === saved.defaults[field] ? " (default)" : ""}
          </option>
        ))}
      </select>
    );
  };
  const changed = (Object.keys(form) as Array<keyof CheckingValues>).some((k) => form[k] !== saved[k]);

  const save = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const c = await api<CheckingSettings>("PUT", "/api/settings/checking", form);
      setSaved(c);
      setForm(valuesOf(c));
      setMessage({ kind: "ok", text: "Saved. Shorter intervals apply now; longer ones from each source's next check." });
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Checking</h2>
      <p className="muted">How often the app looks for new items. A source with its own interval (Sources → Edit) keeps it.</p>
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="field">
          <label htmlFor="c-intervalMinutes">Feeds, boards, channels and subreddits</label>
          {choice("intervalMinutes", FEED_MINUTES, minutesText)}
        </div>
        <div className="field">
          <label htmlFor="c-threadIntervalMinutes">Followed forum threads</label>
          {choice("threadIntervalMinutes", THREAD_MINUTES, minutesText)}
        </div>
        <div className="field">
          <label htmlFor="c-threadPagesPerCheck">Thread pages read per check</label>
          {choice("threadPagesPerCheck", THREAD_PAGES, (n) => (n === 1 ? "1 page (the newest)" : `Up to ${n} pages`))}
          <small id="c-pages-hint" className="hint">
            The newest page, plus earlier ones only while a whole page of replies is new (a busy thread). Each page is one request to the
            forum, through FlareSolverr if the source uses it.
          </small>
        </div>
        <div className="row">
          <button type="submit" disabled={busy || !changed}>
            {busy ? "Saving…" : "Save"}
          </button>
          {changed && (
            <button type="button" className="secondary" disabled={busy} onClick={() => setForm(valuesOf(saved))}>
              Undo changes
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function FlareSolverrSettings() {
  const [status, setStatus] = useState<FlareSolverrStatus>();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string }>();
  const [fields, setFields] = useState<Record<string, string>>({});

  useEffect(() => {
    api<FlareSolverrStatus>("GET", "/api/settings/flaresolverr").then(
      (s) => {
        setStatus(s);
        setUrl(s.url ?? "");
      },
      (err) => setMessage({ kind: "error", text: errorMessage(err) }),
    );
  }, []);

  const save = async (value: string | null) => {
    setBusy(true);
    setMessage(undefined);
    setFields({});
    try {
      const s = await api<FlareSolverrStatus>("PUT", "/api/settings/flaresolverr", { url: value });
      setStatus(s);
      setUrl(s.url ?? "");
      setMessage({ kind: "ok", text: value ? `Connected to FlareSolverr ${s.version ?? ""}. Sites behind a Cloudflare check now go through it.` : "FlareSolverr removed." });
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err) });
      setFields(fieldErrors(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>FlareSolverr</h2>
      <p className="muted">
        {status?.url ? (
          <>On: <code>{status.url}</code>{status.version ? ` (version ${status.version})` : ""}.</>
        ) : (
          "Off. For forums behind a Cloudflare check: the app asks your FlareSolverr to open the page, then reuses its pass."
        )}
      </p>
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
      <form onSubmit={(e) => { e.preventDefault(); void save(url.trim()); }} noValidate>
        <Field
          label="Address"
          name="url"
          value={url}
          onChange={setUrl}
          error={fields.url}
          hint="e.g. http://192.168.1.50:8191, or http://flaresolverr:8191 on the same Docker network. Checked before saving."
          autoComplete="off"
        />
        <div className="row">
          <button type="submit" disabled={busy || !url.trim()}>
            {busy ? "Checking…" : "Save and test"}
          </button>
          {status?.url && (
            <button type="button" className="secondary danger-text" disabled={busy} onClick={() => void save(null)}>
              Remove
            </button>
          )}
        </div>
      </form>
      <p className="muted small">
        Only sources marked "Fetch through FlareSolverr" use it. Adding a site that answers with a Cloudflare check turns it on for that
        source by itself.
      </p>
    </section>
  );
}

/** Optional YouTube Data API key for top comments in the reader (D-075). */
function YouTubeComments() {
  const [status, setStatus] = useState<YouTubeKeyStatus>();
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string }>();
  const [fields, setFields] = useState<Record<string, string>>({});

  useEffect(() => {
    api<YouTubeKeyStatus>("GET", "/api/settings/youtube").then(setStatus, (err) => setMessage({ kind: "error", text: errorMessage(err) }));
  }, []);

  const save = async (key: string | null) => {
    setBusy(true);
    setMessage(undefined);
    setFields({});
    try {
      setStatus(await api<YouTubeKeyStatus>("PUT", "/api/settings/youtube", { apiKey: key }));
      setApiKey("");
      setMessage({ kind: "ok", text: key ? "Key checked and saved. Open a YouTube video to see its top comments." : "Key removed." });
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err) });
      setFields(fieldErrors(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>YouTube comments</h2>
      <p className="muted">
        {status?.configured ? (
          <>On. Using the key ending <code>{status.keyHint}</code>.</>
        ) : (
          "Off. YouTube has no comments feed, so showing top comments under videos needs your own (free) YouTube Data API key."
        )}
      </p>
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
      <form onSubmit={(e) => { e.preventDefault(); void save(apiKey.trim()); }} noValidate>
        <Field
          label={status?.configured ? "Replace the key" : "API key"}
          name="apiKey"
          type="password"
          value={apiKey}
          onChange={setApiKey}
          error={fields.apiKey}
          hint="Checked with one request before it's saved. Stored encrypted; it never leaves this server."
          autoComplete="off"
        />
        <div className="row">
          <button type="submit" disabled={busy || !apiKey.trim()}>
            {busy ? "Checking…" : "Save key"}
          </button>
          {status?.configured && (
            <button type="button" className="secondary danger-text" disabled={busy} onClick={() => void save(null)}>
              Remove key
            </button>
          )}
        </div>
      </form>
      <details className="help">
        <summary>How to get a key (about 5 minutes)</summary>
        <ol className="small">
          <li>Open the <a href="https://console.cloud.google.com/" target="_blank" rel="noopener noreferrer">Google Cloud console</a> and create a project (any name).</li>
          <li>APIs &amp; Services → Library → <strong>YouTube Data API v3</strong> → Enable.</li>
          <li>APIs &amp; Services → Credentials → Create credentials → <strong>API key</strong>.</li>
          <li>Edit the key: under API restrictions choose <strong>Restrict key</strong> → YouTube Data API v3. Leave application restrictions on None (or IP addresses: your server's public IP).</li>
          <li>Paste the key above.</li>
        </ol>
        <p className="muted small">
          Free: 10,000 units a day; each video's comments use 1 unit and are kept for 15 minutes. No billing account is needed.
        </p>
      </details>
    </section>
  );
}

function ChangePassword() {
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string }>();
  const [fields, setFields] = useState<Record<string, string>>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(undefined);
    setFields({});
    try {
      await api("POST", "/api/auth/password", { currentPassword, newPassword });
      setCurrent("");
      setNew("");
      setMessage({ kind: "ok", text: "Password changed. Your other devices have been signed out." });
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err) });
      setFields(fieldErrors(err));
    }
  };

  return (
    <section className="card">
      <h2>Password</h2>
      <form onSubmit={submit} noValidate>
        {message && <Alert kind={message.kind}>{message.text}</Alert>}
        <Field label="Current password" name="currentPassword" type="password" value={currentPassword} onChange={setCurrent} autoComplete="current-password" />
        <Field label="New password" name="newPassword" type="password" value={newPassword} onChange={setNew} error={fields.newPassword} autoComplete="new-password" />
        <button type="submit">Change password</button>
      </form>
    </section>
  );
}

/** "Chrome on Android", "Firefox on Windows", … from a User-Agent; good enough to recognise a device. */
function deviceName(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /curl|node|python/i.test(ua) ? "Script" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : null;
  return os ? `${browser} on ${os}` : browser;
}

const PROXY_TEXT: Record<ConnectionInfo["proxy"], string> = {
  "through-trusted-proxy": "through your reverse proxy",
  direct: "directly (no reverse proxy)",
  "untrusted-proxy": "through a proxy the app doesn't trust",
};

/** Signed-in devices, and what the app sees of this connection (D-110). */
function Devices({ connection }: { connection?: ConnectionInfo }) {
  const [sessions, setSessions] = useState<SessionView[]>();
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string }>();
  const load = () => api<SessionView[]>("GET", "/api/auth/sessions").then(setSessions, (err) => setMessage({ kind: "error", text: errorMessage(err) }));
  useEffect(() => {
    void load();
  }, []);
  const end = async (s: SessionView) => {
    try {
      await api("DELETE", `/api/auth/sessions/${s.id}`);
      if (s.current) location.reload();
      else await load();
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err) });
    }
  };
  const others = sessions?.filter((s) => !s.current).length ?? 0;

  return (
    <section className="card">
      <h2>Signed-in devices</h2>
      {connection && (
        <p className="muted small">
          This connection: {connection.https ? "HTTPS" : "plain HTTP"}, from <code>{connection.ip}</code>, {PROXY_TEXT[connection.proxy]}
          {connection.https && connection.secureCookie ? "; login cookie marked Secure." : "."}
          {connection.proxy === "untrusted-proxy" && (
            <> The proxy's own address isn't in <code>TRUST_PROXY</code>, so the app can't see your real address or that you're on HTTPS. See DEPLOY.md §3.</>
          )}
        </p>
      )}
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
      {!sessions ? (
        <p className="muted">Loading…</p>
      ) : (
        <ul className="sessions">
          {sessions.map((s) => (
            <li key={s.id}>
              <div>
                <strong>{deviceName(s.userAgent)}</strong>
                {s.current && <span className="badge">This device</span>}
                <div className="muted small">
                  {s.ip ?? "unknown address"} · active <span title={fullDate(s.lastSeenAt)}>{relativeTime(s.lastSeenAt)}</span> · signed in{" "}
                  <span title={fullDate(s.createdAt)}>{relativeTime(s.createdAt)}</span>
                </div>
              </div>
              <button className="secondary" onClick={() => void end(s)}>
                Sign out
              </button>
            </li>
          ))}
        </ul>
      )}
      {others > 0 && (
        <button
          className="secondary danger-text"
          onClick={() =>
            void api<{ signedOut: number }>("POST", "/api/auth/sessions/sign-out-others").then(
              (r) => {
                setMessage({ kind: "ok", text: `Signed out ${r.signedOut} other device${r.signedOut === 1 ? "" : "s"}.` });
                void load();
              },
              (err) => setMessage({ kind: "error", text: errorMessage(err) }),
            )
          }
        >
          Sign out everywhere else
        </button>
      )}
      <p className="muted small">
        By default each device stays signed in for 30 days after it was last used, and must log in again (with a code, if two-factor is on) at least every
        90 days.
      </p>
    </section>
  );
}

function TwoFactor({ enabled, onChange }: { enabled: boolean; onChange: () => void }) {
  const [enrol, setEnrol] = useState<TotpBeginResponse>();
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const digits = (v: string) => v.replace(/\D/g, "").slice(0, 6);

  const run = async (fn: () => Promise<void>) => {
    setError(undefined);
    setDone(undefined);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <section className="card">
      <h2>Two-factor login</h2>
      {error && <Alert>{error}</Alert>}
      {done && <Alert kind="ok">{done}</Alert>}
      {enabled ? (
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await api("POST", "/api/auth/totp/disable", { password, code }); setPassword(""); setCode(""); setDone("Two-factor login is off. Your other devices were signed out."); onChange(); }); }} noValidate>
          <p className="muted">On. Logging in asks for a code from your authenticator app.</p>
          <Field label="Password" name="password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
          <Field label="Current code" name="code" value={code} onChange={(v) => setCode(digits(v))} inputMode="numeric" autoComplete="one-time-code" />
          <button type="submit" className="danger">Turn off</button>
        </form>
      ) : enrol ? (
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await api("POST", "/api/auth/totp/enable", { code }); setEnrol(undefined); setCode(""); setDone("Two-factor login is on. Your other devices were signed out: log in there again with a code."); onChange(); }); }} noValidate>
          <p className="muted">Scan this with an authenticator app (Aegis, Google Authenticator, 1Password…), then enter the code it shows.</p>
          <img className="qr" src={enrol.qrDataUrl} alt="QR code for your authenticator app" width={240} height={240} />
          <p className="muted small">Can't scan? Enter this key manually: <code className="break">{enrol.secret}</code></p>
          <Field label="Code from the app" name="code" value={code} onChange={(v) => setCode(digits(v))} inputMode="numeric" autoComplete="one-time-code" autoFocus />
          <div className="row">
            <button type="submit">Turn on</button>
            <button type="button" className="secondary" onClick={() => setEnrol(undefined)}>Cancel</button>
          </div>
        </form>
      ) : (
        <>
          <p className="muted">Off. Recommended, since this app is reachable from the internet.</p>
          <button onClick={() => void run(async () => setEnrol(await api<TotpBeginResponse>("POST", "/api/auth/totp/begin")))}>
            Set up
          </button>
        </>
      )}
    </section>
  );
}
