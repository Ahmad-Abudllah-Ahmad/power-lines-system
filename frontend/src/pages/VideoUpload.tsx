import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { toast } from "../components/Toast";
import MediaUploadBox from "../components/MediaUploadBox";
import UploadPipelineStrip from "../components/UploadPipelineStrip";
import {
  Video,
  X,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  ArrowLeft,
  Trash2,
  Layers,
  Play,
  Upload,
} from "lucide-react";
import { io, type Socket } from "socket.io-client";
import { VideoAnnotatedFrameStrip } from "../components/VideoAnnotatedFrameStrip";
import { DetectionSidebarBucketPanels } from "../components/DetectionSidebarBucketPanels";
import {
  partitionDetectionsSidebarBuckets,
  previewDetectionRowsForFile,
  uniqueDefectTypeCount,
} from "../utils/detectionSidebarBuckets";
import {
  type DetectionRowLike,
  DetectionClassFilterDropdown,
  useDetectionClassFilterForRows,
} from "../components/DetectionClassFilter";

const POLL_MS = 3000;

type VideoCard = {
  localId: string;
  fileId?: string;
  filename: string;
  localPreview?: string;
  status: "pending" | "uploading" | "queued" | "processing" | "complete" | "error";
  progress: number;
  progressLabel: string;
  thumbUrl?: string;
  videoUrl?: string;
  totalDetections: number;
  framesAnalyzed: number;
  duration: number;
  fps: number;
  avgConfidence: number;
  maxConfidence: number;
  /** Per-box list from server when present. */
  detections?: any[];
  error?: string;
};

type LocalVideo = {
  id: string;
  file: File;
  preview: string;
};

let _vid = 0;
const uid = () => `v_${++_vid}_${Date.now()}`;

