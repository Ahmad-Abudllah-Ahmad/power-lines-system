import React, { useEffect, useMemo, useRef, useState } from "react";

const PREVIEW_FRAME_GRID_MAX = 48;

function formatTimeSec(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export type VideoAnnotatedFrameStripProps = {
  videoUrl: string;
  duration: number;
  fps: number;
  framesAnalyzed: number;
  mainVideoRef: React.RefObject<HTMLVideoElement | null>;
};

/**
 * Scrollable grid of annotated frame thumbnails (from the same MP4), between the main player and a stats panel.
 * Clicking a cell pauses the main video and seeks to that timestamp.
 */
export function VideoAnnotatedFrameStrip({
  videoUrl,
  duration,
  fps,
  framesAnalyzed,
  mainVideoRef,
}: VideoAnnotatedFrameStripProps) {
  const captureVideoRef = useRef<HTMLVideoElement>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  const slots = useMemo(() => {
    if (!videoUrl) return [];
    const dur = duration || 0;
    const fp = Math.max(0.001, fps || 30);
    const estimated = Math.max(1, Math.round(dur * fp));
    const fa = Math.max(1, framesAnalyzed || estimated);
    const n = Math.min(PREVIEW_FRAME_GRID_MAX, fa);
    return Array.from({ length: n }, (_, k) => {
      const fi = n <= 1 ? 0 : Math.round((k / (n - 1)) * (fa - 1));
      let t = fi / fp;
      if (dur > 0) t = Math.min(Math.max(0, t), Math.max(0, dur - 0.05));
      return { k, fi, t };
    });
  }, [videoUrl, duration, fps, framesAnalyzed]);

  useEffect(() => {
    if (!videoUrl || slots.length === 0) {
      setThumbs({});
      return;
    }
    const cap = captureVideoRef.current;
    if (!cap) return;

    let cancelled = false;
    setThumbs({});

    const waitMeta = () =>
      new Promise<void>((resolve) => {
        if (cap.readyState >= HTMLMediaElement.HAVE_METADATA) {
          resolve();
          return;
        }
        const done = () => {
          cap.removeEventListener("loadedmetadata", done);
          resolve();
        };
        cap.addEventListener("loadedmetadata", done);
      });

    const captureAt = (t: number, key: string) =>
      new Promise<void>((resolve) => {
        if (cancelled) {
          resolve();
          return;
        }
        const applyFrame = () => {
          if (cancelled) return;
          try {
            const vw = cap.videoWidth;
            const vh = cap.videoHeight;
            if (vw < 2 || vh < 2) return;
            const canvas = document.createElement("canvas");
            const tw = 128;
            const th = Math.max(1, Math.round((vh / vw) * tw));
            canvas.width = tw;
            canvas.height = th;
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            ctx.drawImage(cap, 0, 0, tw, th);
            const dataUrl = canvas.toDataURL("image/jpeg", 0.58);
            setThumbs((prev) => ({ ...prev, [key]: dataUrl }));
          } catch {
            /* canvas taint / decode */
          }
        };

        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };

        if (Math.abs(cap.currentTime - t) < 0.04 && cap.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          applyFrame();
          finish();
          return;
        }

        const onSeeked = () => {
          cap.removeEventListener("seeked", onSeeked);
          applyFrame();
          finish();
        };
        cap.addEventListener("seeked", onSeeked);
        cap.currentTime = t;
        window.setTimeout(() => {
          cap.removeEventListener("seeked", onSeeked);
          finish();
        }, 900);
      });

    void (async () => {
      await waitMeta();
      if (cancelled) return;
      for (const slot of slots) {
        if (cancelled) break;
        await captureAt(slot.t, String(slot.k));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [videoUrl, slots]);

  if (!videoUrl || slots.length === 0) return null;

  return (
    <>
      <video
        ref={captureVideoRef}
        src={videoUrl}
        muted
        playsInline
        preload="auto"
        tabIndex={-1}
        aria-hidden
        className="pointer-events-none fixed left-0 top-0 h-px w-px opacity-0"
      />
      <div
        className="flex h-full min-h-0 w-[220px] shrink-0 flex-col border-l"
        style={{ borderColor: "var(--dash-panel-border)", backgroundColor: "var(--dash-thumb-strip-bg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 border-b px-2 py-2 text-[11px] font-medium" style={{ borderColor: "var(--dash-panel-border)", color: "var(--dash-muted)" }}>
          Annotated frames
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2">
          <div className="grid grid-cols-2 gap-2">
            {slots.map((slot) => (
              <button
                key={slot.k}
                type="button"
                className="group overflow-hidden rounded-lg border text-left transition-colors hover:border-cyan-500/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50"
                style={{ borderColor: "var(--dash-panel-border)", backgroundColor: "var(--dash-nested-bg)" }}
                onClick={(e) => {
                  e.stopPropagation();
                  const v = mainVideoRef.current;
                  if (!v) return;
                  v.pause();
                  v.currentTime = slot.t;
                }}
              >
                <div className="aspect-video" style={{ backgroundColor: "var(--dash-inset-bg)" }}>
                  {thumbs[String(slot.k)] ? (
                    <img
                      src={thumbs[String(slot.k)]}
                      alt=""
                      className="h-full w-full object-cover"
                      draggable={false}
                    />
                  ) : (
                    <div className="h-full w-full animate-pulse" style={{ backgroundColor: "var(--dash-skeleton)" }} />
                  )}
                </div>
                <div className="px-1 py-1 text-center font-Poppins text-[10px] dash-text-body group-hover:dash-text-primary">
                  {formatTimeSec(slot.t)}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
