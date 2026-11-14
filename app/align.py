"""Lyric alignment: ASR only supplies timing, characters come from the user's lyrics.

Primary engine is the Paraformer ONNX that also exports CIF peaks, so each unit
gets the model's own timestamp (8 s windows, 4 s hop). The sherpa-only export has
no timing at all and falls back to uniform placement inside 4 s windows; Whisper,
when installed, is the precision fallback. Every engine anchors its ASR units to
the canonical lyric units, so misheard characters never reach the screen.
Runs on CPU in one background thread.
"""
from __future__ import annotations

import json
import logging
import os
import queue
import re
import threading
import time
from difflib import SequenceMatcher
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KIT = ROOT / "YuE"
PARAFORMER_DIR = KIT / "models" / "paraformer-zh"
PARAFORMER_ONNX = PARAFORMER_DIR / "model.int8.onnx"
PARAFORMER_TOKENS = PARAFORMER_DIR / "tokens.txt"
WHISPER_DIR = KIT / "models" / "faster-whisper-large-v3-turbo"
HF_HOME = Path(os.environ.get("HF_HOME") or Path.home() / ".cache" / "huggingface")
SMARTSUB_DATA = Path(os.environ.get("APPDATA") or "") / "smartsub" / "models"

log = logging.getLogger("yue2.align")

RATE = 16000
WINDOW = 4.0          # seconds per ASR window (sherpa engine, no native timing)
HOP = 1.0             # window stride; 3 s of overlap per window
TS_WINDOW = 8.0       # native-timestamp engine: longer windows still decode cleanly
TS_HOP = 4.0
LOOKBACK = 8          # canonical units a window may re-match behind the cursor
MIN_BLOCK = 3         # 3+ units carry enough text to identify a line on their own
SHORT_BLOCK_NEAR = 12.0  # 2-unit matches only count while singing continues (normal pauses fit)
MIN_UNIT_SECONDS = 0.12  # fastest plausible delivery; used to reject implausible anchors
ESTIMATE_TOLERANCE = 2.0  # overlapping windows may refine a unit by this much, not relocate it

