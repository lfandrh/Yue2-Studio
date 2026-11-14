#!/usr/bin/env python3
"""YuE2 自动更新回归测试：在真实服务上走一遍 check -> download -> apply，再恢复原状。

前置：服务已在跑（例如 start.bat 9097）。脚本会临时替换 app/ 代码并自动恢复，
      只改代码路径，不动 runs/ 数据、YuE/models、YuE/.venv。
用法：
    python tools/verify-update.py --port 9097
    python tools/verify-update.py --port 9097 --rollback   # 额外验证失败回滚
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "runs"
VERIFY = RUNS / "_verify"
HOST = "127.0.0.1"
MARKER = "/* yue2-verify-update-marker */"


def http_json(method: str, path: str, body: dict | None = None, timeout: float = 15) -> dict:
    data = json.dumps(body or {}).encode("utf-8")
    req = urllib.request.Request(f"http://{HOST}:{ARGS.port}{path}", data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def wait_health(port: int, timeout: float = 90) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://{HOST}:{port}/api/health", timeout=3) as response:
                if response.status == 200:
                    return json.loads(response.read().decode("utf-8"))
        except Exception:
            pass
        time.sleep(1.0)
    raise RuntimeError("服务探活超时")


def bump(version: str) -> str:
    parts = [int(p) for p in str(version).split(".")]
    while len(parts) < 3:
        parts.append(0)
    parts[2] += 1
    return ".".join(str(p) for p in parts)


def make_package(version: str, zip_path: Path, breaking: bool = False) -> str:
    stage = VERIFY / "stage"
    if stage.exists():
        shutil.rmtree(stage)
    (stage / "app").mkdir(parents=True)
    shutil.copytree(ROOT / "app", stage / "app", ignore=shutil.ignore_patterns("__pycache__"))
    for name in ("start.bat", "stop.bat", "clean.bat"):
        if (ROOT / name).exists():
            shutil.copy2(ROOT / name, stage / name)
    (stage / "version.json").write_text(json.dumps(
        {"version": version, "commit": "verify", "built_at": "verify"}, ensure_ascii=False),
        encoding="utf-8")
    store = stage / "app" / "static" / "js" / "store.js"
    text = store.read_text(encoding="utf-8")
    if breaking:
        text = text.replace("export const state = {", "export const state = { this is not valid js", 1)
    store.write_text(text + f"\n{MARKER}\n", encoding="utf-8")
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(stage.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(stage).as_posix())
    shutil.rmtree(stage)
    return hashlib.sha256(zip_path.read_bytes()).hexdigest()


def restore(app_backup: Path, version_backup: Path, update_backup: Path, port: int) -> None:
    print("==> 恢复原代码")
    if (ROOT / "app").exists():
        shutil.rmtree(ROOT / "app")
    shutil.copytree(app_backup, ROOT / "app", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copy2(version_backup, ROOT / "version.json")
    shutil.copy2(update_backup, ROOT / "update.json")
    subprocess.run(["cmd", "/c", "stop.bat", str(port), "--no-pause"], cwd=ROOT,
                   capture_output=True, timeout=60)
    subprocess.Popen(["cmd", "/c", "start", "", "/b", "start.bat", str(port), "--no-pause"],
                     cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    health = wait_health(port, 90)
    print("    恢复后版本:", health.get("version"))


def main() -> int:
    global ARGS
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=9097)
    parser.add_argument("--rollback", action="store_true")
    ARGS = parser.parse_args()

    if VERIFY.exists():
        shutil.rmtree(VERIFY)
    VERIFY.mkdir(parents=True)
    app_backup = VERIFY / "app-backup"
    version_backup = VERIFY / "version.json.bak"
    update_backup = VERIFY / "update.json.bak"
    shutil.copytree(ROOT / "app", app_backup, ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copy2(ROOT / "version.json", version_backup)
    shutil.copy2(ROOT / "update.json", update_backup)

    before = wait_health(ARGS.port, 30)
    current = str(before.get("version") or "0.0.0")
    target = bump(current)
    print(f"当前版本 {current} -> 目标版本 {target}")

    serve = VERIFY / "serve"
    serve.mkdir()
    sha = make_package(target, serve / f"yue2-code-{target}.zip")
    manifest = {"version": target, "channel": "stable",
                "url": (serve / f"yue2-code-{target}.zip").as_uri(),
                "sha256": sha, "size": (serve / f"yue2-code-{target}.zip").stat().st_size,
                "changelog": "verify", "published_at": "verify", "min_version": "0.0.1"}
    (serve / "latest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    (ROOT / "update.json").write_text(json.dumps(
        {"update_url": (serve / "latest.json").as_uri(), "channel": "stable", "auto_check": False}),
        encoding="utf-8")

    # 服务端 current_version() 有 30s 缓存
    print("等待版本缓存过期（31s）…")
    time.sleep(31)

    try:
        check = http_json("POST", "/api/system/update/check", {})
        assert check["has_update"] and check["latest"] == target, check
        print("check OK:", check["latest"], "sha256", check["sha256"][:12])

        download = http_json("POST", "/api/system/update/download",
                             {"url": check["url"], "sha256": check["sha256"]}, timeout=60)
        assert download["sha256"] == check["sha256"], download
        print("download OK:", download["size"], "bytes")

        apply_result = http_json("POST", "/api/system/update/apply", {"port": ARGS.port}, timeout=15)
        print("apply:", apply_result)
        health = wait_health(ARGS.port, 90)
        assert health.get("version") == target, health
        marker = (ROOT / "app" / "static" / "js" / "store.js").read_text(encoding="utf-8")
        assert MARKER in marker, "标记不存在，说明代码没有替换"
        print("apply OK: version =", health["version"], "jobs =", health["jobs"])

        if ARGS.rollback:
            print("==> 额外验证失败回滚")
            bad = bump(target)
            bad_sha = make_package(bad, serve / "bad.zip", breaking=True)
            (ROOT / "update.json").write_text(json.dumps(
                {"update_url": (serve / "latest.json").as_uri(), "channel": "stable",
                 "auto_check": False}), encoding="utf-8")
            manifest["version"] = bad
            manifest["url"] = (serve / "bad.zip").as_uri()
            manifest["sha256"] = bad_sha
            (serve / "latest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
            time.sleep(31)
            check = http_json("POST", "/api/system/update/check", {})
            assert check["has_update"], check
            dl = http_json("POST", "/api/system/update/download",
                           {"url": check["url"], "sha256": check["sha256"]}, timeout=60)
            assert dl["sha256"] == check["sha256"]
            http_json("POST", "/api/system/update/apply", {"port": ARGS.port}, timeout=15)
            print("等待回滚（最多 200s）…")
            time.sleep(200)
            health = wait_health(ARGS.port, 60)
            assert health.get("version") == target, health
            status = http_json("GET", "/api/system/update/status")
            assert status.get("rolled_back"), status
            print("rollback OK: version =", health["version"], "rolled_back =", status.get("rolled_back"))

        print("\n全部通过")
        return 0
    finally:
        restore(app_backup, version_backup, update_backup, ARGS.port)
        if VERIFY.exists():
            shutil.rmtree(VERIFY)


if __name__ == "__main__":
    sys.exit(main())