"""In-memory store for DJI thermal batch jobs."""

import time
import uuid

from map_geo import azerbaijan_dot_from_id

thermal_jobs: dict[str, dict] = {}


def new_thermal_job(total: int, palette: int, unit: str, object_type: str | None) -> dict:
    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "total": total,
        "completed": 0,
        "palette": palette,
        "unit": unit,
        "object_type": object_type,
        "status": "active",
        "files": {},
        "results": [],
        "created_at": time.time(),
        "map_gps": azerbaijan_dot_from_id(job_id),
    }
    thermal_jobs[job_id] = job
    return job
