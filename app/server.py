"""YuE2 web backend: job queue over a resident model worker, with SQLite indexing.

Artifacts stay on disk under runs/jobs/<id>/out/<id>/ (the official protocol);
SQLite only indexes job metadata. Progress is streamed over SSE, with a 15s
poll fallback available through GET /api/jobs.
"""
from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import align, db, logs, score_edit, score_tools

log = logs.setup()

ROOT = Path(__file__).resolve().parents[1]
KIT = ROOT / "YuE"
PYTHON_EXE = KIT / ".venv" / "Scripts" / "python.exe"
WORKER_SCRIPT = ROOT / "app" / "model_worker.py"
MODEL_DIR = KIT / "models" / "YuE2-3B"
VAE_DIR = KIT / "models" / "YuE2-Vae"
VAE_LEGACY_DIR = KIT / "models" / "YuE2-Vae-legacy"
JOBS_DIR = ROOT / "runs" / "jobs"
TRASH_DIR = ROOT / "runs" / "_trash"
TRASH_TTL_DAYS = 30
MIN_FREE_GIB = 5.0

STAGE_ZH = {
    "Resolving model files": "解析模型路径",
    "Verifying model files": "校验模型权重",
    "Loading model": "加载模型",
    "Planning score": "规划乐谱",
    "Using provided score": "采用导入乐谱",
    "Generating song": "生成语义序列",
    "Synthesizing audio": "音频合成 (NAR)",
    "Decoding audio": "解码导出音频",
    "Loading audio decoder": "加载音频解码器",
}
STAGE_PHASE = {
    "Planning score": "plan", "Using provided score": "plan",
    "Generating song": "semantic",
    "Synthesizing audio": "nar", "Decoding audio": "decode",
    "Loading audio decoder": "decode",
    "Loading model": "load", "Resolving model files": "load", "Verifying model files": "load",
}
PROGRESS_RE = re.compile(r"^\[YuE2\] (Running|Starting|Completed) ([^:]+): (.*)$")
JOB_TYPES = ("song", "plan", "rerender", "staged", "redecode")
ARTIFACT_NAMES = {
    "audio.flac": "audio/flac", "score.abc": "text/plain; charset=utf-8",
    "plan.json": "application/json", "plan_manifest.json": "application/json",
    "config.json": "application/json", "request.json": "application/json",
    "result.json": "application/json", "failure.json": "application/json",
    "latent.npy": "application/octet-stream", "semantic.npy": "application/octet-stream",
    "abc_tokens.npy": "application/octet-stream", "prefix.npy": "application/octet-stream",
}

presets = [
    {"id": "zh-citypop", "name": "华语城市流行", "language": "zh",
     "style": "Mandarin, city pop, warm female vocal, electric piano, acoustic guitar, 92 BPM",
     "lyrics": "[Verse]\n晚风轻轻吹过窗前\n你留下的笑还在昨天\n[Chorus]\n让这首歌陪你走远\n把所有想念唱成明天"},
    {"id": "zh-folk", "name": "中文民谣叙事", "language": "zh",
     "style": "Mandarin, folk ballad, acoustic guitar, soft male vocal, 76 BPM",
     "lyrics": "[Verse]\n小城的灯一盏盏亮起\n旧车站还留着你的气息\n[Chorus]\n如果时间可以倒回去\n我还是会走进那场雨"},
    {"id": "zh-rock", "name": "华语摇滚", "language": "zh",
     "style": "Mandarin, mandarin rock, electric guitar, driving drums, male vocal, 128 BPM",
     "lyrics": "[Verse]\n把所有的沉默都点燃\n让心跳盖过这座城市\n[Chorus]\n就算明天不会到来\n今夜我们也要大声唱"},
    {"id": "zh-ballad", "name": "中文抒情慢歌", "language": "zh",
     "style": "Mandarin, soft ballad, piano, strings, breathy female vocal, 68 BPM",
     "lyrics": "[Verse]\n窗外的雨下得很轻\n像你说话时的声音\n[Chorus]\n我学会了一个人生活\n却还没学会不想你"},
    {"id": "en-synthwave", "name": "Synthwave", "language": "en",
     "style": "English, synthwave, breathy female vocal, analog synth, gated drums, 104 BPM",
     "lyrics": "[Verse]\nNeon running down the boulevard\nMidnight calls and we are still awake\n[Chorus]\nHold the night a little longer\nWe were never meant to fade"},
    {"id": "en-jazz", "name": "Jazz-funk", "language": "en",
     "style": "English, jazz-funk, warm lead vocal, Rhodes, slap bass, 96 BPM",
     "lyrics": "[Verse]\nCoffee cooling on the windowsill\nCity humming like a quiet chord\n[Chorus]\nLet the rhythm take the evening\nWe can dance across the floor"},
    {"id": "en-acoustic", "name": "Acoustic pop", "language": "en",
     "style": "English, acoustic pop, soft female vocal, acoustic guitar, light percussion, 88 BPM",
     "lyrics": "[Verse]\nPaper planes above the garden\nSummer leaning on the door\n[Chorus]\nSay it slow, say it softly\nI will meet you where we were"},
    {"id": "yue-canto", "name": "粵語流行", "language": "zh",
     "style": "Cantonese, cantopop, warm female vocal, piano, strings, 84 BPM",
     "lyrics": "[Verse]\n舊街燈影照著你我的身影\n把未完的話都留給晚風\n[Chorus]\n如果這一晚可以重來\n我會握緊你的手不放開"},
]

@asynccontextmanager
async def lifespan(_: FastAPI):
    log.info("服务启动，日志写入 %s", logs.LOG_PATH)
    try:
        restore_jobs()
        seed_demo()
        prune_trash()
    except Exception:  # noqa: BLE001 - the index is rebuildable; a bad DB must not block startup
        log.exception("启动时恢复任务索引失败，先以空索引运行")
    threading.Thread(target=worker, daemon=True).start()
    yield
    with MODEL_LOCK:
        if MODEL["state"] == "loaded":
            try:
                _unload_locked()
            except Exception:  # noqa: BLE001 - shutdown must not mask the real error
                log.exception("退出时卸载模型失败")
        terminate_worker()
    log.info("服务已停止")


app = FastAPI(title="YuE2 Web", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=ROOT / "app" / "static"), name="static")


@app.middleware("http")
async def static_revalidate(request: Request, call_next):
    """静态文件每次都回源校验：本地更新后刷新即生效，不让浏览器沿用旧的 JS/CSS。"""
    response = await call_next(request)
    if request.url.path in ("/", "/legacy") or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response

MAX_BODY_BYTES = 2 * 1024 * 1024


@app.exception_handler(RequestValidationError)
async def invalid_request(request: Request, exc: RequestValidationError) -> JSONResponse:
    """Flatten FastAPI's error list: the UI shows one readable line, not [object Object]."""
    errors = exc.errors()
    detail = "；".join(_validation_message(error) for error in errors[:3]) or "无法解析请求"
    log.warning("请求参数有误 %s %s：%s", request.method, request.url.path, detail)
    return JSONResponse(status_code=422,
                        content={"detail": f"请求参数有误：{detail}",
                                 "errors": jsonable_encoder(errors)})


@app.exception_handler(Exception)
async def unhandled_exception(request: Request, exc: Exception) -> JSONResponse:
    trace = uuid.uuid4().hex[:8]
    log.error("未处理异常 trace=%s %s %s", trace, request.method, request.url.path, exc_info=exc)
    return JSONResponse(status_code=500,
                        content={"detail": f"服务内部错误（编号 {trace}），详情见 runs/app.log",
                                 "trace": trace})


VALIDATION_ZH = {
    "Field required": "必填",
    "Input should be a valid string": "必须是文本",
    "Input should be a valid integer": "必须是整数",
    "Input should be a valid number": "必须是数字",
    "Input should be a valid boolean": "必须是布尔值",
    "Input should be a valid dictionary or object to extract fields from": "必须是 JSON 对象",
    "Input should be a valid list": "必须是数组",
}


def _validation_message(error: dict) -> str:
    location = ".".join(str(part) for part in error.get("loc", ()) if part != "body") or "请求体"
    return f"{location} {VALIDATION_ZH.get(error.get('msg', ''), error.get('msg', ''))}".strip()


@app.middleware("http")
async def limit_body(request, call_next):
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
        # 先把请求体读完再回 413：直接返回会让连接被重置，浏览器只能看到"网络错误"
        async for _ in request.stream():
            pass
        return JSONResponse({"detail": "请求体过大"}, status_code=413)
    return await call_next(request)


