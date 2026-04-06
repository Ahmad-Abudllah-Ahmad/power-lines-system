import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import JSZip from "jszip";
import {
  getRun,
  resolveArtifactUrl,
  listOverlays,
  overlayFileUrl,
  overlaysZipUrl,
  type RunDetail,
  type OverlayItem,
} from "../api/api";
import LoadingSpinner from "../components/LoadingSpinner";
import { toast } from "../components/Toast";
import {
  RGB_PREVIEW_ZOOM_MAX,
  RGB_PREVIEW_ZOOM_MIN,
  RGB_PREVIEW_ZOOM_STEP,
} from "../components/DetectionClassFilter";
import { formatDetectionLabel } from "../utils/formatLabels";
import {
  Download,
  FileText,
  AlertCircle,
  CheckCircle2,
  XCircle,
  ArrowLeft,
  Clock,
  MapPin,
  Flame,
  Archive,
  Image as ImageIcon,
  Search,
  X,
  Plus,
  Minus,
  ChevronLeft,
  ChevronRight,
  Edit,
} from "lucide-react";

// Severity/tag from overlay: use backend-provided tag/severity when present, else parse filename.
const SEVERITY_ORDER = ["broken", "missing_part", "pollution_flashover", "rust", "damage", "normal"];
const KNOWN_SEVERITIES = new Set(SEVERITY_ORDER);

function overlayTag(item: OverlayItem): string {
  if (item.tag) return item.tag;
  const token = item.filename.split("_")[0]?.toLowerCase() ?? "";
  return KNOWN_SEVERITIES.has(token) ? token : "unknown";
}

function overlaySeverity(item: OverlayItem): string {
  if (item.severity) return item.severity;
  return overlayTag(item);
}

function severityRank(s: string): number {
  const i = SEVERITY_ORDER.indexOf(s);
  return i >= 0 ? i : SEVERITY_ORDER.length;
}

/** Map tag or backend severity to HIGH | MEDIUM | LOW for counts (unknown → LOW, unclassified). */
function overlaySeverityForCount(item: OverlayItem): "HIGH" | "MEDIUM" | "LOW" {
  const s = (item.severity ?? "").toUpperCase();
  if (s === "HIGH" || s === "MEDIUM" || s === "LOW") return s;
  const tag = overlayTag(item);
  if (["broken", "missing_part", "pollution_flashover"].includes(tag)) return "HIGH";
  if (["rust", "damage"].includes(tag)) return "MEDIUM";
  return "LOW"; // normal, unknown, or unclassified
}

const GALLERY_STORAGE_KEY = "run_gallery_state";

function loadGalleryState(runIdOrParam: string): { severity: string; search: string; zoom: number } | null {
  try {
    const raw = localStorage.getItem(`${GALLERY_STORAGE_KEY}_${runIdOrParam}`);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return {
      severity: typeof o.severity === "string" ? o.severity : "",
      search: typeof o.search === "string" ? o.search : "",
      zoom: typeof o.zoom === "number" && o.zoom >= 0.25 && o.zoom <= 3 ? o.zoom : 1,
    };
  } catch {
    return null;
  }
}

function saveGalleryState(runIdOrParam: string, severity: string, search: string, zoom: number) {
  try {
    localStorage.setItem(
      `${GALLERY_STORAGE_KEY}_${runIdOrParam}`,
      JSON.stringify({ severity, search, zoom })
    );
  } catch {
    // ignore
  }
}

const VALID_SEVERITIES = new Set(["", "broken", "missing_part", "pollution_flashover", "rust", "damage", "normal", "unknown"]);
const URL_DEBOUNCE_MS = 300;

type Detection = {
  component_type?: string;
  bbox?: [number, number, number, number];
  det_conf?: number;
  defect_type?: string;
  defect_conf?: number;
  thermal_flag?: boolean;
  severity?: string;
  status?: string;
};

