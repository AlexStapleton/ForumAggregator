import { useState, type FormEvent } from "react";
import type { AuthMode } from "@fa/shared";
import { ApiRequestError, api, errorMessage } from "../api";
import { Alert, AuthCard, Field } from "../components";

export function LoginPage({ authMode, onDone }: { authMode: AuthMode; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (authMode === "proxy") {
    return (
      <AuthCard title="Log in">
        <Alert kind="info">
          This app is set to use your single-sign-on proxy. Open it through the proxy's address to log in.
        </Alert>
      </AuthCard>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api("POST", "/api/auth/login", { username, password, ...(needsCode ? { totpCode } : {}) });
      onDone();
    } catch (err) {
      if (err instanceof ApiRequestError && err.body.error === "totp_required") {
        setNeedsCode(true);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Log in">
      <form onSubmit={submit} noValidate>
        {error && <Alert>{error}</Alert>}
        <Field label="Username" name="username" value={username} onChange={setUsername} autoComplete="username" autoFocus={!needsCode} />
        <Field label="Password" name="password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
        {needsCode && (
          <Field
            label="Authenticator code"
            name="totpCode"
            value={totpCode}
            onChange={(v) => setTotpCode(v.replace(/\D/g, "").slice(0, 6))}
            hint="The 6-digit code from your authenticator app"
            autoComplete="one-time-code"
            inputMode="numeric"
            autoFocus
          />
        )}
        <button type="submit" disabled={busy}>{busy ? "Logging in…" : "Log in"}</button>
      </form>
    </AuthCard>
  );
}
