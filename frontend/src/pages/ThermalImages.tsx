import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { toast } from "../components/Toast";
import MediaUploadBox from "../components/MediaUploadBox";
import {
  ThermalAnalysisDetailModal,
  ThermalAnalysisConfigurationInteractive,
  type ThermalStats,
  type ThermalAnalysisData,
  type ThermalTempUnit,
} from "../components/ThermalAnalysisDetailModal";
import {
  Thermometer,
  Upload,
  Activity,
  CheckCircle2,
  XCircle,
  ArrowLeft,
  Clock,
  Trash2,
  Layers,
  FileImage,
  X,
} from "lucide-react";
import { io, type Socket } from "socket.io-client";

const POLL_MS = 2000;

export type ThermalImagesProps = { embedded?: boolean };

type LocalFile = {
  id: string;
  file: File;
  preview: string;
};

type CardData = {
  localId?: string;
  fileId?: string;
  filename: string;
  localPreview?: string;
  status: "pending" | "uploading" | "queued" | "processing" | "complete" | "error";
  progress: number;
  progressLabel: string;
  thermalImageB64?: string;
  thermalImageUrl?: string;
  stats?: ThermalStats;
  analysis?: ThermalAnalysisData;
  unit?: string;
  error?: string;
};

type SdkHealth = {
  ok: boolean;
  sdk_initialized: boolean;
  sdk_message: string;
};

let _idCounter = 0;
const uid = () => `t_${++_idCounter}_${Date.now()}`;

function unitLabel(u: ThermalTempUnit) {
  return u === "Celsius" ? "°C" : u === "Fahrenheit" ? "°F" : "K";
}

