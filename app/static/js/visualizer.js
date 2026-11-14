/* 歌词可视化模块（方案：design/lyrics-demo/INTEGRATION.md · Phase 1-3）
   自包含、零第三方依赖；由 app.js 在「展开歌词 → 沉浸播放」时动态 import，默认零开销。
   · 时间：不依赖 timeupdate 钩子，rAF 自驱动直读 player.currentTime（seek 立即跟随）
   · 卡拉OK：复用服务端对齐的逐字时间轴 lines[].units（与 #lyrNow 同源）
   · 环形：AnalyserNode 真频谱（懒创建；两大坑见 ensureAnalyser 注释），无 WebAudio 时退回合成频谱
   · 黑胶：惯性启停 + 唱臂随曲目进度走针
   · 收起即 destroy：cancel rAF， 不留任何循环；prefers-reduced-motion 全模式降级 */
"use strict";
import {T} from "./i18n.js";
import {readText, writeText} from "./storage.js";

/* 沉浸舞台背景与文字随页面主题（.lyrViz 用 --bg/--text）；
   频谱色带固定取 tokens.css 深色档语义色（深浅底上都可见）：--meter-lo → --accent → --warn → --danger；
   浅色底上柱子亮帽/提亮混色改朝墨色走，避免暖白帽融进浅背景 */
const BAND = [[95, 174, 132], [147, 188, 166], [228, 178, 60], [222, 106, 88]];
const WARM = [242, 239, 230]; // 深色主题下的提亮目标（--text）
const INK = [27, 26, 23];     // 浅色主题下的压暗目标（--text）

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)");
/* 提亮/压暗目标随主题走：深色底朝暖白提，浅色底朝墨色压（柱帽才不会融进背景） */
const glowTarget = () => (document.documentElement.dataset.theme === "light" ? INK : WARM);
const MODE_KEY = "lyrViz.mode";
const BARS = 96;
const HALF = BARS / 2;

const mix = (c1, c2, t) => `rgb(${Math.round(c1[0] + (c2[0] - c1[0]) * t)}, ${Math.round(c1[1] + (c2[1] - c1[1]) * t)}, ${Math.round(c1[2] + (c2[2] - c1[2]) * t)})`;
const rgba = (c, a) => `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a})`;
const pal = (u) => {
  const x = Math.max(0, Math.min(0.999, u)) * (BAND.length - 1);
  const i = Math.floor(x), f = x - i, a = BAND[i], b = BAND[Math.min(BAND.length - 1, i + 1)];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
};
const seedOf = (str) => { let h = 2166136261; for (const c of String(str || "")) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
const rand = (i) => { const r = Math.sin(i * 127.1 + 311.7) * 43758.5453; return r - Math.floor(r); };
const beatEnv = (t) => Math.exp(-7 * ((t % (60 / 96)) / (60 / 96)));

/* 按曲目 id 确定性生成的封面（SVG 内联，无外部图片依赖） */
function coverSVG(seed) {
  const s = seedOf(seed);
  const hueA = pal(0.15 + s * 0.5), hueB = pal(0.55 + s * 0.4);
  const sunY = 58 + s * 22, lines = 2 + Math.round(s * 2);
  let waves = "";
  for (let i = 0; i < lines; i++) {
    const y = 118 + i * 9, w = 46 - i * 10;
    waves += `<line x1="${100 - w / 2}" y1="${y}" x2="${100 + w / 2}" y2="${y}"/>`;
  }
  return `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs><linearGradient id="g${(s * 1e4) | 0}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${mix([13, 15, 14], hueA, 0.85)}"/>
      <stop offset=".62" stop-color="${mix(hueA, hueB, .5)}"/>
      <stop offset="1" stop-color="${hueB}"/></linearGradient></defs>
    <rect width="200" height="200" fill="url(#g${(s * 1e4) | 0})"/>
    <circle cx="100" cy="${sunY + 40}" r="30" fill="${mix(WARM, hueB, 0.25)}"/>
    <rect y="${sunY + 66}" width="200" height="${200 - sunY - 66}" fill="rgba(13,15,14,.45)"/>
    <g stroke="${mix(WARM, hueB, 0.45)}" stroke-width="3" stroke-linecap="round" opacity=".8">${waves}</g>
  </svg>`;
}

/* ---------- 模块状态 ---------- */
const S = {
  mounted: false, open: false, mode: "karaoke",
  player: null, box: null, cv: null, ctx: null, stage: null, dpr: 1,
  lines: [], trackId: "", trackTitle: "",
  raf: 0, last: 0, angle: 0, vel: 0,
  kIdx: -2, vIdx: -2, rIdx: -2, fIdx: -2,
  peakA: 0, peakSmooth: 0,
  vals: new Float32Array(BARS),
  rawSpec: new Float32Array(BARS), // 半环频段原始值（镜像之前）
  waveEnergy: 0,                   // 慢速包络（持续音压基准，用于突变对比）
  slowSpec: new Float32Array(HALF + 1), // 各频段慢速包络
  botSlow: new Float32Array(HALF + 1),  // 底部专用快包络（τ≈0.25s，只放行瞬态）
  botVals: new Float32Array(BARS),      // 底部柱高（中心音频源）
  splash: 0,                            // 浪涌：中心爆→涟漪涌起的跟随量
  audioCtx: null, analyser: null, freq: null, audioFailed: false,
};

const activeIndex = (t) => {
  let low = 0, high = S.lines.length - 1, found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (S.lines[mid].t <= t) { found = mid; low = mid + 1; } else high = mid - 1;
  }
  return found;
};

