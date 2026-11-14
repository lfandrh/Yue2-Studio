"""歌词对齐关键逻辑的合成用例（不加载任何 ASR 模型）。

运行：
    python tools/verify-align-logic.py
覆盖：
- 重复副歌不会把锚点跳到第二次出现的位置（窗口上限）
- 时间戳越界时整段回拉，而不是挤成同一个时间点
- 行/字的结束时间不超过音频时长
- 结尾插值不外推出音频
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app import align  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("" if ok or not detail else f"  -> {detail}"))


def chorus_test() -> None:
    chorus = list("春风又绿江南岸")
    gap = list("夜幕低垂星光闪啊夜色多温柔")
    # 第一遍副歌有一个字被听错，第二遍完全相同：旧窗口会把整窗锚到第二遍。
    normed = list("春风又绿江北岸") + gap + chorus
    cursor = 4  # 前一窗已经对上第一遍副歌的前四个字
    heard = list(chorus)
    low, blocks = align._match_window(heard, normed, cursor)
    targets = [low + block.b for block in blocks]
    limit = cursor + len(heard) + 8
    check("重复副歌：窗口内还有候选锚点", bool(blocks), f"blocks={blocks}")
    check("重复副歌：锚点不越过本窗邻域", all(t < limit for t in targets),
          f"targets={targets} limit={limit}")
    after = low + max(block.b + block.size for block in blocks)
    check("重复副歌：cursor 不跳到第二遍副歌", after <= len(chorus) + 1, f"cursor_after={after}")


def short_block() -> None:
    heard = list("看那云卷云舒花明暗")
    normed = list("看那") + list("风吹过山谷") * 3
    total = len(normed)
    _, far = align._pick_blocks(heard, normed, 0, total, 60.0, 0, 0.0,
                                lambda block: 40.0)
    check("短块过滤：远处的2字巧合不成为锚点", not far,
          str([(block.a, block.b, block.size) for block in far]))
    _, near = align._pick_blocks(heard, normed, 0, total, 60.0, 0, 0.0,
                                 lambda block: 3.0)
    check("短块过滤：连续演唱时2字匹配仍可用", bool(near),
          str([(block.a, block.b, block.size) for block in near]))


def implausible_anchor() -> None:
    check("可行性：结尾短匹配没有后续空间时被拒",
          not align._plausible(500, 430, 256.8, 262.36))
    check("可行性：正常锚点通过", align._plausible(500, 470, 252.0, 262.36))
    check("可行性：时长未知时放行", align._plausible(500, 430, 256.8, 0.0))


def far_search() -> None:
    unsung = list("看那云卷云舒花明暗") + list("看那花开花落任平凡")
    heard = list("夜色阑珊酒醒何处杨柳岸")
    normed = list("且由他岁月如流去不返") + unsung + heard
    low, blocks = align._search_far(heard, normed, 0)
    targets = [low + block.b for block in blocks]
    check("远跳搜索：找回被跳过行之后的歌词", any(target >= 18 for target in targets), str(targets))


def reachable_test() -> None:
    check("可达性：短时间内跳过大量歌词被拒",
          not align._reachable(160, 74.0, 80, 72.0))
    check("可达性：间奏后跳到后面的歌词被允许",
          align._reachable(370, 240.0, 300, 221.8))
    check("可达性：时间倒退被拒", not align._reachable(80, 70.0, 80, 72.0))


def finalize_overflow() -> None:
    fixed = align._finalize_starts([10.0, 20.0, 30.0, 40.0, 50.0], 30.0)
    check("越界回拉：全部落在音频内", all(0.0 <= item <= 29.95 for item in fixed), str(fixed))
    check("越界回拉：严格递增", all(a < b for a, b in zip(fixed, fixed[1:])), str(fixed))


def finalize_nonmonotonic() -> None:
    fixed = align._finalize_starts([5.0, 3.0, 4.0], 60.0)
    check("乱序输入：变成严格递增", fixed == [5.0, 5.03, 5.06], str(fixed))
    check("空输入：返回空列表", align._finalize_starts([], 60.0) == [])


def build_bounds() -> None:
    lines = [{"text": "第一句歌词", "units": list("第一句歌词")},
             {"text": "第二句", "units": list("第二句")}]
    starts = align._finalize_starts([1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 3.8, 3.83], 4.0)
    data = align._build(starts, 4.0, lines, "test", 1.0)
    units = [unit for line in data["lines"] for unit in line["units"]]
    check("构建结果：结束时间不越过音频", all(unit["end"] <= 4.0 for unit in units),
          str([unit["end"] for unit in units]))
    check("构建结果：结束晚于开始", all(unit["end"] > unit["start"] for unit in units))
    check("构建结果：行时间取自首尾字",
          data["lines"][0]["start"] == units[0]["start"]
          and data["lines"][-1]["end"] == units[-1]["end"])


def fill_tail() -> None:
    spans = [(1.0, 1.03), None, None]
    align._fill_gaps(spans, 2.0)
    check("尾部插值：不越过音频结尾", spans[-1] is not None and spans[-1][1] <= 2.0,
          str(spans))
    check("尾部插值：保持递增",
          spans[0][0] < spans[1][0] < spans[2][0] and spans[1][1] <= spans[2][0], str(spans))


def duplicate_estimate() -> None:
    bucket: list[float] = []
    align._add_estimate(bucket, 193.9)
    align._add_estimate(bucket, 206.9)
    check("重复副歌：后一遍的估计不覆盖第一次", bucket == [193.9], str(bucket))
    align._add_estimate(bucket, 194.6)
    check("重复副歌：邻窗仍可微调", bucket == [193.9, 194.6], str(bucket))


def fill_wide_gap() -> None:
    spans = [(10.0, 10.03), None, None, None, (30.0, 30.03)]
    align._fill_gaps(spans, 8.0)  # 平均字长被压得很小，整段均分会超出上限
    check("大空档：未唱的字贴着右锚点", spans[1][0] >= 20.0, str(spans))
    check("大空档：填充不越过右锚点",
          spans[3][1] <= 30.0 + 1e-6 and spans[2][1] <= 30.0 + 1e-6, str(spans))


def main() -> int:
    chorus_test()
    short_block()
    implausible_anchor()
    far_search()
    reachable_test()
    finalize_overflow()
    finalize_nonmonotonic()
    build_bounds()
    fill_tail()
    duplicate_estimate()
    fill_wide_gap()
    failed = [name for name, ok, _ in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} 通过")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
