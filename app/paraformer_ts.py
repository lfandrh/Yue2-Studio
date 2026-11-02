"""Paraformer with native token timestamps (4-output int8 ONNX, onnxruntime).

The sherpa export only carries logits, so timing had to be inferred from window
positions. This export also returns the CIF peaks (``us_cif_peak``) that FunASR
itself uses to place words, so each token gets the model's own start/end time.
Features follow funasr-onnx's frontend: kaldi fbank (80 mel) -> LFR 7/6 -> CMVN.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path

import numpy as np

DIR = Path(__file__).resolve().parents[1] / "YuE" / "models" / "paraformer-zh-en-ts"
MODEL = DIR / "model.int8.onnx"
TOKENS = DIR / "tokens.txt"
CMVN = DIR / "am.mvn"
CONFIG = DIR / "asr.json"

log = logging.getLogger("yue2.paraformer")
RATE = 16000
_LOCK = threading.Lock()
_ENGINE: "_Engine | None" = None
_WARNED_TIMING = False


def ready() -> bool:
    return MODEL.exists() and TOKENS.exists() and CMVN.exists()


def decode(samples: np.ndarray) -> list[tuple[str, float, float]]:
    """Tokens with times in seconds relative to ``samples`` (float32, 16 kHz)."""
    return _engine().decode(samples)


def _engine() -> "_Engine":
    global _ENGINE
    with _LOCK:
        if _ENGINE is None:
            _ENGINE = _Engine()
        return _ENGINE


def _read_tokens(path: Path) -> list[str]:
    return [line.rstrip("\r\n") for line in path.read_text(encoding="utf-8").splitlines()]


def _read_cmvn(path: Path) -> np.ndarray:
    lines = path.read_text(encoding="utf-8").splitlines()
    means, scales = [], []
    for index, line in enumerate(lines):
        field = line.split()
        if not field:
            continue
        nxt = lines[index + 1].split() if index + 1 < len(lines) else []
        if field[0] == "<AddShift>" and nxt[:1] == ["<LearnRateCoef>"]:
            means = nxt[3:-1]
        elif field[0] == "<Rescale>" and nxt[:1] == ["<LearnRateCoef>"]:
            scales = nxt[3:-1]
    if not means or not scales:
        raise RuntimeError(f"CMVN 文件无法解析：{path}")
    return np.array([np.array(means, dtype=np.float64), np.array(scales, dtype=np.float64)])


def _timestamps(peaks: np.ndarray, tokens: list[str]) -> list[tuple[float, float] | None]:
    """FunASR's ts_prediction_lfr6 (MIT, alibaba-damo-academy/FunASR).

    Peak frames sit on the 60 ms LFR grid; -1.5 frames cancels the model lookahead.
    A token fired on a long stretch of lead-in audio (music, breathing) is dropped:
    its peak lands on the window edge and it drags the whole line one token early.
    """
    start_threshold = 5
    max_duration = 30
    lead_in = 50
    rate = 10.0 * 6 / 1000 / 3
    peak = peaks.reshape(-1)
    frames = peak.shape[-1]
    fire = np.where(peak > 1.0 - 1e-4)[0] - 1.5
    if len(fire) != len(tokens) + 1:
        raise RuntimeError(f"峰值与字不匹配：{len(fire)} / {len(tokens)}")
    stamps: list[tuple[float, float] | None] = []
    for index in range(len(fire) - 1):
        span = fire[index + 1] - fire[index]
        if index == 0 and span > lead_in:
            stamps.append(None)
        elif span < max_duration:
            stamps.append((fire[index] * rate, fire[index + 1] * rate))
        else:
            stamps.append((fire[index] * rate, (fire[index] + max_duration) * rate))
    if not stamps:
        return stamps
    if frames - fire[-1] > start_threshold and stamps[-1] is not None:
        end = (frames + fire[-1]) / 2
        stamps[-1] = (stamps[-1][0], end * rate)
    elif stamps[-1] is not None:
        stamps[-1] = (stamps[-1][0], frames * rate)
    return stamps


class _Engine:
    def __init__(self) -> None:
        import onnxruntime as ort

        config = json.loads(CONFIG.read_text(encoding="utf-8"))["frontend_conf"]
        self.tokens = _read_tokens(TOKENS)
        self.cmvn = _read_cmvn(CMVN)
        self.n_mels = int(config.get("n_mels", 80))
        self.frame_length = float(config.get("frame_length", 25))
        self.frame_shift = float(config.get("frame_shift", 10))
        self.window = str(config.get("window", "hamming"))
        self.lfr_m = int(config.get("lfr_m", 7))
        self.lfr_n = int(config.get("lfr_n", 6))
        options = ort.SessionOptions()
        options.intra_op_num_threads = max(1, min(8, (os.cpu_count() or 4) - 2))
        self.session = ort.InferenceSession(str(MODEL), sess_options=options,
                                            providers=["CPUExecutionProvider"])

    def _fbank(self, samples: np.ndarray) -> np.ndarray:
        import kaldi_native_fbank as knf

        opts = knf.FbankOptions()
        opts.frame_opts.samp_freq = RATE
        opts.frame_opts.dither = 0.0
        opts.frame_opts.window_type = self.window
        opts.frame_opts.frame_shift_ms = self.frame_shift
        opts.frame_opts.frame_length_ms = self.frame_length
        opts.mel_opts.num_bins = self.n_mels
        opts.energy_floor = 0
        opts.frame_opts.snip_edges = True
        fn = knf.OnlineFbank(opts)
        fn.accept_waveform(RATE, (samples * (1 << 15)).tolist())
        frames = fn.num_frames_ready
        mat = np.empty([frames, self.n_mels], dtype=np.float32)
        for i in range(frames):
            mat[i] = fn.get_frame(i)
        return mat

    def _lfr(self, feat: np.ndarray) -> np.ndarray:
        count = int(np.ceil(feat.shape[0] / self.lfr_n))
        pad = np.tile(feat[0], ((self.lfr_m - 1) // 2, 1))
        feat = np.vstack((pad, feat))
        total = feat.shape[0]
        rows = []
        for i in range(count):
            if self.lfr_m <= total - i * self.lfr_n:
                rows.append(feat[i * self.lfr_n:i * self.lfr_n + self.lfr_m].reshape(1, -1))
            else:
                frame = feat[i * self.lfr_n:].reshape(-1)
                for _ in range(self.lfr_m - (total - i * self.lfr_n)):
                    frame = np.hstack((frame, feat[-1]))
                rows.append(frame)
        return np.vstack(rows).astype(np.float32)

    def _apply_cmvn(self, feat: np.ndarray) -> np.ndarray:
        dim = feat.shape[1]
        means = np.tile(self.cmvn[0:1, :dim], (feat.shape[0], 1))
        scales = np.tile(self.cmvn[1:2, :dim], (feat.shape[0], 1))
        return ((feat + means) * scales).astype(np.float32)

    def decode(self, samples: np.ndarray) -> list[tuple[str, float, float]]:
        if samples.size < int(0.3 * RATE):
            return []
        feat = self._apply_cmvn(self._lfr(self._fbank(samples)))
        logits, counts, _alphas, peaks = self.session.run(
            None, {"speech": feat[None], "speech_lengths": np.array([feat.shape[0]], np.int32)})
        ids = logits[0].argmax(axis=-1)[:int(counts[0])].tolist()
        texts = [self.tokens[i] for i in ids]
        while texts and texts[-1] in ("</s>", "<s>", "<blank>"):
            texts.pop()
        try:
            stamps = _timestamps(peaks[0], list(texts))
        except (RuntimeError, IndexError) as exc:
            global _WARNED_TIMING
            if not _WARNED_TIMING:
                _WARNED_TIMING = True
                log.warning("词级时间戳提取失败，该窗口退回均匀分布：%s: %s",
                            type(exc).__name__, exc)
            return []
        out = []
        for text, stamp in zip(texts, stamps):
            if stamp is None or text in ("<blank>", "<s>", "<unk>"):
                continue
            out.append((text, stamp[0], stamp[1]))
        return out