/* ---------- 真频谱（懒创建，见注释两个坑） ---------- */
function ensureAnalyser() {
  if (S.analyser || S.audioFailed) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error("no WebAudio");
    S.audioCtx = new AC();
    // 坑①：同一 media 元素全局只能 createMediaElementSource 一次 —— 模块级单例，mount 幂等
    const src = S.audioCtx.createMediaElementSource(S.player);
    S.analyser = S.audioCtx.createAnalyser();
    S.analyser.fftSize = 256;
    S.analyser.smoothingTimeConstant = 0.82;
    S.freq = new Uint8Array(S.analyser.frequencyBinCount);
    src.connect(S.analyser);
    // 坑②：不接回 destination 元素会全程静音 —— 与创建写在同一处，绝不遗漏
    S.analyser.connect(S.audioCtx.destination);
    S.player.addEventListener("play", () => {
      if (S.audioCtx.state === "suspended") S.audioCtx.resume().catch(() => {});
    });
  } catch {
    S.audioFailed = true; // 无 WebAudio → 环形退回合成频谱，功能不缺席
  }
}

/* ---------- 数据链 ----------
   镜像对称 + 对数频段插值 + 软膝压缩。
   环形=突变响应：起音即时、回落 120ms，柱子跟着音频硬跳（用户点名风格）；
   底部水波=整体能量的慢速跟随（丝滑）。 */
