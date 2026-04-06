import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";
import { toast } from "../components/Toast";
import { VideoAnnotatedFrameStrip } from "../components/VideoAnnotatedFrameStrip";
import { DetectionSidebarBucketPanels } from "../components/DetectionSidebarBucketPanels";
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
  image_width?: number | null;
  image_height?: number | null;
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

/** Demo-only labels for Assign dropdown (no backend). */
const ASSIGN_DEMO_USERS = ["A. Mammadov", "L. Hasanova", "R. Aliyev"];

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
  const pad = 20;
  const ix1 = Math.max(0, Math.floor(Math.min(x1, x2)) - pad);
  const iy1 = Math.max(0, Math.floor(Math.min(y1, y2)) - pad);
  const ix2 = Math.min(img.naturalWidth, Math.ceil(Math.max(x1, x2)) + pad);
  const iy2 = Math.min(img.naturalHeight, Math.ceil(Math.max(y1, y2)) + pad);
  const w = Math.max(1, ix2 - ix1);
  const h = Math.max(1, iy2 - iy1);

  const minDim = 600;
  const scale = Math.max(1, Math.ceil(minDim / Math.max(w, h)));
  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, ix1, iy1, w, h, 0, 0, w * scale, h * scale);
  return canvas.toDataURL("image/png");
}

/** Full-frame image scaled for PDF (e.g. original / thumb without crop). */
function fullImageContainedDataUrl(img: HTMLImageElement, maxLongEdge: number) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (w <= 0 || h <= 0) return null;
  const longEdge = Math.max(w, h);
  const scale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h, 0, 0, cw, ch);
  return canvas.toDataURL("image/png");
}

function escapeReportHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pdfBatchMetaLine(batchTotal: number, approvedCount: number, processingMs: number): string {
  const proc =
    processingMs > 0
      ? processingMs >= 1000
        ? `${(processingMs / 1000).toFixed(1)} s`
        : `${Math.round(processingMs)} ms`
      : "—";
  return `Images in batch: <span class="font-Poppins text-black">${batchTotal}</span>. Approved for report: <span class="font-Poppins text-black">${approvedCount}</span>.<br/><span class="block mt-1">Batch processing time: <span class="font-Poppins text-black">${proc}</span></span>`;
}

function reportThermalUnitLabel(u: string): string {
  if (u === "Fahrenheit") return "°F";
  if (u === "Kelvin") return "K";
  return "°C";
}

function reportStatRow(label: string, value: string): string {
  return `<div class="flex justify-between gap-2 py-0.5 border-b border-gray-100 text-xs"><span class="text-gray-500 font-semibold">${escapeReportHtml(label)}</span><span class="text-gray-900 font-medium text-right">${escapeReportHtml(value)}</span></div>`;
}

function buildThermalTemperatureStatsHtml(stats: ThermalStats | null | undefined, unit: string): string {
  const u = reportThermalUnitLabel(unit);
  const fmt = (n: number | null | undefined, digits = 2) =>
    n != null && Number.isFinite(n) ? n.toFixed(digits) : "—";
  if (!stats) return `<div class="text-xs text-gray-500">No temperature statistics.</div>`;
  const range =
    stats.max_c != null && stats.min_c != null && Number.isFinite(stats.max_c) && Number.isFinite(stats.min_c)
      ? (stats.max_c - stats.min_c).toFixed(2)
      : "—";
  const res = stats.width && stats.height ? `${stats.width} × ${stats.height}` : "—";
  return [
    reportStatRow("Minimum", `${fmt(stats.min_c)} ${u}`),
    reportStatRow("Maximum", `${fmt(stats.max_c)} ${u}`),
    reportStatRow("Mean", `${fmt(stats.mean_c)} ${u}`),
    reportStatRow("Median", `${fmt(stats.median_c)} ${u}`),
    reportStatRow("Std Dev", `${fmt(stats.std_c)} ${u}`),
    reportStatRow("Resolution", res),
    reportStatRow("Temp Range", `${range} ${u}`),
  ].join("");
}

function buildThermalCameraLocationHtml(analysis: ThermalAnalysisData | null | undefined): string {
  const m = analysis?.metadata_extracted;
  if (!m) return `<div class="text-xs text-gray-500">—</div>`;
  const lat = m.gps_coordinates?.latitude;
  const lon = m.gps_coordinates?.longitude;
  return [
    reportStatRow("Camera", m.camera_model != null ? String(m.camera_model) : "N/A"),
    reportStatRow("Serial", m.serial_number != null ? String(m.serial_number) : "N/A"),
    reportStatRow("Focal Length", m.focal_length_mm != null ? `${m.focal_length_mm} mm` : "N/A"),
    reportStatRow("F-Number", m.f_number != null ? `f/${m.f_number}` : "N/A"),
    reportStatRow("Timestamp", m.timestamp != null ? String(m.timestamp) : "N/A"),
    reportStatRow("Tilt", m.camera_tilt_deg != null ? `${m.camera_tilt_deg.toFixed(1)}°` : "N/A"),
    reportStatRow("Latitude", lat != null ? lat.toFixed(6) : "N/A"),
    reportStatRow("Longitude", lon != null ? lon.toFixed(6) : "N/A"),
    reportStatRow("Altitude", m.altitude_m != null ? `${m.altitude_m.toFixed(1)} m` : "N/A"),
    reportStatRow(
      "Resolution",
      m.image_width != null && m.image_height != null ? `${m.image_width}×${m.image_height}` : "N/A"
    ),
  ].join("");
}