# ---------------------------------------------------------------- GPU / model
def probe_gpu() -> dict:
    command = ["nvidia-smi", "--query-gpu=name,memory.total,memory.free,compute_cap",
               "--format=csv,noheader,nounits"]
    unknown = {"available": False, "suitable": False, "name": "", "compute_capability": None,
               "reason": "未检测到 NVIDIA GPU"}
    try:
        run = subprocess.run(command, capture_output=True, text=True, timeout=10,
                             encoding="utf-8", errors="replace",
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except FileNotFoundError:
        return unknown  # 没装 CUDA 驱动的机器上这是常态，每 5 秒轮询一次，不该刷日志
    except (OSError, subprocess.SubprocessError) as exc:
        log.warning("GPU 查询失败：%s: %s", type(exc).__name__, exc)
        return {**unknown, "reason": f"GPU 查询失败（{type(exc).__name__}）"}
    line = next((x for x in (run.stdout or "").splitlines() if x.strip()), "")
    if run.returncode != 0 or not line:
        log.debug("nvidia-smi 返回 %s：%s", run.returncode, (run.stderr or line)[:200])
        return {**unknown, "reason": "未检测到可用的 NVIDIA GPU"}
    try:
        name, total, free, capability = (part.strip() for part in line.split(",")[:4])
        total_gib, free_gib, capability = float(total) / 1024, float(free) / 1024, float(capability)
    except ValueError:
        log.warning("无法解析 nvidia-smi 输出：%s", line[:200])
        return {"available": True, "suitable": False, "name": line, "compute_capability": None,
                "reason": "无法读取 GPU 信息"}
    if capability < 8.0:
        suitable, reason = False, f"{name} 不支持 BF16（算力 {capability:.1f}），使用 CPU"
    elif free_gib < MIN_FREE_GIB:
        suitable, reason = False, f"{name} 空闲显存 {free_gib:.1f} GiB，低于 {MIN_FREE_GIB:.0f} GiB，使用 CPU"
    else:
        suitable, reason = True, ""
    return {"available": True, "suitable": suitable, "name": name,
            "total_gib": round(total_gib, 1), "free_gib": round(free_gib, 1),
            "compute_capability": capability, "reason": reason}


GPU = probe_gpu()
DEFAULT_DEVICE = "cuda" if GPU["suitable"] else "cpu"

_GPU_LIVE = {"at": 0.0, "data": None}
_GPU_LIVE_LOCK = threading.Lock()


def gpu_live() -> dict:
    now = time.time()
    with _GPU_LIVE_LOCK:
        if _GPU_LIVE["data"] is None or now - _GPU_LIVE["at"] > 5:
            _GPU_LIVE["data"] = probe_gpu()
            _GPU_LIVE["at"] = now
        return _GPU_LIVE["data"]

MODEL = {"state": "unloaded", "device": None, "device_name": "", "reason": "",
         "seconds": None, "load": {}}
MODEL_BUSY = False
CUDA_BLOCKED = ""
MODEL_LOCK = threading.RLock()
WORKER: dict = {"proc": None, "log": None}
EVENTS: queue.Queue = queue.Queue()
CURRENT_JOB = {"id": None}
SUBSCRIBERS: set = set()
SUB_LOCK = threading.Lock()
DOCTOR_CACHE = {"at": 0.0, "data": None}
DROPPED = {"count": 0}


# ------------------------------------------------------------------- job models
class JobRequest(BaseModel):
    type: str = "song"
    style: Any = ""
    lyrics: Any = ""
    seed: int | None = None
    cot: str = "full"
    device: str = "auto"
    abc: str | None = None
    cfg_scale: float | None = None
    abc_sampling: dict | None = None
    semantic_sampling: dict | None = None
    ode_steps: int | None = None
    vae: str | None = None
    source: str | None = None
    from_stage: str | None = None
    title: str | None = None


class Job:
    def __init__(self, job_id: str, job_type: str = "song", request: dict | None = None,
                 *, source: str | None = None, from_stage: str | None = None,
                 vae: str | None = None, ode_steps: int | None = None,
                 title: str = "", parent_id: str | None = None, demo: bool = False):
        self.id = job_id
        self.type = job_type
        self.request = request or {}
        self.source = source
        self.from_stage = from_stage
        self.vae = vae
        self.ode_steps = ode_steps
        self.title = title or ""
        self.parent_id = parent_id or source
        self.variant_group = None
        self.favorite = False
        self.demo = demo
        self.status = "queued"
        self.stage = ""
        self.progress = ""
        self.error = ""
        self.result: dict = {}
        self.artifacts: dict = {}
        self.effective: dict = {}
        self.created_at = time.time()
        self.updated_at = self.created_at

    def to_db(self) -> dict:
        r = self.result or {}
        truncated = r.get("truncated")
        if isinstance(truncated, dict):
            truncated = any(bool(v) for v in truncated.values())
        return {
            "id": self.id, "type": self.type, "status": self.status,
            "stage": self.stage, "progress": self.progress,
            "device": self.request.get("device", ""),
            "style": self.request.get("style", ""),
            "title": self.title, "seed": self.request.get("seed"),
            "cot": self.request.get("cot", ""),
            "created_at": self.created_at, "updated_at": time.time(),
            "parent_id": self.parent_id, "variant_group": self.variant_group,
            "favorite": self.favorite, "error": self.error,
            "duration": r.get("audio_seconds"),
            "truncated": (bool(truncated) if truncated is not None else None),
            "ode_steps": self.ode_steps, "vae": self.vae, "demo": self.demo,
            "requested": self.request, "effective": self.effective,
            "artifacts": self.artifacts, "result": self.result,
        }

    def to_dict(self) -> dict:
        return _api_row(self.to_db())


JOBS: dict[str, Job] = {}
QUEUE: queue.Queue[str] = queue.Queue()
LOCK = threading.Lock()


JOB_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_]{1,63}$")


def job_path(job_id: str) -> Path:
    """任务目录的唯一入口：字符集 + 解析后必须仍在 runs/jobs 下一层。"""
    if not JOB_ID_RE.match(job_id or ""):
        raise HTTPException(404, "job not found")
    base = JOBS_DIR.resolve()
    path = (base / job_id).resolve()
    if path.parent != base:
        raise HTTPException(404, "job not found")
    return path


def job_dir(job_id: str) -> Path:
    return job_path(job_id)


def job_artifacts(job_id: str) -> Path:
    return job_path(job_id) / "out" / job_id


PLAN_ARTIFACTS = ("plan.json", "plan_manifest.json", "abc_tokens.npy", "prefix.npy")


def missing_source_artifacts(source: Path, stage: str) -> list[str]:
    """Names a staged/redecode run needs but the source did not produce."""
    if not source.exists():
        return ["产物目录"]
    required = [*PLAN_ARTIFACTS, "semantic.npy" if stage == "semantic" else (),
                "latent.npy" if stage == "redecode" else ()]
    missing = [name for name in required if name and not (source / name).exists()]
    if (source / "plan.json").exists() and (_read_json(source / "plan.json") or {}).get("abc") is not None \
            and not (source / "score.abc").exists():
        missing.append("score.abc")
    return missing


def model_status_dict() -> dict:
    gpu = gpu_live()
    if MODEL["state"] == "loaded" and MODEL["device"] == "cuda":
        # 显存是我们自己的模型占的，不能据此判定「GPU 不可用、自动降级 CPU」
        gpu = {**gpu, "suitable": True, "reason": ""}
    return {"state": MODEL["state"], "device": MODEL["device"],
            "device_name": MODEL["device_name"], "reason": MODEL["reason"],
            "seconds": MODEL["seconds"], "busy": MODEL_BUSY,
            "gpu": gpu, "default_device": DEFAULT_DEVICE}


# ------------------------------------------------------------------- SSE plumbing
def broadcast(event: dict) -> None:
    with SUB_LOCK:
        subscribers = list(SUBSCRIBERS)
    for sub in subscribers:
        try:
            sub.put_nowait(event)
        except queue.Full:
            # 队列满说明这个页面长时间没取：丢最旧的，保证最新进度一定送得出去。
            DROPPED["count"] += 1
            try:
                sub.get_nowait()
                sub.put_nowait(event)
            except (queue.Empty, queue.Full):
                pass
            if DROPPED["count"] % 100 == 1:
                log.warning("事件队列已满，累计丢弃 %d 条最旧事件（页面进度可能不及时）",
                            DROPPED["count"])


def drain_events() -> None:
    while True:
        try:
            EVENTS.get_nowait()
        except queue.Empty:
            return


def _persist(job: Job, *, replace: bool = True) -> None:
    try:
        if replace:
            db.upsert(job.to_db())
        else:
            db.insert_missing(job.to_db())
    except Exception as exc:  # noqa: BLE001 - the index is rebuildable from disk
        log.error("任务索引写入失败 id=%s：%s: %s", job.id, type(exc).__name__, exc)


def _apply_stage(event: dict) -> None:
    job_id = event.get("job")
    if not job_id:
        return
    job = JOBS.get(job_id)
    if job is None:
        return
    label = event.get("label") or ""
    if label != job.stage:
        job.stage = label
        job.updated_at = time.time()
        _persist(job)
    if event.get("total"):
        job.progress = f"{event.get('completed')}/{event.get('total')}"
    elif event.get("completed"):
        job.progress = str(event.get("completed"))
    event["stage_zh"] = STAGE_ZH.get(label, label)
    event["phase"] = STAGE_PHASE.get(label, "other")


