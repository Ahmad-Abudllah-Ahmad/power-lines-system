// API Gateway URL - routes to appropriate microservices
export const API_BASE = import.meta.env.VITE_API_BASE || "";

// API Configuration
const DEFAULT_TIMEOUT = 30000; // 30 seconds
const MAX_RETRIES = 2;
const RETRY_DELAY = 1000; // 1 second

// Types
export type Tower = {
  id: string;
  name: string;
  corridor: string;
  lat: number;
  lng: number;
  last_scan: string;
  status: "HEALTHY" | "MONITOR" | "REQUIRES_INSPECTION";
  ai_confidence: number;
  sensors: string[];
  hero_image: string;
  thermal_image?: string;
  voltage_kv?: string;
  tower_type?: string;
  region?: string;
  corridor_tag?: string | null;
  image_dimensions?: { width: number; height: number };
  annotated_image?: string;
  detection_crops?: Array<{
    finding_id: string;
    crop_path: string;
    crop_filename: string;
    bbox: [number, number, number, number];
    crop_size: { width: number; height: number };
    detection_area_percent: number;
  }>;
};

export type Finding = {
  id: string;
  type: string;
  label: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  bbox_xyxy: [number, number, number, number];
  source: "RGB" | "Thermal";
  confidence: number;
  grade?: number;
  distance_m?: number;
  notes?: string;
  image_dimensions?: { width: number; height: number };
  detection_area_percent?: number;
  // Thermal-part correlation (from 3-model pipeline)
  correlated_part?: {
    type: string;
    label: string;
    part_id: string;
    distance_pixels: number;
    confidence: number;
  };
};

// API Request Options
interface ApiRequestOptions extends RequestInit {
  timeout?: number;
  retries?: number;
  skipErrorHandling?: boolean;
}

// Central fetch wrapper with timeout, retries, and error handling
async function apiFetch<T>(
  endpoint: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  const {
    timeout = DEFAULT_TIMEOUT,
    retries = MAX_RETRIES,
    skipErrorHandling = false,
    ...fetchOptions
  } = options;

  const url = endpoint.startsWith("http") ? endpoint : `${API_BASE}${endpoint}`;

  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...fetchOptions.headers,
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorMessage = `Request failed: ${response.status} ${response.statusText}`;
        
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorData.detail || errorMessage;
        } catch {
          try {
            const errorText = await response.text();
            if (errorText) {
              errorMessage = errorText.length > 200 
                ? errorText.substring(0, 200) + "..." 
                : errorText;
            }
          } catch {
            // Use default error message
          }
        }

        // Provide user-friendly error messages
        if (response.status === 400) {
          errorMessage = `Invalid request: ${errorMessage}`;
        } else if (response.status === 401) {
          errorMessage = "Unauthorized. Please check your credentials.";
        } else if (response.status === 403) {
          errorMessage = "Forbidden. You don't have permission to access this resource.";
        } else if (response.status === 404) {
          errorMessage = "Resource not found.";
        } else if (response.status === 502 || response.status === 503) {
          errorMessage = "Service unavailable. Please ensure the backend services are running.";
        } else if (response.status === 500) {
          errorMessage = `Server error: ${errorMessage}`;
        }

        const error = new Error(errorMessage);
        (error as any).status = response.status;
        throw error;
      }

      // Try to parse JSON, fallback to text
      try {
        const data = await response.json();
        return data as T;
      } catch {
        // If response is not JSON, return empty object or text
        const text = await response.text();
        return (text ? JSON.parse(text) : {}) as T;
      }
    } catch (error: any) {
      clearTimeout(timeoutId);
      lastError = error;

      // Don't retry on abort (timeout) or client errors (4xx)
      if (error.name === "AbortError") {
        throw new Error(`Request timeout: The request took longer than ${timeout}ms`);
      }

      if (error.status && error.status >= 400 && error.status < 500) {
        throw error;
      }

      // Retry logic
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY * (attempt + 1)));
        continue;
      }

      // Network errors
      if (error instanceof TypeError && error.message.includes("fetch")) {
        throw new Error(
          `Network error: Cannot connect to API at ${API_BASE}. Please ensure the backend services are running.`
        );
      }

      throw error;
    }
  }

  throw lastError || new Error("Request failed after retries");
}

