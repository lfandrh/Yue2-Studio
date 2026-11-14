"""Pure job text rules extracted from app/server.py; no service or model required."""
from __future__ import annotations

import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app import jobs_text

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(ok), detail))


def eq(name: str, actual, expected) -> None:
    check(name, actual == expected, f"actual={actual!r} expected={expected!r}")


def main() -> int:
    eq("空标题保持空串", jobs_text.clean_title(None), "")
    eq("标题去首尾空白", jobs_text.clean_title("  晚风  "), "晚风")
    try:
        jobs_text.clean_title(123)
    except ValueError as exc:
        eq("非文本标题给出原因", str(exc), "标题必须是文本")
    else:
        check("非文本标题应失败", False, "未抛 ValueError")
    try:
        jobs_text.clean_title("x" * 201)
    except ValueError as exc:
        eq("超长标题给出原因", str(exc), "标题最多 200 个字")
    else:
        check("超长标题应失败", False, "未抛 ValueError")

    eq("歌词首句跳过段落标记", jobs_text.lyric_head("[Verse]\n晚风轻轻吹过窗前\n第二行"),
       "晚风轻轻吹过窗前")
    eq("歌词首句最多 14 字", jobs_text.lyric_head("一二三四五六七八九十一二三四五六"),
       "一二三四五六七八九十一二三四")
    eq("无歌词首行为空", jobs_text.lyric_head(""), "")
    eq("篇幅按中文和英文词折算", jobs_text.lyric_units("[Verse]\n晚风 hello world"),
       4.8)

    source = {"requested": {"lyrics": "源歌词"}}
    eq("派生任务无快照回退源歌词",
       jobs_text.effective_lyrics("redecode", {"lyrics": ""}, None, lambda: source), "源歌词")
    eq("派生任务优先使用请求歌词",
       jobs_text.effective_lyrics("staged", {"lyrics": "本任务歌词"}, None, lambda: source),
       "本任务歌词")
    eq("派生任务优先读取有效快照",
       jobs_text.effective_lyrics("redecode", {"lyrics": ""}, {"lyrics": "快照歌词"},
                                  lambda: source), "快照歌词")
    eq("普通任务不读取派生快照",
       jobs_text.effective_lyrics("song", {"lyrics": "自身歌词"}, {"lyrics": "快照歌词"},
                                  lambda: source), "自身歌词")

    failed = [item for item in RESULTS if not item[1]]
    for name, ok, detail in failed:
        print(f"FAIL {name} -> {detail}")
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} 项通过")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
