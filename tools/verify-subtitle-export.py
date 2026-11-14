"""验收 SRT / LRC 纯函数：边界样例 + 现有全部 lyrics.json。

运行：
    python tools/verify-subtitle-export.py
"""
from __future__ import annotations

import glob
import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app import server as server_module
from app import subtitles
from app.subtitles import SubtitleError

RESULTS: list[tuple[str, bool, str]] = []

SRT_TIME = re.compile(r"^\d{2,}:\d{2}:\d{2},\d{3}$")
LRC_TIME = re.compile(r"^\[(\d{2,}):(\d{2})\.(\d{2})\]")
WORD_TAG = re.compile(r"<(\d{2,}):(\d{2})\.(\d{2})>")


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(ok), detail))
    if not ok:
        print(f"FAIL {name}  -> {detail}")


def eq(name: str, actual, expected) -> None:
    check(name, actual == expected, f"actual={actual!r} expected={expected!r}")


def raises(name: str, fn) -> None:
    try:
        fn()
    except SubtitleError:
        check(name, True)
    except Exception as exc:  # noqa: BLE001 - 测试里任何别的异常都算失败
        check(name, False, f"{type(exc).__name__}: {exc}")
    else:
        check(name, False, "没有抛 SubtitleError")


def payload(lines: list[dict], duration: float | None = 10.0) -> dict:
    data = {"lines": lines}
    if duration is not None:
        data["audio_seconds"] = duration
    return data


def line(text: str, start: float, end: float, units=None) -> dict:
    item = {"text": text, "start": start, "end": end}
    if units is not None:
        item["units"] = [{"text": t, "start": s, "end": e} for t, s, e in units]
    return item


def test_boundaries() -> None:
    data = payload([
        line("", 0.2, 0.8),
        line("第一行", 1.0, 6.0, [("第", 1.0, 1.5), ("一", 1.5, 2.0), ("行", 2.0, 2.5)]),
        line("第二行", 5.0, 9.0, [("第", 5.0, 5.5), ("二", 5.5, 6.0), ("行", 6.0, 6.5)]),
        line("第三行", 9.5, 12.0, [("第", 9.5, 9.7), ("三", 9.7, 9.9), ("行", 9.9, 10.0)]),
    ])
    eq("SRT 精确输出（结尾裁到下一行/音频）",
       subtitles.build_srt(data),
       "1\r\n00:00:01,000 --> 00:00:05,000\r\n第一行\r\n\r\n"
       "2\r\n00:00:05,000 --> 00:00:09,000\r\n第二行\r\n\r\n"
       "3\r\n00:00:09,500 --> 00:00:10,000\r\n第三行\r\n")
    eq("行级 LRC 精确输出",
       subtitles.build_lrc(data),
       "[00:01.00]第一行\n[00:05.00]第二行\n[00:09.50]第三行\n")
    eq("逐字 LRC 行尾补结束标签",
       subtitles.build_lrc(data, enhanced=True),
       "[00:01.00]<00:01.00>第<00:01.50>一<00:02.00>行<00:05.00>\n"
       "[00:05.00]<00:05.00>第<00:05.50>二<00:06.00>行<00:09.00>\n"
       "[00:09.50]<00:09.50>第<00:09.70>三<00:09.90>行<00:10.00>\n")

    eq("SRT 用 CRLF", "\n" not in subtitles.build_srt(data).replace("\r\n", ""), True)
    eq("LRC 用 LF", "\r" not in subtitles.build_lrc(data), True)
    check("SRT 无 BOM", not subtitles.build_srt(data).startswith("\ufeff"))

    no_units = payload([line("没有逐字", 2.0, 3.0)])
    eq("逐字缺失时退回行级", subtitles.build_lrc(no_units, enhanced=True),
       "[00:02.00]没有逐字<00:03.00>\n")

    english = payload([line("Hello, world!", 1.0, 2.0, [
        ("Hello", 1.0, 1.2), (",", 1.2, 1.3), ("world", 1.3, 1.5), ("!", 1.5, 1.6)])])
    eq("逐字保留原文标点与空格", subtitles.build_lrc(english, enhanced=True),
       "[00:01.00]<00:01.00>Hello<00:01.20>, <00:01.30>world<00:01.50>!<00:02.00>\n")
    eq("英文行级原文不动", subtitles.build_lrc(english), "[00:01.00]Hello, world!\n")

    no_punct = payload([line("提一壶，春风", 1.0, 3.0, [
        ("提", 1.0, 1.2), ("一", 1.2, 1.4), ("壶", 1.4, 1.6), ("春", 1.6, 1.8), ("风", 1.8, 2.0)])])
    eq("逐字补回未标注的标点", subtitles.build_lrc(no_punct, enhanced=True),
       "[00:01.00]<00:01.00>提<00:01.20>一<00:01.40>壶，<00:01.60>春<00:01.80>风<00:03.00>\n")

    one = payload([line("嘿", 1.0, 4.0, [("嘿", 1.0, 1.4)])])
    eq("单字行仍有逐字标签", subtitles.build_lrc(one, enhanced=True),
       "[00:01.00]<00:01.00>嘿<00:04.00>\n")

    bad_units = payload([line("坏单位", 1.0, 4.0, [("坏", 1.0, 1.2), ("单", None, 1.5)])])
    eq("单位时间无效时退回行级", subtitles.build_lrc(bad_units, enhanced=True),
       "[00:01.00]坏单位<00:04.00>\n")

    spaced = payload([line("  hello  ", 1.0, 2.0)])
    eq("SRT 保留首尾空格", subtitles.build_srt(spaced),
       "1\r\n00:00:01,000 --> 00:00:02,000\r\n  hello  \r\n")
    eq("行级 LRC 保留首尾空格", subtitles.build_lrc(spaced), "[00:01.00]  hello  \n")
    spaced_words = payload([line("  Hello world  ", 1.0, 2.0, [
        ("Hello", 1.0, 1.2), ("world", 1.3, 1.5)])])
    eq("逐字保留首尾空格", subtitles.build_lrc(spaced_words, enhanced=True),
       "[00:01.00]<00:01.00>  Hello <00:01.30>world  <00:02.00>\n")

    eq("歌词内换行压成空格",
       subtitles.build_lrc(payload([line("a\r\nb", 1.0, 2.0)])), "[00:01.00]a b\n")
    eq("制表符压成空格",
       subtitles.build_lrc(payload([line("a\tb", 1.0, 2.0)])), "[00:01.00]a b\n")
    raises("控制字符拒绝导出",
           lambda: subtitles.build_srt(payload([line("a\x00b", 1.0, 2.0)])))

    arrow = payload([line("A --> B", 1.0, 2.0)])
    eq("SRT 正文里的 --> 不破坏块", subtitles.build_srt(arrow),
       "1\r\n00:00:01,000 --> 00:00:02,000\r\nA --> B\r\n")
    eq("LRC 正文里的 --> 原样保留", subtitles.build_lrc(arrow), "[00:01.00]A --> B\n")


