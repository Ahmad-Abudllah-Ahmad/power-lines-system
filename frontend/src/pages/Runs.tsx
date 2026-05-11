import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";
import { toast } from "../components/Toast";
import { VideoAnnotatedFrameStrip } from "../components/VideoAnnotatedFrameStrip";
import { VideoJobPreviewShell } from "../components/VideoJobPreviewShell";
import { DetectionSidebarBucketPanels } from "../components/DetectionSidebarBucketPanels";
import { RunsReportGenerator } from "../components/RunsReportGenerator";
import {
  ThermalAnalysisDetailHeader,
  ThermalAnalysisDetailInner,
  type ThermalStats,
  type ThermalAnalysisData,
} from "../components/ThermalAnalysisDetailModal";
import {
  Clock,
  CheckCircle2,
  XCircle,
  MessageSquare,
  Search,
  Filter,
  Copy,
  ScanSearch,
  Image,
  Video,
  Thermometer,
  X,
  ChevronLeft,
  ChevronRight,
  Eye,
  Layers,
  AlertTriangle,
  RefreshCw,
  ChevronDown,
  ZoomIn,
  ZoomOut,
  RotateCcw,
} from "lucide-react";
import { API_BASE } from "../api/api";
import {
  filterRowsForRgbPreviewOverlay,
  partitionDetectionsSidebarBuckets,
  uniqueDefectTypeCount,
  previewDetectionRowsForFile,
} from "../utils/detectionSidebarBuckets";
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
import { useRgbPreviewPan } from "../utils/useRgbPreviewPan";
import { videoResultsAuxUrlsFromAnnotatedVideoUrl } from "../utils/videoJobUrls";

function resolveThermalFetchUrl(u: string): string {
  if (!u) return "";
  const s = u.trim();
  if (s.startsWith("http")) return s;
  const path = s.startsWith("/") ? s : `/${s}`;
  return API_BASE ? `${API_BASE}${path}` : path;
}

type FileInfo = {
  file_id?: string;
  filename: string;
  /** From detection server: rgb vs thermal (per file or batch source). */
  source?: string;
  status: string;
  thumb_url?: string;
  annotated_url?: string;
  video_url?: string;
  /** Same job folder as `video_url` / `annotated.mp4` — from API when present. */
  original_url?: string;
  frames_url?: string;
  video_width?: number | null;
  video_height?: number | null;
  /** Per-box list (images from SAHI; videos: all boxes across frames, from detection server). */
  detections?: any[];
  image_width?: number | null;
  image_height?: number | null;
  stats?: { total_defects: number; avg_confidence: number; max_confidence: number; min_confidence: number; processing_time_ms: number };
  total_detections?: number;
  duration?: number;
  fps?: number;
  frames_analyzed?: number;
  avg_confidence?: number;
  max_confidence?: number;
  /** EXIF GPS at upload (same values as map / CorridorMap per-image picker). */
  gps?: { lat: number; lng: number } | null;
};

type RunEntry = {
  run_id: string;
  type: "image" | "video" | "thermal";
  /** DJI thermal batch from `/api/thermal/batch/*` — merged into `/api/runs`. */
  thermal_analysis_job?: boolean;
  /** Batch map pin: first image if ≤2 files, else mean of all images with GPS. */
  gps?: { lat: number; lng: number };
  status: string;
  total_files: number;
  completed: number;
  total_defects: number;
  needs_review: number;
  avg_confidence: number;
  created_at: number | string;
  _created_ts?: number;
  files: FileInfo[];
};

/** Demo-only labels for Assign dropdown (no backend). */
const ASSIGN_DEMO_USERS = ["A. Mammadov", "L. Hasanova", "R. Aliyev"];

/** API /api/runs maps job `complete` → `completed` and `active` → `processing`. */
function isRunBatchComplete(status: string) {
  return status === "complete" || status === "completed";
}

/** Table / filters: thermal image batches vs plain IMAGE / VIDEO. */
function runDisplayType(run: RunEntry): "image" | "video" | "thermal" {
  if (run.type === "thermal") return "thermal";
  if (run.type === "video") return "video";
  const files = run.files;
  if (files.length > 0 && files.every((f) => f.source === "thermal")) return "thermal";
  return "image";
}

function runUniqueFindingsCount(run: RunEntry): number {
  return run.files.reduce((s, f) => s + uniqueDefectTypeCount(f.detections), 0);
}