// Health check function - prefers dedicated /health endpoint, falls back to /api/summary
// Uses longer timeouts so we don't show "Offline" when the server is busy (e.g. bulk image processing)
export async function checkApiHealth(): Promise<{ healthy: boolean; latency?: number }> {
  try {
    const startTime = Date.now();
    // Try dedicated health endpoint first (fast, lightweight)
    try {
      const health = await apiFetch<{ ok?: boolean; status?: string; version?: string }>("/health", {
        timeout: 15000, // Longer timeout when server is busy (bulk processing, etc.)
        retries: 0,
      });
      const latency = Date.now() - startTime;
      return { healthy: health.ok !== false, latency };
    } catch {
      // Fallback to /api/summary if /health doesn't exist
      await apiFetch<{ status?: string }>("/api/summary", {
        timeout: 20000, // Longer timeout for fallback when server is under load
        retries: 0,
      });
      const latency = Date.now() - startTime;
      return { healthy: true, latency };
    }
  } catch {
    return { healthy: false };
  }
}

// API Endpoints
export async function runPipelineDemo(): Promise<{ steps?: Array<{ id: string; detail?: string }> }> {
  return apiFetch(`${API_BASE}/api/pipeline/demo`, {
    method: "POST",
    timeout: 60000, // Longer timeout for pipeline operations
  });
}

export async function runPipeline(payload: {
  tower_id?: string;
  rgb_base64: string;
  filename?: string;
  thermal_base64?: string;
  ambient_c?: number;
  voltage_kv?: string;
  tower_type?: string;
  region?: string;
  corridor_tag?: string;
  gps?: { lat: number; lng: number };
}) {
  return apiFetch<{
    run_id?: string;
    tower_id?: string;
    status?: string;
    error?: string;
  }>("/api/pipeline/run", {
    method: "POST",
    body: JSON.stringify(payload),
    timeout: 660000, // 11 minutes (600s pipeline + 60s buffer) for pipeline processing
  });
}

export async function bulkProcess(payload: {
  images: Array<{
    filename: string;
    rgb_base64: string;
    thermal_base64?: string;
    tower_id?: string;
  }>;
  organize_by_defect?: boolean;
}) {
  return apiFetch<{
    batch_id: string;
    batch_dir: string;
    total_images: number;
    processed: number;
    failed: number;
    runs: string[];
    organization: {
      enabled: boolean;
      folders: Record<string, number>;
      details: Record<string, Array<{
        filename: string;
        run_id: string;
        defect_type: string;
        detection_count: number;
      }>>;
    };
  }>("/api/pipeline/bulk", {
    method: "POST",
    body: JSON.stringify(payload),
    timeout: 3600000, // 1 hour for large batches
  });
}

export async function getSummary() {
  return apiFetch<{
    towers_total: number;
    findings_total: number;
    avg_ai_confidence: number;
    status_counts: {
      HEALTHY: number;
      MONITOR: number;
      REQUIRES_INSPECTION: number;
    };
  }>("/api/summary");
}

export async function getTowers(): Promise<Tower[]> {
  return apiFetch<Tower[]>("/api/towers");
}

export async function getTower(id: string): Promise<Tower> {
  return apiFetch<Tower>(`/api/towers/${id}`);
}

export async function getFindings(id: string): Promise<Finding[]> {
  return apiFetch<Finding[]>(`/api/towers/${id}/findings`);
}

export function reportUrl(id: string) {
  return `${API_BASE}/api/towers/${id}/report.pdf`;
}

export async function runLiveDetection(payload: {
  rgb_base64: string;
}) {
  return apiFetch(`${API_BASE}/api/pipeline/live`, {
    method: "POST",
    body: JSON.stringify(payload),
    timeout: 60000,
  });
}

export async function getEvaluationReports() {
  return apiFetch<Array<{ filename: string; created_at: string; size?: number }>>(
    "/api/reports/evaluations"
  );
}

export async function getMetricsSummary() {
  return apiFetch<{
    total_evaluations?: number;
    avg_accuracy?: number;
    [key: string]: any;
  }>("/api/reports/metrics-summary");
}

export function evaluationReportUrl(filename: string) {
  return `${API_BASE}/api/reports/evaluations/${filename}`;
}