const C_KNEE = 0.08, FUDGE = 0.55;
function compress(v) { // 软膝压缩：收拢动态范围但不压平
  return Math.min(1, (Math.log(C_KNEE + v) - Math.log(C_KNEE)) /
    (Math.log(C_KNEE + 0.25) - Math.log(C_KNEE)) * FUDGE);
}
function spectrum(t, now, dt) {
  const out = S.vals;
  const playing = S.player && !S.player.paused;
  if (S.analyser) {
    S.analyser.getByteFrequencyData(S.freq);
    let total = 0;
    for (let i = 0; i < S.freq.length; i++) total += S.freq[i];
    if (total === 0 && S.audioCtx && S.audioCtx.state !== "running") {
      S.audioCtx.resume().catch(() => {}); // suspended → 退回合成，恢复后自动切回
      S.live = false;
    } else S.live = true;
    if (S.live) {
      const bins = S.freq.length, usable = Math.floor(bins * 0.72);
      // 半环频段：对数映射 + 相邻 bin 插值 + 低音倾斜 + 软膝压缩（原始值，不做时间平滑）
      for (let k = 0; k <= HALF; k++) {
        const u = k / HALF;
        const f0 = Math.pow(u, 1.7) * usable;
        const f1 = Math.pow(Math.min(1, u + 1 / HALF), 1.7) * usable;
        let acc = 0, cnt = 0;
        for (let b = Math.floor(f0); b <= Math.min(usable - 1, Math.ceil(f1)); b++) { acc += S.freq[b]; cnt++; }
        let v = cnt ? acc / cnt / 255 : 0;
        v *= 0.55 + 0.45 * u;
        S.rawSpec[k] = compress(v);
      }
    }
  }
  if (!S.analyser || !S.live) {
    // 合成：平滑空间轮廓 × 假节拍包络（突变感的合成替代）
    for (let k = 0; k <= HALF; k++) {
      const u = k / HALF;
      const profile = Math.max(0, Math.sin(u * 3.1 + 1.2) * Math.sin(u * 1.7 - 0.4));
      S.rawSpec[k] = compress(0.06 + 0.78 * profile * (playing ? beatEnv(t) : 0.1));
    }
  }
  // 慢速包络：持续音压的基准线（柱子只对"变化量"起爆，持续平稳时主动落回）
  for (let k = 0; k <= HALF; k++) {
    S.slowSpec[k] += (S.rawSpec[k] - S.slowSpec[k]) * (1 - Math.exp(-dt * 1.2));
  }
  // 空间平滑：相邻频段轻度加权（去单柱毛刺，峰形保留）
  for (let k = 0; k <= HALF; k++) {
    const p = S.rawSpec[Math.max(0, k - 1)], c = S.rawSpec[k], n = S.rawSpec[Math.min(HALF, k + 1)];
    S.rawSpec[k] = p * 0.25 + c * 0.5 + n * 0.25;
  }
  // 镜像 + 峰值柱：快攻（立即到顶）+ 线性匀速滑落（全程 ~420ms，丝滑不飘浮）
  const FALL = 2.4;
  for (let i = 0; i < BARS; i++) {
    const k = Math.min(i, BARS - i);
    const raw = S.rawSpec[Math.min(HALF, k)];
    const spike = Math.max(0, raw - S.slowSpec[k] * 0.55); // 超出慢包络的部分才是"突变"
    const target = Math.min(1, spike * 1.5 + raw * 0.12);
    const prev = out[i];
    out[i] = target > prev ? target : Math.max(target, prev - FALL * dt);
  }
  // 底部中心源：更快的快包络（τ≈0.25s）+ 更强对比——鼓点一过柱子立刻落回
  let bsum = 0;
  for (let i = 0; i < BARS; i++) {
    const k = Math.min(i, BARS - i);
    const raw = S.rawSpec[Math.min(HALF, k)];
    S.botSlow[k] += (raw - S.botSlow[k]) * (1 - Math.exp(-dt * 4));
    const bspike = Math.max(0, raw - S.botSlow[k] * 0.8);
    S.botVals[i] = Math.min(1, bspike * 1.7 + raw * 0.05);
    bsum += S.botVals[i];
  }
  S.waveEnergy += (bsum / BARS - S.waveEnergy) * (1 - Math.exp(-dt * 3));
  // 浪涌：快起（~0.15s）慢落（~1.2s）——中心爆完，涟漪带着这份能量往外涌
  S.splash += (S.waveEnergy - S.splash) * (1 - Math.exp(-dt * (S.waveEnergy > S.splash ? 14 : 3)));
}

/* ---------- 卡拉OK：逐字 span 构建用真 units 时间 ---------- */
function buildKaraoke(line, box) {
  box.innerHTML = "";
  if (!line) return;
  const frag = document.createDocumentFragment();
  let cursor = 0;
  const marks = []; // {from,to,start,end} 字符区间 → 时间区间
  (line.units || []).forEach((u, i) => {
    const at = line.text.indexOf(u.text, cursor);
    if (at < 0) return;
    const next = (line.units[i + 1] || {}).start || u.start + 1.2;
    marks.push({ from: at, to: at + u.text.length, start: u.start, end: Math.max(u.start + 0.08, next) });
    cursor = at + u.text.length;
  });
  const unitAt = (ch) => {
    for (const m of marks) if (ch >= m.from && ch < m.to) return m;
    return null;
  };
  [...line.text].forEach((ch, i) => {
    const span = document.createElement("span");
    span.className = "ch";
    span.dataset.c = ch;
    span.textContent = ch;
    const m = unitAt(i);
    if (m) { span.dataset.u0 = m.start; span.dataset.u1 = m.end; }
    frag.appendChild(span);
  });
  box.appendChild(frag);
}

