import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  SIDEBAR_COMPONENT_CLASS_KEYS,
  normalizeDetectionClassKey,
} from "../utils/detectionSidebarBuckets";

/**
 * Plays the un-annotated video and draws bounding boxes on a canvas overlay
 * synced to the current video time, so unchecking a class hides its boxes
 * on every frame in real time. Falls back to <video src=annotated.mp4> when
 * either the original video or the per-frame JSON is missing.
 */

const COMPONENT_CLASS_KEYS_SET = new Set<string>(SIDEBAR_COMPONENT_CLASS_KEYS);

function strokeColorForClass(name: string | undefined): string {
  return COMPONENT_CLASS_KEYS_SET.has(normalizeDetectionClassKey(name))
    ? "rgb(0, 200, 0)"
    : "rgb(220, 0, 0)";
}

type FrameDetection = {
  bbox?: [number, number, number, number] | number[];
  class_name?: string;
  class_id?: number;
  confidence?: number;
};

export type VideoOverlayPlayerProps = {
  videoUrl: string;
  /** Un-annotated video URL when available; if omitted, falls back to videoUrl. */
  originalUrl?: string;
  /** /results/<file_id>/detections_frames.json */
  framesUrl?: string;
  fps: number;
  videoWidth?: number;
  videoHeight?: number;
  /** Normalized class keys hidden by the user's filter dropdown. */
  hiddenClassKeys: Set<string>;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  className?: string;
  /** Modal CSS scale (RGB preview); keeps overlay redraw in sync when zoom changes. */
  modalZoom?: number;
  /** Hide browser “full screen” on the video so app chrome (e.g. zoom) can use Fullscreen API on a parent. */
  disableNativeVideoFullscreen?: boolean;
};

export function VideoOverlayPlayer({
  videoUrl,
  originalUrl,
  framesUrl,
  fps,
  videoWidth,
  videoHeight,
  hiddenClassKeys,
  videoRef,
  className = "w-full max-h-[calc(100vh-8rem)] rounded-xl bg-black shadow-2xl",
  modalZoom = 1,
  disableNativeVideoFullscreen = false,
}: VideoOverlayPlayerProps) {
  const innerVideoRef = useRef<HTMLVideoElement | null>(null);
  const setVideoEl = (el: HTMLVideoElement | null) => {
    innerVideoRef.current = el;
    if (videoRef) videoRef.current = el;
  };
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [frames, setFrames] = useState<FrameDetection[][] | null>(null);
  const [framesLoaded, setFramesLoaded] = useState(false);

  const overlayEnabled = useMemo(
    () => Boolean(originalUrl && framesUrl),
    [originalUrl, framesUrl]
  );

  // Fetch per-frame JSON once per file
  useEffect(() => {
    if (!framesUrl) {
      setFrames(null);
      setFramesLoaded(false);
      return;
    }
    let cancelled = false;
    setFramesLoaded(false);
    fetch(framesUrl, { cache: "force-cache" })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (cancelled) return;
        setFrames(Array.isArray(data) ? (data as FrameDetection[][]) : []);
        setFramesLoaded(true);
      })
      .catch(() => {
        if (!cancelled) {
          setFrames([]);
          setFramesLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [framesUrl]);

  // Per-frame draw loop using requestAnimationFrame so updates happen on every
  // displayed video frame, including when the user toggles a class checkbox.
  useEffect(() => {
    if (!overlayEnabled) return;
    const video = innerVideoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    let raf = 0;
    let cancelled = false;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const sourceW = videoWidth && videoWidth > 0 ? videoWidth : video.videoWidth;
    const sourceH = videoHeight && videoHeight > 0 ? videoHeight : video.videoHeight;

    const draw = () => {
      if (cancelled) return;
      const vw = video.videoWidth || sourceW;
      const vh = video.videoHeight || sourceH;
      const dpr = window.devicePixelRatio || 1;
      const cssW = video.clientWidth;
      const cssH = video.clientHeight;
      if (cssW > 0 && cssH > 0) {
        const targetW = Math.round(cssW * dpr);
        const targetH = Math.round(cssH * dpr);
        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
        }
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      if (frames && frames.length > 0 && vw > 0 && vh > 0 && fps > 0) {
        // Letter-box scale: <video> uses object-contain implicitly via CSS sizing.
        const ctr = Math.min(cssW / vw, cssH / vh);
        const ox = (cssW - vw * ctr) / 2;
        const oy = (cssH - vh * ctr) / 2;
        const idx = Math.min(
          frames.length - 1,
          Math.max(0, Math.round(video.currentTime * fps))
        );
        const list = frames[idx] || [];
        const linePx = Math.max(1.5, ctr * 1.5);
        const fontPx = Math.max(10, Math.round(11 * Math.max(0.6, ctr)));
        ctx.font = `${fontPx}px sans-serif`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        for (const det of list) {
          const name = det.class_name;
          const key = normalizeDetectionClassKey(name);
          if (hiddenClassKeys.has(key)) continue;
          const b = det.bbox;
          if (!Array.isArray(b) || b.length < 4) continue;
          const [x1, y1, x2, y2] = b;
          if (![x1, y1, x2, y2].every((n) => Number.isFinite(n))) continue;
          const rx = ox + x1 * ctr;
          const ry = oy + y1 * ctr;
          const rw = (x2 - x1) * ctr;
          const rh = (y2 - y1) * ctr;
          const color = strokeColorForClass(name);
          ctx.strokeStyle = color;
          ctx.lineWidth = linePx;
          ctx.strokeRect(rx, ry, rw, rh);
          const label = String(name || "Defect");
          const tw = ctx.measureText(label).width;
          const labelBgW = tw + 6;
          const labelBgH = fontPx + 6;
          let labelTop = ry - labelBgH;
          if (labelTop < oy + 1) labelTop = ry + rh + 2;
          ctx.fillStyle = color;
          ctx.fillRect(rx, labelTop, labelBgW, labelBgH);
          ctx.fillStyle = "rgb(0, 0, 0)";
          ctx.fillText(label, rx + 3, labelTop + labelBgH / 2);
        }
      }

      raf = window.requestAnimationFrame(draw);
    };
    raf = window.requestAnimationFrame(draw);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
    };
  }, [overlayEnabled, frames, fps, videoWidth, videoHeight, hiddenClassKeys, modalZoom]);

  // Pick source: prefer un-annotated video so the overlay is the only box source.
  const useOverlay = overlayEnabled && (frames === null || framesLoaded);
  const src = useOverlay ? originalUrl! : videoUrl;
  return (
    <div className="relative inline-block w-full">
      <video
        ref={setVideoEl}
        key={src}
        src={src}
        controls
        controlsList={disableNativeVideoFullscreen ? "nofullscreen" : undefined}
        autoPlay
        playsInline
        className={className}
      />
      {useOverlay && (
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute inset-0 h-full w-full"
        />
      )}
    </div>
  );
}
