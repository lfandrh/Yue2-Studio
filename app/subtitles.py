"""把歌词时间轴（lyrics.json）转成 SRT / LRC 文本。

时间取值统一先换成整数刻度（毫秒/厘秒）再四舍五入，避免浮点 toString
在 x.xx5 这类边界上出现「差一毫秒」；逐字 LRC 每行末尾补一个行结束标签，
否则播放器在间奏里会把最后一字一直高亮。
"""
from __future__ import annotations

import json
import math
import re
import unicodedata
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from urllib.parse import quote

FORMATS = ("srt", "lrc")
INVALID_NAME_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
LINE_BREAKS = re.compile(r"[ \t]*[\r\n\u2028\u2029]+[ \t]*")


class SubtitleError(ValueError):
    """时间轴无法导出；消息直接展示给用户。"""


def _number(value, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise SubtitleError(f"{label}不是有效数字，无法导出字幕")
    number = float(value)
    if number < 0:
        raise SubtitleError(f"{label}是负数，无法导出字幕")
    return number


def _ticks(seconds: float, per_second: int) -> int:
    scaled = Decimal(str(seconds)) * per_second
    return int(scaled.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def srt_timestamp(seconds: float) -> str:
    total = _ticks(seconds, 1000)
    hours, rest = divmod(total, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    whole, millis = divmod(rest, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole:02d},{millis:03d}"


def lrc_timestamp(seconds: float) -> str:
    total = _ticks(seconds, 100)
    minutes, rest = divmod(total, 6000)
    whole, centis = divmod(rest, 100)
    # 超过 99 分钟时分钟位自然扩到三位：主流播放器按整数解析，不必截断长音频
    return f"[{minutes:02d}:{whole:02d}.{centis:02d}]"


def _word_tag(seconds: float) -> str:
    return f"<{lrc_timestamp(seconds)[1:-1]}>"


def _clean_text(raw, position: int) -> str:
    """保留正文首尾空格；换行/制表符压成空格，控制字符直接拒绝。

    SRT 靠空行分块、LRC 靠换行分句，正文里混进换行会把一条字幕拆成半条；
    首尾空格则可能是歌词本身的排版，不该悄悄丢掉。
    """
    text = str(raw or "")
    if CONTROL_CHARS.search(text):
        raise SubtitleError(f"第 {position} 行歌词含控制字符，无法导出")
    text = LINE_BREAKS.sub(" ", text).replace("\t", " ")
    return text if text.strip() else ""


def _timeline(payload, need_end: bool = False) -> tuple[list[dict], float | None]:
    if not isinstance(payload, dict):
        raise SubtitleError("歌词时间轴文件格式异常，无法导出")
    raw = payload.get("lines")
    if not isinstance(raw, list) or not raw:
        raise SubtitleError("没有可导出的歌词时间轴")
    audio = payload.get("audio_seconds")
    duration = None
    if isinstance(audio, (int, float)) and not isinstance(audio, bool) \
            and math.isfinite(audio) and audio > 0:
        duration = float(audio)
    lines = []
    for position, item in enumerate(raw, 1):
        if not isinstance(item, dict):
            raise SubtitleError(f"第 {position} 行歌词格式异常，无法导出")
        text = _clean_text(item.get("text"), position)
        if not text:
            continue
        start = _number(item.get("start"), f"第 {position} 行开始时间")
        end = None
        if need_end:
            end = _number(item.get("end"), f"第 {position} 行结束时间")
            if end <= start:
                raise SubtitleError(f"第 {position} 行结束时间不晚于开始时间，无法导出")
        lines.append({"position": position, "text": text, "start": start, "end": end,
                      "units": item.get("units")})
    if not lines:
        raise SubtitleError("歌词时间轴里没有可导出的歌词")
    for previous, current in zip(lines, lines[1:]):
        if current["start"] <= previous["start"]:
            raise SubtitleError(f"第 {current['position']} 行开始时间没有晚于上一行，无法导出")
    if duration is not None:
        for line in lines:
            # 行级 LRC 不查 end，但起点在音频之外仍然没有意义
            if line["start"] >= duration:
                raise SubtitleError(f"第 {line['position']} 行开始时间超出音频结尾，无法导出")
    return lines, duration


def _cue_end(line: dict, following: dict | None, duration: float | None) -> float:
    end = line["end"]
    if following is not None:
        end = min(end, following["start"])
    if duration is not None:
        end = min(end, duration)
    if end <= line["start"]:
        raise SubtitleError(f"第 {line['position']} 行超出音频结尾，无法导出")
    return end


def _word_units(line: dict) -> list[tuple[str, float]] | None:
    units = line.get("units")
    if not isinstance(units, list) or not units:
        return None
    words: list[tuple[str, float]] = []
    for unit in units:
        if not isinstance(unit, dict):
            return None
        piece = str(unit.get("text") or "").strip()
        if not piece:
            continue
        try:
            start = _number(unit.get("start"), "字开始时间")
        except SubtitleError:
            return None
        if start < line["start"] - 0.001 or start >= line["end"] - 0.001:
            return None
        if words and start < words[-1][1] - 0.001:
            return None
        words.append((piece, start))
    return words or None


def _segments(line: dict) -> list[tuple[str, float]] | None:
    """把字时间贴回原歌词：ASR 单元通常不含标点，正文必须以原句为准。"""
    words = _word_units(line)
    if words is None:
        return None
    text = line["text"]
    segments: list[list] = []
    position = 0
    for piece, start in words:
        found = text.find(piece, position)
        if found < 0:
            return None
        gap = text[position:found]
        if segments:
            if gap:
                segments[-1][0] += gap
            segments.append([piece, start])
        else:
            segments.append([gap + piece, start])
        position = found + len(piece)
    if position < len(text):
        segments[-1][0] += text[position:]
    if "".join(segment[0] for segment in segments) != text:
        return None
    return [(segment[0], segment[1]) for segment in segments if segment[0]]


def build_srt(payload) -> str:
    lines, duration = _timeline(payload, need_end=True)
    blocks = []
    for index, line in enumerate(lines):
        following = lines[index + 1] if index + 1 < len(lines) else None
        end = _cue_end(line, following, duration)
        blocks.append(f"{index + 1}\r\n{srt_timestamp(line['start'])} --> {srt_timestamp(end)}"
                      f"\r\n{line['text']}")
    return "\r\n\r\n".join(blocks) + "\r\n"


def build_lrc(payload, enhanced: bool = False) -> str:
    lines, duration = _timeline(payload, need_end=bool(enhanced))
    output = []
    for index, line in enumerate(lines):
        if not enhanced:
            output.append(f"{lrc_timestamp(line['start'])}{line['text']}")
            continue
        following = lines[index + 1] if index + 1 < len(lines) else None
        end = _cue_end(line, following, duration)
        segments = _segments(line)
        if segments is None:
            output.append(f"{lrc_timestamp(line['start'])}{line['text']}{_word_tag(end)}")
            continue
        body = "".join(f"{_word_tag(start)}{piece}" for piece, start in segments)
        output.append(f"{lrc_timestamp(line['start'])}{body}{_word_tag(end)}")
    return "\n".join(output) + "\n"


def render(payload, fmt: str, enhanced: bool = False) -> str:
    key = str(fmt or "").strip().lower()
    if key not in FORMATS:
        raise SubtitleError(f"不支持的字幕格式：{fmt}")
    if key == "srt":
        if enhanced:
            raise SubtitleError("SRT 不支持逐字时间轴，请改用 LRC")
        return build_srt(payload)
    return build_lrc(payload, enhanced=bool(enhanced))


def read_export(directory: Path, fmt: str, enhanced: bool = False) -> str:
    path = Path(directory) / "lyrics.json"
    if not path.exists():
        raise SubtitleError("歌词时间轴还没生成，等对齐完成后再导出")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise SubtitleError("歌词时间轴文件损坏，无法导出；可以重新对齐后重试") from exc
    return render(payload, fmt, enhanced)


def _first_lyric_line(lyrics: str) -> str:
    for line in str(lyrics or "").split("\n"):
        text = line.strip()
        if text and not text.startswith("["):
            return text[:14]
    return ""


def _display_name(job) -> str:
    name = str(getattr(job, "work_name", "") or "").strip()
    if name:
        label = str(getattr(job, "version_label", "") or "").strip() \
            or str(getattr(job, "version_tag", "") or "").strip()
        return f"{name} · {label}" if label else name
    title = str(getattr(job, "title", "") or "").strip()
    if title:
        return title
    head = _first_lyric_line((getattr(job, "request", {}) or {}).get("lyrics", ""))
    return head or "未命名任务"


def _safe_name(text: str, limit: int = 48) -> str:
    cleaned = INVALID_NAME_CHARS.sub(" ", unicodedata.normalize("NFC", str(text or "")))
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    return cleaned[:limit].rstrip(" .")


def download_name(job, job_id: str, fmt: str, enhanced: bool = False) -> str:
    base = _safe_name(_display_name(job) if job is not None else "")
    key = str(fmt).strip().lower()
    suffix = ".srt" if key == "srt" else ".lrc"
    word = " (逐字)" if suffix == ".lrc" and enhanced else ""
    return f"{base or 'yue2'} - {job_id}{word}{suffix}"


def content_disposition(filename: str) -> str:
    fallback = "".join(char if 32 <= ord(char) < 127 and char not in '"\\' else "_"
                       for char in filename)
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename, safe='')}"