MARKER_RE = re.compile(r"^\[[^\]]+\]$")
UNIT_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]|[A-Za-z0-9]+(?:['’][A-Za-z]+)?")
CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
AUDIO_NAMES = ("audio.flac", "audio.wav")

_MODEL = {"para": None, "whisper": None}
_MODEL_LOCK = threading.Lock()
_QUEUE: queue.Queue = queue.Queue()
_QUEUED: set[str] = set()
_QUEUE_LOCK = threading.Lock()
_WORKER = None


# ------------------------------------------------------------------ model discovery
def paraformer_ready() -> bool:
    return PARAFORMER_ONNX.exists() and PARAFORMER_TOKENS.exists()


def _ts_module():
    try:
        from . import paraformer_ts
    except ImportError:  # imported as a plain module (scripts, tests)
        import paraformer_ts  # type: ignore[no-redef]
    return paraformer_ts


def paraformer_ts_ready() -> bool:
    try:
        return _ts_module().ready()
    except ImportError:
        return False


def whisper_dir() -> Path | None:
    """First existing faster-whisper model directory, project copy first."""
    if os.environ.get("YUE2_ALIGN_MODEL"):
        path = Path(os.environ["YUE2_ALIGN_MODEL"])
        return path if (path / "model.bin").exists() else None
    if WHISPER_DIR.joinpath("model.bin").exists():
        return WHISPER_DIR
    roots = [
        (HF_HOME / "hub", "models--*whisper*turbo*"),
        (HF_HOME / "hub", "models--Systran--faster-whisper-*"),
        (SMARTSUB_DATA, "*whisper*"),
    ]
    for root, pattern in roots:
        if not root.is_dir():
            continue
        for model in sorted(root.glob(pattern)):
            snapshots = model / "snapshots"
            for snapshot in sorted(snapshots.glob("*/") if snapshots.is_dir() else [model]):
                if (snapshot / "model.bin").exists():
                    return snapshot
    return None


def available() -> bool:
    return paraformer_ts_ready() or paraformer_ready() or whisper_dir() is not None


def _threads(cap: int) -> int:
    return max(1, min(cap, (os.cpu_count() or 4) - 2))


def _paraformer():
    with _MODEL_LOCK:
        if _MODEL["para"] is not None:
            return _MODEL["para"]
        if not paraformer_ready():
            raise RuntimeError("找不到 Paraformer 模型")
        import sherpa_onnx

        _MODEL["para"] = sherpa_onnx.OfflineRecognizer.from_paraformer(
            paraformer=str(PARAFORMER_ONNX), tokens=str(PARAFORMER_TOKENS),
            num_threads=_threads(8), sample_rate=RATE, feature_dim=80,
            decoding_method="greedy_search")
        return _MODEL["para"]


def _whisper():
    with _MODEL_LOCK:
        if _MODEL["whisper"] is not None:
            return _MODEL["whisper"]
        path = whisper_dir()
        if path is None:
            raise RuntimeError("找不到 Whisper 对齐模型")
        from faster_whisper import WhisperModel

        _MODEL["whisper"] = WhisperModel(str(path), device="cpu", compute_type="int8",
                                         cpu_threads=_threads(12))
        return _MODEL["whisper"]


# ------------------------------------------------------------------ lyrics units
def _units(text: str) -> list[str]:
    return UNIT_RE.findall(text)


def _norm(text: str) -> str:
    return text.lower() if text.isascii() else text


def _language(lyrics: str) -> str | None:
    cjk = len(CJK_RE.findall(lyrics))
    latin = len(re.findall(r"[A-Za-z]", lyrics))
    if cjk and cjk >= latin / 2:
        return "zh"
    if latin:
        return "en"
    return None


def lyric_lines(lyrics: str) -> list[dict]:
    lines = []
    for raw in (lyrics or "").splitlines():
        text = raw.strip()
        if not text or MARKER_RE.match(text):
            continue
        units = _units(text)
        if units:
            lines.append({"text": text, "units": units})
    return lines


# ------------------------------------------------------------------ audio decode
def _pcm(audio: Path) -> tuple["object", float]:
    import numpy as np
    import soundfile as sf

    data, rate = sf.read(str(audio), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if rate != RATE and mono.size:
        count = max(1, int(round(len(mono) * RATE / rate)))
        source = np.linspace(0.0, 1.0, len(mono), endpoint=False)
        target = np.linspace(0.0, 1.0, count, endpoint=False)
        mono = np.interp(target, source, mono).astype("float32")
    peak = float(np.max(np.abs(mono))) if mono.size else 0.0
    if peak > 0:
        mono = (mono / peak * 0.9).astype("float32")
    return mono, len(mono) / RATE


def _window_starts(total: int, window: int, hop: int) -> list[int]:
    """滑窗起点，末尾补一个「贴到结尾」的窗。

    `range(0, total - window + 1, hop)` 只能停在 hop 的整数倍上：整首歌最后不足一个
    hop 的音频永远不进任何窗口，尾句因此拿不到实测锚点，只能靠插值推算。
    """
    last = max(total - window, 0)
    starts = list(range(0, last + 1, hop)) or [0]
    if starts[-1] != last:
        starts.append(last)
    return starts


def _match_window(heard: list[str], normed: list[str], cursor: int) -> tuple[int, list]:
    """Anchor one ASR window to the lyric units it most likely sang.

    The target window stops shortly after what this window heard. A wider window
    (the old 3x factor) lets an identical chorus match its second occurrence:
    the cursor then jumps over the first one, lyrics race ahead and hold for the
    length of the skipped section. Anchoring stays forward-only; LOOKBACK only
    lets neighbouring windows vote on a few units already matched.
    """
    low = max(0, cursor - LOOKBACK)
    limit = min(len(normed), cursor + len(heard) + 8)
    if limit - low < 2:
        return low, []
    matcher = SequenceMatcher(None, heard, normed[low:limit], autojunk=False)
    return low, [block for block in matcher.get_matching_blocks() if block.size >= 2]


def _search_far(heard: list[str], normed: list[str], cursor: int) -> tuple[int, list]:
    """Recover the line that is actually being sung after the singer skipped lyrics.

    Instrumental sections and lyric-sheet lines the model never sings leave the
    forward cursor behind. The near window then sees real text it cannot reach.
    Only a strong match (most of what this window heard) may jump forward; the
    caller still checks that the jump is possible in the elapsed time, so an
    identical chorus cannot be mistaken for the one already playing.
    """
    target = normed[cursor:]
    if len(target) < 2:
        return cursor, []
    matcher = SequenceMatcher(None, heard, target, autojunk=False)
    need = max(MIN_BLOCK, (len(heard) * 3 + 4) // 5)
    return cursor, [block for block in matcher.get_matching_blocks() if block.size >= need]


def _reachable(unit_at: int, time_at: float, anchor_unit: int, anchor_time: float) -> bool:
    """A jump may not cover more lyric units than the elapsed audio could deliver."""
    if time_at < anchor_time - 0.8:
        return False
    return (unit_at - anchor_unit) * MIN_UNIT_SECONDS <= (time_at - anchor_time) + 2.0


def _pick_blocks(heard: list[str], normed: list[str], cursor: int, total: int,
                 duration: float, anchor_unit: int, anchor_time: float,
                 block_time) -> tuple[int, list]:
    """Near-window matches first; fall back to a strong, time-reachable long jump."""
    def usable(low: int, blocks: list) -> list:
        out = []
        for block in blocks:
            time_at = block_time(block)
            if not _plausible(total, low + block.b, time_at, duration):
                continue
            if not _reachable(low + block.b, time_at, anchor_unit, anchor_time):
                continue
            # 2 字匹配只在同一句还在唱时可信；隔了间奏再遇到，多半是别处的巧合。
            if block.size < MIN_BLOCK and time_at - anchor_time > SHORT_BLOCK_NEAR:
                continue
            out.append(block)
        return out

    low, blocks = _match_window(heard, normed, cursor)
    chosen = usable(low, blocks)
    if chosen:
        return low, chosen
    low, blocks = _search_far(heard, normed, cursor)
    chosen = usable(low, blocks)
    return (low, chosen) if chosen else (cursor, [])


def _plausible(total: int, unit_at: int, heard_at: float, duration: float) -> bool:
    """Reject anchors that cannot leave room for the units still to come.

    A misheard fragment near the end ("由他" from another line, "天地间" from the
    outro) can match a later lyric line; anchoring it there squeezes every line
    after it into the last seconds. Genuine anchors always leave at least the
    fastest plausible delivery time for the remaining units.
    """
    if duration <= 0:
        return True
    remaining = max(0, total - unit_at)
    return heard_at <= duration and duration - heard_at >= remaining * MIN_UNIT_SECONDS


def _add_estimate(bucket: list[float], value: float, weight: int = 1) -> None:
    """Keep a unit at the first place it was heard.

    A repeated chorus is decoded again when the audio reaches its second
    occurrence. Without this guard those later estimates outvote the correct
    first one and the line drifts to the repeat. Neighbouring windows still vote
    within ``ESTIMATE_TOLERANCE`` to smooth edge truncation.
    """
    if bucket and value > bucket[0] + ESTIMATE_TOLERANCE:
        return
    bucket.extend([value] * weight)


def _paraformer_starts(audio: Path, normed: list[str]) -> tuple[list, float, int]:
    """Windowed Paraformer decode; each window's text is anchored forward-only.

    Returns per-unit start times (None where unmatched), audio seconds and the
    number of units that received at least one estimate.
    """
    import numpy as np

    recognizer = _paraformer()
    samples, duration = _pcm(audio)
    window, hop = int(WINDOW * RATE), int(HOP * RATE)
    total = len(normed)
    estimates: list[list[float]] = [[] for _ in range(total)]
    cursor, anchor_unit, anchor_time = 0, 0, 0.0
    starts = _window_starts(len(samples), window, hop)
    for start in starts:
        stream = recognizer.create_stream()
        stream.accept_waveform(RATE, samples[start:start + window])
        recognizer.decode_stream(stream)
        heard = [_norm(unit) for unit in _units(stream.result.text or "")]
        if not heard or cursor >= total:
            continue
        offset = start / RATE
        low, blocks = _pick_blocks(
            heard, normed, cursor, total, duration, anchor_unit, anchor_time,
            lambda block, offset=offset: offset + (block.a + 0.5) / len(heard) * WINDOW)
        if not blocks:
            continue
        # 邻窗解码会重复听到同一段字，取中位数抵消各窗的起始偏差。
        for heard_at, unit_at, size in blocks:
            for step in range(size):
                position = offset + (heard_at + step + 0.5) / len(heard) * WINDOW
                # Longer decodes are less truncated, so they get more weight.
                _add_estimate(estimates[low + unit_at + step], position, len(heard))
        if blocks:
            cursor = anchor_unit = max(
                cursor, low + max(block.b + block.size for block in blocks))
            anchor_time = max(
                anchor_time, max(offset + (block.a + 0.5) / len(heard) * WINDOW
                                 for block in blocks))
        if cursor >= total:
            break
    times = [float(np.median(values)) if values else None for values in estimates]
    return times, duration, sum(1 for item in times if item is not None)


def _token_units(tokens: list[tuple[str, float, float]]) -> list[tuple[str, float]]:
    """Tokens to lyric units; BPE continuations (``word@@``) are joined first."""
    merged: list[tuple[str, float, float]] = []
    buffer, begin, end = "", 0.0, 0.0
    for text, start, stop in tokens:
        if not text:
            continue
        if text.endswith("@@"):
            if not buffer:
                begin = start
            buffer += text[:-2]
            end = stop
            continue
        if not buffer:
            begin = start
        buffer += text
        end = stop
        merged.append((buffer, begin, end))
        buffer = ""
    if buffer:
        merged.append((buffer, begin, end))
    heard: list[tuple[str, float]] = []
    for word, begin, end in merged:
        units = _units(word)
        if not units:
            continue
        step = max(end - begin, 0.0) / len(units)
        for index, unit in enumerate(units):
            heard.append((_norm(unit), begin + index * step))
    return heard


def _paraformer_ts_starts(audio: Path, normed: list[str],
                          lines: list[dict] | None = None) -> tuple[list, float, int]:
    """Paraformer decode where every unit carries the model's own timestamp.

    Windows are wider than the sherpa engine's because token times do not depend
    on the window offset; tokens pinned to a window edge are dropped upstream in
    paraformer_ts. The anchor stage is identical to the sherpa engine. A line
    whose start was truncated by the sliding windows is re-decoded in place.
    """
    import numpy as np

    engine = _ts_module()
    samples, duration = _pcm(audio)
    window, hop = int(TS_WINDOW * RATE), int(TS_HOP * RATE)
    total = len(normed)
    estimates: list[list[float]] = [[] for _ in range(total)]
    cursor, anchor_unit, anchor_time = 0, 0, 0.0
    starts = _window_starts(len(samples), window, hop)
    for start in starts:
        block = samples[start:start + window]
        if block.size < int(0.5 * RATE):
            continue
        heard = _token_units(engine.decode(block))
        if not heard or cursor >= total:
            continue
        offset = start / RATE
        low, blocks = _pick_blocks(
            [unit for unit, _ in heard], normed, cursor, total, duration,
            anchor_unit, anchor_time, lambda block_, offset=offset: offset + heard[block_.a][1])
        if not blocks:
            continue
        for heard_at, unit_at, size in blocks:
            for index in range(size):
                _add_estimate(estimates[low + unit_at + index],
                              offset + heard[heard_at + index][1])
        if blocks:
            cursor = anchor_unit = max(
                cursor, low + max(block_.b + block_.size for block_ in blocks))
            anchor_time = max(
                anchor_time, max(offset + heard[block_.a][1] for block_ in blocks))
        if cursor >= total:
            break
    times = [float(np.median(values)) if values else None for values in estimates]
    if lines:
        times = _refine_lines(samples, lines, normed, times, duration)
    return times, duration, sum(1 for item in times if item is not None)


def _whisper_starts(audio: Path, normed: list[str], language: str | None) -> tuple[list, float, int]:
    model = _whisper()
    segments, info = model.transcribe(
        str(audio), language=language, beam_size=5, word_timestamps=True,
        condition_on_previous_text=False, vad_filter=False)
    heard: list[tuple[str, float]] = []
    for segment in segments:
        for word in segment.words or []:
            units = _units(word.word or "")
            if not units:
                continue
            span = max(0.02, float(word.end) - float(word.start))
            step = span / len(units)
            for index, unit in enumerate(units):
                heard.append((_norm(unit), float(word.start) + index * step))
    if not heard:
        return [None] * len(normed), float(getattr(info, "duration", 0.0) or 0.0), 0
    starts: list = [None] * len(normed)
    matcher = SequenceMatcher(None, [item[0] for item in heard], normed, autojunk=False)
    for heard_at, unit_at, size in matcher.get_matching_blocks():
        for offset in range(size):
            starts[unit_at + offset] = heard[heard_at + offset][1]
    duration = float(getattr(info, "duration", 0.0) or 0.0)
    return starts, duration, sum(1 for item in starts if item is not None)


def _align_pairs(heard: list[tuple[str, float]], target: list[str]) -> list[tuple[int, int]]:
    """Global DP alignment; returns (heard, unit) index pairs of equal characters.

    SequenceMatcher breaks a run on every misheard character, which leaves holes
    that later get interpolated. A DP alignment keeps the order through the wrong
    character and still anchors both of its neighbours.
    """
    import numpy as np

    count, size = len(heard), len(target)
    if not count or not size:
        return []
    score = np.zeros((count + 1, size + 1), dtype=np.int32)
    score[:, 0] = -np.arange(count + 1)
    score[0, :] = -np.arange(size + 1)
    move = np.zeros((count + 1, size + 1), dtype=np.int8)
    for row in range(1, count + 1):
        char = heard[row - 1][0]
        for col in range(1, size + 1):
            best = score[row - 1, col - 1] + (2 if char == target[col - 1] else -1)
            code = 0
            if score[row - 1, col] - 1 > best:
                best, code = score[row - 1, col] - 1, 1
            if score[row, col - 1] - 1 > best:
                best, code = score[row, col - 1] - 1, 2
            score[row, col] = best
            move[row, col] = code
    pairs, row, col = [], count, size
    while row and col:
        code = move[row, col]
        if code == 0:
            if heard[row - 1][0] == target[col - 1]:
                pairs.append((row - 1, col - 1))
            row -= 1
            col -= 1
        elif code == 1:
            row -= 1
        else:
            col -= 1
    pairs.reverse()
    return pairs


def _refine_lines(samples, lines: list[dict], normed: list[str], starts: list,
                  duration: float) -> list:
    """Re-decode each line in its own window and take the model's token times.

    The sliding pass can truncate a line at a window edge, which pins its first
    tokens to the edge. A window built around the rough position has the whole
    line inside, so the estimates come from one clean decode of that line.
    """
    engine = _ts_module()
    out = list(starts)
    cursor = 0
    for line in lines:
        size = len(line["units"])
        chunk = starts[cursor:cursor + size]
        target = normed[cursor:cursor + size]
        begin = cursor
        cursor += size
        known = [item for item in chunk if item is not None]
        if len(known) * 2 < size:
            continue
        low = max(0.0, min(known) - 1.0)
        high = min(duration, max(known) + 1.5, low + 20.0)
        if high - low < 0.5:
            continue
        heard = _token_units(engine.decode(samples[int(low * RATE):int(high * RATE)]))
        pairs = _align_pairs(heard, target)
        if len(pairs) * 2 < size:
            continue
        for heard_at, unit_at in pairs:
            out[begin + unit_at] = low + heard[heard_at][1]
    return out


# ------------------------------------------------------------------ post-processing
def _fill_gaps(spans: list[tuple[float, float] | None], duration: float) -> None:
    """Interpolate unmatched units between the surrounding anchors."""
    total = len(spans)
    average = (duration or 1.0) / max(total, 1) * 0.9
    index = 0
    while index < total:
        if spans[index] is not None:
            index += 1
            continue
        start = index
        while index < total and spans[index] is None:
            index += 1
        count = index - start
        left = spans[start - 1][1] if start > 0 else None
        right = spans[index][0] if index < total else None
        if left is not None and right is not None:
            natural = (right - left) / count
            cap = max(average * 1.6, 0.12)
            if natural <= cap:
                step = max(natural, 0.06)
                for offset in range(count):
                    spans[start + offset] = (left + offset * step, left + (offset + 1) * step)
            else:
                # 中间隔着间奏或歌词没唱的行：这档字属于右锚点所在句子的开头，
                # 贴着它排。按整段均分会把每个字拉成好几秒，行首被拖回上一行末尾。
                step = cap
                begin = right - count * step
                for offset in range(count):
                    spans[start + offset] = (max(0.0, begin + offset * step),
                                             begin + (offset + 1) * step)
        elif right is not None:
            step = min(count * average, right) / count
            for offset in range(count):
                spans[start + offset] = (right - step * count + offset * step,
                                         right - step * count + (offset + 1) * step)
        elif left is not None:
            # 只有左锚的尾档按平均字长外推；不夹住的话时间戳能越过音频结尾，
            # 播放器 timeupdate 永远命不中那几行，表现为「最后一句不亮」。
            step = average
            if duration and left + count * step > duration - 0.05:
                step = max(0.03, (duration - 0.05 - left) / count)
            for offset in range(count):
                spans[start + offset] = (left + offset * step, left + (offset + 1) * step)
        else:
            step = min(duration or 1.0, count * average) / count
            for offset in range(count):
                spans[start + offset] = (offset * step, (offset + 1) * step)


def _finalize_starts(starts: list[float], duration: float) -> list[float]:
    """Strictly increasing starts that still fit before the audio ends.

    Clamping every late start to ``duration - 0.05`` separately would give several
    lines the same timestamp; the player's binary search then skips all but the
    last one. Pull the tail back as a block instead, preserving order and spacing.
    """
    fixed, last = [], 0.0
    for start in starts:
        start = max(start, last)
        fixed.append(round(start, 3))
        last = start + 0.03
    ceiling = max(0.0, duration - 0.05)
    for index in range(len(fixed) - 1, -1, -1):
        limit = ceiling - 0.03 * (len(fixed) - 1 - index)
        if fixed[index] <= limit:
            break
        fixed[index] = max(0.0, limit)
    return fixed


def _build(starts: list[float], duration: float, lines: list[dict],
           engine: str, confidence: float) -> dict:
    count = len(starts)
    ceiling = max(0.0, duration)
    payload_lines, cursor = [], 0
    for line in lines:
        size = len(line["units"])
        chunk = starts[cursor:cursor + size]
        cursor += size
        units = []
        for index, text in enumerate(line["units"]):
            following = starts[cursor - size + index + 1] if index + 1 < size else (
                starts[cursor] if cursor < count else None)
            end = following if following is not None and following > chunk[index] else chunk[index] + 0.45
            # 结束时间夹进音频时长：越界区间会让下游的逐字/进度判断落到不存在的音频上。
            end = min(end, ceiling)
            if end <= chunk[index]:
                end = min(chunk[index] + 0.03, ceiling)
            units.append({"text": text, "start": chunk[index], "end": round(end, 3)})
        payload_lines.append({"text": line["text"], "start": units[0]["start"],
                              "end": units[-1]["end"], "units": units})
    for index in range(len(payload_lines) - 1):
        gap = payload_lines[index + 1]["start"] - payload_lines[index]["end"]
        if 0 < gap <= 1.2:
            payload_lines[index]["end"] = payload_lines[index + 1]["start"]
    return {
        "engine": engine,
        "method": "asr-anchor",
        "audio_seconds": round(duration, 2),
        "confidence": round(confidence, 3),
        "created_at": time.time(),
        "lines": payload_lines,
    }


def _whisper_label() -> str:
    """Report the model actually on disk; the UI writes this into lyrics.json."""
    path = whisper_dir()
    if path is None:
        return "faster-whisper"
    name = path.name
    if re.fullmatch(r"[0-9a-f]{8,}", name):  # HF snapshot hash, use the repo name
        name = path.parent.parent.name.removeprefix("models--").replace("--", "/")
    return f"faster-whisper {name}"


def align(audio: Path, lyrics: str, engine: str | None = None) -> dict:
    lines = lyric_lines(lyrics)
    if not lines:
        raise ValueError("歌词里没有可对齐的字（目前支持中文与拉丁字母）")
    normed = [_norm(unit) for line in lines for unit in line["units"]]
    choice = (engine or os.environ.get("YUE2_ALIGN_ENGINE") or "auto").strip().lower()
    known = [("paraformer-ts", "Paraformer 原生时间戳", paraformer_ts_ready,
              lambda: _paraformer_ts_starts(audio, normed, lines)),
             ("paraformer", "Paraformer 窗口对齐", paraformer_ready,
              lambda: _paraformer_starts(audio, normed)),
             ("whisper", _whisper_label(),
              lambda: whisper_dir() is not None,
              lambda: _whisper_starts(audio, normed, _language(lyrics)))]
    attempts = [(label, run) for key, label, ready, run in known
                 if choice in ("auto", key) and ready()]
    if not attempts:
        raise RuntimeError(_engine_unavailable(choice, known))

    errors = []
    for label, run in attempts:
        try:
            starts, duration, matched = run()
        except Exception as exc:  # noqa: BLE001 - try the next engine
            errors.append(f"{label}：{exc}")
            continue
        confidence = matched / max(len(normed), 1)
        # 绝对下限跟着歌词长度缩放：一两句的副歌只有十个字，写死 3 个字会把整首拒掉。
        floor = max(2, round(len(normed) * 0.05))
        if matched < floor or confidence < 0.2:
            errors.append(f"{label}：可对齐的字太少（{matched}/{len(normed)}）")
            continue
        if duration <= 0:
            duration = max((item for item in starts if item is not None), default=1.0)
        spans = [(item, item + 0.03) if item is not None else None for item in starts]
        _fill_gaps(spans, duration)
        fixed = _finalize_starts([item[0] for item in spans if item is not None], duration)
        return _build(fixed, duration, lines, label, confidence)
    raise ValueError("；".join(errors) or "没有识别到可对齐的演唱")


def _engine_unavailable(choice: str, known: list[tuple]) -> str:
    """显式指定的引擎没模型时，说清是「你指定的这个」不可用，而不是泛泛一句没有模型。"""
    labels = {key: label for key, label, _, _ in known}
    if choice not in labels:
        return f"未知的对齐引擎「{choice}」，可选：{'、'.join(labels)}"
    ready = [lbl for key, lbl, check, _ in known if key != choice and check()]
    return (f"指定引擎「{labels[choice]}」不可用：本机没有它的模型。"
            + (f"当前可用：{'、'.join(ready)}；不设 YUE2_ALIGN_ENGINE 则自动选。" if ready
               else "当前一个对齐模型都没有。"))


# ------------------------------------------------------------------ background queue
def _loop() -> None:
    while True:
        job_id, audio, lyrics, out, done = _QUEUE.get()
        ok = False
        try:
            data = align(audio, lyrics)
            data["job"] = job_id
            out.parent.mkdir(parents=True, exist_ok=True)
            temp = out.with_name(out.name + ".tmp")
            temp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
            os.replace(temp, out)
            out.with_name("lyrics.error.json").unlink(missing_ok=True)
            ok = True
        except Exception as exc:  # noqa: BLE001 - one failed song must not kill the worker
            log.warning("歌词对齐失败 %s：%s: %s", job_id, type(exc).__name__, exc, exc_info=exc)
            try:
                out.with_name("lyrics.error.json").write_text(
                    json.dumps({"reason": str(exc), "at": time.time()}, ensure_ascii=False),
                    encoding="utf-8")
            except OSError as write_exc:
                log.warning("写入 lyrics.error.json 失败 %s：%s", job_id, write_exc)
        finally:
            with _QUEUE_LOCK:
                _QUEUED.discard(job_id)
            if done is not None:
                try:
                    done(ok)
                except Exception as exc:  # noqa: BLE001 - callbacks must not kill the worker
                    log.warning("歌词对齐回调失败 %s：%s: %s", job_id, type(exc).__name__, exc)
            _QUEUE.task_done()


def schedule(job_id: str, audio: Path, lyrics: str, out: Path, done=None) -> bool:
    global _WORKER
    with _QUEUE_LOCK:
        if job_id in _QUEUED:
            return False
        _QUEUED.add(job_id)
        _QUEUE.put((job_id, Path(audio), lyrics, Path(out), done))
        if _WORKER is None or not _WORKER.is_alive():
            _WORKER = threading.Thread(target=_loop, daemon=True, name="lyric-align")
            _WORKER.start()
    return True


def busy(job_id: str) -> bool:
    """True while this job is queued for, or running, lyric alignment."""
    with _QUEUE_LOCK:
        return job_id in _QUEUED


def find_audio(directory: Path) -> Path | None:
    for name in AUDIO_NAMES:
        path = directory / name
        if path.exists():
            return path
    return None