def test_rounding() -> None:
    eq("SRT 毫秒四舍五入", subtitles.srt_timestamp(1.2345), "00:00:01,235")
    eq("LRC 厘秒四舍五入", subtitles.lrc_timestamp(1.235), "[00:01.24]")
    eq("时间可以超过一小时", subtitles.srt_timestamp(3661.5), "01:01:01,500")
    eq("LRC 分钟可超过 99", subtitles.lrc_timestamp(6001.0), "[100:01.00]")


def test_errors() -> None:
    raises("顶层不是对象", lambda: subtitles.build_srt([]))
    raises("没有 lines", lambda: subtitles.build_srt({}))
    raises("全空歌词", lambda: subtitles.build_srt(payload([line(" ", 1.0, 2.0)])))
    raises("开始时间缺失", lambda: subtitles.build_srt(payload([line("x", None, 2.0)])))
    raises("结束不晚于开始",
           lambda: subtitles.build_srt(payload([line("x", 2.0, 2.0)])))
    raises("行开始时间倒退",
           lambda: subtitles.build_srt(payload([line("a", 2.0, 3.0), line("b", 2.0, 4.0)])))
    raises("整行越过音频结尾",
           lambda: subtitles.build_srt(payload([line("x", 3.0, 4.0)], duration=2.0)))
    raises("不支持的格式", lambda: subtitles.render(payload([line("x", 1.0, 2.0)]), "ass"))
    raises("SRT 不允许逐字",
           lambda: subtitles.render(payload([line("x", 1.0, 2.0)]), "srt", enhanced=True))
    eq("格式名大小写不敏感",
       subtitles.render(payload([line("x", 1.0, 2.0)]), " SRT "),
       "1\r\n00:00:01,000 --> 00:00:02,000\r\nx\r\n")

    bad_end = payload([line("x", 2.0, 2.0), line("y", 3.0, 4.0)])
    eq("行级 LRC 不依赖 end", subtitles.build_lrc(bad_end), "[00:02.00]x\n[00:03.00]y\n")
    raises("逐字 LRC 仍检查 end", lambda: subtitles.build_lrc(bad_end, enhanced=True))
    raises("SRT 仍检查 end", lambda: subtitles.build_srt(bad_end))
    eq("行级 LRC 缺 end 也能导出",
       subtitles.build_lrc({"lines": [{"text": "x", "start": 1.0}]}), "[00:01.00]x\n")
    raises("行级 LRC 起点越过音频",
           lambda: subtitles.build_lrc(payload([line("x", 3.0, 4.0)], duration=2.0)))
    eq("行级 LRC 只查起点不查 end",
       subtitles.build_lrc(payload([line("x", 1.5, 2.5)], duration=2.0)), "[00:01.50]x\n")


