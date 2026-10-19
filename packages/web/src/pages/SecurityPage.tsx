import { useEffect, useState, type FormEvent } from "react";
import type { AuthStatus, FlareSolverrStatus, TotpBeginResponse, YouTubeKeyStatus } from "@fa/shared";
import { api, errorMessage, fieldErrors } from "../api";
import { Alert, Field } from "../components";
import { AUTO_SPLIT_MIN_PX, SPLIT_MIN_PX, usePrefs, type ReaderLayout } from "../prefs";

export function SecurityPage({ status, onChange }: { status: AuthStatus; onChange: () => void }) {
  return (
    <>
      <h1>Settings</h1>
      <p className="muted">
        Signed in as <strong>{status.username}</strong>
        {status.via === "proxy" ? " through your SSO proxy" : ""}.
      </p>
      <ThisDevice />
      <YouTubeComments />
      <FlareSolverrSettings />
      {status.via === "session" && <ChangePassword />}
      <TwoFactor enabled={!!status.totpEnabled} onChange={onChange} />
    </>
  );
}

const LAYOUTS: Array<{ value: ReaderLayout; label: string; hint: string }> = [
  { value: "auto", label: "Automatic", hint: `List and reader side by side on wide screens (${AUTO_SPLIT_MIN_PX}px and up), full-screen reader otherwise.` },
  { value: "split", label: "Side by side", hint: `List on the left, reader on the right whenever the window is at least ${SPLIT_MIN_PX}px wide.` },
  { value: "full", label: "Full-screen reader", hint: "Items open over the list, as on a phone." },
];

/** Layout preferences stored in this browser only, so phone and desktop can differ. */
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
    </section>
  );
}

/** Optional FlareSolverr instance for forums behind a Cloudflare check (D-080). */
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

function TwoFactor({ enabled, onChange }: { enabled: boolean; onChange: () => void }) {
  const [enrol, setEnrol] = useState<TotpBeginResponse>();
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const digits = (v: string) => v.replace(/\D/g, "").slice(0, 6);

  const run = async (fn: () => Promise<void>) => {
    setError(undefined);
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
      {enabled ? (
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await api("POST", "/api/auth/totp/disable", { password, code }); setPassword(""); setCode(""); onChange(); }); }} noValidate>
          <p className="muted">On. Logging in asks for a code from your authenticator app.</p>
          <Field label="Password" name="password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
          <Field label="Current code" name="code" value={code} onChange={(v) => setCode(digits(v))} inputMode="numeric" autoComplete="one-time-code" />
          <button type="submit" className="danger">Turn off</button>
        </form>
      ) : enrol ? (
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await api("POST", "/api/auth/totp/enable", { code }); setEnrol(undefined); setCode(""); onChange(); }); }} noValidate>
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
