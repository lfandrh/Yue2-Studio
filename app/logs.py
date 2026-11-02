"""File logging for the web process: runs/app.log, rotated, UTF-8.

The model runs in a separate process whose stderr the server redirects to
runs/model_worker.log (and to the job's .meta/run.log while a job runs), so it
configures logging on its own instead of importing this module.
"""
from __future__ import annotations

import logging
import logging.handlers
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOG_DIR = ROOT / "runs"
LOG_PATH = LOG_DIR / "app.log"
MAX_BYTES = 5 * 1024 * 1024
BACKUPS = 3
FORMAT = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"
DATE = "%Y-%m-%d %H:%M:%S"

log = logging.getLogger("yue2.web")


def setup() -> logging.Logger:
    """Attach the rotating file handler once; logging must never block startup."""
    parent = logging.getLogger("yue2")
    if getattr(parent, "_yue2_ready", False):
        return log
    parent.setLevel(logging.INFO)
    parent.propagate = False
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        handler = logging.handlers.RotatingFileHandler(
            LOG_PATH, maxBytes=MAX_BYTES, backupCount=BACKUPS, encoding="utf-8")
        handler.setFormatter(logging.Formatter(FORMAT, DATE))
        # uvicorn sets propagate=False on its own loggers, so it needs its own copy.
        logging.getLogger("uvicorn.error").addHandler(handler)
        logging.getLogger("uvicorn.access").addHandler(handler)
    except OSError as exc:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(logging.Formatter(FORMAT, DATE))
        parent.addHandler(handler)
        parent._yue2_ready = True
        log.warning("日志文件不可写（%s: %s），改为输出到控制台", type(exc).__name__, exc)
        return log
    parent.addHandler(handler)
    parent._yue2_ready = True
    return log
