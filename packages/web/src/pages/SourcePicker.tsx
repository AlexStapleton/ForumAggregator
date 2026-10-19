// The feed's source filter: a checkbox per source, so any mix can be on or off (D-077).
// The choice is stored per device as the *unticked* sources, so a newly added source shows up.
import { useEffect, useId, useRef, useState } from "react";
import type { Source } from "@fa/shared";
import { KIND_LABEL } from "../kinds";

export function SourcePicker({ sources, hidden, onChange }: { sources: Source[]; hidden: string[]; onChange: (hidden: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // Close on a click outside or Esc. Esc stops here (document runs before window), so in the
  // side-by-side view it doesn't also close the open article.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const known = new Set(sources.map((s) => s.id));
  // Ignore hidden IDs of deleted sources when counting.
  const hiddenCount = hidden.filter((id) => known.has(id)).length;
  const shown = sources.length - hiddenCount;
  const label = hiddenCount === 0 ? "All sources" : shown === 0 ? "No sources" : `${shown} of ${sources.length} sources`;

  const toggle = (id: string, on: boolean) => onChange(on ? hidden.filter((h) => h !== id) : [...hidden.filter((h) => known.has(h)), id]);

  return (
    <div className="source-picker" ref={root}>
      <button
        type="button"
        className={`picker-button${hiddenCount ? " filtered" : ""}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{label}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="picker-panel card" id={panelId} role="group" aria-label="Sources to show">
          <div className="picker-actions">
            <button type="button" className="link" onClick={() => onChange([])} disabled={hiddenCount === 0}>
              Select all
            </button>
            <button type="button" className="link" onClick={() => onChange(sources.map((s) => s.id))} disabled={shown === 0}>
              Clear all
            </button>
          </div>
          <ul className="picker-list">
            {sources.map((s) => (
              <li key={s.id}>
                <label className="picker-row">
                  <input type="checkbox" checked={!hidden.includes(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} />
                  <span className={`kind kind-${s.kind}`}>{KIND_LABEL[s.kind]}</span>
                  <span className="picker-title">{s.title}</span>
                  {s.unreadCount > 0 && <span className="count">{s.unreadCount}</span>}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