def read_events(proc: subprocess.Popen) -> None:
    junk = 0
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            # 协议只允许 JSON 行；混进来的 print 要留痕，但不能每条都写日志。
            junk += 1
            if junk <= 5 or junk % 100 == 0:
                log.warning("模型进程输出了非协议行（第 %d 条）：%s", junk, line[:300])
            continue
        if event.get("event") == "stage":
            event["job"] = CURRENT_JOB["id"]
            _apply_stage(event)
            broadcast(event)
            continue
        EVENTS.put(event)
    # 先把 died 放出去让 send() 解除等待；状态更新不拿 MODEL_LOCK，
    # 否则会和持有锁等 EVENTS 的 run_job 互相卡死。
    is_current = WORKER.get("proc") is proc
    # 管道 EOF 往往比进程真正退出早几十毫秒，直接 poll() 会记成 None；
    # 先等退出码再放 died，日志顺序才是「进程结束 → 任务结束」。
    try:
        exit_code = proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        exit_code = None
    log.info("模型进程输出结束（exit=%s）", exit_code)
    EVENTS.put({"event": "died", "pid": proc.pid, "reason": "模型进程已退出"})
    if is_current and MODEL["state"] in ("loaded", "loading"):
        MODEL.update(state="unloaded", device=None, device_name="", seconds=None, load={},
                     reason="模型进程已退出，请重新加载模型")
        broadcast({"event": "unloaded", "model": model_status_dict()})


def terminate_worker() -> None:
    proc, log_handle = WORKER.get("proc"), WORKER.get("log")
    WORKER["proc"], WORKER["log"] = None, None
    if proc is not None:
        if proc.poll() is None:
            try:
                proc.kill()
            except OSError as exc:
                log.warning("结束模型进程失败：%s: %s", type(exc).__name__, exc)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                log.warning("模型进程 10 秒内未退出（PID %s）", proc.pid)
        for stream in (proc.stdin, proc.stdout):
            try:
                if stream is not None:
                    stream.close()
            except OSError as exc:
                log.debug("关闭模型进程管道失败：%s", exc)
    if log_handle is not None:
        log_handle.close()
    # 强杀时 read_events 的 is_current 已经为假，这里必须自己收敛状态；
    # 否则 UI 会一直显示"已加载"，直到下一个任务静默重载。
    if MODEL["state"] in ("loaded", "loading"):
        MODEL.update(state="unloaded", device=None, device_name="", seconds=None, load={},
                     reason="模型进程已退出，请重新加载模型")
        broadcast({"event": "unloaded", "model": model_status_dict()})


