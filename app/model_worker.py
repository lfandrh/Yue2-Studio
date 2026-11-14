"""Persistent model host for the web UI; JSON lines over stdin/stdout.

Keeping the model in this process lets the UI load it once and unload it on
demand. Long commands accept a ``cancel_file`` path: the pipeline's
``cancelled`` callback checks whether that file exists, so cancellation lands at
the next stage boundary without racing the stdin command loop.

Every progress stage is bridged to a structured ``stage`` event on stdout
(label/completed/total/rate), so the server can push it over SSE instead of
re-parsing the human log.
"""
from __future__ import annotations

import contextlib
import dataclasses
import gc
import json
import logging
import os
import sys
import time
import uuid
from pathlib import Path

PIPE = None
DEVICE = None
BASE_CONFIG = None
RID = None
KIT = Path(os.environ.get("YUE2_KIT", Path(__file__).resolve().parents[1] / "YuE"))
LOG_FORMAT = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"

log = logging.getLogger("yue2.worker")


def emit(**event):
    """Write one JSON line to stdout, tagged with the command it belongs to.

    The server serialises commands, so a stale event can only come from a
    command it already gave up on; the rid lets it discard that instead of
    attributing it to whatever runs next.
    """
    if RID is not None:
        event.setdefault("rid", RID)
    sys.__stdout__.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.__stdout__.flush()


def install_progress_bridge():
    """Emit one structured event whenever the official Progress renders a line."""
    try:
        import yue2.progress as progress_mod
    except Exception as exc:  # noqa: BLE001 - progress is cosmetic; generation still works
        log.warning("进度桥接未安装：%s: %s", type(exc).__name__, exc)
        return
    handle = progress_mod.Progress
    if getattr(handle, "_yue2_bridged", False):
        return
    original = handle._render

    def _render(self, stage, now, status=None, force=False):
        will_render = self.enabled and (force or now - stage._last_render >= self._interval)
        original(self, stage, now, status=status, force=force)
        if not will_render:
            return
        try:
            started = stage._started if stage._started is not None else now
            elapsed = max(0.0, now - started)
            rate = stage.completed / elapsed if elapsed > 0 else 0.0
            emit(event="stage", label=stage.label, completed=int(stage.completed),
                 total=(None if stage.total is None else int(stage.total)),
                 unit=stage.unit, status=status, elapsed=round(elapsed, 1), rate=round(rate, 2))
        except Exception as exc:  # noqa: BLE001 - never let telemetry break generation
            log.debug("进度事件发送失败：%s: %s", type(exc).__name__, exc)

    handle._render = _render
    handle._yue2_bridged = True


def release():
    global PIPE, DEVICE, BASE_CONFIG
    pipe, PIPE, DEVICE, BASE_CONFIG = PIPE, None, None, None
    if pipe is not None:
        try:
            pipe.close()
        except Exception as exc:  # noqa: BLE001 - unloading must continue regardless
            log.warning("关闭管线失败：%s: %s", type(exc).__name__, exc)
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception as exc:  # noqa: BLE001 - nothing left to free if torch cannot load
        log.debug("清空显存缓存失败：%s: %s", type(exc).__name__, exc)


def load(cmd):
    global PIPE, DEVICE, BASE_CONFIG
    release()
    from yue2.pipeline import YuE2Pipeline
    device = cmd["device"]
    budget = float(cmd.get("budget", 24))
    started = time.perf_counter()
    pipe = YuE2Pipeline.from_pretrained(
        cmd["model"], vae=cmd["vae"], device=device, memory_budget_gib=budget,
        backend="torch", staged=device == "cuda",
        ar_graph=os.environ.get("YUE2_AR_GRAPH") == "1",
        vae_core_frames=512 if budget <= 12 else 1024)
    pipe.load()
    PIPE, DEVICE, BASE_CONFIG = pipe, device, pipe.generation_config
    name = "CPU"
    if device == "cuda":
        import torch
        name = torch.cuda.get_device_name(0)
    emit(event="loaded", device=device, device_name=name,
         seconds=time.perf_counter() - started, load=dict(pipe.load_timing))


