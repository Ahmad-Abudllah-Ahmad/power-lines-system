import React, { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import {
  getRuns,
  getLatestBulkBatch,
  getRecentBulkBatches,
  bulkBatchReportUrl,
  getRun,
  listOverlays,
  resolveArtifactUrl,
  API_BASE,
  type Run,
} from "../api/api";
import { useTheme } from "../context/ThemeContext";
import { toast } from "../components/Toast";
import { VideoAnnotatedFrameStrip } from "../components/VideoAnnotatedFrameStrip";
import {
  ThermalAnalysisDetailModal,
  type ThermalStats,
  type ThermalAnalysisData,
} from "../components/ThermalAnalysisDetailModal";
import {
  applyBreakageAngleBraceRename,
  filterRowsForRgbPreviewOverlay,
  partitionDetectionsSidebarBuckets,
  previewDetectionRowsForFile,
  uniqueDefectTypeCount,
} from "../utils/detectionSidebarBuckets";
import { DetectionSidebarBucketPanels } from "../components/DetectionSidebarBucketPanels";
import {
  type DetectionRowLike,
  DetectionClassFilterDropdown,
  DETECTION_FILE_GRID_CLASS,
  RGB_PREVIEW_ZOOM_MAX,
  RGB_PREVIEW_ZOOM_MIN,
  RGB_PREVIEW_ZOOM_STEP,
  useDetectionClassFilterForRows,
  useRgbPreviewDetectionOverlay,
} from "../components/DetectionClassFilter";
import {
  LayoutDashboard,
  CheckCircle2,
  AlertCircle,
  TrendingUp,
  Copy,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  Download,
  ListOrdered,
  Clock,
  XCircle,
  Upload,
  Image as ImageIcon,
  FileCheck,
  BarChart3,
  AlertTriangle,
  HelpCircle,
  Thermometer,
  Video,
  Plus,
  X,
  Eye,
  Check,
  ZoomIn,
  ZoomOut,
  RotateCcw,
} from "lucide-react";

const DAYS = 14;
const EMPTY_GALLERY_URLS: string[] = [];

type TimeRange = "today" | "7d" | "30d" | "custom" | "all";

function getTimeRangeBounds(tr: TimeRange, customFrom?: Date, customTo?: Date): { start: number; end: number } {
  const now = Date.now();
  const end = now;
  switch (tr) {
    case "today": {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return { start: d.getTime(), end };
    }
    case "7d":
      return { start: now - 7 * 24 * 60 * 60 * 1000, end };
    case "30d":
      return { start: now - 30 * 24 * 60 * 60 * 1000, end };
    case "custom":
      if (customFrom && customTo) {
        const d1 = new Date(customFrom);
        d1.setHours(0, 0, 0, 0);
        const d2 = new Date(customTo);
        d2.setHours(23, 59, 59, 999);
        return { start: d1.getTime(), end: d2.getTime() };
      }
      return { start: 0, end };
    default:
      return { start: 0, end };
  }
}

function formatTimeRangeLabel(tr: TimeRange): string {
  switch (tr) {
    case "today": return "Today";
    case "7d": return "7 days";
    case "30d": return "30 days";
    case "custom": return "Custom";
    default: return "All";
  }
}

function copyRunId(runId: string) {
  navigator.clipboard.writeText(runId).then(
    () => toast.success("Run ID copied to clipboard", 2500),
    () => toast.error("Copy failed", 3000)
  );
}

function dayKey(r: Run): string {
  const t = r.created_at ?? r.timestamp;
  if (!t) return "";
  try {
    return new Date(t).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

function runTime(r: Run): number {
  const t = r.created_at ?? r.timestamp;
  return t ? new Date(t).getTime() : 0;
}

function confidencePct(r: Run): number | null {
  const v = r.avg_confidence ?? r.ai_confidence;
  return typeof v === "number" ? Math.round(v * 100) : null;
}

function mediaUrl(u: string) {
  if (!u) return u;
  if (u.startsWith("http")) return u;
  const path = u.startsWith("/") ? u : `/${u}`;
  return API_BASE ? `${API_BASE}${path}` : path;
}

function overlayItemSrc(runId: string, it: { url?: string; filename: string }): string {
  const raw = it.url?.trim() || `/api/runs/${runId}/artifacts/overlays/${encodeURIComponent(it.filename)}`;
  return mediaUrl(raw);
}

function isMp4Url(u: string | null | undefined): boolean {
  return Boolean(u && /\.mp4(\?|$)/i.test(u));
}

/** True when run is a video batch or any file carries an annotated MP4 output. */
function isVideoStyleRun(run: Run | undefined): boolean {
  if (!run) return false;
  const anyRun = run as unknown as {
    type?: string;
    files?: Array<{ video_url?: string | null }>;
  };
  if (anyRun.type === "video") return true;
  return Boolean(anyRun.files?.some((f) => isMp4Url(f.video_url ?? undefined)));
}

/** Detection server embeds `/results/…` on `files[]`. Image jobs: `/results/{job_id}/{file_id}_annotated.jpg`. Video jobs: `/results/{file_id}/thumb.jpg`. */
function extractUrlsFromRunPayload(run: Run): { urls: string[]; filenames: string[] } {
  const anyRun = run as unknown as {
    type?: string;
    files?: Array<{
      filename?: string;
      file_id?: string;
      thumb_url?: string | null;
      annotated_url?: string | null;
      video_url?: string | null;
    }>;
  };
  const files = anyRun.files;
  if (!files?.length) return { urls: [], filenames: [] };
  const jobId = run.run_id ?? run.id;
  const runIsVideo = isVideoStyleRun(run);
  const urls: string[] = [];
  const filenames: string[] = [];
  for (const f of files) {
    const fileIsVideo = runIsVideo || isMp4Url(f.video_url ?? undefined);
    let u = f.annotated_url || f.thumb_url || null;
    if (!u && f.video_url && !isMp4Url(f.video_url)) u = f.video_url;
    if (!u && f.file_id) {
      if (fileIsVideo) u = `/results/${f.file_id}/thumb.jpg`;
      else if (jobId) u = `/results/${jobId}/${f.file_id}_annotated.jpg`;
    }
    if (u && typeof u === "string") {
      urls.push(mediaUrl(u.trim()));
      filenames.push(f.filename || f.file_id || "image");
    }
  }
  return { urls, filenames };
}

const RECENT_UPLOADS_LIMIT = 8;
const RECENT_UPLOADS_CAROUSEL_MAX = 8;

const HOW_IT_WORKS_SLIDES = [
  {
    imageSrc: "/carousel/slide-1.png",
    alt: "Digital and field power line inspection",
    title: "Blueprint to live inspection",
    meta: "Digital twin · corridor intelligence",
    accent: "blue" as const,
    steps: [
      "Align schematic and photographic views of lines and structures",
      "Monitor uploads, batches, and thermal runs in one dashboard",
      "Export evidence that ties engineering context to site findings",
    ],
  },
  {
    imageSrc: "/carousel/slide-2.png",
    alt: "Drone inspecting transmission lines",
    title: "Single image inspection",
    meta: "RGB workflow · AI-assisted review",
    accent: "cyan" as const,
    steps: [
      "Upload RGB image (thermal optional) with tower details",
      "AI detects components and classifies defects automatically",
      "Review detections and download a detailed incident report",
    ],
  },
  {
    imageSrc: "/carousel/slide-3.jpeg",
    alt: "Power infrastructure inspection",
    title: "Batch & thermal analysis",
    meta: "Scale processing · thermal insights",
    accent: "violet" as const,
    steps: [
      "Upload multiple images at once; results organized by defect type",
      "Thermal imaging for hot spots, corona patterns, and anomalies",
      "Download statistics and risk-focused reports for your fleet",
    ],
  },
];

const HOW_IT_WORKS_INTERVAL_MS = 5000;

type DashboardRunFile = {
  file_id?: string;
  filename?: string;
  /** rgb | thermal from detection server (thermal uses same image URLs as RGB) */
  source?: string;
  thumb_url?: string | null;
  annotated_url?: string | null;
  clean_url?: string | null;
  image_width?: number | null;
  image_height?: number | null;
  video_url?: string | null;
  detections?: Array<{ class_name?: string; confidence?: number }>;
  stats?: {
    total_defects?: number;
    avg_confidence?: number;
    processing_time_ms?: number;
  };
  total_detections?: number;
  avg_confidence?: number;
  duration?: number;
  fps?: number;
  frames_analyzed?: number;
};

function resolveMediaSrc(u: string | null | undefined): string {
  if (!u) return "";
  const s = u.trim();
  if (s.startsWith("http")) return s;
  return mediaUrl(s);
}

function shortAgo(ts?: string): string {
  if (!ts) return "—";
  try {
    const sec = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (sec < 60) return `${sec}s ago`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ago`;
    return new Date(ts).toLocaleDateString();
  } catch {
    return "—";
  }
}

function fileDefectCount(f: DashboardRunFile, isVideoJob: boolean): number {
  if (isVideoJob) return f.total_detections ?? 0;
  return f.stats?.total_defects ?? f.detections?.length ?? 0;
}

function dashboardVideoResultsFolderId(f: Pick<DashboardRunFile, "file_id" | "video_url">): string | null {
  if (f.file_id) return f.file_id;
  const u = (f.video_url || "").trim();
  const m = u.match(/\/results\/([^/]+)\//);
  return m?.[1] ?? null;
}

function RecentBatchUploadDetailModal({
  runId,
  fileIndex,
  run,
  recentRunGallery,
  batchDetailVideoDets,
  batchDetailVideoDetsLoading,
  batchDetailTab,
  setBatchDetailTab,
  batchDetailImgZoom,
  setBatchDetailImgZoom,
  batchDetailVideoRef,
  onClose,
  onFileIndexChange,
}: {
  runId: string;
  fileIndex: number;
  run: Run;
  recentRunGallery: Record<string, { loading: boolean; urls: string[]; filenames: string[] }>;
  batchDetailVideoDets: unknown[];
  batchDetailVideoDetsLoading: boolean;
  batchDetailTab: "image" | "processing";
  setBatchDetailTab: React.Dispatch<React.SetStateAction<"image" | "processing">>;
  batchDetailImgZoom: number;
  setBatchDetailImgZoom: React.Dispatch<React.SetStateAction<number>>;
  batchDetailVideoRef: React.RefObject<HTMLVideoElement | null>;
  onClose: () => void;
  onFileIndexChange: (index: number) => void;
}) {
  const batchDetailPreviewImgRef = useRef<HTMLImageElement | null>(null);
  const batchDetailPreviewCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const apiFiles = (run as unknown as { files?: DashboardRunFile[] })?.files;
  const gal = recentRunGallery[runId];
  const synthetic: DashboardRunFile[] =
    (gal?.urls ?? []).map((url, j) => ({
      filename: gal.filenames[j] || `Image ${j + 1}`,
      annotated_url: url,
      thumb_url: url,
      detections: [],
      stats: { total_defects: 0, avg_confidence: 0 },
    })) ?? [];
  const files: DashboardRunFile[] = apiFiles?.length ? apiFiles : synthetic;
  const isVideoJob = isVideoStyleRun(run);
  const n = files.length;
  const safeIdx = n === 0 ? 0 : Math.min(Math.max(0, fileIndex), n - 1);
  const cur = files[safeIdx];
  const videoSrc =
    cur?.video_url && /\.mp4(\?|$)/i.test(cur.video_url) ? resolveMediaSrc(cur.video_url) : "";

  const iw = typeof cur?.image_width === "number" ? cur.image_width : 0;
  const ih = typeof cur?.image_height === "number" ? cur.image_height : 0;
  const previewHasSourceDims = iw > 0 && ih > 0;
  const thumbResolved = cur?.thumb_url ? resolveMediaSrc(cur.thumb_url) : "";
  const annotatedResolved = cur?.annotated_url ? resolveMediaSrc(cur.annotated_url) : "";
  const cleanResolved = cur?.clean_url ? resolveMediaSrc(cur.clean_url) : "";
  const previewOverlaySrc = annotatedResolved || thumbResolved;
  const mainImg = annotatedResolved || thumbResolved;

  const runKind = isVideoJob ? ("video" as const) : ("image" as const);
  const previewDetectionRows = applyBreakageAngleBraceRename(
    previewDetectionRowsForFile(
      runKind,
      cur?.detections as unknown[] | undefined,
      batchDetailVideoDets
    ) as DetectionRowLike[]
  );

  const batchClassKeySourceRows = useMemo(() => {
    const out: DetectionRowLike[] = [];
    for (const file of files) {
      if (!Array.isArray(file.detections)) continue;
      for (const d of file.detections) out.push(d as DetectionRowLike);
    }
    if (isVideoJob && batchDetailVideoDets.length > 0) {
      for (const d of batchDetailVideoDets) out.push(d as DetectionRowLike);
    }
    return out;
  }, [files, isVideoJob, batchDetailVideoDets]);

  const clsFilter = useDetectionClassFilterForRows(
    previewDetectionRows,
    runId,
    batchClassKeySourceRows.length > 0 ? { classKeysFromRows: batchClassKeySourceRows } : undefined
  );

  const previewSidebarPartition = useMemo(() => {
    if (!previewDetectionRows.length) return null;
    return partitionDetectionsSidebarBuckets(clsFilter.filteredRows);
  }, [previewDetectionRows, clsFilter.filteredRows]);

  const overlayDetections = filterRowsForRgbPreviewOverlay(
    previewDetectionRows,
    clsFilter.hiddenSet
  ).filter((d) => Array.isArray(d.bbox) && d.bbox.length >= 4) as Array<{
    bbox: number[];
    class_name?: string;
    label?: string;
  }>;

  const dashFilteredImgSrc = clsFilter.hiddenSet.size > 0
    ? (cleanResolved || thumbResolved)
    : previewOverlaySrc;

  useRgbPreviewDetectionOverlay(batchDetailPreviewImgRef, batchDetailPreviewCanvasRef, {
    enabled: Boolean(!videoSrc && previewHasSourceDims && previewOverlaySrc),
    sourceW: iw,
    sourceH: ih,
    detections: overlayDetections,
    imageUrlKey: `${runId}:${safeIdx}:${dashFilteredImgSrc}`,
    modalZoom: batchDetailImgZoom,
  });

  const totalFiles = (run as unknown as { total_files?: number })?.total_files ?? n;
  const completed = (run as unknown as { completed?: number })?.completed ?? totalFiles;
  const defectsFound =
    run?.findings_count ?? (run as unknown as { total_defects?: number })?.total_defects ?? 0;
  const created = run?.created_at ?? run?.timestamp;
  const procMs = cur?.stats?.processing_time_ms;

  const setIdx = (i: number) => {
    if (n <= 0) return;
    onFileIndexChange(Math.max(0, Math.min(i, n - 1)));
  };

  const showLiveThumbOverlay =
    !videoSrc && previewHasSourceDims && Boolean(previewOverlaySrc);

  return (
    <div
  className="fixed inset-0 z-[100] flex items-stretch justify-center dash-overlay-backdrop dash-text-primary"
  onClick={onClose}
>
  <div
    className="flex flex-col lg:flex-row w-full max-w-[1800px] h-full max-h-[100dvh] dash-modal-surface border border-dash overflow-hidden shadow-2xl"
    onClick={(e) => e.stopPropagation()}
  >

    {/* ════════════════════════════════════════
        LEFT PANEL — File thumbnails grid
    ════════════════════════════════════════ */}
    <div className="hidden lg:flex w-[210px] xl:w-[240px] shrink-0 flex-col border-r border-dash dash-modal-aside overflow-hidden">

      {/* Panel header */}
      <div className="shrink-0 flex items-center justify-between px-3 py-2.5 border-b border-dash">
        <span className="text-[10px] font-bold uppercase tracking-widest dash-text-subtle">Files</span>
        <span className="text-[10px] tabular-nums dash-text-muted bg-[var(--dash-inset-bg)] border border-dash rounded px-1.5 py-0.5">
          {n}
        </span>
      </div>

      {/* Scrollable grid */}
      <div className="flex-1 overflow-y-auto min-h-0 p-2">
        {n === 0 ? (
          <div className="flex items-center justify-center h-full dash-text-subtle text-xs text-center px-4">
            No files in this batch
          </div>
        ) : isVideoJob ? (
          /* Video jobs — vertical list with wide thumbnails */
          <div className="flex flex-col gap-1.5">
            {files.map((f, i) => {
              const thumb = resolveMediaSrc(f.thumb_url || f.annotated_url);
              const dc = fileDefectCount(f, isVideoJob);
              const sel = i === safeIdx;
              return (
                <button
                  key={`${f.file_id ?? f.filename}-${i}`}
                  type="button"
                  onClick={() => setIdx(i)}
                  className={[
                    "flex items-center gap-2.5 rounded-lg border p-2 text-left transition-all duration-150",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400",
                    sel
                      ? "border-cyan-500/70 bg-cyan-500/10 ring-1 ring-cyan-500/30"
                      : "border-dash bg-[var(--dash-nested-bg-soft)] hover:border-[var(--dash-thumb-border-hover)] hover:bg-[var(--dash-hover-bg)]",
                  ].join(" ")}
                >
                  <div className="relative w-12 h-12 shrink-0 rounded-md overflow-hidden bg-[var(--dash-inset-bg)]">
                    {thumb ? (
                      <img src={thumb} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="absolute inset-0 flex items-center justify-center">
                        <ImageIcon className="h-4 w-4 text-[var(--dash-subtle)]" />
                      </span>
                    )}
                    {isMp4Url(f.video_url ?? undefined) && (
                      <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30">
                        <Video className="w-3.5 h-3.5 text-white drop-shadow" aria-hidden />
                      </span>
                    )}
                    {sel && (
                      <span className="absolute bottom-0.5 right-0.5 bg-emerald-500 rounded-full p-0.5 z-[1] shadow">
                        <Check size={7} className="text-white" strokeWidth={3} />
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] dash-text-primary truncate leading-snug mb-0.5" title={f.filename}>
                      {f.filename}
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <span className={`text-[9px] font-semibold ${dc > 0 ? "text-red-400" : "text-emerald-400"}`}>
                        {Array.isArray(f.detections) && f.detections.length > 0
                          ? `${uniqueDefectTypeCount(f.detections)} defect${uniqueDefectTypeCount(f.detections) !== 1 ? "s" : ""}`
                          : `${dc} defect${dc !== 1 ? "s" : ""}`}
                      </span>
                      {f.source === "thermal" && (
                        <span className="text-[8px] text-amber-400 font-bold uppercase tracking-wide">Thermal</span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          /* Image jobs — 2-column thumbnail grid */
          <div className="grid grid-cols-2 gap-1.5">
            {files.map((f, i) => {
              const thumb = resolveMediaSrc(f.thumb_url || f.annotated_url);
              const dc = fileDefectCount(f, isVideoJob);
              const sel = i === safeIdx;
              return (
                <button
                  key={`${f.file_id ?? f.filename}-${i}`}
                  type="button"
                  onClick={() => setIdx(i)}
                  className={[
                    "flex flex-col rounded-lg border p-1.5 text-left transition-all duration-150",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400",
                    sel
                      ? "border-cyan-500/70 bg-cyan-500/10 ring-1 ring-cyan-500/30"
                      : "border-dash bg-[var(--dash-nested-bg-soft)] hover:border-[var(--dash-thumb-border-hover)] hover:bg-[var(--dash-hover-bg)]",
                  ].join(" ")}
                >
                  <div className="relative aspect-square w-full overflow-hidden rounded-md bg-[var(--dash-inset-bg)] mb-1.5">
                    {thumb ? (
                      <img src={thumb} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="absolute inset-0 flex items-center justify-center">
                        <ImageIcon className="h-5 w-5 text-[var(--dash-subtle)]" />
                      </span>
                    )}
                    {sel && (
                      <span className="absolute bottom-0.5 right-0.5 bg-emerald-500 rounded-full p-0.5 z-[1] shadow">
                        <Check size={7} className="text-white" strokeWidth={3} />
                      </span>
                    )}
                    {dc > 0 && (
                      <span className="absolute top-0.5 left-0.5 bg-red-500/80 text-white text-[8px] font-bold rounded px-1 leading-4">
                        {dc}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 w-full px-0.5">
                    <div className="text-[9px] dash-text-primary truncate leading-snug" title={f.filename}>
                      {f.filename}
                    </div>
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className={`text-[8px] font-semibold ${dc > 0 ? "text-red-400" : "text-emerald-400"}`}>
                        {Array.isArray(f.detections) && f.detections.length > 0
                          ? `${uniqueDefectTypeCount(f.detections)}d`
                          : `${dc}d`}
                      </span>
                      {f.source === "thermal" && (
                        <span className="text-[8px] text-amber-400 font-bold uppercase">T</span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>

    {/* ════════════════════════════════════════
        CENTRE PANEL — Media viewer
    ════════════════════════════════════════ */}
    <div className="flex-1 relative flex flex-col min-w-0 bg-black min-h-[40vh] lg:min-h-0">

      {n > 0 && (
        <>
          {n > 1 && (
            <button
              type="button"
              onClick={() => setIdx(safeIdx - 1)}
              className="absolute left-2 top-1/2 -translate-y-1/2 z-10 rounded-full bg-[var(--dash-panel-bg)] hover:bg-[var(--dash-hover-bg)] p-2.5 border border-dash transition-colors"
              aria-label="Previous file"
            >
              <ChevronLeft size={22} />
            </button>
          )}
          {n > 1 && (
            <button
              type="button"
              onClick={() => setIdx(safeIdx + 1)}
              className={`absolute top-1/2 z-10 -translate-y-1/2 rounded-full border border-dash bg-[var(--dash-panel-bg)] p-2.5 hover:bg-[var(--dash-hover-bg)] transition-colors ${
                videoSrc ? "right-2 lg:right-[236px]" : "right-3"
              }`}
              aria-label="Next file"
            >
              <ChevronRight size={22} />
            </button>
          )}

          <div className="absolute top-3 right-3 z-10 rounded-md bg-[var(--dash-inset-bg)] px-2.5 py-1 text-xs font-Poppins dash-text-body border border-dash tabular-nums">
            {safeIdx + 1} / {n}
          </div>

          {!videoSrc && mainImg && (
            <div className="absolute top-3 left-3 z-10 flex items-center rounded-lg border border-dash bg-[var(--dash-inset-bg)] overflow-hidden">
              <button
                type="button"
                onClick={() =>
                  setBatchDetailImgZoom((z) => Math.max(RGB_PREVIEW_ZOOM_MIN, z - RGB_PREVIEW_ZOOM_STEP))
                }
                className="p-1.5 dash-text-primary hover:bg-[var(--dash-hover-bg)] transition-colors"
                aria-label="Zoom out"
              >
                <ZoomOut size={16} />
              </button>
              <span className="px-2 text-xs dash-text-body min-w-[3rem] text-center select-none">
                {Math.round(batchDetailImgZoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() =>
                  setBatchDetailImgZoom((z) => Math.min(RGB_PREVIEW_ZOOM_MAX, z + RGB_PREVIEW_ZOOM_STEP))
                }
                className="p-1.5 dash-text-primary hover:bg-[var(--dash-hover-bg)] transition-colors"
                aria-label="Zoom in"
              >
                <ZoomIn size={16} />
              </button>
              <button
                type="button"
                onClick={() => setBatchDetailImgZoom(1)}
                className="p-1.5 dash-text-primary hover:bg-[var(--dash-hover-bg)] border-l border-dash transition-colors"
                aria-label="Reset zoom"
              >
                <RotateCcw size={14} />
              </button>
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col pt-12 pb-6 lg:flex-row lg:items-stretch">
            <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto scrollbar-gutter-stable p-6">
              {videoSrc ? (
                <video
                  ref={batchDetailVideoRef}
                  key={videoSrc}
                  src={videoSrc}
                  controls
                  playsInline
                  className="max-h-[min(85vh,820px)] max-w-full rounded-xl border border-[var(--dash-preview-border)] shadow-lg"
                />
              ) : mainImg ? (
                <div
                  className="relative inline-block max-w-full rounded-xl transition-[transform] duration-150 ease-out"
                  style={{
                    transform: `scale(${batchDetailImgZoom})`,
                    transformOrigin: "center",
                  }}
                >
                  {showLiveThumbOverlay ? (
                    <>
                      <img
                        ref={batchDetailPreviewImgRef}
                        src={dashFilteredImgSrc}
                        alt={cur?.filename ?? ""}
                        className="max-h-[min(85vh,820px)] max-w-full object-contain rounded-xl border border-[var(--dash-preview-border)] block shadow-lg"
                        draggable={false}
                      />
                      <canvas
                        ref={batchDetailPreviewCanvasRef}
                        className="pointer-events-none absolute inset-0 h-full w-full rounded-xl"
                        aria-hidden
                      />
                    </>
                  ) : (
                    <img
                      src={mainImg}
                      alt={cur?.filename ?? ""}
                      className="max-h-[min(85vh,820px)] max-w-full object-contain rounded-xl border border-[var(--dash-preview-border)] shadow-lg"
                    />
                  )}
                </div>
              ) : (
                <div className="dash-text-subtle text-sm">No preview</div>
              )}
            </div>

            {videoSrc && cur && (
              <div className="flex max-h-[38vh] shrink-0 justify-center overflow-hidden lg:max-h-none lg:h-full lg:justify-start lg:self-stretch">
                <VideoAnnotatedFrameStrip
                  videoUrl={videoSrc}
                  duration={cur.duration ?? 0}
                  fps={cur.fps ?? 0}
                  framesAnalyzed={cur.frames_analyzed ?? 0}
                  mainVideoRef={batchDetailVideoRef}
                />
              </div>
            )}
          </div>
        </>
      )}

      {n === 0 && (
        <div className="flex-1 flex items-center justify-center dash-text-subtle text-sm p-8">
          No files in this batch
        </div>
      )}
    </div>

    {/* ════════════════════════════════════════
        RIGHT PANEL — Stats & details
    ════════════════════════════════════════ */}
    <div className="w-full lg:w-[380px] shrink-0 border-t lg:border-t-0 lg:border-l border-dash dash-modal-aside flex flex-col max-h-[55vh] lg:max-h-[100dvh] overflow-hidden">

      {/* Tab bar */}
      <div className="flex shrink-0 items-stretch border-b border-dash">
        <button
          type="button"
          onClick={() => setBatchDetailTab("image")}
          className={`flex-1 py-3 text-xs font-bold tracking-wide transition-colors ${
            batchDetailTab === "image"
              ? "text-cyan-300 border-b-2 border-cyan-400 bg-cyan-500/10"
              : "dash-text-subtle hover:text-[var(--dash-body)]"
          }`}
        >
          {isVideoJob ? "MEDIA" : "IMAGE"}
        </button>
        <button
          type="button"
          onClick={() => setBatchDetailTab("processing")}
          className={`flex-1 py-3 text-xs font-bold tracking-wide transition-colors ${
            batchDetailTab === "processing"
              ? "text-cyan-300 border-b-2 border-cyan-400 bg-cyan-500/10"
              : "dash-text-subtle hover:text-[var(--dash-body)]"
          }`}
        >
          PROCESSING
        </button>

        <div className="relative flex shrink-0 items-center justify-end border-l border-dash px-2 py-2">
          <DetectionClassFilterDropdown
            filterClassKeys={clsFilter.filterClassKeys}
            hiddenSet={clsFilter.hiddenSet}
            open={clsFilter.open}
            setOpen={clsFilter.setOpen}
            anchorRef={clsFilter.anchorRef}
            toggleKey={clsFilter.toggleKey}
            showAll={clsFilter.showAll}
            hideAll={clsFilter.hideAll}
            liveOverlayEnabled={!videoSrc && showLiveThumbOverlay}
          />
        </div>

        <button
          type="button"
          onClick={onClose}
          className="flex shrink-0 items-center justify-center px-3 border-l border-dash hover:bg-[var(--dash-hover-bg)] transition-colors"
          aria-label="Close"
        >
          <X size={18} className="dash-text-subtle" />
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {batchDetailTab === "image" ? (
          <div className="p-4 space-y-5">

            {/* Run ID + timestamp */}
            <div>
              <div className="text-[10px] uppercase tracking-widest dash-text-subtle mb-1">Run ID</div>
              <div className="font-Poppins text-sm dash-text-primary break-all leading-snug">{runId}</div>
              <div className="text-[11px] dash-text-muted mt-1">{shortAgo(created)}</div>
            </div>

            {/* Stats: top row Total files | Completed; full-width Detections below (reference layout) */}
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="dash-nested rounded-lg p-3 min-w-0">
                <div className="text-[10px] dash-text-subtle uppercase tracking-wide mb-1">Total files</div>
                <div className="text-xl font-semibold dash-text-primary tabular-nums">{totalFiles}</div>
              </div>
              <div className="dash-nested rounded-lg p-3 min-w-0">
                <div className="text-[10px] dash-text-subtle uppercase tracking-wide mb-1">Completed</div>
                <div className="text-xl font-semibold text-emerald-400 tabular-nums">{completed}</div>
              </div>
              <div className="col-span-2 dash-nested rounded-lg p-3 min-w-0">
                <div className="text-xs dash-text-subtle font-medium uppercase tracking-wide mb-1">Detections</div>
                {isVideoJob &&
                previewDetectionRows.length === 0 &&
                (cur?.total_detections ?? 0) > 0 &&
                batchDetailVideoDetsLoading ? (
                  <div className="text-sm font-semibold dash-text-subtle mt-0.5 animate-pulse">Loading…</div>
                ) : previewSidebarPartition ? (
                  <div
                    className={`flex flex-wrap items-center justify-center gap-x-4 text-sm font-semibold leading-snug mt-0.5 ${
                      previewSidebarPartition.defects.length > 0 ? "text-red-400" : "text-emerald-400"
                    }`}
                  >
                    <span>{previewSidebarPartition.components.length} components</span>
                    <span>{previewSidebarPartition.defects.length} defects</span>
                  </div>
                ) : (
                  <div
                    className={`text-xl font-semibold tabular-nums ${
                      defectsFound > 0 ? "text-red-400" : "text-emerald-400"
                    }`}
                  >
                    {defectsFound}
                  </div>
                )}
              </div>
            </div>

            {/* Current file info */}
            {cur && (
              <div className="dash-nested dash-nested-mid rounded-lg border border-dash p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] uppercase tracking-widest dash-text-subtle">Filename</span>
                  {cur.source === "thermal" && (
                    <span className="rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide">
                      Thermal
                    </span>
                  )}
                  {isVideoJob && (
                    <span className="rounded bg-violet-500/20 text-violet-300 border border-violet-500/40 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide">
                      Video
                    </span>
                  )}
                </div>
                <div className="text-xs dash-text-primary font-medium break-all leading-relaxed">{cur.filename}</div>
                {procMs != null && (
                  <div className="text-[11px] dash-text-muted pt-0.5">
                    Processing time:{" "}
                    <span className="text-[var(--dash-body)] font-medium">{Math.round(procMs)} ms</span>
                  </div>
                )}
              </div>
            )}

            {/* Mobile-only file list (hidden on lg where left panel shows) */}
            <div className="lg:hidden">
              <div className="text-[11px] font-semibold dash-text-primary uppercase tracking-widest mb-3">
                All Files
                <span className="ml-1.5 text-[10px] font-normal dash-text-muted normal-case">({n})</span>
              </div>
              <div
                className={[
                  isVideoJob ? "flex flex-col gap-2" : "grid grid-cols-3 gap-2",
                  "max-h-[240px] overflow-y-auto pr-1",
                ].join(" ")}
              >
                {files.map((f, i) => {
                  const thumb = resolveMediaSrc(f.thumb_url || f.annotated_url);
                  const dc = fileDefectCount(f, isVideoJob);
                  const sel = i === safeIdx;
                  return (
                    <button
                      key={`${f.file_id ?? f.filename}-${i}`}
                      type="button"
                      onClick={() => setIdx(i)}
                      className={[
                        "rounded-lg border text-left transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400",
                        isVideoJob ? "flex items-center gap-2.5 p-2" : "flex flex-col p-1.5",
                        sel
                          ? "border-cyan-500/70 bg-cyan-500/10 ring-1 ring-cyan-500/30"
                          : "border-dash bg-[var(--dash-nested-bg-soft)] hover:border-[var(--dash-thumb-border-hover)] hover:bg-[var(--dash-hover-bg)]",
                      ].join(" ")}
                    >
                      <div
                        className={
                          isVideoJob
                            ? "relative w-10 h-10 shrink-0 rounded-md overflow-hidden bg-[var(--dash-inset-bg)]"
                            : "relative aspect-square w-full overflow-hidden rounded-md bg-[var(--dash-inset-bg)] mb-1.5"
                        }
                      >
                        {thumb ? (
                          <img src={thumb} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <span className="absolute inset-0 flex items-center justify-center">
                            <ImageIcon className="h-4 w-4 text-[var(--dash-subtle)]" />
                          </span>
                        )}
                        {isVideoJob && isMp4Url(f.video_url ?? undefined) && (
                          <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30">
                            <Video className="w-3.5 h-3.5 text-white drop-shadow" aria-hidden />
                          </span>
                        )}
                        {sel && (
                          <span className="absolute bottom-0.5 right-0.5 bg-emerald-500 rounded-full p-0.5 z-[1] shadow">
                            <Check size={7} className="text-white" strokeWidth={3} />
                          </span>
                        )}
                        {!isVideoJob && dc > 0 && (
                          <span className="absolute top-0.5 left-0.5 bg-red-500/80 text-white text-[8px] font-bold rounded px-1 leading-4">
                            {dc}
                          </span>
                        )}
                      </div>
                      <div className={isVideoJob ? "min-w-0 flex-1" : "min-w-0 w-full"}>
                        <div className="text-[9px] dash-text-primary truncate leading-snug" title={f.filename}>
                          {f.filename}
                        </div>
                        <span className={`text-[8px] font-semibold ${dc > 0 ? "text-red-400" : "text-emerald-400"}`}>
                          {Array.isArray(f.detections) && f.detections.length > 0
                            ? `${uniqueDefectTypeCount(f.detections)}d`
                            : `${dc}d`}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Video detections loading */}
            {isVideoJob &&
              (cur?.total_detections ?? 0) > 0 &&
              batchDetailVideoDetsLoading &&
              previewDetectionRows.length === 0 && (
                <div className="text-xs dash-text-subtle animate-pulse">Loading defect list…</div>
              )}

            {/* Detection sidebar panels */}
            {previewSidebarPartition &&
              (previewSidebarPartition.components.length > 0 ||
                previewSidebarPartition.defects.length > 0) && (
                <div className="rounded-lg border border-dash overflow-hidden">
                  <DetectionSidebarBucketPanels partition={previewSidebarPartition} hideRowCounts />
                </div>
              )}
          </div>
        ) : (
          /* Processing tab */
          <div className="p-4 space-y-4 text-sm dash-text-body">
            <div className="text-[11px] font-semibold dash-text-primary uppercase tracking-widest">
              Batch Processing
            </div>
            <div className="dash-nested dash-nested-mid rounded-lg border border-dash p-3 space-y-2.5 text-xs">
              <div className="flex items-center justify-between gap-4">
                <span className="dash-text-subtle">Status</span>
                <span className="dash-text-primary font-semibold uppercase tracking-wide">
                  {(run?.status ?? "—").toString()}
                </span>
              </div>
              <div className="h-px bg-[var(--dash-border)] opacity-50" />
              <div className="flex items-center justify-between gap-4">
                <span className="dash-text-subtle">Job type</span>
                <span className="dash-text-primary">{isVideoJob ? "Video" : "Image"}</span>
              </div>
              <div className="h-px bg-[var(--dash-border)] opacity-50" />
              <div className="flex items-center justify-between gap-4">
                <span className="dash-text-subtle">Files completed</span>
                <span className="text-emerald-400 font-medium tabular-nums">
                  {completed} / {totalFiles}
                </span>
              </div>
              {isVideoJob && cur && (
                <>
                  <div className="h-px bg-[var(--dash-border)] opacity-50" />
                  <div className="flex items-center justify-between gap-4">
                    <span className="dash-text-subtle">Duration</span>
                    <span className="dash-text-primary tabular-nums">{cur.duration ?? "—"} s</span>
                  </div>
                  <div className="h-px bg-[var(--dash-border)] opacity-50" />
                  <div className="flex items-center justify-between gap-4">
                    <span className="dash-text-subtle">FPS / Frames</span>
                    <span className="dash-text-primary tabular-nums">
                      {cur.fps ?? "—"} / {cur.frames_analyzed ?? "—"}
                    </span>
                  </div>
                </>
              )}
            </div>
            <p className="text-[11px] dash-text-subtle leading-relaxed">
              Per-file timings and pipeline stages appear here for traceability.
            </p>
          </div>
        )}
      </div>

      {/* Footer CTA */}
      <div className="shrink-0 border-t border-dash p-3">
        <Link
          to={`/runs/${runId}`}
          className="flex items-center justify-center gap-2 w-full rounded-lg bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 py-2.5 text-xs font-semibold hover:bg-cyan-500/30 transition-colors"
          onClick={onClose}
        >
          Open full run page
          <ChevronRight size={14} />
        </Link>
      </div>
    </div>

  </div>
</div>
  );
}

function RecentUploadThumbnailSlider({
  runId,
  urls,
  loading,
}: {
  runId: string;
  urls: string[];
  loading: boolean;
}) {
  const [idx, setIdx] = useState(0);
  const reduceMotion = useReducedMotion();
  const slideUrls = urls.slice(0, RECENT_UPLOADS_CAROUSEL_MAX);
  useEffect(() => {
    setIdx(0);
  }, [runId, slideUrls.length, slideUrls[0] ?? ""]);
  useEffect(() => {
    if (slideUrls.length <= 1) return;
    const ms = reduceMotion ? 4500 : 2800;
    const t = setInterval(() => {
      setIdx((i) => (i + 1) % slideUrls.length);
    }, ms);
    return () => clearInterval(t);
  }, [slideUrls.length, reduceMotion]);
  useEffect(() => {
    setIdx((i) => (slideUrls.length === 0 ? 0 : Math.min(i, slideUrls.length - 1)));
  }, [slideUrls.length]);
  if (loading && slideUrls.length === 0) {
    return (
      <div className="absolute inset-0 bg-[var(--dash-inset-bg)] animate-pulse flex items-center justify-center">
        <Clock className="text-[var(--dash-subtle)] w-6 h-6 animate-spin" />
      </div>
    );
  }
  if (slideUrls.length === 0) {
    return (
      <div className="absolute inset-0 bg-[var(--dash-inset-bg)] flex items-center justify-center">
        <ImageIcon className="w-7 h-7 text-[var(--dash-subtle)]" />
      </div>
    );
  }
  return (
    <div className="absolute inset-0 bg-[var(--dash-media-bg)] overflow-hidden">
      {slideUrls.map((u, i) => (
        <img
          key={`${runId}-${u}-${i}`}
          src={u}
          alt=""
          className={`absolute inset-0 w-full h-full object-cover ease-in-out pointer-events-none ${
            reduceMotion ? "transition-opacity duration-200" : "transition-opacity duration-700"
          } ${i === idx ? "opacity-100 z-[1]" : "opacity-0 z-0"}`}
          loading={i === 0 ? "eager" : "lazy"}
          decoding="async"
        />
      ))}
      {slideUrls.length > 1 && (
        <div className="absolute bottom-1 left-1/2 -translate-x-1/2 z-[2] rounded-full bg-black/65 px-1.5 py-0.5 text-[9px] text-neutral-200 font-Poppins tabular-nums">
          {idx + 1}/{slideUrls.length}
        </div>
      )}
    </div>
  );
}

type StatusDistRow = {
  name: string;
  value: number;
  color: string;
  track: string;
  pct: number;
};

type StatusDonutChartTokens = {
  pieCell: string;
  pieStroke: string;
  statusDonutConnector: string;
  ttBg: string;
  ttBorderCyan: string;
  ttShadow: string;
  ttLabel: string;
  ttItem: string;
};

function StatusDonutChart({
  pieData,
  chart,
  reduceMotion,
  innerRadius,
  outerRadius,
  center,
}: {
  pieData: StatusDistRow[];
  chart: StatusDonutChartTokens;
  reduceMotion: boolean;
  innerRadius: number;
  outerRadius: number;
  center: React.ReactNode;
}) {
  return (
    <>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={pieData}
            cx="50%"
            cy="50%"
            innerRadius={innerRadius}
            outerRadius={outerRadius}
            paddingAngle={2}
            dataKey="value"
            nameKey="name"
            strokeWidth={1}
            stroke={chart.pieCell}
            startAngle={90}
            endAngle={-270}
            isAnimationActive={!reduceMotion}
            animationDuration={780}
            animationBegin={100}
            animationEasing="ease-out"
          >
            {pieData.map((entry) => (
              <Cell key={entry.name} fill={entry.color} stroke={chart.pieCell} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              backgroundColor: chart.ttBg,
              border: `1px solid ${chart.ttBorderCyan}`,
              borderRadius: "8px",
              fontSize: "12px",
              boxShadow: chart.ttShadow,
            }}
            labelStyle={{ color: chart.ttLabel }}
            itemStyle={{ color: chart.ttItem }}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        {center}
      </div>
    </>
  );
}

function StatusDistributionInfographic({
  rows,
  pieData,
  total,
  chart,
  reduceMotion,
}: {
  rows: StatusDistRow[];
  pieData: StatusDistRow[];
  total: number;
  chart: StatusDonutChartTokens;
  reduceMotion: boolean;
}) {
  const leftCol = rows.slice(0, 2);
  const rightCol = rows.slice(2, 4);
  const lineStroke = chart.statusDonutConnector;

  const rowBlock = (row: StatusDistRow, side: "left" | "right", slotIndex: number) => {
    const tipY = slotIndex === 0 ? 11 : 25;
    const elbowD =
      side === "left"
        ? `M 56 ${tipY} L 52 ${tipY} L 52 18 L 0 18`
        : `M 0 ${tipY} L 4 ${tipY} L 4 18 L 56 18`;
    const textBlock = (
      <div
        className={`min-w-0 flex-1 max-w-[11rem] xl:max-w-[13rem] ${side === "left" ? "text-right" : "text-left"}`}
      >
        <div className="text-sm font-semibold dash-text-primary tracking-tight" style={{ fontFamily: '"Outfit", sans-serif' }}>
          {row.name}
        </div>
        <div className="text-xs dash-text-muted mt-0.5 font-medium">
          {row.value} {row.value === 1 ? "upload" : "uploads"} · {total > 0 ? `${row.pct}%` : "0%"}
        </div>
      </div>
    );
    const swatch = (
      <span
        className="h-3 w-3 shrink-0 rounded-full shadow-sm ring-2 ring-[var(--dash-panel-border)]"
        style={{ backgroundColor: row.color }}
        aria-hidden
      />
    );
    const connector = (
      <svg className="h-9 w-11 xl:w-[3.25rem] shrink-0 overflow-visible" viewBox="0 0 56 36" aria-hidden>
        <motion.path
          d={elbowD}
          fill="none"
          stroke={lineStroke}
          strokeWidth={1.35}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: reduceMotion ? 1 : 0, opacity: reduceMotion ? 0.9 : 0.35 }}
          animate={{ pathLength: 1, opacity: 0.9 }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : {
                  pathLength: { duration: 0.68, ease: [0.22, 1, 0.36, 1], delay: 0.06 * slotIndex },
                  opacity: { duration: 0.35, delay: 0.06 * slotIndex },
                }
          }
        />
      </svg>
    );
    return (
      <div
        key={row.name}
        className={`flex items-center gap-2 w-full ${side === "left" ? "flex-row justify-end" : "flex-row justify-start"}`}
      >
        {side === "left" ? (
          <>
            {textBlock}
            {swatch}
            <div className="hidden lg:block">{connector}</div>
          </>
        ) : (
          <>
            <div className="hidden lg:block">{connector}</div>
            {swatch}
            {textBlock}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="w-full">
      {/* Mobile: center donut + legend rows (swatch only, no mini donuts) */}
      <div className="flex flex-col items-stretch gap-5 lg:hidden">
        <div className="relative mx-auto flex h-[192px] w-[192px] shrink-0 items-center justify-center">
          {pieData.length > 0 ? (
            <StatusDonutChart
              pieData={pieData}
              chart={chart}
              reduceMotion={reduceMotion}
              innerRadius={56}
              outerRadius={78}
              center={
                <>
                  <span
                    className="text-3xl font-bold tabular-nums dash-text-primary tracking-tight"
                    style={{ fontFamily: '"Outfit", sans-serif' }}
                  >
                    {total}
                  </span>
                  <span className="text-[10px] font-semibold uppercase tracking-wider dash-text-muted mt-0.5">
                    TOTAL UPLOADS
                  </span>
                </>
              }
            />
          ) : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {rows.map((row) => (
            <div
              key={row.name}
              className="flex items-center gap-3 rounded-xl border border-dash px-3 py-2.5 dash-inset-pill"
            >
              <span
                className="h-3 w-3 shrink-0 rounded-full shadow-sm ring-2 ring-[var(--dash-panel-border)]"
                style={{ backgroundColor: row.color }}
                aria-hidden
              />
              <div className="min-w-0">
                <div className="text-sm font-semibold dash-text-primary" style={{ fontFamily: '"Outfit", sans-serif' }}>
                  {row.name}
                </div>
                <div className="text-xs dash-text-muted">
                  {row.value} · {total > 0 ? `${row.pct}%` : "0%"}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Desktop: labels separated from center donut (infographic spacing) */}
      <div className="hidden lg:flex lg:flex-row lg:items-center lg:justify-between lg:gap-4 min-h-[220px] px-1">
        <div className="flex flex-col justify-center gap-6 flex-1 min-w-0 max-w-[200px] xl:max-w-[220px]">
          {leftCol.map((r, i) => rowBlock(r, "left", i))}
        </div>

        <div className="relative flex h-[200px] w-[200px] xl:h-[220px] xl:w-[220px] shrink-0 items-center justify-center">
          {pieData.length > 0 ? (
            <StatusDonutChart
              pieData={pieData}
              chart={chart}
              reduceMotion={reduceMotion}
              innerRadius={58}
              outerRadius={84}
              center={
                <>
                  <span
                    className="text-3xl xl:text-[2rem] font-bold tabular-nums dash-text-primary tracking-tight"
                    style={{ fontFamily: '"Outfit", sans-serif' }}
                  >
                    {total}
                  </span>
                  <span className="text-[10px] font-semibold uppercase tracking-wider dash-text-muted mt-0.5 text-center px-2">
                    TOTAL UPLOADS
                  </span>
                </>
              }
            />
          ) : null}
        </div>

        <div className="flex flex-col justify-center gap-6 flex-1 min-w-0 max-w-[200px] xl:max-w-[220px]">
          {rightCol.map((r, i) => rowBlock(r, "right", i))}
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [latestBulkBatch, setLatestBulkBatch] = useState<any>(null);
  const [recentBulkBatches, setRecentBulkBatches] = useState<any[]>([]);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [bulkBatchesDropdownOpen, setBulkBatchesDropdownOpen] = useState(false);
  const [latestBulkBatchDropdownOpen, setLatestBulkBatchDropdownOpen] = useState(false);
  const [timeRange, setTimeRange] = useState<TimeRange>("7d");
  const [customFrom, setCustomFrom] = useState<string>("");
  const [customTo, setCustomTo] = useState<string>("");
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [selectedRecentRunId, setSelectedRecentRunId] = useState<string | null>(null);
  const [recentRunGallery, setRecentRunGallery] = useState<
    Record<string, { loading: boolean; urls: string[]; filenames: string[] }>
  >({});
  const [recentUploadPreview, setRecentUploadPreview] = useState<{
    runId: string;
    imageUrl: string;
    filename?: string;
    /** When set, quick preview uses a video player (video batch / annotated mp4). */
    videoUrl?: string;
    duration?: number;
    fps?: number;
    framesAnalyzed?: number;
  } | null>(null);
  const recentQuickPreviewVideoRef = useRef<HTMLVideoElement>(null);
  const batchDetailVideoRef = useRef<HTMLVideoElement>(null);
  const [recentBatchDetail, setRecentBatchDetail] = useState<{ runId: string; fileIndex: number } | null>(
    null
  );
  const [thermalDetailResults, setThermalDetailResults] = useState<Record<string, unknown>[] | null>(null);
  const [thermalDetailJobMeta, setThermalDetailJobMeta] = useState<{
    palette?: number | null;
    object_type?: string | null;
  } | null>(null);
  const [thermalDetailLoading, setThermalDetailLoading] = useState(false);
  const [dashThermalRoiActive, setDashThermalRoiActive] = useState(false);
  const [dashThermalRoiStart, setDashThermalRoiStart] = useState<{ x: number; y: number } | null>(null);
  const [dashThermalRoiEnd, setDashThermalRoiEnd] = useState<{ x: number; y: number } | null>(null);
  const [dashThermalRoiStats, setDashThermalRoiStats] = useState<ThermalStats | null>(null);
  const [dashThermalRoiLoading, setDashThermalRoiLoading] = useState(false);
  const [batchDetailTab, setBatchDetailTab] = useState<"image" | "processing">("image");
  const [batchDetailVideoDets, setBatchDetailVideoDets] = useState<unknown[]>([]);
  const [batchDetailVideoDetsLoading, setBatchDetailVideoDetsLoading] = useState(false);
  const [batchDetailImgZoom, setBatchDetailImgZoom] = useState(1);
  const reduceMotion = useReducedMotion();
  const { theme } = useTheme();
  const chart = useMemo(() => {
    const L = theme === "light";
    return {
      grid: L ? "rgba(100,116,139,0.22)" : "rgba(148,163,184,0.18)",
      axis: L ? "rgba(71,85,105,0.9)" : "rgba(148,163,184,0.85)",
      ttBg: L ? "rgba(255,255,255,0.97)" : "rgba(15, 20, 25, 0.92)",
      ttBorderCyan: L ? "rgba(13, 148, 136, 0.45)" : "rgba(45, 212, 191, 0.38)",
      ttShadow: L ? "0 18px 48px rgba(15,23,42,0.1)" : "0 18px 48px rgba(0,0,0,0.45)",
      ttLabel: L ? "rgba(15,23,42,0.9)" : "rgba(226,232,240,0.9)",
      ttItem: L ? "rgba(30,41,59,0.94)" : "rgba(226,232,240,0.92)",
      cursorCyan: L ? "rgba(20, 184, 166, 0.18)" : "rgba(45, 212, 191, 0.12)",
      cursorAmber: L ? "rgba(249, 115, 22, 0.18)" : "rgba(251, 146, 60, 0.14)",
      pieLabel: L ? "rgba(15,23,42,0.94)" : "rgba(226,232,240,0.92)",
      pieStroke: L ? "rgba(255,255,255,0.95)" : "rgba(0,0,0,0.55)",
      statusDonutConnector: L ? "rgba(15, 23, 42, 0.5)" : "rgba(248, 250, 252, 0.88)",
      pieCell: L ? "rgba(100, 116, 139, 0.18)" : "rgba(148, 163, 184, 0.2)",
      barStrokeCyan: L ? "rgba(13, 148, 136, 0.35)" : "rgba(45, 212, 191, 0.45)",
      barStrokeAmber: L ? "rgba(234, 88, 12, 0.35)" : "rgba(251, 146, 60, 0.4)",
      ttBorderAmber: L ? "rgba(249, 115, 22, 0.45)" : "rgba(251, 146, 60, 0.4)",
      /** Status donut — semantic quartet, balanced on light / dark UI */
      status: {
        Completed: {
          fill: L ? "#059669" : "#4ade80",
          track: L ? "#ecfdf5" : "rgba(30, 41, 55, 0.88)",
        },
        Processing: {
          fill: L ? "#d97706" : "#fbbf24",
          track: L ? "#fffbeb" : "rgba(30, 41, 55, 0.88)",
        },
        Failed: {
          fill: L ? "#e11d48" : "#fb7185",
          track: L ? "#fff1f2" : "rgba(30, 41, 55, 0.88)",
        },
        Pending: {
          fill: L ? "#6366f1" : "#a5b4fc",
          track: L ? "#eef2ff" : "rgba(30, 41, 55, 0.88)",
        },
      },
      /** Uploads — teal ladder (depth → highlight) */
      uploadsBarStops: L
        ? ["#0f766e", "#14b8a6", "#99f6e4"]
        : ["#5eead4", "#2dd4bf", "#0f766e"],
      /** Needs review — warm orange ladder */
      needsReviewBarStops: L
        ? ["#c2410c", "#f97316", "#fdba74"]
        : ["#fb923c", "#ea580c", "#7c2d12"],
    };
  }, [theme]);

  /** Quick actions + hero carousel: light = high-contrast cards (not dark-glass tints). */
  const dashHero = useMemo(() => {
    const L = theme === "light";
    return {
      quickRgb: L
        ? "block rounded-xl border border-cyan-200/90 bg-gradient-to-br from-white via-cyan-50/90 to-sky-100/50 p-3 text-left shadow-sm shadow-slate-900/[0.04] hover:border-cyan-400 hover:shadow-md hover:shadow-cyan-600/10 transition-all group"
        : "block rounded-xl border border-cyan-500/30 bg-gradient-to-br from-cyan-900/20 to-blue-900/10 p-3 text-left hover:border-cyan-500/60 transition-all group",
      quickThermal: L
        ? "block rounded-xl border border-orange-200/90 bg-gradient-to-br from-white via-orange-50/90 to-amber-50/50 p-3 text-left shadow-sm shadow-slate-900/[0.04] hover:border-orange-400 hover:shadow-md hover:shadow-orange-600/10 transition-all group"
        : "block rounded-xl border border-orange-500/30 bg-gradient-to-br from-orange-900/20 to-red-900/10 p-3 text-left hover:border-orange-500/60 transition-all group",
      quickVideo: L
        ? "block rounded-xl border border-violet-200/90 bg-gradient-to-br from-white via-violet-50/90 to-indigo-50/50 p-3 text-left shadow-sm shadow-slate-900/[0.04] hover:border-violet-400 hover:shadow-md hover:shadow-violet-600/10 transition-all group"
        : "block rounded-xl border border-purple-500/30 bg-gradient-to-br from-purple-900/20 to-indigo-900/10 p-3 text-left hover:border-purple-500/60 transition-all group",
      quickIconRgb: L
        ? "w-9 h-9 rounded-lg bg-cyan-100 flex items-center justify-center shrink-0 ring-1 ring-cyan-200/80"
        : "w-9 h-9 rounded-lg bg-cyan-500/20 flex items-center justify-center shrink-0",
      quickIconThermal: L
        ? "w-9 h-9 rounded-lg bg-orange-100 flex items-center justify-center shrink-0 ring-1 ring-orange-200/80"
        : "w-9 h-9 rounded-lg bg-orange-500/20 flex items-center justify-center shrink-0",
      quickIconVideo: L
        ? "w-9 h-9 rounded-lg bg-violet-100 flex items-center justify-center shrink-0 ring-1 ring-violet-200/80"
        : "w-9 h-9 rounded-lg bg-purple-500/20 flex items-center justify-center shrink-0",
      quickGlyphRgb: L ? "text-cyan-600" : "text-cyan-400",
      quickGlyphThermal: L ? "text-orange-600" : "text-orange-400",
      quickGlyphVideo: L ? "text-violet-600" : "text-purple-400",
      quickTitle: L ? "text-xs font-semibold text-slate-800 leading-tight tracking-tight" : "text-xs font-semibold text-white leading-tight",
      arrow: L
        ? "p-2 rounded-full bg-white/95 hover:bg-white border border-slate-200 hover:border-cyan-400/50 shadow-md text-slate-700 transition-colors"
        : "p-2 rounded-full bg-black/30 hover:bg-black/50 border border-neutral-700 hover:border-cyan-400/50 transition-colors",
      arrowIcon: L ? "text-slate-800" : "text-white",
    };
  }, [theme]);

  const howItWorksCount = HOW_IT_WORKS_SLIDES.length;
  const howItWorksAutoplayRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const restartHowItWorksAutoplay = useCallback(() => {
    if (howItWorksAutoplayRef.current) {
      clearInterval(howItWorksAutoplayRef.current);
      howItWorksAutoplayRef.current = null;
    }
    howItWorksAutoplayRef.current = setInterval(() => {
      setCurrentSlide((prev) => (prev + 1) % howItWorksCount);
    }, HOW_IT_WORKS_INTERVAL_MS);
  }, [howItWorksCount]);

  useEffect(() => {
    restartHowItWorksAutoplay();
    return () => {
      if (howItWorksAutoplayRef.current) {
        clearInterval(howItWorksAutoplayRef.current);
        howItWorksAutoplayRef.current = null;
      }
    };
  }, [restartHowItWorksAutoplay]);

  const goHowItWorksPrev = useCallback(() => {
    setCurrentSlide((prev) => (prev - 1 + howItWorksCount) % howItWorksCount);
    restartHowItWorksAutoplay();
  }, [howItWorksCount, restartHowItWorksAutoplay]);

  const goHowItWorksNext = useCallback(() => {
    setCurrentSlide((prev) => (prev + 1) % howItWorksCount);
    restartHowItWorksAutoplay();
  }, [howItWorksCount, restartHowItWorksAutoplay]);

  const goHowItWorksIndex = useCallback(
    (index: number) => {
      setCurrentSlide(index);
      restartHowItWorksAutoplay();
    },
    [restartHowItWorksAutoplay]
  );

  useEffect(() => {
    setLoading(true);
    setError(null);
    getRuns()
      .then(setRuns)
      .catch((e) => {
        const msg = e instanceof Error ? e.message : "Failed to load uploads";
        setError(msg);
        toast.error(msg, 5000);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    // Fetch latest bulk batch
    getLatestBulkBatch()
      .then(setLatestBulkBatch)
      .catch(() => {
        // Silently fail if no bulk batches exist
        setLatestBulkBatch(null);
      });
    
    // Fetch recent bulk batches
    getRecentBulkBatches(5)
      .then(setRecentBulkBatches)
      .catch(() => {
        // Silently fail if no bulk batches exist
        setRecentBulkBatches([]);
      });
  }, []);

  const sortedRuns = useMemo(() => {
    return [...runs].sort((a, b) => runTime(b) - runTime(a));
  }, [runs]);

  const { start: rangeStart, end: rangeEnd } = useMemo(
    () => getTimeRangeBounds(timeRange, customFrom ? new Date(customFrom) : undefined, customTo ? new Date(customTo) : undefined),
    [timeRange, customFrom, customTo]
  );

  const filteredRuns = useMemo(() => {
    if (timeRange === "all") return runs;
    return runs.filter((r) => {
      const t = runTime(r);
      return t >= rangeStart && t <= rangeEnd;
    });
  }, [runs, timeRange, rangeStart, rangeEnd]);

  const kpis = useMemo(() => {
    const total = filteredRuns.length;
    const completed = filteredRuns.filter((r) => r.status === "completed").length;
    const processing = filteredRuns.filter((r) => r.status === "processing").length;
    const failed = filteredRuns.filter((r) => r.status === "failed").length;
    const needsReview = filteredRuns.reduce((s, r) => s + (r.must_review_count ?? 0), 0);
    const criticalFindings = filteredRuns.reduce((s, r) => s + (r.findings_count ?? 0), 0);
    const rgbFindings = filteredRuns.reduce((s, r) => s + ((r as any).rgb_findings ?? 0), 0);
    const thermalFindings = filteredRuns.reduce((s, r) => s + ((r as any).thermal_findings ?? 0), 0);
    const confidences = filteredRuns
      .map((r) => r.avg_confidence ?? r.ai_confidence)
      .filter((v): v is number => typeof v === "number");
    const avgConf = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;
    return { total, completed, processing, failed, needsReview, criticalFindings, rgbFindings, thermalFindings, avgConf };
  }, [filteredRuns]);

  const topDefectTypes = useMemo(() => {
    const counts: Record<string, number> = {};
    const add = (batch: { organization?: { folders?: Record<string, number> } }) => {
      const folders = batch?.organization?.folders ?? {};
      Object.entries(folders).forEach(([k, v]) => {
        counts[k] = (counts[k] ?? 0) + v;
      });
    };
    if (latestBulkBatch) add(latestBulkBatch);
    recentBulkBatches.forEach(add);
    return Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([name, value]) => ({ name: name.replace(/_/g, " "), value }));
  }, [latestBulkBatch, recentBulkBatches]);

  const chartStart = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - DAYS);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, []);

  const runsPerDay = useMemo(() => {
    const byDay: Record<string, { runs: number; mustReview: number }> = {};
    for (let i = 0; i < DAYS; i++) {
      const d = new Date(chartStart);
      d.setDate(d.getDate() + i);
      const k = d.toISOString().slice(0, 10);
      byDay[k] = { runs: 0, mustReview: 0 };
    }
    filteredRuns.forEach((r) => {
      const k = dayKey(r);
      if (!k || runTime(r) < chartStart) return;
      if (!byDay[k]) byDay[k] = { runs: 0, mustReview: 0 };
      byDay[k].runs += 1;
      byDay[k].mustReview += r.must_review_count ?? 0;
    });
    return Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date: date.slice(5), runs: v.runs, mustReview: v.mustReview }));
  }, [filteredRuns, chartStart]);

  const statusDistribution = useMemo(() => {
    const completed = filteredRuns.filter((r) => r.status === "completed").length;
    const processing = filteredRuns.filter((r) => r.status === "processing").length;
    const failed = filteredRuns.filter((r) => r.status === "failed").length;
    const pending = filteredRuns.filter((r) => r.status === "pending").length;
    const total = completed + processing + failed + pending;
    const order = ["Completed", "Processing", "Failed", "Pending"] as const;
    const vals = { Completed: completed, Processing: processing, Failed: failed, Pending: pending };
    const rows: StatusDistRow[] = order.map((name) => {
      const value = vals[name];
      const spec = chart.status[name];
      return {
        name,
        value,
        color: spec.fill,
        track: spec.track,
        pct: total > 0 ? Math.round((value / total) * 100) : 0,
      };
    });
    const pieData = rows.filter((d) => d.value > 0);
    return { rows, pieData, total };
  }, [filteredRuns, chart]);

  const recentRuns = useMemo(
    () => [...filteredRuns].sort((a, b) => runTime(b) - runTime(a)).slice(0, RECENT_UPLOADS_LIMIT),
    [filteredRuns]
  );

  const recentRunIdsKey = useMemo(
    () => recentRuns.map((r) => r.run_id ?? r.id).join("|"),
    [recentRuns]
  );

  useEffect(() => {
    const ids = new Set(recentRuns.map((r) => r.run_id ?? r.id));
    if (selectedRecentRunId && !ids.has(selectedRecentRunId)) {
      setSelectedRecentRunId(null);
    }
  }, [recentRuns, selectedRecentRunId]);

  useEffect(() => {
    if (!recentRunIdsKey) return;
    const ids = recentRunIdsKey.split("|").filter(Boolean);
    let cancelled = false;
  
    setRecentRunGallery((prev) => {
      const next = { ...prev };
  
      for (const run of recentRuns) {
        const runId = run.run_id ?? run.id;
        const isThermal = Boolean((run as unknown as { thermal_analysis_job?: boolean })?.thermal_analysis_job);
  
        if (isThermal) {
          next[runId] = {
            loading: true,
            urls: prev[runId]?.urls ?? [],
            filenames: prev[runId]?.filenames ?? [],
          };
          continue;
        }
  
        const embedded = extractUrlsFromRunPayload(run);
        if (embedded.urls.length > 0) {
          next[runId] = { loading: false, urls: embedded.urls, filenames: embedded.filenames };
        } else {
          next[runId] = {
            loading: true,
            urls: prev[runId]?.urls ?? [],
            filenames: prev[runId]?.filenames ?? [],
          };
        }
      }
  
      return next;
    });
  
    void Promise.all(
      ids.map(async (runId) => {
        const run = recentRuns.find((r) => (r.run_id ?? r.id) === runId);
        const isThermal = Boolean((run as unknown as { thermal_analysis_job?: boolean })?.thermal_analysis_job);
  
        let urls: string[] = [];
        let filenames: string[] = [];
  
        try {
          if (isThermal) {
            const res = await fetch(`/api/thermal/batch/results/${encodeURIComponent(runId)}`);
            if (res.ok) {
              const data = await res.json();
              const results = Array.isArray(data?.results) ? data.results : [];
  
              urls = results
                .map((r: any) =>
                  resolveMediaSrc(
                    r.original_image_url ||
                    r.thermal_rjpeg_url ||
                    r.thermal_image_url ||
                    ""
                  )
                )
                .filter(Boolean);
  
              filenames = results.map((r: any) => r.filename || r.file_id || "thermal");
            }
          } else {
            const embedded = run
              ? extractUrlsFromRunPayload(run)
              : { urls: [] as string[], filenames: [] as string[] };
  
            if (embedded.urls.length > 0) {
              urls = embedded.urls;
              filenames = embedded.filenames;
            } else {
              const items = await listOverlays(runId);
              if (items.length > 0) {
                urls = items.map((it) => overlayItemSrc(runId, it));
                filenames = items.map((it) => it.filename);
              } else {
                const detail = await getRun(runId);
                const art = detail.artifacts;
                const u =
                  art
                    ? resolveArtifactUrl(art, runId, "overlay") ||
                      resolveArtifactUrl(art, runId, "annotated")
                    : undefined;
  
                if (u) {
                  urls = [mediaUrl(u)];
                  filenames = ["preview"];
                }
              }
            }
          }
        } catch {
          /* ignore */
        }
  
        if (!cancelled) {
          setRecentRunGallery((prev) => ({
            ...prev,
            [runId]: { loading: false, urls, filenames },
          }));
        }
      })
    );
  
    return () => {
      cancelled = true;
    };
  }, [recentRunIdsKey, recentRuns]);

  useEffect(() => {
    if (!recentBatchDetail) {
      setThermalDetailResults(null);
      setThermalDetailJobMeta(null);
      setThermalDetailLoading(false);
      return;
    }
    const run = runs.find((r) => (r.run_id ?? r.id) === recentBatchDetail.runId);
    const isDjiThermal = Boolean((run as unknown as { thermal_analysis_job?: boolean })?.thermal_analysis_job);
    if (!isDjiThermal) {
      setThermalDetailResults(null);
      setThermalDetailJobMeta(null);
      setThermalDetailLoading(false);
      return;
    }
    let cancelled = false;
    setThermalDetailLoading(true);
    setThermalDetailResults(null);
    setThermalDetailJobMeta(null);
    fetch(`/api/thermal/batch/results/${encodeURIComponent(recentBatchDetail.runId)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("not thermal batch"))))
      .then((data) => {
        if (!cancelled) {
          setThermalDetailResults(Array.isArray(data.results) ? data.results : []);
          setThermalDetailJobMeta({
            palette: typeof data.palette === "number" ? data.palette : null,
            object_type: data.object_type != null ? String(data.object_type) : null,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setThermalDetailResults([]);
          setThermalDetailJobMeta(null);
        }
      })
      .finally(() => {
        if (!cancelled) setThermalDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [recentBatchDetail, runs]);

  useEffect(() => {
    if (!recentBatchDetail) return;
    const run = runs.find((r) => (r.run_id ?? r.id) === recentBatchDetail.runId);
    const isDjiThermal = Boolean((run as unknown as { thermal_analysis_job?: boolean })?.thermal_analysis_job);
    const gal = recentRunGallery[recentBatchDetail.runId];
    const nNav = Math.max(gal?.urls?.length ?? 0, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRecentBatchDetail(null);
      if (!isDjiThermal || nNav <= 0) return;
      if (e.key === "ArrowLeft") {
        setRecentBatchDetail((prev) =>
          prev ? { ...prev, fileIndex: Math.max(0, prev.fileIndex - 1) } : null
        );
      }
      if (e.key === "ArrowRight") {
        setRecentBatchDetail((prev) =>
          prev ? { ...prev, fileIndex: Math.min(nNav - 1, prev.fileIndex + 1) } : null
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recentBatchDetail, runs, recentRunGallery]);

  const batchDetailRun = useMemo(
    () =>
      recentBatchDetail ? runs.find((r) => (r.run_id ?? r.id) === recentBatchDetail.runId) : undefined,
    [runs, recentBatchDetail]
  );

  useEffect(() => {
    if (!recentBatchDetail || !batchDetailRun) {
      setBatchDetailVideoDets([]);
      setBatchDetailVideoDetsLoading(false);
      return;
    }
    if (Boolean((batchDetailRun as unknown as { thermal_analysis_job?: boolean }).thermal_analysis_job)) {
      setBatchDetailVideoDets([]);
      setBatchDetailVideoDetsLoading(false);
      return;
    }
    if (!isVideoStyleRun(batchDetailRun)) {
      setBatchDetailVideoDets([]);
      setBatchDetailVideoDetsLoading(false);
      return;
    }
    const runId = recentBatchDetail.runId;
    const apiFiles = (batchDetailRun as unknown as { files?: DashboardRunFile[] })?.files;
    const gal = recentRunGallery[runId];
    const synthetic: DashboardRunFile[] =
      (gal?.urls ?? []).map((url, j) => ({
        filename: gal.filenames[j] || `Image ${j + 1}`,
        annotated_url: url,
        thumb_url: url,
        detections: [],
        stats: { total_defects: 0, avg_confidence: 0 },
      })) ?? [];
    const files: DashboardRunFile[] = apiFiles?.length ? apiFiles : synthetic;
    const n = files.length;
    const safeIdx = n === 0 ? 0 : Math.min(Math.max(0, recentBatchDetail.fileIndex), n - 1);
    const curF = files[safeIdx];
    if (!curF) {
      setBatchDetailVideoDets([]);
      setBatchDetailVideoDetsLoading(false);
      return;
    }
    const embedded = curF.detections;
    if (Array.isArray(embedded) && embedded.length > 0) {
      setBatchDetailVideoDets(embedded);
      setBatchDetailVideoDetsLoading(false);
      return;
    }
    const rid = dashboardVideoResultsFolderId(curF);
    if (!rid) {
      setBatchDetailVideoDets([]);
      setBatchDetailVideoDetsLoading(false);
      return;
    }
    setBatchDetailVideoDetsLoading(true);
    setBatchDetailVideoDets([]);
    let cancelled = false;
    fetch(`/api/video/detections/${encodeURIComponent(rid)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("missing"))))
      .then((data) => {
        if (!cancelled) setBatchDetailVideoDets(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setBatchDetailVideoDets([]);
      })
      .finally(() => {
        if (!cancelled) setBatchDetailVideoDetsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [recentBatchDetail, batchDetailRun, recentRunGallery]);

  useEffect(() => {
    setBatchDetailImgZoom(1);
  }, [recentBatchDetail?.runId]);

  const dashThermalDetail = useMemo(() => {
    if (!recentBatchDetail) return null;
    const runId = recentBatchDetail.runId;
    const run = runs.find((r) => (r.run_id ?? r.id) === runId);
    if (!run || !Boolean((run as unknown as { thermal_analysis_job?: boolean })?.thermal_analysis_job)) {
      return null;
    }
  
    const galT = recentRunGallery[runId];
    const apiFilesT = (run as unknown as { files?: DashboardRunFile[] })?.files;
  
    const syntheticT: DashboardRunFile[] =
      (galT?.urls ?? []).map((url, j) => ({
        filename: galT.filenames[j] || `Image ${j + 1}`,
        annotated_url: url,
        thumb_url: url,
        detections: [],
        stats: { total_defects: 0, avg_confidence: 0 },
      })) ?? [];
  
    const filesT: DashboardRunFile[] = apiFilesT?.length ? apiFilesT : syntheticT;
    const nT = filesT.length;
    const safeIdxT = nT === 0 ? 0 : Math.min(Math.max(0, recentBatchDetail.fileIndex), nT - 1);
    const curT = filesT[safeIdxT];
    const fname = galT?.filenames?.[safeIdxT] ?? curT?.filename ?? "";
    const results = thermalDetailResults;
    const fidT = curT?.file_id;
  
    const tr =
      (fidT ? results?.find((r) => (r as { file_id?: string }).file_id === fidT) : undefined) ??
      results?.find((r) => (r as { filename?: string }).filename === fname) ??
      undefined;
  
    const originalUrlRaw =
      (tr?.original_image_url as string) ||
      (tr?.thermal_rjpeg_url as string) ||
      "";
  
    const imgUrl = originalUrlRaw ? resolveMediaSrc(originalUrlRaw) : "";
  
    const visualizationUrlRaw =
      (tr?.thermal_visualization_url as string) ||
      (tr?.thermal_image_url as string) ||
      "";
  
    const visualizationImgUrl = visualizationUrlRaw ? resolveMediaSrc(visualizationUrlRaw) : "";
  
    const countDisplay = Math.max(nT, results?.length ?? 0);
  
    return {
      runId,
      fname,
      tr,
      imgUrl,
      visualizationImgUrl,
      safeIdxT,
      nT,
      countDisplay: countDisplay > 0 ? countDisplay : 1,
    };
  }, [recentBatchDetail, runs, recentRunGallery, thermalDetailResults]);

  useEffect(() => {
    setDashThermalRoiActive(false);
    setDashThermalRoiStart(null);
    setDashThermalRoiEnd(null);
    setDashThermalRoiStats(null);
  }, [dashThermalDetail?.runId, dashThermalDetail?.safeIdxT, dashThermalDetail?.fname]);

  const handleDashThermalRoiMouseDown = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      if (!dashThermalRoiActive || !dashThermalDetail) return;
      const el = e.currentTarget;
      const tr = dashThermalDetail.tr as Record<string, unknown> | undefined;
      const st = (tr?.stats as ThermalStats) ?? null;
      const w = el.naturalWidth > 0 ? el.naturalWidth : st?.width ?? 640;
      const h = el.naturalHeight > 0 ? el.naturalHeight : st?.height ?? 512;
      const rect = el.getBoundingClientRect();
      const x = Math.round(((e.clientX - rect.left) / rect.width) * w);
      const y = Math.round(((e.clientY - rect.top) / rect.height) * h);
      setDashThermalRoiStart({ x, y });
      setDashThermalRoiEnd(null);
      setDashThermalRoiStats(null);
    },
    [dashThermalRoiActive, dashThermalDetail]
  );

  const handleDashThermalRoiMouseUp = useCallback(
    async (e: React.MouseEvent<HTMLImageElement>) => {
      if (!dashThermalRoiActive || !dashThermalRoiStart || !dashThermalDetail) return;
      const el = e.currentTarget;
      const tr = dashThermalDetail.tr as Record<string, unknown> | undefined;
      const st = (tr?.stats as ThermalStats) ?? null;
      const w = el.naturalWidth > 0 ? el.naturalWidth : st?.width ?? 640;
      const h = el.naturalHeight > 0 ? el.naturalHeight : st?.height ?? 512;
      const rect = el.getBoundingClientRect();
      const x = Math.round(((e.clientX - rect.left) / rect.width) * w);
      const y = Math.round(((e.clientY - rect.top) / rect.height) * h);
      setDashThermalRoiEnd({ x, y });

      let x1 = Math.min(dashThermalRoiStart.x, x);
      let y1 = Math.min(dashThermalRoiStart.y, y);
      let x2 = Math.max(dashThermalRoiStart.x, x);
      let y2 = Math.max(dashThermalRoiStart.y, y);
      if (x2 <= x1) x2 = Math.min(w, x1 + 1);
      if (y2 <= y1) y2 = Math.min(h, y1 + 1);
      x1 = Math.max(0, Math.min(x1, w - 1));
      y1 = Math.max(0, Math.min(y1, h - 1));
      x2 = Math.max(x1 + 1, Math.min(x2, w));
      y2 = Math.max(y1 + 1, Math.min(y2, h));

      const filename = dashThermalDetail.fname || (tr?.filename as string) || "thermal.jpg";
      const imgUrl = dashThermalDetail.imgUrl;
      const rjpegRaw = (tr?.thermal_rjpeg_url as string) || "";
      const rjpegUrl = rjpegRaw ? resolveMediaSrc(rjpegRaw) : "";
      const b64 = (tr?.thermal_image_base64_png as string) || null;
      const unit = String(tr?.unit ?? "Celsius");

      setDashThermalRoiLoading(true);
      try {
        let file: File | null = null;
        if (rjpegUrl) {
          const res = await fetch(rjpegUrl);
          if (res.ok) {
            const blob = await res.blob();
            file = new File([blob], filename, { type: blob.type || "image/jpeg" });
          }
        }
        if (!file && imgUrl) {
          const res = await fetch(imgUrl);
          if (res.ok) {
            const blob = await res.blob();
            file = new File([blob], filename, { type: blob.type || "image/jpeg" });
          }
        }
        if (!file && b64) {
          const res = await fetch(`data:image/png;base64,${b64}`);
          const blob = await res.blob();
          const baseName = filename.replace(/\.[^.]+$/, "") || "thermal";
          file = new File([blob], `${baseName}.png`, { type: "image/png" });
        }
        if (!file) return;

        const form = new FormData();
        form.append("image", file);
        form.append("x1", String(x1));
        form.append("y1", String(y1));
        form.append("x2", String(x2));
        form.append("y2", String(y2));
        form.append("unit", unit);
        const res = await fetch(`/api/thermal/roi`, { method: "POST", body: form });
        if (res.ok) {
          const data = await res.json();
          setDashThermalRoiStats((data.stats ?? data) as ThermalStats);
        }
      } catch {
        /* ignore */
      } finally {
        setDashThermalRoiLoading(false);
      }
    },
    [dashThermalRoiActive, dashThermalRoiStart, dashThermalDetail]
  );

  const transition = reduceMotion ? { duration: 0 } : { duration: 0.2 };

  if (loading) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="space-y-6 dashboard-page"
      >
        <div>
          <div className="h-8 w-40 rounded mb-2 animate-pulse bg-[var(--dash-skeleton)]" />
          <div className="h-4 w-56 rounded animate-pulse bg-[var(--dash-skeleton)] opacity-90" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="dash-panel p-4 animate-pulse">
              <div className="h-4 w-20 rounded mb-3 bg-[var(--dash-skeleton)]" />
              <div className="h-8 w-16 rounded bg-[var(--dash-skeleton-strong)]" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="dash-panel p-6 h-64 animate-pulse" />
          <div className="dash-panel p-6 h-64 animate-pulse" />
        </div>
        <div className="dash-panel p-6 animate-pulse h-48" />
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={transition}
      className="space-y-6 dashboard-page"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold mb-2 dash-page-title">Dashboard</h1>
          <p className="dash-page-subtitle">Inspection overview</p>
        </div>
        <div className="flex flex-wrap gap-2 justify-end">
          <motion.div
            whileHover={reduceMotion ? undefined : { y: -2, transition: { duration: 0.15 } }}
            className="max-w-[220px]"
          >
            <Link to="/ai-detection" className={dashHero.quickRgb}>
              <div className="flex items-center gap-2 mb-2">
                <div className={dashHero.quickIconRgb}>
                  <ImageIcon size={18} className={dashHero.quickGlyphRgb} />
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className={dashHero.quickTitle}>RGB image</h4>
                </div>
                <Plus size={16} className={`${dashHero.quickGlyphRgb} shrink-0 opacity-0 group-hover:opacity-100 transition-opacity`} />
              </div>
            </Link>
          </motion.div>

          <motion.div
            transition={transition}
            whileHover={reduceMotion ? undefined : { y: -2, transition: { duration: 0.15 } }}
            className="max-w-[220px]"
          >
            <Link to="/ai-detection?mode=thermal" className={dashHero.quickThermal}>
              <div className="flex items-center gap-2 mb-2">
                <div className={dashHero.quickIconThermal}>
                  <Thermometer size={18} className={dashHero.quickGlyphThermal} />
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className={dashHero.quickTitle}>Thermal analysis</h4>
                </div>
                <Plus size={16} className={`${dashHero.quickGlyphThermal} shrink-0 opacity-0 group-hover:opacity-100 transition-opacity`} />
              </div>
            </Link>
          </motion.div>

          <motion.div
            transition={transition}
            whileHover={reduceMotion ? undefined : { y: -2, transition: { duration: 0.15 } }}
            className="max-w-[220px]"
          >
            <Link to="/ai-detection?mode=video" className={dashHero.quickVideo}>
              <div className="flex items-center gap-2 mb-2">
                <div className={dashHero.quickIconVideo}>
                  <Video size={18} className={dashHero.quickGlyphVideo} />
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className={dashHero.quickTitle}>Upload video</h4>
                </div>
                <Plus size={16} className={`${dashHero.quickGlyphVideo} shrink-0 opacity-0 group-hover:opacity-100 transition-opacity`} />
              </div>
            </Link>
          </motion.div>
        </div>
      </div>

      {/* How It Works — gradient frame carousel (image left, copy on same panel) */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full"
      >
        <div className="rounded-[24px] bg-transparent p-0">
          <div
            className="relative min-h-[220px] overflow-hidden rounded-[24px] sm:min-h-[240px] md:min-h-[260px]"
            style={{
              background:
                theme === "light"
                  ? "linear-gradient(90deg, #263388 0%, #3247A4 45%, #AD7CF3 100%)"
                  : "linear-gradient(90deg, #050505 0%, #171717 40%, #525252 100%)",
            }}
          >
            {HOW_IT_WORKS_SLIDES.map((card, index) => {
              const stepAccent =
                card.accent === "blue"
                  ? "text-sky-200 font-semibold tabular-nums shrink-0"
                  : card.accent === "cyan"
                    ? "text-cyan-200 font-semibold tabular-nums shrink-0"
                    : "text-violet-200 font-semibold tabular-nums shrink-0";
              return (
                <motion.div
                  key={card.imageSrc}
                  role="tabpanel"
                  aria-hidden={currentSlide !== index}
                  initial={false}
                  animate={{ opacity: currentSlide === index ? 1 : 0 }}
                  transition={{ duration: 0.35, ease: "easeOut" }}
                  className={`absolute inset-0 flex min-h-[220px] flex-col sm:min-h-[240px] md:min-h-[260px] ${
                    currentSlide === index ? "z-[1]" : "z-0 pointer-events-none"
                  }`}
                >
                  <img
                    src={card.imageSrc}
                    alt={card.alt}
                    className="pointer-events-none absolute inset-0 z-0 h-full w-full min-h-full min-w-full object-cover object-center"
                    loading={index === 0 ? "eager" : "lazy"}
                  />
                  <div
                    className="pointer-events-none absolute inset-0 z-[1] bg-gradient-to-r from-black/25 via-black/40 to-black/72 sm:via-black/45 sm:to-black/78"
                    aria-hidden
                  />
                  <div className="relative z-[2] flex min-h-0 w-full flex-1 flex-col justify-center px-4 py-4 pr-[3.25rem] sm:px-6 sm:pr-16 md:pr-20 lg:pr-24">
                    <div className="flex w-full max-w-[min(100%,26rem)] flex-col gap-2 rounded-2xl border border-white/20 bg-black/35 px-4 py-4 text-white shadow-[0_8px_32px_rgba(0,0,0,0.18)] backdrop-blur-xl backdrop-saturate-150 sm:px-5 sm:py-5 md:ml-auto">
                      <h3 className="text-lg font-bold leading-tight tracking-tight text-white sm:text-xl md:text-2xl lg:text-[1.65rem]">
                        {card.title}
                      </h3>
                      <p className="text-xs font-medium text-white/75 sm:text-sm">{card.meta}</p>
                      <ul className="mt-1 space-y-2 text-left text-xs leading-snug text-white/90 sm:text-sm md:space-y-2.5">
                        {card.steps.map((line, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <span className={stepAccent}>{i + 1}.</span>
                            <span>{line}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </motion.div>
              );
            })}

            <button
              type="button"
              onClick={goHowItWorksPrev}
              className={`absolute left-2 top-1/2 z-20 -translate-y-1/2 md:left-3 ${dashHero.arrow}`}
              aria-label="Previous slide"
            >
              <ChevronLeft className={dashHero.arrowIcon} size={20} />
            </button>
            <button
              type="button"
              onClick={goHowItWorksNext}
              className={`absolute right-2 top-1/2 z-20 -translate-y-1/2 md:right-3 ${dashHero.arrow}`}
              aria-label="Next slide"
            >
              <ChevronRight className={dashHero.arrowIcon} size={20} />
            </button>
          </div>
        </div>

        <div className="mt-3 flex justify-center gap-2">
          {HOW_IT_WORKS_SLIDES.map((_, index) => (
            <button
              key={index}
              type="button"
              onClick={() => goHowItWorksIndex(index)}
              className={`rounded-full transition-all ${
                currentSlide === index ? "h-2 w-8 bg-[#3247A4]" : "h-2.5 w-2.5 border-2 border-[#3247A4]/45 bg-transparent hover:border-[#3247A4]/70"
              }`}
              aria-label={`Go to slide ${index + 1}`}
              aria-current={currentSlide === index ? "true" : undefined}
            />
          ))}
        </div>
      </motion.div>

      {error && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-4 flex items-center gap-3 text-amber-200"
        >
          <AlertCircle size={20} className="shrink-0" />
          <span className="text-sm">{error}</span>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setLoading(true);
              getRuns()
                .then(setRuns)
                .catch((e) => {
                  setError(e instanceof Error ? e.message : "Failed");
                  toast.error(e instanceof Error ? e.message : "Failed", 5000);
                })
                .finally(() => setLoading(false));
            }}
            className="ml-auto text-xs font-semibold text-amber-300 hover:text-amber-100 underline"
          >
            Retry
          </button>
        </motion.div>
      )}

      {runs.length > 0 && (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              {
                label: "Uploads",
                value: kpis.total,
                sub: "All inspections",
                icon: ListOrdered,
                color: "cyan",
                tooltip: null,
              },
              {
                label: "Completed",
                value: kpis.completed,
                sub: `${kpis.processing} processing, ${kpis.failed} failed`,
                icon: CheckCircle2,
                color: "emerald",
                tooltip: null,
              },
              {
                label: "Needs Review",
                value: kpis.needsReview,
                sub: "Total items to review",
                icon: AlertCircle,
                color: "amber",
                tooltip: null,
              },
              {
                label: "Model Precision Confidence",
                value: "96%",
                sub: "",
                icon: TrendingUp,
                color: "cyan",
                tooltip: null,
              },
            ].map((kpi, i) => {
              const Icon = kpi.icon;
              return (
                <motion.div
                  key={`${kpi.label}-${kpi.sub}`}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...transition, delay: reduceMotion ? 0 : i * 0.05 }}
                  whileHover={reduceMotion ? undefined : { y: -2, transition: { duration: 0.15 } }}
                  className="dash-panel dash-panel-interactive p-4 transition-colors group relative"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium dash-text-muted uppercase tracking-wider flex items-center gap-1">
                      {kpi.label}
                      {kpi.tooltip && (
                        <span
                          title={kpi.tooltip}
                          className="dash-text-subtle hover:text-[var(--dash-body)] cursor-help"
                        >
                          <HelpCircle size={12} />
                        </span>
                      )}
                    </span>
                    <Icon
                      size={18}
                      className={
                        kpi.color === "cyan"
                          ? "text-cyan-400"
                          : kpi.color === "emerald"
                          ? "text-emerald-400"
                          : kpi.color === "red"
                          ? "text-red-400"
                          : kpi.color === "orange"
                          ? "text-orange-400"
                          : "text-amber-400"
                      }
                    />
                  </div>
                  <div className="text-2xl font-bold dash-text-primary">{kpi.value}</div>
                  {kpi.sub ? <div className="text-xs dash-text-subtle mt-0.5">{kpi.sub}</div> : null}
                </motion.div>
              );
            })}
          </div>

          {/* Top Defect Types mini panel */}
          {topDefectTypes.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...transition, delay: reduceMotion ? 0 : 0.08 }}
              className="dash-panel p-4"
            >
              <h3 className="text-sm font-semibold dash-text-primary mb-3 flex items-center gap-2">
                <BarChart3 size={16} className="text-cyan-400" />
                Top Defect Types
              </h3>
              <div className="flex flex-wrap gap-3">
                {topDefectTypes.map(({ name, value }) => (
                  <div
                    key={name}
                    className="flex items-center gap-2 rounded-lg px-3 py-2 border dash-inset-pill"
                  >
                    <span className="text-sm font-medium dash-text-primary capitalize">{name}</span>
                    <span className="text-xs font-bold text-cyan-400">{value}</span>
                  </div>
                ))}
              </div>
            </motion.div>
          )}

          {/* Latest Bulk Batch Dropdown */}
          {latestBulkBatch && latestBulkBatch.organization && latestBulkBatch.organization.enabled && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...transition, delay: reduceMotion ? 0 : 0.1 }}
              className="rounded-xl border border-premium-accent/50 bg-premium-accent/10 shadow-premium overflow-hidden"
            >
              {/* Dropdown Header */}
              <button
                onClick={() => setLatestBulkBatchDropdownOpen(!latestBulkBatchDropdownOpen)}
                className="w-full flex items-center justify-between p-6 hover:bg-premium-accent/5 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Upload className="text-premium-accent" size={20} />
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-semibold dash-text-primary">Latest Bulk Batch</h3>
                    <span className="text-xs dash-text-muted">
                      {latestBulkBatch.batch_id && (() => {
                        try {
                          const match = latestBulkBatch.batch_id.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
                          if (match) {
                            const [, year, month, day, hour, min, sec] = match;
                            return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}`).toLocaleString();
                          }
                          return latestBulkBatch.batch_id;
                        } catch {
                          return latestBulkBatch.batch_id;
                        }
                      })()}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-green-400 flex items-center gap-1">
                      <CheckCircle2 size={14} />
                      {latestBulkBatch.processed} processed
                    </span>
                    {latestBulkBatch.failed > 0 && (
                      <span className="text-red-400 flex items-center gap-1">
                        <XCircle size={14} />
                        {latestBulkBatch.failed} failed
                      </span>
                    )}
                  </div>
                  {latestBulkBatchDropdownOpen ? (
                    <ChevronUp className="text-premium-accent" size={20} />
                  ) : (
                    <ChevronDown className="text-premium-accent" size={20} />
                  )}
                </div>
              </button>
              
              {/* Dropdown Content */}
              {latestBulkBatchDropdownOpen && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2 }}
                  className="px-6 pb-6 space-y-4 border-t border-premium-accent/30"
                >
                  <div>
                    <div className="text-sm dash-text-body mb-3">
                      Organized into <span className="text-premium-accent font-semibold">{Object.keys(latestBulkBatch.organization.folders || {}).length}</span> defect type folders
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                      {(Object.entries(latestBulkBatch.organization.folders || {}) as [string, number][]).map(([folder, count]) => (
                        <div
                          key={folder}
                          className="glass rounded-lg border border-dash p-3 hover:border-premium-accent/50 transition-colors"
                        >
                          <div className="text-premium-accent font-semibold text-sm capitalize">
                            {String(folder).replace(/_/g, " ")}
                          </div>
                          <div className="dash-text-body text-xs mt-1">
                            {count} image{count !== 1 ? "s" : ""}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2 text-xs dash-text-muted pt-3 border-t border-premium-accent/30">
                    <code className="dash-code px-2 py-1 rounded">{latestBulkBatch.batch_dir || "outputs/bulk_processing/"}</code>
                    <div className="ml-auto flex items-center gap-3">
                      <Link
                        to="/bulk-upload"
                        className="text-premium-accent hover:text-premium-accent/80 underline flex items-center gap-1"
                      >
                        View Bulk Upload
                        <ChevronRight size={12} />
                      </Link>
                      <Link
                        to="/bulk-batches"
                        className="text-cyan-400 hover:text-cyan-300 underline flex items-center gap-1"
                      >
                        View Recent Batches
                        <ChevronRight size={12} />
                      </Link>
                    </div>
                  </div>
                </motion.div>
              )}
            </motion.div>
          )}

          {/* Recent Bulk Batches Dropdown */}
          {recentBulkBatches.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...transition, delay: reduceMotion ? 0 : 0.15 }}
              className="dash-panel overflow-hidden"
            >
              {/* Dropdown Header */}
              <button
                onClick={() => setBulkBatchesDropdownOpen(!bulkBatchesDropdownOpen)}
                className="w-full flex items-center justify-between p-6 dash-hover-row transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Upload className="text-cyan-400" size={20} />
                  <h3 className="text-lg font-semibold dash-text-primary">Recent Bulk Batches</h3>
                  <span className="text-xs dash-text-muted dash-code px-2 py-1 rounded">
                    {recentBulkBatches.length}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <Link
                    to="/bulk-batches"
                    onClick={(e) => e.stopPropagation()}
                    className="text-xs font-medium text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
                  >
                    View all
                    <ChevronRight size={14} />
                  </Link>
                  {bulkBatchesDropdownOpen ? (
                    <ChevronUp className="dash-text-muted" size={20} />
                  ) : (
                    <ChevronDown className="dash-text-muted" size={20} />
                  )}
                </div>
              </button>
              
              {/* Dropdown Content - Evidence-first design */}
              {bulkBatchesDropdownOpen && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2 }}
                  className="px-6 pb-6 space-y-3 border-t border-dash"
                >
                {recentBulkBatches.map((batch) => {
                  const formatBatchDate = (batchId: string) => {
                    try {
                      const match = batchId.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
                      if (match) {
                        const [, year, month, day, hour, min, sec] = match;
                        return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}`).toLocaleString();
                      }
                      return batchId;
                    } catch {
                      return batchId;
                    }
                  };
                  const folders = (batch?.organization?.folders ?? {}) as Record<string, number>;
                  const defectsFound = (Object.values(folders) as number[]).reduce((a, b) => a + b, 0);
                  const hotspotsFound =
                    (folders["thermal"] ?? 0) +
                    (folders["hotspot"] ?? 0) +
                    (folders["thermal_hotspot"] ?? 0) +
                    (folders["thermal_hotspots"] ?? 0);
                  const batchId = batch.batch_id ?? batch.batch_dir?.split(/[/\\]/).pop() ?? "unknown";

                  return (
                    <div
                      key={batch.batch_id}
                      className="glass rounded-lg border border-dash p-4 hover:border-cyan-500/50 transition-colors"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold dash-text-primary mb-1">
                            Batch {batch.batch_id ? formatBatchDate(batch.batch_id) : batchId}
                          </div>
                          <code className="text-xs dash-text-subtle font-Poppins">{batchId}</code>
                        </div>
                        <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2 text-xs">
                          <span className="flex items-center gap-1 dash-text-body">
                            <ImageIcon size={12} />
                            {Number(batch.processed ?? 0)} images
                          </span>
                          <span className="flex items-center gap-1 text-cyan-400">
                            <AlertCircle size={12} />
                            {defectsFound} defects
                          </span>
                          {hotspotsFound > 0 && (
                            <span className="flex items-center gap-1 text-orange-400">
                              <AlertTriangle size={12} />
                              {hotspotsFound} hotspots
                            </span>
                          )}
                          {batch.failed > 0 && (
                            <span className="text-red-400 flex items-center gap-1">
                              <XCircle size={12} />
                              {batch.failed} failed
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-dash">
                        <a
                          href={bulkBatchReportUrl(batchId)}
                          download={`batch_report_${batchId}.pdf`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-300 border border-cyan-500/50 text-xs font-semibold hover:bg-cyan-500/30 transition-colors"
                        >
                          <Download size={14} />
                          Download report
                        </a>
                        <Link
                          to="/bulk-batches"
                          className="text-cyan-400 hover:text-cyan-300 underline text-xs font-medium flex items-center gap-1"
                        >
                          View Batch
                          <ChevronRight size={12} />
                        </Link>
                      </div>
                    </div>
                  );
                })}
                </motion.div>
              )}
            </motion.div>
          )}

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ ...transition, delay: reduceMotion ? 0 : 0.1 }}
              className="dash-panel p-4"
            >
              <h3 className="font-semibold dash-text-primary mb-4">Uploads per day (last 14 days)</h3>
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={runsPerDay} margin={{ top: 6, right: 6, left: -20, bottom: 0 }} barCategoryGap={10}>
                    <defs>
                      <linearGradient id="uploadsBarGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={chart.uploadsBarStops[0]} stopOpacity={1} />
                        <stop offset="55%" stopColor={chart.uploadsBarStops[1]} stopOpacity={0.88} />
                        <stop offset="100%" stopColor={chart.uploadsBarStops[2]} stopOpacity={0.42} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="2 6" stroke={chart.grid} vertical={false} />
                    <XAxis
                      dataKey="date"
                      stroke={chart.axis}
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      stroke={chart.axis}
                      fontSize={11}
                      allowDecimals={false}
                      tickLine={false}
                      axisLine={false}
                      width={34}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: chart.ttBg,
                        border: `1px solid ${chart.ttBorderCyan}`,
                        borderRadius: "8px",
                        fontSize: "12px",
                        boxShadow: chart.ttShadow,
                      }}
                      labelStyle={{ color: chart.ttLabel }}
                      itemStyle={{ color: chart.ttItem }}
                      cursor={{ fill: chart.cursorCyan }}
                    />
                    <Bar
                      dataKey="runs"
                      name="Uploads"
                      fill="url(#uploadsBarGrad)"
                      radius={[10, 10, 6, 6]}
                      stroke={chart.barStrokeCyan}
                      strokeWidth={1}
                      isAnimationActive={!reduceMotion}
                      animationDuration={720}
                      animationBegin={80}
                      animationEasing="ease-out"
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </motion.div>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ ...transition, delay: reduceMotion ? 0 : 0.15 }}
              className="dash-panel p-4"
            >
              <h3 className="font-semibold dash-text-primary mb-4">Status distribution</h3>
              <div className="min-h-[280px] lg:min-h-[240px] py-1">
                {statusDistribution.total > 0 && statusDistribution.pieData.length > 0 ? (
                  <StatusDistributionInfographic
                    rows={statusDistribution.rows}
                    pieData={statusDistribution.pieData}
                    total={statusDistribution.total}
                    chart={chart}
                    reduceMotion={reduceMotion ?? false}
                  />
                ) : (
                  <div className="flex min-h-[200px] items-center justify-center dash-text-subtle text-sm">
                    No data in this range
                  </div>
                )}
              </div>
            </motion.div>
          </div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ ...transition, delay: reduceMotion ? 0 : 0.2 }}
            className="dash-panel p-4"
          >
            <h3 className="font-semibold dash-text-primary mb-4">Needs Review per day (last 14 days)</h3>
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={runsPerDay} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="needsReviewBarGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={chart.needsReviewBarStops[0]} stopOpacity={1} />
                      <stop offset="58%" stopColor={chart.needsReviewBarStops[1]} stopOpacity={0.9} />
                      <stop offset="100%" stopColor={chart.needsReviewBarStops[2]} stopOpacity={0.45} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="2 6" stroke={chart.grid} vertical={false} />
                  <XAxis
                    dataKey="date"
                    stroke={chart.axis}
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    stroke={chart.axis}
                    fontSize={11}
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={false}
                    width={34}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: chart.ttBg,
                      border: `1px solid ${chart.ttBorderAmber}`,
                      borderRadius: "8px",
                      fontSize: "12px",
                      boxShadow: chart.ttShadow,
                    }}
                    labelStyle={{ color: chart.ttLabel }}
                    itemStyle={{ color: chart.ttItem }}
                    cursor={{ fill: chart.cursorAmber }}
                  />
                  <Bar
                    dataKey="mustReview"
                    name="Needs review"
                    fill="url(#needsReviewBarGrad)"
                    radius={[10, 10, 6, 6]}
                    stroke={chart.barStrokeAmber}
                    strokeWidth={1}
                    isAnimationActive={!reduceMotion}
                    animationDuration={720}
                    animationBegin={80}
                    animationEasing="ease-out"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </motion.div>

          {/* Recent Runs */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ ...transition, delay: reduceMotion ? 0 : 0.25 }}
            className="dash-panel overflow-hidden"
          >
            <div className="px-4 py-3 border-b border-dash flex items-center justify-between">
              <h3 className="font-semibold dash-text-primary">Recent Uploads</h3>
              <Link
                to="/runs"
                className="font-medium flex items-center gap-1"
              >
                View all
                <ChevronRight size={14} />
              </Link>
            </div>
            <div className="p-2 sm:p-3">
              <div
                className={`flex flex-col gap-3 ${selectedRecentRunId ? "lg:flex-row lg:items-stretch" : ""}`}
              >
                <div
                  className={`min-w-0 ${selectedRecentRunId ? "lg:w-1/2 lg:max-h-[min(70vh,640px)] lg:overflow-y-auto lg:pr-1" : "w-full"}`}
                >
                  <div
                    className={`grid gap-2 ${selectedRecentRunId ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"}`}
                  >
                    {recentRuns.map((run, i) => {
                      const runId = run.run_id ?? run.id;
                      const pct = confidencePct(run);
                      const gal = recentRunGallery[runId];
                      const urls = gal?.urls ?? EMPTY_GALLERY_URLS;
                      const loadingGal = gal?.loading ?? true;
                      const isSelected = selectedRecentRunId === runId;
                      const ts = run.created_at ?? run.timestamp;
                      return (
                        <motion.div
                          key={run.id}
                          role="button"
                          tabIndex={0}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ delay: reduceMotion ? 0 : 0.03 * i }}
                          onClick={() =>
                            setSelectedRecentRunId((prev) => (prev === runId ? null : runId))
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setSelectedRecentRunId((prev) => (prev === runId ? null : runId));
                            }
                          }}
                          className={`rounded-lg border overflow-hidden text-left cursor-pointer transition-all bg-[var(--dash-elevated-bg)] ${
                            isSelected
                              ? "border-cyan-500/60 ring-1 ring-cyan-500/40 shadow-[0_0_12px_rgba(34,211,238,0.1)]"
                              : "border-dash hover:border-[var(--dash-thumb-border-hover)]"
                          }`}
                        >
                          <div className="relative h-[72px] sm:h-20 w-full border-b border-dash overflow-hidden shrink-0 bg-[var(--dash-thumb-strip-bg)]">
                            <RecentUploadThumbnailSlider
                              runId={runId}
                              urls={urls}
                              loading={loadingGal}
                            />
                          </div>
                          <div className="p-2 space-y-1">
                            <div className="flex items-start justify-between gap-1">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-0.5">
                                  <span className="font-Poppins dash-text-primary text-[10px] truncate" title={runId}>
                                    {runId.length > 10 ? `${runId.slice(0, 10)}…` : runId}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      copyRunId(runId);
                                    }}
                                    className="p-0.5 rounded dash-text-muted hover:text-[var(--dash-heading)] hover:bg-[var(--dash-hover-bg)] shrink-0"
                                    aria-label="Copy run ID"
                                  >
                                    <Copy size={10} />
                                  </button>
                                </div>
                                <div className="text-[9px] truncate leading-tight">
                                  {ts ? new Date(ts).toLocaleString() : "—"}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedRecentRunId(runId);
                                }}
                                className="shrink-0 inline-flex items-center gap-0.5 rounded-md bg-cyan-500/20 border border-cyan-500/50 px-1.5 py-0.5 text-[9px] font-semibold hover:bg-cyan-500/30"
                              >
                                View
                                <ChevronRight size={9} />
                              </button>
                            </div>
                            <div className="flex flex-wrap items-center gap-1 text-[9px] leading-tight">
                              <span
                                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-semibold border ${
                                  run.status === "completed"
                                    ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/50"
                                    : run.status === "processing"
                                    ? "bg-amber-500/20 text-amber-400 border-amber-500/50"
                                    : run.status === "failed"
                                    ? "bg-red-500/20 text-red-400 border-red-500/50"
                                    : "bg-neutral-500/20 text-neutral-400 border-neutral-500/50"
                                }`}
                              >
                                {run.status === "processing" && (
                                  <Clock size={9} className="animate-spin" />
                                )}
                                {run.status === "failed" && <XCircle size={9} />}
                                {run.status === "completed" && <CheckCircle2 size={9} />}
                                {run.status.toUpperCase()}
                              </span>
                              <span className="dash-text-muted">
                                Findings:{" "}
                                <span className="dash-text-body">
                                  {run.findings_count !== undefined ? run.findings_count : "—"}
                                </span>
                              </span>
                              <span
                                className={
                                  (run.must_review_count ?? 0) > 0
                                    ? "text-amber-400 font-medium"
                                    : "dash-text-muted"
                                }
                              >
                                Review: {run.must_review_count ?? "—"}
                              </span>
                            </div>
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                </div>

                {selectedRecentRunId && (
                  <div className="w-full lg:w-1/2 flex flex-col border-t lg:border-t-0 lg:border-l border-dash lg:pl-4 pt-4 lg:pt-0 min-h-[280px] lg:max-h-[min(70vh,720px)]">
                    <div className="flex items-center justify-between gap-2 mb-3 shrink-0">
                      <div className="min-w-0">
                        <div className="text-xs uppercase tracking-wide">
                          Batch images
                        </div>
                        <div className="font-Poppins text-sm dash-text-primary truncate" title={selectedRecentRunId}>
                          {selectedRecentRunId}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setBatchDetailTab("image");
                            setRecentBatchDetail({ runId: selectedRecentRunId, fileIndex: 0 });
                          }}
                          className="inline-flex items-center gap-1 rounded-lg bg-cyan-500/30  border border-cyan-400/60 px-2.5 py-1.5 text-xs font-semibold hover:bg-cyan-500/45"
                        >
                          <Eye size={14} />
                          View details
                        </button>
                        {/* <Link
                          to={`/runs/${selectedRecentRunId}`}
                          className="inline-flex items-center gap-1 rounded-lg bg-cyan-500/20 border border-cyan-500/50 px-2.5 py-1.5 text-xs font-semibold hover:bg-cyan-500/30"
                        >
                          Open run
                        </Link> */}
                        <button
                          type="button"
                          onClick={() => setSelectedRecentRunId(null)}
                          className="rounded-lg border border-dash dash-text-body px-2.5 py-1.5 text-xs font-semibold hover:bg-[var(--dash-hover-bg)]"
                        >
                          Close
                        </button>
                      </div>
                    </div>
                    <div className="flex-1 overflow-y-auto min-h-0">
                      {(() => {
                        const sel = recentRunGallery[selectedRecentRunId];
                        const selUrls = sel?.urls ?? EMPTY_GALLERY_URLS;
                        const selNames = sel?.filenames ?? [];
                        const selLoading = sel?.loading ?? true;
                        if (selLoading && selUrls.length === 0) {
                          return (
                            <div className="flex items-center justify-center py-16 dash-text-subtle text-sm gap-2">
                              <Clock className="animate-spin" size={18} />
                              Loading…
                            </div>
                          );
                        }
                        if (selUrls.length === 0) {
                          return (
                            <div className="flex flex-col items-center justify-center py-16 dash-text-subtle text-sm gap-2">
                              <ImageIcon size={40} className="opacity-40" />
                              No previews yet for this run
                            </div>
                          );
                        }
                        const splitRun = runs.find((r) => (r.run_id ?? r.id) === selectedRecentRunId);
                        const splitFiles = (splitRun as unknown as { files?: DashboardRunFile[] })?.files;
                        return (
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pb-2">
                            {selUrls.map((u, j) => {
                              const f = splitFiles?.[j];
                              const hasVideo =
                                Boolean(f?.video_url) && isMp4Url(f?.video_url ?? undefined);
                              const vSrc = hasVideo ? resolveMediaSrc(f!.video_url) : undefined;
                              return (
                                <button
                                  key={`${u}-${j}`}
                                  type="button"
                                  onClick={() =>
                                    setRecentUploadPreview({
                                      runId: selectedRecentRunId,
                                      imageUrl: u,
                                      filename: selNames[j],
                                      videoUrl: vSrc,
                                      duration: f?.duration,
                                      fps: f?.fps,
                                      framesAnalyzed: f?.frames_analyzed,
                                    })
                                  }
                                  className="relative aspect-square rounded-lg border border-dash overflow-hidden bg-[var(--dash-inset-bg)] hover:border-cyan-500/50 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 transition-colors group"
                                >
                                  <img
                                    src={u}
                                    alt={selNames[j] ?? `Item ${j + 1}`}
                                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                                    loading="lazy"
                                  />
                                  {hasVideo && (
                                    <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30">
                                      <Video
                                        className="text-white drop-shadow-md w-7 h-7 opacity-95"
                                        aria-hidden
                                      />
                                    </span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {recentUploadPreview && (
              <div
                className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 p-4"
                onClick={() => setRecentUploadPreview(null)}
              >
                <div
                  className="relative flex w-full max-w-6xl max-h-[92vh] flex-col items-stretch md:max-h-[90vh] md:flex-row md:items-stretch md:min-h-[320px]"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    onClick={() => setRecentUploadPreview(null)}
                    className="absolute top-2 right-2 z-20 rounded-full p-2 transition-colors md:top-4 md:right-4"
                    aria-label="Close preview"
                  >
                    <X size={20} className="text-white" />
                  </button>
                  <div className="relative flex min-h-0 min-w-0 flex-1 flex-col justify-center pt-10 md:pt-12 md:pr-2">
                    {recentUploadPreview.videoUrl ? (
                      <video
                        ref={recentQuickPreviewVideoRef}
                        key={recentUploadPreview.videoUrl}
                        src={recentUploadPreview.videoUrl}
                        controls
                        playsInline
                        className="mx-auto w-full max-h-[55vh] rounded-lg border border-[var(--dash-preview-border)] bg-black md:max-h-[min(85vh,820px)]"
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <img
                        src={recentUploadPreview.imageUrl}
                        alt={recentUploadPreview.filename ?? "Preview"}
                        className="mx-auto h-auto max-h-[55vh] w-full max-w-full rounded-lg object-contain md:max-h-[85vh]"
                        onClick={(e) => e.stopPropagation()}
                      />
                    )}
                    <div className="mt-2 bg-[var(--dash-inset-bg)] border border-dash px-3 py-2 text-xs font-Poppins dash-text-primary md:absolute md:bottom-4 md:left-4 md:mt-0 md:max-w-[min(100%,28rem)] md:rounded-lg">
                      {recentUploadPreview.filename ?? `${recentUploadPreview.runId.slice(0, 12)}…`}
                    </div>
                  </div>
                  {recentUploadPreview.videoUrl && (
                    <div className="mt-2 flex max-h-[42vh] min-h-0 shrink-0 justify-center overflow-hidden md:mt-0 md:max-h-none md:h-full md:justify-start">
                      <VideoAnnotatedFrameStrip
                        videoUrl={recentUploadPreview.videoUrl}
                        duration={recentUploadPreview.duration ?? 0}
                        fps={recentUploadPreview.fps ?? 0}
                        framesAnalyzed={recentUploadPreview.framesAnalyzed ?? 0}
                        mainVideoRef={recentQuickPreviewVideoRef}
                      />
                    </div>
                  )}
                  <button
                    type="button"
                    className="absolute bottom-2 right-2 z-10 flex items-center gap-2 rounded-lg bg-cyan-500 px-3 py-2 text-sm font-semibold text-white transition-colors md:bottom-4 md:right-4 md:px-4"
                    onClick={(e) => {
                      e.stopPropagation();
                      const { runId, filename, imageUrl, videoUrl } = recentUploadPreview;
                      const r = runs.find((x) => (x.run_id ?? x.id) === runId);
                      const apiFiles = (r as unknown as { files?: DashboardRunFile[] })?.files;
                      let fileIndex = 0;
                      if (apiFiles?.length) {
                        if (filename) {
                          const i = apiFiles.findIndex((f) => f.filename === filename);
                          if (i >= 0) fileIndex = i;
                        } else if (imageUrl || videoUrl) {
                          const i = apiFiles.findIndex((f) => {
                            const fid = f.file_id;
                            const thermalRow =
                              thermalDetailResults?.find((r) => (r as { file_id?: string }).file_id === fid) as
                                | {
                                    original_image_url?: string;
                                    thermal_rjpeg_url?: string;
                                    thermal_image_url?: string;
                                  }
                                | undefined;
                          
                            return (
                              resolveMediaSrc(thermalRow?.original_image_url) === imageUrl ||
                              resolveMediaSrc(thermalRow?.thermal_rjpeg_url) === imageUrl ||
                              resolveMediaSrc(thermalRow?.thermal_image_url) === imageUrl ||
                              resolveMediaSrc(f.annotated_url) === imageUrl ||
                              resolveMediaSrc(f.thumb_url) === imageUrl ||
                              (videoUrl && f.video_url && resolveMediaSrc(f.video_url) === videoUrl)
                            );
                          });
                          if (i >= 0) fileIndex = i;
                        }
                      } else {
                        const gal = recentRunGallery[runId];
                        if (gal?.urls?.length && imageUrl) {
                          const i = gal.urls.indexOf(imageUrl);
                          if (i >= 0) fileIndex = i;
                        }
                      }
                      setRecentUploadPreview(null);
                      setBatchDetailTab("image");
                      setRecentBatchDetail({ runId, fileIndex });
                    }}
                  >
                    <Eye size={16} />
                    View Details
                  </button>
                </div>
              </div>
            )}

            {dashThermalDetail && (
              <ThermalAnalysisDetailModal
              open={Boolean(dashThermalDetail)}
              onClose={() => setRecentBatchDetail(null)}
              filename={
                dashThermalDetail?.fname ||
                (dashThermalDetail?.tr as { filename?: string } | undefined)?.filename ||
                "Thermal"
              }
              thermalImageB64={undefined}
              thermalImageUrl={dashThermalDetail?.imgUrl || null}
              stats={(dashThermalDetail?.tr?.stats as ThermalStats) ?? null}
              analysis={(dashThermalDetail?.tr?.analysis as ThermalAnalysisData) ?? null}
              unit={String(
                (dashThermalDetail?.tr as { unit?: string } | undefined)?.unit ?? "Celsius"
              )}
              analysisConfiguration={{
                objectType: thermalDetailJobMeta?.object_type ?? null,
                paletteId: thermalDetailJobMeta?.palette ?? null,
              }}
              fileIndexDisplay={dashThermalDetail?.safeIdxT ?? 0}
              fileCountDisplay={dashThermalDetail?.countDisplay ?? 1}
              onPrev={() =>
                dashThermalDetail &&
                setRecentBatchDetail({
                  runId: dashThermalDetail.runId,
                  fileIndex: Math.max(0, dashThermalDetail.safeIdxT - 1),
                })
              }
              onNext={() =>
                dashThermalDetail &&
                setRecentBatchDetail({
                  runId: dashThermalDetail.runId,
                  fileIndex: Math.min(
                    Math.max(0, dashThermalDetail.nT - 1),
                    dashThermalDetail.safeIdxT + 1
                  ),
                })
              }
              enableRoi
              roiActive={dashThermalRoiActive}
              onToggleRoi={() => {
                setDashThermalRoiActive((a) => !a);
                setDashThermalRoiStart(null);
                setDashThermalRoiEnd(null);
                setDashThermalRoiStats(null);
              }}
              roiStart={dashThermalRoiStart}
              roiEnd={dashThermalRoiEnd}
              roiStats={dashThermalRoiStats}
              roiLoading={dashThermalRoiLoading}
              onImageMouseDown={handleDashThermalRoiMouseDown}
              onImageMouseUp={handleDashThermalRoiMouseUp}
              loading={thermalDetailLoading}
            />
            )}

            {recentBatchDetail &&
              batchDetailRun &&
              !Boolean((batchDetailRun as unknown as { thermal_analysis_job?: boolean }).thermal_analysis_job) && (
                <RecentBatchUploadDetailModal
                  runId={recentBatchDetail.runId}
                  fileIndex={recentBatchDetail.fileIndex}
                  run={batchDetailRun}
                  recentRunGallery={recentRunGallery}
                  batchDetailVideoDets={batchDetailVideoDets}
                  batchDetailVideoDetsLoading={batchDetailVideoDetsLoading}
                  batchDetailTab={batchDetailTab}
                  setBatchDetailTab={setBatchDetailTab}
                  batchDetailImgZoom={batchDetailImgZoom}
                  setBatchDetailImgZoom={setBatchDetailImgZoom}
                  batchDetailVideoRef={batchDetailVideoRef}
                  onClose={() => setRecentBatchDetail(null)}
                  onFileIndexChange={(i) =>
                    setRecentBatchDetail((prev) =>
                      prev ? { runId: prev.runId, fileIndex: i } : prev
                    )
                  }
                />
              )}
          </motion.div>
        </>
      )}
    </motion.div>
  );
}
