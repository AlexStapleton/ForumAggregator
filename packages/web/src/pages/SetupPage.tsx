import { useState, type FormEvent } from "react";
import { PASSWORD_MIN_LENGTH } from "@fa/shared";
import { api, errorMessage, fieldErrors } from "../api";
import { Alert, AuthCard, Field } from "../components";

export function SetupPage({ onDone }: { onDone: () => void }) {
  const [setupCode, setSetupCode] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string>();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

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
      await api("POST", "/api/auth/setup", { setupCode, username, password });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setFields(fieldErrors(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Create your account">
      <p className="muted">
        This is the first run. Enter the setup code shown in the container log
        (<code>docker compose logs forumaggregator</code>) to prove you own this server.
      </p>
      <form onSubmit={submit} noValidate>
        {error && <Alert>{error}</Alert>}
        <Field label="Setup code" name="setupCode" value={setupCode} onChange={setSetupCode} error={fields.setupCode} autoComplete="off" autoFocus />
        <Field label="Username" name="username" value={username} onChange={setUsername} error={fields.username} autoComplete="username" />
        <Field
          label="Password"
          name="password"
          type="password"
          value={password}
          onChange={setPassword}
          error={fields.password}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. A passphrase works well.`}
          autoComplete="new-password"
        />
        <Field label="Confirm password" name="confirm" type="password" value={confirm} onChange={setConfirm} error={fields.confirm} autoComplete="new-password" />
        <button type="submit" disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
      </form>
    </AuthCard>
  );
}