export async function getLatestBulkBatch() {
  return apiFetch<{
    batch_id: string;
    batch_dir: string;
    total_images: number;
    processed: number;
    failed: number;
    runs: string[];
    organization: {
      enabled: boolean;
      folders: Record<string, number>;
      details: Record<string, Array<{
        filename: string;
        run_id: string;
        defect_type: string;
        detection_count: number;
      }>>;
    };
  }>("/api/bulk-batches/latest", {
    timeout: 10000,
    retries: 0,
    skipErrorHandling: true, // Don't show error if no batches exist
  }).catch(() => null); // Return null if not found instead of throwing
}

/** URL for downloading bulk batch PDF report */
export function bulkBatchReportUrl(batchId: string): string {
  const path = `/api/bulk-batches/${encodeURIComponent(batchId)}/report`;
  return path.startsWith("http") ? path : `${API_BASE}${path}`;
}

export async function getRecentBulkBatches(limit: number = 5) {
  return apiFetch<
    {
      batch_id: string;
      batch_dir: string;
      total_images: number;
      processed: number;
      failed: number;
      runs: string[];
      organization: {
        enabled: boolean;
        folders: Record<string, number>;
        details?: Record<string, Array<{
          filename: string;
          run_id: string;
          defect_type: string;
          detection_count: number;
        }>>;
      };
    }[]
  >(`/api/bulk-batches/recent?limit=${limit}`, {
    timeout: 10000,
    retries: 0,
    skipErrorHandling: true,
  }).catch(() => []); // Return empty array if not found
}

// Run/Pipeline execution types
// List contract: keep /api/runs lightweight (no full detections)
export type Run = {
  id: string;
  run_id?: string; // Alternative field name from backend
  tower_id?: string;
  status: "pending" | "processing" | "completed" | "failed";
  created_at?: string; // Backend may send only timestamp
  completed_at?: string;
  findings_count?: number;
  must_review_count?: number;
  ai_confidence?: number;
  avg_confidence?: number; // Alias for AI confidence
  error?: string;
  timestamp?: string; // Legacy list/detail; use created_at ?? timestamp for display
  gps?: { lat: number; lng: number }; // Optional; used by CorridorMap when present
  metadata?: {
    voltage_kv?: string;
    tower_type?: string;
    region?: string;
    corridor_tag?: string;
    gps?: { lat: number; lng: number }; // Alternative location when backend nests gps in metadata
  };
};

// Artifacts: prefer *_url from backend; support legacy *_path when present
export type RunArtifacts = {
  overlay_url?: string;
  report_url?: string;
  annotated_url?: string;
  thermal_url?: string;
  overlay_path?: string;
  report_path?: string;
  annotated_image?: string;
  thermal_overlay?: string;
};

export type RunDetail = Run & {
  detections?: Array<{
    component_type: string;
    bbox: [number, number, number, number];
    det_conf: number;
    defect_type?: string;
    defect_conf?: number;
    thermal_flag?: boolean;
    severity: "HIGH" | "MEDIUM" | "LOW";
    status: "confirmed" | "needs_review" | "false_positive";
  }>;
  artifacts?: RunArtifacts;
  metadata?: {
    gps?: { lat: number; lng: number };
    timestamp?: string;
    phase?: string;
    ambient_c?: number;
    thermal_insights?: {
      temp_min?: number | null;
      temp_max?: number | null;
      temp_mean?: number | null;
      ambient_used?: number;
      raw_output?: string;
      roi_analysis?: { Tp_max?: number; Tw_max?: number; dT?: number; hot_area_ratio?: number; severity?: string };
    };
  };
  error?: string;
};

// Get list of runs/scans
export async function getRuns(): Promise<Run[]> {
  return apiFetch<Run[]>("/api/runs");
}

// Get single run detail
export async function getRun(id: string): Promise<RunDetail> {
  return apiFetch<RunDetail>(`/api/runs/${id}`);
}

// Build artifact URL when backend does not return *_url. Convention: GET /api/runs/:id/artifacts/:type
export function runArtifactUrl(runId: string, artifactType: "overlay" | "report" | "annotated" | "thermal"): string {
  const path = `/api/runs/${runId}/artifacts/${artifactType}`;
  return path.startsWith("http") ? path : `${API_BASE}${path}`;
}

