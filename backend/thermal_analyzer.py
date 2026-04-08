"""
Thermal image parameter analysis engine.

Extracts EXIF / XMP metadata from DJI R-JPEG files and estimates:
  - Camera-to-target distance
  - Ambient temperature & relative humidity
  - Emissivity
  - Reflected temperature
  - Thermal correction insights

All estimates carry explicit confidence scores and source labels.
"""

import math
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from io import BytesIO
from typing import Optional

try:
    from PIL import Image
    from PIL.ExifTags import TAGS
    _PIL_OK = True
except ImportError:
    _PIL_OK = False

try:
    from image_gps import exif_gps_from_image as _exif_gps_from_image
    _IMAGE_GPS_OK = True
except ImportError:
    _IMAGE_GPS_OK = False

try:
    import requests as _requests
    _REQUESTS_OK = True
except ImportError:
    _REQUESTS_OK = False

# Emissivity reference table: (typical_value, min_plausible, confidence, label)
_EMISSIVITY = {
    "human_skin": (0.98, 0.95, 0.95, "high"),
    "skin":        (0.98, 0.95, 0.95, "high"),
    "human":       (0.98, 0.95, 0.95, "high"),
    "person":      (0.98, 0.95, 0.95, "high"),
    "animal":      (0.98, 0.95, 0.90, "high"),
    "concrete":    (0.92, 0.88, 0.90, "high"),
    "asphalt":     (0.95, 0.92, 0.90, "high"),
    "road":        (0.95, 0.92, 0.85, "medium"),
    "vegetation":  (0.95, 0.93, 0.90, "high"),
    "grass":       (0.95, 0.93, 0.90, "high"),
    "tree":        (0.95, 0.93, 0.90, "high"),
    "leaves":      (0.96, 0.94, 0.90, "high"),
    "water":       (0.96, 0.95, 0.92, "high"),
    "ice":         (0.97, 0.95, 0.90, "high"),
    "snow":        (0.97, 0.95, 0.90, "high"),
    "metal_polished": (0.10, 0.05, 0.75, "medium"),
    "metal_rough": (0.60, 0.50, 0.75, "medium"),
    "metal_oxidized": (0.65, 0.55, 0.80, "medium"),
    "metal":       (0.40, 0.10, 0.50, "low"),
    "steel":       (0.35, 0.10, 0.55, "low"),
    "aluminum":    (0.10, 0.05, 0.65, "medium"),
    "copper":      (0.07, 0.03, 0.65, "medium"),
    "glass":       (0.84, 0.80, 0.85, "high"),
    "paint":       (0.93, 0.90, 0.90, "high"),
    "wood":        (0.90, 0.85, 0.88, "high"),
    "plastic":     (0.92, 0.88, 0.88, "high"),
    "rubber":      (0.95, 0.90, 0.88, "high"),
    "soil":        (0.95, 0.88, 0.85, "high"),
    "sand":        (0.90, 0.85, 0.85, "high"),
    "brick":       (0.90, 0.85, 0.88, "high"),
    "fabric":      (0.94, 0.90, 0.88, "high"),
    "roof":        (0.90, 0.82, 0.80, "medium"),
    "solar_panel": (0.85, 0.80, 0.78, "medium"),
    "electrical":  (0.85, 0.75, 0.75, "medium"),
    "electrical_insulator": (0.92, 0.88, 0.85, "high"),
    "insulator":   (0.92, 0.88, 0.85, "high"),
    "insulation":  (0.90, 0.85, 0.85, "high"),
    "wire":        (0.70, 0.60, 0.70, "medium"),
    "transformer": (0.85, 0.75, 0.75, "medium"),
    "pipe":        (0.80, 0.70, 0.72, "medium"),
    "bearing":     (0.85, 0.75, 0.72, "medium"),
    "motor":       (0.85, 0.75, 0.72, "medium"),
}

# Sensor pixel-pitch lookup (µm) by camera model keyword
_PIXEL_PITCH_UM = {
    "h30t": 12.0, "h20t": 12.0, "xt2": 17.0, "xt s": 12.0,
    "xts": 12.0, "m2ea": 12.0, "m30t": 12.0, "m3t": 12.0,
    "flir": 17.0, "zenmuse": 12.0,
}

