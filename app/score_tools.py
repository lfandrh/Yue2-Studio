"""Adapter over the official yue2-music skill scripts.

The scripts are pure functions (no model load). We inject their directories onto
sys.path once, and degrade to a clear error if the scripts move on upgrade.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_SKILL = ROOT / "YuE" / "skills" / "yue2-music"
_SCRIPTS = _SKILL / "scripts"
_INSTRUMENTAL = _SKILL / "instrumental" / "scripts"

_abc_tools = None
_convert_score = None
_import_error = ""


def _ensure() -> None:
    global _abc_tools, _convert_score, _import_error
    if _abc_tools is not None and _convert_score is not None:
        return
    for path in (_SCRIPTS, _INSTRUMENTAL):
        if str(path) not in sys.path:
            sys.path.insert(0, str(path))
    try:
        import abc_tools  # type: ignore
        from instrumentalize import convert_score  # type: ignore
    except Exception as exc:  # noqa: BLE001 - surface import failure to the endpoint
        _import_error = f"{type(exc).__name__}: {exc}"
        raise ScoreToolsUnavailable(_import_error) from exc
    _abc_tools = abc_tools
    _convert_score = convert_score


class ScoreToolsUnavailable(RuntimeError):
    pass


def available() -> bool:
    try:
        _ensure()
        return True
    except ScoreToolsUnavailable:
        return False


def inspect(abc: str) -> dict:
    _ensure()
    return _abc_tools.report(_abc_tools.parse_abc(abc))


def compare(before: str, after: str, allow_tempo_change: bool = False) -> dict:
    _ensure()
    return _abc_tools.compare(
        _abc_tools.parse_abc(before),
        _abc_tools.parse_abc(after),
        allow_tempo_change=bool(allow_tempo_change),
    )


def strip_chords(abc: str, keep_voice: str = "both") -> str:
    _ensure()
    if keep_voice not in ("both", "Vocal", "Ins"):
        raise ValueError("keep_voice must be both, Vocal or Ins")
    return _abc_tools.strip_chords(abc, keep_voice=keep_voice)


def instrumentalize(abc: str, overlap: str = "vocal", keep_chords: bool = True) -> dict:
    _ensure()
    if overlap not in ("vocal", "error"):
        raise ValueError("overlap must be vocal or error")
    text, check = _convert_score(abc, overlap=overlap, keep_chords=bool(keep_chords))
    return {"abc": text, "check": check}
