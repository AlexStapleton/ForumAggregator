// Podcast episodes in the reader (D-093): a speed choice kept per device, and the place you
// stopped kept per episode on this device. The controls are our own, not the browser's (D-113):
// some phone browsers draw their built-in ones with dark icons on no background, which vanish on
// a dark page.
import { useEffect, useRef, useState } from "react";
import type { ItemAudio } from "@fa/shared";
import { PLAYBACK_RATES, usePrefs } from "./prefs";
import { clockLabel } from "./time";

const POSITIONS_KEY = "fa.audioPositions";
/** Episodes whose place is remembered; the oldest are forgotten first. */
const POSITIONS_KEPT = 200;
/** Don't offer to resume within the first or last few seconds. */
const EDGE_SECONDS = 10;
const BACK_SECONDS = 15;
const FORWARD_SECONDS = 30;

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
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState<number | null>(audio.durationSeconds);
  const lastSaved = useRef(0);

  useEffect(() => {
    if (ref.current) ref.current.playbackRate = prefs.playbackRate;
  }, [prefs.playbackRate]);

  // Back to where this episode was left, once its length is known.
  const onLoadedMetadata = () => {
    const el = ref.current;
    if (!el) return;
    el.playbackRate = prefs.playbackRate;
    if (Number.isFinite(el.duration) && el.duration > 0) setDuration(el.duration);
    const saved = readPositions()[itemId]?.seconds;
    if (saved && saved > EDGE_SECONDS && (!Number.isFinite(el.duration) || saved < el.duration - EDGE_SECONDS)) {
      el.currentTime = saved;
      setPosition(saved);
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
  const seek = (seconds: number) => {
    const el = ref.current;
    if (!el) return;
    const end = duration ?? Infinity;
    el.currentTime = Math.max(0, Math.min(seconds, end));
    setPosition(el.currentTime);
  };
  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) {
      setFailed(false);
      el.play().catch((err: unknown) => {
        // AbortError: paused again before it started; not a failure.
        if (!(err instanceof DOMException && err.name === "AbortError")) setFailed(true);
      });
    } else el.pause();
  };

  return (
    <div className="audio">
      <audio
        ref={ref}
        preload="metadata"
        src={audio.url}
        onLoadedMetadata={onLoadedMetadata}
        onDurationChange={() => {
          const d = ref.current?.duration;
          if (d && Number.isFinite(d)) setDuration(d);
        }}
        onTimeUpdate={() => {
          setPosition(ref.current?.currentTime ?? 0);
          remember();
        }}
        onPlay={() => setPlaying(true)}
        onPlaying={() => setWaiting(false)}
        onWaiting={() => setWaiting(true)}
        onPause={() => {
          setPlaying(false);
          setWaiting(false);
          remember(true);
        }}
        onEnded={() => {
          setPlaying(false);
          writePosition(itemId, null);
        }}
        onError={() => {
          setPlaying(false);
          setWaiting(false);
          setFailed(true);
        }}
      />
      <div className="audio-main">
        <button className="audio-play" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button className="secondary audio-skip" onClick={() => seek(position - BACK_SECONDS)} aria-label={`Back ${BACK_SECONDS} seconds`}>
          −{BACK_SECONDS}
        </button>
        <button className="secondary audio-skip" onClick={() => seek(position + FORWARD_SECONDS)} aria-label={`Forward ${FORWARD_SECONDS} seconds`}>
          +{FORWARD_SECONDS}
        </button>
        <span className="audio-time small">
          {clockLabel(position)}
          {duration ? ` / ${clockLabel(duration)}` : ""}
          {waiting && playing ? " · Loading…" : ""}
        </span>
      </div>
      <input
        type="range"
        className="audio-seek"
        aria-label="Position"
        min={0}
        max={duration ? Math.floor(duration) : 0}
        step={1}
        value={Math.floor(position)}
        disabled={!duration}
        onChange={(e) => seek(Number(e.target.value))}
      />
      {failed && (
        <p className="small audio-error">
          This episode wouldn't play here.{" "}
          <a href={audio.url} target="_blank" rel="noopener noreferrer">
            Open the audio file
          </a>
        </p>
      )}
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
                seek(0);
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

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor">
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
    </svg>
  );
}