def worker_process() -> subprocess.Popen:
    proc = WORKER.get("proc")
    if proc is not None and proc.poll() is None:
        return proc
    if proc is not None:
        terminate_worker()
    (ROOT / "runs").mkdir(parents=True, exist_ok=True)
    worker_log = ROOT / "runs" / "model_worker.log"
    try:
        if worker_log.stat().st_size > 5 * 1024 * 1024:
            worker_log.replace(worker_log.with_name(worker_log.name + ".1"))
    except OSError as exc:
        log.warning("轮转 model_worker.log 失败：%s: %s", type(exc).__name__, exc)
    WORKER["log"] = open(worker_log, "a", encoding="utf-8", errors="replace")
    env = {**os.environ, "YUE2_KIT": str(KIT), "HF_ENDPOINT": "https://hf-mirror.com",
           "PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1"}
    proc = subprocess.Popen(
        [str(PYTHON_EXE), str(WORKER_SCRIPT)],
        cwd=str(ROOT), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=WORKER["log"],
        text=True, encoding="utf-8", errors="replace", bufsize=1, env=env,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    WORKER["proc"] = proc
    log.info("启动模型进程（PID %s）", proc.pid)
    drain_events()
    threading.Thread(target=read_events, args=(proc,), daemon=True).start()
    return proc


def worker_alive() -> bool:
    proc = WORKER.get("proc")
    return proc is not None and proc.poll() is None


class WorkerError(RuntimeError):
    def __init__(self, reason: str, cancelled: bool = False, action: str | None = None,
                 trace: str | None = None):
        super().__init__(reason)
        self.cancelled = cancelled
        self.action = action
        self.trace = trace


def send(cmd: dict, timeout: float) -> dict:
    proc = worker_process()
    rid = uuid.uuid4().hex[:8]
    cmd = {**cmd, "rid": rid}
    drain_events()
    try:
        proc.stdin.write(json.dumps(cmd, ensure_ascii=False) + "\n")
        proc.stdin.flush()
    except (BrokenPipeError, OSError, ValueError) as exc:
        # worker 已死时管道是断的：按"进程退出"上报，而不是让任务吃到 BrokenPipeError。
        log.warning("向模型进程发送 %s 失败：%s: %s", cmd.get("cmd"), type(exc).__name__, exc)
        terminate_worker()
        raise RuntimeError("模型进程已退出") from exc
    while True:
        try:
            event = EVENTS.get(timeout=timeout)
        except queue.Empty:
            log.warning("模型进程 %g 秒无响应（cmd=%s rid=%s），已强制结束",
                        timeout, cmd.get("cmd"), rid)
            terminate_worker()
            raise RuntimeError("模型进程无响应") from None
        if event.get("rid") and event["rid"] != rid:
            # 上一条已经放弃的命令迟到的回包，不能算到当前命令头上。
            log.debug("丢弃过期事件 rid=%s（当前 rid=%s）：%s",
                      event["rid"], rid, event.get("event"))
            continue
        if event.get("event") == "died":
            pid, current = event.get("pid"), WORKER.get("proc")
            if pid is not None and current is not None and pid != current.pid:
                # 上一条命令的进程晚于 drain 才投递退出：不能算到当前进程头上。
                log.debug("忽略旧进程 PID %s 的 died 事件（当前 PID %s）", pid, current.pid)
                continue
            terminate_worker()
            raise RuntimeError(event.get("reason") or "模型进程已退出")
        if event.get("event") == "error":
            log.warning("模型进程报告失败 action=%s trace=%s type=%s：%s",
                        event.get("action"), event.get("trace") or "-",
                        event.get("type"), event.get("reason"))
            raise WorkerError(event.get("reason") or "模型操作失败",
                              bool(event.get("cancelled")), event.get("action"),
                              event.get("trace"))
        return event


def _load_locked(device: str) -> str:
    global CUDA_BLOCKED
    MODEL.update(state="loading", reason="")
    broadcast({"event": "model", "model": model_status_dict()})
    common = {"model": str(MODEL_DIR), "vae": str(VAE_DIR), "budget": 24}
    try:
        event = send({"cmd": "load", "device": device, **common}, 900)
    except Exception as exc:
        terminate_worker()
        log.error("模型加载失败 device=%s：%s", device, exc)
        if device != "cuda":
            MODEL.update(state="unloaded", reason=f"模型加载失败：{exc}")
            broadcast({"event": "unloaded", "model": model_status_dict()})
            raise RuntimeError(f"模型加载失败：{exc}") from exc
        degraded = f"GPU 不可用，已自动降级为 CPU：{exc}"
        try:
            event = send({"cmd": "load", "device": "cpu", **common}, 900)
        except Exception as cpu_exc:
            terminate_worker()
            log.error("GPU 加载失败后 CPU 加载也失败：%s", cpu_exc)
            MODEL.update(state="unloaded", reason=f"模型加载失败：{cpu_exc}")
            broadcast({"event": "unloaded", "model": model_status_dict()})
            raise RuntimeError(f"{degraded}；CPU 加载也失败：{cpu_exc}") from cpu_exc
        CUDA_BLOCKED = str(exc)
        log.info("模型已加载到 CPU（GPU 降级）")
        MODEL.update(state="loaded", device="cpu", device_name=event.get("device_name", "CPU"),
                     seconds=event.get("seconds"), load=event.get("load", {}), reason=degraded)
        broadcast({"event": "loaded", "model": model_status_dict()})
        return "cpu"
    log.info("模型已加载 device=%s（%.1f 秒）", device, event.get("seconds") or 0.0)
    MODEL.update(state="loaded", device=device, device_name=event.get("device_name", device),
                 seconds=event.get("seconds"), load=event.get("load", {}), reason="")
    broadcast({"event": "loaded", "model": model_status_dict()})
    return device


def _unload_locked() -> None:
    global CUDA_BLOCKED
    MODEL.update(state="unloading")
    broadcast({"event": "model", "model": model_status_dict()})
    terminate_worker()
    log.info("模型已卸载")
    MODEL.update(state="unloaded", device=None, device_name="", seconds=None, load={}, reason="")
    CUDA_BLOCKED = ""
    broadcast({"event": "unloaded", "model": model_status_dict()})


def ensure_loaded(device: str) -> str:
    if device == "cuda" and CUDA_BLOCKED:
        device = "cpu"
    if MODEL["state"] == "loaded" and MODEL["device"] == device and worker_alive():
        return device
    if MODEL["state"] == "loaded":
        _unload_locked()
    return _load_locked(device)


# ------------------------------------------------------------------- disk restore
def index_artifacts(job_id: str) -> dict:
    directory = job_artifacts(job_id)
    index = {}
    if directory.exists():
        for path in sorted(directory.iterdir()):
            if path.is_file() and path.name in ARTIFACT_NAMES:
                index[path.name] = path.stat().st_size
    return index


def job_from_row(row: dict) -> Job:
    request = row.get("requested") or {"style": row.get("style", ""), "lyrics": "",
                                       "cot": row.get("cot", "full"), "seed": row.get("seed")}
    job = Job(row["id"], row.get("type", "song"), request,
              source=row.get("parent_id"), title=row.get("title", ""),
              parent_id=row.get("parent_id"))
    job.status = row.get("status", "queued")
    job.stage = row.get("stage", "")
    job.progress = row.get("progress", "")
    job.error = row.get("error", "")
    job.result = row.get("result") or {}
    job.artifacts = row.get("artifacts") or {}
    job.effective = row.get("effective") or {}
    job.favorite = bool(row.get("favorite"))
    job.demo = bool(row.get("demo"))
    job.ode_steps = row.get("ode_steps")
    job.vae = row.get("vae") or None
    job.created_at = row.get("created_at") or time.time()
    job.updated_at = row.get("updated_at") or job.created_at
    return job


def _read_json(path: Path | None):
    if path is None or not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        log.warning("读不到 %s：%s: %s", path, type(exc).__name__, exc)
        return None
    except ValueError as exc:
        log.warning("%s 不是合法 JSON，按缺失处理：%s", path, exc)
        return None


def _mtime(path: Path) -> float | None:
    try:
        return path.stat().st_mtime
    except OSError as exc:
        log.debug("取不到 %s 的时间：%s", path, exc)
        return None


DEMO_DIR = ROOT / "demo" / "showcase"
DEMO_ID = "song_demo_wanfeng"


def seed_demo() -> None:
    """Copy the bundled example song into the library exactly once."""
    flag = ROOT / "runs" / ".demo_seeded"
    if flag.exists() or not (DEMO_DIR / "audio.flac").exists() or db.get(DEMO_ID) is not None:
        return
    out = job_artifacts(DEMO_ID)
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(DEMO_DIR, out, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("demo.json"))
    except OSError as exc:
        log.warning("示例曲导入跳过：%s: %s", type(exc).__name__, exc)
        return
    meta = _read_json(DEMO_DIR / "demo.json") or {}
    request = dict(_read_json(out / "request.json") or meta.get("request") or {})
    request.pop("id", None)
    request.setdefault("cot", "full")
    config = _read_json(out / "config.json") or {}
    generation = config.get("generation") or {}
    request.setdefault("vae", config.get("decoder_release") or "standard")
    request.setdefault("ode_steps", generation.get("ode_steps"))
    (out / "request.json").write_text(json.dumps(request, ensure_ascii=False, indent=2), encoding="utf-8")
    job = Job(DEMO_ID, "song", request, title=meta.get("title") or "示例曲 · 晚风",
              vae=request.get("vae"), ode_steps=request.get("ode_steps"), demo=True)
    job.status = "complete"
    job.result = _read_json(out / "result.json") or {}
    job.artifacts = index_artifacts(DEMO_ID)
    job.created_at = time.time()
    _persist(job)
    with LOCK:
        JOBS[DEMO_ID] = job
    try:
        flag.write_text(time.strftime("%Y-%m-%d %H:%M:%S"), encoding="utf-8")
    except OSError as exc:
        log.warning("示例曲导入标记写入失败：%s: %s", type(exc).__name__, exc)


def prune_trash() -> None:
    """Drop deleted jobs nobody came back for; the library itself is never touched."""
    if not TRASH_DIR.exists():
        return
    cutoff = time.time() - TRASH_TTL_DAYS * 86400
    removed, freed = 0, 0
    for entry in sorted(TRASH_DIR.iterdir()):
        try:
            if not entry.is_dir() or entry.stat().st_mtime >= cutoff:
                continue
            size = sum(part.stat().st_size for part in entry.rglob("*") if part.is_file())
            shutil.rmtree(entry)
            removed, freed = removed + 1, freed + size
        except OSError as exc:
            log.warning("清理回收站失败 %s：%s: %s", entry.name, type(exc).__name__, exc)
    if removed:
        log.info("回收站清理：删除 %d 个超过 %d 天的任务，释放 %.1f MB",
                 removed, TRASH_TTL_DAYS, freed / 1024 / 1024)


def restore_jobs() -> None:
    """Reconcile disk artifacts into the DB, then load every row into memory."""
    db.init()
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    known = db.all_ids()
    for directory in sorted(JOBS_DIR.iterdir()):
        if not directory.is_dir() or directory.name in known:
            continue
        out_dir = directory / "out" / directory.name
        meta = directory / ".meta"
        request = _read_json(next((path for path in (out_dir / "request.json", meta / "request.json",
                                                     meta / "job_request.json") if path.exists()), None))
        if request is None:
            continue
        result, failure = _read_json(out_dir / "result.json"), _read_json(out_dir / "failure.json")
        if result is not None:
            status, error = "complete", ""
        elif failure is not None:
            status = "cancelled" if failure.get("status") == "cancelled" else "failed"
            error = failure.get("reason", "unknown")
        else:
            status, error = "failed", "任务在写出产物前被终止"
        job = Job(directory.name, _infer_type(request), request, demo=directory.name == DEMO_ID)
        if job.demo:
            job.title = "示例曲 · 晚风"
        job.status, job.result, job.error = status, result or {}, error
        job.artifacts = index_artifacts(directory.name)
        if request.get("device") is None:
            for candidate in (meta / "request.json", meta / "job_request.json"):
                extra = _read_json(candidate)
                if extra and extra.get("device"):
                    request["device"] = extra["device"]
                    break
        job.created_at = _mtime(out_dir / "result.json") or _mtime(directory) or time.time()
        # 只补缺：已入库的行带着收藏/标题/参数，不能被磁盘重建结果覆盖。
        _persist(job, replace=False)
    interrupted = db.fail_unfinished("服务重启，任务中断")
    if interrupted:
        log.info("重启收敛：%d 个未完成任务标记为失败", interrupted)
    with LOCK:
        JOBS.clear()
        for row in db.list_jobs(limit=500):
            JOBS[row["id"]] = job_from_row(row)


def _infer_type(request: dict) -> str:
    if request.get("source") and request.get("from"):
        return "staged"
    return "song"


def cancel_requested(job: Job) -> bool:
    return (job_dir(job.id) / ".meta" / "cancel").exists()


# ------------------------------------------------------------------- job execution
def build_worker_command(job: Job) -> tuple[dict, float]:
    directory = job_dir(job.id)
    (directory / ".meta").mkdir(parents=True, exist_ok=True)
    cancel_file = directory / ".meta" / "cancel"
    log_path = directory / ".meta" / "run.log"
    log_path.write_text("", encoding="utf-8")
    out = str(directory / "out")
    if job.type in ("song", "plan", "rerender"):
        request_path = directory / ".meta" / "request.json"
        request_path.write_text(json.dumps({**job.request, "id": job.id}, ensure_ascii=False, indent=2),
                                encoding="utf-8")
        cmd = {"cmd": "plan" if job.type == "plan" else "generate",
               "request": str(request_path), "output": out, "id": job.id,
               "log": str(log_path), "cancel_file": str(cancel_file),
               "ode_steps": job.ode_steps, "attention": db.get_settings()}
        return cmd, 6 * 3600
    source = job_artifacts(job.source) if job.source else None
    stage = "redecode" if job.type == "redecode" else (job.from_stage or "plan")
    missing = missing_source_artifacts(source, stage) if source is not None else ["产物目录"]
    if missing:
        raise RuntimeError(f"源任务缺少产物：{', '.join(missing)}")
    if job.type == "staged":
        cmd = {"cmd": "staged", "from": job.from_stage or "plan", "src": str(source),
               "output": out, "id": job.id, "log": str(log_path), "cancel_file": str(cancel_file),
               "ode_steps": job.ode_steps, "attention": db.get_settings()}
        return cmd, 6 * 3600
    if job.type == "redecode":
        cmd = {"cmd": "redecode", "src": str(source), "output": out, "id": job.id,
               "log": str(log_path), "cancel_file": str(cancel_file),
               "vae": job.vae or "standard"}
        return cmd, 3600
    raise RuntimeError(f"未知任务类型：{job.type}")


def _job_lyrics(job: Job) -> str:
    lyrics = (job.request or {}).get("lyrics") or ""
    if not lyrics and job.source:
        with LOCK:
            source = JOBS.get(job.source)
        if source is not None:
            lyrics = (source.request or {}).get("lyrics") or ""
    return lyrics


def schedule_alignment(job: Job) -> None:
    """Queue lyric timing once the audio exists; the align thread runs on CPU."""
    if job.status != "complete":
        return
    directory = job_artifacts(job.id)
    audio = align.find_audio(directory)
    lyrics = _job_lyrics(job)
    out = directory / "lyrics.json"
    if audio is None or not lyrics.strip() or out.exists():
        return
    align.schedule(job.id, audio, lyrics, out,
                   lambda _ok: broadcast({"event": "lyrics", "job": job.id}))


def run_job(job: Job) -> None:
    global MODEL_BUSY
    device = job.request.get("device") or "auto"
    if device == "auto":
        device = MODEL["device"] if MODEL["state"] == "loaded" else DEFAULT_DEVICE
    with LOCK:
        if job.status == "cancelled":
            return
        job.status = "running"
    job.stage, job.progress = "", ""
    MODEL_BUSY = True
    CURRENT_JOB["id"] = job.id
    _persist(job)
    broadcast(_job_event(job, status="running"))
    log.info("任务开始 id=%s type=%s device=%s", job.id, job.type, device)
    try:
        if not (MODEL["state"] == "loaded" and MODEL["device"] == device):
            job.stage = "Loading model"
        with MODEL_LOCK:
            device = ensure_loaded(device)
        job.request["device"] = device
        if job.status == "cancelled" or cancel_requested(job):
            raise WorkerError("已取消（尚未开始生成）", cancelled=True)
        cmd, timeout = build_worker_command(job)
        if job.status == "cancelled" or cancel_requested(job):
            raise WorkerError("已取消（尚未开始生成）", cancelled=True)
        with MODEL_LOCK:
            send(cmd, timeout)
        result_path = job_artifacts(job.id) / "result.json"
        if result_path.exists():
            job.result = _read_json(result_path) or {}
        job.artifacts = index_artifacts(job.id)
        job.status = "complete"
        job.stage, job.progress = "", ""
        schedule_alignment(job)
    except WorkerError as exc:
        job.status = "cancelled" if exc.cancelled else "failed"
        job.error = str(exc) if exc.cancelled or not exc.trace \
            else f"{exc}（日志编号 {exc.trace}）"
        if job.status == "cancelled":
            _mark_cancelled(job, str(exc))
        else:
            log.error("任务失败 id=%s type=%s trace=%s：%s", job.id, job.type,
                      exc.trace or "-", exc)
    except Exception as exc:  # noqa: BLE001
        job.status = "failed"
        job.error = str(exc)
        log.exception("任务异常 id=%s type=%s", job.id, job.type)
    finally:
        CURRENT_JOB["id"] = None
        MODEL_BUSY = False
        job.artifacts = job.artifacts or index_artifacts(job.id)
        _persist(job)
        broadcast(_job_event(job, status=job.status, error=job.error,
                             duration=(job.result or {}).get("audio_seconds")))
        log.info("任务结束 id=%s status=%s", job.id, job.status)


def _mark_cancelled(job: Job, reason: str) -> None:
    directory = job_artifacts(job.id)
    try:
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "failure.json").write_text(
            json.dumps({"status": "cancelled", "reason": reason}, ensure_ascii=False, indent=2),
            encoding="utf-8")
    except OSError as exc:
        log.warning("写入取消标记失败 id=%s：%s: %s", job.id, type(exc).__name__, exc)