def test_names() -> None:
    class Job:
        work_name = "晚风/轻轻"
        version_label = ""
        version_tag = "改谱 2"
        title = "旧标题"
        request = {"lyrics": "[Verse]\n晚风"}

    name = subtitles.download_name(Job(), "song_1", "srt")
    eq("文件名带作品名与版本", name, "晚风 轻轻 · 改谱 2 - song_1.srt")
    eq("无任务时用 yue2 兜底", subtitles.download_name(None, "song_2", "lrc"), "yue2 - song_2.lrc")
    eq("逐字 LRC 文件名带逐字",
       subtitles.download_name(Job(), "song_1", "lrc", enhanced=True),
       "晚风 轻轻 · 改谱 2 - song_1 (逐字).lrc")
    eq("行级 LRC 文件名不带逐字",
       subtitles.download_name(Job(), "song_1", "lrc"), "晚风 轻轻 · 改谱 2 - song_1.lrc")
    eq("SRT 文件名忽略逐字",
       subtitles.download_name(Job(), "song_1", "srt", enhanced=True),
       "晚风 轻轻 · 改谱 2 - song_1.srt")
    header = subtitles.content_disposition(name)
    check("Content-Disposition 有 ASCII 兜底", 'filename="' in header and "song_1.srt" in header, header)
    check("Content-Disposition 带 UTF-8 名称", "filename*=UTF-8''" in header, header)
    encoded = header.split("filename*=UTF-8''", 1)[1]
    eq("UTF-8 文件名可还原", unquote(encoded), name)
    long_name = subtitles.download_name(Job(), "x" * 10, "lrc")
    check("文件名不会过长", len(long_name) < 80, str(len(long_name)))

    class Dots:
        work_name = " .晚风. "
        version_label = ""
        version_tag = ""
        title = ""
        request = {}

    eq("文件名去掉首尾点与空格", subtitles.download_name(Dots(), "song_1", "srt"),
       "晚风 - song_1.srt")

    class AllDots(Dots):
        work_name = "..."

    eq("全是点时用兜底名", subtitles.download_name(AllDots(), "song_1", "lrc"), "yue2 - song_1.lrc")


def parse_srt(text: str):
    # 只去掉结尾那一个换行：strip() 会把最后一条字幕的尾部空格也吃掉
    flat = text.replace("\r\n", "\n")
    if flat.endswith("\n"):
        flat = flat[:-1]
    blocks = flat.split("\n\n")
    cues = []
    for block in blocks:
        rows = block.split("\n")
        if len(rows) < 3:
            raise AssertionError(f"SRT 块不完整：{block!r}")
        cues.append((int(rows[0]), rows[1], "\n".join(rows[2:])))
    return cues


def srt_seconds(stamp: str) -> float:
    match = re.match(r"^(\d+):(\d{2}):(\d{2}),(\d{3})$", stamp)
    if not match:
        raise AssertionError(f"SRT 时间格式错：{stamp}")
    hours, minutes, seconds, millis = (int(part) for part in match.groups())
    return hours * 3600 + minutes * 60 + seconds + millis / 1000


def lrc_seconds(hours_minutes: str, seconds: str, centis: str) -> float:
    return int(hours_minutes) * 60 + int(seconds) + int(centis) / 100


