"""
DJI Thermal SDK wrapper — DLLs in backend/models/windows/
"""

import ctypes as CT
from ctypes import c_int32, c_uint8
from pathlib import Path
import tempfile

import numpy as np

_sdk_initialized = False
_init_error = None

_BACKEND_DIR = Path(__file__).resolve().parent
DLL_PATH = str(_BACKEND_DIR / "models" / "windows" / "libdirp.dll")


def _bytes_to_c_buffer(image_bytes: bytes) -> tuple[CT.Array, c_int32]:
    """
    Create a binary-safe C buffer for passing JPEG bytes to the DJI SDK.

    NOTE: assigning to `.value` on a ctypes string buffer treats the input as a C-string
    and truncates at the first NUL byte, which can make different images appear identical.
    """
    size = c_int32(len(image_bytes))
    buf = CT.create_string_buffer(len(image_bytes))
    CT.memmove(buf, image_bytes, len(image_bytes))
    return buf, size


def dll_files_present() -> bool:
    return Path(DLL_PATH).is_file()


def init_sdk() -> tuple[bool, str]:
    global _sdk_initialized, _init_error
    if _sdk_initialized:
        return True, "SDK already initialized."

    if not dll_files_present():
        _init_error = "libdirp.dll not found"
        return False, f"DLL not found at `{DLL_PATH}`."

    try:
        from dji_thermal_sdk.dji_sdk import dji_init
        dji_init(dllpath=DLL_PATH)
        _sdk_initialized = True
        return True, "DJI Thermal SDK initialized successfully."
    except Exception as e:
        _init_error = str(e)
        return False, f"SDK initialization failed: {e}"


def is_initialized() -> bool:
    return _sdk_initialized


# DJI dirp_create_from_rjpeg return codes (common) — human-readable for API clients.
_RJPEG_CREATE_ERRORS: dict[int, str] = {
    -1: "Invalid data buffer.",
    -3: "Unsupported R-JPEG version.",
    -7: (
        "Not a valid thermal/R-JPEG file. Use a DJI radiometric JPEG (R-JPEG), "
        "not a rendered preview PNG or a regular photo JPEG."
    ),
}


def _rjpeg_value_error(operation: str, ret: int) -> ValueError:
    code = int(ret)
    if operation == "dirp_create_from_rjpeg":
        msg = _RJPEG_CREATE_ERRORS.get(code)
        if msg:
            return ValueError(msg)
    return ValueError(f"{operation} failed (code {code}).")


def extract_temperature_map(image_bytes: bytes, dtype: str = "float32") -> np.ndarray:
    if not _sdk_initialized:
        raise RuntimeError("SDK not initialized. Call init_sdk() first.")

    from dji_thermal_sdk.dji_sdk import (
        dirp_create_from_rjpeg,
        dirp_get_rjpeg_resolution,
        dirp_measure_ex,
        dirp_destroy,
        dirp_resolution_t,
        DIRP_SUCCESS,
    )

    handle = CT.c_void_p()
    rjpeg_data, size = _bytes_to_c_buffer(image_bytes)

    ret = dirp_create_from_rjpeg(rjpeg_data, size, CT.byref(handle))
    if ret != DIRP_SUCCESS:
        raise _rjpeg_value_error("dirp_create_from_rjpeg", ret)

    try:
        resolution = dirp_resolution_t()
        ret = dirp_get_rjpeg_resolution(handle, CT.byref(resolution))
        if ret != DIRP_SUCCESS:
            raise _rjpeg_value_error("dirp_get_rjpeg_resolution", ret)

        h, w = resolution.height, resolution.width

        if dtype == "float32":
            buf_size = h * w * CT.sizeof(CT.c_float)
            buf = CT.create_string_buffer(buf_size)
            ret = dirp_measure_ex(handle, CT.byref(buf), buf_size)
            if ret != DIRP_SUCCESS:
                raise _rjpeg_value_error("dirp_measure_ex", ret)
            temp_array = np.frombuffer(buf.raw, dtype=np.float32).reshape(h, w)
        else:
            buf_size = h * w * CT.sizeof(CT.c_int16)
            buf = CT.create_string_buffer(buf_size)
            ret = dirp_measure_ex(handle, CT.byref(buf), buf_size)
            if ret != DIRP_SUCCESS:
                raise _rjpeg_value_error("dirp_measure_ex", ret)
            raw = np.frombuffer(buf.raw, dtype=np.int16).reshape(h, w)
            temp_array = raw.astype(np.float32) / 10.0

        return temp_array
    finally:
        dirp_destroy(handle)


def render_thermal_image(image_bytes: bytes, palette: int = 0) -> np.ndarray:
    if not _sdk_initialized:
        raise RuntimeError("SDK not initialized. Call init_sdk() first.")

    from dji_thermal_sdk.dji_sdk import (
        dirp_create_from_rjpeg,
        dirp_get_rjpeg_resolution,
        dirp_set_pseudo_color,
        dirp_process,
        dirp_destroy,
        dirp_resolution_t,
        DIRP_SUCCESS,
        c_int,
    )

    handle = CT.c_void_p()
    rjpeg_data, size = _bytes_to_c_buffer(image_bytes)

    ret = dirp_create_from_rjpeg(rjpeg_data, size, CT.byref(handle))
    if ret != DIRP_SUCCESS:
        raise _rjpeg_value_error("dirp_create_from_rjpeg", ret)

    try:
        resolution = dirp_resolution_t()
        ret = dirp_get_rjpeg_resolution(handle, CT.byref(resolution))
        if ret != DIRP_SUCCESS:
            raise _rjpeg_value_error("dirp_get_rjpeg_resolution", ret)

        h, w = resolution.height, resolution.width

        dirp_set_pseudo_color(handle, c_int(palette))

        buf_size = h * w * 3 * CT.sizeof(c_uint8)
        buf = CT.create_string_buffer(buf_size)
        ret = dirp_process(handle, CT.byref(buf), buf_size)
        if ret != DIRP_SUCCESS:
            raise _rjpeg_value_error("dirp_process", ret)

        img = np.frombuffer(buf.raw, dtype=np.uint8).reshape(h, w, 3)
        return img
    finally:
        dirp_destroy(handle)


def get_temperature_stats(temp_map: np.ndarray) -> dict:
    valid = temp_map[np.isfinite(temp_map)]
    if valid.size == 0:
        return {}
    # Plain Python scalars only — numpy int64/float64 in dicts break JSONResponse (HTTP 500).
    return {
        "min_c": float(np.min(valid)),
        "max_c": float(np.max(valid)),
        "mean_c": float(np.mean(valid)),
        "median_c": float(np.median(valid)),
        "std_c": float(np.std(valid)),
        "height": int(temp_map.shape[0]),
        "width": int(temp_map.shape[1]),
        "pixels": int(valid.size),
    }


def convert_temp_map(temp_map: np.ndarray, unit: str) -> np.ndarray:
    if unit == "Fahrenheit":
        return temp_map * 9 / 5 + 32
    if unit == "Kelvin":
        return temp_map + 273.15
    return temp_map


def get_roi_stats(temp_map: np.ndarray, x1: int, y1: int, x2: int, y2: int) -> dict:
    roi = temp_map[y1:y2, x1:x2]
    return get_temperature_stats(roi)


def save_bytes_to_temp(image_bytes: bytes, suffix: str = ".jpg") -> str:
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    tmp.write(image_bytes)
    tmp.close()
    return tmp.name
