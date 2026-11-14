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
    # 官方 convert_score 只认 intro/verse/... 固定段名，模型原谱含 verse 1/chorus 1 等
    # 复合标签会整单 400（BUG-004）。这里不改上游词表：失败时按通用标题归一化重试，
    # 归一化方式是保守的（取首词并按已知段族映射），产物仍逐音校验。
    try:
        text, check = _convert_score(abc, overlap=overlap, keep_chords=bool(keep_chords))
    except ValueError:
        fixed = _normalize_section_labels(abc)
        if fixed == abc:
            raise
        text, check = _convert_score(fixed, overlap=overlap, keep_chords=bool(keep_chords))
        check = {**check, "section_normalized": True}
    return {"abc": text, "check": check}


_FAMILY = {"intro": "intro", "verse": "verse", "pre-chorus": "pre-chorus",
           "chorus": "chorus", "bridge": "bridge", "interlude": "interlude",
           "outro": "outro", "instrumental": "instrumental"}


def _normalize_section_labels(abc: str) -> str:
    lines = []
    for line in abc.splitlines():
        if line.startswith("% "):
            label = line[2:].strip().lower()
            head = label.split()[0] if label else ""
            mapped = _FAMILY.get(head)
            if mapped is None and label.startswith(("post-", "pre-")):
                mapped = "pre-chorus" if label.startswith("pre-") else "chorus"
            lines.append(f"% {mapped}" if mapped else line)
        else:
            lines.append(line)
    return "\n".join(lines) + ("\n" if abc.endswith("\n") else "")