def verify_real(path: Path) -> None:
    label = path.parent.parent.parent.name
    data = json.loads(path.read_text(encoding="utf-8"))
    items = [item for item in data["lines"] if str(item.get("text") or "").strip()]
    expected = [str(item.get("text") or "") for item in items]
    duration = data.get("audio_seconds")

    srt = subtitles.build_srt(data)
    cues = parse_srt(srt)
    check(f"{label}: SRT 条数", len(cues) == len(expected), f"{len(cues)} != {len(expected)}")
    check(f"{label}: SRT 编号连续", [cue[0] for cue in cues] == list(range(1, len(cues) + 1)))
    check(f"{label}: SRT 文本顺序一致", [cue[2] for cue in cues] == expected)
    expected_starts = [subtitles.srt_timestamp(float(item["start"])) for item in items]
    expected_ends = []
    for index, item in enumerate(items):
        end = float(item["end"])
        if index + 1 < len(items):
            end = min(end, float(items[index + 1]["start"]))
        if duration:
            end = min(end, float(duration))
        expected_ends.append(subtitles.srt_timestamp(end))
    check(f"{label}: SRT 起点对应时间轴", [cue[1].split(" --> ")[0] for cue in cues] == expected_starts)
    check(f"{label}: SRT 终点对应时间轴", [cue[1].split(" --> ")[1] for cue in cues] == expected_ends)
    times = []
    for stamp in (part for cue in cues for part in re.split(r" --> ", cue[1])):
        check(f"{label}: SRT 时间格式 {stamp}", bool(SRT_TIME.match(stamp)))
        times.append(srt_seconds(stamp))
    starts = times[0::2]
    ends = times[1::2]
    check(f"{label}: SRT 每条 end > start", all(end > start for start, end in zip(starts, ends)))
    check(f"{label}: SRT 起点递增", all(a < b for a, b in zip(starts, starts[1:])))
    check(f"{label}: SRT 终点不倒退", all(a <= b for a, b in zip(ends, ends[1:])))
    if duration:
        check(f"{label}: SRT 不越过音频", max(ends) <= float(duration) + 0.001,
              f"{max(ends)} > {duration}")
    check(f"{label}: SRT 全是 CRLF", "\n" not in srt.replace("\r\n", ""))

    lrc = subtitles.build_lrc(data)
    rows = lrc.strip("\n").split("\n")
    check(f"{label}: LRC 行数", len(rows) == len(expected), f"{len(rows)} != {len(expected)}")
    texts, starts = [], []
    for row in rows:
        match = LRC_TIME.match(row)
        check(f"{label}: LRC 行格式 {row[:24]!r}", bool(match))
        if not match:
            continue
        starts.append(lrc_seconds(match.group(1), match.group(2), match.group(3)))
        texts.append(row[match.end():])
    check(f"{label}: LRC 文本顺序一致", texts == expected)
    check(f"{label}: LRC 起点对应时间轴",
          len(starts) == len(items)
          and all(abs(value - float(item["start"])) <= 0.0051 for value, item in zip(starts, items)))
    check(f"{label}: LRC 起点递增", all(a < b for a, b in zip(starts, starts[1:])))
    check(f"{label}: LRC 无 CR", "\r" not in lrc)

    enhanced = subtitles.build_lrc(data, enhanced=True)
    rows = enhanced.strip("\n").split("\n")
    check(f"{label}: 逐字 LRC 行数", len(rows) == len(expected), f"{len(rows)} != {len(expected)}")
    for index, row in enumerate(rows):
        head = LRC_TIME.match(row)
        check(f"{label}: 逐字第 {index + 1} 行有行标签", bool(head), row[:32])
        if not head:
            continue
        tags = WORD_TAG.findall(row)
        check(f"{label}: 逐字第 {index + 1} 行有标签", bool(tags), row[:32])
        check(f"{label}: 逐字第 {index + 1} 行以标签收尾", bool(re.search(r"<[^>]+>$", row)), row[-24:])
        tag_times = [lrc_seconds(*tag) for tag in tags]
        check(f"{label}: 逐字第 {index + 1} 行标签递增",
              all(a <= b for a, b in zip(tag_times, tag_times[1:])), str(tag_times))
        body = re.sub(r"<[^>]+>", "", row[head.end():])
        check(f"{label}: 逐字第 {index + 1} 行不漏字且空格不变",
              body == expected[index], f"{body!r} != {expected[index]!r}")


def verify_legacy_entry() -> None:
    """The legacy route stays available only as a clearly labelled comparison page."""
    static = ROOT / "app" / "static"
    legacy = (static / "index.legacy.html").read_text(encoding="utf-8")
    current = (static / "index.html").read_text(encoding="utf-8")
    check("旧版页面存在且有内容", len(legacy.strip()) > 200)
    check("旧版页面有明确旧版标识", 'class="legacy-banner"' in legacy and "旧版对照页" in legacy)
    check("旧版页面提供返回新版入口", 'href="/"' in legacy)
    check("新版页面不链接旧版入口", 'href="/legacy"' not in current)
    routes = [getattr(item, "path", None) for item in server_module.app.routes]
    check("服务器注册新版与旧版路由", "/" in routes and "/legacy" in routes)


def main() -> int:
    test_boundaries()
    test_rounding()
    test_errors()
    test_names()
    verify_legacy_entry()

    files = sorted(Path(p) for p in glob.glob(str(ROOT / "runs" / "jobs" / "*" / "out" / "*" / "lyrics.json")))
    print(f"真实时间轴 {len(files)} 份")
    for path in files:
        verify_real(path)

    failed = [item for item in RESULTS if not item[1]]
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} 项通过")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
