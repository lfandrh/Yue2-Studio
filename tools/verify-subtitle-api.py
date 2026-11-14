"""启动真实服务，按 HTTP 契约验收字幕导出。

运行：
    python tools/verify-subtitle-api.py
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import unquote

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app import server, subtitles

PYTHON = ROOT / "YuE" / ".venv" / "Scripts" / "python.exe"
BASE_PORT = int(os.environ.get("VERIFY_PORT", "8099"))
BASE = f"http://127.0.0.1:{BASE_PORT}"
JOBS = ROOT / "runs" / "jobs"
DEMO = JOBS / "song_demo_wanfeng" / "out" / "song_demo_wanfeng"
TEMP_ID = "verify_subtitle_tmp"
RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(ok), detail))
    if not ok:
        print(f"FAIL {name}  -> {detail}")


def eq(name: str, actual, expected) -> None:
    check(name, actual == expected, f"actual={actual!r} expected={expected!r}")


def get(path: str):
    request = urllib.request.Request(BASE + path)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers, exc.read()


def get_json(path: str):
    status, headers, body = get(path)
    try:
        data = json.loads(body.decode("utf-8")) if body else None
    except ValueError:
        data = None
    return status, headers, data, body


def request_json(path: str, method: str, payload: dict):
    request = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8") or "{}")


def wait_ready(proc: subprocess.Popen) -> bool:
    deadline = time.time() + 45
    while time.time() < deadline:
        if proc.poll() is not None:
            return False
        try:
            status, _, _ = get("/api/model")
            if status == 200:
                return True
        except OSError:
            pass
        time.sleep(0.4)
    return False


def expect_error(name: str, path: str, code: int, contains: str) -> None:
    status, _, data, body = get_json(path)
    detail = (data or {}).get("detail", "") if isinstance(data, dict) else ""
    check(name, status == code and contains in detail,
          f"status={status} detail={detail!r} body={body[:120]!r}")


def verify_downloads() -> None:
    digest = hashlib.sha256((DEMO / "lyrics.json").read_bytes()).hexdigest()
    payload = json.loads((DEMO / "lyrics.json").read_text(encoding="utf-8"))
    cases = [
        ("", "srt", False),
        ("?format=lrc", "lrc", False),
        ("?format=LRC&enhanced=1", "lrc", True),
        ("?format=lrc&enhanced=true", "lrc", True),
    ]
    for query, fmt, enhanced in cases:
        status, headers, body = get(f"/api/jobs/song_demo_wanfeng/lyrics/subtitle{query}")
        label = f"{fmt}{' 逐字' if enhanced else ''}"
        check(f"{label}: HTTP 200", status == 200, str(status))
        expected_type = "application/x-subrip" if fmt == "srt" else "text/plain"
        check(f"{label}: Content-Type", headers.get("Content-Type", "").startswith(expected_type),
              headers.get("Content-Type", ""))
        disposition = headers.get("Content-Disposition", "")
        check(f"{label}: 附件下载头", disposition.startswith("attachment;"), disposition)
        filename = disposition.split("filename*=UTF-8''", 1)[-1]
        check(f"{label}: 文件名后缀", unquote(filename).endswith("." + fmt), filename)
        name = unquote(filename)
        if enhanced:
            check(f"{label}: 文件名标逐字", "(逐字)" in name, name)
        elif fmt == "lrc":
            check(f"{label}: 行级文件名不带逐字", "(逐字)" not in name, name)
        check(f"{label}: 禁止缓存", headers.get("Cache-Control") == "no-store",
              headers.get("Cache-Control", ""))
        check(f"{label}: nosniff", headers.get("X-Content-Type-Options") == "nosniff",
              headers.get("X-Content-Type-Options", ""))
        text = body.decode("utf-8")
        eq(f"{label}: 内容与纯函数一致", text, subtitles.render(payload, fmt, enhanced))
        check(f"{label}: 无 BOM", not body.startswith(b"\xef\xbb\xbf"))
        if fmt == "srt":
            check(f"{label}: CRLF", "\n" not in text.replace("\r\n", ""))
        else:
            check(f"{label}: LF", "\r" not in text)

    srt_status, srt_headers, srt_body = get("/api/jobs/song_demo_wanfeng/lyrics/subtitle")
    check("SRT 中文可用 UTF-8 读取", "晚风轻轻吹过窗前" in srt_body.decode("utf-8"))
    check("下载不改动时间轴文件",
          hashlib.sha256((DEMO / "lyrics.json").read_bytes()).hexdigest() == digest)

    for path in sorted(JOBS.glob("*/out/*/lyrics.json")):
        job_id = path.parent.parent.parent.name
        status, _, body = get(f"/api/jobs/{job_id}/lyrics/subtitle?format=lrc&enhanced=1")
        check(f"{job_id}: 逐字 LRC 可下载", status == 200 and b"<" in body,
              f"status={status} bytes={len(body)}")


def verify_errors() -> None:
    expect_error("SRT 不允许逐字", "/api/jobs/song_demo_wanfeng/lyrics/subtitle?format=srt&enhanced=1",
                 400, "SRT 不支持逐字")
    expect_error("未知格式", "/api/jobs/song_demo_wanfeng/lyrics/subtitle?format=ass", 400, "srt 或 lrc")
    expect_error("任务不存在", "/api/jobs/no_such_job_0912/lyrics/subtitle", 404, "job not found")
    expect_error("路径穿越", "/api/jobs/..%2F..%2Fetc/lyrics/subtitle", 404, "")
    status, headers, _ = get("/api/jobs/song_demo_wanfeng/lyrics/subtitle?format=srt")
    check("默认格式仍可用 GET", status == 200 and headers.get("Content-Disposition"), str(status))


def verify_health_and_security() -> None:
    """部署探活端点与安全响应头契约。"""
    status, _, data, _ = get_json("/api/health")
    eq("健康检查返回 200", status, 200)
    eq("健康检查状态 ok", (data or {}).get("status"), "ok")
    check("健康检查字段齐全",
          {"jobs", "queued", "subscribers", "model_busy", "time"} <= set(data or {}),
          repr(sorted((data or {}).keys())))

    expected_headers = {
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-origin",
    }
    for target in ("/", "/api/jobs"):
        _, headers, _ = get(target)
        for name, value in expected_headers.items():
            eq(f"{target} 响应带 {name}", headers.get(name), value)

    _, static_headers, _ = get("/static/js/app.js")
    eq("静态资源带 nosniff", static_headers.get("X-Content-Type-Options"), "nosniff")


def verify_missing_states() -> None:
    job_dir = JOBS / TEMP_ID
    out = job_dir / "out" / TEMP_ID
    shutil.rmtree(job_dir, ignore_errors=True)
    out.mkdir(parents=True)
    path = f"/api/jobs/{TEMP_ID}/lyrics/subtitle"
    try:
        expect_error("没有时间轴时给出等待提示", path, 409, "还没生成")
        (out / "lyrics.json").write_text("{bad", encoding="utf-8")
        expect_error("时间轴损坏可诊断", path, 409, "损坏")
        (out / "lyrics.json").write_text(json.dumps({"lines": []}), encoding="utf-8")
        expect_error("空时间轴可诊断", path, 409, "没有可导出")
        (out / "lyrics.json").unlink()
        (out / "lyrics.error.json").write_text(
            json.dumps({"reason": "音频识别失败"}, ensure_ascii=False), encoding="utf-8")
        expect_error("对齐失败原因可见", path, 409, "歌词对齐失败：音频识别失败")
        (out / "lyrics.error.json").unlink()
        payload = {"audio_seconds": 3.0, "lines": [
            {"text": "测试", "start": 1.0, "end": 3.0,
             "units": [{"text": "测", "start": 1.0, "end": 2.0},
                       {"text": "试", "start": 2.0, "end": 3.0}]}]}
        (out / "lyrics.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        status, headers, body = get(path + "?format=lrc&enhanced=1")
        text = body.decode("utf-8")
        check("无索引任务也能按磁盘导出", status == 200 and "测" in text and "试" in text,
              f"status={status} body={body[:80]!r}")
        check("无索引任务文件名兜底", "yue2" in unquote(headers.get("Content-Disposition", "")),
              headers.get("Content-Disposition", ""))

        (out / "lyrics.json").write_text(json.dumps(
            {"audio_seconds": 10.0, "lines": [
                {"text": "  A --> B  ", "start": 1.0, "end": 2.0}]},
            ensure_ascii=False), encoding="utf-8")
        status, _, body = get(path + "?format=srt")
        eq("接口保留首尾空格与 -->", body.decode("utf-8"),
           "1\r\n00:00:01,000 --> 00:00:02,000\r\n  A --> B  \r\n")

        (out / "lyrics.json").write_text(json.dumps(
            {"lines": [{"text": "a\r\nb", "start": 1.0, "end": 2.0}]},
            ensure_ascii=False), encoding="utf-8")
        status, _, body = get(path + "?format=lrc")
        check("接口把歌词内换行压成空格", status == 200 and body.decode("utf-8") == "[00:01.00]a b\n",
              f"status={status} body={body[:60]!r}")

        (out / "lyrics.json").write_text(json.dumps(
            {"lines": [{"text": "a\x00b", "start": 1.0, "end": 2.0}]},
            ensure_ascii=False), encoding="utf-8")
        expect_error("控制字符给出原因", path, 409, "控制字符")

        (out / "lyrics.json").write_text(json.dumps(
            {"audio_seconds": 2.0, "lines": [{"text": "x", "start": 3.0, "end": 4.0}]},
            ensure_ascii=False), encoding="utf-8")
        expect_error("行级 LRC 起点越界给出原因", path + "?format=lrc", 409, "开始时间超出音频结尾")
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


def _read_sse(stream, count: int, timeout: float = 5.0) -> list[dict]:
    """Read data frames; keep SSE ids/comments separately for stream assertions."""
    frames: list[dict] = []
    event_name = ""
    event_id = ""
    deadline = time.time() + timeout
    while len(frames) < count:
        if time.time() > deadline:
            raise AssertionError(f"SSE timeout after {len(frames)} data frames")
        raw = stream.readline()
        if not raw:
            continue
        line = raw.decode("utf-8").rstrip("\r\n")
        if line.startswith("id:"):
            event_id = line.split(":", 1)[1].strip()
        elif line.startswith("event:"):
            event_name = line.split(":", 1)[1].strip()
        elif line.startswith("data:"):
            frames.append({"name": event_name, "id": event_id,
                           "data": json.loads(line.split(":", 1)[1].strip())})
            event_name = ""
            event_id = ""
    return frames


def verify_sse_frontend_contract() -> None:
    """Static contract: client handles ready frames, sequence gaps, and a full resync."""
    text = (ROOT / "app" / "static" / "js" / "store.js").read_text(encoding="utf-8")
    checks = {
        "监听 ready 事件": 'source.addEventListener("ready"',
        "ready 基线校准": 'eventSeq = Number.isInteger(seq) ? seq : null;',
        "检测事件断号": 'if (seqGap(eventSeq, seq))',
        "断号重新拉全量任务": 'loadJobs().catch(() => {});',
        "重连清理旧序号": 'eventSeq = null;',
    }
    for label, needle in checks.items():
        check(label, needle in text, repr(needle))


async def verify_sse_sequence() -> None:
    """Broadcast carries one shared sequence and the event stream emits it as SSE id."""
    original_seq = server.EVENT_SEQ["value"]
    server.EVENT_SEQ["value"] = 0
    server.QUEUE.queue.clear()

    class FakeSub:
        def __init__(self):
            self.items = []

        def put_nowait(self, item):
            self.items.append(item)

    fake_sub = FakeSub()
    with server.SUB_LOCK:
        server.SUBSCRIBERS.clear()
        server.SUBSCRIBERS.add(fake_sub)
    try:
        first_payload = {"event": "probe", "value": 1}
        server.broadcast(first_payload)
        second_payload = {"event": "probe", "value": 2}
        server.broadcast(second_payload)
        eq("共享事件序号从 1 单调递增", [item["seq"] for item in fake_sub.items], [1, 2])
        eq("广播不修改调用方事件", first_payload, {"event": "probe", "value": 1})
        check("连续事件不误报断号", not server._event_gap(1, 2), "1 -> 2")
        check("丢号可被序号识别", server._event_gap(1, 3), "1 -> 3")
        check("新订阅不误报断号", not server._event_gap(None, 3), "None -> 3")

        stream = server.events()
        source = stream.body_iterator.__aiter__()
        ready = await anext(source)
        eq("SSE 首帧声明 ready", ready, 'event: ready\ndata: {"seq": 2}\n\n')
        server.broadcast({"event": "probe", "value": 3})
        emitted = await anext(source)
        await source.aclose()
        check("SSE 帧带 id 与 event", emitted.startswith("id: 3\ndata: "), repr(emitted))
        event = json.loads(emitted.split("data: ", 1)[1])
        eq("SSE 帧保留事件正文与序号", (event["event"], event["value"], event["seq"]),
           ("probe", 3, 3))
    finally:
        with server.SUB_LOCK:
            server.SUBSCRIBERS.clear()
        server.EVENT_SEQ["value"] = original_seq


async def verify_sse_replay() -> None:
    """重连带 Last-Event-ID 时先补发漏掉的事件，再声明 ready 基线。"""
    original_seq = server.EVENT_SEQ["value"]
    server.EVENT_SEQ["value"] = 0
    server.EVENT_HISTORY.clear()
    server.QUEUE.queue.clear()

    class FakeSub:
        def __init__(self):
            self.items = []

        def put_nowait(self, item):
            self.items.append(item)

    fake_sub = FakeSub()
    with server.SUB_LOCK:
        server.SUBSCRIBERS.clear()
        server.SUBSCRIBERS.add(fake_sub)
    try:
        for value in (1, 2, 3):
            server.broadcast({"event": "probe", "value": value})
        check("广播进入历史缓冲",
              [item["seq"] for item in server.EVENT_HISTORY] == [1, 2, 3],
              repr([item["seq"] for item in server.EVENT_HISTORY]))

        stream = server.events(last_event_id="1")
        source = stream.body_iterator.__aiter__()
        frames = [await anext(source) for _ in range(3)]
        await source.aclose()
        first_values = json.loads(frames[0].split("data: ", 1)[1])
        second_values = json.loads(frames[1].split("data: ", 1)[1])
        eq("重连首帧重放漏掉的事件 2",
           (first_values["seq"], first_values["value"]), (2, 2))
        eq("第二帧重放事件 3",
           (second_values["seq"], second_values["value"]), (3, 3))
        eq("重放后 ready 声明当前基线", frames[2],
           'event: ready\ndata: {"seq": 3}\n\n')

        stream2 = server.events()
        src2 = stream2.body_iterator.__aiter__()
        first2 = await anext(src2)
        await src2.aclose()
        eq("无 Last-Event-ID 时首帧即 ready", first2,
           'event: ready\ndata: {"seq": 3}\n\n')

        stream3 = server.events(last_event_id="0")
        src3 = stream3.body_iterator.__aiter__()
        frames3 = [await anext(src3) for _ in range(4)]
        await src3.aclose()
        eq("过期 Last-Event-ID 重放全部历史",
           [json.loads(f.split("data: ", 1)[1])["value"] for f in frames3[:3]], [1, 2, 3])
        eq("重放全部后基线不变", frames3[3],
           'event: ready\ndata: {"seq": 3}\n\n')

        stream4 = server.events(last_event_id="not-a-number")
        src4 = stream4.body_iterator.__aiter__()
        first4 = await anext(src4)
        await src4.aclose()
        eq("非法 Last-Event-ID 不影响握手", first4,
           'event: ready\ndata: {"seq": 3}\n\n')

        stream5 = server.events(last_event_id="3")
        src5 = stream5.body_iterator.__aiter__()
        first5 = await anext(src5)
        await src5.aclose()
        eq("Last-Event-ID 等于当前序号时不重放", first5,
           'event: ready\ndata: {"seq": 3}\n\n')
    finally:
        with server.SUB_LOCK:
            server.SUBSCRIBERS.clear()
        server.EVENT_SEQ["value"] = original_seq
        server.EVENT_HISTORY.clear()


def verify_job_log_pagination() -> None:
    """Log reads must stay incremental and keep the legacy tail-window contract."""
    job_id = "song_verify_log_pagination"
    job_dir = JOBS / job_id
    log_dir = job_dir / ".meta"
    log_path = log_dir / "run.log"
    all_lines = [f"line {index}" for index in range(10)]

    def call(**params):
        query = "&".join(f"{key}={value}" for key, value in params.items())
        path = f"/api/jobs/{job_id}/log" + (f"?{query}" if query else "")
        status, _, data, _ = get_json(path)
        eq(f"日志接口返回 200 {query or '(默认参数)'}", status, 200)
        return data or {}

    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path.write_text("\n".join(all_lines), encoding="utf-8")

        missing_status, _, missing, _ = get_json("/api/jobs/song_verify_missing_log/log")
        eq("日志不存在仍返回 200", missing_status, 200)
        eq("日志不存在返回空分页", {
            "offset": (missing or {}).get("offset"), "limit": (missing or {}).get("limit"),
            "total_lines": (missing or {}).get("total_lines"),
            "text": (missing or {}).get("text"), "lines": (missing or {}).get("lines"),
        }, {"offset": 0, "limit": 0, "total_lines": 0, "text": "", "lines": []})

        legacy = call(lines=4)
        eq("旧 lines 参数仍读末尾窗口", legacy.get("lines"), all_lines[-4:])
        eq("旧 lines 返回实际行数", legacy.get("limit"), 4)
        eq("旧 lines 报告总行数", legacy.get("total_lines"), 10)

        first = call(offset=0, limit=4)
        eq("首次 offset 读前四行", first.get("lines"), all_lines[:4])
        eq("首次分页返回起始位置", first.get("offset"), 0)
        eq("首次分页报告总行数", first.get("total_lines"), 10)

        second = call(offset=4, limit=4)
        eq("第二次 offset 读接续窗口", second.get("lines"), all_lines[4:8])

        edge = call(offset=8, limit=4)
        eq("最后不足一页自动截断", edge.get("lines"), all_lines[8:])

        beyond = call(offset=12, limit=4)
        eq("越界 offset 返回空窗口", beyond.get("lines"), [])
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


def verify_score_concurrency() -> None:
    """Two stale score writers must not overwrite each other."""
    job_id = "song_verify_score_concurrency"
    directory = server.job_artifacts(job_id)
    path = directory / server.SCORE_ARTIFACT
    first = "X:1\nT:\nM:4/4\nL:1/4\nK:C\nC D E F|\n"
    second = "X:1\nT:\nM:4/4\nL:1/4\nK:C\nG A B c|\n"
    third = "X:1\nT:\nM:4/4\nL:1/4\nK:C\nc B A G|\n"
    route = f"/api/jobs/{job_id}/score"
    try:
        directory.mkdir(parents=True, exist_ok=True)
        path.write_text(first, encoding="utf-8", newline="\n")

        status, headers, loaded, _ = get_json(route)
        eq("谱面版本接口返回 200", status, 200)
        first_hash = (loaded or {}).get("sha256")
        check("谱面响应带 sha256", bool(first_hash), repr(first_hash))
        eq("谱面 ETag 与 sha256 一致", headers.get("ETag"), f'"{first_hash}"')

        missing_status, missing = request_json(route, "PUT", {"abc": second})
        eq("缺少版本哈希拒绝写回", missing_status, 428)
        eq("谱面未因缺少版本被覆盖", path.read_text(encoding="utf-8"), first)

        stale_status, stale = request_json(
            route, "PUT", {"abc": second, "expected_sha256": "stale"})
        eq("旧版本写回返回 409", stale_status, 409)
        check("冲突响应说明原因", "其他页面" in str((stale or {}).get("detail", "")),
              repr((stale or {}).get("detail")))
        eq("冲突写回不覆盖服务器谱面", path.read_text(encoding="utf-8"), first)

        saved_status, saved = request_json(
            route, "PUT", {"abc": second, "expected_sha256": first_hash})
        eq("匹配版本可写回", saved_status, 200)
        eq("匹配版本写回状态", (saved or {}).get("status"), "saved")
        second_hash = (saved or {}).get("sha256")
        check("写回后返回新 sha256", bool(second_hash) and second_hash != first_hash,
              repr(second_hash))
        eq("匹配版本写回落到磁盘", path.read_text(encoding="utf-8"), second)

        unchanged_status, unchanged = request_json(
            route, "PUT", {"abc": second, "expected_sha256": second_hash})
        eq("同版本同内容返回 200", unchanged_status, 200)
        eq("同版本同内容不重复备份", (unchanged or {}).get("status"), "unchanged")

        old_tab_status, old_tab = request_json(
            route, "PUT", {"abc": third, "expected_sha256": first_hash})
        eq("另一标签旧版本写回返回 409", old_tab_status, 409)
        eq("另一标签旧版本未覆盖新谱", path.read_text(encoding="utf-8"), second)
    finally:
        shutil.rmtree(server.job_dir(job_id), ignore_errors=True)


def verify_effective_lyrics_snapshot() -> None:
    """Derived jobs carry a lyrics snapshot that survives source deletion."""
    child_id = "song_verify_effective_snapshot"
    source_lyrics = "[Verse]" + os.linesep + "源任务歌词"
    snapshot_lyrics = "[Verse]" + os.linesep + "快照歌词"
    child = server.Job(child_id, "redecode", {"lyrics": ""}, source="verify_snapshot_source")
    job_dir = JOBS / child_id

    class FakeDB:
        @staticmethod
        def get(job_id):
            if job_id == "verify_snapshot_source":
                return {
                    "id": job_id, "type": "song", "status": "complete",
                    "requested": {"lyrics": source_lyrics},
                }
            return None

    original_db = server.db
    try:
        server.db = FakeDB()
        eq("无快照时派生任务回退源任务歌词",
           server._effective_lyrics(child), source_lyrics)

        requested_child = server.Job(
            child_id, "redecode", {"lyrics": snapshot_lyrics}, source="verify_snapshot_source")
        eq("创建时请求歌词优先于源任务歌词",
           server._effective_lyrics(requested_child), snapshot_lyrics)

        child_dir = job_dir / ".meta"
        child_dir.mkdir(parents=True, exist_ok=True)
        (child_dir / "effective_request.json").write_text(
            json.dumps({"lyrics": snapshot_lyrics, "source": "verify_snapshot_source"},
                       ensure_ascii=False), encoding="utf-8")
        eq("有快照时派生任务读取快照歌词",
           server._effective_lyrics(child), snapshot_lyrics)
    finally:
        server.db = original_db
        shutil.rmtree(job_dir, ignore_errors=True)


def verify_derived_lyrics() -> None:
    """Derived jobs can inherit lyrics through their complete source job."""
    source_id = "verify_subtitle_source"
    child_id = "song_verify_subtitle_child"
    lyrics = "[Verse]\n源任务歌词"
    rows = {
        source_id: {
            "id": source_id, "type": "song", "status": "complete",
            "created_at": 1.0, "updated_at": 1.0,
            "requested": {"style": "Mandarin", "lyrics": lyrics},
        },
        child_id: {
            "id": child_id, "type": "redecode", "status": "complete",
            "parent_id": source_id, "created_at": 2.0, "updated_at": 2.0,
            "requested": {"style": "Mandarin", "lyrics": ""},
        },
    }

    class FakeDB:
        @staticmethod
        def get(job_id):
            return rows.get(job_id)

    original_db = server.db
    try:
        server.db = FakeDB()
        child = server._api_row(rows[child_id])
        check("派生任务列表行继承源歌词可用性",
              child["lyrics_len"] == len(lyrics) and child["lyrics_head"] == "源任务歌词",
              repr(child))
        check("派生任务列表仍不返回歌词正文", "lyrics" not in child["requested"],
              repr(child["requested"]))
        child_full = server._api_row(rows[child_id], full=True)
        eq("派生任务详情正文仍来自本任务请求", child_full["requested"].get("lyrics"), "")
        check("派生任务最终可用歌词与导出端点一致",
              server._job_lyrics(server.Job(child_id, "redecode",
                                            rows[child_id]["requested"], source=source_id))
              == lyrics)
    finally:
        server.db = original_db

    status, invalid = request_json(
        "/api/jobs", "POST",
        {"type": "staged", "source": source_id, "from_stage": "plan"})
    eq("缺失源任务仍拒绝派生任务", status, 404)
    check("缺失源任务给出原因", "source job not found" in str(invalid.get("detail", "")),
          repr(invalid))


def main() -> int:
    if not PYTHON.exists():
        print(f"缺少项目解释器：{PYTHON}")
        return 2
    proc = subprocess.Popen(
        [str(PYTHON), "-m", "uvicorn", "app.server:app", "--host", "127.0.0.1",
         "--port", str(BASE_PORT), "--log-level", "warning"],
        cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        encoding="utf-8", errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        if not wait_ready(proc):
            try:
                output = proc.stdout.read() if proc.stdout else ""
            except ValueError:
                output = ""
            print(f"服务未能启动（exit={proc.poll()}）：\n{output[-2000:]}")
            return 2
        verify_downloads()
        verify_health_and_security()
        verify_errors()
        verify_missing_states()
        verify_sse_frontend_contract()
        asyncio.run(verify_sse_sequence())
        asyncio.run(verify_sse_replay())
        verify_job_log_pagination()
        verify_score_concurrency()
        verify_effective_lyrics_snapshot()
        verify_derived_lyrics()
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()
    failed = [item for item in RESULTS if not item[1]]
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} 项通过")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
