import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Filter, ChevronDown } from "lucide-react";
import {
  formatDetectionSidebarLabel,
  normalizeDetectionClassKey,
} from "../utils/detectionSidebarBuckets";

/** 3-column tile grid for RGB/thermal file lists and detection result cards (Dashboard, Runs, AIDetection, ThermalImages). */
export const DETECTION_FILE_GRID_CLASS = "grid grid-cols-3 gap-2 sm:gap-3";

/** Shared zoom limits for RGB image + canvas preview (Dashboard, AIDetection, Runs, RunDetail). */
export const RGB_PREVIEW_ZOOM_MIN = 0.25;
export const RGB_PREVIEW_ZOOM_MAX = 5;
export const RGB_PREVIEW_ZOOM_STEP = 0.25;

export type DetectionRowLike = {
  class_name?: string;
  label?: string;
  bbox?: number[];
  /** YOLO / server class index — matches `server.py` annotate_image color selection. */
  class_id?: number;
};

/** Same order as `COLORS` in backend `server.py` (OpenCV BGR → canvas uses RGB). */
const ANNOTATION_COLORS_BGR: readonly [number, number, number][] = [
  [0, 255, 255],
  [255, 0, 255],
  [0, 255, 0],
  [255, 255, 0],
  [255, 128, 0],
  [128, 0, 255],
  [0, 128, 255],
  [255, 0, 128],
];

function bgrTupleToRgbCss(b: number, g: number, r: number): string {
  return `rgb(${r}, ${g}, ${b})`;
}

function annotationStrokeColorCss(classId: number): string {
  const id = Number.isFinite(classId) ? Math.trunc(classId) : 0;
  const idx = ((id % ANNOTATION_COLORS_BGR.length) + ANNOTATION_COLORS_BGR.length) % ANNOTATION_COLORS_BGR.length;
  const [bb, gg, rr] = ANNOTATION_COLORS_BGR[idx]!;
  return bgrTupleToRgbCss(bb, gg, rr);
}

/** Label string and foreign_object rule aligned with `annotate_image(..., copy=True)`. */
function serverStyleAnnotationLabel(row: DetectionRowLike, allRows: DetectionRowLike[]): string {
  const foreignCount = allRows.filter(
    (r) => normalizeDetectionClassKey(r.class_name ?? r.label) === "foreign_object"
  ).length;
  let raw = String(row.class_name ?? row.label ?? "").trim();
  if (foreignCount > 3 && normalizeDetectionClassKey(raw) === "foreign_object") {
    raw = "bolt_rust";
  }
  return raw || "Defect";
}

let classNamesPromise: Promise<string[]> | null = null;

export function fetchDetectionClassNames(): Promise<string[]> {
  return fetch("/api/detection/class_names")
    .then((r) => r.json())
    .then((data) => (Array.isArray(data.class_names) ? data.class_names.map(String) : []))
    .catch(() => []);
}

function getDetectionClassNamesOnce(): Promise<string[]> {
  if (!classNamesPromise) classNamesPromise = fetchDetectionClassNames();
  return classNamesPromise;
}