def worker() -> None:
    while True:
        job_id = QUEUE.get()
        job = JOBS.get(job_id)
        if job is None or job.status == "cancelled":
            continue
        try:
            run_job(job)
        except Exception as exc:  # noqa: BLE001 - last resort; run_job already persists
            job.status = "failed"
            job.error = str(exc)
            _persist(job)
            broadcast(_job_event(job, status="failed", error=job.error))
            log.exception("任务线程兜底捕获 id=%s", job.id)


# ------------------------------------------------------------------- create jobs
def _new_id(prefix: str = "song") -> str:
    return f"{prefix}_" + time.strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:4]


def _official_request(body: JobRequest, source: dict | None = None) -> dict:
    request: dict = {}
    if source:
        for key in ("style", "lyrics", "cot", "seed", "cfg_scale", "abc",
                    "abc_sampling", "semantic_sampling"):
            if source.get(key) is not None:
                request[key] = source[key]
    for key in ("style", "lyrics", "seed", "cfg_scale", "abc_sampling", "semantic_sampling"):
        value = getattr(body, key)
        if value is not None and value != "":
            request[key] = value
    if body.abc is not None:
        request["abc"] = body.abc
    if isinstance(request.get("lyrics"), str):
        request["lyrics"] = request["lyrics"].lstrip("\ufeff")
    request["cot"] = body.cot or request.get("cot") or "full"
    request["device"] = body.device
    return request


_TEXT_TOKENIZER: dict = {"value": None, "failed": False}
_LYRICS_CHAR_CAP = 100000


def _text_tokenizer():
    """Official YuE2 text BPE, loaded once. None if the server env lacks tiktoken."""
    if _TEXT_TOKENIZER["value"] is not None or _TEXT_TOKENIZER["failed"]:
        return _TEXT_TOKENIZER["value"]
    try:
        source = str(KIT / "src")
        if source not in sys.path:
            sys.path.insert(0, source)
        from yue2.tokenization_yue2 import YuE2TextTokenizer
        _TEXT_TOKENIZER["value"] = YuE2TextTokenizer(MODEL_DIR / "qwen.tiktoken")
    except Exception as exc:  # noqa: BLE001 - fall back to a conservative byte budget
        _TEXT_TOKENIZER["failed"] = True
        log.warning("分词器不可用，改用字符数估算上下文：%s: %s", type(exc).__name__, exc)
    return _TEXT_TOKENIZER["value"]


def _text_tokens(text: str) -> int | None:
    tokenizer = _text_tokenizer()
    if tokenizer is None:
        return None
    try:
        return len(tokenizer.encode(text))
    except Exception:  # noqa: BLE001 - never block a job on the estimator
        return None


def _check_context_budget(body: JobRequest) -> None:
    """Reject lyrics that cannot fit the engine context before queuing."""
    if body.type not in ("song", "plan", "rerender"):
        return
    if len(body.lyrics) > _LYRICS_CHAR_CAP:
        raise HTTPException(400, f"歌词过长：超过 {_LYRICS_CHAR_CAP} 字符，请先精简")
    if body.type == "rerender" and len(body.abc or "") > _LYRICS_CHAR_CAP:
        raise HTTPException(400, "谱面过长：请先精简谱面")
    from yue2.protocol import CONTEXT, INSTRUCTIONS, GenerationConfig
    text = f"{INSTRUCTIONS[body.cot]}\n[Tags]\n{body.style}\n[Lyrics]\n{body.lyrics}\n"
    tokens = _text_tokens(text)
    if tokens is None:
        if len(body.lyrics) > 12000:
            raise HTTPException(400, "歌词过长：服务端 tokenizer 不可用，按保守上限判定超过 12000 字符")
        return
    defaults = GenerationConfig()
    abc_max = (body.abc_sampling or {}).get("max_tokens", defaults.abc.max_tokens)
    semantic_max = (body.semantic_sampling or {}).get("max_tokens", defaults.semantic.max_tokens)
    if body.type == "plan":
        needed = tokens + 3 + abc_max
    elif body.type == "rerender":
        abc_tokens = _text_tokens(body.abc or "") or 0
        needed = tokens + 5 + abc_tokens + semantic_max
    else:
        needed = tokens + 5 + abc_max + semantic_max
    if needed > CONTEXT:
        raise HTTPException(
            400,
            f"歌词过长：约 {tokens} 个文本 token，加上生成预算后超过模型上下文 {CONTEXT}；"
            "请删减歌词，或把 max_tokens 调小")


def _clean_title(value) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise HTTPException(400, "标题必须是文本")
    title = value.strip()
    if len(title) > 200:
        raise HTTPException(400, "标题最多 200 个字")
    return title


SAMPLING_LIMITS = {
    "temperature": (0, 5, False),
    "top_p": (0.01, 1, False),
    "top_k": (1, 1000, True),
    "repetition_penalty": (0.01, 5, False),
    "penalty_window": (1, 100, True),
    "min_tokens": (0, 20000, True),
    "max_tokens": (1, 20000, True),
}


