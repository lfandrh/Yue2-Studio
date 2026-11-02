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
SMARTSUB_CACHE = Path("D:/Software/SmartSub/cache/faster-whisper-models/hub")
HF_HOME = Path(os.environ.get("HF_HOME") or Path.home() / ".cache" / "huggingface")
SMARTSUB_DATA = Path(os.environ.get("APPDATA") or "") / "smartsub" / "models"

log = logging.getLogger("yue2.align")

RATE = 16000
WINDOW = 4.0          # seconds per ASR window (sherpa engine, no native timing)
HOP = 1.0             # window stride; 3 s of overlap per window
TS_WINDOW = 8.0       # native-timestamp engine: longer windows still decode cleanly
TS_HOP = 4.0
LOOKBACK = 8          # canonical units a window may re-match behind the cursor

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
        (SMARTSUB_CACHE, "models--*whisper*turbo*"),
        (HF_HOME / "hub", "models--*whisper*turbo*"),
        (SMARTSUB_CACHE, "models--Systran--faster-whisper-*"),
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
    cursor = 0
    starts = list(range(0, max(len(samples) - window, 0) + 1, hop)) or [0]
    for start in starts:
        stream = recognizer.create_stream()
        stream.accept_waveform(RATE, samples[start:start + window])
        recognizer.decode_stream(stream)
        heard = [_norm(unit) for unit in _units(stream.result.text or "")]
        if not heard or cursor >= total:
            continue
        # Look a little behind the cursor: neighbouring windows decode the same
        # characters, and their median cancels each window's lead-in bias.
        low = max(0, cursor - LOOKBACK)
        limit = min(total, cursor + len(heard) * 3 + 6)
        if limit - low < 2:
            continue
        matcher = SequenceMatcher(None, heard, normed[low:limit], autojunk=False)
        blocks = [block for block in matcher.get_matching_blocks() if block.size >= 2]
        for heard_at, unit_at, size in blocks:
            for offset in range(size):
                position = start / RATE + (heard_at + offset + 0.5) / len(heard) * WINDOW
                # Longer decodes are less truncated, so they get more weight.
                estimates[low + unit_at + offset].extend([position] * len(heard))
        if blocks:
            cursor = max(cursor, low + max(block.b + block.size for block in blocks))
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
    cursor = 0
    starts = list(range(0, max(len(samples) - window, 0) + 1, hop)) or [0]
    for start in starts:
        block = samples[start:start + window]
        if block.size < int(0.5 * RATE):
            continue
        heard = _token_units(engine.decode(block))
        if not heard or cursor >= total:
            continue
        offset = start / RATE
        low = max(0, cursor - LOOKBACK)
        limit = min(total, cursor + len(heard) * 3 + 6)
        if limit - low < 2:
            continue
        matcher = SequenceMatcher(None, [item[0] for item in heard],
                                  normed[low:limit], autojunk=False)
        blocks = [block_ for block_ in matcher.get_matching_blocks() if block_.size >= 2]
        for heard_at, unit_at, size in blocks:
            for index in range(size):
                estimates[low + unit_at + index].append(offset + heard[heard_at + index][1])
        if blocks:
            cursor = max(cursor, low + max(block_.b + block_.size for block_ in blocks))
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
            step = max(right - left, count * 0.06) / count
            for offset in range(count):
                spans[start + offset] = (left + offset * step, left + (offset + 1) * step)
        elif right is not None:
            step = min(count * average, right) / count
            for offset in range(count):
                spans[start + offset] = (right - step * count + offset * step,
                                         right - step * count + (offset + 1) * step)
        elif left is not None:
            for offset in range(count):
                spans[start + offset] = (left + offset * average, left + (offset + 1) * average)
        else:
            step = min(duration or 1.0, count * average) / count
            for offset in range(count):
                spans[start + offset] = (offset * step, (offset + 1) * step)


def _monotonic(starts: list[float]) -> list[float]:
    fixed, last = [], 0.0
    for start in starts:
        start = max(start, last)
        fixed.append(round(start, 3))
        last = start + 0.03
    return fixed


def _build(starts: list[float], duration: float, lines: list[dict],
           engine: str, confidence: float) -> dict:
    count = len(starts)
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


def align(audio: Path, lyrics: str, engine: str | None = None) -> dict:
    lines = lyric_lines(lyrics)
    if not lines:
        raise ValueError("歌词为空")
    normed = [_norm(unit) for line in lines for unit in line["units"]]
    choice = (engine or os.environ.get("YUE2_ALIGN_ENGINE") or "auto").strip().lower()
    attempts = []
    if choice in ("auto", "paraformer-ts") and paraformer_ts_ready():
        attempts.append(("Paraformer 原生时间戳",
                         lambda: _paraformer_ts_starts(audio, normed, lines)))
    if choice in ("auto", "paraformer") and paraformer_ready():
        attempts.append(("Paraformer 窗口对齐", lambda: _paraformer_starts(audio, normed)))
    if choice in ("auto", "whisper") and whisper_dir() is not None:
        attempts.append(("faster-whisper large-v3-turbo",
                         lambda: _whisper_starts(audio, normed, _language(lyrics))))
    if not attempts:
        raise RuntimeError("没有可用的歌词对齐模型")

    errors = []
    for label, run in attempts:
        try:
            starts, duration, matched = run()
        except Exception as exc:  # noqa: BLE001 - try the next engine
            errors.append(f"{label}：{exc}")
            continue
        confidence = matched / max(len(normed), 1)
        if matched < 3 or confidence < 0.2:
            errors.append(f"{label}：可对齐的字太少（{matched}/{len(normed)}）")
            continue
        if duration <= 0:
            duration = max((item for item in starts if item is not None), default=1.0)
        spans = [(item, item + 0.03) if item is not None else None for item in starts]
        _fill_gaps(spans, duration)
        fixed = _monotonic([item[0] for item in spans if item is not None])
        return _build(fixed, duration, lines, label, confidence)
    raise ValueError("；".join(errors) or "没有识别到可对齐的演唱")


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
