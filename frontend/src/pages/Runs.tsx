import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";
import { toast } from "../components/Toast";
import { VideoAnnotatedFrameStrip } from "../components/VideoAnnotatedFrameStrip";
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
} from "lucide-react";
import { API_BASE } from "../api/api";

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
  /** Per-box list (images from SAHI; videos: all boxes across frames, from detection server). */
  detections?: any[];
  stats?: { total_defects: number; avg_confidence: number; max_confidence: number; min_confidence: number; processing_time_ms: number };
  total_detections?: number;
  duration?: number;
  fps?: number;
  frames_analyzed?: number;
  avg_confidence?: number;
  max_confidence?: number;
};

type RunEntry = {
  run_id: string;
  type: "image" | "video" | "thermal";
  /** DJI thermal batch from `/api/thermal/batch/*` — merged into `/api/runs`. */
  thermal_analysis_job?: boolean;
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

function copyRunId(runId: string) {
  navigator.clipboard.writeText(runId).then(
    () => toast.success("Run ID copied", 2000),
    () => toast.error("Copy failed", 3000)
  );
}

function timeAgo(ts: number | string | undefined): string {
  if (!ts) return "—";
  let d: Date;
  if (typeof ts === "string") {
    d = new Date(ts);
  } else {
    d = ts > 1e12 ? new Date(ts) : new Date(ts * 1000);
  }
  if (isNaN(d.getTime())) return "—";
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString();
}

function formatDuration(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** API `/api/runs` maps job `complete` → `completed` and `active` → `processing`. */
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

/** Folder under `/results/<id>/` (matches annotated.mp4); `video_url` often has it when `file_id` is absent. */
function videoResultsFolderId(f: Pick<FileInfo, "file_id" | "video_url">): string | null {
  if (f.file_id) return f.file_id;
  const u = f.video_url?.trim() || "";
  const m = u.match(/\/results\/([^/]+)\//);
  return m?.[1] ?? null;
}

function DefectBboxOverlays(props: { detections: Array<{ bbox?: number[] }>; imgW: number; imgH: number }) {
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

export default function Runs() {
  const [runs, setRuns] = useState<RunEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
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
  const runsPreviewVideoRef = useRef<HTMLVideoElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const batchFromQuery = searchParams.get("batch");
  const highlightBoundaries = searchParams.get("highlight") === "1";
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());
  const appliedBatchRef = useRef<string | null>(null);
  const [previewImageDims, setPreviewImageDims] = useState({ w: 0, h: 0 });

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
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchId = r.run_id.toLowerCase().includes(q);
      const matchFile = r.files.some(f => f.filename.toLowerCase().includes(q));
      if (!matchId && !matchFile) return false;
    }
    return true;
  });

  const openPreview = (run: RunEntry, fileIdx = 0) => {
    setPreviewRun(run);
    setPreviewFileIdx(fileIdx);
  };

  const completedFiles = previewRun?.files.filter(f => f.status === "done") || [];
  const previewFile = completedFiles[previewFileIdx] || null;

  const isDjiThermalScanUpload = Boolean(previewRun?.thermal_analysis_job);
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
  const thermalUrl =
    (thermalResultRow?.thermal_image_url as string) || previewFile?.annotated_url || previewFile?.thumb_url || "";
  const thermalUrlResolved = useMemo(() => resolveThermalFetchUrl(thermalUrl), [thermalUrl]);
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

  useEffect(() => {
    setPreviewImageDims({ w: 0, h: 0 });
  }, [previewRun?.run_id, previewFileIdx, previewFile?.annotated_url, isDjiThermalScanUpload]);

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
        if (!file && thermalUrlResolved) {
          const res = await fetch(thermalUrlResolved);
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
      thermalUrlResolved,
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
      if (e.key === "Escape") closePreview();
      if (e.key === "ArrowLeft") navigatePreview(-1);
      if (e.key === "ArrowRight") navigatePreview(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewRun, closePreview]);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">Recent Uploads</h1>
          <p className="text-neutral-400">All uploaded images and videos with detection results</p>
        </div>
        <button onClick={() => { setLoading(true); fetchRuns(); }}
          className="flex items-center gap-2 rounded-xl bg-neutral-800 border border-neutral-700 text-neutral-300 hover:text-white px-4 py-2 text-sm font-semibold hover:bg-neutral-700 transition-colors">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/50 p-4 backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex-1 min-w-[200px] relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={18} />
            <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search by run ID or filename..."
              className="w-full rounded-xl bg-neutral-800 border border-neutral-700 text-white placeholder-neutral-500 pl-10 pr-4 py-2 text-sm outline-none focus:ring-2 focus:ring-cyan-500/50" />
          </div>
          <div className="flex items-center gap-2">
            <Filter className="text-neutral-400" size={18} />
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
              className="rounded-xl bg-neutral-800 border border-neutral-700 text-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-cyan-500/50">
              <option value="all">All types</option>
              <option value="image">Images</option>
              <option value="video">Videos</option>
              <option value="thermal">Thermal</option>
            </select>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
              className="rounded-xl bg-neutral-800 border border-neutral-700 text-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-cyan-500/50">
              <option value="all">All status</option>
              <option value="active">Processing</option>
              <option value="complete">Completed</option>
            </select>
          </div>
        </div>
      </div>

      {/* Stats row */}
      {runs.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: "Total Runs", value: runs.length, color: "text-cyan-400" },
            { label: "Total Files", value: runs.reduce((s, r) => s + r.total_files, 0), color: "text-blue-400" },
            { label: "Total Defects", value: runs.reduce((s, r) => s + r.total_defects, 0), color: "text-red-400" },
            { label: "Needs Review", value: runs.reduce((s, r) => s + r.needs_review, 0), color: "text-amber-400" },
          ].map(s => (
            <div key={s.label} className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4 backdrop-blur-sm">
              <div className="text-xs text-neutral-400 mb-1">{s.label}</div>
              <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/50 overflow-hidden backdrop-blur-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-800/50 text-neutral-300">
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
            <tbody className="divide-y divide-neutral-800">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-16 text-center">
                    <ScanSearch className="mx-auto text-neutral-500 mb-4" size={48} />
                    <div className="text-neutral-400 font-medium">
                      {runs.length === 0
                        ? "No uploads yet. Go to AI Detection or Video Upload to process files."
                        : "No runs match your filters."}
                    </div>
                  </td>
                </tr>
              ) : (
                filtered.map((run, i) => {
                  const dtype = runDisplayType(run);
                  return (
                    <motion.tr key={run.run_id}
                      ref={(el) => {
                        if (el) rowRefs.current.set(run.run_id, el);
                        else rowRefs.current.delete(run.run_id);
                      }}
                      initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                      transition={{ delay: Math.min(i * 0.02, 0.3) }}
                      className={`hover:bg-neutral-800/50 transition-colors cursor-pointer ${
                        batchFromQuery === run.run_id ? "ring-2 ring-inset ring-cyan-500/70 bg-cyan-500/[0.07]" : ""
                      }`}
                      onClick={() => openPreview(run)}
                    >
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-white text-xs truncate max-w-[120px]" title={run.run_id}>{run.run_id}</span>
                          <button onClick={e => { e.stopPropagation(); copyRunId(run.run_id); }}
                            className="p-1 rounded text-neutral-500 hover:text-white hover:bg-neutral-700 transition-colors" title="Copy">
                            <Copy size={12} />
                          </button>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-semibold border ${
                          dtype === "image"
                            ? "bg-blue-500/20 text-blue-300 border-blue-500/50"
                            : dtype === "thermal"
                              ? "bg-orange-500/20 text-orange-300 border-orange-500/50"
                              : "bg-purple-500/20 text-purple-300 border-purple-500/50"
                        }`}>
                          {dtype === "image" ? <Image size={12} /> : dtype === "thermal" ? <Thermometer size={12} /> : <Video size={12} />}
                          {dtype === "image" ? "IMAGE" : dtype === "thermal" ? "THERMAL" : "VIDEO"}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-semibold border ${
                          isRunBatchComplete(run.status)
                            ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/50"
                            : "bg-amber-500/20 text-amber-400 border-amber-500/50"
                        }`}>
                          {isRunBatchComplete(run.status) ? <CheckCircle2 size={12} /> : <Clock size={12} className="animate-spin" />}
                          {isRunBatchComplete(run.status) ? "COMPLETE" : "PROCESSING"}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <Layers size={14} className="text-neutral-500" />
                          <span className="text-neutral-300">{run.completed}/{run.total_files}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`font-semibold ${run.total_defects > 0 ? "text-red-400" : "text-green-400"}`}>
                          {run.total_defects}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        {run.needs_review > 0 ? (
                          <span className="inline-flex items-center gap-1 text-amber-400 font-medium">
                            <AlertTriangle size={13} /> {run.needs_review}
                          </span>
                        ) : (
                          <span className="text-neutral-500">0</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-neutral-300 text-xs">{timeAgo(run.created_at)}</td>
                      <td className="px-6 py-4 text-right">
                        <button onClick={e => { e.stopPropagation(); openPreview(run); }}
                          className="inline-flex items-center gap-1 rounded-xl bg-cyan-500/20 text-cyan-300 border border-cyan-500/50 px-3 py-2 text-sm font-semibold hover:bg-cyan-500/30 transition-colors">
                          <Eye size={14} /> View
                        </button>
                      </td>
                    </motion.tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Preview panel (portal: video | frame strip | sidebar, same as Video Upload) */}
      {previewRun && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-[200] flex min-h-0 min-w-0 flex-row items-stretch bg-black/90"
          role="presentation"
          onClick={() => closePreview()}
        >
          <button
            type="button"
            onClick={() => closePreview()}
            className="absolute top-4 right-4 z-10 rounded-full bg-neutral-800/90 text-white p-2 hover:bg-neutral-700 transition-colors"
          >
            <X size={24} />
          </button>

          {completedFiles.length > 1 && !isDjiThermalScanUpload && (
            <>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); navigatePreview(-1); }}
                className="absolute left-4 top-1/2 z-10 -translate-y-1/2 rounded-full bg-neutral-800/90 text-white p-2 hover:bg-neutral-700"
              >
                <ChevronLeft size={24} />
              </button>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); navigatePreview(1); }}
                className="absolute right-[360px] top-1/2 z-10 -translate-y-1/2 rounded-full bg-neutral-800/90 text-white p-2 hover:bg-neutral-700 md:right-[580px]"
              >
                <ChevronRight size={24} />
              </button>
            </>
          )}

          <div className="flex min-h-0 min-w-0 flex-1 flex-row items-stretch pt-14">
            {isDjiThermalScanUpload ? (
              <div
                className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-neutral-800 bg-[#06080c] md:border-r"
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
                    thermalImageB64={thermalB64}
                    thermalImageUrl={thermalUrlResolved || null}
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
                  className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto p-4 md:p-8"
                  onClick={e => e.stopPropagation()}
                >
                  {previewFile ? (
                    <div className="relative w-full max-w-5xl">
                      <div className="absolute top-2 right-2 z-10 rounded-lg border border-neutral-700 bg-neutral-900/90 px-3 py-1.5 text-xs text-neutral-300">
                        {previewFileIdx + 1} / {completedFiles.length}
                      </div>
                      {previewRun.type === "video" && previewFile.video_url ? (
                        <video
                          ref={runsPreviewVideoRef}
                          key={previewFile.video_url}
                          src={previewFile.video_url}
                          controls
                          autoPlay
                          playsInline
                          className="max-h-[min(80vh,calc(100vh-8rem))] w-full rounded-xl bg-black shadow-2xl"
                        />
                      ) : previewFile.annotated_url ? (
                        <div className="relative inline-block max-w-full">
                          <img
                            src={previewFile.annotated_url}
                            alt={previewFile.filename}
                            onLoad={(e) => {
                              setPreviewImageDims({
                                w: e.currentTarget.naturalWidth,
                                h: e.currentTarget.naturalHeight,
                              });
                            }}
                            className="w-full rounded-xl shadow-2xl max-h-[80vh] object-contain bg-black"
                          />
                          {highlightBoundaries &&
                            !isDjiThermalScanUpload &&
                            previewRun.type !== "video" &&
                            Array.isArray(previewFile.detections) &&
                            previewFile.detections.length > 0 && (
                              <DefectBboxOverlays
                                detections={previewFile.detections}
                                imgW={previewImageDims.w}
                                imgH={previewImageDims.h}
                              />
                            )}
                        </div>
                      ) : (
                        <div className="flex aspect-video w-full items-center justify-center rounded-xl bg-neutral-900 text-neutral-500">
                          No preview available
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-lg text-neutral-500">No completed files to preview</div>
                  )}
                </div>

                {previewRun.type === "video" && previewFile?.video_url && (
                  <VideoAnnotatedFrameStrip
                    videoUrl={previewFile.video_url}
                    duration={previewFile.duration || 0}
                    fps={previewFile.fps || 0}
                    framesAnalyzed={previewFile.frames_analyzed || 0}
                    mainVideoRef={runsPreviewVideoRef}
                  />
                )}
              </>
            )}
          </div>

          <div
            className="flex h-full min-h-0 w-[320px] shrink-0 flex-col overflow-hidden border-l border-neutral-800 bg-[#0f1419] pt-14"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="p-4 border-b border-neutral-800">
              <div className="flex items-center gap-2 mb-2">
                <span className={`px-2 py-0.5 rounded text-xs font-bold border ${
                  runDisplayType(previewRun) === "image"
                    ? "bg-blue-500/20 text-blue-300 border-blue-500/50"
                    : runDisplayType(previewRun) === "thermal"
                      ? "bg-orange-500/20 text-orange-300 border-orange-500/50"
                      : "bg-purple-500/20 text-purple-300 border-purple-500/50"
                }`}>{runDisplayType(previewRun).toUpperCase()}</span>
                <span className={`px-2 py-0.5 rounded text-xs font-bold border ${
                  isRunBatchComplete(previewRun.status) ? "bg-green-500/20 text-green-300 border-green-500/50" : "bg-amber-500/20 text-amber-300 border-amber-500/50"
                }`}>{isRunBatchComplete(previewRun.status) ? "COMPLETE" : "PROCESSING"}</span>
              </div>
              <div className="text-sm font-mono text-neutral-400 truncate" title={previewRun.run_id}>ID: {previewRun.run_id}</div>
              <div className="text-xs text-neutral-500 mt-1">{timeAgo(previewRun.created_at)}</div>
            </div>

            {/* Stats */}
            <div className="p-4 border-b border-neutral-800 grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-neutral-400">Total Files</div>
                <div className="text-xl font-bold text-white">{previewRun.total_files}</div>
              </div>
              <div>
                <div className="text-xs text-neutral-400">Completed</div>
                <div className="text-xl font-bold text-white">{previewRun.completed}</div>
              </div>
              <div>
                <div className="text-xs text-neutral-400">Defects Found</div>
                <div className={`text-xl font-bold ${previewRun.total_defects > 0 ? "text-red-400" : "text-green-400"}`}>
                  {previewRun.total_defects}
                </div>
              </div>
            </div>

            {/* Current file details */}
            {previewFile && (
              <div className="p-4 border-b border-neutral-800">
                <div className="text-xs text-neutral-400 mb-2">Current File</div>
                <div className="text-sm text-white truncate font-medium" title={previewFile.filename}>{previewFile.filename}</div>
                {previewRun.type !== "video" && previewFile.stats && (
                  <div className="mt-3 space-y-2 text-xs">
                    <div className="flex justify-between text-neutral-300">
                      <span>Defects</span>
                      <span className="text-white font-semibold">{previewFile.stats.total_defects}</span>
                    </div>
                    <div className="flex justify-between text-neutral-300">
                      <span>Processing Time</span>
                      <span className="text-white font-semibold">{previewFile.stats.processing_time_ms}ms</span>
                    </div>
                  </div>
                )}
                {previewRun.type === "video" && (
                  <div className="mt-3 space-y-2 text-xs">
                    <div className="flex justify-between text-neutral-300">
                      <span>Detections</span>
                      <span className="text-white font-semibold">{previewFile.total_detections || 0}</span>
                    </div>
                    <div className="flex justify-between text-neutral-300">
                      <span>Duration</span>
                      <span className="text-white font-semibold">{formatDuration(previewFile.duration || 0)}</span>
                    </div>
                    <div className="flex justify-between text-neutral-300">
                      <span>FPS</span>
                      <span className="text-white font-semibold">{previewFile.fps || 0}</span>
                    </div>
                    <div className="flex justify-between text-neutral-300">
                      <span>Frames Analyzed</span>
                      <span className="text-white font-semibold">{previewFile.frames_analyzed || 0}</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Detections for image runs: above file list */}
            {previewRun.type !== "video" && (() => {
              if (!previewFile) return null;
              const rows = previewFile.detections || [];
              const rowKeyBase = previewFile.file_id || previewFile.filename;
              if (!rows.length) return null;
              return (
                <div className="max-h-[min(28vh,220px)] shrink-0 overflow-y-auto border-b border-neutral-800 p-4">
                  <div className="text-xs text-neutral-400 mb-2">
                    Detections ({rows.length})
                  </div>
                  <div className="space-y-1">
                    {rows.map((d: any, i: number) => {
                      return (
                        <div
                          key={`${rowKeyBase}-${i}`}
                          className="flex items-center justify-between py-1 text-xs"
                        >
                          <span className="max-w-[140px] truncate text-white">
                            {d.class_name}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* File list */}
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="text-xs text-neutral-400 mb-3">All Files ({previewRun.files.length})</div>
              <div className="space-y-1.5">
                {previewRun.files.map((f, idx) => {
                  const cIdx = completedFiles.indexOf(f);
                  const isActive = cIdx === previewFileIdx;
                  return (
                    <button key={f.file_id || `${f.filename}-${idx}`}
                      onClick={() => { if (cIdx >= 0) setPreviewFileIdx(cIdx); }}
                      className={`w-full flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors ${
                        isActive ? "bg-cyan-500/20 border border-cyan-500/50" : "hover:bg-neutral-800 border border-transparent"
                      } ${f.status !== "done" ? "opacity-50 cursor-default" : "cursor-pointer"}`}
                    >
                      {f.thumb_url ? (
                        <img src={f.thumb_url} className="w-8 h-8 rounded object-cover flex-shrink-0" alt="" />
                      ) : (
                        <div className="w-8 h-8 rounded bg-neutral-800 flex items-center justify-center flex-shrink-0">
                          {runDisplayType(previewRun) === "video" ? <Video size={12} className="text-neutral-500" /> : runDisplayType(previewRun) === "thermal" ? <Thermometer size={12} className="text-neutral-500" /> : <Image size={12} className="text-neutral-500" />}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] text-white truncate">{f.filename}</div>
                        <div className="text-[10px] text-neutral-500">
                          {f.status === "done" ? (
                            <span className="text-green-400">{previewRun.type === "video" ? `${f.total_detections || 0} detections` : `${f.stats?.total_defects || 0} defects`}</span>
                          ) : f.status === "processing" ? (
                            <span className="text-amber-400">Processing...</span>
                          ) : f.status === "error" ? (
                            <span className="text-red-400">Error</span>
                          ) : (
                            <span>Queued</span>
                          )}
                        </div>
                      </div>
                      {f.status === "done" && <CheckCircle2 size={12} className="text-green-400 flex-shrink-0" />}
                      {f.status === "processing" && <Clock size={12} className="text-amber-400 animate-spin flex-shrink-0" />}
                      {f.status === "error" && <XCircle size={12} className="text-red-400 flex-shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Video detections: below All Files */}
            {previewRun.type === "video" &&
              previewFile &&
              (previewFile.total_detections || 0) > 0 &&
              videoDetectionsLoading && (
                <div className="shrink-0 border-b border-neutral-800 p-4 text-xs text-neutral-500">Loading defect list…</div>
              )}
            {previewRun.type === "video" && (() => {
              if (!previewFile) return null;
              const rows =
                Array.isArray(previewFile.detections) && previewFile.detections.length > 0
                  ? previewFile.detections
                  : videoFetchedDetections;
              const rowKeyBase = videoResultsFolderId(previewFile) || previewFile.file_id || previewFile.filename;
              if (!rows.length) return null;
              return (
                <div className="max-h-[min(28vh,220px)] shrink-0 overflow-y-auto border-b border-neutral-800 p-4">
                  <div className="text-xs text-neutral-400 mb-2">
                    Detections ({rows.length})
                  </div>
                  <div className="space-y-1">
                    {rows.map((d: any, i: number) => {
                      return (
                        <div
                          key={`${rowKeyBase}-${i}`}
                          className="flex items-center justify-between py-1 text-xs"
                        >
                          <span className="max-w-[140px] truncate text-white">
                            {d.class_name}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      , document.body)
      }
    </motion.div>
  );
}
