import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import VideoUpload from "./VideoUpload";
import ThermalImages from "./ThermalImages";
import MediaUploadBox from "../components/MediaUploadBox";
import UploadPipelineStrip from "../components/UploadPipelineStrip";
import { toast } from "../components/Toast";
import {
  partitionDetectionsSidebarBuckets,
  formatDetectionSidebarLabel,
} from "../utils/detectionSidebarBuckets";
import {
  DetectionClassFilterDropdown,
  DETECTION_FILE_GRID_CLASS,
  RGB_PREVIEW_ZOOM_MAX,
  RGB_PREVIEW_ZOOM_MIN,
  RGB_PREVIEW_ZOOM_STEP,
  useDetectionClassFilterForRows,
  useRgbPreviewDetectionOverlay,
} from "../components/DetectionClassFilter";
import {
  Upload,
  Camera,
  X,
  CheckCircle2,
  XCircle,
  Clock,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Crosshair,
  ArrowLeft,
  FileImage,
  Trash2,
  Layers,
} from "lucide-react";
import { io, type Socket } from "socket.io-client";

const POLL_MS = 2000;

type LocalFile = {
  id: string;
  file: File;
  preview: string;
};

type Detection = {
  bbox: number[];
  confidence: number;
  class_id: number;
  class_name: string;
  source?: string;
};

type DetectionStats = {
  total_defects: number;
  avg_confidence: number;
  max_confidence: number;
  min_confidence: number;
  processing_time_ms: number;
};

type CardData = {
  localId?: string;
  fileId?: string;
  filename: string;
  imageType: "rgb";
  localPreview?: string;
  status: "pending" | "uploading" | "queued" | "processing" | "complete" | "error";
  progress: number;
  progressLabel: string;
  thumbUrl?: string;
  annotatedUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  detections: Detection[];
  stats?: DetectionStats;
  error?: string;
};

let _idCounter = 0;
const uid = () => `f_${++_idCounter}_${Date.now()}`;

type ModelInfo = { id: string; title: string; path: string; description: string };

type DetectionMode = "video" | "thermal" | "rgb";

