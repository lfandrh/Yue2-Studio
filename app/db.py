"""SQLite index for journaling job metadata.

Official artifacts (audio.flac / score.abc / plan.json / latent.npy / result.json)
remain the read-only source of truth on disk. This database only indexes what the
web layer adds: job type, lineage, favourites, titles, requested/effective params.
A missing or deleted database can always be rebuilt by scanning runs/jobs.
"""
from __future__ import annotations

import json
import logging
import re
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
  from_stage    TEXT NOT NULL DEFAULT '',
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


BUSY_TIMEOUT_MS = 30_000


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=BUSY_TIMEOUT_MS / 1000.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
    return conn


_ADDED_COLUMNS = {
    "ode_steps": "INTEGER",
    "vae": "TEXT NOT NULL DEFAULT ''",
    "demo": "INTEGER NOT NULL DEFAULT 0",
    "from_stage": "TEXT NOT NULL DEFAULT ''",
    # ---- 作品/版本族谱（歌曲管理优化方案 2026-11-12）----
    "work_name": "TEXT NOT NULL DEFAULT ''",
    "work_root": "TEXT",
    "version_no": "INTEGER",
    "version_tag": "TEXT NOT NULL DEFAULT ''",
    "version_label": "TEXT NOT NULL DEFAULT ''",
    "version_note": "TEXT NOT NULL DEFAULT ''",
    "kept": "INTEGER",
    "hidden": "INTEGER NOT NULL DEFAULT 0",
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
            # 索引依赖本次新增的列，必须等 ALTER 之后再建：老库的 jobs 表没有 work_root，
            # 把这条写进 _SCHEMA 会在 executescript 阶段直接报 no such column，迁移根本跑不到。
            conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_work ON jobs(work_root, version_no)")
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
        "work_name": job.get("work_name") or "",
        "work_root": job.get("work_root"),
        "version_no": job.get("version_no"),
        "version_tag": job.get("version_tag") or "",
        "version_label": job.get("version_label") or "",
        "version_note": job.get("version_note") or "",
        "kept": None if job.get("kept") is None else (1 if job["kept"] else 0),
        "hidden": 1 if job.get("hidden") else 0,
        "from_stage": job.get("from_stage") or "",
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
    if "kept" in fields and fields["kept"] is not None:
        fields["kept"] = 1 if fields["kept"] else 0
    if "hidden" in fields:
        fields["hidden"] = 1 if fields["hidden"] else 0
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
        where.append("(id LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR style LIKE ? ESCAPE '\\' "
                     "OR work_name LIKE ? ESCAPE '\\' OR version_label LIKE ? ESCAPE '\\' "
                     "OR version_tag LIKE ? ESCAPE '\\')")
        params.extend([_like(q)] * 6)
    return where, params


def list_jobs(status: str | None = None, q: str | None = None, favorite: bool | None = None,
              limit: int | None = 200, offset: int = 0) -> list[dict]:
    """limit=None 表示不限行数（启动收敛必须扫全部行）；传数字仍钳在 1–500。"""
    init()
    where, params = _where(status, q, favorite)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    tail = "" if limit is None else " LIMIT ? OFFSET ?"
    if limit is not None:
        params.extend([max(1, min(limit, 500)), max(0, offset)])
    with connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM jobs{clause} ORDER BY created_at DESC{tail}", params
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


# ------------------------------------------------------------------ 作品/版本族谱
# 语义约定见 docs/歌曲管理优化方案-2026-11-12.md：
#   work_root   组内根任务 id（候选=第一个候选；派生=最上游源；独立任务=自身）
#   work_name   作品展示名（组内冗余一致，改名=整组批量刷）
#   version_no  组内序号（按创建时间），列表排序用
#   version_tag 自动标签（候选 A / 改谱 2 …），建任务时一次性写定
#   version_label / version_note / kept / hidden  用户可改的展示层字段

_CANDIDATE_TITLE = re.compile(r"^候选 (\d+) · ")
_DERIVED_TITLE = re.compile(r" · (改谱|成歌|换解码器)(?: \d+)?$")
_CANDIDATE_TAG = re.compile(r"^候选 ([A-Z])$")


def _strip_legacy_suffixes(title: str) -> str:
    """从旧版标题反推作品名：剥「候选 N · 」前缀与「 · 改谱/成歌/换解码器 N」后缀。"""
    text = _CANDIDATE_TITLE.sub("", str(title or "")).strip()
    text = _DERIVED_TITLE.sub("", text).strip()
    # 旧候选标题尾部还有 " · 种子串36-r1" 这类 hash 尾巴，一并剥掉
    parts = text.rsplit(" · ", 1)
    if len(parts) == 2 and re.fullmatch(r"[0-9a-z]{1,12}-r\d+|rnd", parts[1].strip()):
        text = parts[0].strip()
    return text


def _lyric_head(text: str) -> str:
    """歌词第一句（跳过 [Verse] 这类段落标记），与 server._lyric_head 同口径。"""
    for line in str(text or "").split("\n"):
        line = line.strip()
        if line and not line.startswith("["):
            return line[:14]
    return ""


def _row_work_name(row) -> str:
    """作品名：标题剥旧后缀；旧数据标题为空时退回歌词首行，别让整库都叫「未命名作品」。"""
    name = _strip_legacy_suffixes(row["title"])
    if name:
        return name
    request = _loads(row["requested"], "requested", row["id"]) or {}
    return _lyric_head(request.get("lyrics")) or "未命名作品"


def backfill_work_fields() -> int:
    """给 work_root 为空的存量行回填族谱字段。幂等：新任务建任务时已写好，
    这里只补 NULL 的行，可安全重复执行。返回回填行数。"""
    init()
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, type, status, title, parent_id, variant_group, style, cot, created_at, "
            "favorite, demo, requested FROM jobs WHERE work_root IS NULL ORDER BY created_at ASC"
        ).fetchall()
        if not rows:
            return 0
        by_id = {row["id"]: row for row in rows}
        # 沿 parent 链上溯找根（限深防环；找不到父行就地自成根）。
        # 父行可能已在更早的启动里回填过（不在本批 rows 里），这时继承它的 work_root。
        roots: dict[str, str] = {}
        def _persisted_root(job_id: str) -> str | None:
            row = conn.execute("SELECT work_root FROM jobs WHERE id=?", (job_id,)).fetchone()
            return (row["work_root"] or None) if row else None
        def _root(job_id: str, depth: int = 0) -> str:
            if job_id in roots:
                return roots[job_id]
            row = by_id.get(job_id)
            if row is None or depth > 32:
                return job_id
            parent = row["parent_id"]
            if not parent:
                return job_id
            if parent in by_id:
                result = _root(parent, depth + 1)
            else:
                result = _persisted_root(parent) or job_id
            roots[job_id] = result
            return result
        # 旧版候选没有谱系：标题带「候选 N · 」且 style/cot 相同、创建时间相近的
        # 并进同一组（启发式，容错——归不进组的保持独立，只影响聚合展示）。
        candidate_rows = [row for row in rows if _CANDIDATE_TITLE.match(row["title"] or "")]
        merged_roots: dict[str, str] = {}
        buckets: dict[tuple, list] = {}
        for row in candidate_rows:
            key = (row["style"] or "", row["cot"] or "", int((row["created_at"] or 0) // 600))
            buckets.setdefault(key, []).append(row)
        for bucket in buckets.values():
            if len(bucket) < 2:
                continue
            root = _root(bucket[0]["id"])
            for row in bucket[1:]:
                merged_roots[row["id"]] = root
        # 汇总每行的最终归属：组被启发式合并进另一组时，跟随合并后的根。
        final_root: dict[str, str] = {}
        for row in rows:
            final_root[row["id"]] = merged_roots.get(row["id"]) or _root(row["id"])
        def _final_root(job_id: str) -> str:
            # 根本身也可能被合并（根是另一组的候选时），追到链尾
            seen = set()
            current = final_root.get(job_id, job_id)
            while current in merged_roots and current not in seen:
                seen.add(current)
                current = merged_roots[current]
            return current
        seq: dict[str, list[str]] = {}
        for row in rows:
            seq.setdefault(_final_root(row["id"]), []).append(row["id"])
        kept_by_root: dict[str, str] = {}
        for root, jids in seq.items():
            for jid in reversed(jids):
                row = by_id.get(jid)
                if row is not None and row["status"] == "complete":
                    kept_by_root[root] = jid
                    break
        # 组里已经回填过的成员（不在本批）：新补的行要接着编号、沿用已改过的作品名，
        # 否则重启扫描进来的派生任务会从 1 重号，并把作品名覆盖回标题推导值。
        def _existing(root: str) -> tuple[int, str, bool]:
            row = conn.execute(
                "SELECT MAX(version_no) AS max_no, "
                "MAX(CASE WHEN work_name != '' THEN work_name END) AS name, "
                "MAX(COALESCE(kept, 0)) AS kept FROM jobs WHERE work_root=?",
                (root,)).fetchone()
            return int(row["max_no"] or 0), row["name"] or "", bool(row["kept"])
        count = 0
        for root, jids in seq.items():
            start_no, existing_name, existing_kept = _existing(root)
            anchor = by_id.get(root) or by_id[jids[0]]
            name = existing_name or _row_work_name(anchor)
            kept_id = None if existing_kept else kept_by_root.get(root)
            for n, job_id in enumerate(jids, start_no + 1):
                row = by_id.get(job_id)
                tag = ""
                if row is not None:
                    m = _CANDIDATE_TITLE.match(row["title"] or "")
                    if m:
                        tag = f"候选 {chr(ord('A') + int(m.group(1)) - 1)}"
                    else:
                        dm = re.search(r" · (改谱|成歌|换解码器)(?: (\d+))?$", row["title"] or "")
                        if dm:
                            tag = f"{dm.group(1)} {dm.group(2) or 1}"
                conn.execute(
                    "UPDATE jobs SET work_root=:root, work_name=:name, version_no=:no, "
                    "variant_group=:root, version_tag=:tag, kept=:kept WHERE id=:id",
                    {"root": root, "name": name, "no": n, "tag": tag, "id": job_id,
                     "kept": 1 if kept_id == job_id else None})
                count += 1
        return count


def bulk_set_work_name(root: str, name: str) -> int:
    """改作品名：一条 UPDATE 刷整组。返回受影响行数。"""
    init()
    with connect() as conn:
        cursor = conn.execute("UPDATE jobs SET work_name=?, updated_at=? WHERE work_root=?",
                              (name, time.time(), root))
        return cursor.rowcount


MOVE_VERSION_LOCK = threading.Lock()
# 重试上限：正常路径靠 BEGIN IMMEDIATE 的保留锁已经不会读到旧值，
# 这里只兜 busy_timeout 超时等可恢复场景，不掩盖真正的逻辑错误。
_MOVE_MAX_ATTEMPTS = 4


def _is_move_retryable(exc: BaseException) -> bool:
    """只有「锁没拿到」类错误值得重试；约束冲突、SQL 错误等直接回滚抛出。"""
    message = str(exc).lower()
    return isinstance(exc, sqlite3.OperationalError) and ("locked" in message or "busy" in message)


def move_version(job_id: str, root: str, name: str, variant_group: str,
                 keep: bool, split: bool = False) -> int:
    """把一个版本并入作品或拆成独立作品，返回落定后的版本号。

    事务边界与并发约定：
    - 锁顺序：先 init()（内部只拿 _INIT_LOCK），再拿 MOVE_VERSION_LOCK，最后开
      SQLite 写事务。调用方不得在持有 server.LOCK 时进入本函数；本函数也绝不
      回调任何持 server.LOCK 的代码，避免两条锁链互相嵌套死锁。
    - 原子性：BEGIN IMMEDIATE 在读取 MAX(version_no) 之前拿到写锁，跨进程的
      读-改-写因此串行化；不会再出现两个请求读到同一个号各写一次。
    - 失败回滚：任何一步失败都 rollback 并释放连接；UPDATE 命中 0 行说明任务
      已被并发删除，视为失败而不是静默成功。
    - 重试：仅对 locked/busy 做有限次退避重试。
    """
    init()
    with MOVE_VERSION_LOCK:
        last_exc = None
        for attempt in range(_MOVE_MAX_ATTEMPTS):
            conn = None
            try:
                conn = connect()
                conn.execute("BEGIN IMMEDIATE")
                if split:
                    cursor = conn.execute(
                        "UPDATE jobs SET work_root=?, work_name=?, variant_group=?, version_no=1, "
                        "kept=?, updated_at=? WHERE id=?",
                        (root, name, variant_group, 1 if keep else None, time.time(), job_id))
                    if cursor.rowcount != 1:
                        raise RuntimeError(f"移动版本失败：任务 {job_id} 不存在")
                    conn.commit()
                    return 1
                current = conn.execute(
                    "SELECT work_root FROM jobs WHERE id=?", (job_id,)).fetchone()
                if current is None:
                    raise RuntimeError(f"移动版本失败：任务 {job_id} 不存在")
                if current["work_root"] == root:
                    raise RuntimeError("这条版本已经在该作品里")
                if keep:
                    occupied = conn.execute(
                        "SELECT 1 FROM jobs WHERE work_root=? AND kept=1 LIMIT 1",
                        (root,)).fetchone()
                    if occupied is not None:
                        keep = False
                row = conn.execute(
                    "SELECT MAX(version_no) FROM jobs WHERE work_root=?", (root,)).fetchone()
                if row is None or row[0] is None:
                    raise RuntimeError("目标作品没有可续排的版本号")
                next_no = int(row[0]) + 1
                cursor = conn.execute(
                    "UPDATE jobs SET work_root=?, work_name=?, variant_group=?, version_no=?, "
                    "kept=?, updated_at=? WHERE id=?",
                    (root, name, variant_group, next_no, 1 if keep else None, time.time(), job_id))
                if cursor.rowcount != 1:
                    raise RuntimeError(f"移动版本失败：任务 {job_id} 不存在")
                conn.commit()
                return next_no
            except Exception as exc:  # noqa: BLE001 - 交给重试判定与回滚
                if conn is not None:
                    try:
                        conn.rollback()
                    except sqlite3.Error:
                        pass
                if _is_move_retryable(exc) and attempt + 1 < _MOVE_MAX_ATTEMPTS:
                    last_exc = exc
                    time.sleep(0.05 * (attempt + 1))
                    continue
                raise
            finally:
                if conn is not None:
                    conn.close()
        raise RuntimeError("版本移动重试耗尽") from last_exc


def next_version_no(root: str) -> int:
    init()
    with connect() as conn:
        row = conn.execute("SELECT MAX(version_no) FROM jobs WHERE work_root=?", (root,)).fetchone()
    return int(row[0] or 0) + 1


def group_member_ids(root: str) -> list[str]:
    init()
    with connect() as conn:
        rows = conn.execute("SELECT id FROM jobs WHERE work_root=? ORDER BY version_no", (root,)).fetchall()
    return [row["id"] for row in rows]


def group_has_kept(root: str) -> bool:
    init()
    with connect() as conn:
        row = conn.execute("SELECT 1 FROM jobs WHERE work_root=? AND kept=1 LIMIT 1", (root,)).fetchone()
    return row is not None


def find_group_row(group: str) -> dict | None:
    """候选批次归组：按前端下发的 work_group uuid 找组内已有行。"""
    init()
    with connect() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE variant_group=? ORDER BY created_at LIMIT 1",
                           (group,)).fetchone()
    return row_to_dict(row) if row else None


def next_candidate_index(root: str) -> int:
    """组内下一个候选序号（0 起，A=0）：按已有标签的最大字母续排。

    不能只数行数：删掉中间某个候选后，行数会撞上仍然存在的标签，
    出现两个「候选 B」；按最大序号续排最多跳字母，不会重号。
    """
    init()
    with connect() as conn:
        rows = conn.execute(
            "SELECT version_tag FROM jobs WHERE work_root=? AND type='song' AND parent_id IS NULL",
            (root,)).fetchall()
    highest = 0
    for row in rows:
        match = _CANDIDATE_TAG.match(row["version_tag"] or "")
        if match:
            highest = max(highest, ord(match.group(1)) - ord("A") + 1)
    return highest or len(rows)


def next_type_index(root: str, job_type: str, verb: str) -> int:
    """同类派生任务的下一个序号（1 起）：按已有标签的最大数字续排，删行后不重号。"""
    init()
    with connect() as conn:
        rows = conn.execute(
            "SELECT version_tag FROM jobs WHERE work_root=? AND type=?",
            (root, job_type)).fetchall()
    pattern = re.compile(rf"^{re.escape(verb)} (\d+)$")
    highest = 0
    for row in rows:
        match = pattern.match(row["version_tag"] or "")
        if match:
            highest = max(highest, int(match.group(1)))
    return (highest or len(rows)) + 1
