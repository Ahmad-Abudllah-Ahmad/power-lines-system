import React, { useCallback, useEffect, useState } from "react";
import { ZoomIn, ZoomOut, RotateCcw, Maximize2, Minimize2 } from "lucide-react";
import { VideoOverlayPlayer } from "./VideoOverlayPlayer";
import {
  RGB_PREVIEW_ZOOM_MAX,
  RGB_PREVIEW_ZOOM_MIN,
  RGB_PREVIEW_ZOOM_STEP,
} from "./DetectionClassFilter";
import { useRgbPreviewPan } from "../utils/useRgbPreviewPan";

const TOOLBAR_SURFACE = { backgroundColor: "var(--dash-elevated-bg)" } as const;

export type VideoJobPreviewShellProps = {
  videoUrl: string;
  originalUrl?: string;
  framesUrl?: string;
  fps: number;
  videoWidth?: number;
  videoHeight?: number;
  hiddenClassKeys: ReadonlySet<string>;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  fullscreenHostRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  setZoom: React.Dispatch<React.SetStateAction<number>>;
  panResetKey: string | null;
  /**
   * When this value changes: exit fullscreen on this host if active; if empty, exit any document fullscreen.
   * Use e.g. `previewId`, `${runId}:${fileIdx}`, or `${runId}:${safeIdx}` while the preview is open.
   */
  exitFullscreenDependency: string;
  fileIndexLabel?: string;
  onScrollAreaClick?: (e: React.MouseEvent) => void;
  /** Lucide size for zoom / fullscreen icons (default 15). */
  toolbarIconSize?: number;
  /** Extra classes on the fullscreen root (e.g. `self-stretch`). */
  shellExtraClassName?: string;
  /** Override default toolbar position/wrap (e.g. Dashboard offset under header). */
  toolbarClassName?: string;
  /** Override inner scroll region. */
  scrollAreaClassName?: string;
  /** Passed to VideoOverlayPlayer `className`. */
  playerClassName?: string;
};

export function VideoJobPreviewShell({
  videoUrl,
  originalUrl,
  framesUrl,
  fps,
  videoWidth,
  videoHeight,
  hiddenClassKeys,
  videoRef,
  fullscreenHostRef,
  zoom,
  setZoom,
  panResetKey,
  exitFullscreenDependency,
  fileIndexLabel,
  onScrollAreaClick,
  toolbarIconSize = 15,
  shellExtraClassName = "",
  toolbarClassName,
  scrollAreaClassName,
  playerClassName = "max-h-[min(85vh,820px)] w-full max-w-full rounded-xl border border-[var(--dash-preview-border)] bg-black shadow-lg",
}: VideoJobPreviewShellProps) {
  const [areaFullscreen, setAreaFullscreen] = useState(false);
  const videoPan = useRgbPreviewPan(zoom, panResetKey, "w-full flex justify-center");

  const toggleAreaFullscreen = useCallback(() => {
    const el = fullscreenHostRef.current;
    if (!el) return;
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void>;
    };
    const fs = document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    if (fs === el) {
      void (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
    } else {
      const req =
        el.requestFullscreen ??
        (el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen;
      void req?.call(el)?.catch(() => {});
    }
  }, [fullscreenHostRef]);

  useEffect(() => {
    const sync = () => {
      const host = fullscreenHostRef.current;
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      const fs = document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
      setAreaFullscreen(host != null && fs === host);
    };
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, [fullscreenHostRef]);

  useEffect(() => {
    const doc = document as Document & {
      webkitExitFullscreen?: () => Promise<void>;
      webkitFullscreenElement?: Element | null;
    };
    const exitFs = () => void (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
    const fs = document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    if (!exitFullscreenDependency) {
      if (fs) exitFs();
      return;
    }
    const host = fullscreenHostRef.current;
    if (host && fs === host) exitFs();
  }, [exitFullscreenDependency, fullscreenHostRef]);

  const tb =
    toolbarClassName ??
    "absolute left-3 top-3 z-20 flex items-center gap-0.5 rounded-xl border border-[var(--dash-panel-border)] overflow-hidden shadow-lg";

  const scroll =
    scrollAreaClassName ??
    "flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto scrollbar-gutter-stable p-6 md:p-10";

  return (
    <div
      ref={fullscreenHostRef as unknown as React.Ref<HTMLDivElement>}
      className={`relative flex min-h-0 min-w-0 flex-1 flex-col ${areaFullscreen ? "bg-black" : ""} ${shellExtraClassName}`.trim()}
    >
      <div className={tb} style={TOOLBAR_SURFACE}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setZoom((z) => Math.max(RGB_PREVIEW_ZOOM_MIN, z - RGB_PREVIEW_ZOOM_STEP));
          }}
          className="p-2 dash-text-primary hover:bg-[var(--dash-hover-bg)] transition-colors"
          aria-label="Zoom out"
        >
          <ZoomOut size={toolbarIconSize} />
        </button>
        <span className="px-2 text-xs dash-text-body min-w-[3.25rem] text-center font-medium tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setZoom((z) => Math.min(RGB_PREVIEW_ZOOM_MAX, z + RGB_PREVIEW_ZOOM_STEP));
          }}
          className="p-2 dash-text-primary hover:bg-[var(--dash-hover-bg)] transition-colors"
          aria-label="Zoom in"
        >
          <ZoomIn size={toolbarIconSize} />
        </button>
        <div className="w-px h-5 bg-[var(--dash-panel-border)]" />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setZoom(1);
          }}
          className="p-2 dash-text-primary hover:bg-[var(--dash-hover-bg)] transition-colors"
          aria-label="Reset zoom"
        >
          <RotateCcw size={Math.max(12, toolbarIconSize - 2)} />
        </button>
        <div className="w-px h-5 bg-[var(--dash-panel-border)]" />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggleAreaFullscreen();
          }}
          className="p-2 dash-text-primary hover:bg-[var(--dash-hover-bg)] transition-colors"
          aria-label={areaFullscreen ? "Exit full screen" : "Full screen"}
          title={areaFullscreen ? "Exit full screen" : "Full screen"}
        >
          {areaFullscreen ? <Minimize2 size={toolbarIconSize} /> : <Maximize2 size={toolbarIconSize} />}
        </button>
      </div>

      {fileIndexLabel != null && fileIndexLabel !== "" && (
        <div
          className="absolute right-3 top-3 z-20 rounded-lg border border-[var(--dash-panel-border)] px-3 py-1.5 text-xs dash-text-body font-medium tabular-nums shadow-sm"
          style={TOOLBAR_SURFACE}
        >
          {fileIndexLabel}
        </div>
      )}

      <div className={scroll} onClick={onScrollAreaClick}>
        <div className="relative mx-auto w-full max-w-5xl">
          <div {...videoPan}>
            <div
              className="relative inline-block w-full transition-[transform] duration-150 ease-out"
              style={{ transform: `scale(${zoom})`, transformOrigin: "center center" }}
            >
              <VideoOverlayPlayer
                videoUrl={videoUrl}
                originalUrl={originalUrl}
                framesUrl={framesUrl}
                fps={fps}
                videoWidth={videoWidth}
                videoHeight={videoHeight}
                hiddenClassKeys={hiddenClassKeys as unknown as Set<string>}
                videoRef={videoRef}
                modalZoom={zoom}
                disableNativeVideoFullscreen
                className={playerClassName}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