export default function AIDetection() {
  const [searchParams] = useSearchParams();
  const [rgbFiles, setRgbFiles] = useState<LocalFile[]>([]);
  const [cards, setCards] = useState<Map<string, CardData>>(new Map());
  const [jobId, setJobId] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ completed: 0, total: 0 });
  const [config, setConfig] = useState({ confidence: 0.20, sliceSize: 768, overlap: 0.1 });
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewConfFilter, setPreviewConfFilter] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [modalZoom, setModalZoom] = useState(1);
  const previewImgRef = useRef<HTMLImageElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
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
  const [detectionMode, setDetectionMode] = useState<DetectionMode>(() => {
    try {
      const m = new URLSearchParams(window.location.search).get("mode");
      if (m === "thermal" || m === "video" || m === "rgb") return m;
    } catch {
      /* ignore */
    }
    return "rgb";
  });

  useEffect(() => {
    const m = searchParams.get("mode");
    if (m === "thermal" || m === "video" || m === "rgb") setDetectionMode(m);
  }, [searchParams]);

  const socketRef = useRef<Socket | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const cardsRef = useRef<Map<string, CardData>>(new Map());
  const nameToKeyRef = useRef<Map<string, string>>(new Map());
  const cancelRequestedRef = useRef(false);

  const totalFiles = rgbFiles.length;
  const canStart = totalFiles > 0 && !processing;

  useEffect(() => { jobIdRef.current = jobId; }, [jobId]);
  useEffect(() => { cardsRef.current = cards; }, [cards]);

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

  const updateCard = useCallback((key: string, patch: Partial<CardData>) => {
    setCards(prev => {
      const existing = prev.get(key);
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(key, { ...existing, ...patch });
      return next;
    });
  }, []);

  const uploadToActiveJob = useCallback(async (localFiles: LocalFile[]) => {
    const activeJobId = jobIdRef.current;
    if (!activeJobId) return;

    for (const lf of localFiles) {
      const cardData: CardData = {
        localId: lf.id,
        filename: lf.file.name,
        imageType: "rgb",
        localPreview: lf.preview,
        status: "uploading",
        progress: 0,
        progressLabel: "Uploading...",
        detections: [],
      };
      setCards(prev => { const n = new Map(prev); n.set(lf.id, cardData); return n; });
      nameToKeyRef.current.set(lf.file.name, lf.id);

      const formData = new FormData();
      formData.append("job_id", activeJobId);
      formData.append("file", lf.file);
      try {
        const res = await fetch("/api/uploads/file", { method: "POST", body: formData });
        if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
        const data = await res.json();
        nameToKeyRef.current.set(data.file_id, lf.id);
        updateCard(lf.id, { fileId: data.file_id, status: "queued", progressLabel: "Queued" });
      } catch (err: any) {
        updateCard(lf.id, { status: "error", error: err.message || "Upload failed" });
      }
    }
    setBatchProgress(prev => ({ ...prev, total: prev.total + localFiles.length }));
  }, [updateCard]);

  const addFiles = useCallback((files: File[]) => {
    const imageFiles = files.filter(f => f.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      toast.warning("No image files found", 3000);
      return;
    }
    const newFiles: LocalFile[] = imageFiles.map(file => ({
      id: uid(),
      file,
      preview: URL.createObjectURL(file),
    }));
    setRgbFiles(prev => [...prev, ...newFiles]);
    toast.success(`Added ${imageFiles.length} RGB image(s)`, 2000);

    if (processing && jobIdRef.current) {
      uploadToActiveJob(newFiles);
    }
  }, [processing, uploadToActiveJob]);

  const removeFile = useCallback((id: string) => {
    setRgbFiles(prev => {
      const file = prev.find(f => f.id === id);
      if (file) URL.revokeObjectURL(file.preview);
      return prev.filter(f => f.id !== id);
    });
  }, []);

  const clearAll = useCallback(() => {
    rgbFiles.forEach(f => URL.revokeObjectURL(f.preview));
    setRgbFiles([]);
    setCards(new Map());
    setJobId(null);
    setBatchProgress({ completed: 0, total: 0 });
    setProcessing(false);
    socketRef.current?.disconnect();
    socketRef.current = null;
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    nameToKeyRef.current.clear();
  }, [rgbFiles]);

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
      addFiles(Array.from(e.dataTransfer.files));
    }
  }, [addFiles]);

  const syncFromApi = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/detection/results/${id}`);
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
          changed = true;
          next.set(cardKey, {
            ...(existing || {} as CardData),
            fileId: r.file_id,
            status: "complete",
            progress: 100,
            progressLabel: "Complete",
            thumbUrl: r.thumb_url,
            annotatedUrl: r.annotated_url,
            imageWidth: typeof r.image_width === "number" ? r.image_width : undefined,
            imageHeight: typeof r.image_height === "number" ? r.image_height : undefined,
            detections: r.detections || [],
            stats: r.stats,
          });
          nameToKeyRef.current.set(r.file_id, cardKey);
        });

        const fileStatuses: Record<string, any> = body.file_statuses || {};
        for (const [fid, fdata] of Object.entries(fileStatuses) as [string, any][]) {
          if (fdata.status !== "error") continue;
          const cardKey = nameToKeyRef.current.get(fid) || nameToKeyRef.current.get(fdata.filename);
          if (!cardKey) continue;
          const existing = next.get(cardKey);
          if (existing?.status === "complete" || existing?.status === "error") continue;
          changed = true;
          next.set(cardKey, {
            ...(existing || {} as CardData),
            fileId: fid,
            status: "error",
            error: fdata.error || "Processing failed",
          });
        }

        return changed ? next : prev;
      });

      const total = body.total || (body.results?.length ?? 0);
      const completed = body.completed || (body.results?.length ?? 0);
      setBatchProgress({ completed, total });

      if (body.status === "complete" || body.status === "cancelled" || completed >= total) {
        setProcessing(false);
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      }
    } catch { /* retry on next poll */ }
  }, []);

  const connectSocket = useCallback((id: string) => {
    if (socketRef.current) { socketRef.current.disconnect(); socketRef.current = null; }

    const sock = io({ path: "/socket.io/", transports: ["websocket", "polling"] });
    socketRef.current = sock;

    sock.on("connect", () => {
      sock.emit("subscribe_job", { job_id: id });
      syncFromApi(id);
    });

    sock.on("detection_queued", (d: any) => {
      if (d.job_id !== jobIdRef.current) return;
      const cardKey = nameToKeyRef.current.get(d.filename);
      if (cardKey) {
        nameToKeyRef.current.set(d.file_id, cardKey);
        updateCard(cardKey, { fileId: d.file_id, status: "queued", progressLabel: "Queued" });
      }
    });

    sock.on("detection_start", (d: any) => {
      if (d.job_id !== jobIdRef.current) return;
      const cardKey = nameToKeyRef.current.get(d.file_id) || nameToKeyRef.current.get(d.filename);
      if (cardKey) updateCard(cardKey, { status: "processing", progressLabel: "Processing analysis" });
    });

    sock.on("detection_progress", (d: any) => {
      if (d.job_id !== jobIdRef.current) return;
      const cardKey = nameToKeyRef.current.get(d.file_id);
      if (cardKey) updateCard(cardKey, { progress: d.percent, progressLabel: "Processing analysis" });
    });

    sock.on("detection_result", (d: any) => {
      if (d.job_id !== jobIdRef.current) return;
      const cardKey = nameToKeyRef.current.get(d.file_id) || nameToKeyRef.current.get(d.filename);
      if (cardKey) {
        if (d.error) {
          updateCard(cardKey, { status: "error", error: d.error });
        } else {
          updateCard(cardKey, {
            fileId: d.file_id,
            status: "complete",
            progress: 100,
            progressLabel: "Complete",
            thumbUrl: d.thumb_url,
            annotatedUrl: d.annotated_url,
            imageWidth: typeof d.image_width === "number" ? d.image_width : undefined,
            imageHeight: typeof d.image_height === "number" ? d.image_height : undefined,
            detections: d.detections || [],
            stats: d.stats,
          });
        }
      }
      setBatchProgress({ completed: d.completed || 0, total: d.total || 0 });
    });

    sock.on("detection_batch_complete", (d: any) => {
      if (d.job_id !== jobIdRef.current) return;
      setBatchProgress({ completed: d.total_files, total: d.total_files });
      setProcessing(false);
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      toast.success(`Detection complete! ${d.total_defects} defects across ${d.total_files} files.`, 5000);
    });

    sock.on("detection_batch_cancelled", (d: any) => {
      if (d.job_id !== jobIdRef.current) return;
      setBatchProgress(prev => ({ completed: d.completed ?? prev.completed, total: d.total ?? prev.total }));
      setProcessing(false);
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      toast.info("Detection cancelled.", 3000);
    });
  }, [syncFromApi, updateCard]);

  const startDetection = useCallback(async () => {
    if (rgbFiles.length === 0) return;
    setProcessing(true);
    cancelRequestedRef.current = false;
    nameToKeyRef.current.clear();

    const newCards = new Map<string, CardData>();
    rgbFiles.forEach(lf => {
      newCards.set(lf.id, {
        localId: lf.id,
        filename: lf.file.name,
        imageType: "rgb",
        localPreview: lf.preview,
        status: "pending",
        progress: 0,
        progressLabel: "Pending",
        detections: [],
      });
      nameToKeyRef.current.set(lf.file.name, lf.id);
    });
    setCards(newCards);
    setBatchProgress({ completed: 0, total: rgbFiles.length });

    try {
      const batchRes = await fetch("/api/uploads/batch/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          total: rgbFiles.length,
          category: "rgb",
          det_confidence: config.confidence,
          det_slice_size: config.sliceSize,
          det_overlap: config.overlap,
          model_id: selectedModel || undefined,
        }),
      });
      if (!batchRes.ok) {
        const errText = await batchRes.text().catch(() => "");
        throw new Error(errText || `Server returned ${batchRes.status}. Is the detection server running on port 8000?`);
      }
      const { job_id } = await batchRes.json();
      setJobId(job_id);
      jobIdRef.current = job_id;

      connectSocket(job_id);

      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => syncFromApi(job_id), POLL_MS);

      const CONCURRENT = 3;
      const queue = [...rgbFiles];

      const uploadOne = async (lf: LocalFile) => {
        if (cancelRequestedRef.current) return;
        updateCard(lf.id, { status: "uploading", progressLabel: "Uploading..." });
        const formData = new FormData();
        formData.append("job_id", job_id);
        formData.append("file", lf.file);
        try {
          const uploadRes = await fetch("/api/uploads/file", { method: "POST", body: formData });
          if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status}`);
          const data = await uploadRes.json();
          nameToKeyRef.current.set(data.file_id, lf.id);
          updateCard(lf.id, { fileId: data.file_id, status: "queued", progressLabel: "Queued" });
        } catch (err: any) {
          updateCard(lf.id, { status: "error", error: err.message || "Upload failed" });
        }
      };

      // Upload files with limited concurrency for speed
      const workers = Array.from({ length: Math.min(CONCURRENT, queue.length) }, async () => {
        while (queue.length > 0) {
          if (cancelRequestedRef.current) return;
          const lf = queue.shift()!;
          await uploadOne(lf);
        }
      });
      await Promise.all(workers);

      toast.info(`Uploaded ${rgbFiles.length} files. Detection in progress...`, 3000);
    } catch (err: any) {
      toast.error(`Failed to start detection: ${err.message}`, 5000);
      setProcessing(false);
    }
  }, [rgbFiles, config, connectSocket, selectedModel, syncFromApi, updateCard]);

  const cancelDetection = useCallback(async () => {
    const activeJobId = jobIdRef.current;
    if (!activeJobId) return;
    cancelRequestedRef.current = true;
    try {
      const res = await fetch(`/api/uploads/batch/cancel/${activeJobId}`, { method: "POST" });
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
      toast.info("Stopping detection...", 3000);
    } catch (err: any) {
      cancelRequestedRef.current = false;
      toast.error(`Failed to cancel detection: ${err.message}`, 5000);
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
    setModalZoom(1);
    setPreviewConfFilter(0);
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

  const previewDetections = useMemo(() => {
    if (!previewCard) return [];
    return previewCard.detections.filter(d => d.confidence >= previewConfFilter);
  }, [previewCard, previewConfFilter]);

  const clsFilter = useDetectionClassFilterForRows(previewDetections, previewId);

  const previewSidebarBuckets = useMemo(
    () => partitionDetectionsSidebarBuckets(clsFilter.filteredRows as Detection[]),
    [clsFilter.filteredRows]
  );

  const previewHasSourceDims =
    (previewCard?.imageWidth ?? 0) > 0 && (previewCard?.imageHeight ?? 0) > 0;
  const previewBaseSrc = previewHasSourceDims
    ? previewCard?.thumbUrl || previewCard?.localPreview
    : previewCard?.annotatedUrl || previewCard?.thumbUrl || previewCard?.localPreview;

  useRgbPreviewDetectionOverlay(previewImgRef, previewCanvasRef, {
    enabled: Boolean(previewCard && previewHasSourceDims),
    sourceW: previewCard?.imageWidth ?? 0,
    sourceH: previewCard?.imageHeight ?? 0,
    detections: clsFilter.filteredRows as Detection[],
    imageUrlKey: previewBaseSrc ?? "",
    modalZoom,
  });

  return (
    <div className="space-y-6">
      <div className="glass rounded-2xl border border-[var(--dash-panel-border)] p-6 shadow-premium">
        <div className="flex items-center gap-3 mb-3">
          <Link to="/dashboard" className="dash-text-muted hover:dash-text-primary transition-colors">
            <ArrowLeft size={20} />
          </Link>
          <Crosshair className="text-premium-accent text-xl" />
          <h1 className="text-2xl font-bold dash-text-primary">AI Detection</h1>
        </div>
        <p className="text-sm dash-text-body leading-relaxed mb-4">
          Choose a mode: video defect detection, DJI thermal analysis, or RGB image detection.
        </p>
        <div className="flex flex-wrap gap-2">
          {([
            { id: "video" as const, label: "Video analysis" },
            { id: "thermal" as const, label: "Thermal Analysis" },
            { id: "rgb" as const, label: "RGB analysis" },
          ]).map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setDetectionMode(id)}
              className={`rounded-xl border px-4 py-2.5 text-sm font-semibold transition-colors ${
                detectionMode === id
                  ? "border-premium-accent bg-premium-accent/15 dash-text-primary shadow-glow"
                  : "border-[var(--dash-panel-border)] dash-text-body hover:border-neutral-500 hover:dash-text-primary"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {detectionMode === "video" && <VideoUpload embedded />}

      {detectionMode === "thermal" && <ThermalImages embedded />}

      {detectionMode === "rgb" && (
        <>
      <div className="glass rounded-2xl border border-[var(--dash-panel-border)] p-6 shadow-premium">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <image className="text-premium-accent text-xl" />
              <div className="text-sm text-premium-accent uppercase tracking-wider">RGB Analysis</div>
            </div>
            <div className="text-2xl font-bold dash-text-primary mb-2">Defect Detection Pipeline</div>
            <div className="text-sm dash-text-body leading-relaxed">
              Upload RGB Individual or bulk images for AI-powered defect detection. The system uses YOLO + SAHI sliced inference to detect defects and display results in real time.
            </div>
          </div>
          <div className="flex gap-2">
            {totalFiles > 0 && !processing && (
              <button
                onClick={clearAll}
                className="rounded-xl glass border border-[var(--dash-panel-border)] dash-text-primary px-4 py-2 text-sm font-semibold hover:bg-premium-card-hover transition-colors flex items-center gap-2"
              >
                <Trash2 size={16} />
                Clear All
              </button>
            )}
            {processing && (
              <button
                onClick={cancelDetection}
                className="rounded-xl border border-red-500/50 bg-red-500/10 text-red-200 px-4 py-2.5 text-sm font-semibold hover:bg-red-500/20 transition-colors flex items-center gap-2"
              >
                <XCircle size={16} />
                Cancel
              </button>
            )}
            <button
              onClick={startDetection}
              disabled={!canStart}
              className="rounded-xl bg-gradient-accent text-white px-5 py-2.5 text-sm font-semibold hover:shadow-glow disabled:opacity-60 transition-all flex items-center gap-2"
            >
              {processing ? (
                <>
                  <Clock className="text-lg animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <Crosshair className="text-lg" />
                  Start Detection{totalFiles > 0 ? ` (${totalFiles})` : ""}
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      <UploadPipelineStrip
        variant="cyan"
        title="Processing pipeline"
        steps={[
          "Image ingest",
          "YOLO full-image",
          "SAHI sliced inference",
          "NMS merge",
          "Annotation & thumbnails",
        ]}
      />

      <div className="grid grid-cols-1 gap-6">
        <div className="glass rounded-2xl border border-[var(--dash-panel-border)] p-6 shadow-premium">
          <div className="mb-4 flex items-center gap-2">
            <Upload className="text-premium-accent text-xl" />
            <h2 className="text-lg font-semibold dash-text-primary">Image Upload</h2>
          </div>
          <MediaUploadBox
            accent="cyan"
            dragActive={dragActive}
            disabled={processing}
            hasFiles={rgbFiles.length > 0}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            inputId="rgb-upload"
            accept="image/*"
            multiple
            onInputChange={(e) => {
              if (e.target.files?.length) addFiles(Array.from(e.target.files));
              e.target.value = "";
            }}
            addMoreInputId="rgb-add-more"
            onAddMoreChange={(e) => {
              if (e.target.files?.length) addFiles(Array.from(e.target.files));
              e.target.value = "";
            }}
            emptyIcon={<Camera className="mx-auto text-3xl dash-text-subtle" />}
            emptyDescription="Drop RGB images here or click to browse"
            primaryButtonLabel="Select RGB Images"
            footerNote="High-resolution RGB images from drone or camera system"
          >
            <div className="flex items-center gap-2 text-sm text-premium-success">
              <CheckCircle2 size={16} />
              <span>{rgbFiles.length} RGB image(s) selected</span>
            </div>
            <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto">
              {rgbFiles.map((f) => (
                <div key={f.id} className="group relative">
                  <img
                    src={f.preview}
                    alt={f.file.name}
                    className="h-16 w-16 rounded-lg border border-[var(--dash-panel-border)] object-cover"
                  />
                  {!processing && (
                    <button
                      type="button"
                      onClick={() => removeFile(f.id)}
                      className="absolute -right-1 -top-1 rounded-full bg-red-500 p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <X size={10} className="text-white" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </MediaUploadBox>
          {totalFiles > 0 && !processing && (
            <div className="mt-3 rounded-xl border border-[var(--dash-panel-border)] p-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium dash-text-primary">
                  {totalFiles} file{totalFiles !== 1 ? "s" : ""} ready
                </div>
                <div className="flex gap-3 text-xs dash-text-muted">
                  {rgbFiles.length > 0 && <span className="text-premium-accent">{rgbFiles.length} RGB</span>}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Progress */}
      {processing && (
        <div className="glass rounded-2xl border border-premium-accent/50 bg-premium-accent/10 p-4 shadow-premium">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Clock className="text-premium-accent animate-spin" size={18} />
              <span className="font-semibold dash-text-primary">Processing Images</span>
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
            {batchProgress.total > 0 ? `${batchProgress.completed} of ${batchProgress.total} files completed` : "Uploading files..."}
          </div>
        </div>
      )}

      {/* Results Grid */}
      {cards.size > 0 && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold dash-text-primary flex items-center gap-2">
              <Layers className="text-premium-accent" size={20} />
              Detection Results ({cards.size})
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
          <div className={DETECTION_FILE_GRID_CLASS}>
            {Array.from(cards.entries()).map(([key, card]) => (
              <div
                key={key}
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
                <div className="relative aspect-square overflow-hidden" style={{ backgroundColor: "var(--dash-inset-bg)" }}>
                  {card.status === "complete" && card.thumbUrl ? (
                    <img src={card.thumbUrl} alt={card.filename} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200" loading="lazy" />
                  ) : card.localPreview ? (
                    <img src={card.localPreview} alt={card.filename} className="w-full h-full object-cover opacity-50" loading="lazy" />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center"><FileImage className="text-neutral-600" size={32} /></div>
                  )}

                  {card.status !== "complete" && card.status !== "error" && (
                    <div className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center gap-2">
                      {card.status === "processing" ? <Clock className="text-premium-accent animate-spin" size={24} /> : <Clock className="dash-text-muted" size={24} />}
                      <span className="text-[10px] dash-text-primary font-medium px-2 text-center">
                        {card.status === "processing" ? "Processing analysis" : card.progressLabel}
                      </span>
                      {card.status === "processing" && (
                        <div className="w-3/4 rounded-full h-1 overflow-hidden" style={{ backgroundColor: "var(--dash-inset-border)" }}>
                          {card.progress > 0 ? (
                            <div className="bg-cyan-500 h-full rounded-full transition-all duration-300" style={{ width: `${card.progress}%` }} />
                          ) : (
                            <div className="h-full w-1/3 animate-progress-indeterminate rounded-full bg-gradient-to-r from-transparent via-cyan-500/70 to-transparent" />
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {card.status === "error" && (
                    <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center gap-1 px-2">
                      <XCircle className="text-red-400" size={24} />
                      <span className="text-[10px] text-red-300 text-center">{card.error || "Error"}</span>
                    </div>
                  )}

                  <div className="absolute top-1 left-1">
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-cyan-500/80 text-white">
                      RGB
                    </span>
                  </div>

                  {card.status === "complete" && (
                    <div className="absolute top-1 right-1">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${card.detections.length > 0 ? "bg-red-500/90 text-white" : "bg-green-500/90 text-white"}`}>
                        {card.detections.length}
                      </span>
                    </div>
                  )}

                  {card.status === "complete" && (
                    <div className="absolute bottom-1 right-1"><CheckCircle2 className="text-green-400 drop-shadow-lg" size={16} /></div>
                  )}
                </div>

                <div className="p-2">
                  <p className="text-[11px] truncate font-medium dash-text-primary" title={card.filename}>{card.filename}</p>
                  {card.status === "complete" && card.stats && card.stats.avg_confidence > 0 && (
                    <div className="mt-1 flex items-center gap-1">
                      <div className="flex-1 rounded-full h-1.5 overflow-hidden" style={{ backgroundColor: "var(--dash-inset-border)" }}>
                        <div
                          className={`h-full rounded-full ${card.stats.avg_confidence >= 0.7 ? "bg-green-500" : card.stats.avg_confidence >= 0.4 ? "bg-yellow-500" : "bg-red-500"}`}
                          style={{ width: `${Math.round(card.stats.avg_confidence * 100)}%` }}
                        />
                      </div>
                      <span className="text-[10px] font-Poppins dash-text-muted">{Math.round(card.stats.avg_confidence * 100)}%</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Analysis progress — below the grid */}
      {cards.size > 0 && (
        (() => {
          const allCards = Array.from(cards.values());
          const completed = allCards.filter(c => c.status === "complete").length;
          const errors = allCards.filter(c => c.status === "error").length;
          const done = completed + errors;
          const total = allCards.length;
          const pct = total > 0 ? Math.round((done / total) * 100) : 0;
          const totalDefects = allCards.reduce((s, c) => s + (c.stats?.total_defects || 0), 0);
          const avgConf = (() => {
            const confs = allCards.filter(c => c.stats && c.stats.avg_confidence > 0).map(c => c.stats!.avg_confidence);
            return confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
          })();
          const currentlyProcessing = allCards.find(c => c.status === "processing");
          const isRunning = done < total;

          return (
            <div className="glass rounded-2xl border border-[var(--dash-panel-border)] p-5 shadow-premium">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Layers className="text-premium-accent" size={18} />
                  <span className="font-semibold dash-text-primary text-sm">Processing analysis</span>
                </div>
                <span className="text-xs font-Poppins text-premium-accent">{pct}%</span>
              </div>

              <div className="w-full rounded-full h-3 overflow-hidden mb-3" style={{ backgroundColor: "var(--dash-inset-bg)" }}>
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    isRunning
                      ? "bg-gradient-to-r from-cyan-500 to-blue-500"
                      : errors > 0
                      ? "bg-gradient-to-r from-green-500 to-yellow-500"
                      : "bg-gradient-to-r from-green-500 to-emerald-400"
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>

              <div className="flex items-center justify-between text-xs dash-text-muted">
                <div className="flex gap-4">
                  <span>{done} / {total} images</span>
                  {totalDefects > 0 && (
                    <span className="text-red-400">{totalDefects} defect{totalDefects !== 1 ? "s" : ""} found</span>
                  )}
                  {avgConf > 0 && (
                    <span className="text-green-400">Avg: {Math.round(avgConf * 100)}%</span>
                  )}
                </div>
                <div>
                  {isRunning && currentlyProcessing && (
                    <span className="text-premium-accent">
                      Analyzing: {currentlyProcessing.filename.length > 25
                        ? currentlyProcessing.filename.slice(0, 22) + "..."
                        : currentlyProcessing.filename}
                      {currentlyProcessing.status === "processing" && currentlyProcessing.progress > 0
                        ? ` (${Math.round(currentlyProcessing.progress)}%)`
                        : ""}
                    </span>
                  )}
                  {!isRunning && done === total && (
                    <span className="text-green-400 flex items-center gap-1">
                      <CheckCircle2 size={12} /> All images processed
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })()
      )}

      {cards.size === 0 && totalFiles === 0 && (
        <div className="glass rounded-2xl border-2 border-dashed border-[var(--dash-panel-border)] p-12 text-center shadow-premium">
          <Crosshair className="text-4xl dash-text-subtle mx-auto mb-4" />
          <div className="dash-text-body text-lg mb-2">No images uploaded yet</div>
          <div className="dash-text-subtle text-sm">Upload RGB images above to start defect detection</div>
        </div>
      )}

      {/* Preview Modal */}
      {previewId && previewCard && (
        <div className="fixed inset-0 z-50 bg-[var(--dash-overlay-scrim)] flex" onClick={() => setPreviewId(null)}>
          <button
            type="button"
            onClick={() => setPreviewId(null)}
            className="absolute top-4 z-20 rounded-full dash-text-primary p-2 hover:bg-[var(--dash-hover-bg)] transition-colors right-[calc(320px+1rem)]"
            style={{ backgroundColor: "var(--dash-elevated-bg)" }}
            aria-label="Close preview"
          >
            <X size={24} />
          </button>

          {completedCards.length > 1 && (
            <>
              <button
                onClick={e => { e.stopPropagation(); navigatePreview(-1); }}
                className="absolute left-4 top-1/2 -translate-y-1/2 z-10 rounded-full dash-text-primary p-2 hover:bg-[var(--dash-hover-bg)] transition-colors"
                style={{ backgroundColor: "var(--dash-elevated-bg)" }}
              >
                <ChevronLeft size={24} />
              </button>
              <button
                onClick={e => { e.stopPropagation(); navigatePreview(1); }}
                className="absolute top-1/2 z-10 -translate-y-1/2 rounded-full dash-text-primary p-2 hover:bg-[var(--dash-hover-bg)] transition-colors right-[calc(320px+1rem+3.5rem)]"
                style={{ backgroundColor: "var(--dash-elevated-bg)" }}
              >
                <ChevronRight size={24} />
              </button>
            </>
          )}

          {/* Image */}
          <div
            className="flex-1 flex items-center justify-center overflow-auto scrollbar-gutter-stable p-8"
            onClick={e => e.stopPropagation()}
          >
            <div className="relative max-w-full max-h-full">
              <div className="absolute top-2 left-2 z-10 flex items-center gap-1 rounded-lg border border-[var(--dash-panel-border)]" style={{ backgroundColor: "var(--dash-elevated-bg)" }}>
                <button
                  onClick={() =>
                    setModalZoom((z) => Math.max(RGB_PREVIEW_ZOOM_MIN, z - RGB_PREVIEW_ZOOM_STEP))
                  }
                  className="p-1.5 dash-text-primary hover:bg-[var(--dash-hover-bg)] rounded-l-lg"
                >
                  <ZoomOut size={16} />
                </button>
                <span className="px-2 text-xs dash-text-body min-w-[3rem] text-center">{Math.round(modalZoom * 100)}%</span>
                <button
                  onClick={() =>
                    setModalZoom((z) => Math.min(RGB_PREVIEW_ZOOM_MAX, z + RGB_PREVIEW_ZOOM_STEP))
                  }
                  className="p-1.5 dash-text-primary hover:bg-[var(--dash-hover-bg)]"
                >
                  <ZoomIn size={16} />
                </button>
                <button onClick={() => setModalZoom(1)} className="p-1.5 dash-text-primary hover:bg-[var(--dash-hover-bg)] rounded-r-lg border-l border-[var(--dash-panel-border)]"><RotateCcw size={14} /></button>
              </div>
              <div className="absolute top-2 right-2 z-10 rounded-lg border border-[var(--dash-panel-border)] px-3 py-1.5 text-xs dash-text-body" style={{ backgroundColor: "var(--dash-elevated-bg)" }}>
                {previewIndex + 1} / {completedCards.length}
              </div>
              <div
                className="relative inline-block transition-[transform] duration-150 ease-out"
                style={{ transform: `scale(${modalZoom})`, transformOrigin: "center center" }}
              >
                <img
                  ref={previewImgRef}
                  src={previewBaseSrc || ""}
                  alt={previewCard.filename}
                  className="block max-h-[85vh] w-auto rounded-lg object-contain shadow-2xl"
                  draggable={false}
                />
                {previewHasSourceDims ? (
                  <canvas
                    ref={previewCanvasRef}
                    className="pointer-events-none absolute inset-0 h-full w-full rounded-lg"
                    aria-hidden
                  />
                ) : null}
              </div>
            </div>
          </div>

          {/* Detail Panel */}
          <div className="w-[320px] border-l border-[var(--dash-panel-border)] overflow-y-auto flex flex-col" onClick={e => e.stopPropagation()} style={{ backgroundColor: "var(--dash-modal-aside)" }}>
            <div className="p-4 border-b border-[var(--dash-panel-border)]">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1 text-lg font-bold dash-text-primary truncate" title={previewCard.filename}>
                  {previewCard.filename}
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
                  liveOverlayEnabled={previewHasSourceDims}
                />
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className="rounded border border-cyan-500/50 bg-cyan-500/20 px-2 py-0.5 text-xs font-bold text-cyan-300">
                  RGB
                </span>
                {previewCard.stats?.processing_time_ms ? (
                  <span className="text-xs dash-text-muted">{(previewCard.stats.processing_time_ms / 1000).toFixed(1)}s</span>
                ) : null}
              </div>
            </div>

            {previewCard.stats && (
              <div className="p-4 border-b border-[var(--dash-panel-border)] grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs dash-text-muted">Components</div>
                  <div className="text-xl font-bold dash-text-primary">{previewSidebarBuckets.components.length}</div>
                </div>
                <div>
                  <div className="text-xs dash-text-muted">Defects</div>
                  <div className={`text-xl font-bold ${previewSidebarBuckets.defects.length > 0 ? "text-red-400" : "text-green-400"}`}>
                    {previewSidebarBuckets.defects.length}
                  </div>
                </div>
              </div>
            )}

            {/* <div className="p-4 border-b border-[var(--dash-panel-border)]">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-medium dash-text-muted">Confidence Filter</div>
                <span className="text-xs font-Poppins text-premium-accent">&ge; {Math.round(previewConfFilter * 100)}%</span>
              </div>
              <input
                type="range" min="0" max="95" step="5"
                value={Math.round(previewConfFilter * 100)}
                onChange={e => setPreviewConfFilter(parseInt(e.target.value) / 100)}
                className="w-full h-1.5 rounded-lg appearance-none cursor-pointer bg-neutral-700 accent-cyan-500"
              />
              <div className="text-xs dash-text-subtle mt-1">
                Showing {previewDetections.length} of {previewCard.detections.length} detections
              </div>
            </div> */}

            <div className="flex-1 overflow-y-auto p-4">
              {previewDetections.length === 0 ? (
                <div className="text-center py-8 dash-text-subtle text-sm">
                  {previewCard.detections.length === 0
                    ? "No defects detected"
                    : "No detections above threshold"}
                </div>
              ) : (
                <div className="space-y-3">
                  {(
                    [
                      { title: "Components", prefix: "c", items: previewSidebarBuckets.components },
                      { title: "Defects", prefix: "d", items: previewSidebarBuckets.defects },
                    ] as const
                  ).map(
                    ({ title, prefix, items }) =>
                      items.length > 0 && (
                        <div key={title}>
                          <div className="text-xs font-semibold dash-text-body mb-1.5">{title}</div>
                          <div className="space-y-1">
                            {items.map(({ key }) => (
                              <div
                                key={`${prefix}-${key}`}
                                className="flex items-center py-1 text-xs rounded-lg border border-[var(--dash-panel-border)] px-3"
                              >
                                <span className="min-w-0 truncate dash-text-primary" title={formatDetectionSidebarLabel(key)}>
                                  {formatDetectionSidebarLabel(key)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
}
