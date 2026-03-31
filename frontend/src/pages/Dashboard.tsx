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
import { toast } from "../components/Toast";
import { VideoAnnotatedFrameStrip } from "../components/VideoAnnotatedFrameStrip";
import {
  ThermalAnalysisDetailModal,
  type ThermalStats,
  type ThermalAnalysisData,
} from "../components/ThermalAnalysisDetailModal";
import { formatDetectionLabel } from "../utils/formatLabels";
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
} from "lucide-react";

const COLORS = ["#10b981", "#f59e0b", "#ef4444", "#6b7280"]; // completed, processing, failed, pending
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

type DashboardRunFile = {
  file_id?: string;
  filename?: string;
  /** rgb | thermal from detection server (thermal uses same image URLs as RGB) */
  source?: string;
  thumb_url?: string | null;
  annotated_url?: string | null;
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

function fileAvgConf(f: DashboardRunFile, isVideoJob: boolean): number {
  if (isVideoJob) return f.avg_confidence ?? 0;
  return f.stats?.avg_confidence ?? 0;
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
      <div className="absolute inset-0 bg-neutral-800 animate-pulse flex items-center justify-center">
        <Clock className="text-neutral-600 w-6 h-6 animate-spin" />
      </div>
    );
  }
  if (slideUrls.length === 0) {
    return (
      <div className="absolute inset-0 bg-neutral-800 flex items-center justify-center">
        <ImageIcon className="w-7 h-7 text-neutral-600" />
      </div>
    );
  }
  return (
    <div className="absolute inset-0 bg-neutral-900 overflow-hidden">
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
        <div className="absolute bottom-1 left-1/2 -translate-x-1/2 z-[2] rounded-full bg-black/65 px-1.5 py-0.5 text-[9px] text-neutral-200 font-mono tabular-nums">
          {idx + 1}/{slideUrls.length}
        </div>
      )}
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
  const reduceMotion = useReducedMotion();

  // Auto-advance slides every 5 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentSlide((prev) => (prev + 1) % 3);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

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

  const statusPie = useMemo(() => {
    const completed = filteredRuns.filter((r) => r.status === "completed").length;
    const processing = filteredRuns.filter((r) => r.status === "processing").length;
    const failed = filteredRuns.filter((r) => r.status === "failed").length;
    const pending = filteredRuns.filter((r) => r.status === "pending").length;
    return [
      { name: "Completed", value: completed, color: COLORS[0] },
      { name: "Processing", value: processing, color: COLORS[1] },
      { name: "Failed", value: failed, color: COLORS[2] },
      { name: "Pending", value: pending, color: COLORS[3] },
    ].filter((d) => d.value > 0);
  }, [filteredRuns]);

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
        const embedded = run ? extractUrlsFromRunPayload(run) : { urls: [] as string[], filenames: [] as string[] };
        if (embedded.urls.length > 0) {
          return;
        }

        let urls: string[] = [];
        let filenames: string[] = [];
        try {
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
    const urlRaw = (tr?.thermal_image_url as string) || "";
    const imgUrl = urlRaw ? resolveMediaSrc(urlRaw) : "";
    const countDisplay = Math.max(nT, results?.length ?? 0);
    return {
      runId,
      fname,
      tr,
      imgUrl,
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
        className="space-y-6"
      >
        <div>
          <div className="h-8 w-40 bg-neutral-700/50 rounded mb-2 animate-pulse" />
          <div className="h-4 w-56 bg-neutral-700/40 rounded animate-pulse" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4 animate-pulse">
              <div className="h-4 w-20 bg-neutral-700/50 rounded mb-3" />
              <div className="h-8 w-16 bg-neutral-700/60 rounded" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 h-64 animate-pulse" />
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 h-64 animate-pulse" />
        </div>
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 animate-pulse h-48" />
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={transition}
      className="space-y-6"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">Dashboard</h1>
          <p className="text-neutral-400">Inspection overview</p>
        </div>
        <div className="flex flex-wrap gap-2 justify-end">
          <motion.div
            whileHover={reduceMotion ? undefined : { y: -2, transition: { duration: 0.15 } }}
            className="max-w-[220px]"
          >
            <Link
              to="/ai-detection"
              className="block rounded-xl border border-cyan-500/30 bg-gradient-to-br from-cyan-900/20 to-blue-900/10 p-3 text-left hover:border-cyan-500/60 transition-all group"
            >
              <div className="flex items-center gap-2 mb-2">
                <div className="w-9 h-9 rounded-lg bg-cyan-500/20 flex items-center justify-center shrink-0">
                  <ImageIcon size={18} className="text-cyan-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className="text-xs font-semibold text-white leading-tight">RGB image</h4>
                </div>
                <Plus size={16} className="text-cyan-400 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </Link>
          </motion.div>

          <motion.div
            transition={transition}
            whileHover={reduceMotion ? undefined : { y: -2, transition: { duration: 0.15 } }}
            className="max-w-[220px]"
          >
            <Link
              to="/ai-detection?mode=thermal"
              className="block rounded-xl border border-orange-500/30 bg-gradient-to-br from-orange-900/20 to-red-900/10 p-3 text-left hover:border-orange-500/60 transition-all group"
            >
              <div className="flex items-center gap-2 mb-2">
                <div className="w-9 h-9 rounded-lg bg-orange-500/20 flex items-center justify-center shrink-0">
                  <Thermometer size={18} className="text-orange-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className="text-xs font-semibold text-white leading-tight">Thermal analysis</h4>
                </div>
                <Plus size={16} className="text-orange-400 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </Link>
          </motion.div>

          <motion.div
            transition={transition}
            whileHover={reduceMotion ? undefined : { y: -2, transition: { duration: 0.15 } }}
            className="max-w-[220px]"
          >
            <Link
              to="/video-upload"
              className="block rounded-xl border border-purple-500/30 bg-gradient-to-br from-purple-900/20 to-indigo-900/10 p-3 text-left hover:border-purple-500/60 transition-all group"
            >
              <div className="flex items-center gap-2 mb-2">
                <div className="w-9 h-9 rounded-lg bg-purple-500/20 flex items-center justify-center shrink-0">
                  <Video size={18} className="text-purple-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className="text-xs font-semibold text-white leading-tight">Upload video</h4>
                </div>
                <Plus size={16} className="text-purple-400 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </Link>
          </motion.div>
        </div>
      </div>

      {/* How It Works Banner Carousel */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative rounded-2xl border border-cyan-500/30 bg-gradient-to-r from-cyan-900/20 to-blue-900/20 overflow-hidden"
      >
        {/* Background Image */}
        <div className="absolute inset-0 opacity-20">
          <img 
            src="/banner-powerline.jpg" 
            alt="Power transmission infrastructure"
            className="w-full h-full object-cover"
            onError={(e) => {
              // Fallback if image doesn't exist - hide the error
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        </div>
        
        {/* Slide Container */}
        <div className="relative h-48 md:h-56 z-10">
          {/* Slide 1: Single Image Upload */}
          {currentSlide === 0 && (
            <motion.div
              key="slide-1"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3 }}
              className="absolute inset-0 flex items-center justify-end p-6 md:p-8"
            >
              <div className="flex justify-end">
                <div className="bg-black/40 backdrop-blur-sm rounded-lg p-4 md:p-6 border border-white/10 max-w-3xl">
                  <h3 className="text-xl md:text-2xl font-bold text-white mb-2">Single Image Upload</h3>
                  <div className="space-y-2 text-sm md:text-base text-neutral-200">
                    <div className="flex items-start gap-2">
                      <span className="text-cyan-400 font-bold">1.</span>
                      <span>Upload RGB image (thermal optional) with tower details</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="text-cyan-400 font-bold">2.</span>
                      <span>AI detects components and classifies defects automatically</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="text-cyan-400 font-bold">3.</span>
                      <span>Review detections and download detailed incident report</span>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {/* Slide 2: Bulk Batch Processing */}
          {currentSlide === 1 && (
            <motion.div
              key="slide-2"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3 }}
              className="absolute inset-0 flex items-center justify-end p-6 md:p-8"
            >
              <div className="flex justify-end">
                <div className="bg-black/40 backdrop-blur-sm rounded-lg p-4 md:p-6 border border-white/10 max-w-3xl">
                  <h3 className="text-xl md:text-2xl font-bold text-white mb-2">Bulk Batch Processing</h3>
                  <div className="space-y-2 text-sm md:text-base text-neutral-200">
                    <div className="flex items-start gap-2">
                      <span className="text-blue-400 font-bold">1.</span>
                      <span>Upload multiple images at once for batch processing</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="text-blue-400 font-bold">2.</span>
                      <span>Images are automatically organized by defect type</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="text-blue-400 font-bold">3.</span>
                      <span>Download comprehensive statistics report with all images</span>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {/* Slide 3: Thermal Hot Spots & Corona Discharge */}
          {currentSlide === 2 && (
            <motion.div
              key="slide-3"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3 }}
              className="absolute inset-0 flex items-center justify-end p-6 md:p-8"
            >
              <div className="flex justify-end">
                <div className="bg-black/40 backdrop-blur-sm rounded-lg p-4 md:p-6 border border-white/10 max-w-3xl">
                  <h3 className="text-xl md:text-2xl font-bold text-white mb-2">Thermal Hot Spots & Corona Discharge Detection</h3>
                  <div className="space-y-2 text-sm md:text-base text-neutral-200">
                    <div className="flex items-start gap-2">
                      <span className="text-orange-400 font-bold">1.</span>
                      <span>Upload thermal images to detect hot spots and temperature anomalies</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="text-orange-400 font-bold">2.</span>
                      <span>AI identifies corona discharge patterns and electrical faults</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="text-orange-400 font-bold">3.</span>
                      <span>Get detailed analysis with temperature readings and risk assessment</span>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </div>

        {/* Navigation Dots */}
        <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex gap-2">
          {[0, 1, 2].map((index) => (
            <button
              key={index}
              onClick={() => setCurrentSlide(index)}
              className={`h-2 rounded-full transition-all ${
                currentSlide === index
                  ? "w-8 bg-cyan-400"
                  : "w-2 bg-neutral-600 hover:bg-neutral-500"
              }`}
              aria-label={`Go to slide ${index + 1}`}
            />
          ))}
        </div>

        {/* Navigation Arrows */}
        <button
          onClick={() => setCurrentSlide((prev) => (prev - 1 + 3) % 3)}
          className="absolute left-4 top-1/2 transform -translate-y-1/2 p-2 rounded-full bg-black/30 hover:bg-black/50 border border-neutral-700 hover:border-cyan-400/50 transition-colors"
          aria-label="Previous slide"
        >
          <ChevronLeft className="text-white" size={20} />
        </button>
        <button
          onClick={() => setCurrentSlide((prev) => (prev + 1) % 3)}
          className="absolute right-4 top-1/2 transform -translate-y-1/2 p-2 rounded-full bg-black/30 hover:bg-black/50 border border-neutral-700 hover:border-cyan-400/50 transition-colors"
          aria-label="Next slide"
        >
          <ChevronRight className="text-white" size={20} />
        </button>
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
                  className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4 hover:border-neutral-700 transition-colors group relative"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-neutral-400 uppercase tracking-wider flex items-center gap-1">
                      {kpi.label}
                      {kpi.tooltip && (
                        <span
                          title={kpi.tooltip}
                          className="text-neutral-500 hover:text-neutral-300 cursor-help"
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
                  <div className="text-2xl font-bold text-white">{kpi.value}</div>
                  {kpi.sub ? <div className="text-xs text-neutral-500 mt-0.5">{kpi.sub}</div> : null}
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
              className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4"
            >
              <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                <BarChart3 size={16} className="text-cyan-400" />
                Top Defect Types
              </h3>
              <div className="flex flex-wrap gap-3">
                {topDefectTypes.map(({ name, value }) => (
                  <div
                    key={name}
                    className="flex items-center gap-2 bg-neutral-800/80 rounded-lg px-3 py-2 border border-neutral-700"
                  >
                    <span className="text-sm font-medium text-white capitalize">{name}</span>
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
                    <h3 className="text-lg font-semibold text-white">Latest Bulk Batch</h3>
                    <span className="text-xs text-neutral-400">
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
                    <div className="text-sm text-neutral-300 mb-3">
                      Organized into <span className="text-premium-accent font-semibold">{Object.keys(latestBulkBatch.organization.folders || {}).length}</span> defect type folders
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                      {(Object.entries(latestBulkBatch.organization.folders || {}) as [string, number][]).map(([folder, count]) => (
                        <div
                          key={folder}
                          className="glass rounded-lg border border-neutral-700 p-3 hover:border-premium-accent/50 transition-colors"
                        >
                          <div className="text-premium-accent font-semibold text-sm capitalize">
                            {String(folder).replace(/_/g, " ")}
                          </div>
                          <div className="text-neutral-300 text-xs mt-1">
                            {count} image{count !== 1 ? "s" : ""}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2 text-xs text-neutral-400 pt-3 border-t border-premium-accent/30">
                    <code className="bg-neutral-800 px-2 py-1 rounded">{latestBulkBatch.batch_dir || "outputs/bulk_processing/"}</code>
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
              className="rounded-xl border border-neutral-800 bg-neutral-900/50 overflow-hidden"
            >
              {/* Dropdown Header */}
              <button
                onClick={() => setBulkBatchesDropdownOpen(!bulkBatchesDropdownOpen)}
                className="w-full flex items-center justify-between p-6 hover:bg-neutral-800/50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Upload className="text-cyan-400" size={20} />
                  <h3 className="text-lg font-semibold text-white">Recent Bulk Batches</h3>
                  <span className="text-xs text-neutral-400 bg-neutral-800 px-2 py-1 rounded">
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
                    <ChevronUp className="text-neutral-400" size={20} />
                  ) : (
                    <ChevronDown className="text-neutral-400" size={20} />
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
                  className="px-6 pb-6 space-y-3 border-t border-neutral-800"
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
                      className="glass rounded-lg border border-neutral-700 p-4 hover:border-cyan-500/50 transition-colors"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-white mb-1">
                            Batch {batch.batch_id ? formatBatchDate(batch.batch_id) : batchId}
                          </div>
                          <code className="text-xs text-neutral-500 font-mono">{batchId}</code>
                        </div>
                        <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2 text-xs">
                          <span className="flex items-center gap-1 text-neutral-300">
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
                      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-neutral-800">
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
              className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4"
            >
              <h3 className="text-sm font-semibold text-white mb-4">Uploads per day (last 14 days)</h3>
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={runsPerDay} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="runsGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#06b6d4" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="#06b6d4" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="date" stroke="#9ca3af" fontSize={11} />
                    <YAxis stroke="#9ca3af" fontSize={11} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#1f2937",
                        border: "1px solid #374151",
                        borderRadius: "8px",
                        fontSize: "12px",
                      }}
                      labelStyle={{ color: "#9ca3af" }}
                    />
                    <Area type="monotone" dataKey="runs" stroke="#06b6d4" fill="url(#runsGrad)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </motion.div>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ ...transition, delay: reduceMotion ? 0 : 0.15 }}
              className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4"
            >
              <h3 className="text-sm font-semibold text-white mb-4">Status distribution</h3>
              <div className="h-52">
                {statusPie.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={statusPie}
                        cx="50%"
                        cy="50%"
                        innerRadius={48}
                        outerRadius={72}
                        paddingAngle={2}
                        dataKey="value"
                        nameKey="name"
                        label={({ name, value }) => `${name}: ${value}`}
                        labelLine={false}
                      >
                        {statusPie.map((entry, i) => (
                          <Cell key={entry.name} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "#1f2937",
                          border: "1px solid #374151",
                          borderRadius: "8px",
                          fontSize: "12px",
                        }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex items-center justify-center h-full text-neutral-500 text-sm">
                    No data
                  </div>
                )}
              </div>
            </motion.div>
          </div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ ...transition, delay: reduceMotion ? 0 : 0.2 }}
            className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4"
          >
            <h3 className="text-sm font-semibold text-white mb-4">Needs Review per day (last 14 days)</h3>
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={runsPerDay} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="date" stroke="#9ca3af" fontSize={11} />
                  <YAxis stroke="#9ca3af" fontSize={11} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#1f2937",
                      border: "1px solid #374151",
                      borderRadius: "8px",
                      fontSize: "12px",
                    }}
                  />
                  <Bar dataKey="mustReview" name="Needs review" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </motion.div>

          {/* Recent Runs */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ ...transition, delay: reduceMotion ? 0 : 0.25 }}
            className="rounded-xl border border-neutral-800 bg-neutral-900/50 overflow-hidden"
          >
            <div className="px-4 py-3 border-b border-neutral-800 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Recent Uploads</h3>
              <Link
                to="/runs"
                className="text-xs font-medium text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
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
                          className={`rounded-lg border bg-neutral-900/80 overflow-hidden text-left cursor-pointer transition-all ${
                            isSelected
                              ? "border-cyan-500/60 ring-1 ring-cyan-500/40 shadow-[0_0_12px_rgba(34,211,238,0.1)]"
                              : "border-neutral-800 hover:border-neutral-600"
                          }`}
                        >
                          <div className="relative h-[72px] sm:h-20 w-full border-b border-neutral-800 overflow-hidden shrink-0 bg-neutral-950">
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
                                  <span className="font-mono text-white text-[10px] truncate" title={runId}>
                                    {runId.length > 10 ? `${runId.slice(0, 10)}…` : runId}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      copyRunId(runId);
                                    }}
                                    className="p-0.5 rounded text-neutral-400 hover:text-white hover:bg-neutral-700 shrink-0"
                                    aria-label="Copy run ID"
                                  >
                                    <Copy size={10} />
                                  </button>
                                </div>
                                <div className="text-[9px] text-neutral-500 truncate leading-tight">
                                  {ts ? new Date(ts).toLocaleString() : "—"}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedRecentRunId(runId);
                                }}
                                className="shrink-0 inline-flex items-center gap-0.5 rounded-md bg-cyan-500/20 text-cyan-300 border border-cyan-500/50 px-1.5 py-0.5 text-[9px] font-semibold hover:bg-cyan-500/30"
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
                              <span className="text-neutral-400">
                                Findings:{" "}
                                <span className="text-neutral-300">
                                  {run.findings_count !== undefined ? run.findings_count : "—"}
                                </span>
                              </span>
                              <span
                                className={
                                  (run.must_review_count ?? 0) > 0
                                    ? "text-amber-400 font-medium"
                                    : "text-neutral-400"
                                }
                              >
                                Review: {run.must_review_count ?? "—"}
                              </span>
                              {pct != null && (
                                <span className="text-neutral-400">
                                  Conf: <span className="text-neutral-300">{pct}%</span>
                                </span>
                              )}
                            </div>
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                </div>

                {selectedRecentRunId && (
                  <div className="w-full lg:w-1/2 flex flex-col border-t lg:border-t-0 lg:border-l border-neutral-800 lg:pl-4 pt-4 lg:pt-0 min-h-[280px] lg:max-h-[min(70vh,720px)]">
                    <div className="flex items-center justify-between gap-2 mb-3 shrink-0">
                      <div className="min-w-0">
                        <div className="text-xs text-neutral-500 uppercase tracking-wide">
                          Batch images
                        </div>
                        <div className="font-mono text-sm text-white truncate" title={selectedRecentRunId}>
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
                          className="inline-flex items-center gap-1 rounded-lg bg-cyan-500/30 text-cyan-100 border border-cyan-400/60 px-2.5 py-1.5 text-xs font-semibold hover:bg-cyan-500/45"
                        >
                          <Eye size={14} />
                          View details
                        </button>
                        <Link
                          to={`/runs/${selectedRecentRunId}`}
                          className="inline-flex items-center gap-1 rounded-lg bg-cyan-500/20 text-cyan-300 border border-cyan-500/50 px-2.5 py-1.5 text-xs font-semibold hover:bg-cyan-500/30"
                        >
                          Open run
                        </Link>
                        <button
                          type="button"
                          onClick={() => setSelectedRecentRunId(null)}
                          className="rounded-lg border border-neutral-700 text-neutral-300 px-2.5 py-1.5 text-xs font-semibold hover:bg-neutral-800"
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
                            <div className="flex items-center justify-center py-16 text-neutral-500 text-sm gap-2">
                              <Clock className="animate-spin" size={18} />
                              Loading…
                            </div>
                          );
                        }
                        if (selUrls.length === 0) {
                          return (
                            <div className="flex flex-col items-center justify-center py-16 text-neutral-500 text-sm gap-2">
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
                                  className="relative aspect-square rounded-lg border border-neutral-700 overflow-hidden bg-neutral-800 hover:border-cyan-500/50 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 transition-colors group"
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
                    className="absolute top-2 right-2 z-20 bg-neutral-800 hover:bg-neutral-700 rounded-full p-2 transition-colors md:top-4 md:right-4"
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
                        className="mx-auto w-full max-h-[55vh] rounded-lg border border-neutral-800 bg-black md:max-h-[min(85vh,820px)]"
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
                    <div className="mt-2 bg-black/70 px-3 py-2 text-xs font-mono text-white md:absolute md:bottom-4 md:left-4 md:mt-0 md:max-w-[min(100%,28rem)] md:rounded-lg">
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
                    className="absolute bottom-2 right-2 z-10 flex items-center gap-2 rounded-lg bg-cyan-500 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-cyan-600 md:bottom-4 md:right-4 md:px-4"
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
                          const i = apiFiles.findIndex(
                            (f) =>
                              resolveMediaSrc(f.annotated_url) === imageUrl ||
                              resolveMediaSrc(f.thumb_url) === imageUrl ||
                              (videoUrl &&
                                f.video_url &&
                                resolveMediaSrc(f.video_url) === videoUrl)
                          );
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
                open
                onClose={() => {
                  setRecentBatchDetail(null);
                  setDashThermalRoiActive(false);
                  setDashThermalRoiStart(null);
                  setDashThermalRoiEnd(null);
                  setDashThermalRoiStats(null);
                }}
                filename={
                  dashThermalDetail.fname ||
                  (dashThermalDetail.tr as { filename?: string } | undefined)?.filename ||
                  "Thermal"
                }
                thermalImageB64={
                  (dashThermalDetail.tr as { thermal_image_base64_png?: string } | undefined)
                    ?.thermal_image_base64_png || null
                }
                thermalImageUrl={dashThermalDetail.imgUrl || null}
                stats={(dashThermalDetail.tr?.stats as ThermalStats) ?? null}
                analysis={(dashThermalDetail.tr?.analysis as ThermalAnalysisData) ?? null}
                unit={String(
                  (dashThermalDetail.tr as { unit?: string } | undefined)?.unit ?? "Celsius"
                )}
                analysisConfiguration={{
                  objectType: thermalDetailJobMeta?.object_type ?? null,
                  paletteId: thermalDetailJobMeta?.palette ?? null,
                }}
                fileIndexDisplay={dashThermalDetail.safeIdxT}
                fileCountDisplay={dashThermalDetail.countDisplay}
                onPrev={() =>
                  setRecentBatchDetail({
                    runId: dashThermalDetail.runId,
                    fileIndex: Math.max(0, dashThermalDetail.safeIdxT - 1),
                  })
                }
                onNext={() =>
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
              (() => {
                const runId = recentBatchDetail.runId;
                const run = batchDetailRun;
                const isDjiThermal = Boolean(
                  (run as unknown as { thermal_analysis_job?: boolean })?.thermal_analysis_job
                );

                if (isDjiThermal) return null;

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
                const safeIdx = n === 0 ? 0 : Math.min(Math.max(0, recentBatchDetail.fileIndex), n - 1);
                const cur = files[safeIdx];
                const mainImg = cur ? resolveMediaSrc(cur.annotated_url || cur.thumb_url) : "";
                const videoSrc =
                  cur?.video_url && /\.mp4(\?|$)/i.test(cur.video_url)
                    ? resolveMediaSrc(cur.video_url)
                    : "";
                const totalFiles = (run as unknown as { total_files?: number })?.total_files ?? n;
                const completed = (run as unknown as { completed?: number })?.completed ?? totalFiles;
                const defectsFound =
                  run?.findings_count ??
                  (run as unknown as { total_defects?: number })?.total_defects ??
                  0;
                const avgPct = run ? confidencePct(run) : null;
                const created = run?.created_at ?? run?.timestamp;
                const dets = cur?.detections ?? [];
                const curDefects = fileDefectCount(cur ?? {}, isVideoJob);
                const curAvg = fileAvgConf(cur ?? {}, isVideoJob);
                const procMs = cur?.stats?.processing_time_ms;

                const setIdx = (i: number) => {
                  if (n <= 0) return;
                  setRecentBatchDetail({ runId, fileIndex: Math.max(0, Math.min(i, n - 1)) });
                };

                return (
                  <div
                    className="fixed inset-0 z-[100] flex items-stretch justify-center bg-black/95 text-white"
                    onClick={() => setRecentBatchDetail(null)}
                  >
                    <div
                      className="flex flex-col lg:flex-row w-full max-w-[1700px] h-full max-h-[100dvh] bg-[#0b0d12] border border-neutral-800 overflow-hidden shadow-2xl"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex-1 relative flex flex-col min-w-0 bg-black min-h-[40vh] lg:min-h-0">
                        <button
                          type="button"
                          onClick={() => setRecentBatchDetail(null)}
                          className="absolute top-3 right-3 z-20 rounded-lg bg-neutral-800/90 hover:bg-neutral-700 p-2 border border-neutral-600"
                          aria-label="Close"
                        >
                          <X size={20} />
                        </button>
                        {n > 0 && (
                          <>
                            {n > 1 && (
                              <button
                                type="button"
                                onClick={() => setIdx(safeIdx - 1)}
                                className="absolute left-2 top-1/2 -translate-y-1/2 z-10 rounded-full bg-neutral-900/85 hover:bg-neutral-800 p-2.5 border border-neutral-700"
                                aria-label="Previous file"
                              >
                                <ChevronLeft size={22} />
                              </button>
                            )}
                            {n > 1 && (
                              <button
                                type="button"
                                onClick={() => setIdx(safeIdx + 1)}
                                className={`absolute top-1/2 z-10 -translate-y-1/2 rounded-full border border-neutral-700 bg-neutral-900/85 p-2.5 hover:bg-neutral-800 ${
                                  videoSrc ? "right-2 lg:right-[236px]" : "right-2"
                                }`}
                                aria-label="Next file"
                              >
                                <ChevronRight size={22} />
                              </button>
                            )}
                            <div className="absolute top-3 left-3 z-10 rounded-md bg-black/70 px-2 py-1 text-xs font-mono text-neutral-300 border border-neutral-700">
                              {safeIdx + 1}/{n}
                            </div>
                            <div className="flex min-h-0 flex-1 flex-col pb-8 pt-14 lg:flex-row lg:items-stretch">
                              <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-6">
                                {videoSrc ? (
                                  <video
                                    ref={batchDetailVideoRef}
                                    key={videoSrc}
                                    src={videoSrc}
                                    controls
                                    playsInline
                                    className="max-h-[min(85vh,820px)] max-w-full rounded-lg border border-neutral-800"
                                  />
                                ) : mainImg ? (
                                  <img
                                    src={mainImg}
                                    alt={cur?.filename ?? ""}
                                    className="max-h-[min(85vh,820px)] max-w-full object-contain rounded-lg border border-neutral-800"
                                  />
                                ) : (
                                  <div className="text-neutral-500 text-sm">No preview</div>
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
                          <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm p-8">
                            No files in this batch
                          </div>
                        )}
                      </div>

                      <div className="w-full lg:w-[380px] shrink-0 border-t lg:border-t-0 lg:border-l border-neutral-800 bg-[#0f1419] flex flex-col max-h-[55vh] lg:max-h-[100dvh] overflow-hidden">
                        <div className="flex border-b border-neutral-800 shrink-0">
                          <button
                            type="button"
                            onClick={() => setBatchDetailTab("image")}
                            className={`flex-1 py-3 text-xs font-bold tracking-wide ${
                              batchDetailTab === "image"
                                ? "text-cyan-300 border-b-2 border-cyan-400 bg-cyan-500/10"
                                : "text-neutral-500 hover:text-neutral-300"
                            }`}
                          >
                            {isVideoJob ? "MEDIA" : "IMAGE"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setBatchDetailTab("processing")}
                            className={`flex-1 py-3 text-xs font-bold tracking-wide ${
                              batchDetailTab === "processing"
                                ? "text-cyan-300 border-b-2 border-cyan-400 bg-cyan-500/10"
                                : "text-neutral-500 hover:text-neutral-300"
                            }`}
                          >
                            PROCESSING
                          </button>
                        </div>

                        <div className="flex-1 overflow-y-auto min-h-0">
                          {batchDetailTab === "image" ? (
                            <div className="p-4 space-y-4">
                              <div>
                                <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
                                  ID
                                </div>
                                <div className="font-mono text-sm text-white break-all">{runId}</div>
                                <div className="text-xs text-neutral-400 mt-1">{shortAgo(created)}</div>
                              </div>

                              <div className="grid grid-cols-2 gap-2 text-center">
                                <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-2">
                                  <div className="text-[10px] text-neutral-500 uppercase">Total files</div>
                                  <div className="text-lg font-semibold text-white">{totalFiles}</div>
                                </div>
                                <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-2">
                                  <div className="text-[10px] text-neutral-500 uppercase">Completed</div>
                                  <div className="text-lg font-semibold text-emerald-400">{completed}</div>
                                </div>
                                <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-2">
                                  <div className="text-[10px] text-neutral-500 uppercase">Defects found</div>
                                  <div className="text-lg font-semibold text-red-400">{defectsFound}</div>
                                </div>
                                
                              </div>

                              {cur && (
                                <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3 space-y-1.5">
                                  <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase text-neutral-500">
                                    <span>Filename</span>
                                    {cur.source === "thermal" && (
                                      <span className="normal-case rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 px-1.5 py-0.5 text-[9px] font-semibold">
                                        Thermal
                                      </span>
                                    )}
                                    {isVideoJob && (
                                      <span className="normal-case rounded bg-violet-500/20 text-violet-300 border border-violet-500/40 px-1.5 py-0.5 text-[9px] font-semibold">
                                        Video
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-xs text-white font-medium break-all">{cur.filename}</div>
                                  <div className="flex flex-wrap gap-3 text-[11px] text-neutral-400 pt-1">
                                    <span>
                                      Defects:{" "}
                                      <span className="text-emerald-400 font-semibold">{curDefects}</span>
                                    </span>
                                    
                                    {procMs != null && (
                                      <span>
                                        Time:{" "}
                                        <span className="text-neutral-200">{Math.round(procMs)}ms</span>
                                      </span>
                                    )}
                                  </div>
                                </div>
                              )}

                              <div>
                                <div className="text-xs font-semibold text-white mb-2">
                                  All Files ({n})
                                </div>
                                <div className="flex flex-col gap-1.5 max-h-[200px] overflow-y-auto pr-1">
                                  {files.map((f, i) => {
                                    const thumb = resolveMediaSrc(f.thumb_url || f.annotated_url);
                                    const dc = fileDefectCount(f, isVideoJob);
                                    const sel = i === safeIdx;
                                    return (
                                      <button
                                        key={`${f.file_id ?? f.filename}-${i}`}
                                        type="button"
                                        onClick={() => setIdx(i)}
                                        className={`flex items-center gap-2 rounded-lg border p-2 text-left transition-colors ${
                                          sel
                                            ? "border-cyan-500/70 bg-cyan-500/10 ring-1 ring-cyan-500/30"
                                            : "border-neutral-800 bg-neutral-900/30 hover:border-neutral-600"
                                        }`}
                                      >
                                        <div className="relative w-11 h-11 shrink-0 rounded overflow-hidden bg-neutral-800">
                                          {thumb ? (
                                            <img src={thumb} alt="" className="w-full h-full object-cover" />
                                          ) : (
                                            <ImageIcon className="w-5 h-5 text-neutral-600 m-auto" />
                                          )}
                                          {isMp4Url(f.video_url ?? undefined) && (
                                            <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30">
                                              <Video className="w-4 h-4 text-white drop-shadow" aria-hidden />
                                            </span>
                                          )}
                                          {sel && (
                                            <span className="absolute bottom-0.5 right-0.5 bg-emerald-500 rounded-full p-0.5 z-[1]">
                                              <Check size={8} className="text-white" strokeWidth={3} />
                                            </span>
                                          )}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                          <div className="text-[10px] text-white truncate" title={f.filename}>
                                            {f.filename}
                                          </div>
                                          <div className="flex flex-wrap items-center gap-1.5">
                                            <span className="text-[10px] text-emerald-400 font-medium">
                                              {dc} defect{dc !== 1 ? "s" : ""}
                                            </span>
                                            {f.source === "thermal" && (
                                              <span className="text-[9px] text-amber-400 font-semibold uppercase">
                                                Thermal
                                              </span>
                                            )}
                                          </div>
                                        </div>
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>

                              {dets.length > 0 && (
                                <div>
                                  <div className="text-xs font-semibold text-white mb-2">
                                    Detections ({dets.length})
                                  </div>
                                  <div className="space-y-2">
                                    {dets.map((det, di) => {
                                      return (
                                        <div
                                          key={di}
                                          className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-2.5"
                                        >
                                          <div className="flex items-center justify-between gap-2">
                                            <span className="text-[11px] text-white font-medium truncate">
                                              {formatDetectionLabel(det.class_name)}
                                            </span>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="p-4 space-y-3 text-sm text-neutral-300">
                              <div className="text-xs font-semibold text-white uppercase tracking-wide">
                                Batch processing
                              </div>
                              <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3 space-y-2 text-xs">
                                <div className="flex justify-between">
                                  <span className="text-neutral-500">Status</span>
                                  <span className="text-white font-medium">
                                    {(run?.status ?? "—").toString().toUpperCase()}
                                  </span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-neutral-500">Job type</span>
                                  <span className="text-white">{isVideoJob ? "Video" : "Image"}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-neutral-500">Files completed</span>
                                  <span className="text-emerald-400">
                                    {completed} / {totalFiles}
                                  </span>
                                </div>
                                {isVideoJob && cur && (
                                  <>
                                    <div className="flex justify-between">
                                      <span className="text-neutral-500">Duration</span>
                                      <span className="text-white">{cur.duration ?? "—"}s</span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-neutral-500">FPS / Frames</span>
                                      <span className="text-white">
                                        {cur.fps ?? "—"} / {cur.frames_analyzed ?? "—"}
                                      </span>
                                    </div>
                                  </>
                                )}
                              </div>
                              <div className="text-[11px] text-neutral-500 leading-relaxed">
                                Per-file timings and pipeline stages appear here for traceability.
                              </div>
                            </div>
                          )}
                        </div>

                        <div className="shrink-0 border-t border-neutral-800 p-3">
                          <Link
                            to={`/runs/${runId}`}
                            className="flex items-center justify-center gap-2 w-full rounded-lg bg-cyan-500/20 text-cyan-300 border border-cyan-500/50 py-2 text-xs font-semibold hover:bg-cyan-500/30"
                            onClick={() => setRecentBatchDetail(null)}
                          >
                            Open full run page
                            <ChevronRight size={14} />
                          </Link>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}
          </motion.div>
        </>
      )}
    </motion.div>
  );
}
