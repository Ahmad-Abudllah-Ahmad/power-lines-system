/** Sidebar: these normalized class keys count as Components; everything else as Defects. */
export const SIDEBAR_COMPONENT_CLASS_KEYS = [
  "insulator",
  "foundation_pedestal",
  "bolted_connection",
  "conductor",
  "vibration_damper",
  "suspension_clamp",
  "yoke_plate",
  "transmission_corridor",
  "angle_brace",
  "cross_arm",
  "two_glass",
] as const;

/** Omit from sidebar component/defect lists (detections still exist elsewhere). */
export const SIDEBAR_HIDDEN_CLASS_KEYS = new Set<string>([
  "simple_corrosion",
]);

export function normalizeDetectionClassKey(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_")
    .replace(/\s+/g, "_");
}

export function formatDetectionSidebarLabel(key: string): string {
  if (key === "conductor" || key === "foundation_pedestal") return "Foundation Padesteal";
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Normalized keys that share one sidebar label — hide/show toggles must apply to all of them. */
export function detectionClassKeysForSharedFilterToggle(key: string): string[] {
  if (key === "conductor" || key === "foundation_pedestal") {
    return ["conductor", "foundation_pedestal"];
  }
  return [key];
}

/** Only these classes: drop huge ~square overlay junk; real instances are small or tall/narrow. */
const PREVIEW_SQUARE_JUNK_CLASS_KEYS = new Set<string>(["insulator", "broken_disc"]);

/** Min box area as a fraction of image area to treat as “huge” for the square-junk rule. */
const PREVIEW_SQUARE_JUNK_MIN_AREA_RATIO = 0.002;

/** If long_side / short_side is above this, the box is treated as elongated (keep). */
const PREVIEW_SQUARE_JUNK_MAX_ASPECT_LONG_SHORT = 1.55;

/**
 * False positives for insulator / broken_disc are often enormous nearly-square regions.
 * Keep all other classes untouched; keep insulator/broken_disc when small or clearly elongated.
 */
export function rowPassesRgbPreviewGeometryFilter<T extends { class_name?: string; label?: string; bbox?: number[] }>(
  row: T,
  imageWidth: number,
  imageHeight: number
): boolean {
  if (imageWidth <= 0 || imageHeight <= 0) return true;
  const cls = normalizeDetectionClassKey(row.class_name ?? row.label);
  if (!PREVIEW_SQUARE_JUNK_CLASS_KEYS.has(cls)) return true;
  const b = row.bbox;
  if (!Array.isArray(b) || b.length < 4) return true;
  const x1 = Number(b[0]);
  const y1 = Number(b[1]);
  const x2 = Number(b[2]);
  const y2 = Number(b[3]);
  if (![x1, y1, x2, y2].every((n) => Number.isFinite(n))) return true;
  const bw = Math.abs(x2 - x1);
  const bh = Math.abs(y2 - y1);
  const shortSide = Math.min(bw, bh);
  const longSide = Math.max(bw, bh);
  if (shortSide <= 0 || longSide <= 0) return true;
  const aspectLongShort = longSide / shortSide;
  if (aspectLongShort > PREVIEW_SQUARE_JUNK_MAX_ASPECT_LONG_SHORT) return true;
  const imgArea = imageWidth * imageHeight;
  if (imgArea <= 0) return true;
  const areaRatio = (bw * bh) / imgArea;
  if (areaRatio < PREVIEW_SQUARE_JUNK_MIN_AREA_RATIO) return true;
  return false;
}

const BIRD_NEST_CLASS_KEY = "bird_nest";

type BirdNestMergeRow = {
  class_name?: string;
  label?: string;
  bbox?: number[];
  confidence?: number;
  class_id?: number;
};

/** When ≥2 ``bird_nest`` rows have valid boxes, replace them with one axis-aligned union box (previews + reports). */
export function mergeBirdNestRowsForPreview<T extends BirdNestMergeRow>(rows: T[]): T[] {
  const birds: T[] = [];
  const rest: T[] = [];
  for (const r of rows) {
    if (normalizeDetectionClassKey(r.class_name ?? r.label) === BIRD_NEST_CLASS_KEY) birds.push(r);
    else rest.push(r);
  }
  if (birds.length <= 1) return rows;

  const valid: T[] = [];
  const invalid: T[] = [];
  for (const b of birds) {
    const box = b.bbox;
    if (!Array.isArray(box) || box.length < 4 || ![0, 1, 2, 3].every((i) => Number.isFinite(Number(box[i])))) {
      invalid.push(b);
      continue;
    }
    valid.push(b);
  }
  if (valid.length <= 1) return rows;

  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  let maxConf = -Infinity;
  let bestCid: number | undefined;
  for (const b of valid) {
    const box = b.bbox!.map(Number);
    const bx1 = Math.min(box[0], box[2]);
    const by1 = Math.min(box[1], box[3]);
    const bx2 = Math.max(box[0], box[2]);
    const by2 = Math.max(box[1], box[3]);
    x1 = Math.min(x1, bx1);
    y1 = Math.min(y1, by1);
    x2 = Math.max(x2, bx2);
    y2 = Math.max(y2, by2);
    const c = typeof b.confidence === "number" && Number.isFinite(b.confidence) ? b.confidence : 0;
    if (c > maxConf) {
      maxConf = c;
      if (typeof b.class_id === "number" && Number.isFinite(b.class_id)) bestCid = b.class_id;
    }
  }
  const first = valid[0]!;
  const merged = {
    ...first,
    bbox: [x1, y1, x2, y2],
    confidence: maxConf >= 0 ? maxConf : first.confidence,
    class_id: bestCid ?? first.class_id,
    class_name: "bird_nest",
  } as T;

  return [...rest, ...invalid, merged];
}

/** RGB preview canvas: respect "Show on image" toggles; user-hidden classes are always hidden. */
export function filterRowsForRgbPreviewOverlay<T extends { class_name?: string; label?: string; bbox?: number[] }>(
  rows: T[],
  hiddenKeys: Set<string>,
  sourceWidth?: number,
  sourceHeight?: number
): T[] {
  const useGeom =
    typeof sourceWidth === "number" &&
    typeof sourceHeight === "number" &&
    sourceWidth > 0 &&
    sourceHeight > 0;
  const filtered = rows.filter((d) => {
    const key = normalizeDetectionClassKey(d.class_name ?? d.label);
    if (hiddenKeys.has(key)) return false;
    if (useGeom && !rowPassesRgbPreviewGeometryFilter(d, sourceWidth!, sourceHeight!)) return false;
    return true;
  });
  return mergeBirdNestRowsForPreview(filtered);
}

export function partitionDetectionsSidebarBuckets(rows: unknown[]): {
  components: { key: string; count: number }[];
  defects: { key: string; count: number }[];
} {
  const allowed = new Set<string>(SIDEBAR_COMPONENT_CLASS_KEYS);
  const comp = new Map<string, number>();
  const def = new Map<string, number>();
  for (const d of rows) {
    const rec = d as { class_name?: string; label?: string };
    const key = normalizeDetectionClassKey(rec.class_name ?? rec.label);
    if (!key) continue;
    if (SIDEBAR_HIDDEN_CLASS_KEYS.has(key)) continue;
    if (allowed.has(key)) comp.set(key, (comp.get(key) || 0) + 1);
    else def.set(key, (def.get(key) || 0) + 1);
  }
  const components = SIDEBAR_COMPONENT_CLASS_KEYS.filter((c) => (comp.get(c) || 0) > 0).map((c) => ({
    key: c,
    count: comp.get(c)!,
  }));
  const defects = [...def.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, count }));
  return { components, defects };
}

/** Distinct defect-class count (excludes component classes). */
export function uniqueDefectTypeCount(rows: unknown[] | undefined | null): number {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  return partitionDetectionsSidebarBuckets(rows).defects.length;
}

export type DetectionSidebarPartition = ReturnType<typeof partitionDetectionsSidebarBuckets>;

/** Embedded file detections, or fetched video list when embedded is empty. */
export function previewDetectionRowsForFile(
  runType: "image" | "video" | "thermal",
  fileDetections: unknown[] | undefined,
  videoFetched: unknown[]
): unknown[] {
  if (runType === "video") {
    if (Array.isArray(fileDetections) && fileDetections.length > 0) return fileDetections;
    return videoFetched;
  }
  return Array.isArray(fileDetections) ? fileDetections : [];
}
