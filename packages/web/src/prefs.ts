// Per-device preferences, kept in this browser's localStorage (not on the server),
// so the phone and the desktop can each have their own layout (D-070).
import { useCallback, useEffect, useState } from "react";
import type { ItemsOrder } from "@fa/shared";

/** auto: list + reader side by side on wide screens; split: side by side whenever it fits; full: full-screen reader only. */
export type ReaderLayout = "auto" | "split" | "full";

export interface DevicePrefs {
  layout: ReaderLayout;
  order: ItemsOrder;
  /** Sources unticked in the feed's source list (D-077). Hidden rather than shown, so new sources appear. */
  hiddenSources: string[];
  /** Which page a forum thread opens on in the reader (D-088). */
  threadStart: "first" | "last";
  /** Podcast playback speed (D-093). */
  playbackRate: number;
  /** Light or dark, or the device's own setting (D-106). */
  theme: Theme;
}

export type Theme = "auto" | "light" | "dark";

/** Sets the page's theme: data-theme on <html>, read by styles.css. */
export function applyTheme(theme: Theme) {
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

/** Speeds offered by the podcast player. */
export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

const KEY = "fa.prefs";
const DEFAULTS: DevicePrefs = { layout: "auto", order: "newest", hiddenSources: [], threadStart: "first", playbackRate: 1, theme: "auto" };
const EVENT = "fa-prefs";

/** Width at which "auto" switches to side by side, and the narrowest width "split" is used at. */
export const AUTO_SPLIT_MIN_PX = 1100;
export const SPLIT_MIN_PX = 760;

export function readPrefs(): DevicePrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<DevicePrefs>;
    return {
      layout: raw.layout === "split" || raw.layout === "full" ? raw.layout : DEFAULTS.layout,
      order: raw.order === "oldest" ? "oldest" : DEFAULTS.order,
      hiddenSources: Array.isArray(raw.hiddenSources) ? raw.hiddenSources.filter((id): id is string => typeof id === "string") : [],
      threadStart: raw.threadStart === "last" ? "last" : "first",
      playbackRate: PLAYBACK_RATES.includes(raw.playbackRate as number) ? (raw.playbackRate as number) : DEFAULTS.playbackRate,
      theme: raw.theme === "light" || raw.theme === "dark" ? raw.theme : "auto",
    };
  } catch {
    // Private mode or blocked storage: fall back to defaults.
    return { ...DEFAULTS, hiddenSources: [] };
  }
}

export function usePrefs(): [DevicePrefs, (patch: Partial<DevicePrefs>) => void] {
  const [prefs, setPrefs] = useState(readPrefs);
  useEffect(() => {
    const sync = () => setPrefs(readPrefs());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync); // another tab changed them
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const update = useCallback((patch: Partial<DevicePrefs>) => {
    const next = { ...readPrefs(), ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Not saved, but still applied for this visit.
    }
    setPrefs(next);
    if (patch.theme) applyTheme(next.theme);
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [prefs, update];
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Whether the feed should show the reader beside the list right now. */
export function useSplitView(layout: ReaderLayout): boolean {
  const wide = useMediaQuery(`(min-width: ${AUTO_SPLIT_MIN_PX}px)`);
  const fits = useMediaQuery(`(min-width: ${SPLIT_MIN_PX}px)`);
  return layout === "split" ? fits : layout === "auto" ? wide : false;
}
