// Podcast episodes in the reader (D-093): the browser's own audio player, a speed choice kept
// per device, and the place you stopped kept per episode on this device.
import { useEffect, useRef, useState } from "react";
import type { ItemAudio } from "@fa/shared";
import { PLAYBACK_RATES, usePrefs } from "./prefs";
import { clockLabel } from "./time";

const POSITIONS_KEY = "fa.audioPositions";
/** Episodes whose place is remembered; the oldest are forgotten first. */
const POSITIONS_KEPT = 200;
/** Don't offer to resume within the first or last few seconds. */
const EDGE_SECONDS = 10;

type Positions = Record<string, { at: number; seconds: number }>;

function readPositions(): Positions {
  try {
    const raw = JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? "{}") as unknown;
    return raw && typeof raw === "object" ? (raw as Positions) : {};
  } catch {
    return {};
  }
}

function writePosition(itemId: string, seconds: number | null) {
  const all = readPositions();
  if (seconds === null) delete all[itemId];
  else all[itemId] = { at: Date.now(), seconds: Math.floor(seconds) };
  const kept = Object.entries(all)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, POSITIONS_KEPT);
  try {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage blocked: the place just isn't remembered.
  }
}

export function AudioPlayer({ itemId, audio }: { itemId: string; audio: ItemAudio }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [prefs, setPrefs] = usePrefs();
  const [resumedAt, setResumedAt] = useState<number | null>(null);
  const lastSaved = useRef(0);

  useEffect(() => {
    if (ref.current) ref.current.playbackRate = prefs.playbackRate;
  }, [prefs.playbackRate]);

  // Back to where this episode was left, once its length is known.
  const onLoadedMetadata = () => {
    const el = ref.current;
    if (!el) return;
    el.playbackRate = prefs.playbackRate;
    const saved = readPositions()[itemId]?.seconds;
    if (saved && saved > EDGE_SECONDS && (!Number.isFinite(el.duration) || saved < el.duration - EDGE_SECONDS)) {
      el.currentTime = saved;
      setResumedAt(saved);
    }
  };
  const remember = (force = false) => {
    const el = ref.current;
    if (!el || el.currentTime < 1) return;
    if (!force && Math.abs(el.currentTime - lastSaved.current) < 5) return;
    lastSaved.current = el.currentTime;
    writePosition(itemId, el.currentTime);
  };

  return (
    <div className="audio">
      <audio
        ref={ref}
        controls
        preload="metadata"
        src={audio.url}
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={() => remember()}
        onPause={() => remember(true)}
        onEnded={() => writePosition(itemId, null)}
      >
        <a href={audio.url} target="_blank" rel="noopener noreferrer">
          Download the episode
        </a>
      </audio>
      <div className="audio-controls">
        <div className="audio-speeds" role="group" aria-label="Playback speed">
          {PLAYBACK_RATES.map((r) => (
            <button key={r} className={r === prefs.playbackRate ? "" : "secondary"} aria-pressed={r === prefs.playbackRate} onClick={() => setPrefs({ playbackRate: r })}>
              {r}×
            </button>
          ))}
        </div>
        {resumedAt !== null && (
          <span className="small muted">
            Resumed at {clockLabel(resumedAt)} ·{" "}
            <button
              className="link"
              onClick={() => {
                if (ref.current) ref.current.currentTime = 0;
                writePosition(itemId, null);
                setResumedAt(null);
              }}
            >
              Start over
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
