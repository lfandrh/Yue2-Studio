"""Structured (time, pitch) view of the native two-voice ABC dialect, and safe rewrites.

Parsing stays with the official skill script; this module maps its model onto
roll coordinates and edits single tokens so the rest of the file stays identical.
Every rewrite is re-parsed and compared note-by-note with the intended model,
so a rejected edit can never leave a half-changed score behind.
"""
from __future__ import annotations

import re
from fractions import Fraction

from . import score_tools

VOICES = ("Vocal", "Ins")
VOICE_LABELS = {"Vocal": "人声旋律", "Ins": "伴奏"}
DURATIONS = (48, 32, 24, 16, 12, 8, 6, 4, 3, 2, 1)
ACCIDENTALS = {"=": 0, "_": -1, "__": -2, "^": 1, "^^": 2}
REVERSE = ((0, "C", 0), (1, "C", 1), (2, "D", 0), (3, "D", 1), (4, "E", 0), (5, "F", 0),
           (6, "F", 1), (7, "G", 0), (8, "G", 1), (9, "A", 0), (10, "A", 1), (11, "B", 0))
NATURAL = dict(zip("CDEFGAB", (0, 2, 4, 5, 7, 9, 11)))


class EditError(ValueError):
    """The requested change cannot be expressed without touching other notes."""


def _op_int(op: dict, key: str) -> int:
    """User-supplied integer field; a missing or null value is a request error, not a 500."""
    try:
        return int(op[key])
    except (KeyError, TypeError, ValueError) as exc:
        raise EditError(f"参数 {key} 缺失或不是整数") from exc


def _tools():
    score_tools._ensure()
    return score_tools._abc_tools


def _split_units(units: int) -> list:
    parts = []
    left = units
    for size in DURATIONS:
        while left >= size:
            parts.append(size)
            left -= size
    if left:
        raise EditError("这个时长没法用官方记法拼出来")
    return parts


def _rest_text(units: int) -> str:
    return "".join(f"z{size}" for size in _split_units(units)) if units else ""


def _pitch_token(pitch: int, units: int, key_acc: dict, tie: bool) -> str:
    pcs = pitch % 12
    _, letter, alter = next(item for item in REVERSE if item[0] == pcs)
    base = pitch - alter
    steps = (base - 60 - NATURAL[letter]) // 12
    if steps > 0:
        body = letter.lower() + "'" * (steps - 1)
    elif steps < 0:
        body = letter + "," * (-steps)
    else:
        body = letter
    if alter > 0:
        acc = "^" * alter
    elif alter < 0:
        acc = "_" * (-alter)
    else:
        acc = "="
    return f"{acc}{body}{units}{'-' if tie else ''}"


def _structure(lines: list) -> list:
    groups = []
    pending = None
    pending_line = None
    cursor = 8
    while cursor < len(lines):
        while cursor < len(lines) and lines[cursor].startswith("% "):
            pending = lines[cursor][2:].strip()
            pending_line = cursor
            cursor += 1
        if cursor >= len(lines):
            break
        group = {"section": pending, "section_line": pending_line,
                 "from_line": pending_line if pending_line is not None else cursor,
                 "voices": {}}
        pending = pending_line = None
        for name in VOICES:
            if cursor >= len(lines) or lines[cursor] != f"V: {name}":
                raise EditError("谱面不是官方原生两行写法，暂不支持可视化")
            cursor += 1
            fields = []
            while cursor < len(lines) and lines[cursor].startswith(("M:", "K:")):
                field, value = lines[cursor].split(":", 1)
                fields.append((field, value))
                cursor += 1
            if cursor >= len(lines):
                raise EditError("谱面结构不完整，暂不支持可视化")
            group["voices"][name] = {"line": cursor, "music": lines[cursor], "fields": fields}
            cursor += 1
        group["to_line"] = cursor
        groups.append(group)
    return groups


