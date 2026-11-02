"""SQLite index for journaling job metadata.

Official artifacts (audio.flac / score.abc / plan.json / latent.npy / result.json)
remain the read-only source of truth on disk. This database only indexes what the
web layer adds: job type, lineage, favourites, titles, requested/effective params.
A missing or deleted database can always be rebuilt by scanning runs/jobs.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "runs"
DB_PATH = RUNS / "yue2.db"

log = logging.getLogger("yue2.db")

_JSON_FIELDS = ("requested", "effective", "artifacts", "result")
_INIT_LOCK = threading.Lock()
_INITED = False

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL DEFAULT 'song',
  status        TEXT NOT NULL DEFAULT 'queued',
  stage         TEXT NOT NULL DEFAULT '',
  progress      TEXT NOT NULL DEFAULT '',
  device        TEXT NOT NULL DEFAULT '',
  style         TEXT NOT NULL DEFAULT '',
  title         TEXT NOT NULL DEFAULT '',
  seed          INTEGER,
  cot           TEXT NOT NULL DEFAULT '',
  created_at    REAL NOT NULL,
  updated_at    REAL NOT NULL,
  parent_id     TEXT,
  variant_group TEXT,
  favorite      INTEGER NOT NULL DEFAULT 0,
  error         TEXT NOT NULL DEFAULT '',
  duration      REAL,
  truncated     INTEGER,
  ode_steps     INTEGER,
  vae           TEXT NOT NULL DEFAULT '',
  demo          INTEGER NOT NULL DEFAULT 0,
  requested     TEXT,
  effective     TEXT,
  artifacts     TEXT,
  result        TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_parent  ON jobs(parent_id);
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at REAL NOT NULL
);
"""

# Attention kernels that change output bytes stay off until the user opts in.
DEFAULT_SETTINGS = {"attention_ar": False, "attention_nar": False}


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


_ADDED_COLUMNS = {
    "ode_steps": "INTEGER",
    "vae": "TEXT NOT NULL DEFAULT ''",
    "demo": "INTEGER NOT NULL DEFAULT 0",
}


def init() -> None:
    global _INITED
    with _INIT_LOCK:
        if _INITED:
            return
        RUNS.mkdir(parents=True, exist_ok=True)
        with connect() as conn:
            conn.executescript(_SCHEMA)
            existing = {row["name"] for row in conn.execute("PRAGMA table_info(jobs)")}
            for name, definition in _ADDED_COLUMNS.items():
                if name not in existing:
                    conn.execute(f"ALTER TABLE jobs ADD COLUMN {name} {definition}")
        _INITED = True


def get_settings() -> dict:
    """Read persisted switches, falling back to the defaults for unseen keys."""
    init()
    with connect() as conn:
        stored = {row["key"]: row["value"] for row in conn.execute("SELECT key, value FROM settings")}
    return {key: (stored[key] == "1") if key in stored else value
            for key, value in DEFAULT_SETTINGS.items()}