/* ---------- 环形：镜像频谱围绕封面圆盘 ---------- */
function drawRing(now, dt) {
  const ctx = S.ctx;
  const W = S.cv.clientWidth, H = S.cv.clientHeight;
  ctx.clearRect(0, 0, W, H);
  const disc = S.box.querySelector(".lvDisc");
  const r = disc.getBoundingClientRect();
  const box = S.box.getBoundingClientRect();
  const cx = r.left - box.left + r.width / 2, cy = r.top - box.top + r.height / 2;
  const R0 = r.width / 2;
  const ringR = R0 + 18;
  const playing = S.player && !S.player.paused;

  ctx.strokeStyle = "rgba(128,132,128,.14)"; // 主题中立基线
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, ringR - 5, 0, Math.PI * 2); ctx.stroke();

  for (let i = 0; i < BARS; i++) {
    const a = (i / BARS) * Math.PI * 2 - Math.PI / 2;
    const v = S.vals[i];
    const len = 4 + v * Math.min(R0 * 0.9, 160);
    const col = pal(i / BARS);
    const glow = glowTarget();
    ctx.strokeStyle = mix(col, glow, v * 0.22);
    ctx.globalAlpha = 0.3 + v * 0.7;
    ctx.shadowColor = rgba(col, 0.5);
    ctx.shadowBlur = v > 0.55 && !REDUCED.matches ? 9 * v : 0;
    ctx.lineWidth = 2.6 + v * 1.1;
    const c = Math.cos(a), sn = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(cx + c * ringR, cy + sn * ringR);
    ctx.lineTo(cx + c * (ringR + len), cy + sn * (ringR + len));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;

  /* 底部音频柱：中间是“源”——跟音频峰值突变；两边是“随波”——只荡从中心
     传出来的水波（不跟音频）。扰动像石头入水，从中心一圈圈往外辐射。 */
  const NB = BARS * 2, bw = W / NB, half = NB / 2;
  const maxH = Math.min(92, H * 0.1);
  for (let j = 0; j < NB; j++) {
    const dd = Math.abs(j - half) / half;                         // 0 中心 → 1 两端
    // 中心音频区：权重随距离衰减（约 40% 半宽内跟随音频峰值）
    const audioW = Math.max(0, 1 - dd * 2.4);
    const fi = dd * HALF, k0 = Math.floor(fi), fr = fi - k0;
    const v0 = S.botVals[Math.min(HALF, k0)], v1 = S.botVals[Math.min(HALF, k0 + 1)];
    const audioV = (v0 + (v1 - v0) * fr) * audioW;
    // 外围水波区：双频行波向外传播（快波给动感、慢波给水感），振幅由浪涌驱动
    const ripple = (0.10 + 0.34 * S.splash) *
      (0.55 + 0.45 * Math.sin(dd * 6.5 - now * 0.006) + 0.30 * Math.sin(dd * 11 - now * 0.0095)) + 0.04;
    const v = Math.min(1, audioV + ripple * (1 - audioW * 0.6));
    const h = 3 + v * maxH;
    const x = j * bw + bw * 0.2, w = Math.max(1.5, bw * 0.6);
    const col = pal(dd * 0.5 + 0.08);
    const glow = glowTarget();
    ctx.fillStyle = rgba(col, 0.25 + v * 0.55);
    ctx.fillRect(x, H - h, w, h);
    ctx.fillStyle = mix(col, glow, 0.4); // 顶端亮帽（浅色主题下压暗成墨帽）
    ctx.fillRect(x, H - h - 2, w, 2);
  }
}

