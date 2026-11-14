"""作品/版本族谱后端验收（docs/歌曲管理优化方案-2026-11-12.md）。

全程使用临时目录和临时 SQLite，不读写真实 runs/。运行：
    python tools/verify-work-lineage.py
覆盖：旧库迁移、存量回填与幂等、重启续号、API 字段、改名传播、并入/拆分、
完成时自动保留。
"""
from __future__ import annotations

import json
import multiprocessing
import shutil
import sqlite3
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


OLD_SCHEMA = """
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'song',
  status TEXT NOT NULL DEFAULT 'queued', stage TEXT NOT NULL DEFAULT '',
  progress TEXT NOT NULL DEFAULT '', device TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', seed INTEGER,
  cot TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL,
  parent_id TEXT, variant_group TEXT, from_stage TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
  duration REAL, truncated INTEGER, ode_steps INTEGER,
  vae TEXT NOT NULL DEFAULT '', demo INTEGER NOT NULL DEFAULT 0,
  requested TEXT, effective TEXT, artifacts TEXT, result TEXT
);
CREATE INDEX idx_jobs_created ON jobs(created_at DESC);
CREATE INDEX idx_jobs_status  ON jobs(status);
CREATE INDEX idx_jobs_parent  ON jobs(parent_id);
"""

T0 = 1_800_000_000.0
LEGACY_ROWS = [
    # id, status, title, parent_id, style, created_at, requested
    ("song_root", "complete", "晚风", None, "styleA", T0, None),
    ("song_rr", "complete", "晚风 · 改谱 1", "song_root", "styleA", T0 + 10, None),
    ("cand_1", "complete", "候选 1 · 晚风轻轻 · k3x-r1", None, "styleB", T0 + 100, None),
    ("cand_2", "complete", "候选 2 · 晚风轻轻 · ab9-r1", None, "styleB", T0 + 102, None),
    ("song_empty", "complete", "", None, "styleC", T0 + 200,
     json.dumps({"lyrics": "[Verse]\n晚风轻轻吹过窗前\n第二行"}, ensure_ascii=False)),
    ("song_orphan", "complete", "孤儿 · 成歌 1", "missing_parent", "styleD", T0 + 300, None),
]


def _mp_move(task: tuple) -> int:
    """跨进程并发验收的 worker：独立导入 app.db，写同一个临时库。"""
    import sys
    from pathlib import Path
    sys.path.insert(0, str(ROOT))
    from app import db
    db.DB_PATH = Path(task[0])
    return db.move_version(task[1], task[2], task[3], task[2], False)


