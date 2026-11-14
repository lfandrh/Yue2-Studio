"""扫描已产出的 lyrics.json，检查时间轴不变量。运行：
    python tools/verify-lyrics-align.py [runs/jobs]

检查项（任一失败即非零退出）：
- 必需字段齐全，时间都是有限数字
- 每行/每字 start 严格递增，不出现重复时间戳
- end > start，且全部不超过 audio_seconds
- 行 start/end 与首尾字一致，text 非空
- audio_seconds 与磁盘音频实际时长一致（音频存在时）
仅报告不判失败：超长停留行（间奏期间未唱的行会保持显示）、低置信度。
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "runs" / "jobs"
EPS = 0.03

RESULTS: list[tuple[str, bool, str]] = []
WARNINGS: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(ok), detail))
    if not ok:
        print(f"FAIL {name}  -> {detail}")


def finite(value) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(value)


def audio_duration(path: Path) -> float | None:
    try:
        import soundfile as sf

        info = sf.info(str(path))
        return info.frames / info.samplerate if info.samplerate else None
    except Exception:  # noqa: BLE001 - 缺依赖/格式不支持时只跳过该检查
        return None


def scan(path: Path) -> None:
    label = path.parent.parent.parent.name
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        check(f"{label}: 可解析", False, str(exc))
        return
    lines = data.get("lines")
    duration = data.get("audio_seconds")
    check(f"{label}: lines 为列表", isinstance(lines, list) and bool(lines), str(type(lines)))
    check(f"{label}: audio_seconds 有效", finite(duration) and duration > 0, str(duration))
    if not isinstance(lines, list) or not lines or not finite(duration):
        return
    confidence = data.get("confidence")
    check(f"{label}: confidence 在 0~1", finite(confidence) and 0 <= confidence <= 1,
          str(confidence))
    if finite(confidence) and confidence < 0.45:
        WARNINGS.append(f"{label}: 置信度偏低 {confidence:.3f}")

    last_start = -1.0
    units_all: list[dict] = []
    for index, line in enumerate(lines):
        text = (line.get("text") or "").strip()
        units = line.get("units")
        check(f"{label}: 第{index + 1}行有歌词", bool(text), repr(line.get("text")))
        if not isinstance(units, list) or not units:
            check(f"{label}: 第{index + 1}行有字", False, str(units))
            continue
        starts = [unit.get("start") for unit in units]
        ends = [unit.get("end") for unit in units]
        check(f"{label}: 第{index + 1}行时间是数字",
              all(finite(item) for item in starts + ends), f"{starts} / {ends}")
        if not all(finite(item) for item in starts + ends):
            continue
        check(f"{label}: 第{index + 1}行首尾一致",
              abs(line.get("start", -1) - starts[0]) < 1e-6
              and abs(line.get("end", -1) - ends[-1]) < 1e-6,
              f"line={line.get('start')}~{line.get('end')} units={starts[0]}~{ends[-1]}")
        check(f"{label}: 第{index + 1}行 start 递增",
              starts[0] > last_start, f"{last_start} -> {starts[0]}")
        check(f"{label}: 第{index + 1}行字 start 严格递增",
              all(a < b for a, b in zip(starts, starts[1:])), str(starts))
        check(f"{label}: 第{index + 1}行 end > start",
              all(end > start for start, end in zip(starts, ends)),
              str([(s, e) for s, e in zip(starts, ends) if e <= s]))
        check(f"{label}: 第{index + 1}行不越过音频",
              ends[-1] <= duration + EPS and starts[-1] <= duration,
              f"end={ends[-1]} duration={duration}")
        last_start = starts[-1]
        units_all.extend(units)
        hold = ends[-1] - starts[0]
        if hold > 15:
            WARNINGS.append(f"{label}: 第{index + 1}行持续 {hold:.1f}s（间奏/未唱）")

    all_starts = [unit["start"] for unit in units_all if finite(unit.get("start"))]
    duplicates = len(all_starts) - len(set(round(item, 3) for item in all_starts))
    check(f"{label}: 全局没有重复时间戳", duplicates == 0, f"duplicates={duplicates}")

    audio = next((path.parent / name for name in ("audio.flac", "audio.wav")
                  if (path.parent / name).exists()), None)
    if audio is not None:
        actual = audio_duration(audio)
        if actual:
            check(f"{label}: 时长与音频一致", abs(actual - duration) <= 1.0,
                  f"lyrics={duration} audio={actual:.2f}")


def main() -> int:
    files = sorted(BASE.glob("*/out/*/lyrics.json"))
    print(f"扫描 {len(files)} 份 lyrics.json\n")
    for path in files:
        scan(path)
    failed = [item for item in RESULTS if not item[1]]
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} 项通过")
    for warning in WARNINGS:
        print(f"WARN {warning}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