def _bar_bodies(line: str) -> list:
    bodies = []
    start = 0
    for index, char in enumerate(line):
        if char == "|":
            bodies.append((start, index, line[start:index]))
            start = index + 1
    if line[start:].strip():
        raise EditError("谱面行尾不是标准小节线，暂不支持可视化")
    return bodies


def _scan_voice(bodies: list, line_index: int, unit: Fraction, meter: tuple, key: str,
                state: dict) -> None:
    token_re = _tools().TOKEN
    n, d = meter
    length = Fraction(4 * n, d)
    key_acc = _tools().key_accidentals(key)
    notes, rests, chords = state["notes"], state["rests"], state["chords"]
    time, bar, pending = state["time"], state["bar"], state["pending"]
    for bar_start, _, body in bodies:
        full = re.fullmatch(r"\s*Z([2-4]?)\s*", body)
        if full:
            if pending is not None:
                raise EditError("连音线接进了整小节休止，暂不支持可视化")
            count = int(full.group(1) or "1")
            for _ in range(count):
                state["bars"].append({"start": time, "dur": length})
                time += length
                bar += 1
            continue
        local = {}
        offset = Fraction(0)
        cursor = 0
        while cursor < len(body):
            if body[cursor].isspace():
                cursor += 1
                continue
            match = token_re.match(body, cursor)
            if match is None:
                raise EditError(f"第 {bar + 1} 小节有暂不支持的写法")
            begin, end = cursor, match.end()
            cursor = match.end()
            chord, key_field = match.group("chord", "key")
            if key_field is not None:
                raise EditError("谱面中途转调，暂不支持可视化")
            if chord is not None:
                chords.append({"start": time + offset, "bar": bar, "name": chord})
                continue
            note, acc, octave, units, tie = match.group("note", "acc", "oct", "duration", "tie")
            size = int(units or "1")
            duration = size * unit * 4
            span = (line_index, bar_start + begin, bar_start + end)
            if note == "z":
                if pending is not None:
                    raise EditError("连音线接进了休止符，暂不支持可视化")
                rests.append({"start": time + offset, "dur": duration, "units": size,
                              "bar": bar, "span": span})
                offset += duration
                continue
            letter = note.upper()
            written = 60 + NATURAL[letter] + (12 if note.islower() else 0)
            written += 12 * (octave.count("'") - octave.count(","))
            alteration = local.get(letter, key_acc.get(letter, 0))
            if acc:
                alteration = ACCIDENTALS[acc]
                local[letter] = alteration
            pitch = written + alteration
            if pending is not None:
                held = notes[pending]
                if not acc and written == held["written"]:
                    pitch = held["pitch"]
                if pitch != held["pitch"]:
                    raise EditError("连音线写法不标准，暂不支持可视化")
                held["dur"] += duration
                held["spans"].append(span)
                pending = pending if tie else None
            else:
                notes.append({"start": time + offset, "dur": duration, "pitch": pitch,
                              "written": written, "bar": bar, "spans": [span],
                              "key_acc": key_acc})
                pending = len(notes) - 1 if tie else None
            offset += duration
        if offset != length:
            raise EditError(f"第 {bar + 1} 小节时值不等于拍号，暂不支持可视化")
        state["bars"].append({"start": time, "dur": length})
        time += length
        bar += 1
    state.update({"time": time, "bar": bar, "pending": pending})