def _check_sampling(name: str, payload: dict | None) -> None:
    if payload is None:
        return
    if not isinstance(payload, dict):
        raise HTTPException(400, "采样参数必须是对象")
    for key, value in payload.items():
        if key not in SAMPLING_LIMITS:
            raise HTTPException(400, f"不支持的采样参数：{name}.{key}")
        low, high, is_int = SAMPLING_LIMITS[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise HTTPException(400, f"{name}.{key} 必须是数字")
        if is_int and not isinstance(value, int):
            raise HTTPException(400, f"{name}.{key} 必须是整数")
        if not low <= value <= high:
            raise HTTPException(400, f"{name}.{key} 必须在 {low} 到 {high} 之间")
    from yue2.protocol import GenerationConfig
    defaults = GenerationConfig()
    base = defaults.abc if name == "abc_sampling" else defaults.semantic
    low = payload.get("min_tokens", base.min_tokens)
    high = payload.get("max_tokens", base.max_tokens)
    if not 0 <= low <= high:
        raise HTTPException(400, f"min_tokens 不能大于 max_tokens（当前 {low} > {high}）")


def _validate(body: JobRequest) -> None:
    if body.type not in JOB_TYPES:
        raise HTTPException(400, f"type must be one of {JOB_TYPES}")
    if body.device not in ("cpu", "cuda", "auto"):
        raise HTTPException(400, "device must be cpu, cuda or auto")
    if body.cot not in ("full", "melody", "off"):
        raise HTTPException(400, "cot must be full, melody or off")
    if body.type in ("song", "plan", "rerender"):
        if not isinstance(body.style, str):
            raise HTTPException(400, "风格字段必须是文本")
        if not isinstance(body.lyrics, str):
            raise HTTPException(400, "歌词字段必须是文本")
        if not body.style.strip() or not body.lyrics.strip():
            raise HTTPException(400, "风格和歌词是必填的")
    if body.type == "rerender" and not (body.abc or "").strip():
        raise HTTPException(400, "abc score is empty")
    if body.type in ("staged", "redecode") and not body.source:
        raise HTTPException(400, "source job id is required")
    if body.type == "staged" and (body.from_stage or "plan") not in ("plan", "semantic"):
        raise HTTPException(400, "from_stage must be plan or semantic")
    if body.type == "redecode":
        decoder = body.vae or "standard"
        if decoder == "legacy" and not VAE_LEGACY_DIR.exists():
            raise HTTPException(409, "YuE2-Vae-legacy 未安装，无法用该解码器重渲")
        if decoder not in ("standard", "legacy"):
            path = Path(decoder)
            if not path.is_dir():
                raise HTTPException(400, f"解码器必须是 standard、legacy 或本地解码器目录：{decoder}")
            if not (path / "config.json").is_file():
                raise HTTPException(400, f"本地解码器目录缺少 config.json：{decoder}")
    if body.seed is not None and not 0 <= body.seed < 2 ** 63:
        raise HTTPException(400, "seed must be an integer in [0, 2**63)")
    if body.ode_steps is not None and not 1 <= body.ode_steps <= 200:
        raise HTTPException(400, "ode_steps must be between 1 and 200")
    if body.cfg_scale is not None and not 0 <= body.cfg_scale <= 20:
        raise HTTPException(400, "cfg_scale must be between 0 and 20")
    _check_sampling("abc_sampling", body.abc_sampling)
    _check_sampling("semantic_sampling", body.semantic_sampling)
    _check_context_budget(body)


@app.post("/api/jobs")
def create_job(body: JobRequest) -> dict:
    _validate(body)
    source_job = None
    if body.source:
        with LOCK:
            source_job = JOBS.get(body.source)
        if source_job is None or source_job.status != "complete":
            raise HTTPException(404, "source job not found or not complete")
        stage = "redecode" if body.type == "redecode" else (body.from_stage or "plan")
        missing = missing_source_artifacts(job_artifacts(body.source), stage)
        if missing:
            raise HTTPException(409, f"源任务缺少产物：{', '.join(missing)}")
    source_request = source_job.request if source_job else None
    request = _official_request(body, source_request)
    prefix = "plan" if body.type == "plan" else "batch" if body.type == "redecode" else "song"
    job_id = _new_id(prefix)
    job = Job(job_id, body.type, request,
              source=body.source, from_stage=body.from_stage, vae=body.vae,
              ode_steps=body.ode_steps, title=_clean_title(body.title),
              parent_id=body.source)
    if source_job and body.type != "redecode":
        job.effective = source_job.effective
    with LOCK:
        JOBS[job_id] = job
        _persist(job)
        QUEUE.put(job_id)
    broadcast(_job_event(job, status="queued"))
    return job.to_dict()


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    with LOCK:
        job = JOBS.get(job_id)
        if job is None:
            raise HTTPException(404, "任务不存在")
        if job.status not in ("queued", "running"):
            raise HTTPException(409, "任务已结束，无需取消")
        queued = job.status == "queued"
        if queued:
            job.status = "cancelled"
            job.error = "已取消（尚未开始）"
    directory = job_dir(job_id) / ".meta"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "cancel").write_text("1", encoding="utf-8")
    if queued:
        _persist(job)
        broadcast(_job_event(job, status="cancelled"))
    log.info("取消请求 id=%s 状态=%s，生效=%s", job_id, "queued" if queued else "running",
             "已取消" if queued else "下一阶段边界")
    return {"cancelled": job_id, "effective": "queued" if queued else "next stage boundary",
            "row": _api_row(job.to_db()) if queued else None}


# ------------------------------------------------------------------- read jobs
_LYRIC_TAG = re.compile(r"\[[^\]]*\]")
_LYRIC_CJK = re.compile(r"[\u3400-\u9fff]")
_LYRIC_WORD = re.compile(r"[A-Za-z]+")


def _lyric_head(text: str) -> str:
    """歌词第一句（跳过 [Verse] 这类段落标记），列表里当任务名用。"""
    for line in str(text or "").split("\n"):
        line = line.strip()
        if line and not line.startswith("["):
            return line[:14]
    return ""


def _lyric_units(text: str) -> float:
    """篇幅当量：中日韩按字、英文按词折算，与前端 lyricUnits() 同一口径。"""
    clean = _LYRIC_TAG.sub(" ", str(text or ""))
    return round(len(_LYRIC_CJK.findall(clean)) + len(_LYRIC_WORD.findall(clean)) * 1.4, 1)


def _api_row(row: dict, full: bool = False) -> dict:
    """full=False 是列表口径：requested 只留摘要，歌词正文和谱面不进 JSON。"""
    request = dict(row.get("requested") or {})
    lyrics = str(request.get("lyrics") or "")
    if not full:
        # 列表只带摘要：歌词正文一条就能到几 MB，而列表渲染一个字段都不用它
        request.pop("lyrics", None)
        request.pop("abc", None)
    result = row.get("result") or {}
    truncated = row.get("truncated")
    if truncated is None:
        truncated = result.get("truncated")
        if isinstance(truncated, dict):
            truncated = any(bool(v) for v in truncated.values())
    payload = {
        "id": row["id"], "type": row.get("type", "song"), "status": row.get("status"),
        "stage": STAGE_ZH.get(row.get("stage", ""), row.get("stage", "")),
        "stage_raw": row.get("stage", ""), "progress": row.get("progress", ""),
        "device": row.get("device") or request.get("device", ""),
        "style": row.get("style") or request.get("style", ""),
        "seed": row.get("seed"), "cot": row.get("cot", ""),
        "title": row.get("title", ""), "parent_id": row.get("parent_id"),
        "variant_group": row.get("variant_group"), "favorite": bool(row.get("favorite")),
        "created_at": row.get("created_at"), "updated_at": row.get("updated_at"),
        "error": row.get("error", ""), "duration": row.get("duration") or result.get("audio_seconds"),
        "truncated": truncated,
        "seconds": (result.get("timing") or {}).get("e2e_seconds") or result.get("seconds"),
        "ode_steps": row.get("ode_steps"), "vae": row.get("vae") or None,
        "demo": bool(row.get("demo")),
        "requested": request, "effective": row.get("effective"),
        "artifacts": row.get("artifacts") or {}, "result": result,
        "lyrics_head": _lyric_head(lyrics), "lyrics_units": _lyric_units(lyrics),
        "lyrics_len": len(lyrics),
    }
    return _with_live(payload)


def _with_live(payload: dict) -> dict:
    """Overlay in-memory stage/progress so a refresh mid-run does not lose it."""
    with LOCK:
        live = JOBS.get(payload["id"])
        if live is None or live.status not in ("running", "queued"):
            return payload
        payload["status"] = live.status
        payload["stage"] = STAGE_ZH.get(live.stage, live.stage)
        payload["stage_raw"] = live.stage
        payload["progress"] = live.progress
        if live.error:
            payload["error"] = live.error
    return payload


def _job_event(job: "Job", **extra) -> dict:
    """job 事件附带整行（列表口径）：前端合并这一条就行，不必再拉 /api/jobs。

    调用方必须不在 LOCK 里：_with_live() 自己会拿锁，且 LOCK 不可重入。
    """
    return {"event": "job", "job": job.id, **extra, "row": _api_row(job.to_db())}


@app.get("/api/jobs")
def list_jobs(status: str | None = None, q: str | None = None,
              favorite: bool = False, limit: int = Query(200, ge=1, le=500),
              offset: int = Query(0, ge=0)) -> dict:
    rows = db.list_jobs(status=status, q=q, favorite=favorite or None, limit=limit, offset=offset)
    return {"jobs": [_api_row(row) for row in rows],
            "total": db.count(status=status, q=q, favorite=favorite or None)}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    row = db.get(job_id)
    if row is None:
        raise HTTPException(404, "job not found")
    return _api_row(row, full=True)