export function buildDetectionFilterClassKeys(
  modelNames: string[],
  detectionRows: DetectionRowLike[]
): string[] {
  const keys = new Set<string>();
  modelNames.forEach((n) => keys.add(normalizeDetectionClassKey(n)));
  detectionRows.forEach((d) => keys.add(normalizeDetectionClassKey(d.class_name ?? d.label)));
  return [...keys].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

export function filterRowsByVisibleClasses<T extends DetectionRowLike>(rows: T[], hiddenKeys: Set<string>): T[] {
  return rows.filter((d) => !hiddenKeys.has(normalizeDetectionClassKey(d.class_name ?? d.label)));
}

export function redrawRgbDetectionOverlay(
  img: HTMLImageElement,
  canvas: HTMLCanvasElement,
  opts: { sourceW: number; sourceH: number; detections: DetectionRowLike[] }
): void {
  const { sourceW, sourceH, detections } = opts;
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (!nw || !nh || sourceW <= 0 || sourceH <= 0) return;

  const displayW = img.clientWidth;
  const displayH = img.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(displayW * dpr);
  canvas.height = Math.round(displayH * dpr);
  canvas.style.width = `${displayW}px`;
  canvas.style.height = `${displayH}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, displayW, displayH);

  const ctr = Math.min(displayW / nw, displayH / nh);
  const ox = (displayW - nw * ctr) / 2;
  const oy = (displayH - nh * ctr) / 2;
  const tx = nw / sourceW;
  const ty = nh / sourceH;
  /** Source pixel → CSS pixel scale (stroke/font scale with preview size). */
  const srcToCss = Math.min(tx, ty) * ctr;
  const linePx = Math.max(1, srcToCss);
  const fontPx = Math.max(8, Math.round(8 * srcToCss));

  for (const d of detections) {
    const b = d.bbox;
    if (!Array.isArray(b) || b.length < 4) continue;
    const [x1, y1, x2, y2] = b;
    if (![x1, y1, x2, y2].every((n) => Number.isFinite(n))) continue;
    const rx = ox + x1 * tx * ctr;
    const ry = oy + y1 * ty * ctr;
    const rw = (x2 - x1) * tx * ctr;
    const rh = (y2 - y1) * ty * ctr;

    const clsId = typeof d.class_id === "number" && Number.isFinite(d.class_id) ? d.class_id : 0;
    const color = annotationStrokeColorCss(clsId);
    ctx.strokeStyle = color;
    ctx.lineWidth = linePx;
    ctx.strokeRect(rx, ry, rw, rh);

    const label = serverStyleAnnotationLabel(d, detections);
    ctx.font = `${fontPx}px sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const tw = ctx.measureText(label).width;
    const labelBgW = tw + 4 * srcToCss;
    const labelBgH = fontPx + 4 * srcToCss;
    let labelTop = ry - labelBgH;
    if (labelTop < oy + 2) {
      labelTop = ry + rh + 2 * srcToCss;
    }
    ctx.fillStyle = color;
    ctx.fillRect(rx, labelTop, labelBgW, labelBgH);
    ctx.fillStyle = "rgb(0, 0, 0)";
    ctx.fillText(label, rx + 2 * srcToCss, labelTop + labelBgH / 2);
  }
}