def _require_pipe():
    if PIPE is None:
        raise RuntimeError("模型未加载")


def _canceller(path):
    if not path:
        return None

    def cancelled():
        return os.path.exists(path)

    return cancelled


def _load_request(path):
    request_path = Path(path)
    data = json.loads(request_path.read_text(encoding="utf-8"))
    data.pop("device", None)
    return data, request_path


def _apply_config(cmd):
    """Reset to the loaded defaults, then apply the per-job overrides."""
    global BASE_CONFIG
    if BASE_CONFIG is None:
        return
    attention = cmd.get("attention") or {}
    PIPE.ar_accel = bool(attention.get("attention_ar"))
    PIPE.nar_accel = bool(attention.get("attention_nar"))
    steps = cmd.get("ode_steps")
    if steps is None:
        PIPE.generation_config = BASE_CONFIG
        return
    steps = int(steps)
    if steps < 1:
        raise ValueError("ode_steps must be >= 1")
    PIPE.generation_config = dataclasses.replace(BASE_CONFIG, ode_steps=steps)


def _vae_path(cmd):
    value = cmd.get("vae")
    if not value or value == "standard":
        return None
    if value == "legacy":
        path = KIT / "models" / "YuE2-Vae-legacy"
        if not path.exists():
            raise RuntimeError("YuE2-Vae-legacy 未安装")
        return str(path)
    path = Path(value)
    if not path.is_dir():
        raise RuntimeError(f"解码器必须是本地解码器目录：{value}")
    return str(path)


def _out_dir(cmd):
    return Path(cmd["output"]) / cmd["id"]