# Geographic inference zones:
# (abs_lat_min, abs_lat_max, base_temp_c, temp_swing_c, base_humidity, hum_swing)
_GEO_ZONES = [
    (0,  10, 30,  8, 82, 12),
    (10, 23, 28, 10, 72, 15),
    (23, 35, 25, 12, 58, 20),
    (35, 45, 18, 15, 52, 20),
    (45, 55, 12, 18, 55, 18),
    (55, 65,  5, 20, 60, 18),
    (65, 90, -8, 22, 65, 18),
]


def _extract_xmp_dict(image_bytes: bytes) -> dict:
    """Parse the XMP packet from a JPEG bytestring into a flat {tag: value} dict."""
    xmp_dict: dict = {}

    for marker in (b"<x:xmpmeta", b"<?xpacket"):
        start = image_bytes.find(marker)
        if start != -1:
            break
    else:
        return xmp_dict

    end = image_bytes.find(b"</x:xmpmeta>", start)
    if end == -1:
        return xmp_dict
    xmp_bytes = image_bytes[start : end + 12]

    try:
        xmp_str = xmp_bytes.decode("utf-8", errors="replace")
        xmp_clean = re.sub(r"xmlns[^=]*='[^']*'", "", xmp_str)
        xmp_clean = re.sub(r'xmlns[^=]*="[^"]*"', "", xmp_clean)
        xmp_clean = re.sub(r"<([a-zA-Z0-9_-]+):", "<", xmp_clean)
        xmp_clean = re.sub(r"</([a-zA-Z0-9_-]+):", "</", xmp_clean)
        xmp_clean = re.sub(r"\s([a-zA-Z0-9_-]+):([a-zA-Z0-9_]+)=", r" \2=", xmp_clean)

        root = ET.fromstring(xmp_clean)
        for elem in root.iter():
            for k, v in elem.attrib.items():
                local = k.split("}")[-1] if "}" in k else k
                xmp_dict[local] = v
    except Exception:
        for m in re.finditer(r'(?:[A-Za-z0-9_-]+:)?([A-Za-z0-9_]+)="([^"]+)"', xmp_str):
            xmp_dict[m.group(1)] = m.group(2)

    return xmp_dict


def _safe_float(val, default=None) -> Optional[float]:
    try:
        return float(str(val).replace("+", "").strip())
    except Exception:
        return default


def _safe_int(val, default=None) -> Optional[int]:
    try:
        return int(str(val).strip())
    except Exception:
        return default


def extract_rjpeg_metadata(image_bytes: bytes) -> dict:
    """
    Parse EXIF + DJI XMP metadata from an R-JPEG bytestring.
    Returns camera info, GPS, altitude, gimbal tilt, thermal calibration params.
    """
    meta: dict = {}

    if not _PIL_OK:
        return {"error": "Pillow not installed"}

    try:
        img = Image.open(BytesIO(image_bytes))
        meta["image_width"] = img.width
        meta["image_height"] = img.height

        exif_data = img._getexif() or {}
        decoded = {TAGS.get(k, k): v for k, v in exif_data.items()}

        meta["camera_model"] = str(decoded.get("Model", "")).strip() or None
        meta["serial_number"] = str(decoded.get("BodySerialNumber", "")).strip() or None
        meta["timestamp"] = str(decoded.get("DateTime", "")).strip() or None

        fl = decoded.get("FocalLength")
        meta["focal_length_mm"] = float(fl) if fl is not None else None

        fn = decoded.get("FNumber")
        meta["f_number"] = float(fn) if fn is not None else None

        gps_d = _exif_gps_from_image(img) if _IMAGE_GPS_OK else None
        if gps_d:
            meta["gps_coordinates"] = {
                "latitude": gps_d.get("latitude"),
                "longitude": gps_d.get("longitude"),
            }
            alt = gps_d.get("altitude")
            meta["altitude"] = float(alt) if alt is not None else None
            meta["altitude_source"] = (
                "EXIF GPSAltitude (absolute, above mean sea level)"
                if meta["altitude"] is not None
                else None
            )
        else:
            meta["gps_coordinates"] = {"latitude": None, "longitude": None}
            meta["altitude"] = None
            meta["altitude_source"] = None

    except Exception as e:
        meta["exif_error"] = str(e)

    xmp = _extract_xmp_dict(image_bytes)
    meta["raw_xmp"] = xmp

    if meta.get("altitude") is None:
        rel_alt = _safe_float(xmp.get("RelativeAltitude"))
        abs_alt = _safe_float(xmp.get("AbsoluteAltitude"))
        if rel_alt is not None:
            meta["altitude"] = rel_alt
            meta["altitude_source"] = "DJI XMP RelativeAltitude (AGL)"
        elif abs_alt is not None:
            meta["altitude"] = abs_alt
            meta["altitude_source"] = "DJI XMP AbsoluteAltitude (GPS-based)"

    meta["camera_tilt_deg"] = _safe_float(
        xmp.get("GimbalPitch") or xmp.get("CameraPitch")
    )
    meta["emissivity"] = _safe_float(xmp.get("Emissivity"))
    meta["reflected_temperature"] = _safe_float(
        xmp.get("ReflectedApparentTemperature") or xmp.get("ReflectedTemperature")
    )
    meta["atmospheric_temperature"] = _safe_float(
        xmp.get("AtmosphericTemperature") or xmp.get("AmbientTemperature")
    )
    meta["relative_humidity"] = _safe_float(
        xmp.get("RelativeHumidity") or xmp.get("Humidity")
    )
    meta["subject_distance"] = _safe_float(
        xmp.get("SubjectDistance") or xmp.get("ObjectDistance")
    )

    if not meta.get("camera_model"):
        meta["camera_model"] = xmp.get("Model") or xmp.get("CameraModel")

    if "altitude_source" not in meta:
        meta["altitude_source"] = None

    return meta