def build_legacy(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(OLD_SCHEMA)
    for job_id, status, title, parent, style, created, requested in LEGACY_ROWS:
        conn.execute(
            "INSERT INTO jobs(id,type,status,title,parent_id,style,cot,created_at,updated_at,requested)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)",
            (job_id, "song", status, title, parent, style, "full", created, created, requested))
    conn.commit()
    conn.close()


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="yue2-work-lineage-"))
    runs = tmp / "runs"
    jobs_dir = runs / "jobs"
    jobs_dir.mkdir(parents=True)
    db_path = runs / "yue2.db"
    build_legacy(db_path)
    try:
        from app import db

        db.DB_PATH = db_path
        db.RUNS = runs

        # ---------------- 1. 旧库迁移（回归：索引建在加列之前会直接崩） ----------------
        try:
            db.init()
            check("旧库 init 不崩", True)
        except Exception as exc:  # noqa: BLE001 - 失败即验收失败
            check("旧库 init 不崩", False, f"{type(exc).__name__}: {exc}")
            return report()
        cols = {row[1] for row in db.connect().execute("PRAGMA table_info(jobs)")}
        check("迁移补齐 8 个族谱列",
              {"work_name", "work_root", "version_no", "version_tag", "version_label",
               "version_note", "kept", "hidden"} <= cols, repr(sorted(cols)))
        indexes = {row[0] for row in db.connect().execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='jobs'")}
        check("迁移后建出 idx_jobs_work", "idx_jobs_work" in indexes, repr(sorted(indexes)))

        # ---------------- 2. 存量回填 ----------------
        eq("回填行数 = 6", db.backfill_work_fields(), len(LEGACY_ROWS))

        def row(job_id: str) -> dict:
            return db.get(job_id) or {}

        eq("派生任务挂到父作品", row("song_rr")["work_root"], "song_root")
        eq("派生任务沿用作品名", row("song_rr")["work_name"], "晚风")
        eq("派生任务自动标签", row("song_rr")["version_tag"], "改谱 1")
        eq("组内按创建时间编号（根=1）", row("song_root")["version_no"], 1)
        eq("组内按创建时间编号（派生=2）", row("song_rr")["version_no"], 2)
        eq("kept 默认取最新完成项", row("song_rr")["kept"], 1)
        check("较老的完成版本不抢 kept", row("song_root")["kept"] is None,
              repr(row("song_root")["kept"]))
        eq("候选按标签归组 A", (row("cand_1")["work_root"], row("cand_1")["version_tag"]), ("cand_1", "候选 A"))
        eq("候选按标签归组 B", (row("cand_2")["work_root"], row("cand_2")["version_tag"]), ("cand_1", "候选 B"))
        eq("候选共享剥旧后缀的作品名", row("cand_2")["work_name"], "晚风轻轻")
        eq("无标题行用歌词首行命名", row("song_empty")["work_name"], "晚风轻轻吹过窗前")
        eq("父任务缺失时就地成根", row("song_orphan")["work_root"], "song_orphan")
        eq("variant_group 实装为 work_root", row("song_rr")["variant_group"], "song_root")
        eq("回填幂等（第二次 0 行）", db.backfill_work_fields(), 0)

        # ---------------- 3. 重启补行：续号 + 不覆盖已改作品名 ----------------
        eq("改作品名刷整组", db.bulk_set_work_name("song_root", "晚风(女声版)"), 2)
        db.upsert({"id": "song_rr2", "type": "song", "status": "complete",
                   "title": "晚风 · 改谱 2", "parent_id": "song_root",
                   "style": "styleA", "cot": "full", "created_at": T0 + 400})
        eq("重启补行回填 1 行", db.backfill_work_fields(), 1)
        eq("补行继承父作品", row("song_rr2")["work_root"], "song_root")
        eq("补行不覆盖已改作品名", row("song_rr2")["work_name"], "晚风(女声版)")
        eq("补行版本号续排（不重号）", row("song_rr2")["version_no"], 3)
        check("组内已有 kept 时补行不再置位", row("song_rr2")["kept"] is None,
              repr(row("song_rr2")["kept"]))
        eq("补行回填幂等", db.backfill_work_fields(), 0)

        # ---------------- 4. 服务层：API 行字段 + 改名 + 移动 + 自动保留 ----------------
        from app import server

        server.JOBS_DIR = jobs_dir
        server.TRASH_DIR = runs / "_trash"
        server.restore_jobs()
        rows = {item["id"]: item for item in server.list_jobs(limit=200, offset=0)["jobs"]}
        new_keys = {"work_name", "work_root", "version_no", "version_tag",
                    "version_label", "version_note", "kept", "hidden"}
        check("列表行带全部族谱字段", new_keys <= set(rows["song_rr"]), repr(sorted(rows["song_rr"])))
        eq("列表行 work_name 正确", rows["song_rr"]["work_name"], "晚风(女声版)")
        eq("列表行 kept 是布尔", rows["song_rr"]["kept"], True)

        group = "batch-verify"
        req = dict(type="song", style="styleX", lyrics="第一行\n第二行")
        a = server.create_job(server.JobRequest(title="测试作品", work_group=group, **req))
        b = server.create_job(server.JobRequest(work_group=group, **req))
        eq("候选 A 自成根", a["work_root"], a["id"])
        eq("候选 A 标签", (a["version_tag"], a["version_no"]), ("候选 A", 1))
        eq("候选 B 并入同根", (b["work_root"], b["version_no"]), (a["id"], 2))
        eq("候选 B 标签", b["version_tag"], "候选 B")
        eq("候选共享作品名", b["work_name"], "测试作品")
        blank_group = server.create_job(server.JobRequest(work_group="   ", **req))
        eq("空白 work_group 当独立任务", blank_group["work_root"], blank_group["id"])
        try:
            server.create_job(server.JobRequest(work_group="x" * 121, **req))
            check("超长 work_group 被拒", False, "没有抛 400")
        except server.HTTPException as exc:
            eq("超长 work_group 被拒", exc.status_code, 400)

        server.patch_job(a["id"], {"version_label": "主歌版", "version_note": "副歌降 3key",
                                   "kept": True, "hidden": False})
        patched = server.get_job(a["id"])
        eq("PATCH 版本标签", patched["version_label"], "主歌版")
        eq("PATCH 版本说明", patched["version_note"], "副歌降 3key")
        eq("PATCH 保留标记", patched["kept"], True)

        renamed = server.rename_work(b["id"], {"name": "测试作品(女声版)"})
        eq("改名端点返回全部成员", sorted(renamed["members"]), sorted([a["id"], b["id"]]))
        eq("改名传播到全组", {r["work_name"] for r in renamed["rows"]}, {"测试作品(女声版)"})
        eq("改名已落库", db.get(a["id"])["work_name"], "测试作品(女声版)")
        try:
            server.rename_work(b["id"], {"name": "   "})
            check("空作品名被拒", False, "没有抛 400")
        except server.HTTPException as exc:
            eq("空作品名被拒", exc.status_code, 400)

        # 缺失 work_root 的存量行：不能 UPDATE 命中 0 行却谎报成功，要就地补根。
        orphan = server.create_job(server.JobRequest(**req))
        db.update(orphan["id"], work_root=None, work_name="")
        repaired = server.rename_work(orphan["id"], {"name": "补根作品"})
        eq("缺失 work_root 时改名就地补根", repaired["work_root"], orphan["id"])
        eq("缺失 work_root 时改名已落库", db.get(orphan["id"])["work_name"], "补根作品")

        # 示例曲随包发布，和删除/移动一样不允许改名。
        demo_like = server.create_job(server.JobRequest(**req))
        db.update(demo_like["id"], demo=True)
        try:
            server.rename_work(demo_like["id"], {"name": "不能改"})
            check("示例曲改名被拒", False, "没有抛 403")
        except server.HTTPException as exc:
            eq("示例曲改名被拒", exc.status_code, 403)

        split = server.move_job(b["id"], {"split": True})
        eq("拆分后自成根", split["work_root"], b["id"])
        eq("拆分后版本号从 1 起", split["version_no"], 1)
        eq("拆分作品名不带版本标签", split["work_name"], "测试作品(女声版)")
        merged = server.move_job(b["id"], {"target_root": a["id"]})
        eq("并回原作品", merged["work_root"], a["id"])
        eq("并入后版本号续排", merged["version_no"], 2)
        try:
            server.move_job(b["id"], {"target_root": a["id"]})
            check("重复并入被拒", False, "没有抛 409")
        except server.HTTPException as exc:
            eq("重复并入被拒", exc.status_code, 409)

        # 自动保留：组内无 kept 时第一条完成的版本置 ●，第二条不抢。
        server.ensure_loaded = lambda device: device
        server.send = lambda cmd, timeout: None
        server.index_artifacts = lambda job_id: {"audio.flac": True}
        server.missing_output_artifacts = lambda job_id, job_type: []
        server._recover_score_from_plan = lambda job_id: None
        server.schedule_alignment = lambda job: None

        g2 = "batch-keep"
        c1 = server.create_job(server.JobRequest(work_group=g2, **req))
        c2 = server.create_job(server.JobRequest(work_group=g2, **req))
        server.run_job(server.JOBS[c1["id"]])
        eq("完成的首个版本自动保留", db.get(c1["id"])["kept"], 1)
        server.run_job(server.JOBS[c2["id"]])
        check("后续完成版本不抢保留", db.get(c2["id"])["kept"] is None,
              repr(db.get(c2["id"])["kept"]))

        # 重启后继续建同批候选：版本号接着排。
        with server.LOCK:
            server.JOBS.clear()
        server.restore_jobs()
        c3 = server.create_job(server.JobRequest(work_group=g2, **req))
        eq("重启后同批候选不重号", c3["version_no"], 3)
        eq("重启后候选仍同根", c3["work_root"], c1["id"])

        # 崩溃恢复：磁盘上已有 result.json 的完成版本不经过 run_job，也要自动保留。
        crash = server.create_job(server.JobRequest(**req))
        out_dir = jobs_dir / crash["id"] / "out" / crash["id"]
        out_dir.mkdir(parents=True)
        (out_dir / "result.json").write_text("{}", encoding="utf-8")
        server.restore_jobs()
        recovered = server.get_job(crash["id"])
        eq("磁盘恢复的完成版本状态", recovered["status"], "complete")
        eq("磁盘恢复的完成版本自动保留", recovered["kept"], True)

        # 拆分/并入的保留标记：拆出来的完成版本是新组唯一成员，应拿 ●；
        # 并入已有 ● 的作品则不抢。
        g3 = "batch-move-keep"
        k1 = server.create_job(server.JobRequest(work_group=g3, **req))
        k2 = server.create_job(server.JobRequest(work_group=g3, **req))
        server.run_job(server.JOBS[k1["id"]])
        server.run_job(server.JOBS[k2["id"]])
        split_keep = server.move_job(k2["id"], {"split": True})
        eq("拆分完成版本自动保留", split_keep["kept"], True)
        eq("拆分完成版本落库为 ●", db.get(k2["id"])["kept"], 1)
        merged_keep = server.move_job(k2["id"], {"target_root": k1["id"]})
        check("并入已有保留的作品不抢 ●", merged_keep["kept"] is None,
              repr(merged_keep["kept"]))

        # 删掉中间版本后，自动标签按已有最大序号续排，不能撞出重复标签。
        g4 = "batch-tag-gap"
        t1 = server.create_job(server.JobRequest(work_group=g4, **req))
        t2 = server.create_job(server.JobRequest(work_group=g4, **req))
        eq("连续候选标签 A/B", (t1["version_tag"], t2["version_tag"]), ("候选 A", "候选 B"))
        db.update(t2["id"], version_tag="候选 C")  # 模拟中间候选被删/改标
        t3 = server.create_job(server.JobRequest(work_group=g4, **req))
        eq("候选标签按最大序号续排", t3["version_tag"], "候选 D")
        r1 = server.create_job(server.JobRequest(
            type="rerender", source=t1["id"], style="styleX", lyrics="第一行\n第二行",
            abc="X:1\nK:C\nC D E F|"))
        eq("首个派生标签从 1 起", r1["version_tag"], "改谱 1")
        db.update(r1["id"], version_tag="改谱 2")
        r2 = server.create_job(server.JobRequest(
            type="rerender", source=t1["id"], style="styleX", lyrics="第一行\n第二行",
            abc="X:1\nK:C\nC D E F|"))
        eq("派生标签按最大序号续排", r2["version_tag"], "改谱 3")

        # ---------------- 7. 版本移动的事务边界（跨进程并发 / 失败回滚 / 重试） ----------------
        import threading
        import time

        check("locked 错误判为可重试",
              db._is_move_retryable(sqlite3.OperationalError("database is locked")))
        check("约束错误不重试",
              not db._is_move_retryable(sqlite3.IntegrityError("UNIQUE constraint failed")))

        # 真跨进程并发并入同一目标组：MOVE_VERSION_LOCK 只在进程内有效，
        # 只能靠 BEGIN IMMEDIATE 的保留锁串行化读-改-写；修复前会各写同一个号。
        target = server.create_job(server.JobRequest(title="并发目标", **req))
        movers = [server.create_job(server.JobRequest(work_group=f"batch-mv-{i}", **req))
                  for i in range(8)]
        tasks = [(str(db_path), j["id"], target["work_root"], target["work_name"]) for j in movers]
        try:
            ctx = multiprocessing.get_context("spawn")
            with ctx.Pool(processes=len(tasks)) as pool:
                pool.map(_mp_move, tasks)
            concurrency_ok, concurrency_detail = True, ""
        except Exception as exc:  # noqa: BLE001
            concurrency_ok, concurrency_detail = False, f"{type(exc).__name__}: {exc}"
        check("跨进程并发移动全部成功", concurrency_ok, concurrency_detail)
        moved_rows = [r for r in db.list_jobs(limit=None) if r["work_root"] == target["work_root"]]
        numbers = sorted(r["version_no"] for r in moved_rows)
        check("跨进程并发移动不重号", len(set(numbers)) == len(numbers), repr(numbers))
        eq("跨进程并发移动版本号连续", numbers, list(range(1, len(movers) + 2)))

        # 失败回滚：移动已被删除的任务必须抛错，不能静默返回版本号、也不能留下半截写入。
        ghost = server.create_job(server.JobRequest(**req))
        db.delete(ghost["id"])
        before_no = (db.get(target["work_root"]) or {}).get("version_no")
        try:
            db.move_version(ghost["id"], target["work_root"], "幽灵", target["work_root"], False)
            check("移动已删除任务被拒", False, "没有抛 RuntimeError")
        except RuntimeError:
            check("移动已删除任务被拒", True)
        eq("失败移动不改变目标行版本号",
           (db.get(target["work_root"]) or {}).get("version_no"), before_no)
        try:
            db.move_version(ghost["id"], ghost["id"], "幽灵", ghost["id"], True, split=True)
            check("拆分已删除任务被拒", False, "没有抛 RuntimeError")
        except RuntimeError:
            check("拆分已删除任务被拒", True)

        # 重试：busy_timeout=0 制造必然 locked，靠退避重试拿锁；持锁线程先于调用方持有写锁。
        original_timeout = db.BUSY_TIMEOUT_MS
        retry_target = server.create_job(server.JobRequest(**req))
        mover2 = server.create_job(server.JobRequest(**req))
        ready = threading.Event()
        release = threading.Event()
        holder_errors: list[str] = []
        holder_conn: dict = {}

        def _hold_lock() -> None:
            try:
                conn = sqlite3.connect(db_path)
                holder_conn["conn"] = conn
                conn.execute("BEGIN IMMEDIATE")
                ready.set()
                release.wait(timeout=5)
                conn.commit()
            except Exception as exc:  # noqa: BLE001
                holder_errors.append(f"{type(exc).__name__}: {exc}")
            finally:
                if holder_conn.get("conn") is not None:
                    holder_conn["conn"].close()

        db.BUSY_TIMEOUT_MS = 0
        moved_no = None
        try:
            holder = threading.Thread(target=_hold_lock)
            holder.start()
            check("持锁线程进入就绪", ready.wait(timeout=5))
            threading.Timer(0.12, release.set).start()
            moved_no = db.move_version(mover2["id"], retry_target["work_root"], "重试目标",
                                       retry_target["work_root"], False)
            check("锁竞争下重试后移动成功", True)
        except Exception as exc:  # noqa: BLE001
            check("锁竞争下重试后移动成功", False, f"{type(exc).__name__}: {exc}")
        finally:
            release.set()
            holder.join(timeout=5)
            db.BUSY_TIMEOUT_MS = original_timeout
        eq("重试移动落定到目标组",
           (db.get(mover2["id"]) or {}).get("work_root"), retry_target["work_root"])
        eq("重试移动版本号正确", moved_no, 2)
        check("持锁线程无异常", not holder_errors, repr(holder_errors))

        # ---------------- 8. 并发版本号验收（建任务侧） ----------------
        def _concurrent(maker, count: int):
            barrier = threading.Barrier(count)
            results: list = []
            errors: list[str] = []

            def run_one() -> None:
                try:
                    barrier.wait(timeout=5)
                    results.append(maker())
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"{type(exc).__name__}: {exc}")

            threads = [threading.Thread(target=run_one) for _ in range(count)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=15)
            return results, errors

        # 同批候选并发建任务：必须归同一作品，版本号/标签都不能重号。
        g8 = "batch-concurrent-create"
        created, errors8 = _concurrent(
            lambda: server.create_job(server.JobRequest(work_group=g8, **req)), 10)
        check("并发建同批候选全部成功", not errors8 and len(created) == 10, repr(errors8[:3]))
        roots8 = {c["work_root"] for c in created}
        eq("并发候选归入同一作品", len(roots8), 1)
        rows8 = [r for r in db.list_jobs(limit=None) if r["work_root"] in roots8]
        nos8 = sorted(r["version_no"] for r in rows8)
        tags8 = sorted(r["version_tag"] for r in rows8)
        check("并发候选版本号不重号", len(set(nos8)) == len(nos8), repr(nos8))
        eq("并发候选版本号连续", nos8, list(range(1, len(rows8) + 1)))
        check("并发候选标签不重号", len(set(tags8)) == len(tags8), repr(tags8))

        # 同一来源并发建派生任务：改谱序号不能重号。
        base8 = server.create_job(server.JobRequest(**req))
        derived, errors8b = _concurrent(
            lambda: server.create_job(server.JobRequest(
                type="rerender", source=base8["id"], style="styleX",
                lyrics="第一行\n第二行", abc="X:1\nK:C\nC D E F|")), 10)
        check("并发建派生任务全部成功", not errors8b and len(derived) == 10,
              repr(errors8b[:3]))
        dnos = sorted(d["version_no"] for d in derived)
        dtags = sorted(d["version_tag"] for d in derived)
        check("并发派生版本号不重号", len(set(dnos)) == len(dnos), repr(dnos))
        check("并发派生标签不重号", len(set(dtags)) == len(dtags), repr(dtags))

        # ---------------- 9. 移动失败回滚与保留并发 ----------------
        # keep 以 db 事务内最新状态为准：多个完成版本并发并入同一个无 ● 的作品，
        # 只能有一个抢到保留位；调用方的事前判断不作为最终依据。
        keep_target = server.create_job(server.JobRequest(**req))
        winners = [server.create_job(server.JobRequest(**req)) for _ in range(4)]
        for w in winners:
            server.run_job(server.JOBS[w["id"]])
        barrier9 = threading.Barrier(len(winners))
        errors9: list[str] = []

        def _merge_for_keep(job: dict) -> None:
            try:
                barrier9.wait(timeout=5)
                server.move_job(job["id"], {"target_root": keep_target["id"]})
            except Exception as exc:  # noqa: BLE001
                errors9.append(f"{type(exc).__name__}: {exc}")

        threads9 = [threading.Thread(target=_merge_for_keep, args=(j,)) for j in winners]
        for t in threads9:
            t.start()
        for t in threads9:
            t.join(timeout=15)
        check("并发并入全部成功", not errors9, repr(errors9[:3]))
        target_rows = [r for r in db.list_jobs(limit=None)
                       if r["work_root"] == keep_target["work_root"]]
        eq("并发并入只有一个保留版本", sum(1 for r in target_rows if r["kept"]), 1)

        # 移动失败（db 层抛错）不得留下任何内存/索引副作用。
        victim = server.create_job(server.JobRequest(**req))
        before_fields = (db.get(victim["id"]) or {}).get("version_no")
        original_move = db.move_version

        def _boom(*args, **kwargs):
            raise RuntimeError("boom")

        db.move_version = _boom
        try:
            try:
                server.move_job(victim["id"], {"split": True})
                check("移动失败返回 500", False, "没有抛 HTTPException")
            except server.HTTPException as exc:
                eq("移动失败返回 500", exc.status_code, 500)
        finally:
            db.move_version = original_move
        after = db.get(victim["id"]) or {}
        eq("移动失败后索引归属不变", after.get("work_root"), victim["work_root"])
        eq("移动失败后索引版本号不变", after.get("version_no"), before_fields)
        live = server.JOBS.get(victim["id"])
        check("移动失败后内存版本号不变",
              live is not None and live.version_no == before_fields)

        # db 层防御：重复并入不再白白推进目标组版本号。
        dup_target = server.create_job(server.JobRequest(**req))
        mover_dup = server.create_job(server.JobRequest(**req))
        server.move_job(mover_dup["id"], {"target_root": dup_target["id"]})
        max_after_first = max(r["version_no"] for r in db.list_jobs(limit=None)
                              if r["work_root"] == dup_target["work_root"])
        try:
            db.move_version(mover_dup["id"], dup_target["work_root"],
                            dup_target["work_name"], dup_target["work_root"], False)
            check("重复并入被 db 拒绝", False, "没有抛 RuntimeError")
        except RuntimeError:
            check("重复并入被 db 拒绝", True)
        max_after_dup = max(r["version_no"] for r in db.list_jobs(limit=None)
                            if r["work_root"] == dup_target["work_root"])
        eq("重复并入不推进版本号", max_after_dup, max_after_first)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return report()


def report() -> int:
    failed = [name for name, ok, _ in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} 项通过")
    if failed:
        print("失败：" + "、".join(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