export function useDetectionModelClassNames(): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    getDetectionClassNamesOnce().then((list) => {
      if (!cancelled && list.length) setNames(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return names;
}

/** Class checkbox filter + filtered rows for overlays / sidebar (RGB image live overlay, or list-only for video). */
export function useDetectionClassFilterForRows(
  detectionRows: DetectionRowLike[],
  resetKey: string | null | undefined,
  opts?: { classKeysFromRows?: DetectionRowLike[] }
) {
  const modelClassNames = useDetectionModelClassNames();
  const [hiddenClassKeys, setHiddenClassKeys] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  const rowsForClassKeys =
    opts?.classKeysFromRows != null && opts.classKeysFromRows.length > 0
      ? opts.classKeysFromRows
      : detectionRows;

  const hiddenSet = useMemo(() => new Set(hiddenClassKeys), [hiddenClassKeys]);
  const filterClassKeys = useMemo(
    () => buildDetectionFilterClassKeys(modelClassNames, rowsForClassKeys),
    [modelClassNames, rowsForClassKeys]
  );
  const filteredRows = useMemo(
    () => filterRowsByVisibleClasses(detectionRows, hiddenSet),
    [detectionRows, hiddenSet]
  );

  useEffect(() => {
    setOpen(false);
  }, [resetKey]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (anchorRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggleKey = useCallback((key: string) => {
    setHiddenClassKeys((prev) =>
      prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key].sort()
    );
  }, []);

  const showAll = useCallback(() => setHiddenClassKeys([]), []);
  const hideAll = useCallback(() => setHiddenClassKeys([...filterClassKeys]), [filterClassKeys]);

  return {
    filterClassKeys,
    filteredRows,
    hiddenSet,
    open,
    setOpen,
    anchorRef,
    toggleKey,
    showAll,
    hideAll,
  };
}

export function DetectionClassFilterDropdown({
  filterClassKeys,
  hiddenSet,
  open,
  setOpen,
  anchorRef,
  toggleKey,
  showAll,
  hideAll,
  liveOverlayEnabled,
  listOnlyTitle = "Show in list",
}: {
  filterClassKeys: string[];
  hiddenSet: Set<string>;
  open: boolean;
  setOpen: (v: boolean) => void;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  toggleKey: (key: string) => void;
  showAll: () => void;
  hideAll: () => void;
  liveOverlayEnabled: boolean;
  /** Panel header when overlays are not live (e.g. video). */
  listOnlyTitle?: string;
}) {
  const header = liveOverlayEnabled ? "Show on image" : listOnlyTitle;
  const title = liveOverlayEnabled
    ? "Show or hide detection classes on the preview image"
    : "Show or hide classes in the sidebar list (video boxes are baked into the file)";

  return (
    <div ref={anchorRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={filterClassKeys.length === 0}
        title={title}
        className="flex items-center gap-1 rounded-lg border border-[var(--dash-panel-border)] px-2.5 py-1.5 text-[11px] font-semibold dash-text-primary transition-colors hover:bg-[var(--dash-hover-bg)] disabled:cursor-not-allowed disabled:opacity-45"
        style={{ backgroundColor: "var(--dash-elevated-bg)" }}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <Filter size={14} className="text-cyan-400" />
        <span>Classes</span>
        <ChevronDown size={14} className={`opacity-70 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div
          className="absolute right-0 top-full z-30 mt-1 w-64 max-h-64 overflow-hidden rounded-lg border border-[var(--dash-panel-border)] shadow-xl"
          style={{ backgroundColor: "var(--dash-elevated-bg)" }}
          role="listbox"
        >
          <div className="flex items-center justify-between border-b border-[var(--dash-panel-border)] px-2 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide dash-text-muted">{header}</span>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={showAll}
                className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-cyan-400 hover:bg-[var(--dash-hover-bg)]"
              >
                All
              </button>
              <button
                type="button"
                onClick={hideAll}
                className="rounded px-1.5 py-0.5 text-[10px] font-semibold dash-text-muted hover:bg-[var(--dash-hover-bg)]"
              >
                None
              </button>
            </div>
          </div>
          <div className="max-h-52 overflow-y-auto py-1">
            {filterClassKeys.length === 0 ? (
              <div className="px-3 py-2 text-[11px] dash-text-muted">No class list yet</div>
            ) : (
              filterClassKeys.map((key) => (
                <label
                  key={key}
                  className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs dash-text-primary hover:bg-[var(--dash-hover-bg)]"
                >
                  <input
                    type="checkbox"
                    className="rounded border-[var(--dash-panel-border)] text-cyan-500 focus:ring-cyan-500"
                    checked={!hiddenSet.has(key)}
                    onChange={() => toggleKey(key)}
                  />
                  <span className="min-w-0 truncate" title={formatDetectionSidebarLabel(key)}>
                    {formatDetectionSidebarLabel(key)}
                  </span>
                </label>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function useRgbPreviewDetectionOverlay(
  imgRef: React.RefObject<HTMLImageElement | null>,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  args: {
    enabled: boolean;
    sourceW: number;
    sourceH: number;
    detections: DetectionRowLike[];
    imageUrlKey: string;
    /** Parent CSS transform scale (e.g. modal zoom). */
    modalZoom: number;
  }
) {
  const { enabled, sourceW, sourceH, detections, imageUrlKey, modalZoom } = args;

  const redraw = useCallback(() => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas || !enabled || sourceW <= 0 || sourceH <= 0) return;
    redrawRgbDetectionOverlay(img, canvas, { sourceW, sourceH, detections });
  }, [imgRef, canvasRef, enabled, sourceW, sourceH, detections]);

  useEffect(() => {
    redraw();
  }, [redraw, modalZoom, imageUrlKey]);

  useEffect(() => {
    const img = imgRef.current;
    if (!img || !enabled) return;
    let rafId = 0;
    const scheduleRedraw = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        redraw();
      });
    };
    const ro = new ResizeObserver(scheduleRedraw);
    ro.observe(img);
    img.addEventListener("load", scheduleRedraw);
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      img.removeEventListener("load", scheduleRedraw);
    };
  }, [imgRef, enabled, redraw, imageUrlKey]);
}

/** Percentage-positioned boxes over an image (same coordinate space as natural image width/height). */
export function DetectionBboxOverlays(props: { detections: Array<{ bbox?: number[] }>; imgW: number; imgH: number }) {
  const { detections, imgW, imgH } = props;
  if (imgW <= 0 || imgH <= 0) return null;
  return (
    <>
      {detections.map((d, i) => {
        const b = d.bbox;
        if (!Array.isArray(b) || b.length < 4) return null;
        const x1 = Number(b[0]);
        const y1 = Number(b[1]);
        const x2 = Number(b[2]);
        const y2 = Number(b[3]);
        if (![x1, y1, x2, y2].every((n) => Number.isFinite(n))) return null;
        const left = (Math.min(x1, x2) / imgW) * 100;
        const top = (Math.min(y1, y2) / imgH) * 100;
        const w = (Math.abs(x2 - x1) / imgW) * 100;
        const h = (Math.abs(y2 - y1) / imgH) * 100;
        return (
          <div
            key={i}
            className="pointer-events-none absolute z-[5] rounded-sm border-2 border-cyan-300 shadow-[0_0_0_1px_rgba(0,0,0,0.85)]"
            style={{ left: `${left}%`, top: `${top}%`, width: `${w}%`, height: `${h}%` }}
          />
        );
      })}
    </>
  );
}