# ---------------------------------------------------------------------------
# Internal estimators
# ---------------------------------------------------------------------------

def _estimate_distance(meta: dict, object_info: dict) -> dict:
    """Estimate camera-to-target distance using best available method."""
    warnings: list[str] = []

    sd = meta.get("subject_distance")
    if sd and sd > 0:
        return {
            "value": round(sd, 2),
            "method": "subject_distance_from_metadata",
            "confidence": 0.90,
            "warnings": [],
        }

    obj = object_info or {}
    real_size = _safe_float(obj.get("real_world_size_meters"))
    obj_pixels = _safe_float(obj.get("object_pixel_size"))
    focal_mm = meta.get("focal_length_mm")
    camera_model = (meta.get("camera_model") or "").lower()

    pixel_pitch_um = 12.0
    for key, pitch in _PIXEL_PITCH_UM.items():
        if key in camera_model:
            pixel_pitch_um = pitch
            break

    if real_size and obj_pixels and focal_mm and obj_pixels > 0:
        pixel_pitch_m = pixel_pitch_um / 1_000_000
        distance = (real_size * focal_mm / 1000) / (pixel_pitch_m * obj_pixels)
        return {
            "value": round(distance, 2),
            "method": "pinhole_camera_model",
            "confidence": 0.80,
            "warnings": warnings,
        }

    altitude = meta.get("altitude")
    if altitude and altitude > 0:
        tilt_deg = meta.get("camera_tilt_deg")
        if tilt_deg is not None:
            tilt_from_vertical_deg = 90.0 + float(tilt_deg)
            tilt_rad = math.radians(abs(tilt_from_vertical_deg))
            cos_t = math.cos(tilt_rad)
            if cos_t < 0.05:
                cos_t = 0.05
                warnings.append("Camera is near-horizontal; distance estimate unreliable.")
            dist = altitude / cos_t
            method = "altitude_divided_by_cos(tilt)"
            confidence = 0.75
        else:
            dist = altitude
            method = "altitude_as_nadir_approximation"
            confidence = 0.65
            warnings.append("Camera tilt unknown; assuming nadir orientation.")

        return {
            "value": round(dist, 2),
            "method": method,
            "confidence": confidence,
            "warnings": warnings,
        }

    warnings += [
        "No altitude, tilt, or object size available.",
        "Distance is a heuristic estimate only.",
    ]
    return {
        "value": 50.0,
        "range": "10-200 m (typical drone survey altitude)",
        "method": "heuristic_fallback",
        "confidence": 0.15,
        "warnings": warnings,
    }


def _parse_capture_datetime(ts_str: str) -> Optional[datetime]:
    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S"):
        try:
            return datetime.strptime(ts_str.strip(), fmt)
        except ValueError:
            continue
    return None