@app.patch("/api/jobs/{job_id}")
def patch_job(job_id: str, body: dict) -> dict:
    row = db.get(job_id)
    if row is None:
        raise HTTPException(404, "job not found")
    updates = {}
    if "favorite" in body:
        if not isinstance(body["favorite"], bool):
            raise HTTPException(400, "favorite must be a boolean")
        updates["favorite"] = body["favorite"]
    if "title" in body:
        updates["title"] = _clean_title(body["title"])
    if updates:
        db.update(job_id, **updates)
    with LOCK:
        job = JOBS.get(job_id)
        if job is not None:
            if "favorite" in updates:
                job.favorite = updates["favorite"]
            if "title" in updates:
                job.title = updates["title"]
    fresh_row = db.get(job_id) if updates else None
    fresh = _api_row(fresh_row) if fresh_row else None
    if fresh is not None:
        broadcast({"event": "job", "job": job_id, "row": fresh})
    return {"id": job_id, **updates, "row": fresh}


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str) -> dict:
    if job_id == DEMO_ID:
        raise HTTPException(409, "示例曲不能删除（重启后会自动重建）")
    directory = job_path(job_id)
    queued_deleted = False
    if align.busy(job_id):
        raise HTTPException(409, "正在对齐歌词，完成后再删除")
    with LOCK:
        job = JOBS.get(job_id)
        if job is not None and job.status == "running":
            raise HTTPException(409, "任务正在运行，不能删除；请先取消并等待停止")
        if job is not None and job.status == "queued":
            job.status = "cancelled"
            job.error = "已取消（任务已删除）"
            queued_deleted = True
    if queued_deleted:
        _persist(job)
    if job is None and db.get(job_id) is None:
        log.info("删除请求：任务不存在 id=%s", job_id)
        return {"deleted": job_id, "existed": False}
    target, moved = None, False
    if directory.exists():
        TRASH_DIR.mkdir(parents=True, exist_ok=True)
        target = TRASH_DIR / directory.name
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
        try:
            shutil.move(str(directory), str(target))
        except OSError as exc:
            raise HTTPException(409, "文件被占用（可能正在对齐、试听或被其他程序读取），请稍后再删") from exc
        moved = True
        try:
            os.utime(target)  # 回收站按"删除时间"计龄，不是按任务运行时间
        except OSError as exc:
            log.debug("标记回收站时间失败 %s：%s", target.name, exc)
    try:
        db.delete(job_id)
    except Exception as exc:  # noqa: BLE001 - keep disk and index consistent
        log.error("删除任务索引失败 id=%s：%s: %s", job_id, type(exc).__name__, exc)
        if moved:
            try:
                shutil.move(str(target), str(directory))
                log.info("已把任务目录移回 jobs：%s", directory.name)
            except OSError as move_exc:
                log.error("回滚回收站移动失败 id=%s：%s: %s", job_id,
                          type(move_exc).__name__, move_exc)
        raise HTTPException(500, "任务索引删除失败，任务未删除") from exc
    with LOCK:
        JOBS.pop(job_id, None)
    broadcast({"event": "jobs"})
    log.info("任务已删除 id=%s（移入回收站=%s）", job_id, moved)
    return {"deleted": job_id, "existed": True}


# ------------------------------------------------------------------- model / system
@app.get("/api/model")
def model_status() -> dict:
    return model_status_dict()


@app.post("/api/model/load")
def model_load(body: dict | None = None) -> dict:
    if MODEL_BUSY:
        raise HTTPException(409, "正在生成，暂不能加载或切换模型")
    device = (body or {}).get("device") or DEFAULT_DEVICE
    if device not in ("cpu", "cuda"):
        raise HTTPException(400, "device must be cpu or cuda")
    try:
        with MODEL_LOCK:
            if MODEL["state"] == "loaded" and MODEL["device"] == device and worker_alive():
                return model_status_dict()
            if MODEL["state"] == "loaded":
                _unload_locked()
            _load_locked(device)
    except RuntimeError as exc:
        raise HTTPException(500, str(exc)) from exc
    return model_status_dict()


@app.post("/api/model/unload")
def model_unload() -> dict:
    if MODEL_BUSY:
        raise HTTPException(409, "正在生成，完成后再卸载模型")
    with MODEL_LOCK:
        if MODEL["state"] == "loaded":
            _unload_locked()
    return model_status_dict()


# ------------------------------------------------------------------- settings
def _flash_attn_installed() -> bool:
    from importlib.util import find_spec
    try:
        return find_spec("flash_attn") is not None
    except (ImportError, ValueError):
        return False


def attention_capabilities() -> dict:
    """What each acceleration switch can really do here, without loading torch."""
    gpu = gpu_live()
    flash = _flash_attn_installed()
    capability = gpu.get("compute_capability")
    label = f"{capability:.1f}" if isinstance(capability, (int, float)) else "未知"
    widen = "，开启后改用 K/V 扩展走融合 SDPA 内核"
    nar = {"mode": "probe", "reason": "开启后由 cuDNN 自测决定，跑不赢基准就自动退回"}
    if not gpu["available"]:
        ar = {"mode": "baseline", "reason": "未检测到 NVIDIA GPU，开启后仍按基准路径运行"}
        nar = {"mode": "baseline", "reason": "未检测到 NVIDIA GPU，音频合成阶段无可加速内核"}
    elif not flash:
        ar = {"mode": "widen", "reason": f"未安装 flash_attn（算力 {label}）" + widen}
    elif capability is None:
        ar = {"mode": "probe", "reason": "无法读取显卡算力，开启后由运行期探测决定内核"}
    elif capability < 8.0:
        ar = {"mode": "widen", "reason": f"算力 {label} 不支持 FlashAttention-2（需 8.0+）" + widen}
    else:
        ar = {"mode": "flash_attn", "reason": f"FlashAttention-2 可用（算力 {label}）"}
    return {"cuda": bool(gpu["available"]), "flash_attn": flash,
            "compute_capability": gpu.get("compute_capability"), "ar": ar, "nar": nar}


@app.get("/api/settings")
def settings_read() -> dict:
    return {"settings": db.get_settings(), "capabilities": attention_capabilities()}


@app.patch("/api/settings")
def settings_update(body: dict | None = None) -> dict:
    if MODEL_BUSY:
        raise HTTPException(409, "正在生成，完成后再切换加速开关")
    try:
        saved = db.save_settings(body or {})
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"settings": saved, "capabilities": attention_capabilities()}


@app.post("/api/settings/reset")
def settings_reset() -> dict:
    if MODEL_BUSY:
        raise HTTPException(409, "正在生成，完成后再恢复默认设置")
    return {"settings": db.reset_settings(), "capabilities": attention_capabilities()}


@app.get("/api/schema")
def api_schema() -> dict:
    from yue2.protocol import CONTEXT

    def sampling_fields(defaults):
        return [
            {"key": "temperature", "min": 0, "max": 5, "step": 0.01, "default": defaults.temperature, "integer": False},
            {"key": "top_p", "min": 0.01, "max": 1, "step": 0.01, "default": defaults.top_p, "integer": False},
            {"key": "top_k", "min": 1, "max": 1000, "step": 1, "default": defaults.top_k, "integer": True},
            {"key": "repetition_penalty", "min": 0.01, "max": 5, "step": 0.005, "default": defaults.repetition_penalty, "integer": False},
            {"key": "penalty_window", "min": 1, "max": 100, "step": 1, "default": defaults.penalty_window, "integer": True},
            {"key": "min_tokens", "min": 0, "max": defaults.max_tokens, "step": 1, "default": defaults.min_tokens, "integer": True},
            {"key": "max_tokens", "min": 1, "max": 20000, "step": 1, "default": defaults.max_tokens, "integer": True},
        ]

    from yue2.protocol import GenerationConfig
    defaults = GenerationConfig()
    return {
        "types": list(JOB_TYPES),
        "cot": [
            {"value": "full", "guidance": 1.0, "editable_score": True},
            {"value": "melody", "guidance": 1.0, "editable_score": True},
            {"value": "off", "guidance": 1.01, "editable_score": False},
        ],
        "devices": ["auto", "cpu", "cuda"],
        "gpu": GPU, "default_device": DEFAULT_DEVICE,
        "seed": {"min": 0, "max": 2 ** 63 - 1},
        "cfg_scale": {"min": 0, "max": 20, "step": 0.01, "default": None},
        "ode_steps": {"min": 1, "max": 200, "step": 1, "default": defaults.ode_steps},
        "ode_method": {"value": "midpoint", "readonly": True},
        "context": {"value": CONTEXT, "readonly": True},
        "sampling": {
            "abc": {"fields": sampling_fields(defaults.abc)},
            "semantic": {"fields": sampling_fields(defaults.semantic)},
        },
        "decoders": [
            {"value": "standard", "label": "YuE2-Vae（试听）", "available": VAE_DIR.exists()},
            {"value": "legacy", "label": "YuE2-Vae-legacy（论文基准）", "available": VAE_LEGACY_DIR.exists()},
        ],
        "staged_from": ["plan", "semantic"],
        "score_tools": score_tools.available(),
    }


@app.get("/api/presets")
def api_presets() -> dict:
    return {"presets": presets}


@app.post("/api/lyrics/lint")
def lyrics_lint(body: dict) -> dict:
    raw = body.get("lyrics", "")
    if raw is None:
        raise HTTPException(400, "歌词为空")
    if not isinstance(raw, str):
        raise HTTPException(400, "歌词字段必须是文本")
    lyrics = raw.lstrip("\ufeff")
    if not lyrics.strip():
        raise HTTPException(400, "歌词为空")
    if len(lyrics) > _LYRICS_CHAR_CAP:
        raise HTTPException(400, f"歌词过长：超过 {_LYRICS_CHAR_CAP} 字符，请先精简")
    from yue2.protocol import CONTEXT
    tokens = _text_tokens(lyrics)
    if tokens is not None and tokens > CONTEXT:
        raise HTTPException(400, f"歌词过长：约 {tokens} 个 token，超过模型上下文 {CONTEXT}")
    markers = {"[Verse]", "[Chorus]", "[Bridge]", "[Intro]", "[Outro]", "[Pre-Chorus]", "[Hook]"}
    lines, sections, warnings = [], [], []
    for index, raw in enumerate(lyrics.splitlines()):
        text = raw.strip()
        if text in markers:
            sections.append({"marker": text, "line": index})
            continue
        if not text:
            continue
        characters = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
        units = characters or len(re.findall(r"[A-Za-z']+", text))
        flag = ""
        if units and units < 5:
            flag = "过短，旋律容易拖沓"
        elif units > 16:
            flag = "过长，单行容易唱飘"
        lines.append({"line": index, "text": text, "units": units, "warning": flag})
    if not sections:
        warnings.append("缺少段落标记（[Verse] / [Chorus]），模型按段落组织，建议补上")
    if len(sections) and not any(s["marker"] == "[Chorus]" for s in sections):
        warnings.append("没有 [Chorus]，副歌重复句式能让成品更稳")
    return {"empty": False, "sections": sections, "lines": lines, "warnings": warnings}


