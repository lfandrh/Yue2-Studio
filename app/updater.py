#!/usr/bin/env python3
"""YuE2 code-only updater. Runs as a detached process, never as a child of the
web server: the server launches it through ``cmd /c start``, so the stop script's
``taskkill /T`` cannot take it down with the server tree.

Flow: stop -> backup -> apply zip -> clear __pycache__ -> restart -> health check
      -> on failure restore backup and restart again.

Only code paths are touched (app/, root scripts, docs, version.json). runs/,
YuE/models, YuE/.venv and demo/ are never written. Write status to
runs/_update/status.json so the web UI can poll it after the restart.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "runs"
UPDATE_DIR = RUNS / "_update"
BACKUP_DIR = RUNS / "_backup"
STATUS_PATH = UPDATE_DIR / "status.json"
LOG_PATH = UPDATE_DIR / "updater.log"

# Paths a code package may write. Anything else in the zip is ignored.
ALLOWED_ROOT_FILES = {
    "version.json", "start.bat", "stop.bat", "clean.bat",
    "使用说明.md", "README.md",
}
# update.json 故意不在白名单：用户可能改过更新源地址，更新代码时保留本地配置。
ALLOWED_ROOT_DIRS = {"app"}
# Never extracted, even if a malformed package contains them.
FORBIDDEN_PREFIXES = ("runs", "YuE", "demo", ".git", "tools", "docs", "design",
                      "test-run", ".workbuddy-ai")

_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def log(message: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}"
    try:
        UPDATE_DIR.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass
    try:
        print(line, flush=True)
    except Exception:
        pass


def write_status(**fields) -> None:
    try:
        UPDATE_DIR.mkdir(parents=True, exist_ok=True)
        payload = {"at": time.time(), "pid": os.getpid()}
        payload.update(fields)
        STATUS_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                               encoding="utf-8")
    except OSError as exc:
        log(f"写状态失败：{exc}")


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def wait_port_free(port: int, timeout: float) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_free(port):
            return True
        time.sleep(0.5)
    return port_free(port)


def stop_server(port: int) -> None:
    """Reuse stop.bat when present; otherwise kill the listener by port."""
    stop_bat = ROOT / "stop.bat"
    if stop_bat.exists():
        log("停止服务：stop.bat")
        try:
            subprocess.run(["cmd.exe", "/c", str(stop_bat), str(port), "--no-pause"],
                           cwd=str(ROOT), capture_output=True, timeout=60,
                           creationflags=_CREATE_NO_WINDOW)
        except (OSError, subprocess.SubprocessError) as exc:
            log(f"stop.bat 执行失败：{exc}")
        return
    log("未找到 stop.bat，按端口结束监听进程")
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                             timeout=20).stdout
    except (OSError, subprocess.SubprocessError) as exc:
        log(f"netstat 失败：{exc}")
        return
    pids = set()
    for line in out.splitlines():
        if f":{port} " in line and "LISTENING" in line:
            parts = line.split()
            if parts and parts[-1].isdigit():
                pids.add(parts[-1])
    for pid in pids:
        log(f"taskkill /PID {pid} /T /F")
        subprocess.run(["taskkill", "/PID", pid, "/T", "/F"],
                       capture_output=True, timeout=20)


def backup_code() -> Path:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    target = BACKUP_DIR / stamp
    if target.exists():
        target = BACKUP_DIR / (stamp + "-" + str(int(time.time() * 1000) % 1000))
    target.mkdir(parents=True, exist_ok=True)
    app_src = ROOT / "app"
    if app_src.exists():
        shutil.copytree(app_src, target / "app",
                        ignore=shutil.ignore_patterns("__pycache__"))
    for name in sorted(ALLOWED_ROOT_FILES):
        src = ROOT / name
        if src.is_file():
            shutil.copy2(src, target / name)
    (target / "RESTORED").write_text("backup of the code paths only\n", encoding="utf-8")
    log(f"备份完成：{target}")
    return target


def prune_backups(keep: int = 5) -> None:
    if not BACKUP_DIR.exists():
        return
    items = sorted((p for p in BACKUP_DIR.iterdir() if p.is_dir()),
                   key=lambda p: p.name, reverse=True)
    for old in items[keep:]:
        try:
            shutil.rmtree(old)
            log(f"清理旧备份：{old.name}")
        except OSError as exc:
            log(f"清理旧备份失败 {old.name}：{exc}")


def safe_member(name: str) -> bool:
    parts = Path(name).parts
    if not parts:
        return False
    if any(part in ("..", "") for part in parts):
        return False
    if name.startswith(("/", "\\")) or ":" in parts[0]:
        return False
    first = parts[0]
    if first in FORBIDDEN_PREFIXES:
        return False
    if len(parts) == 1 and first not in ALLOWED_ROOT_FILES:
        return False
    if len(parts) > 1 and first not in ALLOWED_ROOT_DIRS:
        return False
    return True


def clear_pycache() -> None:
    app = ROOT / "app"
    if not app.exists():
        return
    for path in sorted(app.rglob("__pycache__"), reverse=True):
        try:
            shutil.rmtree(path)
        except OSError as exc:
            log(f"清理 __pycache__ 失败 {path}：{exc}")


def apply_zip(zip_path: Path) -> None:
    log(f"解压更新包：{zip_path}")
    applied = 0
    with zipfile.ZipFile(zip_path) as archive:
        for member in archive.infolist():
            name = member.filename.replace("\\", "/")
            if not safe_member(name):
                log(f"跳过非法路径：{name}")
                continue
            dest = ROOT / name
            if member.is_dir():
                dest.mkdir(parents=True, exist_ok=True)
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as src, dest.open("wb") as out:
                shutil.copyfileobj(src, out)
            applied += 1
    clear_pycache()
    log(f"已写入 {applied} 个文件")


def restore_backup(backup: Path) -> None:
    log(f"回滚到备份：{backup}")
    app_backup = backup / "app"
    if app_backup.exists():
        app_dst = ROOT / "app"
        if app_dst.exists():
            shutil.rmtree(app_dst)
        shutil.copytree(app_backup, app_dst,
                        ignore=shutil.ignore_patterns("__pycache__"))
    for name in sorted(ALLOWED_ROOT_FILES):
        src = backup / name
        if src.is_file():
            shutil.copy2(src, ROOT / name)
    clear_pycache()
    log("回滚完成")


def restart_server(port: int) -> bool:
    start_bat = ROOT / "start.bat"
    if not start_bat.exists():
        log("未找到 start.bat，无法自动重启")
        return False
    log("启动服务：start.bat")
    try:
        subprocess.Popen(["cmd.exe", "/c", "start", "", "/b", str(start_bat),
                          str(port), "--no-pause"],
                         cwd=str(ROOT), close_fds=True,
                         creationflags=_CREATE_NO_WINDOW)
    except (OSError, subprocess.SubprocessError) as exc:
        log(f"启动失败：{exc}")
        return False
    return True


def wait_health(port: int, timeout: float) -> bool:
    url = f"http://127.0.0.1:{port}/api/health"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if response.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(1.0)
    return False


def read_version() -> str:
    path = ROOT / "version.json"
    try:
        return str(json.loads(path.read_text(encoding="utf-8")).get("version") or "")
    except (OSError, ValueError):
        return ""


def run(zip_path: Path, port: int, timeout: float) -> int:
    started = time.time()
    log("=" * 60)
    log(f"更新开始 pid={os.getpid()} zip={zip_path} port={port}")
    if not zip_path.is_file():
        write_status(phase="failed", ok=False, error=f"更新包不存在：{zip_path}")
        return 2

    write_status(phase="stopping", ok=False, version=read_version(),
                 detail="正在停止服务")
    # Give the launching cmd a moment to exit so this process is fully detached.
    time.sleep(1.0)
    if not port_free(port):
        stop_server(port)
    if not wait_port_free(port, 40):
        write_status(phase="failed", ok=False, error="端口未释放，服务仍在运行")
        return 3

    write_status(phase="backup", ok=False, version=read_version(),
                 detail="正在备份当前代码")
    backup = backup_code()
    prune_backups()

    write_status(phase="apply", ok=False, version=read_version(),
                 detail="正在写入新代码")
    try:
        apply_zip(zip_path)
    except Exception as exc:  # noqa: BLE001 - any failure must roll back
        log(f"解压失败：{exc}")
        restore_backup(backup)
        restart_server(port)
        write_status(phase="failed", ok=False, rolled_back=True,
                     error=f"解压失败已回滚：{exc}")
        return 4

    write_status(phase="restart", ok=False, version=read_version(),
                 detail="正在重启服务")
    if not restart_server(port):
        restore_backup(backup)
        write_status(phase="failed", ok=False, rolled_back=True,
                     error="无法启动服务，已回滚")
        return 5

    write_status(phase="health", ok=False, version=read_version(),
                 detail="正在探活")
    if wait_health(port, timeout):
        log(f"更新成功，耗时 {time.time() - started:.1f}s")
        try:
            zip_path.unlink(missing_ok=True)
        except OSError as exc:
            log(f"清理安装包失败：{exc}")
        write_status(phase="done", ok=True, version=read_version(),
                     detail=f"已更新到 {read_version()}，耗时 {time.time() - started:.1f}s")
        return 0

    log("新版本探活失败，开始回滚")
    restore_backup(backup)
    restart_server(port)
    if wait_health(port, timeout):
        write_status(phase="done", ok=False, rolled_back=True, version=read_version(),
                     error="新版本无法启动，已回滚到更新前版本")
        return 6
    write_status(phase="failed", ok=False, rolled_back=True, version=read_version(),
                 error="回滚后仍无法启动，请查看 runs/_update/updater.log 并手动恢复")
    return 7


def main() -> int:
    parser = argparse.ArgumentParser(description="YuE2 code-only updater")
    parser.add_argument("--zip", required=True)
    parser.add_argument("--port", type=int, default=9090)
    parser.add_argument("--timeout", type=float, default=120.0)
    args = parser.parse_args()
    UPDATE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        return run(Path(args.zip).resolve(), args.port, args.timeout)
    except Exception as exc:  # noqa: BLE001 - never leave status unknown
        log(f"未捕获异常：{exc}")
        write_status(phase="failed", ok=False, error=str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main())