def fetch_weather_at_capture(
    latitude: float, longitude: float, timestamp_str: str,
) -> dict:
    """
    Fetch actual weather at the exact time and GPS location via Open-Meteo API.
    Free, no API key required. Uses historical or forecast endpoint as appropriate.
    """
    if not _REQUESTS_OK:
        return {"error": "requests library not installed"}

    if not timestamp_str:
        return {"error": "No timestamp in image metadata."}

    dt = _parse_capture_datetime(timestamp_str)
    if dt is None:
        return {"error": f"Could not parse timestamp '{timestamp_str}'."}

    capture_date = dt.date()
    today = datetime.now(timezone.utc).date()
    days_ago = (today - capture_date).days

    if days_ago >= 5:
        base_url = "https://archive-api.open-meteo.com/v1/archive"
        endpoint = "Open-Meteo Historical Archive"
        confidence = 0.88
    elif days_ago >= 0:
        base_url = "https://api.open-meteo.com/v1/forecast"
        endpoint = "Open-Meteo Forecast / Recent"
        confidence = 0.82
    else:
        return {"error": "Image timestamp is in the future."}

    date_str = capture_date.strftime("%Y-%m-%d")
    params = {
        "latitude": round(latitude, 4),
        "longitude": round(longitude, 4),
        "start_date": date_str,
        "end_date": date_str,
        "hourly": (
            "temperature_2m,relative_humidity_2m,dew_point_2m,"
            "apparent_temperature,wind_speed_10m,precipitation"
        ),
        "timezone": "auto",
        "wind_speed_unit": "kmh",
    }

    try:
        resp = _requests.get(base_url, params=params, timeout=12)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        return {"error": "Open-Meteo API request failed.", "error_detail": str(e)}

    hourly = data.get("hourly", {})
    times = hourly.get("time", [])
    if not times:
        return {"error": "Open-Meteo returned no hourly data for this date/location."}

    capture_hour = dt.hour
    idx = None
    for i, t in enumerate(times):
        try:
            record_hour = datetime.strptime(t, "%Y-%m-%dT%H:%M").hour
            if record_hour == capture_hour:
                idx = i
                break
        except ValueError:
            continue

    if idx is None:
        def _hour_diff(t_str: str) -> int:
            try:
                return abs(datetime.strptime(t_str, "%Y-%m-%dT%H:%M").hour - capture_hour)
            except ValueError:
                return 99
        idx = min(range(len(times)), key=lambda i: _hour_diff(times[i]))

    def _get(key: str):
        vals = hourly.get(key, [])
        return vals[idx] if idx < len(vals) else None

    temp_c = _get("temperature_2m")
    humidity = _get("relative_humidity_2m")
    if temp_c is None or humidity is None:
        return {"error": "Open-Meteo returned null values for this location/time."}

    return {
        "temperature_c": round(temp_c, 2),
        "humidity_percent": round(humidity, 1),
        "dew_point_c": round(_get("dew_point_2m"), 2) if _get("dew_point_2m") is not None else None,
        "apparent_temp_c": round(_get("apparent_temperature"), 2) if _get("apparent_temperature") is not None else None,
        "wind_speed_kmh": round(_get("wind_speed_10m"), 1) if _get("wind_speed_10m") is not None else None,
        "precipitation_mm": round(_get("precipitation"), 2) if _get("precipitation") is not None else None,
        "weather_time": times[idx],
        "api_endpoint": endpoint,
        "coordinates_used": {"latitude": latitude, "longitude": longitude},
        "confidence": confidence,
    }


