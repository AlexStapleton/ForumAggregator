// Reddit video and gallery posts in the reader (D-117). The reader gets a hint (video or
// gallery, and the feed's preview picture); this asks the server for the details and shows the
// player or the pictures. Reddit's videos are an HLS stream: Safari and Android play it
// themselves; elsewhere hls.js (served from this app, loaded only here) feeds it to the player.
import { useEffect, useRef, useState } from "react";
import type { RedditMedia, RedditMediaHint } from "@fa/shared";
import { api, errorMessage } from "./api";
import { PLAYBACK_RATES, usePrefs } from "./prefs";

export function RedditMediaView({ itemId, hint, postUrl }: { itemId: string; hint: RedditMediaHint; postUrl: string | null }) {
  const [media, setMedia] = useState<RedditMedia>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    api<RedditMedia>("GET", `/api/items/${itemId}/media`).then(
      (m) => live && setMedia(m),
      (err) => live && setError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [itemId]);

  if (error) return <Unplayable poster={hint.poster} postUrl={postUrl} reason={error} />;
  if (!media) return hint.poster ? <img className="reddit-poster" src={hint.poster} alt="" referrerPolicy="no-referrer" /> : <p className="muted">Loading…</p>;
  if (media.kind === "video") return <RedditVideo key={itemId} media={media} postUrl={postUrl} />;
  return <Gallery media={media} postUrl={postUrl} />;
}

/** The preview picture and a link to Reddit, with why it can't be shown here. */
function Unplayable({ poster, postUrl, reason }: { poster: string | null; postUrl: string | null; reason: string }) {
  return (
    <div className="reddit-media">
      {poster && <img className="reddit-poster" src={poster} alt="" referrerPolicy="no-referrer" />}
      <p className="muted small">
        {reason}{" "}
        {postUrl && (
          <a href={postUrl} target="_blank" rel="noopener noreferrer">
            Open on Reddit ↗
          </a>
        )}
      </p>
    </div>
  );
}

type HlsInstance = { destroy(): void };

function RedditVideo({ media, postUrl }: { media: Extract<RedditMedia, { kind: "video" }>; postUrl: string | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [prefs, setPrefs] = usePrefs();
  const [failed, setFailed] = useState<string>();
  const [silent, setSilent] = useState(false);

  useEffect(() => {
    if (ref.current) ref.current.playbackRate = prefs.videoRate;
  }, [prefs.videoRate]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let hls: HlsInstance | undefined;
    let done = false;
    // The stream didn't load: the mp4 without sound, if Reddit gave one; else say so.
    const fallBack = (why: string) => {
      if (done) return;
      done = true;
      hls?.destroy();
      if (media.mp4Url) {
        setSilent(true);
        video.src = media.mp4Url;
      } else {
        setFailed(why);
      }
    };
    const onError = () => fallBack("The video didn't load.");
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.addEventListener("error", onError, { once: true });
      video.src = media.hlsUrl;
    } else {
      void import("hls.js/light").then(
        ({ default: Hls }) => {
          if (done) return;
          if (!Hls.isSupported()) return fallBack("This browser can't play Reddit's videos.");
          // No worker: the page's security policy allows scripts from this app only.
          const h = new Hls({ enableWorker: false, capLevelToPlayerSize: true });
          hls = h;
          h.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal) fallBack(`The video didn't load (${data.details}).`);
          });
          h.loadSource(media.hlsUrl);
          h.attachMedia(video);
        },
        () => fallBack("The video player didn't load."),
      );
    }
    return () => {
      done = true;
      video.removeEventListener("error", onError);
      hls?.destroy();
    };
  }, [media]);

  if (failed) return <Unplayable poster={media.poster} postUrl={postUrl} reason={failed} />;
  const ratio = media.width && media.height ? `${media.width} / ${media.height}` : undefined;
  return (
    <div className="reddit-media">
      <video
        ref={ref}
        className="reddit-video"
        style={ratio ? { aspectRatio: ratio } : undefined}
        controls
        playsInline
        preload="metadata"
        poster={media.poster ?? undefined}
        onLoadedMetadata={() => {
          if (ref.current) ref.current.playbackRate = prefs.videoRate;
        }}
      />
      {silent && <p className="muted small">Playing without sound: Reddit's stream didn't load, and Reddit keeps the sound separately.</p>}
      <div className="audio-speeds" role="group" aria-label="Playback speed">
        {PLAYBACK_RATES.map((r) => (
          <button key={r} className={r === prefs.videoRate ? "" : "secondary"} aria-pressed={r === prefs.videoRate} onClick={() => setPrefs({ videoRate: r })}>
            {r}×
          </button>
        ))}
      </div>
    </div>
  );
}

function Gallery({ media, postUrl }: { media: Extract<RedditMedia, { kind: "gallery" }>; postUrl: string | null }) {
  const strip = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);
  const count = media.images.length;
  const go = (i: number) => {
    const el = strip.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
  };
  // Which picture is showing, as the strip is swiped.
  const onScroll = () => {
    const el = strip.current;
    if (el && el.clientWidth) setAt(Math.round(el.scrollLeft / el.clientWidth));
  };

  return (
    <div className="reddit-media">
      {count > 0 && (
        <div
          className="gallery"
          ref={strip}
          onScroll={onScroll}
          aria-roledescription="gallery"
          // A swipe here moves between pictures, not to the next item in the reader.
          onTouchStart={(e) => e.stopPropagation()}
          onTouchEnd={(e) => e.stopPropagation()}
        >
          {media.images.map((img, i) => (
            <figure key={img.url} className="gallery-slide" aria-label={`Picture ${i + 1} of ${count}`}>
              {img.mp4 ? (
                <video src={img.mp4} poster={img.url} autoPlay muted loop playsInline />
              ) : (
                <a href={img.url} target="_blank" rel="noopener noreferrer nofollow">
                  <img src={img.url} alt={img.caption ?? ""} loading={i < 2 ? "eager" : "lazy"} referrerPolicy="no-referrer" width={img.width ?? undefined} height={img.height ?? undefined} />
                </a>
              )}
              {img.caption && <figcaption className="small muted">{img.caption}</figcaption>}
            </figure>
          ))}
        </div>
      )}
      {count > 1 && (
        <div className="gallery-nav">
          <button className="secondary" onClick={() => go(at - 1)} disabled={at <= 0} aria-label="Previous picture">
            ‹
          </button>
          <span className="small muted">
            {at + 1} / {count}
          </span>
          <button className="secondary" onClick={() => go(at + 1)} disabled={at >= count - 1} aria-label="Next picture">
            ›
          </button>
        </div>
      )}
      {media.notice && (
        <p className="muted small">
          {media.notice}{" "}
          {postUrl && (
            <a href={postUrl} target="_blank" rel="noopener noreferrer">
              Open on Reddit ↗
            </a>
          )}
        </p>
      )}
    </div>
  );
}