def _measure(text: str) -> dict:
    lines = text.splitlines()
    score = _tools().parse_abc(text)
    groups = _structure(lines)
    unit = Fraction(1, int(re.fullmatch(r"L:1/([0-9]+)", lines[3]).group(1)))
    meter = _tools().meter_value(lines[2][2:])
    key = lines[7][2:]
    scans = {name: {"notes": [], "rests": [], "chords": [], "bars": [],
                    "time": Fraction(0), "bar": 0, "pending": None,
                    "meter": meter, "key": key} for name in VOICES}
    sections = []
    for group in groups:
        start_bar = scans[VOICES[0]]["bar"]
        for name in VOICES:
            state = scans[name]
            for field, value in group["voices"][name]["fields"]:
                if field == "M":
                    state["meter"] = _tools().meter_value(value)
                else:
                    _tools().key_accidentals(value)
                    state["key"] = value
            _scan_voice(_bar_bodies(group["voices"][name]["music"]),
                        group["voices"][name]["line"], unit, state["meter"], state["key"], state)
        end_bar = scans[VOICES[0]]["bar"]
        label = group["section"] or (sections[-1]["name"] if sections else "未命名段落")
        if sections and group["section_line"] is None:
            sections[-1]["to_bar"] = end_bar
            sections[-1]["to_line"] = group["to_line"]
        else:
            sections.append({"name": label, "from_bar": start_bar, "to_bar": end_bar,
                             "from_line": group["from_line"], "to_line": group["to_line"]})
    scale = int(1 / unit / 4)
    for name in VOICES:
        scan, official = scans[name], score.voices[name]
        mine = [(note["start"], note["pitch"], note["dur"]) for note in scan["notes"]]
        theirs = [(Fraction(item[0]), int(item[1]), Fraction(item[2])) for item in official.notes]
        if mine != theirs:
            raise EditError("谱面的连音线等写法可视化不支持，请用文本模式")
        if [(item["start"], item["name"]) for item in scan["chords"]] != \
                [(Fraction(t), c) for t, c in official.chords]:
            raise EditError("谱面的和弦位置可视化不支持，请用文本模式")
        if [(int(b["start"] * scale), int(b["dur"] * scale)) for b in scan["bars"]] != \
                [(int(Fraction(b[0]) * scale), int(Fraction(b[1]) * scale)) for b in official.bars]:
            raise EditError("谱面小节网格和官方解析不一致，请用文本模式")
        for note in scan["notes"]:
            note["tie"] = len(note["spans"]) > 1
    return {"score": score, "groups": groups, "scans": scans, "sections": sections,
            "unit": unit, "meter": meter, "key": key, "lines": lines,
            "bars": scans[VOICES[0]]["bar"], "scale": scale, "trailing": text.endswith("\n")}


def _plan(structure: dict) -> dict:
    scale = structure["scale"]
    n, d = structure["meter"]
    voices = []
    pitches = []
    for name in VOICES:
        scan = structure["scans"][name]
        notes = []
        for index, note in enumerate(scan["notes"]):
            notes.append({"i": index, "start": int(note["start"] * scale),
                          "dur": int(note["dur"] * scale), "pitch": note["pitch"],
                          "bar": note["bar"], "tie": note["tie"]})
            pitches.append(note["pitch"])
        voices.append({"name": name, "label": VOICE_LABELS[name], "notes": notes,
                       "chords": [{"start": int(item["start"] * scale), "bar": item["bar"],
                                   "name": item["name"]} for item in scan["chords"]]})
    bars = [{"start": int(item["start"] * scale), "dur": int(item["dur"] * scale)}
            for item in structure["scans"][VOICES[0]]["bars"]]
    return {"bpm": structure["score"].bpm, "meter": f"{n}/{d}", "key": structure["key"],
            "unit": int(1 / structure["unit"]), "bars": bars, "bars_total": len(bars),
            "sections": [{"name": item["name"], "from_bar": item["from_bar"],
                          "to_bar": item["to_bar"]} for item in structure["sections"]],
            "voices": voices,
            "pitch_min": min(pitches) if pitches else 60,
            "pitch_max": max(pitches) if pitches else 72,
            "notes_total": len(pitches)}


def plan(abc: str) -> dict:
    return _plan(_measure(abc))


def _rewrite_note(structure: dict, note: dict, pitch: int, edits: list) -> None:
    for span in note["spans"]:
        line_index, start, end = span
        match = _tools().TOKEN.fullmatch(structure["lines"][line_index][start:end])
        units = int(match.group("duration") or "1")
        tie = bool(match.group("tie"))
        edits.append((line_index, start, end, _pitch_token(pitch, units, note["key_acc"], tie)))