/* ---------- 主循环 ---------- */
function frame(now) {
  if (!S.open) return;
  const dt = Math.min(0.05, (now - S.last) / 1000 || 0.016); S.last = now;
  const t = S.player ? S.player.currentTime : 0;
  const playing = S.player && !S.player.paused;
  const idx = activeIndex(t);
  const line = idx >= 0 ? S.lines[idx] : null;
  const next = S.lines[idx + 1];

  if (S.mode === "ring") {
    spectrum(t, now, dt);
    drawRing(now, dt);
    if (idx !== S.rIdx) {
      S.rIdx = idx;
      S.box.querySelector(".lvRCap .capPrev").textContent = idx > 0 ? S.lines[idx - 1].text : "";
      S.box.querySelector(".lvRCap .capNow").textContent = line ? line.text : "…";
      S.box.querySelector(".lvRCap .capNext").textContent = next ? next.text : "";
    }
  } else if (S.mode === "karaoke") {
    if (idx !== S.kIdx) {
      S.kIdx = idx;
      S.box.querySelector("#lvKPrev").textContent = idx > 0 ? S.lines[idx - 1].text : "";
      S.box.querySelector("#lvKNext").textContent = next ? next.text : "";
      buildKaraoke(line, S.box.querySelector("#lvKNow"));
    }
    const chars = S.box.querySelectorAll("#lvKNow .ch");
    if (REDUCED.matches) { // 降级：整句点亮
      chars.forEach((c) => c.style.setProperty("--clip", line ? "100%" : "0%"));
    } else {
      const end = next ? next.t : (line ? line.t + 6 : 0);
      const p = line ? Math.min(1, Math.max(0, (t - line.t) / Math.max(0.1, end - line.t))) : 0;
      const u0 = line ? line.t : 0, u1 = end;
      chars.forEach((c) => {
        const has = c.dataset.u0 !== undefined;
        const a = has ? +c.dataset.u0 : u0, b = has ? +c.dataset.u1 : u1;
        const cp = Math.min(1, Math.max(0, (t - a) / Math.max(0.08, b - a)));
        c.style.setProperty("--clip", (cp * 100).toFixed(1) + "%");
      });
    }
  } else if (S.mode === "lyrics") {
    if (idx !== S.fIdx) {
      S.fIdx = idx;
      const list = S.box.querySelector("#lvFList");
      [...list.children].forEach((li, i) => li.classList.toggle("on", i === idx));
      if (idx >= 0 && list.children[idx]) {
        const el = list.children[idx];
        list.scrollTop = el.offsetTop - list.clientHeight / 2 + el.offsetHeight / 2;
      }
    }
  } else if (S.mode === "vinyl") {
    if (idx !== S.vIdx) {
      S.vIdx = idx;
      const list = S.box.querySelector("#lvVList");
      [...list.children].forEach((li, i) => li.classList.toggle("on", i === idx));
      if (idx >= 0 && list.children[idx]) {
        const el = list.children[idx];
        list.scrollTop = el.offsetTop - list.clientHeight / 2 + el.offsetHeight / 2;
      }
    }
    // 唱片：启动快、停止慢（马达 vs 惯性滑行）
    const BASE = 360 / 1.8 / 6;
    const target = playing && !REDUCED.matches ? BASE : 0;
    S.vel += (target - S.vel) * (target > S.vel ? 0.045 : 0.012);
    if (S.vel < 0.02 && !playing) S.vel = 0;
    S.angle = (S.angle + S.vel * dt) % 360;
    const disc = S.box.querySelector("#lvVinylDisc");
    if (disc) disc.style.transform = `rotate(${S.angle}deg)`;
    // 唱臂：随曲目进度由外圈走向内圈，暂停抬起
    const arm = S.box.querySelector("#lvArm");
    if (arm) {
      const p = S.player && S.player.duration ? t / S.player.duration : 0;
      arm.style.setProperty("--armDeg", (playing ? -10 + p * 26 : -34) + "deg");
    }
  }
  S.raf = requestAnimationFrame(frame);
}

/* ---------- 布局 ---------- */
function resize() {
  if (!S.box || S.box.hidden) return;
  S.dpr = Math.min(2, devicePixelRatio || 1);
  S.cv.width = S.cv.clientWidth * S.dpr;
  S.cv.height = S.cv.clientHeight * S.dpr;
  S.ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  const trans = document.querySelector(".trans");
  if (trans) S.box.style.bottom = `${trans.offsetHeight}px`;
}

const MODES = ["vinyl", "lyrics", "karaoke", "ring"];

function setMode(mode, {save = true} = {}) {
  if (!MODES.includes(mode)) mode = "vinyl";
  S.mode = mode;
  if (save) writeText(MODE_KEY, mode);
  const box = S.box;
  box.querySelector("#lvVinyl").hidden = mode !== "vinyl";
  box.querySelector("#lvFull").hidden = mode !== "lyrics";
  box.querySelector("#lvKaraoke").hidden = mode !== "karaoke";
  box.querySelector("#lvRing").hidden = mode !== "ring";
  box.querySelectorAll("#lvModes button").forEach((b) => {
    const on = b.dataset.viz === mode;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  });
  S.kIdx = S.vIdx = S.rIdx = S.fIdx = -2; // 强制重建各模式行
  clearCanvas(); // 切模式必清屏：画布残留（如环形柱）不得串进其他模式
  if (mode === "ring") {
    ensureAnalyser();
    resize();
  }
}