// Resolve artifact URL: prefer backend *_url; support legacy *_path; then convention /api/runs/:id/artifacts/:type
export function resolveArtifactUrl(
  artifacts: RunArtifacts | Record<string, unknown>,
  runId: string,
  type: "overlay" | "report" | "annotated" | "thermal"
): string | undefined {
  const a = artifacts as RunArtifacts;
  const url =
    type === "overlay" ? a.overlay_url ?? (a.overlay_path ? runArtifactUrl(runId, "overlay") : undefined)
    : type === "report" ? a.report_url ?? (a.report_path ? runArtifactUrl(runId, "report") : undefined)
    : type === "annotated" ? a.annotated_url ?? (a.annotated_image ? runArtifactUrl(runId, "annotated") : undefined)
    : type === "thermal" ? a.thermal_url ?? (a.thermal_overlay ? runArtifactUrl(runId, "thermal") : undefined)
    : undefined;
  if (!url) return undefined;
  return url.startsWith("http") ? url : `${API_BASE}${url}`;
}

// Overlay gallery: list per-run overlay files (legacy overlays/ folder)
export type OverlayItem = {
  filename: string;
  url: string;
  /** First token from filename (e.g. broken, rust, normal). Backend may omit in older responses. */
  tag?: string;
  /** HIGH | MEDIUM | LOW from tag. Backend may omit in older responses. */
  severity?: string;
  /** Middle part of filename (e.g. DJI_0437). Backend may omit in older responses. */
  stem?: string;
};

export async function listOverlays(runId: string): Promise<OverlayItem[]> {
  const data = await apiFetch<OverlayItem[]>(`/api/runs/${runId}/artifacts/overlays`);
  return Array.isArray(data) ? data : [];
}

// Full URL for one overlay image (for <img src>)
export function overlayFileUrl(runId: string, filename: string): string {
  const path = `/api/runs/${runId}/artifacts/overlays/${encodeURIComponent(filename)}`;
  return path.startsWith("http") ? path : `${API_BASE}${path}`;
}

// Download-all overlays ZIP
export function overlaysZipUrl(runId: string): string {
  const path = `/api/runs/${runId}/artifacts/overlays.zip`;
  return path.startsWith("http") ? path : `${API_BASE}${path}`;
}

export type VideoProcessingResult = {
  video_id: string;
  status: string;
  processed_frames: number;
  total_detections: number;
  defect_summary: Record<string, number>;
  results_url: string;
};

export async function processVideo(
  videoFile: File,
  frameInterval: number = 1,
  towerId?: string
): Promise<VideoProcessingResult> {
  const formData = new FormData();
  formData.append("video_file", videoFile);
  formData.append("frame_interval", frameInterval.toString());
  if (towerId) {
    formData.append("tower_id", towerId);
  }

  const response = await fetch(`${API_BASE}/api/pipeline/video`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "Video processing failed" }));
    throw new Error(error.detail || "Video processing failed");
  }

  return response.json();
}

export async function getVideoResults(videoId: string): Promise<any> {
  const response = await fetch(`${API_BASE}/api/videos/${videoId}/results`);
  if (!response.ok) {
    throw new Error("Failed to fetch video results");
  }
  return response.json();
}

export function videoFrameUrl(videoId: string, frameFilename: string): string {
  return `${API_BASE}/api/videos/${videoId}/frames/${frameFilename}`;
}

export function videoWithOverlaysUrl(videoId: string): string {
  return `${API_BASE}/api/videos/${videoId}/download`;
}

export type VideoResult = {
  video_id: string;
  tower_id?: string;
  status: string;
  created_at: string;
  completed_at: string;
  video_info: {
    filename: string;
    duration_seconds: number;
    fps: number;
    total_frames: number;
    extracted_frames: number;
    frame_interval: number;
  };
  processing_stats: {
    processed_frames: number;
    failed_frames: number;
    total_detections: number;
    average_confidence: number;
  };
  defect_summary: Record<string, number>;
  frame_results: Array<{
    frame_number: number;
    timestamp: number;
    detections_count: number;
    frame_path: string;
    overlay_path: string;
  }>;
};

export async function getRecentVideos(limit: number = 50): Promise<VideoResult[]> {
  return apiFetch<VideoResult[]>(`/api/videos/recent?limit=${limit}`, {
    timeout: 10000,
    retries: 0,
    skipErrorHandling: true,
  }).catch(() => []); // Return empty array if not found
}
