"""Queued job deletion must not leave an invisible runner behind.

Run:
    python tools/verify-job-queue.py
"""
from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("" if ok or not detail else f"  -> {detail}"))


def eq(name: str, actual, expected) -> None:
    check(name, actual == expected, f"actual={actual!r} expected={expected!r}")


def verify_delete_drains_queue() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="yue2-job-queue-"))
    try:
        from app import db, server

        db.DB_PATH = tmp / "yue2.db"
        db.RUNS = tmp / "runs"
        db._INITED = False
        db.init()
        server.QUEUE.queue.clear()
        server.JOBS.clear()

        job = server.Job("song_queue_delete", "song", {"style": "Mandarin", "lyrics": "第一行"})
        with server.LOCK:
            server.JOBS[job.id] = job
            server.QUEUE.put(job.id)

        response = server.delete_job(job.id)
        eq("删除 queued 任务返回成功", response.get("deleted"), job.id)
        eq("删除后执行队列为空", list(server.QUEUE.queue), [])
        eq("删除后内存索引为空", list(server.JOBS), [])
        eq("删除后数据库索引为空", db.all_ids(), set())
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def verify_delete_failure_rollback() -> None:
    """删除失败时：目录、队列、内存状态与索引状态都要回到删除前。"""
    tmp = Path(tempfile.mkdtemp(prefix="yue2-delete-rollback-"))
    try:
        from app import db, server

        db.DB_PATH = tmp / "yue2.db"
        db.RUNS = tmp / "runs"
        db._INITED = False
        db.init()
        server.JOBS_DIR = tmp / "runs" / "jobs"
        server.TRASH_DIR = tmp / "runs" / "_trash"
        server.QUEUE.queue.clear()
        server.JOBS.clear()

        job = server.Job("song_queue_rollback", "song", {"style": "Mandarin", "lyrics": "第一行"})
        with server.LOCK:
            server.JOBS[job.id] = job
            server.QUEUE.put(job.id)
        (server.JOBS_DIR / job.id).mkdir(parents=True, exist_ok=True)

        # 1) 目录移动失败：409 + queued 恢复 + 目录原位 + 队列恢复。
        original_move = shutil.move

        def _move_fail(src, dst, **kwargs):
            raise OSError("模拟文件被占用")

        shutil.move = _move_fail
        try:
            try:
                server.delete_job(job.id)
                check("目录移动失败返回 409", False, "没有抛 HTTPException")
            except server.HTTPException as exc:
                eq("目录移动失败返回 409", exc.status_code, 409)
        finally:
            shutil.move = original_move
        eq("移动失败后任务仍为 queued", (db.get(job.id) or {}).get("status"), "queued")
        eq("移动失败后队列恢复", list(server.QUEUE.queue), [job.id])
        check("移动失败目录未被动过", (server.JOBS_DIR / job.id).is_dir())

        # 2) 索引删除失败：500 + 目录移回 + queued 恢复 + 索引仍在。
        original_delete = db.delete

        def _delete_fail(job_id):
            raise RuntimeError("模拟索引删除失败")

        db.delete = _delete_fail
        try:
            try:
                server.delete_job(job.id)
                check("索引删除失败返回 500", False, "没有抛 HTTPException")
            except server.HTTPException as exc:
                eq("索引删除失败返回 500", exc.status_code, 500)
        finally:
            db.delete = original_delete
        eq("索引删除失败后任务仍为 queued", (db.get(job.id) or {}).get("status"), "queued")
        eq("索引删除失败后队列恢复", list(server.QUEUE.queue), [job.id])
        check("索引删除失败后目录移回", (server.JOBS_DIR / job.id).is_dir())
        check("索引删除失败后回收站为空", not (server.TRASH_DIR / job.id).exists())

        # 3) 正常删除：目录进回收站、DB/队列/内存清空。
        response = server.delete_job(job.id)
        eq("正常删除返回成功", response.get("deleted"), job.id)
        check("正常删除后目录进回收站", (server.TRASH_DIR / job.id).is_dir())
        eq("正常删除后索引清空", db.all_ids(), set())
        eq("正常删除后队列为空", list(server.QUEUE.queue), [])
        eq("正常删除后内存清空", list(server.JOBS), [])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    verify_delete_drains_queue()
    verify_delete_failure_rollback()
    failed = [item for item in RESULTS if not item[1]]
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} 项通过")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())