function setLines(lines) {
  S.lines = (lines || []).map((l) => ({t: l.start ?? l.t ?? 0, text: l.text || "", units: l.units || []}));
  S.kIdx = S.vIdx = S.rIdx = S.fIdx = -2;
  // 黑胶侧列表 + 整页歌词列表共用一套构建
  for (const [sel, cls] of [["#lvVList", "lvVLine"], ["#lvFList", "lvFLine"]]) {
    const list = S.box.querySelector(sel);
    list.innerHTML = "";
    S.lines.forEach((l) => {
      const li = document.createElement("div");
      li.className = cls;
      li.setAttribute("role", "listitem");
      li.dataset.notr = "";
      li.textContent = l.text;
      li.addEventListener("click", () => {
        S.player.currentTime = Math.max(0, l.t + 0.05);
        if (S.player.paused) S.player.play().catch(() => {});
      });
      list.appendChild(li);
    });
  }
}

function setTrack(id, title) {
  if (id !== S.trackId) {
    S.trackId = id || "";
    const svg = coverSVG(S.trackId);
    S.box.querySelector("#lvDisc").innerHTML = svg;
    S.box.querySelector("#lvLabel").innerHTML = svg;
  }
  if (title !== undefined) {
    S.trackTitle = title || "";
    S.box.querySelector("#lvVTitle").textContent = S.trackTitle;
    S.box.querySelector("#lvTitle").textContent = S.trackTitle || T("未选择曲目");
  }
  S.kIdx = S.vIdx = S.rIdx = S.fIdx = -2;
}

function start() {
  if (S.raf) return;
  S.last = performance.now();
  S.raf = requestAnimationFrame(frame);
}
function stop() {
  if (S.raf) cancelAnimationFrame(S.raf);
  S.raf = 0;
}

function clearCanvas() {
  if (!S.ctx) return;
  S.ctx.save();
  S.ctx.setTransform(1, 0, 0, 1, 0, 0);
  S.ctx.clearRect(0, 0, S.cv.width, S.cv.height);
  S.ctx.restore();
}

const LyricViz = {
  mount(container, player) {
    if (S.mounted) return;
    S.mounted = true;
    S.box = container;
    S.player = player;
    S.ctx = S.cv = container.querySelector("#lvCv");
    S.ctx = S.cv.getContext("2d");
    S.mode = readText(MODE_KEY, (value) => MODES.includes(value), "vinyl");
    if (!MODES.includes(S.mode)) S.mode = "vinyl";
    setMode(S.mode, {save: false});
    S.box.querySelectorAll("#lvModes button").forEach((b) => {
      b.addEventListener("click", () => setMode(b.dataset.viz));
    });
    document.addEventListener("keydown", (e) => { // 数字键切模式，仅在沉浸态生效
      if (!S.open || /INPUT|TEXTAREA/.test(e.target.tagName) || e.target.isContentEditable) return;
      const map = {Digit1: "vinyl", Digit2: "lyrics", Digit3: "karaoke", Digit4: "ring"};
      if (map[e.code]) setMode(map[e.code]);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stop(); else if (S.open) start();
    });
    addEventListener("resize", resize);
    resize();
  },
  setOpen(open) {
    if (!S.mounted) return;
    if (open === S.open) return;
    S.open = open;
    if (open) {
      resize();
      S.audioCtx && S.audioCtx.state === "suspended" && S.audioCtx.resume().catch(() => {});
      start();
    } else {
      stop(); // 收起即停：不留任何循环
      clearCanvas();
    }
  },
  setMode(mode) { if (S.mounted) setMode(mode); },
  setLines(lines) { if (S.mounted) setLines(lines); },
  setTrack(id, title) { if (S.mounted) setTrack(id, title); },
  debug() { // 测试与诊断用：暴露内部状态快照
    let total = 0;
    if (S.analyser) { S.analyser.getByteFrequencyData(S.freq); for (const v of S.freq) total += v; }
    return {
      mounted: S.mounted, open: S.open, mode: S.mode,
      rafActive: !!S.raf, lines: S.lines.length,
      audio: S.audioCtx ? S.audioCtx.state : (S.audioFailed ? "failed" : "none"),
      analyserLive: !!S.live, freqTotal: total,
    };
  },
};

export {LyricViz};