export default function ThermalImages({ embedded = false }: ThermalImagesProps) {
  const reduceMotion = useReducedMotion();
  const transition = { duration: reduceMotion ? 0 : 0.3 };

  const [files, setFiles] = useState<LocalFile[]>([]);
  const [cards, setCards] = useState<Map<string, CardData>>(new Map());
  const [jobId, setJobId] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ completed: 0, total: 0 });
  const [dragActive, setDragActive] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const [palette, setPalette] = useState(2);
  const [unit, setUnit] = useState<ThermalTempUnit>("Celsius");
  const [objectType, setObjectType] = useState("");

  const [sdkHealth, setSdkHealth] = useState<SdkHealth | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [roiActive, setRoiActive] = useState(false);
  const [roiStart, setRoiStart] = useState<{ x: number; y: number } | null>(null);
  const [roiEnd, setRoiEnd] = useState<{ x: number; y: number } | null>(null);
  const [roiStats, setRoiStats] = useState<ThermalStats | null>(null);
  const [roiLoading, setRoiLoading] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const cardsRef = useRef<Map<string, CardData>>(new Map());
  const nameToKeyRef = useRef<Map<string, string>>(new Map());

  /** Prefer server echo of upload row id so results match the right card when filenames repeat. */
  const resolveThermalCardKey = (d: { client_key?: string | number; file_id?: string; filename?: string }) => {
    const ck = d.client_key;
    if (ck != null && String(ck).trim().length > 0) return String(ck);
    return nameToKeyRef.current.get(d.file_id || "") || nameToKeyRef.current.get(d.filename || "");
  };

  const totalFiles = files.length;
  const canStart = totalFiles > 0 && !processing;

  useEffect(() => { jobIdRef.current = jobId; }, [jobId]);
  useEffect(() => { cardsRef.current = cards; }, [cards]);

  useEffect(() => {
    fetchHealth();
    return () => {
      socketRef.current?.disconnect();
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const fetchHealth = async () => {
    try {
      const res = await fetch(`/api/thermal/health`);
      if (res.ok) setSdkHealth(await res.json());
    } catch { /* ignore */ }
  };

  const updateCard = useCallback((key: string, patch: Partial<CardData>) => {
    setCards(prev => {
      const existing = prev.get(key);
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(key, { ...existing, ...patch });
      return next;
    });
  }, []);

  const addFiles = useCallback((fileList: File[]) => {
    const imageFiles = fileList.filter(f => f.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      toast.warning("No image files found", 3000);
      return;
    }
    const newFiles: LocalFile[] = imageFiles.map(file => ({
      id: uid(),
      file,
      preview: URL.createObjectURL(file),
    }));
    setFiles(prev => [...prev, ...newFiles]);
    toast.success(`Added ${imageFiles.length} thermal image(s)`, 2000);
  }, []);

  const removeFile = useCallback((id: string) => {
    setFiles(prev => {
      const f = prev.find(x => x.id === id);
      if (f) URL.revokeObjectURL(f.preview);
      return prev.filter(x => x.id !== id);
    });
  }, []);

  const clearAll = useCallback(() => {
    setFiles((prev) => {
      prev.forEach(f => URL.revokeObjectURL(f.preview));
      return [];
    });
    setCards(new Map());
    setJobId(null);
    setBatchProgress({ completed: 0, total: 0 });
    setProcessing(false);
    setPreviewId(null);
    socketRef.current?.disconnect();
    socketRef.current = null;
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    nameToKeyRef.current.clear();
  }, []);

  const syncFromApi = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/thermal/batch/results/${id}`);
      if (!res.ok) return;
      const body = await res.json();

      setCards(prev => {
        const next = new Map(prev);
        let changed = false;
        (body.results || []).forEach((r: any) => {
          const cardKey = resolveThermalCardKey(r);
          if (!cardKey) return;
          const existing = next.get(cardKey);
          if (existing?.status === "complete") return;
          changed = true;
          next.set(cardKey, {
            ...(existing || {} as CardData),
            fileId: r.file_id,
            status: "complete",
            progress: 100,
            progressLabel: "Complete",
            thermalImageB64: r.thermal_image_base64_png,
            thermalImageUrl: r.thermal_image_url,
            stats: r.stats,
            analysis: r.analysis,
            unit: r.unit,
          });
          nameToKeyRef.current.set(r.file_id, cardKey);
        });
        return changed ? next : prev;
      });

      const total = body.total || (body.results?.length ?? 0);
      const completed = body.completed || (body.results?.length ?? 0);
      setBatchProgress({ completed, total });

      if (body.status === "complete" || completed >= total) {
        setProcessing(false);
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      }
    } catch { /* retry next poll */ }
  }, []);

  const connectSocket = useCallback((id: string) => {
    if (socketRef.current) { socketRef.current.disconnect(); socketRef.current = null; }

    const sock = io({ path: "/socket.io/", transports: ["websocket", "polling"] });
    socketRef.current = sock;

    sock.on("connect", () => {
      sock.emit("subscribe_thermal_job", { job_id: id });
      syncFromApi(id);
    });

    sock.on("thermal_queued", (d: any) => {
      if (d.job_id !== jobIdRef.current) return;
      const cardKey = resolveThermalCardKey(d);
      if (cardKey) {
        nameToKeyRef.current.set(d.file_id, cardKey);
        updateCard(cardKey, { fileId: d.file_id, status: "queued", progressLabel: "Queued" });
      }
    });

    sock.on("thermal_start", (d: any) => {
      if (d.job_id !== jobIdRef.current) return;
      const cardKey = resolveThermalCardKey(d);
      if (cardKey) updateCard(cardKey, { status: "processing", progressLabel: "Analyzing..." });
    });

    sock.on("thermal_result", (d: any) => {
      if (d.job_id !== jobIdRef.current) return;
      const cardKey = resolveThermalCardKey(d);
      if (cardKey) {
        if (d.error) {
          updateCard(cardKey, { status: "error", error: d.error });
        } else {
          updateCard(cardKey, {
            fileId: d.file_id,
            status: "complete",
            progress: 100,
            progressLabel: "Complete",
            thermalImageB64: d.thermal_image_base64_png,
            thermalImageUrl: d.thermal_image_url,
            stats: d.stats,
            analysis: d.analysis,
            unit: d.unit,
          });
        }
      }
      setBatchProgress({ completed: d.completed || 0, total: d.total || 0 });
    });

    sock.on("thermal_batch_complete", (d: any) => {
      if (d.job_id !== jobIdRef.current) return;
      setBatchProgress({ completed: d.total_files, total: d.total_files });
      setProcessing(false);
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      toast.success(`Thermal analysis complete! ${d.total_files} files processed.`, 5000);
    });
  }, [syncFromApi, updateCard]);

  const startAnalysis = useCallback(async () => {
    if (files.length === 0) return;
    setProcessing(true);
    nameToKeyRef.current.clear();

    const newCards = new Map<string, CardData>();
    files.forEach(lf => {
      newCards.set(lf.id, {
        localId: lf.id,
        filename: lf.file.name,
        localPreview: lf.preview,
        status: "pending",
        progress: 0,
        progressLabel: "Pending",
      });
      nameToKeyRef.current.set(lf.file.name, lf.id);
    });
    setCards(newCards);
    setBatchProgress({ completed: 0, total: files.length });

    try {
      const batchRes = await fetch(`/api/thermal/batch/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          total: files.length,
          palette,
          unit,
          object_type: objectType || null,
        }),
      });
      if (!batchRes.ok) {
        const errText = await batchRes.text().catch(() => "");
        throw new Error(errText || `Server returned ${batchRes.status}`);
      }
      const { job_id } = await batchRes.json();
      setJobId(job_id);
      jobIdRef.current = job_id;

      connectSocket(job_id);

      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => syncFromApi(job_id), POLL_MS);

      const CONCURRENT = 3;
      const queue = [...files];

      const uploadOne = async (lf: LocalFile) => {
        updateCard(lf.id, { status: "uploading", progressLabel: "Uploading..." });
        const formData = new FormData();
        formData.append("job_id", job_id);
        formData.append("client_key", lf.id);
        formData.append("file", lf.file, lf.file.name);
        try {
          const uploadRes = await fetch(`/api/thermal/batch/file`, { method: "POST", body: formData });
          if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status}`);
          const up = (await uploadRes.json().catch(() => null)) as { file_id?: string } | null;
          if (up?.file_id) nameToKeyRef.current.set(up.file_id, lf.id);
          setCards(prev => {
            const existing = prev.get(lf.id);
            if (existing && existing.status === "uploading") {
              const next = new Map(prev);
              next.set(lf.id, { ...existing, status: "queued", progressLabel: "Queued" });
              return next;
            }
            return prev;
          });
        } catch (err: any) {
          updateCard(lf.id, { status: "error", error: err.message || "Upload failed" });
        }
      };

      const workers = Array.from({ length: Math.min(CONCURRENT, queue.length) }, async () => {
        while (queue.length > 0) {
          const lf = queue.shift()!;
          await uploadOne(lf);
        }
      });
      await Promise.all(workers);

      toast.info(`Uploaded ${files.length} files. Thermal analysis in progress...`, 3000);
    } catch (err: any) {
      toast.error(`Failed to start analysis: ${err.message}`, 5000);
      setProcessing(false);
    }
  }, [files, palette, unit, objectType, connectSocket, syncFromApi, updateCard]);

  const completedCards = useMemo(() =>
    Array.from(cards.entries()).filter(([, c]) => c.status === "complete").map(([key]) => key),
    [cards]
  );

  const previewCard = previewId ? cards.get(previewId) : null;

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

  const handleRoiMouseDown = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    if (!roiActive) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * (previewCard?.stats?.width || 640));
    const y = Math.round(((e.clientY - rect.top) / rect.height) * (previewCard?.stats?.height || 512));
    setRoiStart({ x, y });
    setRoiEnd(null);
    setRoiStats(null);
  }, [roiActive, previewCard]);

  const handleRoiMouseUp = useCallback(async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!roiActive || !roiStart) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * (previewCard?.stats?.width || 640));
    const y = Math.round(((e.clientY - rect.top) / rect.height) * (previewCard?.stats?.height || 512));
    setRoiEnd({ x, y });

    const lf = files.find(f => f.id === previewId);
    if (!lf) return;

    setRoiLoading(true);
    try {
      const form = new FormData();
      form.append("image", lf.file);
      form.append("x1", String(Math.min(roiStart.x, x)));
      form.append("y1", String(Math.min(roiStart.y, y)));
      form.append("x2", String(Math.max(roiStart.x, x)));
      form.append("y2", String(Math.max(roiStart.y, y)));
      form.append("unit", unit);
      const res = await fetch(`/api/thermal/roi`, { method: "POST", body: form });
      if (res.ok) {
        const data = await res.json();
        setRoiStats(data.stats ?? data);
      }
    } catch { /* ignore */ } finally {
      setRoiLoading(false);
    }
  }, [roiActive, roiStart, previewCard, previewId, files, unit]);

  const u = unitLabel(unit);

  return (
    <div className="space-y-6">
      {/* Header — embedded: two cards so the left column is not stretched to the config height (removes empty band under actions). */}
      {embedded ? (
        <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={transition}
            className="glass w-full min-w-0 flex-1 rounded-2xl border border-neutral-800 p-6 shadow-premium"
          >
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <Thermometer className="text-emerald-400" size={22} />
              <div className="text-sm font-medium uppercase tracking-wider text-emerald-400">Thermal Analysis</div>
              {sdkHealth && (
                <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                  sdkHealth.sdk_initialized
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                    : "border-red-500/30 bg-red-500/10 text-red-400"
                }`}>
                  {sdkHealth.sdk_initialized ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
                  DJI SDK {sdkHealth.sdk_initialized ? "Ready" : "Offline"}
                </span>
              )}
            </div>
            <h1 className="mb-2 text-2xl font-bold text-white">DJI R-JPEG Thermal Processing</h1>
            <p className="text-sm leading-relaxed text-neutral-300">
              Upload DJI R-JPEG thermal images for batch analysis. Temperature mapping, metadata extraction,
              environmental data, and correction insights — processed in queue.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {totalFiles > 0 && !processing && (
                <button
                  type="button"
                  onClick={clearAll}
                  className="flex items-center gap-2 rounded-xl border border-neutral-700 glass px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-premium-card-hover"
                >
                  <Trash2 size={16} /> Clear All
                </button>
              )}
              <button
                type="button"
                onClick={startAnalysis}
                disabled={!canStart}
                className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-5 py-2.5 text-sm font-semibold text-white transition-all hover:shadow-lg disabled:opacity-60"
              >
                {processing ? (
                  <>
                    <Clock className="animate-spin" size={16} /> Processing...
                  </>
                ) : (
                  <>
                    <Activity size={16} /> Start Analysis{totalFiles > 0 ? ` (${totalFiles})` : ""}
                  </>
                )}
              </button>
            </div>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...transition, delay: reduceMotion ? 0 : 0.05 }}
            className="glass w-full shrink-0 rounded-2xl border border-neutral-800 bg-premium-card/20 p-5 shadow-premium xl:max-w-md"
          >
            <ThermalAnalysisConfigurationInteractive
              objectType={objectType}
              onObjectTypeChange={setObjectType}
              palette={palette}
              onPaletteChange={setPalette}
              unit={unit}
              onUnitChange={setUnit}
              processing={processing}
              hideEmissivityPaletteSection={embedded}
              hideTemperatureUnitSection={embedded}
            />
          </motion.div>
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={transition}
          className="glass rounded-2xl border border-neutral-800 p-6 shadow-premium"
        >
          <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0 flex-1">
              <div className="mb-2 flex flex-wrap items-center gap-3">
                <Link to="/dashboard" className="text-neutral-400 hover:text-white transition-colors">
                  <ArrowLeft size={20} />
                </Link>
                <Thermometer className="text-emerald-400" size={22} />
                <div className="text-sm font-medium uppercase tracking-wider text-emerald-400">Thermal Analysis</div>
                {sdkHealth && (
                  <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                    sdkHealth.sdk_initialized
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                      : "border-red-500/30 bg-red-500/10 text-red-400"
                  }`}>
                    {sdkHealth.sdk_initialized ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
                    DJI SDK {sdkHealth.sdk_initialized ? "Ready" : "Offline"}
                  </span>
                )}
              </div>
              <h1 className="mb-2 text-2xl font-bold text-white">DJI R-JPEG Thermal Processing</h1>
              <p className="text-sm leading-relaxed text-neutral-300">
                Upload DJI R-JPEG thermal images for batch analysis. Temperature mapping, metadata extraction,
                environmental data, and correction insights — processed in queue.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {totalFiles > 0 && !processing && (
                  <button
                    type="button"
                    onClick={clearAll}
                    className="flex items-center gap-2 rounded-xl border border-neutral-700 glass px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-premium-card-hover"
                  >
                    <Trash2 size={16} /> Clear All
                  </button>
                )}
                <button
                  type="button"
                  onClick={startAnalysis}
                  disabled={!canStart}
                  className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-5 py-2.5 text-sm font-semibold text-white transition-all hover:shadow-lg disabled:opacity-60"
                >
                  {processing ? (
                    <>
                      <Clock className="animate-spin" size={16} /> Processing...
                    </>
                  ) : (
                    <>
                      <Activity size={16} /> Start Analysis{totalFiles > 0 ? ` (${totalFiles})` : ""}
                    </>
                  )}
                </button>
              </div>
            </div>
            <div className="w-full shrink-0 rounded-xl border border-neutral-800 bg-premium-card/20 p-5 xl:max-w-md">
              <ThermalAnalysisConfigurationInteractive
                objectType={objectType}
                onObjectTypeChange={setObjectType}
                palette={palette}
                onPaletteChange={setPalette}
                unit={unit}
                onUnitChange={setUnit}
                processing={processing}
                hideEmissivityPaletteSection={false}
                hideTemperatureUnitSection={false}
              />
            </div>
          </div>
        </motion.div>
      )}

      {/* Upload */}
      <div className="grid grid-cols-1 gap-6">
        <motion.div
          initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
          transition={{ ...transition, delay: reduceMotion ? 0 : 0.05 }}
          className="glass rounded-2xl border border-neutral-800 p-6 shadow-premium"
        >
          <div className="flex items-center gap-2 mb-4">
            <Upload className="text-emerald-400" size={20} />
            <h2 className="font-semibold text-white text-lg">Image Upload</h2>
          </div>

          <MediaUploadBox
            accent="emerald"
            dragActive={dragActive}
            disabled={processing}
            hasFiles={files.length > 0}
            onDragEnter={e => { e.preventDefault(); e.stopPropagation(); setDragActive(true); }}
            onDragLeave={e => { e.preventDefault(); e.stopPropagation(); setDragActive(false); }}
            onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
            onDrop={e => {
              e.preventDefault();
              e.stopPropagation();
              setDragActive(false);
              if (e.dataTransfer.files?.length) addFiles(Array.from(e.dataTransfer.files));
            }}
            inputId="thermal-upload"
            accept="image/*"
            multiple
            onInputChange={e => {
              if (e.target.files?.length) addFiles(Array.from(e.target.files));
              e.target.value = "";
            }}
            addMoreInputId="thermal-add-more"
            onAddMoreChange={e => {
              if (e.target.files?.length) addFiles(Array.from(e.target.files));
              e.target.value = "";
            }}
            emptyIcon={<Thermometer className="text-3xl text-neutral-500 mx-auto" size={36} />}
            emptyDescription="Drop thermal images here or click to browse"
            primaryButtonLabel="Select Thermal Images"
            footerNote="DJI R-JPEG radiometric thermal images for temperature analysis"
          >
            <div className="flex items-center gap-2 text-sm text-emerald-400">
              <CheckCircle2 size={16} />
              <span>{files.length} thermal image(s) selected</span>
            </div>
            <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto">
              {files.map(f => (
                <div key={f.id} className="relative group">
                  <img src={f.preview} alt={f.file.name} className="w-16 h-16 object-cover rounded-lg border border-neutral-700" />
                  {!processing && (
                    <button
                      type="button"
                      onClick={() => removeFile(f.id)}
                      className="absolute -top-1 -right-1 bg-red-500 rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X size={10} className="text-white" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </MediaUploadBox>

          {totalFiles > 0 && !processing && (
            <div className="mt-3 rounded-xl bg-premium-card/50 border border-neutral-700 p-3">
              <div className="flex items-center justify-between">
                <div className="text-sm text-white font-medium">{totalFiles} file{totalFiles !== 1 ? "s" : ""} ready</div>
                <span className="text-xs text-emerald-400">{totalFiles} Thermal</span>
              </div>
            </div>
          )}
        </motion.div>
      </div>

      {/* Progress */}
      {processing && (
        <div className="glass rounded-2xl border border-emerald-500/50 bg-emerald-500/10 p-4 shadow-premium">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Clock className="text-emerald-400 animate-spin" size={18} />
              <span className="font-semibold text-white">Processing Thermal Images</span>
            </div>
            <span className="text-sm text-neutral-300">
              {batchProgress.total > 0 ? `${Math.round((batchProgress.completed / batchProgress.total) * 100)}%` : "—"}
            </span>
          </div>
          <div className="w-full bg-neutral-800 rounded-full h-2.5 overflow-hidden">
            {batchProgress.total > 0 ? (
              <div className="bg-gradient-to-r from-emerald-500 to-teal-500 h-full transition-all duration-300 rounded-full" style={{ width: `${(batchProgress.completed / batchProgress.total) * 100}%` }} />
            ) : (
              <div className="h-full w-1/3 animate-progress-indeterminate rounded-full bg-gradient-to-r from-transparent via-emerald-500/70 to-transparent" />
            )}
          </div>
          <div className="mt-2 text-xs text-neutral-400">
            {batchProgress.total > 0 ? `${batchProgress.completed} of ${batchProgress.total} files completed` : "Uploading files..."}
          </div>
        </div>
      )}

      {/* Results Grid */}
      {cards.size > 0 && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <Layers className="text-emerald-400" size={20} />
              Analysis Results ({cards.size})
            </h2>
            <div className="flex gap-3 text-xs text-neutral-400">
              {(() => {
                const completed = Array.from(cards.values()).filter(c => c.status === "complete").length;
                const errors = Array.from(cards.values()).filter(c => c.status === "error").length;
                const active = Array.from(cards.values()).filter(c => ["processing", "queued", "uploading"].includes(c.status)).length;
                return (
                  <>
                    {completed > 0 && <span className="text-emerald-400">&#x2713; {completed} complete</span>}
                    {active > 0 && <span className="text-cyan-400">&#x21BB; {active} processing</span>}
                    {errors > 0 && <span className="text-red-400">&#x2717; {errors} failed</span>}
                  </>
                );
              })()}
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {Array.from(cards.entries()).map(([key, card]) => (
              <div
                key={key}
                onClick={() => card.status === "complete" && setPreviewId(key)}
                className={`rounded-xl border overflow-hidden transition-all group ${
                  card.status === "complete"
                    ? "border-emerald-500/30 bg-emerald-500/5 cursor-pointer hover:shadow-glow hover:border-emerald-400/50"
                    : card.status === "error"
                    ? "border-red-500/30 bg-red-500/5"
                    : card.status === "processing"
                    ? "border-emerald-500/50 bg-emerald-500/5"
                    : "border-neutral-800 bg-premium-card/30"
                }`}
              >
                <div className="relative aspect-square bg-neutral-800 overflow-hidden">
                  {card.status === "complete" && card.thermalImageB64 ? (
                    <img src={`data:image/png;base64,${card.thermalImageB64}`} alt={card.filename} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200" loading="lazy" />
                  ) : card.status === "complete" && card.thermalImageUrl ? (
                    <img src={card.thermalImageUrl} alt={card.filename} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200" loading="lazy" />
                  ) : card.localPreview ? (
                    <img src={card.localPreview} alt={card.filename} className="w-full h-full object-cover opacity-50" loading="lazy" />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center"><FileImage className="text-neutral-600" size={32} /></div>
                  )}

                  {card.status !== "complete" && card.status !== "error" && (
                    <div className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center gap-2">
                      {card.status === "processing" ? <Clock className="text-emerald-400 animate-spin" size={24} /> : <Clock className="text-neutral-400" size={24} />}
                      <span className="text-[10px] text-white font-medium px-2 text-center">{card.progressLabel}</span>
                    </div>
                  )}

                  {card.status === "error" && (
                    <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center gap-1 px-2">
                      <XCircle className="text-red-400" size={24} />
                      <span className="text-[10px] text-red-300 text-center">{card.error || "Error"}</span>
                    </div>
                  )}

                  <div className="absolute top-1 left-1">
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-500/80 text-white">THERMAL</span>
                  </div>

                  {card.status === "complete" && (
                    <div className="absolute bottom-1 right-1"><CheckCircle2 className="text-emerald-400 drop-shadow-lg" size={16} /></div>
                  )}
                </div>
                <div className="p-2">
                  <p className="text-[11px] truncate font-medium text-white" title={card.filename}>{card.filename}</p>
                  {card.status === "complete" && card.stats && (
                    <div className="mt-1 text-[10px] text-neutral-400">
                      {card.stats.min_c != null ? card.stats.min_c.toFixed(1) : "—"}–{card.stats.max_c != null ? card.stats.max_c.toFixed(1) : "—"} {u}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <ThermalAnalysisDetailModal
        open={Boolean(previewId && previewCard)}
        onClose={() => {
          setPreviewId(null);
          setRoiActive(false);
          setRoiStart(null);
          setRoiEnd(null);
          setRoiStats(null);
        }}
        filename={previewCard?.filename ?? ""}
        thermalImageB64={previewCard?.thermalImageB64}
        thermalImageUrl={previewCard?.thermalImageUrl}
        stats={previewCard?.stats}
        analysis={previewCard?.analysis}
        unit={previewCard?.unit ?? unit}
        fileIndexDisplay={previewId ? Math.max(0, completedCards.indexOf(previewId)) : 0}
        fileCountDisplay={completedCards.length}
        onPrev={() => navigatePreview(-1)}
        onNext={() => navigatePreview(1)}
        exporting={exporting === previewId}
        roiActive={roiActive}
        onToggleRoi={() => {
          setRoiActive((a) => !a);
          setRoiStart(null);
          setRoiEnd(null);
          setRoiStats(null);
        }}
        roiStart={roiStart}
        roiEnd={roiEnd}
        roiStats={roiStats}
        roiLoading={roiLoading}
        onImageMouseDown={handleRoiMouseDown}
        onImageMouseUp={handleRoiMouseUp}
        analysisConfiguration={{
          objectType: objectType || null,
          paletteId: palette,
        }}
      />
    </div>
  );
}