def _retime(piece: str, units: int) -> str:
    match = re.fullmatch(r"(.*?)([0-9]*)(-?)", piece)
    return f"{match.group(1)}{'' if units == 1 else units}{match.group(3)}"


def _resize(structure: dict, name: str, note: dict, delta: int, edits: list) -> None:
    line_index, start, end = note["spans"][0]
    unit = int(_tools().TOKEN.fullmatch(structure["lines"][line_index][start:end])
               .group("duration") or "1")
    new_piece = _retime(structure["lines"][line_index][start:end], unit + delta)
    if delta < 0:
        edits.append((line_index, start, end, f"{new_piece}{_rest_text(-delta)}"))
        return
    edits.append((line_index, start, end, new_piece))
    rests = [rest for rest in structure["scans"][name]["rests"] if rest["bar"] == note["bar"]]
    after = [rest for rest in rests if rest["start"] == note["start"] + note["dur"]]
    if not after:
        raise EditError("这个音后面紧跟着另一个音，拉长会挤掉它；先删掉后面那个音，或者往后挪")
    rest = after[0]
    if rest["units"] < delta:
        raise EditError("后面的休止符不够长，拉不到这么长")
    rline, rstart, rend = rest["span"]
    edits.append((rline, rstart, rend, _rest_text(rest["units"] - delta)))


def _expected(structure: dict, ops: list) -> dict:
    scale = structure["scale"]
    model = {}
    for name in VOICES:
        model[name] = [[int(note["start"] * scale), int(note["dur"] * scale), note["pitch"]]
                       for note in structure["scans"][name]["notes"]]
    for op in ops:
        kind = op.get("kind")
        if kind == "pitch":
            model[op["voice"]][int(op["i"])][2] = int(op["pitch"])
        elif kind == "remove":
            model[op["voice"]].pop(int(op["i"]))
        elif kind == "resize":
            model[op["voice"]][int(op["i"])][1] = int(op["dur"])
        elif kind == "transpose":
            for name in VOICES:
                for note in model[name]:
                    note[2] += int(op["semitones"])
    for name in VOICES:
        for note in model[name]:
            if not 0 <= note[2] <= 127:
                raise EditError("移调后超出音域范围")
    return model


def _apply_replacements(lines: list, edits: list, trailing: bool) -> str:
    by_line = {}
    for line_index, start, end, text in edits:
        by_line.setdefault(line_index, []).append((start, end, text))
    for line_index, items in by_line.items():
        line = lines[line_index]
        for start, end, text in sorted(items, key=lambda item: item[0], reverse=True):
            line = line[:start] + text + line[end:]
        lines[line_index] = line
    return "\n".join(lines) + ("\n" if trailing else "")


def _pin_accidentals(text: str, fresh: dict, expected: dict) -> tuple:
    """Write explicit accidentals where an edit would otherwise leak into the rest of the bar."""
    for _ in range(6):
        scale = fresh["scale"]
        wrong = []
        for name in VOICES:
            for index, note in enumerate(fresh["scans"][name]["notes"]):
                if index >= len(expected[name]):
                    raise EditError("改完音符数对不上，请用文本模式改")
                if note["pitch"] != expected[name][index][2]:
                    wrong.append((name, note, expected[name][index][2]))
        if not wrong:
            return text, fresh
        edits = []
        for name, note, pitch in wrong:
            _rewrite_note(fresh, note, pitch, edits)
        text = _apply_replacements(list(fresh["lines"]), edits, fresh["trailing"])
        fresh = _measure(text)
    return text, fresh


