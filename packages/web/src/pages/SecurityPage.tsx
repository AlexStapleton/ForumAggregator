import { useState, type FormEvent } from "react";
import type { AuthStatus, TotpBeginResponse } from "@fa/shared";
import { api, errorMessage, fieldErrors } from "../api";
import { Alert, Field } from "../components";

export function SecurityPage({ status, onChange }: { status: AuthStatus; onChange: () => void }) {
  return (
    <>
      <h1>Settings</h1>
      <p className="muted">
        Signed in as <strong>{status.username}</strong>
        {status.via === "proxy" ? " through your SSO proxy" : ""}.
      </p>
      {status.via === "session" && <ChangePassword />}
      <TwoFactor enabled={!!status.totpEnabled} onChange={onChange} />
    </>
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