function buildThermalDistanceEnvHtml(analysis: ThermalAnalysisData | null | undefined): string {
  if (!analysis) return `<div class="text-xs text-gray-500">—</div>`;
  const dist = analysis.distance_meters?.value;
  const amb = analysis.environment?.ambient_temperature_c?.value;
  const hum = analysis.environment?.humidity_percent?.value;
  return [
    reportStatRow("Distance", dist != null ? `${dist.toFixed(1)} m` : "N/A"),
    reportStatRow("Ambient Temp", amb != null ? `${amb}°C` : "N/A"),
    reportStatRow("Humidity", hum != null ? `${hum}%` : "N/A"),
  ].join("");
}

function buildThermalParametersHtml(analysis: ThermalAnalysisData | null | undefined): string {
  const tp = analysis?.thermal_parameters;
  if (!tp) return `<div class="text-xs text-gray-500">—</div>`;
  const emi = tp.emissivity?.value;
  const ref = tp.reflected_temperature_c?.value;
  return [
    reportStatRow("Emissivity", emi != null ? emi.toFixed(3) : "N/A"),
    reportStatRow("Reflected Temp", ref != null ? `${ref.toFixed(1)}°C` : "N/A"),
  ].join("");
}

async function buildThermalDefectReportHtml(opts: {
  f: FileInfo;
  row: Record<string, unknown>;
  run: RunEntry;
  inspectionDate: string;
  humanComment: string;
}): Promise<string> {
  const { f, row, run, inspectionDate, humanComment } = opts;
  const unit = String(row.unit ?? "Celsius");
  const stats = row.stats as ThermalStats | undefined;
  const analysis = row.analysis as ThermalAnalysisData | undefined;

  const vizRaw = String(row.thermal_visualization_url || row.thermal_image_url || "").trim();
  const b64 = row.thermal_image_base64_png as string | undefined;

  let vizData: string | null = null;
  if (b64 && b64.length > 0) vizData = `data:image/png;base64,${b64}`;
  else if (vizRaw) vizData = await fetchAsDataUrl(resolveThermalFetchUrl(vizRaw));

  const thermalImgInner = vizData
    ? `<img src="${vizData}" alt="Thermal map" class="object-contain w-full h-full bg-white">`
    : `<span class="text-xs text-gray-500">No thermal image</span>`;

  const statsInner = buildThermalTemperatureStatsHtml(stats, unit);
  const camInner = buildThermalCameraLocationHtml(analysis);
  const distInner = buildThermalDistanceEnvHtml(analysis);
  const tpInner = buildThermalParametersHtml(analysis);

  const label = "Thermal inspection";
  const componentId = safeIdFromLabel("thermal");

  const commentBlock = humanComment
    ? `<div class="bg-blue-50 border-l-4 border-blue-600 p-1.5">
         <h3 class="font-bold text-blue-900 mb-0.5 text-xs">Human suggestion</h3>
         <p class="text-xs text-blue-950 leading-tight">${escapeReportHtml(humanComment)}</p>
       </div>`
    : "";

  return `<section class="defect-block thermal-report-pdf mb-2">
              <h2 class="text-sm font-bold text-blue-900 uppercase mb-1 border-b-2 border-gray-100 pb-0.5">Visual Assessment (Thermal Map)</h2>
              <div class="grid grid-cols-2 gap-3 items-start thermal-visual-row">
                <div class="flex flex-col min-h-0">
                  <div class="bg-red-50 py-1 px-1.5 rounded-t-lg border border-red-300 border-b-0">
                    <h3 class="font-bold text-red-700 text-center uppercase tracking-wide text-xs">Thermal visualization</h3>
                  </div>
                  <div class="border border-red-300 bg-white relative h-40 overflow-hidden flex items-center justify-center shrink-0">
                    ${thermalImgInner}
                  </div>
                  <div class="border border-red-300 border-t-0 py-1 px-1.5 rounded-b-lg bg-red-50 shrink-0">
                    <p class="text-xs text-gray-800 font-medium leading-tight">Radiometric temperature map for this capture.</p>
                  </div>
                </div>
                <div class="flex flex-col min-h-0">
                  <div class="bg-gray-100 py-1 px-1.5 rounded-t-lg border border-gray-300 border-b-0">
                    <h3 class="font-bold text-green-700 text-center uppercase tracking-wide text-xs">Temperature Stats</h3>
                  </div>
                  <div class="border border-gray-300 border-t-0 bg-white py-1 px-1.5 shrink-0">
                    ${statsInner}
                  </div>
                  <div class="border border-gray-300 border-t-0 py-1 px-1.5 rounded-b-lg bg-gray-50 shrink-0">
                    <p class="text-xs text-gray-700 leading-tight">Full-frame statistics from thermal analysis.</p>
                  </div>
                </div>
              </div>
              <div class="mt-2 clear-both">
                <h2 class="text-sm font-bold text-blue-900 uppercase mb-1 border-b-2 border-gray-100 pb-0.5">Defect Description &amp; Maintenance Plan</h2>
                <div class="space-y-1.5">
                  <div class="grid grid-cols-4 gap-2 bg-gray-50 p-2 rounded-lg border border-gray-200">
                    <div>
                      <span class="block text-[10px] font-bold text-gray-500 uppercase">Component Name</span>
                      <span class="block text-xs font-semibold text-gray-900 mt-0.5">${escapeReportHtml(label)}</span>
                    </div>
                    <div>
                      <span class="block text-[10px] font-bold text-gray-500 uppercase">Component ID</span>
                      <span class="block text-xs font-semibold text-gray-900 mt-0.5">${escapeReportHtml(componentId)}</span>
                    </div>
                    <div>
                      <span class="block text-[10px] font-bold text-gray-500 uppercase">Batch / Run ID</span>
                      <span class="block text-xs font-semibold text-gray-900 mt-0.5">${escapeReportHtml(run.run_id)}</span>
                    </div>
                    <div>
                      <span class="block text-[10px] font-bold text-gray-500 uppercase">Inspection Date</span>
                      <span class="block text-xs font-semibold text-gray-900 mt-0.5">${escapeReportHtml(inspectionDate)}</span>
                    </div>
                  </div>
                  <div>
                    <h3 class="font-semibold text-gray-800 text-[11px] mb-0.5">Detailed Findings:</h3>
                    <p class="text-gray-600 leading-tight text-[11px] text-justify">
                      ${defectBlurb("thermal_inspection")}
                    </p>
                    <p class="text-[10px] text-gray-400 mt-0.5">Source file: ${escapeReportHtml(String(f.filename || "—"))}</p>
                  </div>
                  <div class="grid grid-cols-2 gap-2 items-start thermal-meta-row">
                    <div class="border border-gray-200 rounded-lg py-1.5 px-1.5 bg-white self-start w-full">
                      <h3 class="font-semibold text-gray-800 text-xs mb-0.5 border-b border-gray-100 pb-0.5">Camera &amp; Location</h3>
                      ${camInner}
                    </div>
                    <div class="border border-gray-200 rounded-lg py-1.5 px-1.5 bg-white self-start w-full">
                      <h3 class="font-semibold text-gray-800 text-xs mb-0.5 border-b border-gray-100 pb-0.5">Distance &amp; Environment</h3>
                      ${distInner}
                    </div>
                  </div>
                  <div class="border border-gray-200 rounded-lg py-1.5 px-1.5 bg-white">
                    <h3 class="font-semibold text-gray-800 text-xs mb-0.5 border-b border-gray-100 pb-0.5">Thermal Parameters</h3>
                    ${tpInner}
                  </div>
                  ${commentBlock}
                </div>
              </div>
            </section>`;
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

function runUniqueFindingsCount(run: RunEntry): number {
  return run.files.reduce((s, f) => s + uniqueDefectTypeCount(f.detections), 0);
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
  const runsPreviewVideoRef = useRef<HTMLVideoElement>(null);
  const runsPreviewImgRef = useRef<HTMLImageElement>(null);
  const runsPreviewCanvasRef = useRef<HTMLCanvasElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const batchFromQuery = searchParams.get("batch");
  const highlightBoundaries = searchParams.get("highlight") === "1";
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());
  const appliedBatchRef = useRef<string | null>(null);
  const [previewModalZoom, setPreviewModalZoom] = useState(1);
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

  const generateSelectedReport = useCallback(async () => {
    const selected = runs.filter((r) => selectedRunIds.has(r.run_id));
    if (selected.length === 0) return;

    const brandLogoUrl = `${window.location.origin}${encodeURI("/logo-1.png")}`;
    const brandLogoSrc = (await fetchAsDataUrl(brandLogoUrl)) || brandLogoUrl;
    const today = new Date();
    const inspectionDate = today.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "2-digit" });

    const dateStr = new Date().toISOString().slice(0, 10);
    const pdfJobs = selected.map((r) => ({
      runs: [r] as typeof selected,
      filename: `defect_report_${r.run_id.slice(0, 8)}_${dateStr}.pdf`,
    }));

    let pdfExportSuccessCount = 0;

    for (const { runs: runsForPdf, filename: pdfFilename } of pdfJobs) {
      const perRunSections: string[] = [];
      const pdfPageChunks: string[] = [];

      for (const run of runsForPdf) {
        const dtype = runDisplayType(run);
      const createdIso =
        typeof run.created_at === "string"
          ? run.created_at
          : new Date((runCreatedTs(run) ?? Date.now())).toISOString();
      const assigneeRaw = (batchAssigneeByRun[run.run_id] || "").trim();
      const assigneeEscaped = assigneeRaw
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

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
      /** DJI R-JPEG batch only — same `run_id` as `/api/thermal/batch/results/:id`. Image jobs tagged “thermal” use `run_id` from detection and must use the RGB defect loop below. */
      const isThermalReportRun = Boolean(run.thermal_analysis_job);

      let thermalRows: Record<string, unknown>[] = [];
      let thermalJobUnit = "Celsius";
      if (isThermalReportRun) {
        try {
          const rel = `/api/thermal/batch/results/${encodeURIComponent(run.run_id)}`;
          const rurl = API_BASE ? `${API_BASE}${rel}` : rel;
          const tres = await fetch(rurl);
          if (tres.ok) {
            const body = (await tres.json()) as { results?: unknown[]; unit?: string };
            thermalRows = Array.isArray(body.results) ? (body.results as Record<string, unknown>[]) : [];
            if (typeof body.unit === "string" && body.unit) thermalJobUnit = body.unit;
          }
        } catch {
          /* ignore */
        }
      }

      const imageFiles = run.files.filter((f) => {
        const fileKey = (f.file_id || f.filename || "").trim();
        if (!fileKey) return false;
        if (approvedMap[fileKey] !== "approved") return false;
        return Boolean(f.annotated_url || f.thumb_url);
      });
      if (!isThermalReportRun) for (const f of imageFiles) {
        const dets = Array.isArray(f.detections) ? f.detections : [];
        const boxes = dets
          .map((d: any) => ({
            label: String(d?.class_name ?? d?.label ?? "Defect"),
            conf: typeof d?.confidence === "number" ? d.confidence : typeof d?.conf === "number" ? d.conf : null,
            bbox: Array.isArray(d?.bbox) ? d.bbox : null,
          }))
          .filter((d) => Array.isArray(d.bbox) && d.bbox.length >= 4);

        if (boxes.length === 0) continue;

        const originalUrl = (f.thumb_url || "").trim();
        const annotatedUrl = (f.annotated_url || f.thumb_url || "").trim();
        if (!annotatedUrl) continue;
        const referenceSourceUrl = originalUrl || annotatedUrl;

        let referenceImg: HTMLImageElement | null = null;
        let defectImg: HTMLImageElement | null = null;
        try {
          [referenceImg, defectImg] = await Promise.all([loadImage(referenceSourceUrl), loadImage(annotatedUrl)]);
        } catch {
          continue;
        }

        const referenceFull = referenceImg ? fullImageContainedDataUrl(referenceImg, 1600) : null;
        if (!referenceFull) continue;

        const fileKey = (f.file_id || f.filename || "").trim();
        const humanComment = fileKey ? (approvedComments[fileKey] || "").trim() : "";

        for (const b of boxes) {
          const bbox = b.bbox as number[];
          const defectCrop = defectImg ? cropDataUrl(defectImg, bbox) : null;
          if (!defectCrop) continue;

          const label = b.label || "Defect";
          const componentId = safeIdFromLabel(label);

          const defectHtml = `
            <section class="defect-block rgb-defect-pdf mb-4">
              <h2 class="text-sm font-bold text-blue-900 uppercase mb-2 border-b-2 border-gray-100 pb-1">Visual Assessment</h2>
              <div class="grid grid-cols-2 gap-4 items-start rgb-visual-row">
                <div class="flex flex-col">
                  <div class="bg-gray-100 p-1.5 rounded-t-lg border border-gray-300 border-b-0">
                    <h3 class="font-bold text-green-700 text-center uppercase tracking-wide text-xs">REFERENCE:</h3>
                  </div>
                  <div class="border border-gray-300 bg-white relative h-40 overflow-hidden flex items-center justify-center shrink-0">
                    <img src="${referenceFull}" alt="Reference original" class="object-contain max-w-full max-h-full w-auto h-auto bg-white">
                  </div>
                  <div class="border border-gray-300 border-t-0 p-2 rounded-b-lg bg-gray-50">
                    <p class="text-xs text-gray-700">Baseline visual condition (no annotation overlay). Used for comparison.</p>
                  </div>
                </div>
                <div class="flex flex-col">
                  <div class="bg-red-50 p-1.5 rounded-t-lg border border-red-300 border-b-0">
                    <h3 class="font-bold text-red-700 text-center uppercase tracking-wide text-xs">CURRENT:</h3>
                  </div>
                  <div class="border border-red-300 bg-white relative h-40 overflow-hidden flex items-center justify-center shrink-0">
                    <img src="${defectCrop}" alt="Defect crop" class="object-contain max-w-full max-h-full w-auto h-auto bg-white">
                  </div>
                  <div class="border border-red-300 border-t-0 p-2 rounded-b-lg bg-red-50">
                    <p class="text-xs text-gray-800 font-medium">Detection: <span class="text-red-600">${label}</span></p>
                  </div>
                </div>
              </div>
              <div class="mt-3">
                <h2 class="text-sm font-bold text-blue-900 uppercase mb-2 border-b-2 border-gray-100 pb-1">Defect Description & Maintenance Plan</h2>
                <div class="space-y-2">
                  <div class="grid grid-cols-4 gap-3 bg-gray-50 p-3 rounded-lg border border-gray-200">
                    <div>
                      <span class="block text-[10px] font-bold text-gray-500 uppercase">Component Name</span>
                      <span class="block text-xs font-semibold text-gray-900 mt-0.5">${label}</span>
                    </div>
                    <div>
                      <span class="block text-[10px] font-bold text-gray-500 uppercase">Component ID</span>
                      <span class="block text-xs font-semibold text-gray-900 mt-0.5">${componentId}</span>
                    </div>
                    <div>
                      <span class="block text-[10px] font-bold text-gray-500 uppercase">Batch / Run ID</span>
                      <span class="block text-xs font-semibold text-gray-900 mt-0.5">${run.run_id}</span>
                    </div>
                    <div>
                      <span class="block text-[10px] font-bold text-gray-500 uppercase">Inspection Date</span>
                      <span class="block text-xs font-semibold text-gray-900 mt-0.5">${inspectionDate}</span>
                    </div>
                  </div>
                  <div>
                    <p class="text-[10px] text-gray-400">Source file: ${String(f.filename || "—")}</p>
                  </div>
                  ${humanComment
                    ? `<div class="bg-blue-50 border-l-4 border-blue-600 p-2">
                         <h3 class="font-bold text-blue-900 mb-0.5 text-xs">Human suggestion</h3>
                         <p class="text-xs text-blue-950">${humanComment.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>
                       </div>`
                    : ""}
                </div>
              </div>
            </section>`;
          defectCards.push(defectHtml);
        }
      }

      if (isThermalReportRun) {
        for (const row of thermalRows) {
          const fid = String(row.file_id ?? "").trim();
          const fn = String(row.filename ?? "").trim();
          const tf =
            run.files.find(
              (f) =>
                (Boolean(fid) && (f.file_id || "").trim() === fid) ||
                (Boolean(fn) && (f.filename || "").trim() === fn)
            ) || null;
          const fileKey = ((tf?.file_id || tf?.filename || fid || fn) || "").trim();
          if (!fileKey) continue;
          if (approvedMap[fileKey] !== "approved") continue;
          const tComment = (approvedComments[fileKey] || "").trim();
          const fileForReport: FileInfo =
            tf ??
            ({
              filename: fn || `${fid || "thermal"}.jpg`,
              file_id: fid || undefined,
              status: "done",
            } as FileInfo);
          const rowUnit = row.unit != null ? String(row.unit) : thermalJobUnit;
          defectCards.push(
            await buildThermalDefectReportHtml({
              f: fileForReport,
              row: { ...row, unit: rowUnit },
              run,
              inspectionDate,
              humanComment: tComment,
            })
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

      const batchTotal = run.total_files > 0 ? run.total_files : run.files.length;
      const approvedCount = run.files.filter((f) => {
        const k = (f.file_id || f.filename || "").trim();
        return Boolean(k) && approvedMap[k] === "approved";
      }).length;
      let batchProcessingMs = 0;
      if (isThermalReportRun && thermalRows.length > 0) {
        for (const tr of thermalRows) {
          const m = tr.processing_time_ms;
          if (typeof m === "number" && Number.isFinite(m)) batchProcessingMs += m;
        }
      }
      if (batchProcessingMs === 0) {
        batchProcessingMs = run.files.reduce((s, f) => {
          const ms = f.stats?.processing_time_ms;
          return s + (typeof ms === "number" && Number.isFinite(ms) ? ms : 0);
        }, 0);
      }

      const thermalPdfTight = isThermalReportRun;
      const headerHtml = `
          <header class="flex flex-col md:flex-row justify-between items-start md:items-center border-b-4 border-blue-900 ${thermalPdfTight ? "pb-3 mb-3" : "pb-6 mb-8"}">
            <div>
              <h1 class="text-3xl font-extrabold text-gray-900 uppercase tracking-wide">Component Defect Report</h1>
              <p class="text-gray-500 mt-1 font-medium">Transmission Line Asset Management</p>
              <p class="text-xs text-gray-400 ${thermalPdfTight ? "mt-1" : "mt-2"}">Batch: <span class="font-Poppins">${run.run_id}</span> • Type: ${dtype.toUpperCase()} • Created: ${createdIso}</p>
              <p class="text-xs text-gray-400 mt-1">Assigned to: <span class="font-Poppins text-gray-600">${assigneeEscaped}</span></p>
              <p class="text-lg text-black mt-1.5 leading-relaxed font-medium">${pdfBatchMetaLine(batchTotal, approvedCount, batchProcessingMs)}</p>
            </div>
            <div class="mt-4 md:mt-0 text-right">
              <img src="${brandLogoSrc}" alt="AzərEnerji" class="${thermalPdfTight ? "h-24 md:h-28" : "h-[9rem] md:h-[10.5rem]"} w-auto object-contain ml-auto" />
            </div>
          </header>`;

      const footerHtml = `
          <footer class="${thermalPdfTight ? "mt-5 pt-5 gap-4" : "mt-12 pt-8 gap-8"} border-t-2 border-gray-300 flex flex-col md:flex-row justify-between items-end">
            <div class="w-full md:w-auto">
              <p class="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-1">Official Report Generated By</p>
              <div class="flex items-center gap-3">
                <img src="${brandLogoSrc}" alt="AzərEnerji" class="${thermalPdfTight ? "h-20" : "h-[6.75rem]"} w-auto object-contain" />
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
          </footer>`;

      const wrapCls = `max-w-5xl mx-auto bg-white p-8 md:p-12 shadow-xl border border-gray-200${thermalPdfTight ? " pdf-thermal-run" : ""}`;

      const pdfPages: string[] = [];
      if (defectCards.length <= 1) {
        pdfPages.push(`<div class="pdf-page ${wrapCls}">${headerHtml}${defectCards[0] || ""}${footerHtml}</div>`);
      } else {
        pdfPages.push(`<div class="pdf-page ${wrapCls}">${headerHtml}${defectCards[0]}</div>`);
        for (let di = 1; di < defectCards.length - 1; di++) {
          pdfPages.push(`<div class="pdf-page ${wrapCls}">${defectCards[di]}</div>`);
        }
        pdfPages.push(`<div class="pdf-page ${wrapCls}">${defectCards[defectCards.length - 1]}${footerHtml}</div>`);
      }

        perRunSections.push(pdfPages.join("\n"));
        pdfPageChunks.push(...pdfPages);
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
      a { text-decoration: none; color: inherit; }
    }
  </style>
</head>
<body class="bg-gray-100 text-gray-800 font-sans p-4 md:p-8">
  ${perRunSections.join("\n")}
</body>
</html>`;

      const pdfIframe = document.createElement("iframe");
      pdfIframe.style.cssText = "position:fixed;left:-9999px;top:0;width:794px;height:1400px;border:none;visibility:hidden;";
      document.body.appendChild(pdfIframe);
      const pdfDoc = pdfIframe.contentDocument || pdfIframe.contentWindow?.document;
      if (!pdfDoc) {
        toast.error("Cannot generate PDF", 4000);
        document.body.removeChild(pdfIframe);
        continue;
      }

      const pdfFullHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<script src="https://cdn.tailwindcss.com"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"><\/script>
<style>
/* PDF-only: full “page” height for flex fill, strip card chrome Tailwind adds on .pdf-page */
body.pdf-report-root{margin:0;padding:0;width:794px;background:#fff}
.pdf-page{
  box-sizing:border-box!important;
  width:100%!important;max-width:100%!important;margin:0 0 40px!important;
  min-height:1123px!important;height:1123px!important;
  display:flex!important;flex-direction:column!important;
  border:none!important;box-shadow:none!important;outline:none!important;
}
.pdf-page>header{flex-shrink:0}
.pdf-page>footer{flex-shrink:0;margin-top:auto}
.pdf-page>.defect-block{flex:1 1 auto!important;display:flex!important;flex-direction:column!important;min-height:0!important}
.pdf-page>.defect-block>h2:first-of-type{flex-shrink:0}
.pdf-page>.defect-block>.grid{flex:1 1 auto!important;min-height:0!important;align-items:stretch!important;align-content:stretch!important;grid-template-rows:1fr!important}
.pdf-page>.defect-block>.grid>.flex.flex-col{display:flex!important;flex-direction:column!important;min-height:0!important;height:100%!important}
.pdf-page>.defect-block>.grid>.flex-col>.relative.h-44{flex:1 1 auto!important;min-height:176px!important;height:auto!important}
.pdf-page>.defect-block>.mt-3{flex-shrink:0}
.pdf-page>.defect-block.thermal-report-pdf{flex:0 1 auto!important}
.pdf-page>.defect-block.thermal-report-pdf>.grid.thermal-visual-row{flex:0 1 auto!important;min-height:auto!important;grid-template-rows:auto!important;align-items:start!important}
.pdf-page>.defect-block.thermal-report-pdf>.grid.thermal-visual-row>.flex.flex-col{height:auto!important;min-height:0!important}
.pdf-page>.defect-block.thermal-report-pdf>.grid.thermal-visual-row .relative.h-40{flex:0 0 auto!important;height:160px!important;min-height:160px!important;max-height:160px!important;overflow:hidden!important}
.pdf-page>.defect-block.thermal-report-pdf>.mt-2{flex:0 0 auto!important;flex-shrink:0!important;width:100%!important}
.pdf-page>.defect-block.thermal-report-pdf .thermal-meta-row{align-items:start!important}
.pdf-page.pdf-thermal-run{padding:1rem 1.25rem!important}
.pdf-page>.defect-block.rgb-defect-pdf{flex:0 1 auto!important}
.pdf-page>.defect-block.rgb-defect-pdf>.grid.rgb-visual-row{flex:0 1 auto!important;min-height:auto!important;grid-template-rows:auto!important;align-items:start!important}
.pdf-page>.defect-block.rgb-defect-pdf>.grid.rgb-visual-row>.flex.flex-col{height:auto!important;min-height:0!important}
.pdf-page>.defect-block.rgb-defect-pdf>.grid.rgb-visual-row .relative.h-40{flex:0 0 auto!important;height:160px!important;min-height:160px!important;max-height:160px!important;overflow:hidden!important}
</style>
</head><body class="pdf-report-root bg-white text-gray-800 font-sans">
${pdfPageChunks.join("\n")}
</body></html>`;

      pdfDoc.open();
      pdfDoc.write(pdfFullHtml);
      pdfDoc.close();

      await new Promise<void>((res) => {
        let d = false;
        const f = () => { if (!d) { d = true; res(); } };
        pdfIframe.addEventListener("load", f);
        setTimeout(f, 8000);
      });
      await new Promise((r) => setTimeout(r, 2500));

      const allImgs = pdfDoc.body.querySelectorAll("img");
      if (allImgs.length > 0) {
        await Promise.all(Array.from(allImgs).map((img) => new Promise<void>((res) => {
          if (img.complete && img.naturalWidth > 0) { res(); return; }
          img.onload = () => res();
          img.onerror = () => res();
          setTimeout(res, 4000);
        })));
        await new Promise((r) => setTimeout(r, 300));
      }

      const iframeWin = pdfIframe.contentWindow as Window & { html2canvas?: (el: HTMLElement, opts: Record<string, unknown>) => Promise<HTMLCanvasElement> };
      if (!iframeWin?.html2canvas) {
        toast.error("PDF renderer failed to load", 4000);
        document.body.removeChild(pdfIframe);
        continue;
      }

      try {
        const { jsPDF } = await import("jspdf");
        const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
        const pageW = 210;
        const pageH = 297;
        const margin = 6;
        const contentW = pageW - margin * 2;

        const pageEls = pdfDoc.querySelectorAll(".pdf-page");
        for (let pi = 0; pi < pageEls.length; pi++) {
          const canvas = await iframeWin.html2canvas(pageEls[pi] as HTMLElement, {
            scale: 2, useCORS: true,
            width: 794, windowWidth: 794, scrollY: 0,
            backgroundColor: "#ffffff",
          });

          const imgData = canvas.toDataURL("image/jpeg", 0.95);
          const imgH = (canvas.height * contentW) / canvas.width;

          if (pi > 0) pdf.addPage();
          pdf.addImage(imgData, "JPEG", margin, margin, contentW, Math.min(imgH, pageH - margin * 2));
        }

        pdf.save(pdfFilename);
        pdfExportSuccessCount++;
      } catch {
        toast.error("PDF generation failed", 4000);
      } finally {
        document.body.removeChild(pdfIframe);
      }
    }

    if (pdfExportSuccessCount > 0) {
      toast.success(`${pdfExportSuccessCount} report${pdfExportSuccessCount > 1 ? "s" : ""} downloaded`, 2500);
    }
  }, [runs, selectedRunIds, runCreatedTs, fileReviewStatusByRun, fileCommentByRun, batchAssigneeByRun]);

  const openPreview = (run: RunEntry, fileIdx = 0) => {
    setPreviewRun(run);
    setPreviewFileIdx(fileIdx);
  };

  const completedFiles = previewRun?.files.filter(f => f.status === "done") || [];
  const previewFile = completedFiles[previewFileIdx] || null;

  const previewDetectionRows = useMemo(() => {
    if (!previewRun || !previewFile) return [];
    return previewDetectionRowsForFile(previewRun.type, previewFile.detections, videoFetchedDetections);
  }, [previewRun, previewFile, videoFetchedDetections]);

  const previewClassFilterResetKey =
    previewRun && previewFile ? `${previewRun.run_id}:${previewFileIdx}` : null;
  const clsFilter = useDetectionClassFilterForRows(
    previewDetectionRows as DetectionRowLike[],
    previewClassFilterResetKey
  );

  const previewSidebarPartition = useMemo(() => {
    if (!previewDetectionRows.length) return null;
    return partitionDetectionsSidebarBuckets(clsFilter.filteredRows);
  }, [previewDetectionRows.length, clsFilter.filteredRows]);

  const isDjiThermalScanUpload = Boolean(previewRun?.thermal_analysis_job);

  const runsPreviewSourceW = typeof previewFile?.image_width === "number" ? previewFile.image_width : 0;
  const runsPreviewSourceH = typeof previewFile?.image_height === "number" ? previewFile.image_height : 0;
  const runsPreviewHasSourceDims = runsPreviewSourceW > 0 && runsPreviewSourceH > 0;
  const runsPreviewThumbSrc = previewFile?.thumb_url?.trim() || "";
  const runsPreviewShowLiveOverlay =
    !isDjiThermalScanUpload &&
    previewRun?.type !== "video" &&
    runsPreviewHasSourceDims &&
    Boolean(runsPreviewThumbSrc);

  const runsOverlayDetections = clsFilter.filteredRows.filter(
    (d) => Array.isArray(d.bbox) && d.bbox.length >= 4
  ) as Array<{ bbox: number[]; class_name?: string; label?: string }>;

  useRgbPreviewDetectionOverlay(runsPreviewImgRef, runsPreviewCanvasRef, {
    enabled: runsPreviewShowLiveOverlay,
    sourceW: runsPreviewSourceW,
    sourceH: runsPreviewSourceH,
    detections: runsOverlayDetections,
    imageUrlKey: `${previewRun?.run_id}:${previewFileIdx}:${runsPreviewThumbSrc}`,
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
      if (e.key === "Escape") closePreview();
      if (e.key === "ArrowLeft") navigatePreview(-1);
      if (e.key === "ArrowRight") navigatePreview(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewRun, closePreview]);

  useEffect(() => {
    setPreviewModalZoom(1);
  }, [previewRun?.run_id]);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold dash-text-primary mb-2">Recent Uploads</h1>
          <p className="dash-text-muted">All uploaded images and videos with detection results</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => generateSelectedReport()}
            disabled={selectedCount === 0}
            className={`flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition-colors ${
              selectedCount === 0
                ? "bg-[var(--dash-nested-bg-mid)] border-[var(--dash-panel-border)] dash-text-subtle cursor-not-allowed"
                : "bg-cyan-500/20 border-cyan-500/50 hover:bg-cyan-500/30"
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
            { label: "Total Defects", value: runs.reduce((s, r) => s + runUniqueFindingsCount(r), 0), color: "text-red-400" },
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
                className="absolute top-1/2 z-10 -translate-y-1/2 rounded-full dash-text-primary p-2.5 hover:bg-[var(--dash-hover-bg)] transition-all duration-150 shadow-lg right-[max(1rem,calc(380px+0.5rem))]"
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
                      <div className="relative mx-auto flex w-full max-w-5xl flex-col items-center">
                        {previewRun.type !== "video" && previewFile.annotated_url && (
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

                        {previewRun.type === "video" && previewFile.video_url ? (
                          <video
                            ref={runsPreviewVideoRef}
                            key={previewFile.video_url}
                            src={previewFile.video_url}
                            controls
                            autoPlay
                            playsInline
                            className="max-h-[min(80vh,calc(100vh-8rem))] w-full max-w-full rounded-2xl bg-black shadow-2xl"
                          />
                        ) : (previewFile.annotated_url || runsPreviewThumbSrc) ? (
                          <div
                            className="relative mx-auto inline-block max-w-full rounded-2xl shadow-2xl transition-[transform] duration-150 ease-out"
                            style={{ transform: `scale(${previewModalZoom})`, transformOrigin: "center" }}
                          >
                            {runsPreviewShowLiveOverlay ? (
                              <>
                                <img
                                  ref={runsPreviewImgRef}
                                  src={runsPreviewThumbSrc}
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
                                src={previewFile.annotated_url}
                                alt={previewFile.filename}
                                className="w-full max-h-[80vh] rounded-2xl object-contain bg-black"
                              />
                            )}
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
                    ) : (
                      <div className="text-base dash-text-subtle">No completed files to preview</div>
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

            {/* RIGHT — Stats & details */}
            <div
              className="flex h-full min-h-0 w-[380px] shrink-0 flex-col overflow-hidden border-l border-dash dash-modal-aside"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex shrink-0 items-stretch border-b border-dash">
                <div className="flex min-w-0 flex-1 items-center px-3 py-2.5">
                  <span className="text-[10px] font-bold uppercase tracking-widest dash-text-subtle">Run</span>
                </div>
                <button
                  type="button"
                  onClick={() => closePreview()}
                  className="flex shrink-0 items-center justify-center px-3 border-l border-dash hover:bg-[var(--dash-hover-bg)] transition-colors"
                  aria-label="Close preview"
                >
                  <X size={18} className="dash-text-subtle" />
                </button>
              </div>
              <div className="shrink-0 p-4 border-b border-dash">
                <div className="flex items-center gap-2 mb-2.5">
                  <span className={`px-2 py-0.5 rounded-lg text-[11px] font-bold border tracking-wide ${
                    runDisplayType(previewRun) === "image"
                      ? "bg-blue-500/15 text-blue-300 border-blue-500/30"
                      : runDisplayType(previewRun) === "thermal"
                        ? "bg-orange-500/15 text-orange-300 border-orange-500/30"
                        : "bg-purple-500/15 text-purple-300 border-purple-500/30"
                  }`}>
                    {runDisplayType(previewRun).toUpperCase()}
                  </span>
                  <span className={`px-2 py-0.5 rounded-lg text-[11px] font-bold border tracking-wide ${
                    isRunBatchComplete(previewRun.status)
                      ? "bg-green-500/15 text-green-300 border-green-500/30"
                      : "bg-amber-500/15 text-amber-300 border-amber-500/30"
                  }`}>
                    {isRunBatchComplete(previewRun.status) ? "COMPLETE" : "PROCESSING"}
                  </span>
                </div>
                <div className="text-xs font-mono dash-text-muted truncate" title={previewRun.run_id}>
                  {previewRun.run_id}
                </div>
                <div className="text-[11px] dash-text-subtle mt-1">{timeAgo(previewRun.created_at)}</div>
              </div>

              <div className="shrink-0 p-4 border-b border-dash">
                <div className="grid grid-cols-3 gap-3">
                  <div className="flex flex-col gap-0.5">
                    <div className="text-[10px] dash-text-muted font-medium uppercase tracking-wide">Files</div>
                    <div className="text-xl font-bold dash-text-primary tabular-nums">{previewRun.total_files}</div>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <div className="text-[10px] dash-text-muted font-medium uppercase tracking-wide">Done</div>
                    <div className="text-xl font-bold dash-text-primary tabular-nums">{previewRun.completed}</div>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <div className="text-[10px] dash-text-muted font-medium uppercase tracking-wide">Defects</div>
                    {previewFile != null && previewRun ? (
                      previewRun.type === "video" &&
                      previewDetectionRows.length === 0 &&
                      (previewFile.total_detections || 0) > 0 &&
                      videoDetectionsLoading ? (
                        <div className="text-sm font-bold dash-text-subtle mt-0.5">…</div>
                      ) : previewSidebarPartition ? (
                        <div className="flex flex-col gap-0.5 mt-0.5">
                          <span className="text-[11px] font-semibold dash-text-body tabular-nums">
                            {previewSidebarPartition.components.length} comp.
                          </span>
                          <span className={`text-[11px] font-bold tabular-nums ${previewSidebarPartition.defects.length > 0 ? "text-red-400" : "text-green-400"}`}>
                            {previewSidebarPartition.defects.length} def.
                          </span>
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
              </div>

              {previewFile && (
                <div className="shrink-0 p-4 border-b border-dash">
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[10px] font-medium dash-text-muted uppercase tracking-wide mb-1">Current File</div>
                      <div
                        className="text-sm dash-text-primary truncate font-semibold leading-snug"
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
                        liveOverlayEnabled={runsPreviewShowLiveOverlay}
                      />
                    )}
                  </div>

                  {previewRun.type !== "video" && previewFile.stats && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="dash-text-muted">Processing time</span>
                      <span className="dash-text-primary font-semibold tabular-nums">
                        {previewFile.stats.processing_time_ms}ms
                      </span>
                    </div>
                  )}

                  {previewRun.type === "video" && (
                    <div className="space-y-2 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="dash-text-muted">Duration</span>
                        <span className="dash-text-primary font-semibold tabular-nums">{formatDuration(previewFile.duration || 0)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="dash-text-muted">FPS</span>
                        <span className="dash-text-primary font-semibold tabular-nums">{previewFile.fps || 0}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="dash-text-muted">Frames analyzed</span>
                        <span className="dash-text-primary font-semibold tabular-nums">{previewFile.frames_analyzed || 0}</span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="min-h-0 flex-1 overflow-y-auto">
                {previewRun.type === "video" &&
                  previewFile &&
                  videoDetectionsLoading &&
                  previewDetectionRows.length === 0 &&
                  (previewFile.total_detections || 0) > 0 && (
                    <div className="p-4 text-xs dash-text-subtle">Loading defect list…</div>
                  )}

                {previewFile && previewSidebarPartition &&
                  (previewSidebarPartition.components.length > 0 || previewSidebarPartition.defects.length > 0) && (
                    <DetectionSidebarBucketPanels partition={previewSidebarPartition} hideRowCounts />
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