def save_settings(values: dict) -> dict:
    """Persist known switches only; unknown keys are rejected instead of silently stored."""
    unknown = set(values) - set(DEFAULT_SETTINGS)
    if unknown:
        raise ValueError(f"Unknown settings: {sorted(unknown)}")
    for key, value in values.items():
        if not isinstance(value, bool):
            raise TypeError(f"{key} must be a boolean")
    init()
    now = time.time()
    with connect() as conn:
        for key, value in values.items():
            conn.execute("INSERT INTO settings(key, value, updated_at) VALUES(?,?,?) "
                         "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                         (key, "1" if value else "0", now))
    return get_settings()


def reset_settings() -> dict:
    """Restore every switch to its default, which is off."""
    init()
    with connect() as conn:
        conn.execute("DELETE FROM settings")
    return dict(DEFAULT_SETTINGS)


def _dumps(value):
    return None if value is None else json.dumps(value, ensure_ascii=False)
def _loads(value, field: str = "", job_id: str = ""):
    if value is None or value == "":
        return None
    try:
        return json.loads(value)
    except (TypeError, ValueError) as exc:
        log.warning("任务 %s 的 %s 列不是合法 JSON，按空处理：%s", job_id or "?", field or "?", exc)
        return None


def row_to_dict(row: sqlite3.Row) -> dict:
    data = dict(row)
    job_id = str(data.get("id") or "")
    for field in _JSON_FIELDS:
        data[field] = _loads(data.get(field), field, job_id)
    data["favorite"] = bool(data.get("favorite"))
    data["demo"] = bool(data.get("demo"))
    data["truncated"] = bool(data["truncated"]) if data.get("truncated") is not None else None
    return data


def _record(job: dict) -> dict:
    return {
        "id": job["id"],
        "type": job.get("type", "song"),
        "status": job.get("status", "queued"),
        "stage": job.get("stage", "") or "",
        "progress": job.get("progress", "") or "",
        "device": job.get("device", "") or "",
        "style": job.get("style", "") or "",
        "title": job.get("title", "") or "",
        "seed": job.get("seed"),
        "cot": job.get("cot", "") or "",
        "created_at": job.get("created_at") or time.time(),
        "updated_at": job.get("updated_at") or time.time(),
        "parent_id": job.get("parent_id"),
        "variant_group": job.get("variant_group"),
        "favorite": 1 if job.get("favorite") else 0,
        "error": job.get("error", "") or "",
        "duration": job.get("duration"),
        "truncated": None if job.get("truncated") is None else (1 if job["truncated"] else 0),
        "ode_steps": job.get("ode_steps"),
        "vae": job.get("vae") or "",
        "demo": 1 if job.get("demo") else 0,
        "requested": _dumps(job.get("requested")),
        "effective": _dumps(job.get("effective")),
        "artifacts": _dumps(job.get("artifacts")),
        "result": _dumps(job.get("result")),
    }


def upsert(job: dict) -> None:
    """Insert or fully replace a job row. Unknown keys are ignored."""
    init()
    record = _record(job)
    columns = ", ".join(record)
    placeholders = ", ".join(f":{key}" for key in record)
    updates = ", ".join(f"{key}=excluded.{key}" for key in record if key != "id")
    with connect() as conn:
        conn.execute(
            f"INSERT INTO jobs ({columns}) VALUES ({placeholders}) "
            f"ON CONFLICT(id) DO UPDATE SET {updates}",
            record,
        )


def insert_missing(job: dict) -> None:
    """Insert a row only when the id is absent; never overwrite existing metadata."""
    init()
    record = _record(job)
    columns = ", ".join(record)
    placeholders = ", ".join(f":{key}" for key in record)
    with connect() as conn:
        conn.execute(
            f"INSERT INTO jobs ({columns}) VALUES ({placeholders}) "
            f"ON CONFLICT(id) DO NOTHING",
            record,
        )


def all_ids() -> set[str]:
    init()
    with connect() as conn:
        return {str(row["id"]) for row in conn.execute("SELECT id FROM jobs")}


def fail_unfinished(reason: str) -> int:
    """Mark every queued/running row as failed; returns how many changed."""
    init()
    with connect() as conn:
        cursor = conn.execute(
            "UPDATE jobs SET status='failed', error=?, updated_at=? "
            "WHERE status IN ('queued','running')",
            (reason, time.time()),
        )
        return cursor.rowcount


def update(job_id: str, **fields) -> None:
    if not fields:
        return
    init()
    fields.setdefault("updated_at", time.time())
    if "requested" in fields:
        fields["requested"] = _dumps(fields["requested"])
    if "effective" in fields:
        fields["effective"] = _dumps(fields["effective"])
    if "artifacts" in fields:
        fields["artifacts"] = _dumps(fields["artifacts"])
    if "result" in fields:
        fields["result"] = _dumps(fields["result"])
    if "favorite" in fields:
        fields["favorite"] = 1 if fields["favorite"] else 0
    if "truncated" in fields and fields["truncated"] is not None:
        fields["truncated"] = 1 if fields["truncated"] else 0
    columns = ", ".join(f"{key}=:{key}" for key in fields)
    fields["id"] = job_id
    with connect() as conn:
        conn.execute(f"UPDATE jobs SET {columns} WHERE id=:id", fields)


def get(job_id: str) -> dict | None:
    init()
    with connect() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    return row_to_dict(row) if row else None


def _like(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _where(status: str | None = None, q: str | None = None,
           favorite: bool | None = None) -> tuple[list[str], list]:
    where, params = [], []
    if status:
        where.append("status=?")
        params.append(status)
    if favorite:
        where.append("favorite=1")
    if q:
        where.append("(id LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR style LIKE ? ESCAPE '\\')")
        params.extend([_like(q)] * 3)
    return where, params


def list_jobs(status: str | None = None, q: str | None = None, favorite: bool | None = None,
              limit: int = 200, offset: int = 0) -> list[dict]:
    init()
    where, params = _where(status, q, favorite)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    params.extend([max(1, min(limit, 500)), max(0, offset)])
    with connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM jobs{clause} ORDER BY created_at DESC LIMIT ? OFFSET ?", params
        ).fetchall()
    return [row_to_dict(row) for row in rows]


def count(status: str | None = None, q: str | None = None, favorite: bool | None = None) -> int:
    init()
    where, params = _where(status, q, favorite)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    with connect() as conn:
        row = conn.execute(f"SELECT COUNT(*) FROM jobs{clause}", params).fetchone()
    return int(row[0])


def delete(job_id: str) -> None:
    init()
    with connect() as conn:
        conn.execute("DELETE FROM jobs WHERE id=?", (job_id,))