def _infer_environment(meta: dict) -> dict:
    """
    Determine ambient temperature and humidity via 4-source priority:
    1. Image metadata  2. Open-Meteo API  3. Geographic inference  4. Fallback
    """
    results: dict = {}
    warnings: list[str] = []
    weather_api_result: Optional[dict] = None

    gps = meta.get("gps_coordinates") or {}
    lat = gps.get("latitude")
    lon = gps.get("longitude")
    ts_str = meta.get("timestamp") or ""

    api_attempted = False
    if lat is not None and lon is not None and ts_str:
        api_attempted = True
        weather_api_result = fetch_weather_at_capture(lat, lon, ts_str)
        if "error" in weather_api_result:
            warnings.append(f"Weather API unavailable: {weather_api_result['error']}")
            weather_api_result = None

    atm_temp = meta.get("atmospheric_temperature")
    if atm_temp is not None:
        results["ambient_temperature_c"] = {
            "value": round(atm_temp, 1),
            "source": "measured — embedded in image metadata",
            "confidence": 0.90,
        }
    elif weather_api_result:
        results["ambient_temperature_c"] = {
            "value": weather_api_result["temperature_c"],
            "apparent_temp": weather_api_result.get("apparent_temp_c"),
            "dew_point_c": weather_api_result.get("dew_point_c"),
            "source": f"Open-Meteo API — {weather_api_result['api_endpoint']} at {weather_api_result.get('weather_time', 'unknown')}",
            "confidence": weather_api_result["confidence"],
        }
    else:
        base_temp, temp_swing = 25.0, 10.0
        season_offset = 0.0
        if lat is not None:
            abs_lat = abs(lat)
            for lmin, lmax, bt, ts, _bh, _hs in _GEO_ZONES:
                if lmin <= abs_lat < lmax:
                    base_temp, temp_swing = bt, ts
                    break
            dt = _parse_capture_datetime(ts_str)
            month = dt.month if dt else 6
            is_summer = (3 <= month <= 9) if lat >= 0 else not (3 <= month <= 9)
            season_offset = 4.0 if is_summer else -4.0

        est_temp = base_temp + season_offset
        results["ambient_temperature_c"] = {
            "value": round(est_temp, 1),
            "range": f"{est_temp - temp_swing / 2:.0f}-{est_temp + temp_swing / 2:.0f} C",
            "source": "geographic + seasonal inference",
            "confidence": 0.45 if lat is not None else 0.20,
        }

    rh = meta.get("relative_humidity")
    if rh is not None:
        results["humidity_percent"] = {
            "value": round(rh, 1),
            "source": "measured — embedded in image metadata",
            "confidence": 0.90,
        }
    elif weather_api_result:
        results["humidity_percent"] = {
            "value": weather_api_result["humidity_percent"],
            "source": f"Open-Meteo API — {weather_api_result['api_endpoint']}",
            "confidence": weather_api_result["confidence"],
        }
    else:
        base_hum, hum_swing = 60.0, 20.0
        if lat is not None:
            abs_lat = abs(lat)
            for lmin, lmax, _bt, _ts, bh, hs in _GEO_ZONES:
                if lmin <= abs_lat < lmax:
                    base_hum, hum_swing = bh, hs
                    break
        results["humidity_percent"] = {
            "value": round(base_hum, 1),
            "range": f"{base_hum - hum_swing / 2:.0f}-{base_hum + hum_swing / 2:.0f} %",
            "source": "geographic inference",
            "confidence": 0.35 if lat is not None else 0.20,
        }

    results["weather_api"] = weather_api_result
    results["warnings"] = warnings
    return results


def _get_emissivity(meta: dict, object_type: Optional[str]) -> dict:
    emis_meta = meta.get("emissivity")
    if emis_meta is not None and 0.01 <= emis_meta <= 1.0:
        return {
            "value": round(emis_meta, 3),
            "source": "metadata — embedded in image",
            "confidence": 0.92,
        }

    if object_type:
        key = object_type.lower().strip()
        if key in _EMISSIVITY:
            val, min_val, conf, label = _EMISSIVITY[key]
            return {
                "value": val,
                "plausible_range": f"{min_val}-1.0",
                "source": f"inferred from object type '{object_type}'",
                "confidence": conf,
            }
        for table_key, (val, min_val, conf, label) in _EMISSIVITY.items():
            if table_key in key or key in table_key:
                return {
                    "value": val,
                    "plausible_range": f"{min_val}-1.0",
                    "source": f"inferred (partial match) from '{object_type}'",
                    "confidence": round(conf * 0.85, 2),
                }

    return {
        "value": 0.95,
        "plausible_range": "0.85-0.98",
        "source": "assumed — conservative default (no type provided)",
        "confidence": 0.30,
    }


def _get_reflected_temperature(meta: dict, ambient_temp_c: float) -> dict:
    rt = meta.get("reflected_temperature")
    if rt is not None:
        return {"value": round(rt, 1), "source": "metadata — embedded in image", "confidence": 0.90}
    return {
        "value": round(ambient_temp_c, 1),
        "source": "assumed equal to estimated ambient temperature",
        "confidence": 0.50,
    }


