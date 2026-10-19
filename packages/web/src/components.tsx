import { useId, type ReactNode } from "react";

export function Field(props: {
  label: string;
  name: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
  autoComplete?: string;
  inputMode?: "numeric" | "text";
  autoFocus?: boolean;
  readOnly?: boolean;
}) {
  // useId: unique even when two forms on a page have a field with the same name.
  const id = `f-${props.name}-${useId().replace(/:/g, "")}`;
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        name={props.name}
        type={props.type ?? "text"}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        autoComplete={props.autoComplete}
        inputMode={props.inputMode}
        autoFocus={props.autoFocus}
        readOnly={props.readOnly}
        aria-invalid={!!props.error}
        aria-describedby={props.error || props.hint ? `${id}-msg` : undefined}
      />
      {(props.error || props.hint) && (
        <small id={`${id}-msg`} className={props.error ? "error" : "hint"}>
          {props.error ?? props.hint}
        </small>
      )}
    </div>
  );
}

export function Alert({ kind = "error", children }: { kind?: "error" | "ok" | "info"; children: ReactNode }) {
  return (
    <div className={`alert alert-${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="auth-page">
      <div className="card auth-card">
        <div className="brand">
          <img src="/icon.svg" alt="" width={32} height={32} />
          <span>ForumAggregator</span>
        </div>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}
