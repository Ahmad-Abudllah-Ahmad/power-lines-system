"""Map placement: deterministic GPS on Azerbaijan mainland only (not Caspian Sea), per batch id."""

from __future__ import annotations

import hashlib

# Simplified mainland boundary (WGS84 lat, lng). Excludes Nakhchivan & open Caspian water.
# Eastern vertices follow the coastline so interior stays on land / near-shore.
_AZ_MAINLAND: list[tuple[float, float]] = [
    (41.905, 45.026),
    (41.78, 45.65),
    (41.86, 46.55),
    (41.78, 47.45),
    (41.58, 48.55),
    (41.32, 49.35),
    (41.02, 49.78),
    (40.62, 50.05),
    (40.18, 50.04),
    (39.76, 49.78),
    (39.38, 49.32),
    (39.05, 48.72),
    (38.88, 48.12),
    (38.82, 47.38),
    (38.96, 46.68),
    (39.38, 46.08),
    (40.02, 45.52),
    (40.72, 45.08),
    (41.45, 45.02),
]

_LAT_MIN = min(p[0] for p in _AZ_MAINLAND)
_LAT_MAX = max(p[0] for p in _AZ_MAINLAND)
_LNG_MIN = min(p[1] for p in _AZ_MAINLAND)
_LNG_MAX = max(p[1] for p in _AZ_MAINLAND)

# Open Caspian (east of ~50.1°E) — excludes Baku / Absheron (~49.85°E).
_CASPIAN_OPEN_WATER: list[tuple[float, float]] = [
    (41.55, 50.35),
    (41.05, 50.88),
    (40.15, 50.92),
    (39.0, 50.68),
    (38.5, 50.22),
    (38.45, 49.95),
    (39.25, 49.88),
    (40.45, 50.08),
    (41.25, 50.28),
    (41.48, 50.32),
]


def _point_in_polygon(lat: float, lng: float, ring: list[tuple[float, float]]) -> bool:
    """Ray casting; ring is (lat, lng) treated as (y, x)."""
    n = len(ring)
    if n < 3:
        return False
    inside = False
    j = n - 1
    for i in range(n):
        yi, xi = ring[i][0], ring[i][1]
        yj, xj = ring[j][0], ring[j][1]
        denom = (yj - yi) + 1e-18
        intersects = (yi > lat) != (yj > lat) and (lng < (xj - xi) * (lat - yi) / denom + xi)
        if intersects:
            inside = not inside
        j = i
    return inside


def _on_mainland_not_sea(lat: float, lng: float) -> bool:
    return _point_in_polygon(lat, lng, _AZ_MAINLAND) and not _point_in_polygon(lat, lng, _CASPIAN_OPEN_WATER)


def _centroid_fallback() -> dict[str, float]:
    lat = sum(p[0] for p in _AZ_MAINLAND) / len(_AZ_MAINLAND)
    lng = sum(p[1] for p in _AZ_MAINLAND) / len(_AZ_MAINLAND)
    return {"lat": round(lat, 6), "lng": round(lng, 6)}


def azerbaijan_dot_from_id(batch_id: str) -> dict[str, float]:
    """Stable lat/lng on land from UTF-8 batch id (same for new and legacy batches)."""
    for rnd in range(64):
        digest = hashlib.sha256(batch_id.encode("utf-8") + bytes([rnd])).digest()
        u1 = int.from_bytes(digest[0:4], "big") / 0xFFFFFFFF
        u2 = int.from_bytes(digest[4:8], "big") / 0xFFFFFFFF
        lat = _LAT_MIN + u1 * (_LAT_MAX - _LAT_MIN)
        lng = _LNG_MIN + u2 * (_LNG_MAX - _LNG_MIN)
        if _on_mainland_not_sea(lat, lng):
            return {"lat": round(lat, 6), "lng": round(lng, 6)}
    return _centroid_fallback()