# ------------------------------------------------------------------- score tools
def _score_call(func, *args, **kwargs):
    try:
        return func(*args, **kwargs)
    except score_tools.ScoreToolsUnavailable as exc:
        raise HTTPException(503, f"官方乐谱脚本不可用：{exc}") from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/score/inspect")
def score_inspect(body: dict) -> dict:
    abc = str(body.get("abc", ""))
    if not abc.strip():
        raise HTTPException(400, "abc is empty")
    report = _score_call(score_tools.inspect, abc)
    voices = {}
    for name, voice in report.get("voices", {}).items():
        bars = voice.get("bars") or []
        keys = voice.get("keys") or []
        voices[name] = {
            "notes": voice.get("sounding_notes"),
            "measures": voice.get("measures"),
            "chords": len(voice.get("chords") or []),
            "meter": f"{bars[0][2][0]}/{bars[0][2][1]}" if bars else None,
            "key": keys[0][1] if keys else None,
        }
    vocal = voices.get("Vocal", {})
    return {
        "bpm": report.get("bpm"),
        "meter": vocal.get("meter"),
        "key": vocal.get("key"),
        "notes": vocal.get("notes"),
        "measures": vocal.get("measures"),
        "chords": vocal.get("chords"),
        "nominal_seconds": report.get("nominal_duration_seconds"),
        "voices": voices,
        "sha256": report.get("sha256"),
        "scope": report.get("scope"),
    }


@app.post("/api/score/compare")
def score_compare(body: dict) -> dict:
    before = str(body.get("before", ""))
    after = str(body.get("after", ""))
    if not before.strip() or not after.strip():
        raise HTTPException(400, "before and after are required")
    return _score_call(score_tools.compare, before, after,
                       allow_tempo_change=bool(body.get("allow_tempo_change")))


@app.post("/api/score/strip-chords")
def score_strip_chords(body: dict) -> dict:
    abc = str(body.get("abc", ""))
    if not abc.strip():
        raise HTTPException(400, "abc is empty")
    return {"abc": _score_call(score_tools.strip_chords, abc, body.get("keep_voice", "both"))}


@app.post("/api/score/instrumentalize")
def score_instrumentalize(body: dict) -> dict:
    abc = str(body.get("abc", ""))
    if not abc.strip():
        raise HTTPException(400, "abc is empty")
    return _score_call(score_tools.instrumentalize, abc,
                       overlap=body.get("overlap", "vocal"),
                       keep_chords=bool(body.get("keep_chords", True)))


@app.post("/api/score/plan")
def score_plan(body: dict) -> dict:
    abc = str(body.get("abc", ""))
    if not abc.strip():
        raise HTTPException(400, "abc is empty")
    return _score_call(score_edit.plan, abc)


@app.post("/api/score/edit")
def score_edit_apply(body: dict) -> dict:
    abc = str(body.get("abc", ""))
    if not abc.strip():
        raise HTTPException(400, "abc is empty")
    ops = body.get("ops")
    return _score_call(score_edit.apply, abc, ops)


# ------------------------------------------------------------------- artifacts
@app.api_route("/api/jobs/{job_id}/artifacts/{name}", methods=["GET", "HEAD"])
def job_artifact(job_id: str, name: str) -> FileResponse:
    if name not in ARTIFACT_NAMES:
        raise HTTPException(404, "unknown artifact")
    path = job_artifacts(job_id) / name
    if not path.exists():
        raise HTTPException(404, "artifact not ready")
    return FileResponse(path, media_type=ARTIFACT_NAMES[name], filename=f"{job_id}_{name}")


@app.api_route("/api/jobs/{job_id}/audio", methods=["GET", "HEAD"])
def job_audio(job_id: str) -> FileResponse:
    path = job_artifacts(job_id) / "audio.flac"
    if not path.exists():
        raise HTTPException(404, "audio not ready")
    return FileResponse(path, media_type="audio/flac", content_disposition_type="inline")


@app.get("/api/jobs/{job_id}/log")
def job_log(job_id: str, lines: int = Query(400, ge=20, le=4000)) -> JSONResponse:
    path = job_dir(job_id) / ".meta" / "run.log"
    if not path.exists():
        raise HTTPException(404, "这个任务还没有日志")
    text = path.read_text(encoding="utf-8", errors="replace")
    return JSONResponse({"job": job_id, "path": str(path), "size": path.stat().st_size,
                         "text": "\n".join(text.splitlines()[-lines:])})


@app.post("/api/jobs/{job_id}/reveal")
def reveal_job_dir(job_id: str) -> dict:
    directory = job_dir(job_id)
    if not directory.exists():
        raise HTTPException(404, "任务目录不存在")
    if not hasattr(os, "startfile"):
        raise HTTPException(501, "当前系统不支持直接打开目录")
    os.startfile(str(directory))
    return {"opened": str(directory)}


@app.get("/api/jobs/{job_id}/score")
def job_score(job_id: str) -> JSONResponse:
    path = job_artifacts(job_id) / "score.abc"
    if not path.exists():
        raise HTTPException(404, "score not found")
    return JSONResponse({"abc": path.read_text(encoding="utf-8")})


@app.get("/api/jobs/{job_id}/lyrics")
def job_lyrics(job_id: str) -> JSONResponse:
    directory = job_artifacts(job_id)
    payload = _read_json(directory / "lyrics.json")
    if payload is not None:
        return JSONResponse(payload)
    error = _read_json(directory / "lyrics.error.json")
    if error:
        return JSONResponse({"status": "failed", "reason": error.get("reason", "")})
    with LOCK:
        job = JOBS.get(job_id)
    if job is None:
        if directory.exists():
            return JSONResponse({"status": "unavailable"})
        raise HTTPException(404, "job not found")
    if job.status != "complete":
        return JSONResponse({"status": "idle", "reason": "任务未完成"})
    if align.find_audio(directory) is None:
        return JSONResponse({"status": "idle", "reason": "没有音频产物"})
    if not _job_lyrics(job).strip():
        return JSONResponse({"status": "idle", "reason": "没有歌词"})
    schedule_alignment(job)
    return JSONResponse({"status": "pending"})


@app.post("/api/jobs/{job_id}/lyrics/retry")
def retry_lyrics(job_id: str) -> dict:
    with LOCK:
        job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if job.status != "complete":
        raise HTTPException(409, "任务未完成，无法对齐歌词")
    directory = job_artifacts(job_id)
    if align.find_audio(directory) is None or not _job_lyrics(job).strip():
        raise HTTPException(409, "没有可用于对齐的音频或歌词")
    for name in ("lyrics.error.json", "lyrics.json"):
        path = directory / name
        if path.exists():
            path.unlink()
    schedule_alignment(job)
    return {"status": "pending"}


# ------------------------------------------------------------------- system
@app.get("/api/system/doctor")
def system_doctor(refresh: bool = False) -> dict:
    now = time.time()
    if not refresh and DOCTOR_CACHE["data"] and now - DOCTOR_CACHE["at"] < 60:
        return DOCTOR_CACHE["data"]
    env = {**os.environ, "YUE2_KIT": str(KIT), "PYTHONUTF8": "1"}
    try:
        run = subprocess.run([str(PYTHON_EXE), "-m", "yue2.cli", "doctor"],
                             cwd=str(ROOT), capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=120, env=env,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        data = json.loads(run.stdout) if run.stdout.strip().startswith("{") else {
            "dependencies_ready": False, "error": (run.stderr or run.stdout or "doctor failed")[-800:]}
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        data = {"dependencies_ready": False, "error": f"{type(exc).__name__}: {exc}"}
    DOCTOR_CACHE["at"], DOCTOR_CACHE["data"] = now, data
    return data


@app.get("/api/events")
def events() -> StreamingResponse:
    sub: queue.Queue = queue.Queue(maxsize=2000)
    with SUB_LOCK:
        SUBSCRIBERS.add(sub)

    def stream():
        try:
            yield ": connected\n\n"
            while True:
                try:
                    event = sub.get(timeout=15)
                except queue.Empty:
                    yield ": keepalive\n\n"
                    continue
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        finally:
            with SUB_LOCK:
                SUBSCRIBERS.discard(sub)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ------------------------------------------------------------------- app lifecycle
@app.get("/")
def index() -> FileResponse:
    return FileResponse(ROOT / "app" / "static" / "index.html")


@app.get("/legacy")
def legacy_index() -> FileResponse:
    return FileResponse(ROOT / "app" / "static" / "index.legacy.html")