function videoResultsFolderId(c: Pick<VideoCard, "fileId" | "videoUrl">): string | null {
  if (c.fileId) return c.fileId;
  const u = c.videoUrl?.trim() || "";
  const m = u.match(/\/results\/([^/]+)\//);
  return m?.[1] ?? null;
}

function timeAgoJob(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "—";
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString();
}

type ModelInfo = { id: string; title: string; path: string; description: string };

export type VideoUploadProps = { embedded?: boolean };

export default function VideoUpload({ embedded = false }: VideoUploadProps) {
  const [localVideos, setLocalVideos] = useState<LocalVideo[]>([]);
  const [cards, setCards] = useState<Map<string, VideoCard>>(new Map());
  const [jobId, setJobId] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ completed: 0, total: 0 });
  const [config, setConfig] = useState({ confidence: 0.25, sliceSize: 640, overlap: 0.2, frameInterval: 1 });
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [jobCreatedAt, setJobCreatedAt] = useState<number | null>(null);
  const [videoFetchedDetections, setVideoFetchedDetections] = useState<any[]>([]);
  const [videoDetectionsLoading, setVideoDetectionsLoading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const DEFAULT_MODELS: ModelInfo[] = [
    {
      id: "tl_defect_industrial",
      title: "TL Defect Industrial",
      path: "",
      description: "tl_defect_industrial 55.5h · weights/best.pt",
    },
  ];
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>(DEFAULT_MODELS);
  const [selectedModel, setSelectedModel] = useState<string>("tl_defect_industrial");

  const socketRef = useRef<Socket | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const nameToKeyRef = useRef<Map<string, string>>(new Map());
  const cancelRequestedRef = useRef(false);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);

  const totalVideos = localVideos.length;
  const canStart = totalVideos > 0 && !processing;

  useEffect(() => { jobIdRef.current = jobId; }, [jobId]);
  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  useEffect(() => {
    fetch("/api/models")
      .then(r => r.json())
      .then(data => {
        const fromApi = Array.isArray(data.models)
          ? data.models.filter((m: ModelInfo) => m?.id).map((m: ModelInfo) => ({
              id: m.id,
              title: m.title ?? m.id,
              path: m.path ?? "",
              description: m.description ?? "",
            }))
          : [];
        const models = fromApi.length > 0 ? fromApi : DEFAULT_MODELS;
        setAvailableModels(models);
        const active = data.active ?? data.active_model_id;
        if (active && models.some((m: ModelInfo) => m.id === active)) {
          setSelectedModel(active);
        } else if (models.length) {
          setSelectedModel(models[0].id);
        }
      })
      .catch(() => {});
  }, []);

  const updateCard = useCallback((key: string, patch: Partial<VideoCard>) => {
    setCards(prev => {
      const existing = prev.get(key);
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(key, { ...existing, ...patch });
      return next;
    });
  }, []);

  const uploadToActiveJob = useCallback(async (vids: LocalVideo[]) => {
    const activeJobId = jobIdRef.current;
    if (!activeJobId) return;

    for (const lv of vids) {
      const cardData: VideoCard = {
        localId: lv.id, filename: lv.file.name, localPreview: lv.preview,
        status: "uploading", progress: 0, progressLabel: "Uploading...",
        totalDetections: 0, framesAnalyzed: 0, duration: 0, fps: 0,
        avgConfidence: 0, maxConfidence: 0,
      };
      setCards(prev => { const n = new Map(prev); n.set(lv.id, cardData); return n; });
      nameToKeyRef.current.set(lv.file.name, lv.id);

      const formData = new FormData();
      formData.append("job_id", activeJobId);
      formData.append("file", lv.file);
      try {
        const res = await fetch("/api/video/upload", { method: "POST", body: formData });
        if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
        const data = await res.json();
        nameToKeyRef.current.set(data.file_id, lv.id);
        updateCard(lv.id, { fileId: data.file_id, status: "queued", progressLabel: "Queued" });
      } catch (err: any) {
        updateCard(lv.id, { status: "error", error: err.message || "Upload failed" });
      }
    }
    setBatchProgress(prev => ({ ...prev, total: prev.total + vids.length }));
  }, [updateCard]);

  const addVideos = useCallback((files: File[]) => {
    const videoFiles = files.filter(f => f.type.startsWith("video/"));
    if (videoFiles.length === 0) {
      toast.warning("No video files found", 3000);
      return;
    }
    const newVids: LocalVideo[] = videoFiles.map(file => ({
      id: uid(), file, preview: URL.createObjectURL(file),
    }));
    setLocalVideos(prev => [...prev, ...newVids]);
    toast.success(`Added ${videoFiles.length} video(s)`, 2000);

    if (processing && jobIdRef.current) {
      uploadToActiveJob(newVids);
    }
  }, [processing, uploadToActiveJob]);

  const removeVideo = useCallback((id: string) => {
    setLocalVideos(prev => {
      const v = prev.find(f => f.id === id);
      if (v) URL.revokeObjectURL(v.preview);
      return prev.filter(f => f.id !== id);
    });
  }, []);

  const clearAll = useCallback(() => {
    localVideos.forEach(v => URL.revokeObjectURL(v.preview));
    setLocalVideos([]);
    setCards(new Map());
    setJobId(null);
    setJobCreatedAt(null);
    setBatchProgress({ completed: 0, total: 0 });
    setProcessing(false);
    socketRef.current?.disconnect();
    socketRef.current = null;
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    nameToKeyRef.current.clear();
  }, [localVideos]);

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    else if (e.type === "dragleave") setDragActive(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files?.length > 0) {
      addVideos(Array.from(e.dataTransfer.files));
    }
  }, [addVideos]);

  const syncFromApi = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/video/results/${id}`);
      if (!res.ok) return;
      const body = await res.json();

      setCards(prev => {
        const next = new Map(prev);
        let changed = false;
        (body.results || []).forEach((r: any) => {
          const cardKey = nameToKeyRef.current.get(r.file_id) || nameToKeyRef.current.get(r.filename);
          if (!cardKey) return;
          const existing = next.get(cardKey);
          if (existing?.status === "complete" || existing?.status === "error") return;

          if (r.status === "error" || r.error) {
            changed = true;
            next.set(cardKey, {
              ...(existing || {} as VideoCard),
              fileId: r.file_id,
              status: "error",
              error: r.error || "Processing failed",
            });
          } else if (r.status === "done" || r.video_url) {
            changed = true;
            next.set(cardKey, {
              ...(existing || {} as VideoCard),
              fileId: r.file_id,
              status: "complete",
              progress: 100,
              progressLabel: "Complete",
              thumbUrl: r.thumb_url,
              videoUrl: r.video_url,
              totalDetections: r.total_detections || 0,
              framesAnalyzed: r.frames_analyzed || 0,
              duration: r.duration || 0,
              fps: r.fps || 0,
              avgConfidence: r.avg_confidence || 0,
              maxConfidence: r.max_confidence || 0,
              detections: Array.isArray(r.detections) ? r.detections : existing?.detections,
            });
          }
        });
        return changed ? next : prev;
      });

      setBatchProgress({ completed: body.completed || 0, total: body.total || 0 });
      if (body.status === "complete" || body.status === "cancelled") {
        setProcessing(false);
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      }
    } catch { /* retry */ }
  }, []);

  const connectSocket = useCallback((id: string) => {
    if (socketRef.current) { socketRef.current.disconnect(); socketRef.current = null; }
    const sock = io({ path: "/socket.io/", transports: ["websocket", "polling"] });
    socketRef.current = sock;

    sock.on("connect", () => {
      sock.emit("subscribe_job", { job_id: id });
      syncFromApi(id);
    });

    sock.on("video_item_queued", (d: any) => {
      if (d.job_id !== jobIdRef.current) return;
      const key = nameToKeyRef.current.get(d.filename);
      if (key) {
        nameToKeyRef.current.set(d.file_id, key);
        updateCard(key, { fileId: d.file_id, status: "queued", progressLabel: "Queued" });
      }
    });

    sock.on("video_item_start", (d: any) => {
      if (d.job_id !== jobIdRef.current) return;
      const key = nameToKeyRef.current.get(d.file_id) || nameToKeyRef.current.get(d.filename);
      if (key) updateCard(key, { status: "processing", progress: 0, progressLabel: "0%" });
    });

    sock.on("video_progress", (d: any) => {
      if (d.job_id !== jobIdRef.current) return;
      const key = nameToKeyRef.current.get(d.file_id);
      const pct = typeof d.percent === "number" ? Math.round(d.percent) : 0;
      if (key) updateCard(key, { progress: d.percent, progressLabel: `${pct}%` });
    });

    sock.on("video_item_result", (d: any) => {
      if (d.job_id !== jobIdRef.current) return;
      const key = nameToKeyRef.current.get(d.file_id) || nameToKeyRef.current.get(d.filename);
      if (key) {
        if (d.error) {
          updateCard(key, { status: "error", error: d.error });
        } else {
          updateCard(key, {
            fileId: d.file_id, status: "complete", progress: 100, progressLabel: "Complete",
            thumbUrl: d.thumb_url, videoUrl: d.video_url,
            totalDetections: d.total_detections || 0,
            framesAnalyzed: d.frames_analyzed || 0,
            duration: d.duration || 0, fps: d.fps || 0,
            avgConfidence: d.avg_confidence || 0, maxConfidence: d.max_confidence || 0,
            ...(Array.isArray(d.detections) ? { detections: d.detections } : {}),
          });
        }
      }
      setBatchProgress({ completed: d.completed || 0, total: d.total || 0 });
    });

    sock.on("video_batch_complete", (d: any) => {
      if (d.job_id !== jobIdRef.current) return;
      setProcessing(false);
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      toast.success(`All videos processed! ${d.total_detections} defects found.`, 5000);
    });

    sock.on("video_batch_cancelled", (d: any) => {
      if (d.job_id !== jobIdRef.current) return;
      setBatchProgress(prev => ({ completed: d.completed ?? prev.completed, total: d.total ?? prev.total }));
      setProcessing(false);
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      toast.info("Video processing cancelled.", 3000);
    });
  }, [syncFromApi, updateCard]);

  const startDetection = useCallback(async () => {
    if (localVideos.length === 0) return;
    setProcessing(true);
    cancelRequestedRef.current = false;
    nameToKeyRef.current.clear();

    const newCards = new Map<string, VideoCard>();
    localVideos.forEach(lv => {
      newCards.set(lv.id, {
        localId: lv.id, filename: lv.file.name, localPreview: lv.preview,
        status: "pending", progress: 0, progressLabel: "Pending",
        totalDetections: 0, framesAnalyzed: 0, duration: 0, fps: 0,
        avgConfidence: 0, maxConfidence: 0,
      });
      nameToKeyRef.current.set(lv.file.name, lv.id);
    });
    setCards(newCards);
    setBatchProgress({ completed: 0, total: localVideos.length });

    try {
      const batchRes = await fetch("/api/video/batch/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          total: localVideos.length,
          det_confidence: config.confidence,
          det_slice_size: config.sliceSize,
          det_overlap: config.overlap,
          frame_interval: config.frameInterval,
          model_id: selectedModel || undefined,
        }),
      });
      if (!batchRes.ok) {
        const errText = await batchRes.text().catch(() => "");
        throw new Error(errText || `Server returned ${batchRes.status}`);
      }
      const { job_id } = await batchRes.json();
      setJobId(job_id);
      setJobCreatedAt(Date.now());
      jobIdRef.current = job_id;

      connectSocket(job_id);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => syncFromApi(job_id), POLL_MS);

      for (const lv of localVideos) {
        if (cancelRequestedRef.current) break;
        updateCard(lv.id, { status: "uploading", progressLabel: "Uploading..." });
        const formData = new FormData();
        formData.append("job_id", job_id);
        formData.append("file", lv.file);
        try {
          const uploadRes = await fetch("/api/video/upload", { method: "POST", body: formData });
          if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status}`);
          const data = await uploadRes.json();
          nameToKeyRef.current.set(data.file_id, lv.id);
          updateCard(lv.id, { fileId: data.file_id, status: "queued", progressLabel: "Queued" });
        } catch (err: any) {
          updateCard(lv.id, { status: "error", error: err.message || "Upload failed" });
        }
      }
      toast.info(`Uploaded ${localVideos.length} video(s). Processing...`, 3000);
    } catch (err: any) {
      toast.error(`Failed: ${err.message}`, 5000);
      setProcessing(false);
    }
  }, [localVideos, config, connectSocket, selectedModel, syncFromApi, updateCard]);

  const cancelDetection = useCallback(async () => {
    const activeJobId = jobIdRef.current;
    if (!activeJobId) return;
    cancelRequestedRef.current = true;
    try {
      const res = await fetch(`/api/video/batch/cancel/${activeJobId}`, { method: "POST" });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(errText || `Server returned ${res.status}`);
      }
      setCards(prev => {
        const next = new Map(prev);
        next.forEach((card, key) => {
          if (card.status !== "complete" && card.status !== "error") {
            next.set(key, { ...card, status: "error", error: "Cancelled by user", progressLabel: "Cancelled" });
          }
        });
        return next;
      });
      toast.info("Stopping video processing...", 3000);
    } catch (err: any) {
      cancelRequestedRef.current = false;
      toast.error(`Failed to cancel video processing: ${err.message}`, 5000);
    }
  }, []);

  const completedCards = useMemo(() =>
    Array.from(cards.entries()).filter(([, c]) => c.status === "complete").map(([key]) => key),
    [cards]
  );

  const previewCard = previewId ? cards.get(previewId) : null;
  const previewIndex = previewId ? completedCards.indexOf(previewId) : -1;

  const navigatePreview = useCallback((dir: number) => {
    if (completedCards.length === 0) return;
    const idx = previewId ? completedCards.indexOf(previewId) : -1;
    const next = dir > 0
      ? (idx + 1) % completedCards.length
      : (idx - 1 + completedCards.length) % completedCards.length;
    setPreviewId(completedCards[next]);
  }, [completedCards, previewId]);

  useEffect(() => {
    if (!previewId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreviewId(null);
      if (e.key === "ArrowLeft") navigatePreview(-1);
      if (e.key === "ArrowRight") navigatePreview(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewId, navigatePreview]);

  useEffect(() => {
    if (!previewCard || previewCard.status !== "complete") {
      setVideoFetchedDetections([]);
      setVideoDetectionsLoading(false);
      return;
    }
    const embedded = previewCard.detections;
    if (Array.isArray(embedded) && embedded.length > 0) {
      setVideoFetchedDetections([]);
      setVideoDetectionsLoading(false);
      return;
    }
    const rid = videoResultsFolderId(previewCard);
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
  }, [
    previewId,
    previewCard?.status,
    previewCard?.fileId,
    previewCard?.videoUrl,
    previewCard?.detections?.length,
  ]);

  const sidebarBatchStats = useMemo(() => {
    const list = Array.from(cards.values());
    const completed = list.filter(c => c.status === "complete").length;
    const totalDefects = list.reduce((s, c) => s + c.totalDetections, 0);
    const confs = list.filter(c => c.status === "complete" && c.avgConfidence > 0).map(c => c.avgConfidence);
    const avgConfidence = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
    const batchComplete =
      list.length > 0 && list.every(c => c.status === "complete" || c.status === "error");
    return { totalFiles: list.length, completed, totalDefects, avgConfidence, batchComplete };
  }, [cards]);

  const previewDetectionRows = useMemo(() => {
    if (!previewCard || previewCard.status !== "complete") return [];
    return previewDetectionRowsForFile("video", previewCard.detections, videoFetchedDetections);
  }, [previewCard, videoFetchedDetections]);

  const clsFilter = useDetectionClassFilterForRows(previewDetectionRows as DetectionRowLike[], previewId);

  const previewSidebarPartition = useMemo(() => {
    if (!previewDetectionRows.length) return null;
    return partitionDetectionsSidebarBuckets(clsFilter.filteredRows);
  }, [previewDetectionRows.length, clsFilter.filteredRows]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="glass rounded-2xl border border-[var(--dash-panel-border)] p-6 shadow-premium">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              {!embedded && (
                <Link to="/dashboard" className="dash-text-muted hover:dash-text-primary transition-colors">
                  <ArrowLeft size={20} />
                </Link>
              )}
              <Video className="text-premium-accent text-xl" />
              <div className="text-sm text-premium-accent uppercase tracking-wider">
                {embedded ? "Video analysis" : "Video Analysis"}
              </div>
            </div>
            <div className="text-2xl font-bold dash-text-primary mb-2">Video Defect Detection</div>
            <div className="text-sm dash-text-body leading-relaxed">
              {embedded
                ? "Upload Individual or bulk videos and analyze with the defect detection pipeline. GPU-accelerated frame-by-frame analysis and annotated results appear below."
                : "Upload one or more video files. Each video is analyzed frame-by-frame using YOLO detection on GPU, producing a fully annotated output video with bounding boxes overlaid."}
            </div>
          </div>
          <div className="flex gap-2">
            {totalVideos > 0 && !processing && (
              <button onClick={clearAll}
                className="rounded-xl glass border border-[var(--dash-panel-border)] dash-text-primary px-4 py-2 text-sm font-semibold hover:bg-premium-card-hover transition-colors flex items-center gap-2">
                <Trash2 size={16} /> Clear All
              </button>
            )}
            {processing && (
              <button
                onClick={cancelDetection}
                className="rounded-xl border border-red-500/50 bg-red-500/10 text-red-200 px-4 py-2.5 text-sm font-semibold hover:bg-red-500/20 transition-colors flex items-center gap-2"
              >
                <XCircle size={16} /> Cancel
              </button>
            )}
            <button onClick={startDetection} disabled={!canStart}
              className="rounded-xl bg-gradient-accent text-white px-5 py-2.5 text-sm font-semibold hover:shadow-glow disabled:opacity-60 transition-all flex items-center gap-2">
              {processing ? (
                <><Clock className="text-lg animate-spin" /> Processing...</>
              ) : (
                <><Play className="text-lg" /> Process Videos{totalVideos > 0 ? ` (${totalVideos})` : ""}</>
              )}
            </button>
          </div>
        </div>
      </div>

      <UploadPipelineStrip
        variant="purple"
        title="GPU-accelerated pipeline"
        steps={[
          "Upload video",
          "Frame sampling",
          "YOLO on GPU",
          "Annotate frames",
          "Export MP4",
        ]}
      />

      <div className="grid grid-cols-1 gap-6">
        <div className="glass rounded-2xl border border-[var(--dash-panel-border)] p-6 shadow-premium">
          <div className="mb-4 flex items-center gap-2">
            <Upload className="text-premium-accent text-xl" />
            <h2 className="text-lg font-semibold dash-text-primary">Video Upload</h2>
          </div>
          <MediaUploadBox
            accent="purple"
            dragActive={dragActive}
            disabled={processing}
            hasFiles={localVideos.length > 0}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            inputId="vid-upload"
            accept="video/*"
            multiple
            onInputChange={(e) => {
              if (e.target.files?.length) addVideos(Array.from(e.target.files));
              e.target.value = "";
            }}
            addMoreInputId="vid-add-more"
            onAddMoreChange={(e) => {
              if (e.target.files?.length) addVideos(Array.from(e.target.files));
              e.target.value = "";
            }}
            emptyIcon={<Video className="mx-auto text-3xl dash-text-subtle" />}
            emptyDescription="Drop video files here or click to browse"
            primaryButtonLabel="Select Videos"
            hint="Supports MP4, AVI, MOV — multiple files allowed"
            footerNote="GPU-accelerated frame-by-frame defect detection"
          >
            <div className="flex items-center gap-2 text-sm text-premium-success">
              <CheckCircle2 size={16} />
              <span>{localVideos.length} video(s) selected</span>
            </div>
            <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
              {localVideos.map((lv) => (
                <div
                  key={lv.id}
                  className="group relative overflow-hidden rounded-lg border border-[var(--dash-panel-border)]"
                  style={{ width: 120, backgroundColor: "var(--dash-inset-bg)" }}
                >
                  <video src={lv.preview} muted className="h-16 w-full object-cover" />
                  <div className="p-1">
                    <p className="truncate text-[9px] dash-text-primary">{lv.file.name}</p>
                    <p className="text-[8px] dash-text-muted">{(lv.file.size / 1024 / 1024).toFixed(1)} MB</p>
                  </div>
                  {!processing && (
                    <button
                      type="button"
                      onClick={() => removeVideo(lv.id)}
                      className="absolute -right-1 -top-1 rounded-full bg-red-500 p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <X size={10} className="text-white" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </MediaUploadBox>
        </div>
      </div>

      {/* Processing Progress */}
      {processing && (
        <div className="glass rounded-2xl border border-premium-accent/50 bg-premium-accent/10 p-4 shadow-premium">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Clock className="text-premium-accent animate-spin" size={18} />
              <span className="font-semibold dash-text-primary">Processing Videos</span>
            </div>
            <span className="text-sm dash-text-body">
              {batchProgress.total > 0 ? `${Math.round((batchProgress.completed / batchProgress.total) * 100)}%` : "—"}
            </span>
          </div>
          <div className="w-full rounded-full h-2.5 overflow-hidden" style={{ backgroundColor: "var(--dash-inset-bg)" }}>
            {batchProgress.total > 0 ? (
              <div className="bg-gradient-accent h-full transition-all duration-300 rounded-full" style={{ width: `${(batchProgress.completed / batchProgress.total) * 100}%` }} />
            ) : (
              <div className="h-full w-1/3 animate-progress-indeterminate rounded-full bg-gradient-to-r from-transparent via-cyan-500/70 to-transparent" />
            )}
          </div>
          <div className="mt-2 text-xs dash-text-muted">
            {batchProgress.total > 0 ? `${batchProgress.completed} of ${batchProgress.total} videos completed` : "Uploading videos..."}
          </div>
        </div>
      )}

      {/* Video Grid */}
      {cards.size > 0 && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold dash-text-primary flex items-center gap-2">
              <Layers className="text-premium-accent" size={20} />
              Video Results ({cards.size})
            </h2>
            <div className="flex gap-3 text-xs dash-text-muted">
              {(() => {
                const completed = Array.from(cards.values()).filter(c => c.status === "complete").length;
                const errors = Array.from(cards.values()).filter(c => c.status === "error").length;
                const active = Array.from(cards.values()).filter(c => ["processing", "queued", "uploading"].includes(c.status)).length;
                return (
                  <>
                    {completed > 0 && <span className="text-green-400">&#x2713; {completed} complete</span>}
                    {active > 0 && <span className="text-premium-accent">&#x21BB; {active} processing</span>}
                    {errors > 0 && <span className="text-red-400">&#x2717; {errors} failed</span>}
                  </>
                );
              })()}
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {Array.from(cards.entries()).map(([key, card]) => (
              <div key={key}
                onClick={() => card.status === "complete" && setPreviewId(key)}
                className={`rounded-xl border overflow-hidden transition-all group ${
                  card.status === "complete"
                    ? "border-green-500/30 bg-green-500/5 cursor-pointer hover:shadow-glow hover:border-premium-accent/50"
                    : card.status === "error"
                    ? "border-red-500/30 bg-red-500/5"
                    : card.status === "processing"
                    ? "border-premium-accent/50 bg-premium-accent/5"
                    : "border-[var(--dash-panel-border)] bg-premium-card/30"
                }`}
              >
                <div className="relative aspect-video overflow-hidden" style={{ backgroundColor: "var(--dash-inset-bg)" }}>
                  {card.status === "complete" && card.thumbUrl ? (
                    <img src={card.thumbUrl} alt={card.filename}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200" loading="lazy" />
                  ) : card.localPreview ? (
                    <video src={card.localPreview} muted className="w-full h-full object-cover opacity-50" />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center"><Video className="text-neutral-600" size={28} /></div>
                  )}

                  {card.status !== "complete" && card.status !== "error" && (
                    <div className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center gap-2">
                      <Clock
                        className={
                          card.status === "processing" || card.status === "queued"
                            ? "text-premium-accent animate-spin"
                            : "dash-text-muted animate-spin"
                        }
                        size={22}
                      />
                      {card.status === "processing" || card.status === "queued" ? (
                        <>
                          <span className="text-[10px] text-white font-medium px-2 text-center tabular-nums">
                            {Math.min(100, Math.max(0, Math.round(card.progress)))}%
                          </span>
                          <div className="w-3/4 bg-neutral-700 rounded-full h-1 overflow-hidden">
                            {card.progress > 0 ? (
                              <div
                                className="bg-cyan-500 h-full rounded-full transition-all duration-300"
                                style={{ width: `${Math.min(100, card.progress)}%` }}
                              />
                            ) : (
                              <div className="h-full w-1/3 animate-progress-indeterminate rounded-full bg-gradient-to-r from-transparent via-cyan-500/70 to-transparent" />
                            )}
                          </div>
                        </>
                      ) : (
                        <>
                          <span className="text-[10px] text-white font-medium px-2 text-center">
                            {card.status === "uploading"
                              ? card.progressLabel
                              : "Pending"}
                          </span>
                          <div className="w-3/4 bg-neutral-700 rounded-full h-1 overflow-hidden">
                            <div className="h-full w-1/3 animate-progress-indeterminate rounded-full bg-gradient-to-r from-transparent via-cyan-500/70 to-transparent" />
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {card.status === "error" && (
                    <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center gap-1 px-2">
                      <XCircle className="text-red-400" size={22} />
                      <span className="text-[9px] text-red-300 text-center">{card.error || "Error"}</span>
                    </div>
                  )}

                  {card.status === "complete" && (
                    <>
                      <div className="absolute bottom-1 left-1">
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-blue-500/80 text-white">
                          {formatTime(card.duration)}
                        </span>
                      </div>
                      <div className="absolute bottom-1 right-1"><CheckCircle2 className="text-green-400 drop-shadow-lg" size={14} /></div>
                      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                        <div className="bg-black/60 rounded-full p-2"><Play className="text-white" size={24} /></div>
                      </div>
                    </>
                  )}

                  <div className="absolute top-1 left-1">
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-purple-500/80 text-white">VIDEO</span>
                  </div>
                </div>

                <div className="p-2">
                  <p className="text-[11px] truncate font-medium dash-text-primary" title={card.filename}>{card.filename}</p>
                  {card.status === "complete" && card.avgConfidence > 0 && (
                    <div className="mt-1 flex items-center gap-1">
                      <div className="flex-1 bg-neutral-700 rounded-full h-1.5 overflow-hidden">
                        <div className={`h-full rounded-full ${card.avgConfidence >= 0.7 ? "bg-green-500" : card.avgConfidence >= 0.4 ? "bg-yellow-500" : "bg-red-500"}`}
                          style={{ width: `${Math.round(card.avgConfidence * 100)}%` }} />
                      </div>
                      <span className="text-[10px] font-Poppins dash-text-muted">{Math.round(card.avgConfidence * 100)}%</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Progress Bar below grid */}
      {cards.size > 0 && (() => {
        const allCards = Array.from(cards.values());
        const completed = allCards.filter(c => c.status === "complete").length;
        const errors = allCards.filter(c => c.status === "error").length;
        const done = completed + errors;
        const total = allCards.length;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const totalDets = allCards.reduce((s, c) => s + c.totalDetections, 0);
        const isRunning = done < total;
        const currentlyProcessing = allCards.find(c => c.status === "processing");

        return (
          <div className="glass rounded-2xl border border-[var(--dash-panel-border)] p-5 shadow-premium">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Layers className="text-premium-accent" size={18} />
                <span className="font-semibold dash-text-primary text-sm">Video Detection Progress</span>
              </div>
              <span className="text-xs font-Poppins text-premium-accent">{pct}%</span>
            </div>
            <div className="w-full rounded-full h-3 overflow-hidden mb-3" style={{ backgroundColor: "var(--dash-inset-bg)" }}>
              <div className={`h-full rounded-full transition-all duration-500 ${
                isRunning ? "bg-gradient-to-r from-cyan-500 to-blue-500"
                : errors > 0 ? "bg-gradient-to-r from-green-500 to-yellow-500"
                : "bg-gradient-to-r from-green-500 to-emerald-400"
              }`} style={{ width: `${pct}%` }} />
            </div>
            <div className="flex items-center justify-between text-xs dash-text-muted">
              <div className="flex gap-4">
                <span>{done} / {total} videos</span>
                {totalDets > 0 && <span className="text-red-400">{totalDets} defect{totalDets !== 1 ? "s" : ""}</span>}
              </div>
              <div>
                {isRunning && currentlyProcessing && (
                  <span className="text-premium-accent">
                    Analyzing: {currentlyProcessing.filename.length > 25 ? currentlyProcessing.filename.slice(0, 22) + "..." : currentlyProcessing.filename}
                  </span>
                )}
                {!isRunning && done === total && (
                  <span className="text-green-400 flex items-center gap-1"><CheckCircle2 size={12} /> All videos processed</span>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Empty state */}
      {cards.size === 0 && totalVideos === 0 && (
        <div className="glass rounded-2xl border-2 border-dashed border-[var(--dash-panel-border)] p-12 text-center shadow-premium">
          <Video className="text-4xl dash-text-subtle mx-auto mb-4" />
          <div className="dash-text-body text-lg mb-2">No videos uploaded yet</div>
          <div className="dash-text-subtle text-sm">Upload one or more videos above to start defect detection</div>
        </div>
      )}

      {/* Preview modal: portal to body so layout overflow/backdrop-filter cannot clip or swallow the frame strip */}
      {previewId && previewCard && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-[200] flex flex-row items-stretch bg-[var(--dash-overlay-scrim)] min-h-0 min-w-0"
          role="presentation"
          onClick={() => setPreviewId(null)}
        >
          <button
            type="button"
            onClick={() => setPreviewId(null)}
            className="absolute top-4 z-20 rounded-full bg-[var(--dash-elevated-bg)] dash-text-primary p-2 hover:bg-[var(--dash-hover-bg)] transition-colors right-[calc(320px+1rem)]"
            aria-label="Close preview"
          >
            <X size={24} />
          </button>

          {completedCards.length > 1 && (
            <>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); navigatePreview(-1); }}
                className="absolute left-4 top-1/2 -translate-y-1/2 z-10 rounded-full bg-[var(--dash-elevated-bg)] dash-text-primary p-2 hover:bg-[var(--dash-hover-bg)] transition-colors"
              >
                <ChevronLeft size={24} />
              </button>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); navigatePreview(1); }}
                className="absolute top-1/2 z-10 -translate-y-1/2 rounded-full bg-[var(--dash-elevated-bg)] dash-text-primary p-2 hover:bg-[var(--dash-hover-bg)] transition-colors right-[calc(320px+1rem+3.5rem)] md:right-[calc(320px+1rem+3.5rem+220px)]"
              >
                <ChevronRight size={24} />
              </button>
            </>
          )}

          {/* Video | annotated frame strip | stats (same row as your mock) */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-row items-stretch pt-14 pb-0">
            <div
              className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto p-4 md:p-8"
              onClick={e => e.stopPropagation()}
            >
              <div className="relative w-full max-w-5xl">
                <div className="absolute top-2 right-2 z-10 rounded-lg border border-[var(--dash-panel-border)] px-3 py-1.5 text-xs dash-text-body" style={{ backgroundColor: "var(--dash-nested-bg)" }}>
                  {previewIndex + 1} / {completedCards.length}
                </div>
                {previewCard.videoUrl ? (
                  <video
                    ref={previewVideoRef}
                    key={previewCard.videoUrl}
                    src={previewCard.videoUrl}
                    controls
                    autoPlay
                    playsInline
                    className="w-full max-h-[calc(100vh-8rem)] rounded-xl bg-black shadow-2xl"
                  />
                ) : (
                  <div className="flex aspect-video w-full items-center justify-center rounded-xl dash-text-subtle" style={{ backgroundColor: "var(--dash-nested-bg)" }}>
                    Video not available
                  </div>
                )}
              </div>
            </div>

            {previewCard.videoUrl && (
              <VideoAnnotatedFrameStrip
                videoUrl={previewCard.videoUrl}
                duration={previewCard.duration}
                fps={previewCard.fps}
                framesAnalyzed={previewCard.framesAnalyzed}
                mainVideoRef={previewVideoRef}
              />
            )}
          </div>

          <div
            className="flex h-full min-h-0 w-[320px] shrink-0 flex-col overflow-hidden border-l border-[var(--dash-panel-border)] pt-14" style={{ backgroundColor: "var(--dash-modal-aside)" }}
            onClick={e => e.stopPropagation()}
          >
            <div className="p-4 border-b border-[var(--dash-panel-border)]">
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2 py-0.5 rounded text-xs font-bold border bg-purple-500/20 text-purple-300 border-purple-500/50">VIDEO</span>
                <span className={`px-2 py-0.5 rounded text-xs font-bold border ${
                  sidebarBatchStats.batchComplete
                    ? "bg-green-500/20 text-green-300 border-green-500/50"
                    : "bg-amber-500/20 text-amber-300 border-amber-500/50"
                }`}>{sidebarBatchStats.batchComplete ? "COMPLETE" : "PROCESSING"}</span>
              </div>
              <div className="text-sm font-Poppins dash-text-muted truncate" title={jobId || undefined}>
                ID: {jobId || "—"}
              </div>
              <div className="text-xs dash-text-subtle mt-1">{timeAgoJob(jobCreatedAt)}</div>
            </div>

            <div className="p-4 border-b border-[var(--dash-panel-border)] grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs dash-text-muted">Total Files</div>
                <div className="text-xl font-bold dash-text-primary">{sidebarBatchStats.totalFiles}</div>
              </div>
              <div>
                <div className="text-xs dash-text-muted">Completed</div>
                <div className="text-xl font-bold dash-text-primary">{sidebarBatchStats.completed}</div>
              </div>
              <div className="col-span-2">
                <div className="text-xs dash-text-muted">Detections</div>
                {previewDetectionRows.length === 0 &&
                (previewCard.totalDetections || 0) > 0 &&
                videoDetectionsLoading ? (
                  <div className="mt-0.5 text-sm font-bold dash-text-subtle">Loading…</div>
                ) : previewSidebarPartition ? (
                  <div
                    className={`mt-0.5 text-sm font-bold leading-tight ${
                      previewSidebarPartition.defects.length > 0 ? "text-red-400" : "text-green-400"
                    }`}
                  >
                    <div>{previewSidebarPartition.components.length} components</div>
                    <div>{previewSidebarPartition.defects.length} defects</div>
                  </div>
                ) : (
                  <div
                    className={`text-xl font-bold ${
                      (previewCard.totalDetections || 0) > 0 ? "text-red-400" : "text-green-400"
                    }`}
                  >
                    {previewCard.totalDetections || 0}
                  </div>
                )}
              </div>
            </div>

            <div className="p-4 border-b border-[var(--dash-panel-border)]">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-xs dash-text-muted mb-2">Current File</div>
                  <div className="text-sm dash-text-primary truncate font-medium" title={previewCard.filename}>{previewCard.filename}</div>
                </div>
                <DetectionClassFilterDropdown
                  filterClassKeys={clsFilter.filterClassKeys}
                  hiddenSet={clsFilter.hiddenSet}
                  open={clsFilter.open}
                  setOpen={clsFilter.setOpen}
                  anchorRef={clsFilter.anchorRef}
                  toggleKey={clsFilter.toggleKey}
                  showAll={clsFilter.showAll}
                  hideAll={clsFilter.hideAll}
                  liveOverlayEnabled={false}
                />
              </div>
              <div className="mt-3 space-y-2 text-xs">
                <div className="flex justify-between dash-text-body">
                  <span>Duration</span>
                  <span className="dash-text-primary font-semibold">{formatTime(previewCard.duration || 0)}</span>
                </div>
                <div className="flex justify-between dash-text-body">
                  <span>FPS</span>
                  <span className="dash-text-primary font-semibold">{previewCard.fps || 0}</span>
                </div>
                <div className="flex justify-between dash-text-body">
                  <span>Frames Analyzed</span>
                  <span className="dash-text-primary font-semibold">{previewCard.framesAnalyzed || 0}</span>
                </div>
              </div>
            </div>

            {previewCard.totalDetections > 0 && videoDetectionsLoading && previewDetectionRows.length === 0 && (
              <div className="shrink-0 border-b border-[var(--dash-panel-border)] p-4 text-xs dash-text-subtle">Loading defect list…</div>
            )}
            {previewSidebarPartition && (previewSidebarPartition.components.length > 0 || previewSidebarPartition.defects.length > 0) && (
              <DetectionSidebarBucketPanels partition={previewSidebarPartition} hideRowCounts />
            )}

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="text-xs dash-text-muted mb-3">All Files ({cards.size})</div>
              <div className="space-y-1.5">
                {Array.from(cards.entries()).map(([key, f]) => {
                  const isActive = key === previewId;
                  const done = f.status === "complete";
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => { if (done) setPreviewId(key); }}
                      className={`w-full flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors ${
                        isActive ? "bg-cyan-500/20 border border-cyan-500/50" : "hover:bg-[var(--dash-hover-bg)] border border-transparent"
                      } ${!done ? "opacity-50 cursor-default" : "cursor-pointer"}`}
                    >
                      {f.thumbUrl ? (
                        <img src={f.thumbUrl} className="w-8 h-8 rounded object-cover flex-shrink-0" alt="" />
                      ) : (
                        <div className="w-8 h-8 rounded flex items-center justify-center flex-shrink-0" style={{ backgroundColor: "var(--dash-inset-bg)" }}>
                          <Video size={12} className="dash-text-subtle" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] dash-text-primary truncate">{f.filename}</div>
                        <div className="text-[10px] dash-text-subtle">
                          {f.status === "complete" ? (
                            <span className="text-green-400">
                              {Array.isArray(f.detections) && f.detections.length > 0
                                ? `${uniqueDefectTypeCount(f.detections)} defects`
                                : `${f.totalDetections || 0} detections`}
                            </span>
                          ) : f.status === "processing" ? (
                            <span className="text-amber-400">Processing...</span>
                          ) : f.status === "error" ? (
                            <span className="text-red-400">Error</span>
                          ) : (
                            <span>Queued</span>
                          )}
                        </div>
                      </div>
                      {f.status === "complete" && <CheckCircle2 size={12} className="text-green-400 flex-shrink-0" />}
                      {f.status === "processing" && <Clock size={12} className="text-amber-400 animate-spin flex-shrink-0" />}
                      {f.status === "error" && <XCircle size={12} className="text-red-400 flex-shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      , document.body)
      }
    </div>
  );
}
