// An invitation or password-reset link (D-114): #/invite/<token> or #/reset/<token>. The token
// stays after "#", so it never reaches a server log; it's sent once, in a POST body.
import { useEffect, useState, type FormEvent } from "react";
import { PASSWORD_MIN_LENGTH, type InviteLinkInfo } from "@fa/shared";
import { api, errorMessage, fieldErrors } from "../api";
import { Alert, AuthCard, Field } from "../components";

export function linkFromHash(hash: string): { kind: "invite" | "reset"; token: string } | null {
  const m = /^#\/(invite|reset)\/([A-Za-z0-9_-]{20,100})$/.exec(hash);
  return m ? { kind: m[1] as "invite" | "reset", token: m[2]! } : null;
}

export function LinkPage({ token, onDone }: { token: string; onDone: () => void }) {
  const [info, setInfo] = useState<InviteLinkInfo>();
  const [loadError, setLoadError] = useState<string>();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string>();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [resetDone, setResetDone] = useState(false);

  useEffect(() => {
    api<InviteLinkInfo>("POST", "/api/auth/link", { token }).then(setInfo, (err) => setLoadError(errorMessage(err)));
  }, [token]);

  const leave = () => {
    history.replaceState(null, "", location.pathname);
    onDone();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setFields({ confirm: "Passwords don't match" });
      return;
    }
    setBusy(true);
    setError(undefined);
    setFields({});
    try {
      if (info?.kind === "invite") {
        await api("POST", "/api/auth/invite/accept", { token, username, password });
        leave();
      } else {
        await api("POST", "/api/auth/reset", { token, password });
        setResetDone(true);
      }
    } catch (err) {
      setError(errorMessage(err));
      setFields(fieldErrors(err));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <AuthCard title="Link not valid">
        <Alert>{loadError}</Alert>
        <button className="secondary" onClick={leave}>
          Go to the login page
        </button>
      </AuthCard>
    );
  }
  if (!info) return <main className="auth-page" aria-busy="true" />;
  if (resetDone) {
    return (
      <AuthCard title="Password changed">
        <Alert kind="ok">Your new password is set, and every device that was signed in has been signed out.</Alert>
        <button onClick={leave}>Log in</button>
      </AuthCard>
    );
  }

  const invite = info.kind === "invite";
  return (
    <AuthCard title={invite ? "Create your account" : `New password for ${info.username}`}>
      <p className="muted">
        {invite
          ? "You've been invited to this ForumAggregator. Pick a username and password; the sources you add are yours alone."
          : "Choose a new password. Two-factor login, if it's on, stays on."}{" "}
        This link works once, until {new Date(info.expiresAt).toLocaleString()}.
      </p>
      <form onSubmit={submit} noValidate>
        {error && <Alert>{error}</Alert>}
        {invite && <Field label="Username" name="username" value={username} onChange={setUsername} error={fields.username} hint="3–32 characters: letters, digits, _ . -" autoComplete="username" autoFocus />}
        {/* Lets a password manager save the new password under the right name. */}
        {!invite && <Field label="Username" name="username" value={info.username ?? ""} onChange={() => undefined} autoComplete="username" readOnly />}
        <Field
          label={invite ? "Password" : "New password"}
          name="password"
          type="password"
          value={password}
          onChange={setPassword}
          error={fields.password}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. A passphrase works well.`}
          autoComplete="new-password"
          autoFocus={!invite}
        />
        <Field label="Confirm password" name="confirm" type="password" value={confirm} onChange={setConfirm} error={fields.confirm} autoComplete="new-password" />
        <button type="submit" disabled={busy}>{busy ? "Saving…" : invite ? "Create account" : "Set password"}</button>
      </form>
    </AuthCard>
  );
}