export default function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [reviewActions, setReviewActions] = useState<Record<number, "confirmed" | "false_positive" | "needs_review">>({});

  const handleReviewAction = (idx: number, action: "confirmed" | "false_positive" | "needs_review") => {
    setReviewActions((prev) => ({ ...prev, [idx]: action }));
  };
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState<"overlay" | "annotated" | "thermal">("overlay");
  const [exportingAll, setExportingAll] = useState(false);
  const [overlayList, setOverlayList] = useState<OverlayItem[]>([]);
  const [overlayFilterSeverity, setOverlayFilterSeverity] = useState<string>("");
  const [overlaySearchStem, setOverlaySearchStem] = useState("");
  const [fullSizeOverlay, setFullSizeOverlay] = useState<string | null>(null);
  const [modalZoom, setModalZoom] = useState(1);
  const urlSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Canonical key for gallery state: stable even if route param differs from run_id
  const keyId = run?.run_id ?? run?.id ?? id ?? "";
  const createdLabel = (run?.created_at ?? run?.timestamp ?? run?.metadata?.timestamp) ?? "";

  // Restore gallery state: URL params (if any) > localStorage(keyId) > defaults
  useEffect(() => {
    if (!keyId) return;
    const urlSeverity = searchParams.get("severity");
    const urlQ = searchParams.get("q");
    const urlZoom = searchParams.get("zoom");
    const hasUrlParams = urlSeverity !== null || urlQ !== null || urlZoom !== null;
    if (hasUrlParams) {
      if (urlSeverity !== null && VALID_SEVERITIES.has(urlSeverity)) {
        setOverlayFilterSeverity(urlSeverity);
      }
      if (urlQ !== null) {
        setOverlaySearchStem(urlQ);
      }
      if (urlZoom !== null) {
        const z = parseFloat(urlZoom);
        if (!Number.isNaN(z) && z >= 0.25 && z <= 3) {
          setModalZoom(z);
        }
      }
    } else {
      const saved = loadGalleryState(keyId);
      if (saved) {
        setOverlayFilterSeverity(saved.severity);
        setOverlaySearchStem(saved.search);
        setModalZoom(saved.zoom);
      }
    }
  }, [keyId, searchParams]);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    getRun(id)
      .then(setRun)
      .catch((e) => {
        const errorMessage = e.message || "Failed to load run details";
        setError(errorMessage);
        toast.error(errorMessage, 5000);
      })
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!id) return;
    listOverlays(id)
      .then(setOverlayList)
      .catch(() => setOverlayList([]));
  }, [id]);

  // Persist gallery state under canonical keyId; write to localStorage + URL (debounce q)
  useEffect(() => {
    if (!keyId) return;
    saveGalleryState(keyId, overlayFilterSeverity, overlaySearchStem, modalZoom);
    if (urlSyncTimerRef.current) clearTimeout(urlSyncTimerRef.current);
    urlSyncTimerRef.current = setTimeout(() => {
      urlSyncTimerRef.current = null;
      setSearchParams(
        {
          ...(overlayFilterSeverity && { severity: overlayFilterSeverity }),
          ...(overlaySearchStem && { q: overlaySearchStem }),
          ...(modalZoom !== 1 && { zoom: String(modalZoom) }),
        },
        { replace: true }
      );
    }, URL_DEBOUNCE_MS);
    return () => {
      if (urlSyncTimerRef.current) clearTimeout(urlSyncTimerRef.current);
    };
  }, [keyId, overlayFilterSeverity, overlaySearchStem, modalZoom, setSearchParams]);

  // All hooks must be called before any early returns (Rules of Hooks)
  // Overlay gallery: severity/tag from backend when present, else parse filename
  const overlaySeverities = useMemo(() => {
    const set = new Set<string>();
    overlayList.forEach((item) => set.add(overlayTag(item)));
    const ordered = Array.from(set).sort((a, b) => severityRank(a) - severityRank(b));
    return ["", ...ordered];
  }, [overlayList]);

  const filteredOverlays = useMemo(() => {
    const search = overlaySearchStem.trim().toLowerCase();
    const list = overlayList.filter((item) => {
      const tag = overlayTag(item);
      if (overlayFilterSeverity && tag !== overlayFilterSeverity) return false;
      if (search) {
        const stem = item.stem ?? item.filename;
        if (!stem.toLowerCase().includes(search) && !item.filename.toLowerCase().includes(search)) return false;
      }
      return true;
    });
    list.sort((a, b) => {
      const ra = severityRank(overlayTag(a));
      const rb = severityRank(overlayTag(b));
      return ra !== rb ? ra - rb : a.filename.localeCompare(b.filename);
    });
    return list;
  }, [overlayList, overlayFilterSeverity, overlaySearchStem]);

  const overlayCountsBySeverity = useMemo(() => {
    const counts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    overlayList.forEach((item) => {
      const s = overlaySeverityForCount(item);
      counts[s]++;
    });
    return counts;
  }, [overlayList]);

  // Severity counts from detections, derived from confidence so LOW confidence never counts as HIGH
  const detectionCountsBySeverity = useMemo(() => {
    const counts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    const runAny = run as Record<string, unknown>;
    const dets: Detection[] =
      Array.isArray(run?.detections) ? (run.detections as Detection[])
      : Array.isArray(runAny?.findings) ? (runAny.findings as Detection[])
      : Array.isArray(runAny?.results) ? (runAny.results as Detection[])
      : [];
    dets.forEach((d) => {
      const conf = Math.max(d.det_conf ?? 0, d.defect_conf ?? 0);
      const s: "HIGH" | "MEDIUM" | "LOW" = conf >= 0.7 ? "HIGH" : conf >= 0.4 ? "MEDIUM" : "LOW";
      counts[s]++;
    });
    return counts;
  }, [run]);

  // Modal keyboard: Esc close, Left/Right navigate
  const modalIndex = fullSizeOverlay ? filteredOverlays.findIndex((o) => o.filename === fullSizeOverlay) : -1;
  const modalTotal = filteredOverlays.length;
  useEffect(() => {
    if (!fullSizeOverlay || modalTotal === 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFullSizeOverlay(null);
        return;
      }
      if (e.key === "ArrowLeft") {
        const idx = filteredOverlays.findIndex((o) => o.filename === fullSizeOverlay);
        const nextIdx = idx <= 0 ? modalTotal - 1 : idx - 1;
        setFullSizeOverlay(filteredOverlays[nextIdx]?.filename ?? null);
      }
      if (e.key === "ArrowRight") {
        const idx = filteredOverlays.findIndex((o) => o.filename === fullSizeOverlay);
        const nextIdx = idx < 0 || idx >= modalTotal - 1 ? 0 : idx + 1;
        setFullSizeOverlay(filteredOverlays[nextIdx]?.filename ?? null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullSizeOverlay, filteredOverlays, modalTotal]);

  // Prefetch current + prev + next full-size images so arrow navigation feels instant
  const runIdForPrefetch = run?.run_id ?? run?.id ?? id ?? "";
  useEffect(() => {
    if (!fullSizeOverlay || !runIdForPrefetch || filteredOverlays.length === 0) return;
    const idx = filteredOverlays.findIndex((o) => o.filename === fullSizeOverlay);
    if (idx < 0) return; // fullSizeOverlay not in current filtered list, skip prefetch
    const prevIdx = idx <= 0 ? filteredOverlays.length - 1 : idx - 1;
    const nextIdx = idx >= filteredOverlays.length - 1 ? 0 : idx + 1;
    const toPreload = [
      fullSizeOverlay,
      filteredOverlays[prevIdx]?.filename,
      filteredOverlays[nextIdx]?.filename,
    ].filter(Boolean) as string[];
    toPreload.forEach((filename) => {
      const img = new Image();
      img.src = overlayFileUrl(runIdForPrefetch, filename);
    });
  }, [fullSizeOverlay, runIdForPrefetch, filteredOverlays]);

  // Early returns after all hooks
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <LoadingSpinner size="lg" text="Loading run details..." />
      </div>
    );
  }

  if (error || !run) {
    return (
      <div className="glass rounded-2xl border border-premium-danger/50 p-6 text-premium-danger shadow-premium">
        <div className="font-semibold mb-2">Error Loading Run</div>
        <div className="text-sm mb-4">{error || "Run not found"}</div>
        <Link
          to="/runs"
          className="inline-flex items-center gap-2 rounded-xl bg-premium-accent text-white px-4 py-2 text-sm font-semibold hover:bg-premium-accent/80 transition-colors"
        >
          <ArrowLeft className="text-sm" />
          Back to Runs
        </Link>
      </div>
    );
  }

  const runId = run.run_id || run.id;

  // Legacy-safe: backend may use detections, findings, or results; normalise once
  const runAny = run as Record<string, unknown>;
  const detections: Detection[] =
    Array.isArray(run?.detections) ? (run.detections as Detection[])
    : Array.isArray(runAny?.findings) ? (runAny.findings as Detection[])
    : Array.isArray(runAny?.results) ? (runAny.results as Detection[])
    : [];

  // Legacy-safe: backend may omit artifacts; default to empty object
  const artifacts = run?.artifacts ?? {};

  const needsReview = detections.filter((d: Detection, idx: number) => {
    const actionStatus = reviewActions[idx] || d.status;
    return actionStatus === "needs_review" || (d.det_conf ?? 0) < 0.7 || (d.defect_conf != null && d.defect_conf < 0.7);
  });
  const confirmed = detections.filter((d: Detection, idx: number) => {
    const actionStatus = reviewActions[idx] || d.status;
    return actionStatus === "confirmed";
  });
  const falsePositives = detections.filter((d: Detection, idx: number) => {
    const actionStatus = reviewActions[idx] || d.status;
    return actionStatus === "false_positive";
  });

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "HIGH":
        return "text-red-400 bg-red-500/20 border-red-500/50";
      case "MEDIUM":
        return "text-yellow-400 bg-yellow-500/20 border-yellow-500/50";
      case "LOW":
        return "text-green-400 bg-green-500/20 border-green-500/50";
      default:
        return "dash-text-muted bg-[var(--dash-nested-bg-soft)] border-[var(--dash-panel-border)]";
    }
  };

  /** Severity for display: derived from confidence so we never show HIGH when model confidence is low. */
  const displaySeverity = (d: Detection): "HIGH" | "MEDIUM" | "LOW" => {
    const conf = Math.max(d.det_conf ?? 0, d.defect_conf ?? 0);
    if (conf >= 0.7) return "HIGH";
    if (conf >= 0.4) return "MEDIUM";
    return "LOW";
  };

  const exportToJSON = () => {
    const data = {
      run_id: runId,
      tower_id: run.tower_id,
      status: run.status,
      created_at: createdLabel || undefined,
      completed_at: run.completed_at,
      findings_count: run.findings_count,
      ai_confidence: run.ai_confidence,
      detections,
      artifacts: artifacts,
      metadata: run.metadata,
    };
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `run_${runId}_${new Date().toISOString().split("T")[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Run data exported to JSON", 3000);
  };

  const hasAnyArtifact =
    (artifacts.report_url || artifacts.report_path) ||
    (artifacts.overlay_url || artifacts.overlay_path) ||
    (artifacts.annotated_url || artifacts.annotated_image) ||
    (artifacts.thermal_url || artifacts.thermal_overlay);

  const handleExportAll = async () => {
    setExportingAll(true);
    try {
      const zip = new JSZip();
      zip.file(
        "run.json",
        JSON.stringify(
          {
            run_id: runId,
            id: run.id,
            tower_id: run.tower_id,
            status: run.status,
            created_at: createdLabel || undefined,
            completed_at: run.completed_at,
            findings_count: run.findings_count,
            ai_confidence: run.ai_confidence,
            detections,
            artifacts: artifacts,
            metadata: run.metadata,
          },
          null,
          2
        )
      );
      const types: Array<"report" | "overlay" | "annotated" | "thermal"> = ["report", "overlay", "annotated", "thermal"];
      const names: Record<string, string> = { report: "report.pdf", overlay: "overlay.png", annotated: "annotated.png", thermal: "thermal.png" };
      for (const t of types) {
        const url = resolveArtifactUrl(artifacts, runId, t);
        if (!url) continue;
        const res = await fetch(url, { credentials: "omit" });
        if (!res.ok) continue;
        const blob = await res.blob();
        zip.file(names[t], blob);
      }
      const outBlob = await zip.generateAsync({ type: "blob" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(outBlob);
      a.download = `run_${runId}_export_${new Date().toISOString().split("T")[0]}.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success("Export all downloaded (run.json + report + overlays)", 4000);
    } catch (e) {
      console.error("Export all failed:", e);
      toast.error("Export all failed. Check console and CORS/network.", 5000);
    } finally {
      setExportingAll(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            to="/runs"
            className="inline-flex items-center gap-2 text-sm text-premium-accent hover:text-premium-accent-light mb-4"
          >
            <ArrowLeft className="text-sm" />
            Back to Runs
          </Link>
          <h1 className="text-3xl font-bold dash-text-primary mb-2">Run Details</h1>
          <div className="flex items-center gap-3 text-sm dash-text-muted">
            <span className="font-Poppins">{runId}</span>
            {run.tower_id && (
              <>
                <span>•</span>
                <span>Tower: {run.tower_id}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={exportToJSON}
            className="rounded-xl glass border border-[var(--dash-panel-border)] dash-text-primary px-4 py-2 text-sm font-semibold hover:bg-premium-card-hover transition-colors flex items-center gap-2"
          >
            <Download className="text-lg" />
            Export JSON
          </button>
          {(artifacts.report_url || artifacts.report_path) && (
            <a
              href={resolveArtifactUrl(artifacts, runId, "report")!}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-xl bg-gradient-accent text-white px-4 py-2 text-sm font-semibold hover:shadow-glow transition-all flex items-center gap-2"
            >
              <FileText className="text-lg" />
              Download PDF
            </a>
          )}
          {hasAnyArtifact && (
            <button
              onClick={handleExportAll}
              disabled={exportingAll}
              className="rounded-xl bg-premium-accent/20 border border-premium-accent/50 text-premium-accent px-4 py-2 text-sm font-semibold hover:bg-premium-accent/30 transition-colors flex items-center gap-2 disabled:opacity-50"
            >
              <Archive className="text-lg" />
              {exportingAll ? "Exporting…" : "Export all (ZIP)"}
            </button>
          )}
        </div>
      </div>

      {/* Status Card */}
      <div className="glass rounded-2xl border border-[var(--dash-panel-border)] p-6 shadow-premium">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <div className="text-xs dash-text-muted uppercase tracking-wider mb-2">Status</div>
            <div className="flex items-center gap-2">
              {run.status === "completed" ? (
                <CheckCircle2 className="text-green-400 text-xl" />
              ) : run.status === "failed" ? (
                <XCircle className="text-red-400 text-xl" />
              ) : (
                <Clock className="text-yellow-400 text-xl" />
              )}
              <span className="text-lg font-semibold dash-text-primary capitalize">{run.status}</span>
            </div>
          </div>
          <div>
            <div className="text-xs dash-text-muted uppercase tracking-wider mb-2">Findings</div>
            <div className="text-2xl font-bold dash-text-primary">{run.findings_count || 0}</div>
          </div>
          <div>
            <div className="text-xs dash-text-muted uppercase tracking-wider mb-2">AI Confidence</div>
            <div className="text-2xl font-bold dash-text-primary">
              {run.ai_confidence ? `${Math.round(run.ai_confidence * 100)}%` : "—"}
            </div>
          </div>
          <div>
            <div className="text-xs dash-text-muted uppercase tracking-wider mb-2">Created</div>
            <div className="text-sm dash-text-primary">{createdLabel ? new Date(createdLabel).toLocaleString() : "—"}</div>
          </div>
        </div>
      </div>

      {/* Overlays Gallery – uses artifact URLs from backend (overlay_url, report_url, etc.) */}
      {(artifacts.overlay_url || artifacts.overlay_path || artifacts.annotated_url || artifacts.annotated_image || artifacts.thermal_url || artifacts.thermal_overlay) && (
        <div className="glass rounded-2xl border border-[var(--dash-panel-border)] p-6 shadow-premium">
          <h2 className="text-xl font-semibold dash-text-primary mb-4">Image Overlays</h2>
          <div className="mb-4 flex gap-2">
            {(artifacts.overlay_url || artifacts.overlay_path) && (
              <button
                onClick={() => setSelectedImage("overlay")}
                className={`rounded-xl px-4 py-2 text-sm font-semibold border transition-all ${
                  selectedImage === "overlay"
                    ? "bg-gradient-accent text-white border-premium-accent shadow-glow"
                    : "glass border-[var(--dash-panel-border)] dash-text-body hover:bg-premium-card-hover"
                }`}
              >
                Detection Overlay
              </button>
            )}
            {(artifacts.annotated_url || artifacts.annotated_image) && (
              <button
                onClick={() => setSelectedImage("annotated")}
                className={`rounded-xl px-4 py-2 text-sm font-semibold border transition-all ${
                  selectedImage === "annotated"
                    ? "bg-gradient-accent text-white border-premium-accent shadow-glow"
                    : "glass border-[var(--dash-panel-border)] dash-text-body hover:bg-premium-card-hover"
                }`}
              >
                Annotated Image
              </button>
            )}
            {(artifacts.thermal_url || artifacts.thermal_overlay) && (
              <button
                onClick={() => setSelectedImage("thermal")}
                className={`rounded-xl px-4 py-2 text-sm font-semibold border transition-all ${
                  selectedImage === "thermal"
                    ? "bg-gradient-accent text-white border-premium-accent shadow-glow"
                    : "glass border-[var(--dash-panel-border)] dash-text-body hover:bg-premium-card-hover"
                }`}
              >
                Thermal Overlay
              </button>
            )}
          </div>
          <div className="rounded-lg overflow-hidden border border-[var(--dash-panel-border)] flex items-center justify-center min-h-0" style={{ backgroundColor: "var(--dash-nested-bg)" }}>
            <img
              src={
                resolveArtifactUrl(artifacts, runId, selectedImage) ?? ""
              }
              alt={`${selectedImage} overlay`}
              className="max-w-full max-h-[600px] w-auto h-auto object-contain"
            />
          </div>
          {selectedImage === "thermal" && run?.metadata?.thermal_insights && (
            <div className="mt-4 p-4 rounded-xl glass border border-premium-accent/30 bg-premium-accent/5">
              <h3 className="text-sm font-semibold text-premium-accent uppercase tracking-wider mb-3 flex items-center gap-2">
                <Flame size={16} />
                Thermal Insights (from R-JPEG)
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {run.metadata.thermal_insights.temp_min != null && (
                  <div>
                    <div className="text-xs dash-text-muted">Min temp</div>
                    <div className="text-lg font-bold dash-text-primary">{run.metadata.thermal_insights.temp_min.toFixed(1)} °C</div>
                  </div>
                )}
                {run.metadata.thermal_insights.temp_max != null && (
                  <div>
                    <div className="text-xs dash-text-muted">Max temp</div>
                    <div className="text-lg font-bold text-orange-400">{run.metadata.thermal_insights.temp_max.toFixed(1)} °C</div>
                  </div>
                )}
                {run.metadata.thermal_insights.temp_mean != null && (
                  <div>
                    <div className="text-xs dash-text-muted">Mean temp</div>
                    <div className="text-lg font-bold dash-text-primary">{run.metadata.thermal_insights.temp_mean.toFixed(1)} °C</div>
                  </div>
                )}
              </div>
              {run.metadata.thermal_insights.roi_analysis && (
                <div className="mt-3 pt-3 border-t border-[var(--dash-panel-border)] grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  {run.metadata.thermal_insights.roi_analysis.Tp_max != null && (
                    <div><span className="dash-text-muted">Part max:</span> <span className="dash-text-primary font-medium">{run.metadata.thermal_insights.roi_analysis.Tp_max.toFixed(1)} °C</span></div>
                  )}
                  {run.metadata.thermal_insights.roi_analysis.Tw_max != null && (
                    <div><span className="dash-text-muted">Wire max:</span> <span className="dash-text-primary font-medium">{run.metadata.thermal_insights.roi_analysis.Tw_max.toFixed(1)} °C</span></div>
                  )}
                  {run.metadata.thermal_insights.roi_analysis.dT != null && (
                    <div><span className="dash-text-muted">ΔT:</span> <span className="text-orange-400 font-medium">{run.metadata.thermal_insights.roi_analysis.dT.toFixed(1)} °C</span></div>
                  )}
                  {run.metadata.thermal_insights.roi_analysis.severity && (
                    <div><span className="dash-text-muted">Severity:</span> <span className="font-semibold text-amber-400">{run.metadata.thermal_insights.roi_analysis.severity}</span></div>
                  )}
                </div>
              )}
              {run.metadata.thermal_insights.temp_min == null && run.metadata.thermal_insights.temp_max == null && run.metadata.thermal_insights.raw_output && (
                <div className="mt-3 pt-3 border-t border-[var(--dash-panel-border)]">
                  <div className="text-xs text-amber-400 font-semibold mb-1">Analysis output (temps could not be parsed):</div>
                  <pre className="text-xs dash-text-muted p-3 rounded-lg overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap font-Poppins" style={{ backgroundColor: "var(--dash-nested-bg)" }}>
                    {run.metadata.thermal_insights.raw_output.trim() || "(empty)"}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Overlay gallery: many overlays per run (list + stream + Download all) */}
      {overlayList.length > 0 && (
        <div className="glass rounded-2xl border border-[var(--dash-panel-border)] p-6 shadow-premium">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
            <h2 className="text-xl font-semibold dash-text-primary flex items-center gap-2">
              <ImageIcon className="text-2xl text-premium-accent" />
              Overlay Gallery ({filteredOverlays.length}{overlayList.length !== filteredOverlays.length ? ` of ${overlayList.length}` : ""})
            </h2>
            <a
              href={overlaysZipUrl(runId)}
              download={`overlays_${runId}.zip`}
              className="inline-flex items-center gap-2 rounded-xl bg-premium-accent text-white px-4 py-2 text-sm font-semibold hover:bg-premium-accent/80 transition-colors"
            >
              <Download className="text-lg" />
              Download all overlays
            </a>
          </div>
          {/* Severity counts: prefer detections (accurate) over overlay filenames */}
          <div className="flex flex-wrap items-center gap-4 mb-4 px-3 py-2 rounded-lg border border-[var(--dash-panel-border)]" style={{ backgroundColor: "var(--dash-nested-bg)" }}>
            <span className="text-sm dash-text-muted">By severity:</span>
            <span className="text-sm font-semibold text-red-400">HIGH: {detectionCountsBySeverity.HIGH}</span>
            <span className="text-sm font-semibold text-yellow-400">MEDIUM: {detectionCountsBySeverity.MEDIUM}</span>
            <span className="text-sm font-semibold text-green-400">LOW: {detectionCountsBySeverity.LOW}</span>
          </div>
          <div className="flex flex-wrap gap-3 mb-4">
            <div className="flex items-center gap-2">
              <label className="text-sm dash-text-muted">Severity</label>
              <select
                value={overlayFilterSeverity}
                onChange={(e) => setOverlayFilterSeverity(e.target.value)}
                className="rounded-lg glass border border-[var(--dash-panel-border)] dash-text-primary px-3 py-2 text-sm focus:ring-2 focus:ring-premium-accent outline-none"
                style={{ backgroundColor: "var(--dash-nested-bg)" }}
              >
                <option value="">All</option>
                {overlaySeverities.filter(Boolean).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2 flex-1 min-w-[200px] max-w-sm">
              <Search className="dash-text-muted text-lg shrink-0" />
              <input
                type="text"
                placeholder="Search by image stem (e.g. DJI_0437)"
                value={overlaySearchStem}
                onChange={(e) => setOverlaySearchStem(e.target.value)}
                className="w-full rounded-lg glass border border-[var(--dash-panel-border)] dash-text-primary px-3 py-2 text-sm placeholder-neutral-500 focus:ring-2 focus:ring-premium-accent outline-none"
                style={{ backgroundColor: "var(--dash-nested-bg)" }}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {filteredOverlays.map((item) => {
              const sev = overlayTag(item);
              const badgeClass =
                sev === "broken" || sev === "missing_part" || sev === "pollution_flashover"
                  ? "bg-red-500/20 text-red-400 border-red-500/50"
                  : sev === "rust" || sev === "damage"
                  ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/50"
                  : sev === "normal"
                  ? "bg-green-500/20 text-green-400 border-green-500/50"
                  : "bg-[var(--dash-nested-bg-soft)] dash-text-muted border-[var(--dash-panel-border)]";
              return (
                <button
                  key={item.filename}
                  type="button"
                  onClick={() => setFullSizeOverlay(item.filename)}
                  className="rounded-lg overflow-hidden border border-[var(--dash-panel-border)] hover:border-premium-accent/50 hover:shadow-glow transition-all text-left group"
                  style={{ backgroundColor: "var(--dash-nested-bg)" }}
                >
                  <div className="aspect-video flex items-center justify-center relative" style={{ backgroundColor: "var(--dash-inset-bg)" }}>
                    <img
                      src={overlayFileUrl(runId, item.filename)}
                      alt={item.filename}
                      className="w-full h-full object-contain group-hover:scale-105 transition-transform"
                    />
                    <span className={`absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded text-[10px] font-semibold border ${badgeClass}`}>
                      {sev}
                    </span>
                  </div>
                  <div className="px-2 py-1.5 text-xs dash-text-muted truncate" title={item.filename}>
                    {item.filename}
                  </div>
                </button>
              );
            })}
          </div>
          {filteredOverlays.length === 0 && (
            <div className="text-center py-8 dash-text-muted">No overlays match the current filters.</div>
          )}
        </div>
      )}

      {/* Full-size overlay modal: Esc close, arrows nav, badge, zoom */}
      {fullSizeOverlay && modalTotal > 0 && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--dash-overlay-scrim)] p-4"
          onClick={() => setFullSizeOverlay(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Overlay full size"
        >
          <button
            type="button"
            onClick={() => setFullSizeOverlay(null)}
            className="absolute top-4 right-4 rounded-full dash-text-primary p-2 hover:bg-[var(--dash-hover-bg)] transition-colors z-10"
            style={{ backgroundColor: "var(--dash-elevated-bg)" }}
            aria-label="Close"
          >
            <X className="text-2xl" />
          </button>

          {modalTotal > 1 && (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  const idx = filteredOverlays.findIndex((o) => o.filename === fullSizeOverlay);
                  const nextIdx = idx <= 0 ? modalTotal - 1 : idx - 1;
                  setFullSizeOverlay(filteredOverlays[nextIdx].filename);
                }}
                className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full dash-text-primary p-2 hover:bg-[var(--dash-hover-bg)] transition-colors z-10"
                style={{ backgroundColor: "var(--dash-elevated-bg)" }}
                aria-label="Previous overlay"
              >
                <ChevronLeft className="text-2xl" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  const idx = filteredOverlays.findIndex((o) => o.filename === fullSizeOverlay);
                  const nextIdx = idx < 0 || idx >= modalTotal - 1 ? 0 : idx + 1;
                  setFullSizeOverlay(filteredOverlays[nextIdx].filename);
                }}
                className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full dash-text-primary p-2 hover:bg-[var(--dash-hover-bg)] transition-colors z-10"
                style={{ backgroundColor: "var(--dash-elevated-bg)" }}
                aria-label="Next overlay"
              >
                <ChevronRight className="text-2xl" />
              </button>
            </>
          )}

          <div className="absolute top-4 left-4 z-10 flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
            <span className="rounded-lg border border-neutral-600 px-3 py-1.5 text-sm font-medium dash-text-primary" style={{ backgroundColor: "var(--dash-elevated-bg)" }}>
              {overlayTag(filteredOverlays.find((o) => o.filename === fullSizeOverlay) ?? { filename: fullSizeOverlay, url: "" })} • {modalIndex + 1}/{modalTotal}
            </span>
            <span className="flex items-center gap-1 rounded-lg border border-neutral-600" style={{ backgroundColor: "var(--dash-elevated-bg)" }}>
              <button
                type="button"
                onClick={() =>
                  setModalZoom((z) => Math.max(RGB_PREVIEW_ZOOM_MIN, z - RGB_PREVIEW_ZOOM_STEP))
                }
                className="p-1.5 dash-text-primary hover:bg-[var(--dash-hover-bg)] rounded-l-md"
                aria-label="Zoom out"
              >
                <Minus className="text-lg" />
              </button>
              <span className="px-2 text-sm dash-text-body min-w-[3rem] text-center">{Math.round(modalZoom * 100)}%</span>
              <button
                type="button"
                onClick={() =>
                  setModalZoom((z) => Math.min(RGB_PREVIEW_ZOOM_MAX, z + RGB_PREVIEW_ZOOM_STEP))
                }
                className="p-1.5 dash-text-primary hover:bg-[var(--dash-hover-bg)] rounded-r-md"
                aria-label="Zoom in"
              >
                <Plus className="text-lg" />
              </button>
            </span>
          </div>

          <div
            className="flex items-center justify-center overflow-auto scrollbar-gutter-stable max-w-full max-h-[90vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={overlayFileUrl(runId, fullSizeOverlay)}
              alt={fullSizeOverlay}
              className="rounded-lg shadow-2xl object-contain transition-[transform] duration-150 ease-out origin-center"
              style={{ transform: `scale(${modalZoom})` }}
              draggable={false}
            />
          </div>
        </div>
      )}

      {/* Needs Review Section */}
      {needsReview.length > 0 && (
        <div className="glass rounded-2xl border border-yellow-500/50 bg-yellow-500/10 p-6 shadow-premium">
          <div className="flex items-center gap-3 mb-4">
            <AlertCircle className="text-2xl text-yellow-400" />
            <h2 className="text-xl font-semibold dash-text-primary">Needs Review ({needsReview.length})</h2>
          </div>
          <div className="text-sm dash-text-body mb-4">
            The following detections have low confidence or require manual review:
          </div>
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {needsReview.map((detection: Detection, idx: number) => (
              <div
                key={idx}
                className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3 text-sm"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold dash-text-primary">
                    {detection.component_type} - {detection.defect_type || "Detection"}
                  </span>
                  <span className={`px-2 py-1 rounded text-xs font-semibold border ${getSeverityColor(displaySeverity(detection))}`}>
                    {displaySeverity(detection)}
                  </span>
                </div>
                <div className="text-xs dash-text-muted">
                  Confidence: {Math.round((detection.det_conf || 0) * 100)}%
                  {detection.defect_conf && ` • Defect: ${Math.round(detection.defect_conf * 100)}%`}
                  {detection.thermal_flag && (
                    <span className="ml-2 text-yellow-400 flex items-center gap-1 inline-flex">
                      <Flame className="text-xs" />
                      Thermal
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Detections Table */}
      <div className="glass rounded-2xl border border-[var(--dash-panel-border)] p-6 shadow-premium">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold dash-text-primary">All Detections ({detections.length})</h2>
          <div className="flex gap-2 text-xs dash-text-muted">
            <span className="text-green-400">✓ Confirmed: {confirmed.length}</span>
            <span className="text-yellow-400">⚠ Review: {needsReview.length}</span>
            <span className="dash-text-muted">✗ False Positive: {falsePositives.length}</span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-premium-card/50 dash-text-body">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">Component</th>
                <th className="text-left px-4 py-3 font-semibold">Defect</th>
                <th className="text-left px-4 py-3 font-semibold">Confidence</th>
                <th className="text-left px-4 py-3 font-semibold">Severity</th>
                <th className="text-left px-4 py-3 font-semibold">Status</th>
                <th className="text-left px-4 py-3 font-semibold">Thermal</th>
                <th className="text-left px-4 py-3 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--dash-panel-border)]">
              {detections.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center dash-text-muted">
                    No detections found
                  </td>
                </tr>
              ) : (
                detections.map((detection: Detection, idx: number) => {
                  const actionStatus = reviewActions[idx] || detection.status;
                  return (
                    <tr key={idx} className="hover:bg-premium-card-hover/50 transition-colors">
                      <td className="px-4 py-3 dash-text-primary font-medium">{formatDetectionLabel(detection.component_type ?? "Unknown")}</td>
                      <td className="px-4 py-3 dash-text-body">{formatDetectionLabel(detection.defect_type ?? "") || "—"}</td>
                      <td className="px-4 py-3 dash-text-body">
                        {Math.round((detection.det_conf || 0) * 100)}%
                        {detection.defect_conf && ` / ${Math.round(detection.defect_conf * 100)}%`}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-1 rounded text-xs font-semibold border ${getSeverityColor(displaySeverity(detection))}`}>
                          {displaySeverity(detection)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`px-2 py-1 rounded text-xs font-semibold ${
                            actionStatus === "confirmed"
                              ? "bg-green-500/20 text-green-400 border border-green-500/50"
                              : actionStatus === "needs_review"
                              ? "bg-yellow-500/20 text-yellow-400 border border-yellow-500/50"
                              : "bg-[var(--dash-nested-bg-soft)] dash-text-muted border border-[var(--dash-panel-border)]"
                          }`}
                        >
                          {(actionStatus ?? "needs_review").replace("_", " ").toUpperCase()}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {detection.thermal_flag ? (
                          <span className="text-yellow-400 flex items-center gap-1">
                            <Flame className="text-sm" />
                            Yes
                          </span>
                        ) : (
                          <span className="dash-text-subtle">No</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleReviewAction(idx, "confirmed")}
                            className={`px-2 py-1 rounded text-xs font-semibold transition-colors ${
                              actionStatus === "confirmed"
                                ? "bg-green-500/30 text-green-300 border border-green-500/50"
                                : "bg-green-500/10 text-green-400 border border-green-500/30 hover:bg-green-500/20"
                            }`}
                            title="Approve / Confirm"
                          >
                            <CheckCircle2 size={14} />
                          </button>
                          <button
                            onClick={() => handleReviewAction(idx, "false_positive")}
                            className={`px-2 py-1 rounded text-xs font-semibold transition-colors ${
                              actionStatus === "false_positive"
                                ? "bg-red-500/30 text-red-300 border border-red-500/50"
                                : "bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20"
                            }`}
                            title="Reject / False Positive"
                          >
                            <XCircle size={14} />
                          </button>
                          <button
                            onClick={() => handleReviewAction(idx, "needs_review")}
                            className={`px-2 py-1 rounded text-xs font-semibold transition-colors ${
                              actionStatus === "needs_review"
                                ? "bg-yellow-500/30 text-yellow-300 border border-yellow-500/50"
                                : "bg-yellow-500/10 text-yellow-400 border border-yellow-500/30 hover:bg-yellow-500/20"
                            }`}
                            title="Mark for Review"
                          >
                            <AlertCircle size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Metadata */}
      {run.metadata && (
        <div className="glass rounded-2xl border border-[var(--dash-panel-border)] p-6 shadow-premium">
          <h2 className="text-xl font-semibold dash-text-primary mb-4">Metadata</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            {run.metadata.gps && (
              <div>
                <div className="dash-text-muted mb-1">Location</div>
                <div className="dash-text-primary flex items-center gap-2">
                  <MapPin className="text-lg" />
                  {run.metadata.gps.lat.toFixed(6)}, {run.metadata.gps.lng.toFixed(6)}
                </div>
              </div>
            )}
            <div>
              <div className="dash-text-muted mb-1">Timestamp</div>
              <div className="dash-text-primary">
                {(run.metadata.timestamp ?? createdLabel)
                  ? new Date(run.metadata.timestamp ?? createdLabel).toLocaleString()
                  : "—"}
              </div>
            </div>
            {run.metadata.phase && (
              <div>
                <div className="dash-text-muted mb-1">Phase</div>
                <div className="dash-text-primary">{run.metadata.phase}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