def _write_failure(cmd, exc, trace=None):
    cancel = isinstance(exc, InterruptedError)
    data, _ = (None, None)
    try:
        data, _ = _load_request(cmd["request"]) if cmd.get("request") else (None, None)
    except Exception:  # noqa: BLE001 - the request copy is best effort on the failure path
        data = None
    try:
        directory = _out_dir(cmd)
        directory.mkdir(parents=True, exist_ok=True)
        payload = {"status": "cancelled" if cancel else "failed",
                   "type": type(exc).__name__, "reason": str(exc)}
        if trace:
            payload["trace"] = trace
        if data is not None:
            payload["request"] = data
        (directory / "failure.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as exc2:  # noqa: BLE001 - the caller is already handling a failure
        log.error("写入 failure.json 失败：%s: %s（原始错误：%s）", type(exc2).__name__, exc2, exc)


@contextlib.contextmanager
def _job_log(cmd):
    """Point stderr at this job's own log for the whole command.

    Pipeline progress, torch warnings and tracebacks all land in
    ``.meta/run.log``, so one failed job is readable without the shared log.
    The failure is recorded here, while the stack still has its context.
    """
    path = cmd.get("log")
    saved = handle = None
    if path:
        log_path = Path(path)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        saved = os.dup(2)
        handle = os.open(str(log_path), os.O_WRONLY | os.O_CREAT | os.O_APPEND)
        sys.stderr.flush()
        os.dup2(handle, 2)
    try:
        yield
    except BaseException as exc:
        trace = cmd.get("_trace") or uuid.uuid4().hex[:8]
        cmd["_trace"] = trace
        log.error("任务失败 cmd=%s trace=%s：%s", cmd.get("cmd"), trace,
                  type(exc).__name__, exc_info=exc)
        _write_failure(cmd, exc, trace)
        raise
    finally:
        if saved is not None:
            try:
                sys.stderr.flush()
            finally:
                os.dup2(saved, 2)
                os.close(saved)
                os.close(handle)


def _early_score(cmd, directory):
    """出谱就落盘并通知服务端：整首歌还要跑几分钟，谱面不必等到最后。

    用户给的谱（重渲染）和「不规划」模式没有新谱可报，直接跳过。
    """
    def on_plan(plan):
        if plan.abc is None or plan.request.abc is not None:
            return
        try:
            plan.save(directory)
        except Exception as exc:  # noqa: BLE001 - 提前展示失败不能拖垮生成
            log.warning("提前写谱失败 job=%s：%s: %s", cmd.get("id"), type(exc).__name__, exc)
            return
        emit(event="score", job=cmd.get("id"))
    return on_plan


def generate(cmd):
    with _job_log(cmd):
        _require_pipe()
        _apply_config(cmd)
        from yue2.cli import request_kwargs
        data, request_path = _load_request(cmd["request"])
        kwargs = request_kwargs(data, request_path.parent)
        directory = _out_dir(cmd)
        directory.mkdir(parents=True, exist_ok=True)
        started = time.perf_counter()
        result = PIPE(cancelled=_canceller(cmd.get("cancel_file")),
                      on_plan=_early_score(cmd, directory), **kwargs)
        result.save_artifacts(directory)
        return time.perf_counter() - started


def plan(cmd):
    with _job_log(cmd):
        _require_pipe()
        _apply_config(cmd)
        from yue2.cli import request_kwargs
        from yue2.storage import write_json
        data, request_path = _load_request(cmd["request"])
        kwargs = request_kwargs(data, request_path.parent)
        kwargs.pop("semantic_sampling", None)
        started = time.perf_counter()
        result = PIPE.plan(cancelled=_canceller(cmd.get("cancel_file")), **kwargs)
        out = _out_dir(cmd)
        result.save(out)
        elapsed = time.perf_counter() - started
        # 只出谱任务没有 SongResult，截断信息只存在 plan.json 里；
        # 补一份最小 result.json，服务端才能标 truncated/used seconds。
        write_json(out / "result.json", {
            "status": "complete",
            "truncated": {"abc": bool(result.truncated)},
            "timing": {"e2e_seconds": elapsed},
        })
        return elapsed


def staged(cmd):
    with _job_log(cmd):
        _require_pipe()
        _apply_config(cmd)
        import numpy as np
        from yue2.pipeline import SymbolicPlan, SemanticResult, SongResult
        from yue2.storage import identity

        source_stage = cmd["from"]
        if source_stage not in ("plan", "semantic"):
            raise ValueError("staged 'from' must be plan or semantic")
        source = Path(cmd["src"])
        plan_obj = SymbolicPlan.load(source)
        cancelled = _canceller(cmd.get("cancel_file"))
        started = time.perf_counter()
        if source_stage == "plan":
            semantic = PIPE.generate_semantic(plan_obj, cancelled=cancelled)
        else:
            tokens = np.load(source / "semantic.npy", allow_pickle=False)
            semantic = SemanticResult(plan_obj, [int(t) for t in tokens.tolist()], {}, False)
        latents = PIPE.synthesize(semantic, cancelled=cancelled)
        audio = PIPE.decode(latents, cancelled=cancelled)
        config = PIPE.effective_config(plan_obj.request)
        request_identity = identity({"request": plan_obj.request.to_dict(), "config": config,
                                     "weights": PIPE.weights})
        timing = {"staged_from": source_stage, "e2e_seconds": time.perf_counter() - started}
        result = SongResult(audio, 48000, semantic, latents, config, PIPE.weights,
                            timing, request_identity)
        result.save_artifacts(_out_dir(cmd))
        return time.perf_counter() - started


def redecode(cmd):
    with _job_log(cmd):
        decoder = _vae_path(cmd)  # validate cheap user input before the model precondition
        _require_pipe()
        import shutil
        import numpy as np
        import soundfile as sf
        from yue2.pipeline import SymbolicPlan

        source = Path(cmd["src"])
        SymbolicPlan.load(source)  # validate the plan manifest before trusting latents
        latents = np.load(source / "latent.npy", allow_pickle=False)
        started = time.perf_counter()
        audio = PIPE.decode(latents, vae=decoder, cancelled=_canceller(cmd.get("cancel_file")))
        directory = _out_dir(cmd)
        directory.mkdir(parents=True, exist_ok=True)
        for name in ("plan.json", "abc_tokens.npy", "prefix.npy", "plan_manifest.json", "score.abc",
                     "semantic.npy", "latent.npy", "request.json", "config.json"):
            src = source / name
            if src.exists():
                shutil.copy2(src, directory / name)
        sf.write(directory / "audio.flac", audio, 48000, subtype="PCM_24")
        result = {}
        if (source / "result.json").exists():
            try:
                inherited = json.loads((source / "result.json").read_text(encoding="utf-8"))
            except ValueError as exc:
                log.warning("源任务 %s 的 result.json 无法解析，新结果不继承旧字段：%s",
                            source.name, exc)
            except OSError as exc:
                log.warning("读不到源任务 %s 的 result.json：%s: %s", source.name,
                            type(exc).__name__, exc)
            else:
                if isinstance(inherited, dict):
                    result = inherited
        result.update({"status": "complete", "sample_rate": 48000,
                       "audio_seconds": len(audio) / 48000, "decoded_from": "latent",
                       "decoder": cmd.get("vae") or "standard", "source": source.name})
        (directory / "result.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        return time.perf_counter() - started


def main():
    global RID
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT,
                        datefmt="%Y-%m-%d %H:%M:%S", stream=sys.stderr, force=True)
    log.info("模型进程启动（PID %s）", os.getpid())
    try:
        import yue2
        log.info("yue2 模块路径 %s", yue2.__file__)
    except Exception as exc:  # noqa: BLE001 - keep the diagnostic line non-fatal
        log.warning("无法解析 yue2 模块路径：%s: %s", type(exc).__name__, exc)
    install_progress_bridge()
    handlers = {"generate": generate, "plan": plan, "staged": staged, "redecode": redecode}
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
            except ValueError:
                log.warning("收到无法解析的命令行：%s", line[:300])
                RID = None
                emit(event="error", reason="invalid command")
                continue
            if not isinstance(cmd, dict):
                log.warning("收到的命令不是对象：%s", line[:300])
                RID = None
                emit(event="error", reason="invalid command")
                continue
            action = cmd.get("cmd")
            RID = cmd.get("rid")
            try:
                if action == "load":
                    load(cmd)
                elif action == "unload":
                    release()
                    emit(event="unloaded")
                elif action in handlers:
                    seconds = handlers[action](cmd)
                    try:
                        emit(event="done", action=action, seconds=seconds)
                    except (OSError, ValueError) as exc:
                        # The handler already wrote result.json. A dead server must
                        # not turn a finished song into a failed job.
                        log.error("任务已完成，但结果无法回传（服务端可能已退出）：%s", exc)
                        return
                elif action == "shutdown":
                    release()
                    emit(event="bye")
                    return
                else:
                    raise ValueError(f"unknown command: {action}")
            except BaseException as exc:
                # _job_log 已把带上下文的栈写进任务日志和 failure.json，这里只补总日志。
                trace = cmd.get("_trace") or uuid.uuid4().hex[:8]
                if not cmd.get("_trace"):
                    log.error("命令失败 action=%s trace=%s", action, trace, exc_info=exc)
                else:
                    log.error("命令失败 action=%s trace=%s（详情见该任务的 run.log）", action, trace)
                if action == "load":
                    release()
                elif action in handlers and not cmd.get("_trace"):
                    try:
                        finished = (_out_dir(cmd) / "result.json").exists()
                    except (KeyError, TypeError):
                        finished = False
                    if not finished:
                        _write_failure(cmd, exc, trace)
                emit(event="error", action=action, type=type(exc).__name__, trace=trace,
                     cancelled=isinstance(exc, InterruptedError), reason=str(exc))
    finally:
        release()
        log.info("模型进程退出（PID %s）", os.getpid())


if __name__ == "__main__":
    main()
