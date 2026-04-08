/**
 * Infer wide vs zoom (tele) framing from detection geometry when focal EXIF is unavailable,
 * then tune RGB canvas annotation thickness and oversized-box suppression.
 */

type BboxRow = { bbox?: number[] };

/** Median sqrt(area ratio) ~ object footprint; wide scenes skew smaller, zoom skew larger. */
export function inferMedianSqrtAreaRatio(
  detections: BboxRow[],
  sourceW: number,
  sourceH: number
): number | null {
  const imgArea = Math.max(sourceW * sourceH, 1);
  const vals: number[] = [];
  for (const d of detections) {
    const b = d.bbox;
    if (!Array.isArray(b) || b.length < 4) continue;
    const [x1, y1, x2, y2] = b;
    if (![x1, y1, x2, y2].every((n) => Number.isFinite(n))) continue;
    const bw = Math.abs(x2 - x1);
    const bh = Math.abs(y2 - y1);
    const ar = (bw * bh) / imgArea;
    if (ar > 0 && ar < 1) vals.push(Math.sqrt(ar));
  }
  if (vals.length === 0) return null;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)]!;
}

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

/**
 * Wide / zoom-out / mid: fixed 0.003 and 0.3. Boost applies only when median footprint is high
 * (clear zoom-in / tele framing).
 */
export function rgbAnnotationTunablesFromDetections(
  detections: BboxRow[],
  sourceW: number,
  sourceH: number
): { areaSkipAbove: number; lineAndLabelScale: number } {
  const m = inferMedianSqrtAreaRatio(detections, sourceW, sourceH);
  if (m == null) {
    return { areaSkipAbove: 0.003, lineAndLabelScale: 0.65 };
  }
  const areaWide = 0.003;
  const lineWide = 0.3;
  const tZoomInStart = 0.052;
  /** Zoom-in band only; m < tZoomInStart still 0.003 / 0.3. Narrower ramp → full boost faster. */
  const tZoomInFull = 0.054;
  const zoomInAmt = clamp01((m - tZoomInStart) / (tZoomInFull - tZoomInStart));
  const areaSkipZoomIn = 0.07;
  const lineScaleZoomIn = 3.45;
  return {
    areaSkipAbove: areaWide + zoomInAmt * (areaSkipZoomIn - areaWide),
    lineAndLabelScale: lineWide + zoomInAmt * (lineScaleZoomIn - lineWide),
  };
}
