/**
 * Keep in sync with `detection_server/map_geo.py` (polygons + SHA-256 rejection rounds).
 */

const AZ_MAINLAND: ReadonlyArray<readonly [number, number]> = [
  [41.905, 45.026],
  [41.78, 45.65],
  [41.86, 46.55],
  [41.78, 47.45],
  [41.58, 48.55],
  [41.32, 49.35],
  [41.02, 49.78],
  [40.62, 50.05],
  [40.18, 50.04],
  [39.76, 49.78],
  [39.38, 49.32],
  [39.05, 48.72],
  [38.88, 48.12],
  [38.82, 47.38],
  [38.96, 46.68],
  [39.38, 46.08],
  [40.02, 45.52],
  [40.72, 45.08],
  [41.45, 45.02],
];

const CASPIAN_OPEN_WATER: ReadonlyArray<readonly [number, number]> = [
  [41.55, 50.35],
  [41.05, 50.88],
  [40.15, 50.92],
  [39.0, 50.68],
  [38.5, 50.22],
  [38.45, 49.95],
  [39.25, 49.88],
  [40.45, 50.08],
  [41.25, 50.28],
  [41.48, 50.32],
];

const UINT32_MAX = 4294967295;

function pointInPolygon(lat: number, lng: number, ring: ReadonlyArray<readonly [number, number]>): boolean {
  const n = ring.length;
  if (n < 3) return false;
  let inside = false;
  let j = n - 1;
  for (let i = 0; i < n; i++) {
    const yi = ring[i][0];
    const xi = ring[i][1];
    const yj = ring[j][0];
    const xj = ring[j][1];
    const denom = yj - yi + 1e-18;
    const intersects = (yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / denom + xi;
    if (intersects) inside = !inside;
    j = i;
  }
  return inside;
}

function onMainlandNotSea(lat: number, lng: number): boolean {
  return pointInPolygon(lat, lng, AZ_MAINLAND) && !pointInPolygon(lat, lng, CASPIAN_OPEN_WATER);
}

function bbox(ring: ReadonlyArray<readonly [number, number]>): { latMin: number; latMax: number; lngMin: number; lngMax: number } {
  let latMin = Infinity;
  let latMax = -Infinity;
  let lngMin = Infinity;
  let lngMax = -Infinity;
  for (const [la, ln] of ring) {
    latMin = Math.min(latMin, la);
    latMax = Math.max(latMax, la);
    lngMin = Math.min(lngMin, ln);
    lngMax = Math.max(lngMax, ln);
  }
  return { latMin, latMax, lngMin, lngMax };
}

const { latMin: _LAT_MIN, latMax: _LAT_MAX, lngMin: _LNG_MIN, lngMax: _LNG_MAX } = bbox(AZ_MAINLAND);

function centroidFallback(): { lat: number; lng: number } {
  let sl = 0;
  let sn = 0;
  for (const [la, ln] of AZ_MAINLAND) {
    sl += la;
    sn += ln;
  }
  const n = AZ_MAINLAND.length;
  return { lat: Math.round((sl / n) * 1e6) / 1e6, lng: Math.round((sn / n) * 1e6) / 1e6 };
}

function encodeRoundPayload(batchId: string, round: number): Uint8Array {
  const te = new TextEncoder().encode(batchId);
  const out = new Uint8Array(te.length + 1);
  out.set(te);
  out[te.length] = round & 0xff;
  return out;
}

function digestToLatLng(dv: DataView): { lat: number; lng: number } {
  const u1 = dv.getUint32(0, false) / UINT32_MAX;
  const u2 = dv.getUint32(4, false) / UINT32_MAX;
  const lat = _LAT_MIN + u1 * (_LAT_MAX - _LAT_MIN);
  const lng = _LNG_MIN + u2 * (_LNG_MAX - _LNG_MIN);
  return { lat, lng };
}

/** Matches Python `azerbaijan_dot_from_id` when Web Crypto is available. */
export async function azerbaijanDotFromBatchId(batchId: string): Promise<{ lat: number; lng: number }> {
  if (!globalThis.crypto?.subtle) {
    return azerbaijanDotFromBatchIdSync(batchId);
  }
  for (let rnd = 0; rnd < 64; rnd++) {
    const payload = encodeRoundPayload(batchId, rnd);
    const buf = await crypto.subtle.digest("SHA-256", payload);
    const dv = new DataView(buf);
    const { lat, lng } = digestToLatLng(dv);
    if (onMainlandNotSea(lat, lng)) {
      return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
    }
  }
  return centroidFallback();
}

/**
 * When `crypto.subtle` is missing: same rejection loop, non-SHA256 digest (positions may differ from server).
 */
export function azerbaijanDotFromBatchIdSync(batchId: string): { lat: number; lng: number } {
  for (let rnd = 0; rnd < 64; rnd++) {
    let h = 2166136261 ^ rnd;
    for (let i = 0; i < batchId.length; i++) {
      h ^= batchId.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    const u1 = h / UINT32_MAX;
    let h2 = 374761393 ^ rnd;
    for (let i = 0; i < batchId.length; i++) {
      h2 = Math.imul(h2 ^ batchId.charCodeAt(i), 2654435761) >>> 0;
    }
    const u2 = h2 / UINT32_MAX;
    const lat = _LAT_MIN + u1 * (_LAT_MAX - _LAT_MIN);
    const lng = _LNG_MIN + u2 * (_LNG_MAX - _LNG_MIN);
    if (onMainlandNotSea(lat, lng)) {
      return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
    }
  }
  return centroidFallback();
}
