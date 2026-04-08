"""JPEG EXIF GPS read + batch map pin from upload-ordered file coordinates."""

from __future__ import annotations

from io import BytesIO
from typing import Any, Optional

from map_geo import azerbaijan_dot_from_id

try:
    from PIL import Image as _Image
    from PIL.ExifTags import GPSTAGS, IFD
    _PIL_OK = True
except ImportError:
    _PIL_OK = False


def _gps_decimal(coord: Any, ref: str) -> Optional[float]:
    try:
        d, m, s = [float(x) for x in coord]
        val = d + m / 60 + s / 3600
        if str(ref).upper() in ("S", "W"):
            val = -val
        return val
    except Exception:
        return None


def _ratio_to_float(x: Any) -> Optional[float]:
    if x is None:
        return None
    try:
        return float(x)
    except (TypeError, ValueError):
        pass
    try:
        return float(x.numerator) / float(x.denominator)
    except Exception:
        return None


def exif_gps_from_image(img: Any) -> Optional[dict[str, Optional[float]]]:
    """
    Read lat/lng/alt from EXIF GPS IFD. Returns None if missing.
    Values are full-precision floats from EXIF (no rounding).
    """
    if not _PIL_OK:
        return None
    exif = img.getexif()
    if not exif:
        return None
    gps_ifd = None
    try:
        gps_ifd = exif.get_ifd(IFD.GPSInfo)
    except Exception:
        try:
            gps_ifd = exif.get_ifd(0x8825)
        except Exception:
            gps_ifd = None
    if not gps_ifd:
        return None
    gps = {GPSTAGS.get(k, k): v for k, v in gps_ifd.items()}
    lat = _gps_decimal(gps.get("GPSLatitude", ()), gps.get("GPSLatitudeRef", "N") or "N")
    lon = _gps_decimal(gps.get("GPSLongitude", ()), gps.get("GPSLongitudeRef", "E") or "E")
    if lat is None or lon is None:
        return None
    alt = _ratio_to_float(gps.get("GPSAltitude"))
    return {"latitude": lat, "longitude": lon, "altitude": alt}


def exif_gps_from_bytes(image_bytes: bytes) -> Optional[dict[str, Optional[float]]]:
    if not image_bytes or not _PIL_OK:
        return None
    try:
        img = _Image.open(BytesIO(image_bytes))
        return exif_gps_from_image(img)
    except Exception:
        return None


def file_gps_for_job(gps: Optional[dict[str, Optional[float]]]) -> Optional[dict[str, float]]:
    """Strip to lat/lng for JSON job file entry (no altitude — map uses 2D)."""
    if not gps:
        return None
    lat, lon = gps.get("latitude"), gps.get("longitude")
    if lat is None or lon is None:
        return None
    return {"lat": float(lat), "lng": float(lon)}


def apply_batch_map_gps_to_job(job: dict) -> None:
    """
    Set job['map_gps'] to {lat,lng} from EXIF uploads (insertion order):
    ≤2 files → first file's coordinates only; ≥3 files → mean of all files that have GPS.
    If no usable GPS, fall back to deterministic pin from job_id.
    """
    jid = str(job.get("job_id") or "")
    files = list((job.get("files") or {}).values())
    n = len(files)
    if n == 0:
        job["map_gps"] = azerbaijan_dot_from_id(jid)
        return
    if n <= 2:
        g0 = files[0].get("gps")
        if isinstance(g0, dict) and g0.get("lat") is not None and g0.get("lng") is not None:
            job["map_gps"] = {"lat": float(g0["lat"]), "lng": float(g0["lng"])}
        else:
            job["map_gps"] = azerbaijan_dot_from_id(jid)
        return
    pts: list[tuple[float, float]] = []
    for f in files:
        g = f.get("gps")
        if isinstance(g, dict) and g.get("lat") is not None and g.get("lng") is not None:
            pts.append((float(g["lat"]), float(g["lng"])))
    if pts:
        job["map_gps"] = {
            "lat": sum(p[0] for p in pts) / len(pts),
            "lng": sum(p[1] for p in pts) / len(pts),
        }
    else:
        job["map_gps"] = azerbaijan_dot_from_id(jid)