def _thermal_correction_insights(
    dist_m: float, humidity_pct: float, emissivity: float,
    reflected_temp_c: float, thermal_data_available: bool,
) -> str:
    """Human-readable explanation of how each parameter biases readings."""
    lines = []

    atm_attenuation = dist_m * 0.002 * (humidity_pct / 60.0)
    lines.append(
        f"Distance ({dist_m:.1f} m): +/- {atm_attenuation:.2f} C atmospheric attenuation."
    )

    if humidity_pct > 70:
        lines.append(f"Humidity ({humidity_pct:.0f}%): High — causes under-estimation of target temperature.")
    elif humidity_pct < 30:
        lines.append(f"Humidity ({humidity_pct:.0f}%): Low — good measurement conditions.")
    else:
        lines.append(f"Humidity ({humidity_pct:.0f}%): Moderate — manageable IR attenuation.")

    if emissivity < 0.5:
        lines.append(f"Emissivity ({emissivity:.2f}): CRITICAL — low emissivity, significant reflected IR.")
    elif emissivity < 0.85:
        lines.append(f"Emissivity ({emissivity:.2f}): Moderate — reflected IR contributes noticeably.")
    else:
        lines.append(f"Emissivity ({emissivity:.2f}): High — near-blackbody, small correction error.")

    if thermal_data_available:
        lines.append("Pixel-level raw values: Available via DJI SDK.")
    else:
        lines.append("Pixel-level raw values: Unavailable (DJI SDK not initialized).")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Public: main analysis entry point
# ---------------------------------------------------------------------------

def analyze(
    image_bytes: bytes,
    object_info: Optional[dict] = None,
    thermal_data_available: bool = False,
) -> dict:
    """
    Full thermal analysis pipeline.
    Returns structured analysis with metadata, distance, environment,
    thermal parameters, and correction insights.
    """
    obj = object_info or {}
    meta = extract_rjpeg_metadata(image_bytes)
    all_warnings: list[str] = []

    dist_result = _estimate_distance(meta, obj)
    all_warnings.extend(dist_result.get("warnings", []))
    dist_m = dist_result["value"]

    env = _infer_environment(meta)
    all_warnings.extend(env.pop("warnings", []))
    ambient_temp = env["ambient_temperature_c"]["value"]
    humidity = env["humidity_percent"]["value"]

    emis_result = _get_emissivity(meta, obj.get("object_type"))
    emissivity = emis_result["value"]

    rt_result = _get_reflected_temperature(meta, ambient_temp)
    reflected_temp = rt_result["value"]

    insights = _thermal_correction_insights(
        dist_m, humidity, emissivity, reflected_temp, thermal_data_available
    )

    if not meta.get("altitude"):
        all_warnings.append("Altitude not found in metadata — distance used heuristics.")
    if not meta.get("gps_coordinates", {}).get("latitude"):
        all_warnings.append("GPS coordinates missing — environmental inference is not region-specific.")
    if not meta.get("emissivity") and not obj.get("object_type"):
        all_warnings.append("Neither emissivity nor object_type provided — default 0.95 used.")

    weather_api_data = env.pop("weather_api", None)

    return {
        "metadata_extracted": {
            "camera_model": meta.get("camera_model"),
            "serial_number": meta.get("serial_number"),
            "focal_length_mm": meta.get("focal_length_mm"),
            "f_number": meta.get("f_number"),
            "image_width": meta.get("image_width"),
            "image_height": meta.get("image_height"),
            "timestamp": meta.get("timestamp"),
            "gps_coordinates": meta.get("gps_coordinates"),
            "altitude_m": meta.get("altitude"),
            "altitude_source": meta.get("altitude_source"),
            "camera_tilt_deg": meta.get("camera_tilt_deg"),
            "emissivity_in_meta": meta.get("emissivity"),
            "reflected_temp_in_meta": meta.get("reflected_temperature"),
            "atmospheric_temp_in_meta": meta.get("atmospheric_temperature"),
            "humidity_in_meta": meta.get("relative_humidity"),
        },
        "weather_api_data": weather_api_data,
        "distance_meters": {
            "value": dist_result["value"],
            "method": dist_result["method"],
            "confidence": dist_result["confidence"],
            **({"range": dist_result["range"]} if "range" in dist_result else {}),
        },
        "environment": {
            "ambient_temperature_c": env["ambient_temperature_c"],
            "humidity_percent": env["humidity_percent"],
        },
        "thermal_parameters": {
            "emissivity": emis_result,
            "reflected_temperature_c": rt_result,
        },
        "thermal_correction_insights": insights,
        "analysis_notes": (
            f"Analysis based on {'DJI SDK pixel data + ' if thermal_data_available else ''}"
            f"EXIF/XMP metadata. Distance method: {dist_result['method']}. "
            f"Environmental data: {'measured' if meta.get('atmospheric_temperature') else 'inferred'}."
        ),
        "warnings": list(dict.fromkeys(all_warnings)),
    }