def apply(abc: str, ops: list) -> dict:
    if not isinstance(ops, list) or not ops:
        raise EditError("没有要改的内容")
    structure = _measure(abc)
    lines = list(structure["lines"])
    edits = []
    applied = []
    structural = False
    for op in ops:
        kind = op.get("kind")
        if kind in ("pitch", "remove", "resize"):
            name = op.get("voice")
            if name not in VOICES:
                raise EditError("声部不对")
            notes = structure["scans"][name]["notes"]
            index = int(op.get("i", -1))
            if not 0 <= index < len(notes):
                raise EditError("这个音已经不在谱上了，刷新一下")
            note = notes[index]
            line_index, start, end = note["spans"][0]
            units = int(_tools().TOKEN.fullmatch(lines[line_index][start:end]).group("duration") or "1")
            where = f"{VOICE_LABELS[name]}第 {note['bar'] + 1} 小节"
            if kind == "pitch":
                target = _op_int(op, "pitch")
                if not 0 <= target <= 127:
                    raise EditError("音高超出范围")
                _rewrite_note(structure, note, target, edits)
                applied.append(f"{where}音高改了")
            elif kind == "remove":
                for span in note["spans"]:
                    line_index, start, end = span
                    piece = _tools().TOKEN.fullmatch(lines[line_index][start:end])
                    edits.append((line_index, start, end,
                                  f"z{int(piece.group('duration') or '1')}"))
                applied.append(f"{where}删掉一个音")
            else:
                if note["tie"]:
                    raise EditError("这个音跨了小节（连音线），改不了音长，可用文本模式")
                target = _op_int(op, "dur")
                if target not in DURATIONS:
                    raise EditError("时长只能是 1/32 的 1、2、3、4、6、8、12、16、24、32、48 倍")
                if target == units:
                    raise EditError("时长没有变化")
                _resize(structure, name, note, target - units, edits)
                applied.append(f"{where}的音长改了")
        elif kind == "transpose":
            step = _op_int(op, "semitones")
            if not -24 <= step <= 24:
                raise EditError("移调范围是正负 24 个半音")
            for name in VOICES:
                for note in structure["scans"][name]["notes"]:
                    _rewrite_note(structure, note, note["pitch"] + step, edits)
            applied.append(f"整曲移调 {step:+d} 个半音")
        elif kind == "tempo":
            bpm = _op_int(op, "bpm")
            if not 20 <= bpm <= 300:
                raise EditError("速度要在 20–300 BPM 之间")
            lines[4] = f"Q:1/4={bpm}"
            applied.append(f"速度改为 {bpm} BPM")
        elif kind in ("drop_section", "duplicate_section"):
            index = int(op.get("section", -1))
            sections = structure["sections"]
            if not 0 <= index < len(sections):
                raise EditError("没有这个段落")
            begin = sections[index]["from_line"]
            stop = sections[index + 1]["from_line"] if index + 1 < len(sections) else len(lines)
            if kind == "drop_section":
                if len(sections) == 1:
                    raise EditError("只剩一个段落，删掉谱就空了")
                del lines[begin:stop]
                applied.append(f"删掉段落「{sections[index]['name']}」")
            else:
                lines[stop:stop] = lines[begin:stop]
                applied.append(f"复制段落「{sections[index]['name']}」")
            structural = True
        else:
            raise EditError("不认识的改动")
    text = _apply_replacements(lines, edits, structure["trailing"])
    fresh = _measure(text)
    if structural:
        return {"abc": text, "plan": _plan(fresh), "applied": applied}
    expected = _expected(structure, ops)
    text, fresh = _pin_accidentals(text, fresh, expected)
    for name in VOICES:
        actual = [[int(note["start"] * fresh["scale"]), int(note["dur"] * fresh["scale"]),
                   note["pitch"]] for note in fresh["scans"][name]["notes"]]
        if actual != expected[name]:
            raise EditError(f"{VOICE_LABELS[name]}改完和预期不一致（升降号会牵连同小节同名的音），"
                            "这条改动没写入，请用文本模式改")
    return {"abc": text, "plan": _plan(fresh), "applied": applied}
