"""Pure text rules shared by job creation, serialization, and derived lyrics."""
from __future__ import annotations

import re
from collections.abc import Callable

LYRIC_TAG = re.compile(r"\[[^\]]*\]")
LYRIC_CJK = re.compile(r"[\u3400-\u9fff]")
LYRIC_WORD = re.compile(r"[A-Za-z]+")


def clean_title(value: object) -> str:
    """Validate a title without depending on FastAPI; callers map ValueError to HTTP 400."""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("标题必须是文本")
    title = value.strip()
    if len(title) > 200:
        raise ValueError("标题最多 200 个字")
    return title


def lyric_head(text: str) -> str:
    """First lyric line, skipping [Verse]-style section markers."""
    for line in str(text or "").split("\n"):
        line = line.strip()
        if line and not line.startswith("["):
            return line[:14]
    return ""


def lyric_units(text: str) -> float:
    """CJK counts as one unit, English words as 1.4; keep in sync with front-end lyricUnits()."""
    clean = LYRIC_TAG.sub(" ", str(text or ""))
    return round(len(LYRIC_CJK.findall(clean)) + len(LYRIC_WORD.findall(clean)) * 1.4, 1)


def effective_lyrics(job_type: str, request: dict | None, snapshot: dict | None,
                     source_loader: Callable[[], dict | None]) -> str:
    """Resolve export lyrics for derived jobs, preferring a persisted snapshot.

    Source loading stays a callback so the pure module does not know about the job DB.
    """
    request = request or {}
    if job_type not in ("staged", "redecode"):
        return str(request.get("lyrics") or "")
    if isinstance(snapshot, dict):
        saved = str(snapshot.get("lyrics") or "")
        if saved.strip():
            return saved
    lyrics = str(request.get("lyrics") or "")
    if not lyrics:
        source = source_loader() or {}
        lyrics = str((source.get("requested") or {}).get("lyrics") or "")
    return lyrics
