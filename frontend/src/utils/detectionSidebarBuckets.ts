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
  "pollution_flashover",
  "foundation_concrete_crack",
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

/** RGB preview canvas: respect "Show on image" toggles; user-hidden classes are always hidden. */
export function filterRowsForRgbPreviewOverlay<T extends { class_name?: string; label?: string }>(
  rows: T[],
  hiddenKeys: Set<string>
): T[] {
  return rows.filter((d) => {
    const key = normalizeDetectionClassKey(d.class_name ?? d.label);
    if (hiddenKeys.has(key)) return false;
    return true;
  });
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