function timeAgo(ts: number | string) {
  const t = typeof ts === "string" ? new Date(ts).getTime() : ts > 1e12 ? ts : ts * 1000;
  if (!Number.isFinite(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 60_000) return "Just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
}

function formatDuration(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const mins = Math.floor(safeSeconds / 60);
  const secs = Math.floor(safeSeconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/** Folder under `/results/<id>/` (matches annotated.mp4); `video_url` often has it when `file_id` is absent. */
function videoResultsFolderId(f: Pick<FileInfo, "file_id" | "video_url">): string | null {
  if (f.file_id) return f.file_id;
  const u = f.video_url?.trim() || "";
  const m = u.match(/\/results\/([^/]+)\//);
  return m?.[1] ?? null;
}

export default function Runs() {
  const [runs, setRuns] = useState<RunEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(() => new Set());
  const [assignDropdown, setAssignDropdown] = useState<{
    runId: string;
    top: number;
    left: number;
  } | null>(null);
  const [previewRun, setPreviewRun] = useState<RunEntry | null>(null);
  const [previewFileIdx, setPreviewFileIdx] = useState(0);
  const [videoFetchedDetections, setVideoFetchedDetections] = useState<any[]>([]);
  const [videoDetectionsLoading, setVideoDetectionsLoading] = useState(false);
  const [thermalBatchResults, setThermalBatchResults] = useState<Record<string, unknown>[] | null>(null);
  const [thermalBatchJobMeta, setThermalBatchJobMeta] = useState<{
    palette?: number | null;
    object_type?: string | null;
  } | null>(null);
  const [thermalBatchLoading, setThermalBatchLoading] = useState(false);
  const [thermalScanRoiActive, setThermalScanRoiActive] = useState(false);
  const [thermalScanRoiStart, setThermalScanRoiStart] = useState<{ x: number; y: number } | null>(null);
  const [thermalScanRoiEnd, setThermalScanRoiEnd] = useState<{ x: number; y: number } | null>(null);
  const [thermalScanRoiStats, setThermalScanRoiStats] = useState<ThermalStats | null>(null);
  const [thermalScanRoiLoading, setThermalScanRoiLoading] = useState(false);
  const runsPreviewVideoRef = useRef<HTMLVideoElement | null>(null);
  const runsVideoFullscreenHostRef = useRef<HTMLDivElement | null>(null);
  const runsPreviewImgRef = useRef<HTMLImageElement>(null);
  const runsPreviewCanvasRef = useRef<HTMLCanvasElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const batchFromQuery = searchParams.get("batch");
  const highlightBoundaries = searchParams.get("highlight") === "1";
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());
  const appliedBatchRef = useRef<string | null>(null);
  const [previewModalZoom, setPreviewModalZoom] = useState(1);
  const rgbPreviewPan = useRgbPreviewPan(
    previewModalZoom,
    previewRun ? `${previewRun.run_id}:${previewFileIdx}` : null,
    "mx-auto max-w-full"
  );
  const [fileReviewStatusByRun, setFileReviewStatusByRun] = useState<Record<string, Record<string, "approved" | "canceled" | undefined>>>(() => {
    try {
      const raw = localStorage.getItem("runs_file_review_status_v1");
      const parsed = raw ? (JSON.parse(raw) as Record<string, Record<string, "approved" | "canceled" | undefined>>) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  });

  const [fileCommentByRun, setFileCommentByRun] = useState<Record<string, Record<string, string>>>(() => {
    try {
      const raw = localStorage.getItem("runs_file_comments_v1");
      const parsed = raw ? (JSON.parse(raw) as Record<string, Record<string, string>>) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  });
  const [batchAssigneeByRun, setBatchAssigneeByRun] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem("runs_batch_assignee_v1");
      const parsed = raw ? (JSON.parse(raw) as Record<string, string>) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  });
  const [activeCommentEditorKey, setActiveCommentEditorKey] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState<string>("");

  useEffect(() => {
    try {
      localStorage.setItem("runs_file_review_status_v1", JSON.stringify(fileReviewStatusByRun));
    } catch {
      /* ignore */
    }
  }, [fileReviewStatusByRun]);

  useEffect(() => {
    try {
      localStorage.setItem("runs_file_comments_v1", JSON.stringify(fileCommentByRun));
    } catch {
      /* ignore */
    }
  }, [fileCommentByRun]);

  useEffect(() => {
    try {
      localStorage.setItem("runs_batch_assignee_v1", JSON.stringify(batchAssigneeByRun));
    } catch {
      /* ignore */
    }
  }, [batchAssigneeByRun]);

  useEffect(() => {
    if (!assignDropdown) return;
    const close = () => setAssignDropdown(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [assignDropdown]);

  const setFileReviewStatus = useCallback((runId: string, fileKey: string, status: "approved" | "canceled" | undefined) => {
    setFileReviewStatusByRun((prev) => {
      const next = { ...prev };
      const curRun = { ...(next[runId] || {}) };
      if (status) curRun[fileKey] = status;
      else delete curRun[fileKey];
      next[runId] = curRun;
      return next;
    });
  }, []);

  const setFileComment = useCallback((runId: string, fileKey: string, comment: string) => {
    setFileCommentByRun((prev) => {
      const next = { ...prev };
      const curRun = { ...(next[runId] || {}) };
      const v = (comment || "").trim();
      if (v) curRun[fileKey] = v;
      else delete curRun[fileKey];
      next[runId] = curRun;
      return next;
    });
  }, []);

  const runCreatedTs = useCallback((r: Pick<RunEntry, "created_at">): number | null => {
    const ts = r.created_at;
    if (!ts) return null;
    if (typeof ts === "string") {
      const d = new Date(ts);
      const t = d.getTime();
      return Number.isFinite(t) ? t : null;
    }
    if (!Number.isFinite(ts)) return null;
    return ts > 1e12 ? ts : ts * 1000;
  }, []);

  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/runs");
      if (!res.ok) return;
      const data = await res.json();
      const arr = Array.isArray(data) ? data : (data.runs || []);
      setRuns(arr);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchRuns();
    const iv = setInterval(fetchRuns, 5000);
    return () => clearInterval(iv);
  }, [fetchRuns]);

  const clearBatchQuery = useCallback(() => {
    if (!searchParams.has("batch") && !searchParams.has("highlight")) return;
    const next = new URLSearchParams(searchParams);
    next.delete("batch");
    next.delete("highlight");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const closePreview = useCallback(() => {
    setPreviewRun(null);
    appliedBatchRef.current = null;
    clearBatchQuery();
  }, [clearBatchQuery]);

  useEffect(() => {
    if (!batchFromQuery || loading) return;
    if (appliedBatchRef.current === batchFromQuery) return;
    const run = runs.find((r) => r.run_id === batchFromQuery);
    if (!run) return;
    appliedBatchRef.current = batchFromQuery;
    setPreviewRun(run);
    setPreviewFileIdx(0);
    requestAnimationFrame(() => {
      rowRefs.current.get(batchFromQuery)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }, [batchFromQuery, loading, runs]);

  const filtered = runs.filter((r) => {
    if (typeFilter !== "all" && runDisplayType(r) !== typeFilter) return false;
    if (statusFilter === "complete" && !isRunBatchComplete(r.status)) return false;
    if (statusFilter === "active" && isRunBatchComplete(r.status)) return false;
    if (dateFrom || dateTo) {
      const t = runCreatedTs(r);
      if (t == null) return false;
      if (dateFrom) {
        const from = new Date(`${dateFrom}T00:00:00`).getTime();
        if (Number.isFinite(from) && t < from) return false;
      }
      if (dateTo) {
        const to = new Date(`${dateTo}T23:59:59.999`).getTime();
        if (Number.isFinite(to) && t > to) return false;
      }
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchId = r.run_id.toLowerCase().includes(q);
      const matchFile = r.files.some(f => f.filename.toLowerCase().includes(q));
      if (!matchId && !matchFile) return false;
    }
    return true;
  });

  const selectedCount = selectedRunIds.size;
  const toggleSelectedRun = useCallback((runId: string) => {
    setSelectedRunIds((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }, []);

  const completedFiles = previewRun?.files.filter((f) => f.status === "done") || [];
  const previewFile = completedFiles[previewFileIdx] || null;

  const previewDetectionRows = useMemo(() => {
    if (!previewRun || !previewFile) return [];
    return previewDetectionRowsForFile(previewRun.type, previewFile.detections, videoFetchedDetections) as Array<{
      class_name?: string;
      label?: string;
    }>;
  }, [previewRun, previewFile, videoFetchedDetections]);

  const previewClassFilterResetKey =
    previewRun && previewFile ? `${previewRun.run_id}:${previewFileIdx}` : null;
  const clsFilter = useDetectionClassFilterForRows(
    previewDetectionRows as DetectionRowLike[],
    previewClassFilterResetKey
  );

  const runsVideoOverlayUrls = useMemo(() => {
    if (!previewFile?.video_url?.trim()) return { originalUrl: undefined as string | undefined, framesUrl: undefined as string | undefined };
    const ext = previewFile as FileInfo & { original_url?: string; frames_url?: string };
    let originalUrl = ext.original_url?.trim() ? resolveThermalFetchUrl(ext.original_url.trim()) : undefined;
    let framesUrl = ext.frames_url?.trim() ? resolveThermalFetchUrl(ext.frames_url.trim()) : undefined;
    const absVideo = resolveThermalFetchUrl(previewFile.video_url.trim());
    const derived = videoResultsAuxUrlsFromAnnotatedVideoUrl(absVideo);
    if (derived) {
      if (!originalUrl) originalUrl = derived.originalUrl;
      if (!framesUrl) framesUrl = derived.framesUrl;
    }
    return { originalUrl, framesUrl };
  }, [previewFile]);

  const openPreview = (run: RunEntry, fileIdx = 0) => {
    setPreviewRun(run);
    setPreviewFileIdx(fileIdx);
  };

  const previewSidebarPartition = useMemo(() => {
    if (!previewDetectionRows.length) return null;
    return partitionDetectionsSidebarBuckets(previewDetectionRows);
  }, [previewDetectionRows]);

  const isDjiThermalScanUpload = Boolean(previewRun?.thermal_analysis_job);

  const runsPreviewSourceW = typeof previewFile?.image_width === "number" ? previewFile.image_width : 0;
  const runsPreviewSourceH = typeof previewFile?.image_height === "number" ? previewFile.image_height : 0;
  const runsPreviewHasSourceDims = runsPreviewSourceW > 0 && runsPreviewSourceH > 0;
  const runsPreviewThumbSrc = previewFile?.thumb_url?.trim() || "";
  const runsPreviewAnnotatedSrc = previewFile?.annotated_url?.trim() || "";
  const runsPreviewCleanSrc = (previewFile as Record<string, unknown>)?.clean_url
    ? String((previewFile as Record<string, unknown>).clean_url).trim()
    : "";
  const runsPreviewUnderlaySrc = runsPreviewCleanSrc || runsPreviewThumbSrc;
  const runsPreviewStaticSrc = runsPreviewAnnotatedSrc || runsPreviewThumbSrc;
  const runsPreviewShowLiveOverlay =
    !isDjiThermalScanUpload &&
    previewRun?.type !== "video" &&
    runsPreviewHasSourceDims &&
    Boolean(runsPreviewUnderlaySrc);

  const runsOverlayDetections = filterRowsForRgbPreviewOverlay(
    previewDetectionRows as DetectionRowLike[],
    clsFilter.hiddenSet,
    runsPreviewSourceW,
    runsPreviewSourceH
  ).filter((d) => Array.isArray(d.bbox) && d.bbox.length >= 4) as Array<{
    bbox: number[];
    class_name?: string;
    label?: string;
  }>;

  useRgbPreviewDetectionOverlay(runsPreviewImgRef, runsPreviewCanvasRef, {
    enabled: runsPreviewShowLiveOverlay,
    sourceW: runsPreviewSourceW,
    sourceH: runsPreviewSourceH,
    detections: runsOverlayDetections,
    imageUrlKey: `${previewRun?.run_id}:${previewFileIdx}:${runsPreviewUnderlaySrc}`,
    modalZoom: previewModalZoom,
  });
  const thermalResultRow: Record<string, unknown> | null = (() => {
    if (!isDjiThermalScanUpload || !previewFile || !thermalBatchResults?.length) return null;
    const pid = previewFile.file_id;
    const rows = thermalBatchResults;
    if (pid) {
      const byFid = rows.find((r) => (r as { file_id?: string }).file_id === pid);
      if (byFid) return byFid as Record<string, unknown>;
    }
    const byName = rows.find((r) => (r as { filename?: string }).filename === previewFile.filename);
    if (byName) return byName as Record<string, unknown>;
    return null;
  })();
  const thermalB64 = (thermalResultRow?.thermal_image_base64_png as string) || null;

    const thermalOriginalUrl =
      (thermalResultRow?.original_image_url as string) ||
      (thermalResultRow?.thermal_rjpeg_url as string) ||
      previewFile?.thumb_url ||
      previewFile?.annotated_url ||
      "";

    const thermalOriginalUrlResolved = useMemo(
      () => resolveThermalFetchUrl(thermalOriginalUrl),
      [thermalOriginalUrl]
    );

    const thermalVisualizationUrl =
      (thermalResultRow?.thermal_visualization_url as string) ||
      (thermalResultRow?.thermal_image_url as string) ||
      previewFile?.annotated_url ||
      previewFile?.thumb_url ||
      "";

    const thermalVisualizationUrlResolved = useMemo(
      () => resolveThermalFetchUrl(thermalVisualizationUrl),
      [thermalVisualizationUrl]
    );

    const thermalRjpegUrl = (thermalResultRow?.thermal_rjpeg_url as string) || "";
    const thermalRjpegResolved = useMemo(
      () => (thermalRjpegUrl ? resolveThermalFetchUrl(thermalRjpegUrl) : ""),
      [thermalRjpegUrl]
    );

    const thermalUnit = String(thermalResultRow?.unit ?? "Celsius");

  useEffect(() => {
    setThermalScanRoiActive(false);
    setThermalScanRoiStart(null);
    setThermalScanRoiEnd(null);
    setThermalScanRoiStats(null);
  }, [previewRun?.run_id, previewFileIdx, previewFile?.filename]);

  const handleThermalScanRoiMouseDown = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      if (!thermalScanRoiActive) return;
      const el = e.currentTarget;
      const st = (thermalResultRow?.stats as ThermalStats) ?? null;
      const w = el.naturalWidth > 0 ? el.naturalWidth : st?.width ?? 640;
      const h = el.naturalHeight > 0 ? el.naturalHeight : st?.height ?? 512;
      const rect = el.getBoundingClientRect();
      const x = Math.round(((e.clientX - rect.left) / rect.width) * w);
      const y = Math.round(((e.clientY - rect.top) / rect.height) * h);
      setThermalScanRoiStart({ x, y });
      setThermalScanRoiEnd(null);
      setThermalScanRoiStats(null);
    },
    [thermalScanRoiActive, thermalResultRow?.stats]
  );

  const handleThermalScanRoiMouseUp = useCallback(
    async (e: React.MouseEvent<HTMLImageElement>) => {
      if (!thermalScanRoiActive || !thermalScanRoiStart || !previewFile) return;
      const el = e.currentTarget;
      const st = (thermalResultRow?.stats as ThermalStats) ?? null;
      const w = el.naturalWidth > 0 ? el.naturalWidth : st?.width ?? 640;
      const h = el.naturalHeight > 0 ? el.naturalHeight : st?.height ?? 512;
      const rect = el.getBoundingClientRect();
      const x = Math.round(((e.clientX - rect.left) / rect.width) * w);
      const y = Math.round(((e.clientY - rect.top) / rect.height) * h);
      setThermalScanRoiEnd({ x, y });

      let x1 = Math.min(thermalScanRoiStart.x, x);
      let y1 = Math.min(thermalScanRoiStart.y, y);
      let x2 = Math.max(thermalScanRoiStart.x, x);
      let y2 = Math.max(thermalScanRoiStart.y, y);
      if (x2 <= x1) x2 = Math.min(w, x1 + 1);
      if (y2 <= y1) y2 = Math.min(h, y1 + 1);
      x1 = Math.max(0, Math.min(x1, w - 1));
      y1 = Math.max(0, Math.min(y1, h - 1));
      x2 = Math.max(x1 + 1, Math.min(x2, w));
      y2 = Math.max(y1 + 1, Math.min(y2, h));

      const filename = previewFile.filename || "thermal.jpg";
      setThermalScanRoiLoading(true);
      try {
        let file: File | null = null;
        if (thermalRjpegResolved) {
          const res = await fetch(thermalRjpegResolved);
          if (res.ok) {
            const blob = await res.blob();
            file = new File([blob], filename, { type: blob.type || "image/jpeg" });
          }
        }
        
        if (!file && thermalOriginalUrlResolved) {
          const res = await fetch(thermalOriginalUrlResolved);
          if (res.ok) {
            const blob = await res.blob();
            file = new File([blob], filename, { type: blob.type || "image/jpeg" });
          }
        }
        
        if (!file && thermalVisualizationUrlResolved) {
          const res = await fetch(thermalVisualizationUrlResolved);
          if (res.ok) {
            const blob = await res.blob();
            file = new File([blob], filename, { type: blob.type || "image/jpeg" });
          }
        }
        
        if (!file && thermalB64) {
          const res = await fetch(`data:image/png;base64,${thermalB64}`);
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
        form.append("unit", thermalUnit);
        const res = await fetch(`/api/thermal/roi`, { method: "POST", body: form });
        if (res.ok) {
          const data = await res.json();
          setThermalScanRoiStats((data.stats ?? data) as ThermalStats);
        }
      } catch {
        /* ignore */
      } finally {
        setThermalScanRoiLoading(false);
      }
    },
    [
      thermalScanRoiActive,
      thermalScanRoiStart,
      previewFile,
      thermalResultRow?.stats,
      thermalRjpegResolved,
      thermalOriginalUrlResolved,
      thermalVisualizationUrlResolved,
      thermalB64,
      thermalUnit,
    ]
  );

  const navigatePreview = (dir: number) => {
    if (completedFiles.length === 0) return;
    setPreviewFileIdx((previewFileIdx + dir + completedFiles.length) % completedFiles.length);
  };

  const openPreviewRunId = previewRun?.run_id;
  useEffect(() => {
    if (!openPreviewRunId) return;
    const latest = runs.find((r) => r.run_id === openPreviewRunId);
    if (latest) setPreviewRun(latest);
  }, [runs, openPreviewRunId]);

  useEffect(() => {
    if (previewRun?.type !== "video" || !previewFile) {
      setVideoFetchedDetections([]);
      setVideoDetectionsLoading(false);
      return;
    }
    const embedded = previewFile.detections;
    if (Array.isArray(embedded) && embedded.length > 0) {
      setVideoFetchedDetections([]);
      setVideoDetectionsLoading(false);
      return;
    }
    const rid = videoResultsFolderId(previewFile);
    if (!rid) {
      setVideoFetchedDetections([]);
      setVideoDetectionsLoading(false);
      return;
    }
    setVideoDetectionsLoading(true);
    setVideoFetchedDetections([]);
    let cancelled = false;
    fetch(`/api/video/detections/${encodeURIComponent(rid)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("missing"))))
      .then((data) => {
        if (!cancelled) setVideoFetchedDetections(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setVideoFetchedDetections([]);
      })
      .finally(() => {
        if (!cancelled) setVideoDetectionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [previewRun?.type, previewFile?.file_id, previewFile?.video_url, previewFile?.detections?.length]);

  useEffect(() => {
    if (!previewRun?.thermal_analysis_job) {
      setThermalBatchResults(null);
      setThermalBatchJobMeta(null);
      setThermalBatchLoading(false);
      return;
    }
    let cancelled = false;
    setThermalBatchLoading(true);
    setThermalBatchResults(null);
    setThermalBatchJobMeta(null);
    fetch(`/api/thermal/batch/results/${encodeURIComponent(previewRun.run_id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("thermal batch"))))
      .then((data) => {
        if (!cancelled) {
          setThermalBatchResults(Array.isArray(data.results) ? data.results : []);
          setThermalBatchJobMeta({
            palette: typeof data.palette === "number" ? data.palette : null,
            object_type: data.object_type != null ? String(data.object_type) : null,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setThermalBatchResults([]);
          setThermalBatchJobMeta(null);
        }
      })
      .finally(() => {
        if (!cancelled) setThermalBatchLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [previewRun?.run_id, previewRun?.thermal_analysis_job]);

  useEffect(() => {
    if (!previewRun) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const host = runsVideoFullscreenHostRef.current;
        const doc = document as Document & { webkitFullscreenElement?: Element | null };
        const fs = document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
        if (host && fs === host) return;
        closePreview();
      }
      if (e.key === "ArrowLeft") navigatePreview(-1);
      if (e.key === "ArrowRight") navigatePreview(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewRun, closePreview]);

  useEffect(() => {
    if (previewRun) return;
    const doc = document as Document & {
      webkitExitFullscreen?: () => Promise<void>;
      webkitFullscreenElement?: Element | null;
    };
    const fs = document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    if (fs) void (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
  }, [previewRun]);

  useEffect(() => {
    setPreviewModalZoom(1);
  }, [previewRun?.run_id, previewFileIdx]);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold dash-text-primary mb-2">Recent Uploads</h1>
          <p className="dash-text-muted">All uploaded images and videos with detection results</p>
        </div>
        <div className="flex items-center gap-2">
          <RunsReportGenerator
            runs={runs}
            selectedRunIds={selectedRunIds}
            selectedCount={selectedCount}
            runCreatedTs={runCreatedTs}
            fileReviewStatusByRun={fileReviewStatusByRun}
            fileCommentByRun={fileCommentByRun}
            batchAssigneeByRun={batchAssigneeByRun}
            hiddenClassKeys={clsFilter.hiddenSet}
          />
          <button
            onClick={() => {
              setLoading(true);
              fetchRuns();
            }}
            className="flex items-center gap-2 rounded-xl border border-[var(--dash-panel-border)] dash-text-body hover:dash-text-primary px-4 py-2 text-sm font-semibold hover:bg-[var(--dash-hover-bg)] transition-colors"
            style={{ backgroundColor: "var(--dash-inset-bg)" }}
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-2xl border border-[var(--dash-panel-border)] p-4 backdrop-blur-sm" style={{ backgroundColor: "var(--dash-nested-bg)" }}>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex-1 min-w-[200px] relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 dash-text-muted" size={18} />
            <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search by run ID or filename..."
              className="w-full rounded-xl border placeholder-[var(--dash-subtle)] pl-10 pr-4 py-2 text-sm outline-none focus:ring-2 focus:ring-cyan-500/50"
              style={{ backgroundColor: "var(--dash-inset-bg)", borderColor: "var(--dash-inset-border)", color: "var(--dash-heading)" }} />
          </div>
          <div className="flex items-center gap-2">
            <Filter className="dash-text-muted" size={18} />
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
              className="rounded-xl border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-cyan-500/50"
              style={{ backgroundColor: "var(--dash-inset-bg)", borderColor: "var(--dash-inset-border)", color: "var(--dash-heading)" }}>
              <option value="all">All types</option>
              <option value="image">Images</option>
              <option value="video">Videos</option>
              <option value="thermal">Thermal</option>
            </select>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
              className="rounded-xl border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-cyan-500/50"
              style={{ backgroundColor: "var(--dash-inset-bg)", borderColor: "var(--dash-inset-border)", color: "var(--dash-heading)" }}>
              <option value="all">All status</option>
              <option value="active">Processing</option>
              <option value="complete">Completed</option>
            </select>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="rounded-xl border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-cyan-500/50"
                style={{ backgroundColor: "var(--dash-inset-bg)", borderColor: "var(--dash-inset-border)", color: "var(--dash-heading)" }}
                aria-label="From date"
              />
              <span className="dash-text-subtle text-xs">to</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="rounded-xl border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-cyan-500/50"
                style={{ backgroundColor: "var(--dash-inset-bg)", borderColor: "var(--dash-inset-border)", color: "var(--dash-heading)" }}
                aria-label="To date"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Stats row */}
      {runs.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: "Total Runs", value: runs.length, color: "text-cyan-400" },
            { label: "Total Files", value: runs.reduce((s, r) => s + r.total_files, 0), color: "text-blue-400" },
            { label: "Detections", value: runs.reduce((s, r) => s + runUniqueFindingsCount(r), 0), color: "text-red-400" },
            { label: "Needs Review", value: runs.reduce((s, r) => s + r.needs_review, 0), color: "text-amber-400" },
          ].map(s => (
            <div key={s.label} className="rounded-xl border border-[var(--dash-panel-border)] p-4 backdrop-blur-sm" style={{ backgroundColor: "var(--dash-nested-bg)" }}>
              <div className="dash-text-muted mb-1">{s.label}</div>
              <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="rounded-2xl border border-[var(--dash-panel-border)] overflow-hidden backdrop-blur-sm" style={{ backgroundColor: "var(--dash-nested-bg)" }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="dash-text-body" style={{ backgroundColor: "var(--dash-nested-bg-mid)" }}>
              <tr>
                <th className="text-left px-6 py-4 font-semibold">Run ID</th>
                <th className="text-left px-6 py-4 font-semibold">Type</th>
                <th className="text-left px-6 py-4 font-semibold">Status</th>
                <th className="text-left px-6 py-4 font-semibold">Files</th>
                <th className="text-left px-6 py-4 font-semibold">Findings</th>
                <th className="text-left px-6 py-4 font-semibold">Needs Review</th>
                <th className="text-left px-6 py-4 font-semibold">Created</th>
                <th className="text-right px-6 py-4 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--dash-panel-border)]">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-16 text-center">
                    <ScanSearch className="mx-auto dash-text-subtle mb-4" size={48} />
                    <div className="dash-text-muted font-medium">
                      {runs.length === 0
                        ? "No uploads yet. Go to AI Detection or Video Upload to process files."
                        : "No runs match your filters."}
                    </div>
                  </td>
                </tr>
              ) : (
                filtered.map((run, i) => {
                  const dtype = runDisplayType(run);
                  const findingsCount = runUniqueFindingsCount(run);
                  const assigneeLabel = (batchAssigneeByRun[run.run_id] || "").trim();
                  const isSelected = selectedRunIds.has(run.run_id);
                  return (
                    <motion.tr key={run.run_id}
                      ref={(el) => {
                        if (el) rowRefs.current.set(run.run_id, el);
                        else rowRefs.current.delete(run.run_id);
                      }}
                      initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                      transition={{ delay: Math.min(i * 0.02, 0.3) }}
                      className={`hover:bg-[var(--dash-hover-bg)] transition-colors cursor-pointer ${
                        batchFromQuery === run.run_id ? "ring-2 ring-inset ring-cyan-500/70 bg-cyan-500/[0.07]" : ""
                      }`}
                      onClick={() => openPreview(run)}
                    >
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={(e) => {
                              e.stopPropagation();
                              toggleSelectedRun(run.run_id);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="h-4 w-4 accent-cyan-500"
                            aria-label={`Select batch ${run.run_id}`}
                          />
                          <span className="font-Poppins dash-text-primary text-xs truncate max-w-[120px]" title={run.run_id}>{run.run_id}</span>
                          <button onClick={e => { e.stopPropagation(); copyRunId(run.run_id); }}
                            className="p-1 rounded dash-text-subtle hover:dash-text-primary hover:bg-[var(--dash-hover-bg)] transition-colors" title="Copy">
                            <Copy size={12} />
                          </button>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-semibold border ${
                          dtype === "image"
                            ? "bg-blue-500/20 border-blue-500/50"
                            : dtype === "thermal"
                              ? "bg-orange-500/20 text-black-300 border-orange-500/50"
                              : "bg-purple-500/20 text-purple-300 border-purple-500/50"
                        }`}>
                          {dtype === "image" ? <Image size={12} /> : dtype === "thermal" ? <Thermometer size={12} /> : <Video size={12} />}
                          {dtype === "image" ? "IMAGE" : dtype === "thermal" ? "THERMAL" : "VIDEO"}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-semibold border ${
                          isRunBatchComplete(run.status)
                            ? "bg-emerald-500/20 border-emerald-500/50"
                            : "bg-amber-500/20 border-amber-500/50"
                        }`}>
                          {isRunBatchComplete(run.status) ? <CheckCircle2 size={12} /> : <Clock size={12} className="animate-spin" />}
                          {isRunBatchComplete(run.status) ? "COMPLETE" : "PROCESSING"}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <Layers size={14} className="dash-text-subtle" />
                          <span className="dash-text-body">{run.completed}/{run.total_files}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`font-semibold ${findingsCount > 0 ? "text-red-400" : "text-green-400"}`}>
                          {findingsCount}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        {run.needs_review > 0 ? (
                          <span className="inline-flex items-center gap-1 text-amber-400 font-medium">
                            <AlertTriangle size={13} /> {run.needs_review}
                          </span>
                        ) : (
                          <span className="dash-text-subtle">0</span>
                        )}
                      </td>
                      <td className="px-6 py-4 dash-text-body text-xs">{timeAgo(run.created_at)}</td>
                      <td className="px-6 py-4 text-right">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              const r = e.currentTarget.getBoundingClientRect();
                              const minW = 176;
                              const left = Math.min(Math.max(8, r.right - minW), window.innerWidth - minW - 8);
                              setAssignDropdown((cur) =>
                                cur?.runId === run.run_id ? null : { runId: run.run_id, top: r.bottom + 4, left }
                              );
                            }}
                            className="inline-flex min-w-0 max-w-[11rem] items-center gap-1 rounded-xl border border-neutral-700 bg-[rgb(66_106_240_/_60%)] px-3 py-2 text-sm font-semibold text-black-200 transition-colors hover:bg-neutral-700"
                            title={assigneeLabel || "Assign (demo)"}
                          >
                            <CheckCircle2 size={14} className="shrink-0" />
                            <span className="truncate">{assigneeLabel || "Assign"}</span>
                            <ChevronDown
                              size={14}
                              className={assignDropdown?.runId === run.run_id ? "rotate-180 transition-transform" : "transition-transform"}
                            />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openPreview(run);
                            }}
                            className="inline-flex items-center gap-1 rounded-xl bg-cyan-500/20 border border-cyan-500/50 px-3 py-2 text-sm font-semibold hover:bg-cyan-500/30 transition-colors"
                          >
                            <Eye size={14} /> View
                          </button>
                        </div>
                      </td>
                    </motion.tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {assignDropdown && typeof document !== "undefined" && createPortal(
        <>
          <div
            className="fixed inset-0 z-[150]"
            aria-hidden
            onClick={() => setAssignDropdown(null)}
          />
          <div
            role="listbox"
            aria-label="Assign to (demo)"
            className="fixed z-[151] min-w-[11rem] rounded-xl border border-neutral-700 bg-neutral-900 py-1 shadow-lg"
            style={{ top: assignDropdown.top, left: assignDropdown.left }}
            onClick={(e) => e.stopPropagation()}
          >
            {ASSIGN_DEMO_USERS.map((name) => (
              <button
                key={name}
                type="button"
                className="block w-full px-3 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800"
                onClick={(e) => {
                  e.stopPropagation();
                  const rid = assignDropdown.runId;
                  setBatchAssigneeByRun((prev) => {
                    const next = { ...prev };
                    if ((next[rid] || "").trim() === name) delete next[rid];
                    else next[rid] = name;
                    return next;
                  });
                  setAssignDropdown(null);
                }}
              >
                {name}
              </button>
            ))}
          </div>
        </>,
        document.body
      )}

      {/* Preview panel (portal: video | frame strip | sidebar, same as Video Upload) */}
      {previewRun && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-[200] flex min-h-0 min-w-0 w-full flex-row items-stretch bg-[var(--dash-overlay-scrim)]"
          role="presentation"
          onClick={() => closePreview()}
        >
          {completedFiles.length > 1 && !isDjiThermalScanUpload && (
            <>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); navigatePreview(-1); }}
                className="absolute top-1/2 z-10 -translate-y-1/2 rounded-full dash-text-primary p-2.5 hover:bg-[var(--dash-hover-bg)] transition-all duration-150 shadow-lg left-[max(1rem,calc(210px+0.5rem))] xl:left-[max(1rem,calc(240px+0.5rem))]"
                style={{ backgroundColor: "var(--dash-elevated-bg)" }}
              >
                <ChevronLeft size={20} />
              </button>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); navigatePreview(1); }}
                className={`absolute top-1/2 z-10 -translate-y-1/2 rounded-full dash-text-primary p-2.5 hover:bg-[var(--dash-hover-bg)] transition-all duration-150 shadow-lg ${
                  previewRun.type === "video"
                    ? "right-[max(1rem,calc(540px+0.5rem))]"
                    : "right-[max(1rem,calc(320px+0.5rem))]"
                }`}
                style={{ backgroundColor: "var(--dash-elevated-bg)" }}
              >
                <ChevronRight size={20} />
              </button>
            </>
          )}

          <div className="flex min-h-0 min-w-0 flex-1 flex-row items-stretch">
            {/* LEFT — Files (thumbnail grid) */}
            <div
              className="flex h-full min-h-0 w-[210px] xl:w-[240px] shrink-0 flex-col overflow-hidden border-r border-dash dash-modal-aside"
              onClick={e => e.stopPropagation()}
            >
              <div className="shrink-0 flex items-center justify-between px-3 py-2.5 border-b border-dash">
                <span className="text-[10px] font-bold uppercase tracking-widest dash-text-subtle">Files</span>
                <span className="text-[10px] tabular-nums dash-text-muted bg-[var(--dash-inset-bg)] border border-dash rounded px-1.5 py-0.5">
                  {previewRun.files.length}
                </span>
              </div>

              <div className="flex-1 overflow-y-auto min-h-0 p-2">
                <div className={previewRun.type === "video" ? "flex flex-col gap-1.5" : "grid grid-cols-2 gap-1.5"}>
                  {previewRun.files.map((f, idx) => {
                    const cIdx = completedFiles.indexOf(f);
                    const isActive = cIdx === previewFileIdx;
                    const fileKey = (f.file_id || f.filename || `${idx}`).trim();
                    const reviewStatus = (fileReviewStatusByRun[previewRun.run_id] || {})[fileKey];
                    const comment = (fileCommentByRun[previewRun.run_id] || {})[fileKey] || "";
                    const editorKey = `${previewRun.run_id}::${fileKey}`;
                    const editorOpen = activeCommentEditorKey === editorKey;
                    const rowKey = f.file_id || `${f.filename}-${idx}`;

                    const commentPanel =
                      f.status === "done" && (comment.trim() || editorOpen) ? (
                        <div className={previewRun.type === "video" ? "px-2 pb-2 -mt-0.5" : "col-span-2 px-0 pb-1"}>
                          <div
                            className="rounded-xl border border-[var(--dash-panel-border)] p-2.5"
                            style={{ backgroundColor: "var(--dash-nested-bg)" }}
                          >
                            <div className="flex items-center justify-between gap-2 mb-2">
                              <div className="flex items-center gap-1.5">
                                <MessageSquare size={10} className="dash-text-muted" />
                                <span className="text-[10px] font-semibold dash-text-muted uppercase tracking-wider">Note</span>
                              </div>
                              {editorOpen && (
                                <div className="flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setFileComment(previewRun.run_id, fileKey, commentDraft);
                                      setActiveCommentEditorKey(null);
                                    }}
                                    className="rounded-md px-2 py-0.5 text-[10px] font-semibold text-cyan-300 bg-cyan-500/15 border border-cyan-500/30 hover:bg-cyan-500/25 transition-colors"
                                  >
                                    Save
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setCommentDraft(comment || "");
                                      setActiveCommentEditorKey(null);
                                    }}
                                    className="rounded-md px-2 py-0.5 text-[10px] font-semibold dash-text-body border border-[var(--dash-panel-border)] hover:bg-[var(--dash-hover-bg)] transition-colors"
                                    style={{ backgroundColor: "var(--dash-nested-bg-mid)" }}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              )}
                            </div>

                            {editorOpen ? (
                              <textarea
                                value={commentDraft}
                                onChange={(e) => setCommentDraft(e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                rows={2}
                                placeholder="Add a note…"
                                className="w-full resize-none rounded-lg border px-2.5 py-2 text-[11px] outline-none focus:ring-1 focus:ring-cyan-500/50 placeholder-[var(--dash-subtle)] leading-relaxed"
                                style={{
                                  backgroundColor: "var(--dash-inset-bg)",
                                  borderColor: "var(--dash-inset-border)",
                                  color: "var(--dash-heading)",
                                }}
                              />
                            ) : (
                              <p className="text-[11px] dash-text-body leading-relaxed">{comment}</p>
                            )}
                          </div>
                        </div>
                      ) : null;

                    if (previewRun.type === "video") {
                      return (
                        <div key={rowKey} className="w-full">
                          <button
                            onClick={() => {
                              if (cIdx >= 0) setPreviewFileIdx(cIdx);
                            }}
                            className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-all duration-100 ${
                              isActive
                                ? "bg-cyan-500/15 border border-cyan-500/40 ring-1 ring-cyan-500/20"
                                : "hover:bg-[var(--dash-hover-bg)] border border-transparent"
                            } ${f.status !== "done" ? "opacity-40 cursor-default" : "cursor-pointer"}`}
                          >
                            {f.thumb_url ? (
                              <img src={f.thumb_url} className="w-9 h-9 rounded-lg object-cover flex-shrink-0" alt="" />
                            ) : (
                              <div
                                className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                                style={{ backgroundColor: "var(--dash-inset-bg)" }}
                              >
                                {runDisplayType(previewRun) === "video" ? (
                                  <Video size={13} className="dash-text-subtle" />
                                ) : runDisplayType(previewRun) === "thermal" ? (
                                  <Thermometer size={13} className="dash-text-subtle" />
                                ) : (
                                  <Image size={13} className="dash-text-subtle" />
                                )}
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="text-[11px] dash-text-primary truncate font-medium">{f.filename}</div>
                              <div className="text-[10px] dash-text-subtle mt-0.5">
                                {f.status === "done" ? (
                                  <span className="text-emerald-400/80">
                                    {previewRun.type === "video"
                                      ? `${f.total_detections || 0} detections`
                                      : `${uniqueDefectTypeCount(f.detections)} defects`}
                                  </span>
                                ) : f.status === "processing" ? (
                                  <span className="text-amber-400">Processing…</span>
                                ) : f.status === "error" ? (
                                  <span className="text-red-400">Error</span>
                                ) : (
                                  <span className="dash-text-subtle">Queued</span>
                                )}
                              </div>
                            </div>
                          </button>
                          {commentPanel}
                        </div>
                      );
                    }

                    return (
                      <React.Fragment key={rowKey}>
                        <div className="min-w-0">
                          <div
                            className={`flex flex-col overflow-hidden rounded-xl border transition-all duration-100 ${
                              isActive
                                ? "border-cyan-500/40 bg-cyan-500/10 ring-1 ring-cyan-500/20"
                                : "border-[var(--dash-panel-border)] bg-[var(--dash-nested-bg-soft)] hover:bg-[var(--dash-hover-bg)] hover:border-[var(--dash-hover-border)]"
                            } ${f.status !== "done" ? "opacity-40" : ""}`}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                if (cIdx >= 0) setPreviewFileIdx(cIdx);
                              }}
                              className={`flex w-full flex-col p-2 text-left ${
                                f.status !== "done" ? "cursor-default" : "cursor-pointer"
                              }`}
                            >
                              <div className="relative mb-1.5 aspect-square w-full overflow-hidden rounded-lg bg-[var(--dash-inset-bg)]">
                                {f.thumb_url ? (
                                  <img src={f.thumb_url} className="h-full w-full object-cover" alt="" />
                                ) : (
                                  <div className="absolute inset-0 flex items-center justify-center">
                                    {runDisplayType(previewRun) === "thermal" ? (
                                      <Thermometer size={14} className="dash-text-subtle" />
                                    ) : (
                                      <Image size={14} className="dash-text-subtle" />
                                    )}
                                  </div>
                                )}

                                {isActive && (
                                  <span className="absolute bottom-1 right-1 z-[1] rounded-full bg-emerald-500 p-0.5 shadow-sm">
                                    <CheckCircle2 size={8} className="text-white" strokeWidth={3} />
                                  </span>
                                )}

                                {f.status === "processing" && (
                                  <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30 rounded-lg">
                                    <Clock size={14} className="animate-spin text-amber-400" />
                                  </span>
                                )}

                                {f.status === "error" && (
                                  <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30 rounded-lg">
                                    <XCircle size={14} className="text-red-400" />
                                  </span>
                                )}
                              </div>

                              <div className="truncate text-[10px] font-medium dash-text-primary leading-tight" title={f.filename}>
                                {f.filename}
                              </div>

                              <div className="mt-0.5 text-[9px] font-semibold">
                                {f.status === "done" ? (
                                  <span className="text-emerald-400">{`${uniqueDefectTypeCount(f.detections)} defects`}</span>
                                ) : f.status === "processing" ? (
                                  <span className="text-amber-400">Processing…</span>
                                ) : f.status === "error" ? (
                                  <span className="text-red-400">Error</span>
                                ) : (
                                  <span className="dash-text-subtle">Queued</span>
                                )}
                              </div>
                            </button>

                            {f.status === "done" && (
                              <div
                                className="flex flex-wrap items-center justify-center gap-1 border-t border-[var(--dash-panel-border)] px-1.5 py-1.5"
                                style={{ backgroundColor: "var(--dash-nested-bg-mid)" }}
                              >
                                {reviewStatus === "approved" && (
                                  <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[8px] font-semibold leading-tight text-emerald-400">
                                    Approved
                                  </span>
                                )}
                                {reviewStatus === "canceled" && (
                                  <span className="rounded-md border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[8px] font-semibold leading-tight text-red-300">
                                    Canceled
                                  </span>
                                )}

                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (editorOpen) {
                                      setActiveCommentEditorKey(null);
                                      return;
                                    }
                                    setActiveCommentEditorKey(editorKey);
                                    setCommentDraft(comment || "");
                                  }}
                                  className={`rounded-lg border p-1 transition-colors ${
                                    editorOpen
                                      ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-300"
                                      : "border-[var(--dash-panel-border)] dash-text-body hover:dash-text-primary hover:bg-[var(--dash-hover-bg)]"
                                  }`}
                                  style={!editorOpen ? { backgroundColor: "var(--dash-nested-bg-mid)" } : undefined}
                                  title="Comment"
                                  aria-label="Comment"
                                >
                                  <MessageSquare size={11} />
                                </button>

                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setFileReviewStatus(previewRun.run_id, fileKey, "approved");
                                  }}
                                  className={`rounded-lg border p-1 transition-colors ${
                                    reviewStatus === "approved"
                                      ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-400"
                                      : "border-[var(--dash-panel-border)] dash-text-body hover:dash-text-primary hover:bg-[var(--dash-hover-bg)]"
                                  }`}
                                  style={reviewStatus !== "approved" ? { backgroundColor: "var(--dash-nested-bg-mid)" } : undefined}
                                  title="Approve"
                                  aria-label="Approve"
                                >
                                  <CheckCircle2 size={11} />
                                </button>

                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setFileReviewStatus(previewRun.run_id, fileKey, "canceled");
                                  }}
                                  className={`rounded-lg border p-1 transition-colors ${
                                    reviewStatus === "canceled"
                                      ? "border-red-500/50 bg-red-500/15 text-red-300"
                                      : "border-[var(--dash-panel-border)] dash-text-body hover:dash-text-primary hover:bg-[var(--dash-hover-bg)]"
                                  }`}
                                  style={reviewStatus !== "canceled" ? { backgroundColor: "var(--dash-nested-bg-mid)" } : undefined}
                                  title="Cancel"
                                  aria-label="Cancel"
                                >
                                  <XCircle size={11} />
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                        {commentPanel}
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* CENTER — Main preview (centered in remaining space) */}
            <div
              className={`flex min-h-0 min-w-0 flex-1 flex-row items-stretch justify-center ${
                isDjiThermalScanUpload ? "" : "bg-black"
              }`}
            >
              {isDjiThermalScanUpload ? (
                <div
                  className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                  style={{ backgroundColor: "var(--dash-media-bg)" }}
                  onClick={e => e.stopPropagation()}
                >
                  <ThermalAnalysisDetailHeader
                    filename={previewFile?.filename ?? "Thermal"}
                    fileIndexDisplay={previewFileIdx}
                    fileCountDisplay={completedFiles.length}
                    onPrev={() => navigatePreview(-1)}
                    onNext={() => navigatePreview(1)}
                    compact
                  />
                  <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
                    <ThermalAnalysisDetailInner
                      thermalImageB64={undefined}
                      thermalImageUrl={
                        thermalVisualizationUrlResolved || thermalOriginalUrlResolved || null
                      }
                      stats={(thermalResultRow?.stats as ThermalStats) ?? null}
                      analysis={(thermalResultRow?.analysis as ThermalAnalysisData) ?? null}
                      unit={thermalUnit}
                      analysisConfiguration={{
                        objectType: thermalBatchJobMeta?.object_type ?? null,
                        paletteId: thermalBatchJobMeta?.palette ?? null,
                      }}
                      loading={thermalBatchLoading}
                      enableRoi
                      roiActive={thermalScanRoiActive}
                      onToggleRoi={() => {
                        setThermalScanRoiActive((a) => !a);
                        setThermalScanRoiStart(null);
                        setThermalScanRoiEnd(null);
                        setThermalScanRoiStats(null);
                      }}
                      roiStart={thermalScanRoiStart}
                      roiEnd={thermalScanRoiEnd}
                      roiStats={thermalScanRoiStats}
                      roiLoading={thermalScanRoiLoading}
                      onImageMouseDown={handleThermalScanRoiMouseDown}
                      onImageMouseUp={handleThermalScanRoiMouseUp}
                    />
                  </div>
                </div>
              ) : (
                <>
                  <div
                    className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center overflow-auto scrollbar-gutter-stable p-6 md:p-10 w-full"
                    onClick={e => e.stopPropagation()}
                  >
                    {previewFile ? (
                      previewRun.type === "video" && previewFile.video_url ? (
                        <VideoJobPreviewShell
                          videoUrl={resolveThermalFetchUrl(previewFile.video_url.trim())}
                          originalUrl={runsVideoOverlayUrls.originalUrl}
                          framesUrl={runsVideoOverlayUrls.framesUrl}
                          fps={previewFile.fps || 30}
                          videoWidth={previewFile.video_width ?? undefined}
                          videoHeight={previewFile.video_height ?? undefined}
                          hiddenClassKeys={clsFilter.hiddenSet}
                          videoRef={runsPreviewVideoRef}
                          fullscreenHostRef={runsVideoFullscreenHostRef}
                          zoom={previewModalZoom}
                          setZoom={setPreviewModalZoom}
                          panResetKey={`${previewRun.run_id}:${previewFileIdx}:v`}
                          exitFullscreenDependency={`${previewRun.run_id}:${previewFileIdx}`}
                          fileIndexLabel={`${previewFileIdx + 1} / ${completedFiles.length}`}
                          onScrollAreaClick={(e) => e.stopPropagation()}
                          shellExtraClassName="w-full"
                          scrollAreaClassName="flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto scrollbar-gutter-stable p-6 md:p-10"
                          playerClassName="max-h-[min(80vh,calc(100vh-8rem))] w-full max-w-full rounded-2xl bg-black shadow-2xl"
                        />
                      ) : (
                        <div className="relative mx-auto flex w-full max-w-5xl flex-col items-center">
                          {(previewFile.annotated_url || runsPreviewThumbSrc) && (
                            <div
                              className="absolute top-3 left-3 z-10 flex items-center gap-0.5 rounded-xl border border-[var(--dash-panel-border)] overflow-hidden shadow-lg"
                              style={{ backgroundColor: "var(--dash-elevated-bg)" }}
                            >
                              <button
                                type="button"
                                onClick={() =>
                                  setPreviewModalZoom((z) =>
                                    Math.max(RGB_PREVIEW_ZOOM_MIN, z - RGB_PREVIEW_ZOOM_STEP)
                                  )
                                }
                                className="p-2 dash-text-primary hover:bg-[var(--dash-hover-bg)] transition-colors"
                              >
                                <ZoomOut size={15} />
                              </button>
                              <span className="px-2 text-xs dash-text-body min-w-[3.25rem] text-center font-medium tabular-nums">
                                {Math.round(previewModalZoom * 100)}%
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  setPreviewModalZoom((z) =>
                                    Math.min(RGB_PREVIEW_ZOOM_MAX, z + RGB_PREVIEW_ZOOM_STEP)
                                  )
                                }
                                className="p-2 dash-text-primary hover:bg-[var(--dash-hover-bg)] transition-colors"
                              >
                                <ZoomIn size={15} />
                              </button>
                              <div className="w-px h-5 bg-[var(--dash-panel-border)]" />
                              <button
                                type="button"
                                onClick={() => setPreviewModalZoom(1)}
                                className="p-2 dash-text-primary hover:bg-[var(--dash-hover-bg)] transition-colors"
                              >
                                <RotateCcw size={13} />
                              </button>
                            </div>
                          )}

                          <div
                            className="absolute top-3 right-3 z-10 rounded-lg border border-[var(--dash-panel-border)] px-3 py-1.5 text-xs dash-text-body font-medium tabular-nums shadow-sm"
                            style={{ backgroundColor: "var(--dash-elevated-bg)" }}
                          >
                            {previewFileIdx + 1} / {completedFiles.length}
                          </div>

                          {(previewFile.annotated_url || runsPreviewThumbSrc) ? (
                            <div {...rgbPreviewPan}>
                              <div
                                className="relative mx-auto inline-block max-w-full rounded-2xl shadow-2xl transition-[transform] duration-150 ease-out"
                                style={{ transform: `scale(${previewModalZoom})`, transformOrigin: "center" }}
                              >
                                {runsPreviewShowLiveOverlay ? (
                                  <>
                                    <img
                                      ref={runsPreviewImgRef}
                                      src={runsPreviewUnderlaySrc}
                                      alt={previewFile.filename}
                                      className="w-full max-h-[80vh] rounded-2xl object-contain bg-black block"
                                      draggable={false}
                                    />
                                    <canvas
                                      ref={runsPreviewCanvasRef}
                                      className="pointer-events-none absolute inset-0 h-full w-full rounded-2xl"
                                      aria-hidden
                                    />
                                  </>
                                ) : (
                                  <img
                                    src={runsPreviewStaticSrc}
                                    alt={previewFile.filename}
                                    className="w-full max-h-[80vh] rounded-2xl object-contain bg-black"
                                  />
                                )}
                              </div>
                            </div>
                          ) : (
                            <div
                              className="mx-auto flex aspect-video w-full max-w-3xl items-center justify-center rounded-2xl dash-text-subtle text-sm"
                              style={{ backgroundColor: "var(--dash-nested-bg)" }}
                            >
                              No preview available
                            </div>
                          )}
                        </div>
                      )
                    ) : (
                      <div className="text-base dash-text-subtle">No completed files to preview</div>
                    )}
                  </div>

                  {previewRun.type === "video" && previewFile?.video_url && (
                    <VideoAnnotatedFrameStrip
                      videoUrl={resolveThermalFetchUrl(previewFile.video_url.trim())}
                      duration={previewFile.duration || 0}
                      fps={previewFile.fps || 0}
                      framesAnalyzed={previewFile.frames_analyzed || 0}
                      mainVideoRef={runsPreviewVideoRef}
                      framesUrl={runsVideoOverlayUrls.framesUrl}
                      hiddenClassKeys={clsFilter.hiddenSet}
                    />
                  )}
                </>
              )}
            </div>

            {/* RIGHT — Stats & details (match Video Upload preview sidebar) */}
            <div
              className="flex h-full min-h-0 w-[320px] shrink-0 flex-col overflow-hidden border-l border-[var(--dash-panel-border)]"
              style={{ backgroundColor: "var(--dash-modal-aside)" }}
              onClick={e => e.stopPropagation()}
            >
              <div className="flex shrink-0 items-stretch border-b border-[var(--dash-panel-border)]">
                <div className="flex min-w-0 flex-1 items-center px-3 py-2.5">
                  <span className="text-[10px] font-bold uppercase tracking-widest dash-text-subtle">Run</span>
                </div>
                <button
                  type="button"
                  onClick={() => closePreview()}
                  className="flex shrink-0 items-center justify-center px-3 border-l border-[var(--dash-panel-border)] hover:bg-[var(--dash-hover-bg)] transition-colors"
                  aria-label="Close preview"
                >
                  <X size={18} className="dash-text-subtle" />
                </button>
              </div>
              <div className="shrink-0 p-4 border-b border-[var(--dash-panel-border)]">
                <div className="flex items-center gap-2 mb-2">
                  <span className={`px-2 py-0.5 rounded text-xs font-bold border ${
                    runDisplayType(previewRun) === "image"
                      ? "bg-blue-500/20 text-blue-300 border-blue-500/50"
                      : runDisplayType(previewRun) === "thermal"
                        ? "bg-orange-500/20 text-orange-300 border-orange-500/50"
                        : "bg-purple-500/20 text-purple-300 border-purple-500/50"
                  }`}>
                    {runDisplayType(previewRun).toUpperCase()}
                  </span>
                  <span className={`px-2 py-0.5 rounded text-xs font-bold border ${
                    isRunBatchComplete(previewRun.status)
                      ? "bg-green-500/20 text-green-300 border-green-500/50"
                      : "bg-amber-500/20 text-amber-300 border-amber-500/50"
                  }`}>
                    {isRunBatchComplete(previewRun.status) ? "COMPLETE" : "PROCESSING"}
                  </span>
                </div>
                <div className="text-sm font-Poppins dash-text-muted truncate" title={previewRun.run_id}>
                  ID: {previewRun.run_id}
                </div>
                <div className="text-xs dash-text-subtle mt-1">{timeAgo(previewRun.created_at)}</div>
              </div>

              <div className="shrink-0 p-4 border-b border-[var(--dash-panel-border)] text-center">
                <div className="rounded-lg border border-[var(--dash-panel-border)] p-3 min-w-0" style={{ backgroundColor: "var(--dash-inset-bg)" }}>
                    <div className="text-xs dash-text-muted font-medium uppercase tracking-wide mb-1">Detections</div>
                    {previewFile != null && previewRun ? (
                      previewRun.type === "video" &&
                      previewDetectionRows.length === 0 &&
                      (previewFile.total_detections || 0) > 0 &&
                      videoDetectionsLoading ? (
                        <div className="mt-0.5 text-sm font-bold dash-text-subtle">Loading…</div>
                      ) : previewSidebarPartition ? (
                        <div
                          className={`mt-0.5 flex flex-wrap items-center justify-center gap-x-4 text-sm font-semibold leading-snug ${
                            previewSidebarPartition.defects.length > 0 ? "text-red-400" : "text-green-400"
                          }`}
                        >
                          <span>{previewSidebarPartition.components.length} components</span>
                          <span>{previewSidebarPartition.defects.length} defects</span>
                        </div>
                      ) : (
                        <div className={`text-xl font-bold tabular-nums ${previewRun.total_defects > 0 ? "text-red-400" : "text-green-400"}`}>
                          {previewRun.total_defects}
                        </div>
                      )
                    ) : (
                      <div className={`text-xl font-bold tabular-nums ${previewRun.total_defects > 0 ? "text-red-400" : "text-green-400"}`}>
                        {previewRun.total_defects}
                      </div>
                    )}
                </div>
              </div>

              {previewFile && (
                <div className="shrink-0 p-4 border-b border-[var(--dash-panel-border)]">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-xs dash-text-muted mb-2">Current File</div>
                      <div
                        className="text-sm dash-text-primary truncate font-medium leading-snug"
                        title={previewFile.filename}
                      >
                        {previewFile.filename}
                      </div>
                    </div>
                    {!isDjiThermalScanUpload && runDisplayType(previewRun) !== "thermal" && (
                      <DetectionClassFilterDropdown
                        filterClassKeys={clsFilter.filterClassKeys}
                        hiddenSet={clsFilter.hiddenSet}
                        open={clsFilter.open}
                        setOpen={clsFilter.setOpen}
                        anchorRef={clsFilter.anchorRef}
                        toggleKey={clsFilter.toggleKey}
                        showAll={clsFilter.showAll}
                        hideAll={clsFilter.hideAll}
                        liveOverlayEnabled={
                          runsPreviewShowLiveOverlay ||
                          (previewRun.type === "video" &&
                            Boolean(runsVideoOverlayUrls.originalUrl && runsVideoOverlayUrls.framesUrl))
                        }
                      />
                    )}
                  </div>

                  {previewRun.type !== "video" && previewFile.stats && (
                    <div className="flex items-center justify-between text-xs mt-3">
                      <span className="dash-text-muted">Processing time</span>
                      <span className="dash-text-primary font-semibold tabular-nums">
                        {previewFile.stats.processing_time_ms}ms
                      </span>
                    </div>
                  )}

                  {previewRun.type === "video" && (
                    <div className="mt-3 space-y-2 text-xs">
                      <div className="flex justify-between dash-text-body">
                        <span>Duration</span>
                        <span className="dash-text-primary font-semibold">{formatDuration(previewFile.duration || 0)}</span>
                      </div>
                      <div className="flex justify-between dash-text-body">
                        <span>FPS</span>
                        <span className="dash-text-primary font-semibold">{previewFile.fps || 0}</span>
                      </div>
                      <div className="flex justify-between dash-text-body">
                        <span>Frames Analyzed</span>
                        <span className="dash-text-primary font-semibold">{previewFile.frames_analyzed || 0}</span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {previewRun.type === "video" &&
                previewFile &&
                videoDetectionsLoading &&
                previewDetectionRows.length === 0 &&
                (previewFile.total_detections || 0) > 0 && (
                  <div className="shrink-0 border-b border-[var(--dash-panel-border)] p-4 text-xs dash-text-subtle">Loading defect list…</div>
                )}

              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {previewFile && previewSidebarPartition &&
                  (previewSidebarPartition.components.length > 0 || previewSidebarPartition.defects.length > 0) && (
                    <div className="overflow-hidden rounded-lg border border-dash">
                      <DetectionSidebarBucketPanels partition={previewSidebarPartition} hideRowCounts />
                    </div>
                  )}
              </div>
            </div>
          </div>
        </div>
      , document.body)
      }
    </motion.div>
  );
}
