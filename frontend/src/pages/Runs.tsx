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

function safeIdFromLabel(label: string) {
  const base = (label || "COMPONENT")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 18);
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${base}-${rand}`;
}

function defectBlurb(labelRaw: string) {
  const label = (labelRaw || "").toLowerCase();
  const canned: Array<{ match: RegExp; text: string }> = [
    {
      match: /insulator|disc|string/,
      text: "Localized surface tracking and material degradation are consistent with contamination-driven stress. Recommend close inspection for cracks, glazing damage, and evidence of partial discharge.",
    },
    {
      match: /corona|arcing|flashover/,
      text: "Pattern suggests discharge activity and possible flashover residue. Recommend verifying clearances, checking for sharp edges/loose hardware, and scheduling cleaning and immediate corrective action if activity persists.",
    },
    {
      match: /bolt|nut|hardware|clamp/,
      text: "Anomaly indicates potential loosening, deformation, or corrosion. Recommend torque verification, corrosion treatment, and replacement if mechanical integrity is compromised.",
    },
    {
      match: /rust|corrosion/,
      text: "Corrosion signatures may indicate coating failure and moisture ingress. Recommend surface preparation and protective treatment; replace components showing advanced section loss.",
    },
    {
      match: /crack|fracture|broken|chip/,
      text: "Visible discontinuity suggests structural damage. Recommend urgent replacement or reinforcement to reduce risk of mechanical failure under load and weather events.",
    },
  ];
  const hit = canned.find((c) => c.match.test(label));
  return (
    hit?.text ??
    "Defect signature deviates from baseline geometry and texture. Recommend field verification and corrective maintenance based on severity, location, and asset criticality."
  );
}

async function loadImage(url: string) {
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = document.createElement("img");
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image_load_failed"));
    img.src = url;
  });
}

async function fetchAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("read_failed"));
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function cropDataUrl(img: HTMLImageElement, bbox: number[]) {
  const [x1, y1, x2, y2] = bbox;
  const ix1 = Math.max(0, Math.min(img.naturalWidth - 1, Math.floor(Math.min(x1, x2))));
  const iy1 = Math.max(0, Math.min(img.naturalHeight - 1, Math.floor(Math.min(y1, y2))));
  const ix2 = Math.max(ix1 + 1, Math.min(img.naturalWidth, Math.ceil(Math.max(x1, x2))));
  const iy2 = Math.max(iy1 + 1, Math.min(img.naturalHeight, Math.ceil(Math.max(y1, y2))));
  const w = Math.max(1, ix2 - ix1);
  const h = Math.max(1, iy2 - iy1);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, ix1, iy1, w, h, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.92);
}

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
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(() => new Set());
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

  const generateSelectedReport = useCallback(async () => {
    const selected = runs.filter((r) => selectedRunIds.has(r.run_id));
    if (selected.length === 0) return;

    const brandLogoUrl = `${window.location.origin}/azerenerji-logo.png`;
    const brandLogoSrc = (await fetchAsDataUrl(brandLogoUrl)) || brandLogoUrl;
    const today = new Date();
    const inspectionDate = today.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "2-digit" });

    const perRunSections: string[] = [];

    for (const run of selected) {
      const dtype = runDisplayType(run);
      const createdIso =
        typeof run.created_at === "string"
          ? run.created_at
          : new Date((runCreatedTs(run) ?? Date.now())).toISOString();

      const defectCards: string[] = [];

      if (dtype === "video") {
        defectCards.push(
          `<div class="bg-yellow-50 border-l-4 border-yellow-500 p-4">
             <h3 class="font-bold text-yellow-800 mb-1">Note</h3>
             <p class="text-sm text-yellow-900">This batch contains video items. Cropped defect comparisons are generated for image-based detections only.</p>
           </div>`
        );
      }

      const approvedMap = fileReviewStatusByRun[run.run_id] || {};
      const approvedComments = fileCommentByRun[run.run_id] || {};
      const imageFiles = run.files.filter((f) => {
        const fileKey = (f.file_id || f.filename || "").trim();
        if (!fileKey) return false;
        if (approvedMap[fileKey] !== "approved") return false;
        return Boolean(f.annotated_url || f.thumb_url);
      });
      for (const f of imageFiles) {
        const dets = Array.isArray(f.detections) ? f.detections : [];
        const boxes = dets
          .map((d: any) => ({
            label: String(d?.class_name ?? d?.label ?? "Defect"),
            conf: typeof d?.confidence === "number" ? d.confidence : typeof d?.conf === "number" ? d.conf : null,
            bbox: Array.isArray(d?.bbox) ? d.bbox : null,
          }))
          .filter((d) => Array.isArray(d.bbox) && d.bbox.length >= 4);

        if (boxes.length === 0) continue;

        const healthyUrl = (f.thumb_url || f.annotated_url || "").trim();
        const defectUrl = (f.annotated_url || f.thumb_url || "").trim();
        if (!healthyUrl || !defectUrl) continue;

        let healthyImg: HTMLImageElement | null = null;
        let defectImg: HTMLImageElement | null = null;
        try {
          [healthyImg, defectImg] = await Promise.all([loadImage(healthyUrl), loadImage(defectUrl)]);
        } catch {
          continue;
        }

        const fileKey = (f.file_id || f.filename || "").trim();
        const humanComment = fileKey ? (approvedComments[fileKey] || "").trim() : "";

        for (const b of boxes) {
          const bbox = b.bbox as number[];
          const healthyCrop = healthyImg ? cropDataUrl(healthyImg, bbox) : null;
          const defectCrop = defectImg ? cropDataUrl(defectImg, bbox) : null;
          if (!healthyCrop || !defectCrop) continue;

          const label = b.label || "Defect";
          const componentId = safeIdFromLabel(label);

          defectCards.push(
            `
            <section class="mb-10">
              <h2 class="text-lg font-bold text-blue-900 uppercase mb-4 border-b-2 border-gray-100 pb-2">Visual Assessment (Side-by-Side)</h2>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div class="flex flex-col">
                  <div class="bg-gray-100 p-2 rounded-t-lg border border-gray-300 border-b-0">
                    <h3 class="font-bold text-green-700 text-center uppercase tracking-wide text-sm">Reference: Healthy State</h3>
                  </div>
                  <div class="border border-gray-300 bg-white relative h-64 md:h-80 overflow-hidden flex items-center justify-center">
                    <img src="${healthyCrop}" alt="Healthy crop" class="object-contain w-full h-full bg-white">
                    <span class="absolute bottom-3 left-3 bg-black bg-opacity-70 text-white text-xs px-2 py-1 rounded">Original crop</span>
                  </div>
                  <div class="border border-gray-300 border-t-0 p-4 rounded-b-lg bg-gray-50">
                    <p class="text-sm text-gray-700">Baseline visual condition for this localized region (no annotation overlay). Used for comparison.</p>
                  </div>
                </div>
                <div class="flex flex-col">
                  <div class="bg-red-50 p-2 rounded-t-lg border border-red-300 border-b-0">
                    <h3 class="font-bold text-red-700 text-center uppercase tracking-wide text-sm">Current: Defective State</h3>
                  </div>
                  <div class="border border-red-300 bg-white relative h-64 md:h-80 overflow-hidden flex items-center justify-center">
                    <img src="${defectCrop}" alt="Defect crop" class="object-contain w-full h-full bg-white">
                    <span class="absolute bottom-3 left-3 bg-red-700 bg-opacity-90 text-white text-xs px-2 py-1 rounded">Annotated crop</span>
                  </div>
                  <div class="border border-red-300 border-t-0 p-4 rounded-b-lg bg-red-50">
                    <p class="text-sm text-gray-800 font-medium">Defect detected: <span class="text-red-600">${label}</span></p>
                  </div>
                </div>
              </div>
              <section class="mt-8">
                <h2 class="text-lg font-bold text-blue-900 uppercase mb-4 border-b-2 border-gray-100 pb-2">Defect Description & Maintenance Plan</h2>
                <div class="space-y-4">
                  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 bg-gray-50 p-6 rounded-lg border border-gray-200">
                    <div>
                      <span class="block text-xs font-bold text-gray-500 uppercase">Component Name</span>
                      <span class="block text-base font-semibold text-gray-900 mt-1">${label}</span>
                    </div>
                    <div>
                      <span class="block text-xs font-bold text-gray-500 uppercase">Component ID</span>
                      <span class="block text-base font-semibold text-gray-900 mt-1">${componentId}</span>
                    </div>
                    <div>
                      <span class="block text-xs font-bold text-gray-500 uppercase">Batch / Run ID</span>
                      <span class="block text-base font-semibold text-gray-900 mt-1">${run.run_id}</span>
                    </div>
                    <div>
                      <span class="block text-xs font-bold text-gray-500 uppercase">Inspection Date</span>
                      <span class="block text-base font-semibold text-gray-900 mt-1">${inspectionDate}</span>
                    </div>
                  </div>
                  <div>
                    <h3 class="font-semibold text-gray-800 text-md mb-2">Detailed Findings:</h3>
                    <p class="text-gray-600 leading-relaxed text-sm text-justify">
                      ${defectBlurb(label)}
                    </p>
                    <p class="text-xs text-gray-400 mt-2">Source file: ${String(f.filename || "—")}</p>
                  </div>
                  ${humanComment
                    ? `<div class="bg-blue-50 border-l-4 border-blue-600 p-4">
                         <h3 class="font-bold text-blue-900 mb-1">Human suggestion</h3>
                         <p class="text-sm text-blue-950">${humanComment.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>
                       </div>`
                    : ""}
                  <div class="bg-yellow-50 border-l-4 border-yellow-500 p-4">
                    <h3 class="font-bold text-yellow-800 mb-1">Recommended Action: Priority Review</h3>
                    <p class="text-sm text-yellow-900">
                      Schedule field verification for the affected component area and apply corrective maintenance based on severity and asset criticality.
                    </p>
                  </div>
                </div>
              </section>
            </section>
            `
          );
        }
      }

      if (defectCards.length === 0) {
        defectCards.push(
          `<div class="bg-gray-50 border border-gray-200 p-6 rounded-lg">
             <p class="text-sm text-gray-700">No approved needed.</p>
           </div>`
        );
      }

      perRunSections.push(
        `
        <div class="max-w-5xl mx-auto bg-white p-8 md:p-12 shadow-xl border border-gray-200 mb-10">
          <header class="flex flex-col md:flex-row justify-between items-start md:items-center border-b-4 border-blue-900 pb-6 mb-8">
            <div>
              <h1 class="text-3xl font-extrabold text-gray-900 uppercase tracking-wide">Component Defect Report</h1>
              <p class="text-gray-500 mt-1 font-medium">Transmission Line Asset Management</p>
              <p class="text-xs text-gray-400 mt-2">Batch: <span class="font-mono">${run.run_id}</span> • Type: ${dtype.toUpperCase()} • Created: ${createdIso}</p>
            </div>
            <div class="mt-4 md:mt-0 text-right">
              <img src="${brandLogoSrc}" alt="AzərEnerji" class="h-12 md:h-14 w-auto object-contain ml-auto" />
            </div>
          </header>
          ${defectCards.join("\n")}
          <footer class="mt-12 pt-8 border-t-2 border-gray-300 flex flex-col md:flex-row justify-between items-end gap-8">
            <div class="w-full md:w-auto">
              <p class="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-1">Official Report Generated By</p>
              <div class="flex items-center gap-3">
                <img src="${brandLogoSrc}" alt="AzərEnerji" class="h-9 w-auto object-contain" />
              </div>
            </div>
            <div class="flex flex-col md:flex-row gap-8 w-full md:w-auto">
              <div class="w-full md:w-48">
                <div class="border-b border-gray-800 h-10 mb-2"></div>
                <p class="text-center text-xs font-semibold text-gray-600 uppercase">Inspecting Engineer</p>
              </div>
              <div class="w-full md:w-48">
                <div class="border-b border-gray-800 h-10 mb-2"></div>
                <p class="text-center text-xs font-semibold text-gray-600 uppercase">Sector Supervisor Approval</p>
              </div>
            </div>
          </footer>
        </div>
        `
      );
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Component Defect Report - Azerenerji</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    @media print {
      body { background-color: white; }
      .print-shadow-none { box-shadow: none !important; }
      .print-m-0 { margin: 0 !important; }
      .print-p-0 { padding: 0 !important; }
      a { text-decoration: none; color: inherit; }
    }
  </style>
</head>
<body class="bg-gray-100 text-gray-800 font-sans p-4 md:p-8">
  ${perRunSections.join("\n")}
</body>
</html>`;

    const w = window.open("", "_blank");
    if (!w) {
      toast.error("Popup blocked. Allow popups to generate the report.", 4000);
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }, [runs, selectedRunIds, runCreatedTs, fileReviewStatusByRun, fileCommentByRun]);

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

  useEffect(() => {
    setPreviewImageDims({ w: 0, h: 0 });
  }, [previewRun?.run_id, previewFileIdx, thermalOriginalUrlResolved, isDjiThermalScanUpload]);

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
        <div className="flex items-center gap-2">
          <button
            onClick={() => generateSelectedReport()}
            disabled={selectedCount === 0}
            className={`flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition-colors ${
              selectedCount === 0
                ? "bg-neutral-800/60 border-neutral-700 text-neutral-500 cursor-not-allowed"
                : "bg-cyan-500/20 border-cyan-500/50 text-cyan-200 hover:bg-cyan-500/30"
            }`}
            title={selectedCount === 0 ? "Select one or more batches to generate a report" : `Generate report for ${selectedCount} batch(es)`}
          >
            Generate report {selectedCount > 0 ? `(${selectedCount})` : ""}
          </button>
          <button
            onClick={() => {
              setLoading(true);
              fetchRuns();
            }}
            className="flex items-center gap-2 rounded-xl bg-neutral-800 border border-neutral-700 text-neutral-300 hover:text-white px-4 py-2 text-sm font-semibold hover:bg-neutral-700 transition-colors"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
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
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="rounded-xl bg-neutral-800 border border-neutral-700 text-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-cyan-500/50"
                aria-label="From date"
              />
              <span className="text-neutral-500 text-xs">to</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="rounded-xl bg-neutral-800 border border-neutral-700 text-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-cyan-500/50"
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
                  const isSelected = selectedRunIds.has(run.run_id);
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
                  thermalImageB64={undefined}
                  thermalImageUrl={thermalOriginalUrlResolved || null}
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
                  const fileKey = (f.file_id || f.filename || `${idx}`).trim();
                  const reviewStatus = (fileReviewStatusByRun[previewRun.run_id] || {})[fileKey];
                  const comment = (fileCommentByRun[previewRun.run_id] || {})[fileKey] || "";
                  const editorKey = `${previewRun.run_id}::${fileKey}`;
                  const editorOpen = activeCommentEditorKey === editorKey;
                  return (
                    <div key={f.file_id || `${f.filename}-${idx}`} className="w-full">
                      <button
                        onClick={() => {
                          if (cIdx >= 0) setPreviewFileIdx(cIdx);
                        }}
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
                      {f.status === "done" && (
                        <div className="flex items-center gap-1 min-w-[190px] justify-end">
                          {reviewStatus === "approved" ? (
                            <span className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                              Approved
                            </span>
                          ) : reviewStatus === "canceled" ? (
                            <span className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-300">
                              Canceled
                            </span>
                          ) : null}
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
                            className="rounded-md border border-neutral-700 bg-neutral-800/60 px-2 py-1 text-neutral-300 hover:text-white hover:bg-neutral-700/60 transition-colors"
                            title="Comment"
                            aria-label="Comment"
                          >
                            <MessageSquare size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setFileReviewStatus(previewRun.run_id, fileKey, "approved");
                            }}
                            className={`rounded-md border px-2 py-1 transition-colors ${
                              reviewStatus === "approved"
                                ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-200"
                                : "border-neutral-700 bg-neutral-800/60 text-neutral-300 hover:text-white hover:bg-neutral-700/60"
                            }`}
                            title="Approve"
                            aria-label="Approve"
                          >
                            <CheckCircle2 size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setFileReviewStatus(previewRun.run_id, fileKey, "canceled");
                            }}
                            className={`rounded-md border px-2 py-1 transition-colors ${
                              reviewStatus === "canceled"
                                ? "border-red-500/60 bg-red-500/15 text-red-200"
                                : "border-neutral-700 bg-neutral-800/60 text-neutral-300 hover:text-white hover:bg-neutral-700/60"
                            }`}
                            title="Cancel"
                            aria-label="Cancel"
                          >
                            <XCircle size={14} />
                          </button>
                        </div>
                      )}
                      {f.status === "done" && <CheckCircle2 size={12} className="text-green-400 flex-shrink-0" />}
                      {f.status === "processing" && <Clock size={12} className="text-amber-400 animate-spin flex-shrink-0" />}
                      {f.status === "error" && <XCircle size={12} className="text-red-400 flex-shrink-0" />}
                      </button>
                      {f.status === "done" && (comment.trim() || editorOpen) ? (
                        <div className="px-3 pb-3 -mt-1">
                          <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-3">
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-[11px] font-semibold text-neutral-300">Comment</div>
                              {editorOpen ? (
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setFileComment(previewRun.run_id, fileKey, commentDraft);
                                      setActiveCommentEditorKey(null);
                                    }}
                                    className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/15 transition-colors"
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
                                    className="rounded-md border border-neutral-700 bg-neutral-800/60 px-2 py-1 text-[11px] font-semibold text-neutral-300 hover:text-white hover:bg-neutral-700/60 transition-colors"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : null}
                            </div>
                            {editorOpen ? (
                              <textarea
                                value={commentDraft}
                                onChange={(e) => setCommentDraft(e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                rows={2}
                                placeholder="Add a note for this image (will appear in the report as Human suggestion)"
                                className="mt-2 w-full resize-none rounded-lg bg-neutral-800 border border-neutral-700 text-white placeholder-neutral-500 px-3 py-2 text-[12px] outline-none focus:ring-2 focus:ring-cyan-500/40"
                              />
                            ) : (
                              <div className="mt-2 text-[12px] text-neutral-300">{comment}</div>
                            )}
                          </div>
                        </div>
                      ) : null}
                    </div>
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
