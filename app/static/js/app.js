/* 主脚本：路由 + 视图渲染 + 真实后端联动（B2 外壳）。
   约定：state 里只有中文原文与原始数据，翻译发生在渲染时（T()）；
   文件名 / 参数名 / 歌词 / 报错原文是数据，用 data-notr 或 esc() 直出，不进词典。 */
"use strict";

import {T, applyLang, getLang, toggleLang, toggleTheme, trDom} from "./i18n.js";
import {icon, q, qa, esc, notr, fmtClock, fmtStamp, fmtDate, debounce, toast,
        openModal, closeModal, modalOpen, confirmDialog, initModals} from "./ui.js";
import {state, subscribe, bootstrap, loadModel, loadJobs, loadJob, loadDoctor, loadModelOn,
        unloadModel, createJob, cancelJob, updateJob, deleteJob, audioUrl, artifactUrl,
        loadSettings, saveSettings, resetSettings,
        get, post, ApiError} from "./store.js";

const $ = (id) => document.getElementById(id);
const VIEWS = ["studio", "score", "library", "guide", "system"];
const PHASES = ["plan", "semantic", "nar", "decode"];

const ui = {
  view: "studio",
  cot: "full",
  device: "auto",
  filter: "",
  search: "",
  sort: "new",
  ab: [],
  track: null,
  side: "a",
  sampling: {abc: {}, semantic: {}},
  cfg: null,
  ode: null,
  vae: "standard",
  scoreJob: null,
  accelSaving: false,
  scoreAbc: "",
  scoreOriginal: "",
  scoreLoadedJob: null,
  inspect: null,
  rollTab: "roll",
  rollPlan: null,
  rollSel: null,
  rollDrag: null,
  rollUndo: [],
  rollError: "",
  rollBusy: false,
  rollFor: "",
  rollFocus: false,
  focusScroll: 0,
  rollZoomX: 1,
  rollZoomY: 1,
  lyrics: null,
  lyricLine: -1,
  lyricNote: "播放后这里跟着唱",
  logJob: null,
};

/* ------------------------------------------------------------------ 路由 */
function go(view) {
  if (!VIEWS.includes(view)) view = "studio";
  if (view !== "score") setRollFocus(false);
  ui.view = view;
  qa(".view").forEach((section) => section.classList.toggle("active", section.id === `v-${view}`));
  qa(".nav").forEach((button) => {
    if (button.dataset.view === view) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (window.history?.replaceState) window.history.replaceState(null, "", `#${view}`);
  renderView();
  $("work").scrollTop = 0;
}

function renderView() {
  if (ui.view === "studio") renderQueue();
  else if (ui.view === "score") renderScore();
  else if (ui.view === "library") renderLibrary();
  else if (ui.view === "guide") renderGuideView();
  else if (ui.view === "system") renderSystem();
}

function renderAll() {
  renderTopbar();
  renderRail();
  renderCost();
  renderView();
}

/* ------------------------------------------------------------------ 顶栏 */
function modelText() {
  const model = state.model;
  const gpu = model.gpu || {};
  if (model.state === "loading") return T("正在加载模型…");
  if (model.state === "unloading") return T("正在卸载模型…");
  if (model.state === "loaded") {
    const device = model.device === "cuda" ? T("显卡") : "CPU";
    const extra = model.seconds ? T(" · 用时 {0}", fmtStamp(model.seconds)) : "";
    const degraded = model.reason ? ` · ${T(model.reason)}` : "";
    return T("模型已加载 · {0}{1}{2}", device, extra, degraded);
  }
  if (model.reason) return T("模型未加载 · {0}", T(model.reason));
  if (gpu.available && !gpu.suitable) return T("模型未加载 · {0}", gpu.reason || T("本机用 CPU"));
  return T("模型未加载 · 生成时会自动加载，约 1 分钟");
}

/* 标签页标题上的完成提示：切回窗口就撤掉，不做常驻标记 */
let titleFlag = false;
const baseTitle = () => T("YuE2 音乐工作台");
function paintTitle() {
  document.title = titleFlag ? `✓ ${T("已完成")} · ${baseTitle()}` : baseTitle();
}

let sawConnected = false;

function renderTopbar() {
  const model = state.model;
  const gpu = model.gpu || {};
  const working = state.jobs.some((job) => job.status === "running");
  const busy = model.state === "loading" || model.state === "unloading" || !!model.busy || working;
  const box = $("mstat");
  box.classList.toggle("on", model.state === "loaded");
  box.classList.toggle("busy", busy);
  $("mstatText").textContent = modelText();
  box.title = model.state === "loaded"
    ? `${model.device_name || model.device || ""}${model.reason ? ` · ${model.reason}` : ""}`
    : gpu.reason || "";
  if (state.connected) sawConnected = true;
  $("netBadge").hidden = !(sawConnected && !state.connected);

  const device = model.state === "loaded" ? model.device : ui.device === "auto" ? model.default_device : ui.device;
  qa(".devseg button").forEach((button) => {
    const want = button.dataset.dev;
    button.setAttribute("aria-pressed", String(want === device));
    const blocked = want === "cuda" && gpu.available && !gpu.suitable;
    button.disabled = busy || (want === "cuda" && !gpu.available) || blocked;
    button.title = blocked ? (gpu.reason || "") : working ? T("生成中不能切换设备，等当前任务结束") : "";
  });

  const loaded = model.state === "loaded";
  $("btnLoad").disabled = busy;
  $("btnLoad").querySelector(".lb").textContent = loaded ? T("卸载模型") : T("加载模型");
  $("btnLoad").querySelector("svg").innerHTML =
    '<path d="M21 8.5 12 3 3 8.5v7L12 21l9-5.5z"/><path d="M3 8.5 12 14l9-5.5M12 14v7"/>';

  qa(".langseg button").forEach((button) =>
    button.setAttribute("aria-pressed", String(button.dataset.lang === getLang())));
  $("icoSun").parentElement.setAttribute("aria-label", T("切换深浅色主题"));
}

function renderRail() {
  const active = state.jobs.filter((job) => job.status === "running" || job.status === "queued").length;
  $("cStudio").textContent = String(active);
  $("cStudio").classList.toggle("q", active > 0);
  $("cLib").textContent = String(state.jobs.filter((job) => job.status === "complete").length);
  const device = state.model.device === "cuda" ? T("显卡") : "CPU";
  $("railfoot").innerHTML = `${esc(T("单任务队列"))}<br>${esc(T("设备：{0}", device))}`;
}

/* ------------------------------------------------------------------ 模型操作 */
async function onDevice(button) {
  const want = button.dataset.dev;
  ui.device = want;
  button.disabled = true;
  try {
    await loadModelOn(want);
    const model = state.model;
    if (model.state === "loaded") {
      toast(model.device === want
        ? T("模型已加载到 {0} · 可以开始生成", want === "cuda" ? T("显卡") : "CPU")
        : T("已自动降级到 CPU · {0}", model.reason || ""), model.device === want ? "ok" : "warn");
    } else {
      toast(model.reason || T("模型加载失败"), "bad");
    }
  } catch (exc) {
    toast(message(exc), "bad");
    loadModel().catch(() => {});
  }
  renderTopbar();
}

async function onLoadButton() {
  const model = state.model;
  if (model.state === "loaded") {
    try {
      await unloadModel();
      toast(T("模型已卸载，工作进程已退出，显存与内存已释放"), "ok");
    } catch (exc) {
      toast(message(exc), "bad");
    }
  } else {
    await onDevice({dataset: {dev: ui.device === "auto" ? (model.default_device || "cpu") : ui.device}});
    return;
  }
  renderTopbar();
  renderSystem();
}

/* 后端英文报错 → 人话；匹配不到返回 null，调用处原样显示（不吞、不瞎猜）。 */
const STAGE_LABELS = [
  [/^abc$|plan/i, "规划乐谱"],
  [/semantic|vllm ar|prefill/i, "语义生成"],
  [/acoustic flow|nar/i, "非自回归合成"],
  [/vae|decode/i, "解码导出"],
];
const SAMPLING_LABELS = {
  temperature: "温度", top_p: "Top-P", top_k: "Top-K", repetition_penalty: "重复惩罚",
};

/* 校验器逐条差异行（贴谱/重渲染/对比三处共用）：能识别的翻成人话，识别不了的返回 null 由调用方兜底 */
function diffLine(raw) {
  const e = String(raw || "");
  if (/quarter-note tempo differs/i.test(e)) return T("速度（BPM）与原谱不同");
  const grid = e.match(/^(\w+): bar meter\/time grid differs$/i);
  if (grid) return T("{0}：拍号或小节网格与原谱不同", voiceLabel(grid[1]));
  const notes = e.match(/^(\w+): sounding notes differ starting at note (\d+)/i);
  if (notes) return T("{0}：从第 {1} 个音符起音高、起点或时值不同", voiceLabel(notes[1]), notes[2]);
  return null;
}

function humanError(raw) {
  const e = String(raw || "").trim();
  if (!e) return null;
  const cancel = e.match(/^cancelled (?:during|before) (.+)$/i);
  if (cancel) {
    const hit = STAGE_LABELS.find(([re]) => re.test(cancel[1]));
    return hit ? T("已取消（在「{0}」阶段停止）", T(hit[1])) : T("已取消");
  }
  if (/barline/i.test(e)) return T("谱面格式有误：音乐行要以普通小节线 | 结尾");
  const range = e.match(/^(abc|semantic)_sampling\.(\w+) must be between (\S+) and (\S+)$/);
  if (range) {
    const label = SAMPLING_LABELS[range[2]] ? T(SAMPLING_LABELS[range[2]]) : range[2];
    return T("{0}超出范围：只能填 {1} 到 {2}", label, range[3], range[4]);
  }
  if (/^seed must be/i.test(e)) return T("随机种子超出范围：需为 0 到 2^63 之间的整数");
  if (/^ode_steps must be/i.test(e)) return T("求解步数超出范围：只能填 1 到 200");
  if (/^cfg_scale must be/i.test(e)) return T("文本引导强度超出范围：只能填 0 到 20");
  if (/^favorite must be/i.test(e)) return T("收藏状态只接受 true / false");
  if (/^title must be/i.test(e)) return T("标题最多 200 个字");
  if (/budget exceeds 24576|no implicit truncation/i.test(e)) {
    return T("歌词或风格超出模型上下文（24576）：请精简歌词，或把 max_tokens 调小");
  }
  if (/Incomplete native two-voice ABC/i.test(e)) return T("谱面不完整：原生双声部 ABC 缺少收尾内容");
  const diff = diffLine(e);
  if (diff) return diff;
  if (/^Unsupported key /i.test(e)) return T("调号不支持：请用标准的大调或小调 K: 字段");
  if (/^Unsupported meter /i.test(e)) return T("拍号不支持：请写成明确的分数，例如 4/4");
  if (/^(?:Missing header|Expected native|Expected L:|Expected integer|Preserve native|Dangling section)/i.test(e)) {
    return T("谱面缺少必需的头部字段：请保留 X:1、T:、M:、L:、Q:、K: 与两个声部定义");
  }
  if (/expected V: (Vocal|Ins)/i.test(e)) {
    const missing = e.match(/expected V: (Vocal|Ins)/i);
    return T("谱面结构有误：这里缺少 {0} 声部的段落", voiceLabel(missing[1]));
  }
  if (/voices have different measure counts/i.test(e)) return T("谱面结构有误：两个声部的小节数不一致");
  if (/^group \d+, /i.test(e)) return T("谱面校验未通过：{0}", e);
  if (/^(?:Vocal|Ins): /i.test(e)) return T("谱面校验未通过：{0}", e);
  if (/请求体过大|request body.*too large/i.test(e)) return T("提交内容过大：请缩短歌词或去掉过长的参数");
  return null;
}

function voiceLabel(name) {
  return name === "Vocal" ? T("人声") : name === "Ins" ? T("伴奏") : name;
}

const message = (exc) => (exc instanceof ApiError ? (humanError(exc.message) || T(exc.message)) : T("连不上后端服务"));

/* ------------------------------------------------------------------ 创作表单 */
function syncChips() {
  const text = $("fStyle").value.toLowerCase();
  qa(".chipset .chip").forEach((chip) => {
    const on = text.includes(chip.dataset.token.toLowerCase());
    chip.setAttribute("aria-pressed", String(on));
  });
}

function toggleToken(chip) {
  const token = chip.dataset.token;
  const box = $("fStyle");
  const parts = box.value.split(",").map((item) => item.trim()).filter(Boolean);
  const hit = parts.findIndex((item) => item.toLowerCase() === token.toLowerCase());
  if (hit >= 0) parts.splice(hit, 1);
  else parts.push(token);
  const bpm = $("fBpm").value.trim();
  const lang = $("fLang").value;
  const head = parts.filter((item) => item === lang);
  const tail = parts.filter((item) => item !== lang);
  const composed = [...head, ...tail];
  if (bpm && !composed.some((item) => /bpm$/i.test(item))) composed.push(`${bpm} BPM`);
  box.value = composed.join(", ");
  syncChips();
  saveDraftSoon();
}

function styleFromControls() {
  const box = $("fStyle");
  if (box.value.trim()) return box.value.trim();
  return "";
}

function applyPreset(preset) {
  if (!preset) return false;
  $("fStyle").value = preset.style;
  $("fLyrics").value = preset.lyrics;
  const bpm = /(\d{2,3})\s*BPM/i.exec(preset.style);
  if (bpm) $("fBpm").value = bpm[1];
  const lang = /^(Mandarin|English|Cantonese|Japanese)/.exec(preset.style);
  if (lang) $("fLang").value = lang[1];
  syncChips();
  $("lintNote").hidden = true;
  return true;
}

async function fillPreset() {
  const preset = state.presets.find((item) => item.id === $("fPreset").value);
  if (!preset) return;
  if (!await confirmOverwrite()) return;
  applyPreset(preset);
  markFormBase();
  saveDraftSoon();
  toast(T("已载入范例 · 风格与歌词都可以再改"), "ok");
}

/* 表单「脏」的判定：和最近一次载入的基准（范例/参数回填/草稿）比，改动过才算，
   这样自动预填的范例不会让每次复用都弹确认。 */
let formBase = "";
const formSnapshot = () => `${$("fStyle").value.trim()}\u0000${$("fLyrics").value.trim()}`;
function markFormBase() { formBase = formSnapshot(); }
function formDirty() {
  return formSnapshot() !== formBase && !!($("fStyle").value.trim() || $("fLyrics").value.trim());
}

async function confirmOverwrite() {
  if (!formDirty()) return true;
  return confirmDialog({
    title: T("覆盖当前表单？"),
    body: esc(T("表单里还有没发出去的内容，继续会把风格和歌词换掉。")),
    ok: T("覆盖"), cancel: T("取消"), danger: true,
  });
}

/* ------------------------------------------------------------------ 表单草稿 */
const DRAFT_KEY = "yue2.draft";
let draftTimer = 0;

function draftSnapshot() {
  return {
    style: $("fStyle").value, lyrics: $("fLyrics").value,
    bpm: $("fBpm").value, lang: $("fLang").value, seed: $("fSeed").value,
    count: $("fVar").value, cot: ui.cot, cfg: ui.cfg, ode: ui.ode, vae: ui.vae,
    sampling: {abc: {...ui.sampling.abc}, semantic: {...ui.sampling.semantic}},
  };
}

function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = 0;
  try {
    const snap = draftSnapshot();
    if (!snap.style.trim() && !snap.lyrics.trim()) { localStorage.removeItem(DRAFT_KEY); return; }
    localStorage.setItem(DRAFT_KEY, JSON.stringify(snap));
  } catch (exc) { /* 隐私模式下存不了就算了 */ }
}

function saveDraftSoon() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 400);
}

function readDraft() {
  try {
    const data = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    return data && typeof data === "object" && typeof data.style === "string" ? data : null;
  } catch (exc) { return null; }
}

function clearDraft() {
  clearTimeout(draftTimer);
  draftTimer = 0;
  try { localStorage.removeItem(DRAFT_KEY); } catch (exc) { /* 无痕模式 */ }
}

function applyDraft(draft) {
  $("fStyle").value = draft.style || "";
  $("fLyrics").value = draft.lyrics || "";
  if (draft.bpm) $("fBpm").value = draft.bpm;
  if (draft.lang) $("fLang").value = draft.lang;
  $("fSeed").value = draft.seed ?? "";
  $("fVar").value = ["1", "2", "3", "4"].includes(String(draft.count)) ? String(draft.count) : "1";
  ui.cot = ["full", "melody", "off"].includes(draft.cot) ? draft.cot : "full";
  qa(".mode").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.cot === ui.cot)));
  ui.cfg = Number.isFinite(draft.cfg) ? draft.cfg : null;
  ui.ode = Number.isFinite(draft.ode) ? draft.ode : null;
  ui.vae = draft.vae || "standard";
  ui.sampling = {
    abc: {...(draft.sampling && draft.sampling.abc || {})},
    semantic: {...(draft.sampling && draft.sampling.semantic || {})},
  };
  syncChips();
  renderAdvanced();
  renderCost();
}

/* 首次打开时表单是空的，新手连点「生成」都只会拿到一句「风格为空」。
   这里先替他填好第一个范例；用户改任何一个字都不影响，只是省掉从零开始。 */
function prefillExample() {
  if ($("fStyle").value.trim() || $("fLyrics").value.trim()) return false;
  const preset = state.presets && state.presets[0];
  if (!preset) return false;
  $("fPreset").value = preset.id;
  return applyPreset(preset);
}

async function lintLyrics() {
  const lyrics = $("fLyrics").value;
  const note = $("lintNote");
  if (!lyrics.trim()) {
    note.hidden = false;
    note.className = "note bad";
    note.textContent = T("歌词为空");
    return false;
  }
  try {
    const result = await post("/api/lyrics/lint", {lyrics});
    const warnings = result.warnings || [];
    const lines = (result.lines || []).filter((line) => line.warning);
    note.hidden = false;
    note.className = warnings.length || lines.length ? "note" : "note ok";
    note.innerHTML = warnings.length || lines.length
      ? `<b>${esc(T("结构检查：{0} 条提醒", warnings.length + lines.length))}</b>` +
        `<ul style="margin:var(--sp2) 0 0 var(--sp4);font-size:13px">` +
        [...warnings.map((text) => `<li>${esc(T(text))}</li>`),
         ...lines.map((line) => `<li>${esc(T("第 {0} 行：{1}", line.line + 1, T(line.warning)))}</li>`)].join("") +
        `</ul>`
      : esc(T("结构检查通过：段落标记齐全，行长在 {0} 个音节以内", "7–16"));
    return true;
  } catch (exc) {
    note.hidden = false;
    note.className = "note bad";
    note.textContent = message(exc);
    return false;
  }
}

function advancedChanged() {
  const schema = state.schema;
  if (!schema) return false;
  if (ui.cfg !== null && Math.abs(ui.cfg - cotGuidance()) > 1e-9) return true;
  if (ui.ode !== null && ui.ode !== schema.ode_steps.default) return true;
  if (ui.vae !== "standard") return true;
  for (const phase of ["abc", "semantic"]) {
    const fields = schema.sampling[phase === "abc" ? "abc" : "semantic"].fields;
    for (const field of fields) {
      const value = ui.sampling[phase][field.key];
      if (value !== undefined && value !== field.default) return true;
    }
  }
  return false;
}

const cotGuidance = () => {
  const entry = (state.schema?.cot || []).find((item) => item.value === ui.cot);
  return entry ? entry.guidance : 1;
};

function buildSampling(phase) {
  const schema = state.schema;
  if (!schema) return undefined;
  const fields = schema.sampling[phase].fields;
  const out = {};
  let touched = false;
  for (const field of fields) {
    const value = ui.sampling[phase][field.key];
    if (value === undefined || value === field.default) continue;
    out[field.key] = value;
    touched = true;
  }
  return touched ? out : undefined;
}

const RESET_SVG = '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>' +
  '<path d="M3 3v5h5"/></svg>';

function decimalsOf(step) {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

function fmtNum(value, integer, step) {
  if (integer) return String(Math.round(Number(value)));
  return String(Number(Number(value).toFixed(decimalsOf(step))));
}

function clampValue(value, {min, max, step, integer}) {
  const rounded = integer ? Math.round(value) : Number(value.toFixed(decimalsOf(step)));
  return Math.min(max, Math.max(min, rounded));
}

function syncAdvBadge() {
  $("advBadge").textContent = advancedChanged() ? T("已自定义") : T("官方默认");
  $("advBadge").className = advancedChanged() ? "badge queue" : "badge";
}

function renderAdvanced() {
  const schema = state.schema;
  if (!schema) return;
  syncAdvBadge();

  const cfg = ui.cfg ?? cotGuidance();
  const cfgRange = $("sCfg");
  cfgRange.min = String(schema.cfg_scale.min);
  cfgRange.max = String(schema.cfg_scale.max);
  cfgRange.step = String(schema.cfg_scale.step);
  cfgRange.value = String(cfg);
  const cfgNum = $("nCfg");
  cfgNum.min = cfgRange.min;
  cfgNum.max = cfgRange.max;
  cfgNum.step = cfgRange.step;
  cfgNum.value = fmtNum(cfg, false, schema.cfg_scale.step);
  $("rstCfg").disabled = ui.cfg === null || Math.abs(ui.cfg - cotGuidance()) < 1e-9;

  const ode = ui.ode ?? schema.ode_steps.default;
  const odeRange = $("sOde");
  odeRange.min = String(schema.ode_steps.min);
  odeRange.max = String(schema.ode_steps.max);
  odeRange.step = String(schema.ode_steps.step);
  odeRange.value = String(ode);
  const odeNum = $("nOde");
  odeNum.min = odeRange.min;
  odeNum.max = odeRange.max;
  odeNum.step = odeRange.step;
  odeNum.value = fmtNum(ode, true, schema.ode_steps.step);
  $("rstOde").disabled = ui.ode === null || ui.ode === schema.ode_steps.default;

  const vae = $("fVae");
  vae.innerHTML = schema.decoders.map((item) =>
    `<option value="${esc(item.value)}"${item.available ? "" : " disabled"}>` +
    `${esc(T(item.label))}${item.available ? "" : ` · ${esc(T("未安装"))}`}</option>`).join("");
  vae.value = schema.decoders.some((item) => item.value === ui.vae && item.available) ? ui.vae : "standard";
  ui.vae = vae.value;
  $("rstVae").disabled = ui.vae === "standard";

  $("advNote").innerHTML = `<span class="idn" data-notr>ode_method=${esc(schema.ode_method.value)}</span>、` +
    `<span class="idn" data-notr>context=${esc(String(schema.context.value))}</span> ` +
    esc(T("由官方代码硬校验，只读展示，改不了也不该改。"));

  for (const [phase, groups] of [["abc", ["grpAbc", "grpAbc2"]], ["semantic", ["grpSem", "grpSem2"]]]) {
    const fields = schema.sampling[phase].fields;
    fields.forEach((field, index) => {
      const hostId = groups[index % 2];
      const host = $(hostId);
      let row = q(`[data-key="${field.key}"]`, host);
      if (!row) {
        row = document.createElement("div");
        row.className = "ctl";
        row.dataset.key = field.key;
        row.innerHTML =
          `<div class="row"><span class="name"><span class="idn" data-notr>${esc(field.key)}</span>` +
          ` <span class="dft"></span></span></div>` +
          `<div class="rowline"><input type="range" data-range aria-label="${esc(field.key)}">` +
          `<input class="inp num" type="number" data-num inputmode="${field.integer ? "numeric" : "decimal"}"` +
          ` aria-label="${esc(field.key)} value">` +
          `<button class="iconbtn rst" data-reset type="button" title="恢复默认"` +
          ` aria-label="恢复默认" disabled>${RESET_SVG}</button></div>`;
        host.append(row);
        const range = q("[data-range]", row);
        const num = q("[data-num]", row);
        const rst = q("[data-reset]", row);
        const apply = (next) => {
          ui.sampling[phase][field.key] = next;
          range.value = String(next);
          num.value = fmtNum(next, field.integer, field.step);
          rst.disabled = next === field.default;
          syncAdvBadge();
        };
        range.addEventListener("input", () => {
          apply(field.integer ? Number.parseInt(range.value, 10) : Number.parseFloat(range.value));
        });
        num.addEventListener("change", () => {
          const raw = num.value.trim();
          const parsed = Number(raw);
          if (raw === "" || !Number.isFinite(parsed)) {
            num.value = fmtNum(ui.sampling[phase][field.key] ?? field.default, field.integer, field.step);
            return;
          }
          apply(clampValue(parsed, field));
        });
        rst.addEventListener("click", () => {
          delete ui.sampling[phase][field.key];
          renderAdvanced();
        });
      }
      q(".dft", row).textContent = T("官方默认 {0}", field.default);
      const range = q("[data-range]", row);
      range.min = String(field.min);
      range.max = String(field.max);
      range.step = String(field.step);
      const num = q("[data-num]", row);
      num.min = String(field.min);
      num.max = String(field.max);
      num.step = String(field.step);
      const value = ui.sampling[phase][field.key] ?? field.default;
      range.value = String(value);
      num.value = fmtNum(value, field.integer, field.step);
      q("[data-reset]", row).disabled = ui.sampling[phase][field.key] === undefined
        || ui.sampling[phase][field.key] === field.default;
    });
  }
}

function resetAdvanced() {
  const schema = state.schema;
  ui.cfg = null;
  ui.ode = null;
  ui.vae = "standard";
  ui.sampling = {abc: {}, semantic: {}};
  if (schema) $("fVae").value = "standard";
  renderAdvanced();
  toast(T("高级参数已复位到官方默认"), "ok");
}

/* ------------------------------------------------------------------ 预计耗时 */
function targetDevice() {
  if (state.model.state === "loaded" && state.model.device) return state.model.device;
  return ui.device === "auto" ? (state.model.default_device || "cpu") : ui.device;
}

/* 歌词长度：中日韩按字、英文按词折算，用来把参考任务的时间按篇幅缩放 */
function lyricUnits(text) {
  const clean = String(text || "").replace(/\[[^\]]*\]/g, " ");
  const cjk = (clean.match(/[\u3400-\u9fff]/g) || []).length;
  const words = (clean.match(/[A-Za-z]+/g) || []).length;
  return cjk + words * 1.4;
}

function referenceJob(device) {
  const pool = state.jobs.filter((job) => job.status === "complete"
    && job.artifacts?.["audio.flac"] && job.result?.timing?.e2e_seconds);
  return pool.find((job) => (job.device || "cpu") === device) || pool[0] || null;
}

function renderCost() {
  const count = Number.parseInt($("fVar").value, 10) || 1;
  const device = targetDevice();
  const ref = referenceJob(device);
  const queueAhead = state.jobs.filter((job) => job.status === "running" || job.status === "queued").length;
  $("costQ").textContent = String(queueAhead);
  const list = $("costUl");
  if (!ref) {
    $("costT").textContent = "—";
    list.innerHTML = `<li><span>${esc(T("尚无本机实测数据"))}</span><b>${esc(T("跑完第一首后这里换成真实构成"))}</b></li>`;
    return;
  }
  const timing = ref.result.timing || {};
  const one = timing.e2e_seconds || 0;
  const refUnits = ref.lyrics_units ?? lyricUnits(ref.requested?.lyrics);
  const nowUnits = lyricUnits($("fLyrics").value);
  const ratio = refUnits > 0 && nowUnits > 0 ? Math.min(3, Math.max(0.4, nowUnits / refUnits)) : 1;
  const estimate = one * ratio * count;
  $("costT").textContent = (ratio === 1 ? "" : "≈") + fmtClock(estimate);
  const rows = [
    [T("规划乐谱"), timing.abc?.seconds],
    [T("语义生成（自回归）"), timing.semantic?.seconds],
    [T("非自回归合成（流匹配）"), timing.nar_seconds],
    [T("解码导出 FLAC（48kHz 立体声）"), timing.vae_seconds],
  ];
  const refDevice = ref.device || "cpu";
  list.innerHTML = rows.filter(([, value]) => Number.isFinite(value))
    .map(([label, value]) => `<li><span>${esc(label)}</span><b class="mono">${esc(fmtStamp(value))}</b></li>`)
    .join("") +
    `<li style="color:var(--text3)"><span>${esc(T("本机实测基准 · {0}", refDevice === "cuda" ? T("显卡") : "CPU"))}` +
    ` <span data-notr>${esc(ref.id)}</span></span>` +
    `<b class="mono">${esc(T("{0} 秒音频 / 耗时 {1}", Number(ref.duration || 0).toFixed(1), fmtStamp(one)))}</b></li>` +
    (ratio === 1 ? "" : `<li style="color:var(--text3)"><span>${esc(T("当前歌词篇幅为基准的 {0} 倍", ratio.toFixed(2)))}</span>` +
      `<b class="mono">${esc(fmtClock(estimate))}</b></li>`) +
    (refDevice !== device ? `<li style="color:var(--txt-warn)"><span>${esc(T("基准是 {0} 任务，与当前 {1} 不同，只能看量级",
      refDevice === "cuda" ? T("显卡") : "CPU", device === "cuda" ? T("显卡") : "CPU"))}</span></li>` : "") +
    (count > 1 ? `<li style="color:var(--text3)"><span>${esc(T("候选 {0} 个 · 队列逐个跑", count))}</span>` +
      `<b class="mono">${esc(fmtClock(estimate))}</b></li>` : "");
}

/* ------------------------------------------------------------------ 生成 */
/* 报错必须指向那个输入框：它可能在半屏之外，只弹一句 toast 等于没说 */
function need(field, message) {
  field.scrollIntoView({block: "center", behavior: "smooth"});
  field.focus({preventScroll: true});
  toast(T(message), "bad");
}

const firstLyricLine = (lyrics) => (String(lyrics || "").split("\n").map((line) => line.trim())
  .find((line) => line && !line.startsWith("[")) || "").slice(0, 12);

let songSubmitting = false;

/* 「生成歌曲」与「只出谱」共用：校验必填 → 结构检查 → 装配请求体。
   返回 null 表示已用 need() 指到出问题的输入框，调用方直接收尾。 */
async function composeSong(type) {
  const style = styleFromControls();
  const lyrics = $("fLyrics").value.trim();
  if (!style) { need($("fStyle"), "风格描述为空 —— 至少要写语言或流派"); return null; }
  if (!lyrics) { need($("fLyrics"), "歌词为空"); return null; }
  await lintLyrics();
  const payload = {
    type, style, lyrics, cot: ui.cot,
    device: ui.device === "auto" ? (state.model.default_device || "auto") : ui.device,
    title: "",
  };
  if (ui.cfg !== null) payload.cfg_scale = ui.cfg;
  if (ui.ode !== null) payload.ode_steps = ui.ode;
  const abc = buildSampling("abc");
  if (abc) payload.abc_sampling = abc;
  return {payload, lyrics};
}

async function generate() {
  if (songSubmitting) return [];
  songSubmitting = true;
  $("btnGen").disabled = true;
  const made = [];
  try {
    const composed = await composeSong("song");
    if (!composed) return made;
    const {payload, lyrics} = composed;
    const count = Number.parseInt($("fVar").value, 10) || 1;
    const seedRaw = $("fSeed").value.trim();
    const seed = seedRaw === "" ? null : Number.parseInt(seedRaw, 10);
    if (seedRaw !== "" && !Number.isInteger(seed)) {
      toast(T("种子要是整数，或留空表示随机"), "bad");
      return made;
    }
    if (seed !== null) payload.seed = seed;
    if (ui.vae && ui.vae !== "standard") payload.vae = ui.vae;
    const semantic = buildSampling("semantic");
    if (semantic) payload.semantic_sampling = semantic;
    for (let index = 0; index < count; index += 1) {
      const item = {...payload};
      if (count > 1) {
        const head = firstLyricLine(lyrics);
        item.title = head ? `候选 ${index + 1} · ${head}` : `候选 ${index + 1}`;
        if (index > 0) delete item.seed;
      }
      made.push(await createJob(item));
    }
    const loaded = state.model.state === "loaded";
    clearDraft();
    toast(T("已排队 {0} 个任务{1}", made.length, loaded ? "" : T(" · 生成前会先加载模型")), "ok");
    setGuideOff();
    go("studio");
  } catch (exc) {
    toast(message(exc), "bad");
  } finally {
    songSubmitting = false;
    $("btnGen").disabled = false;
    renderCost();
  }
  return made;
}

/* 只出谱：约 1 分钟先看到乐谱，满意再点卡上的「渲染成歌」。不渲染音频。 */
let planSubmitting = false;

async function generatePlan() {
  if (planSubmitting) return;
  planSubmitting = true;
  $("btnPlan").disabled = true;
  try {
    const composed = await composeSong("plan");
    if (!composed) return;
    await createJob(composed.payload);
    clearDraft();
    toast(T("已排队 · 先出乐谱，完成后点卡上的「渲染成歌」"), "ok");
    setGuideOff();
    go("studio");
  } catch (exc) {
    toast(message(exc), "bad");
  } finally {
    planSubmitting = false;
    $("btnPlan").disabled = false;
    renderCost();
  }
}

/* ------------------------------------------------------------------ 队列卡片 */
const BADGE = {
  running: ["run", "生成中", "clock"],
  queued: ["queue", "排队中", ""],
  complete: ["done", "已完成", "check"],
  failed: ["fail", "失败", "warn"],
  cancelled: ["fail", "已取消", "x"],
};

function jobName(job) {
  if (job.title) {
    const candidate = /^候选 (\d+) · (.+)$/.exec(job.title);
    return candidate ? T("候选 {0} · {1}", candidate[1], candidate[2]) : job.title;
  }
  const head = job.lyrics_head || firstLyricLine(job.requested?.lyrics);
  return head ? head.slice(0, 14) : T("未命名任务");
}

function stageBars(job) {
  const stage = state.stage && state.stage.job === job.id ? state.stage : null;
  const phase = stage?.phase || "plan";
  const activeIndex = Math.max(0, PHASES.indexOf(phase));
  const ratio = stage && stage.total ? Math.min(1, (stage.completed || 0) / stage.total) : 0;
  const seg = (index) => {
    const cls = index < activeIndex ? "done" : index === activeIndex ? "act" : "";
    return `<span class="sg ${cls}"></span>`;
  };
  const labels = [T("规划乐谱"), T("语义生成"), T("非自回归合成"), T("解码导出")];
  const percent = stage && stage.total ? Math.round(ratio * 100) : null;
  const line = [labels[activeIndex], percent !== null ? `${percent}%` : "",
    stage?.elapsed ? `${T("已用")} ${fmtStamp(stage.elapsed)}` : ""].filter(Boolean).join(" · ");
  return `<div class="stagebar">${PHASES.map((_, index) => seg(index)).join("")}</div>
    <div class="stageline">${esc(line)}</div>`;
}

/* 失败原因映射成人话；匹配不到就只显示原始错误。 */
function failTip(error) {
  const e = String(error || "");
  const map = [
    [/out of memory|显存不足|CUDA OOM/i, T("显存不足：改用 CPU 生成，或把歌词缩短到 2 段以内")],
    [/memoryerror|allocate|memory/i, T("内存不足：候选数量改成 1，或先关掉其他程序")],
    [/写出产物前被终止|before it wrote/i, T("进程在写出产物前结束了：多是显存/内存不足或手动终止，先看任务目录里的 run.log")],
    [/服务重启，任务中断/, T("服务重启打断了任务：模型加载后重新生成即可")],
    [/缺少产物|missing/i, T("源任务产物缺失：请重新生成源任务后再试")],
    [/style and lyrics are required/i, T("风格和歌词是必填的")],
    [/abc score is empty/i, T("谱面是空的：先检查谱面再重渲")],
    [/未安装|not installed/i, T("缺少组件：按部署文档安装后重试")],
    [/not found/i, T("源任务找不到：可能已被删除")],
  ];
  for (const [re, tip] of map) if (re.test(e)) return tip;
  return null;
}

const hasAudio = (job) => !!job.artifacts?.["audio.flac"];

/* 下载文件名给歌名，编号兜底：只靠编号的话，下载下来分不清是哪首 */
function dlName(job) {
  const base = String(job?.title || job?.lyrics_head || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 48);
  return `${base || "yue2"} - ${job?.id || Date.now()}.flac`;
}

function jobCard(job) {
  const [kind, label, glyph] = BADGE[job.status] || ["queue", job.status, ""];
  const badge = `<span class="badge ${kind}">${glyph ? icon(glyph) : ""}${esc(T(label))}</span>`;
  const demoBadge = job.demo ? `<span class="badge">${esc(T("示例"))}</span>` : "";
  const actions = [];
  if (job.status === "running" || job.status === "queued") {
    actions.push(`<button class="btn sm" data-act="cancel" type="button">${esc(T("取消"))}</button>`);
  } else if (job.status === "complete") {
    if (hasAudio(job)) {
      actions.push(`<button class="btn sm" data-act="play" type="button">${esc(T("试听"))}</button>`);
      actions.push(`<a class="btn sm ghost" data-dl href="${esc(audioUrl(job.id))}" download="${esc(dlName(job))}">${esc(T("下载"))}</a>`);
    }
    if (job.artifacts?.["score.abc"]) actions.push(`<button class="btn sm ghost" data-act="score" type="button">${esc(T("乐谱"))}</button>`);
    actions.push(`<button class="btn sm ghost" data-act="again" type="button">${esc(T("复制参数再来"))}</button>`);
    if (job.type === "plan" && !hasAudio(job)) {
      actions.push(job.truncated
        ? `<button class="btn sm" type="button" disabled title="${esc(T("谱面被截断，不能直接渲染"))}">${esc(T("渲染成歌"))}</button>`
        : `<button class="btn sm" data-act="render" type="button">${esc(T("渲染成歌"))}</button>`);
    }
  } else {
    actions.push(`<button class="btn sm" data-act="reuse" type="button">${esc(T("改参数重试"))}</button>`);
  }
  actions.push(`<button class="btn sm ghost" data-act="detail" type="button" aria-label="${esc(T("任务详情"))}">${esc(T("详情"))}</button>`);

  let tail = "";
  if (job.status === "running") tail = `<div class="stages">${stageBars(job)}</div>`;
  else if (job.status === "queued") tail = `<div class="sub" style="margin-top:var(--sp3)">${esc(T("排队中 · 本机并发恒为 1，前面还有 {0} 个任务",
    state.jobs.filter((item) => item.status === "running").length))}</div>`;
  else if (job.status === "complete") {
    tail = `<div class="metrics">
        ${hasAudio(job) ? `<span>${esc(T("时长"))} <b class="mono">${esc(Number(job.duration || 0).toFixed(1))}s</b></span>` : ""}
        <span>${esc(T("耗时"))} <b class="mono">${esc(fmtStamp(job.seconds))}</b></span>
        ${job.artifacts?.["score.abc"] ? `<span>${esc(T("含乐谱"))}</span>` : ""}
        ${job.truncated ? `<span class="tk w">${esc(T("截断"))} ${esc(T("是"))}</span>` : ""}
      </div>` +
      (!hasAudio(job) ? `<div class="sub" style="margin-top:var(--sp3)">${esc(job.type === "plan" && job.truncated
        ? T("谱面被截断：请改短歌词重新生成，或在乐谱页修正后再渲染")
        : T("只出谱任务 · 还没有音频，点「渲染成歌」生成完整歌曲"))}</div>` : "");
  } else {
    const tip = failTip(job.error);
    const human = humanError(job.error) || T(job.error || "任务在写出产物前被终止");
    tail = `<div class="note bad" style="margin-top:var(--sp3)">${esc(human)}` +
      (tip ? `<div class="sub" style="margin-top:var(--sp2)">${esc(tip)}</div>` : "") + `</div>`;
  }

  return `<div class="jobc${job.status === "running" ? " live" : ""}" data-job="${esc(job.id)}">
    <div class="jt">
      <div class="jname">${notr(jobName(job))}</div>${demoBadge}${badge}
      <div class="jid mono" data-notr>${esc(job.id)}</div>
      <div class="acts">${actions.join("")}</div>
    </div>
    ${job.style ? `<div class="jstyle" data-notr>${esc(job.style)}</div>` : ""}
    ${tail}</div>`;
}

/* ------------------------------------------------------------------ 新手引导 / 教程 / 巡览 */
const GUIDE_KEY = "yue2.guide";
const TOUR_KEY = "yue2.tour";

function guideOff() {
  try { return localStorage.getItem(GUIDE_KEY) === "off"; } catch (err) { return false; }
}

/* 关掉引导：点「知道了」或成功生成第一首之后就不再打扰。 */
function setGuideOff() {
  try { localStorage.setItem(GUIDE_KEY, "off"); } catch (err) { /* 无痕模式下只关这一次 */ }
  const guide = $("guide");
  if (guide) guide.hidden = true;
}

function tourSeen() {
  try { return localStorage.getItem(TOUR_KEY) === "seen"; } catch (err) { return false; }
}

function markTourSeen() {
  try { localStorage.setItem(TOUR_KEY, "seen"); } catch (err) { /* 无痕模式：本次会话内不重复弹 */ }
}

/* 引导三步：第 1 步的措辞取决于表单里到底有没有东西可改。
   文案只写中文，英文界面交给 trDom 在 renderGuide 末尾统一翻。 */
function guideSteps() {
  const filled = !!(styleFromControls() && $("fLyrics").value.trim());
  return [
    filled
      ? ["范例已经填好了", "风格和歌词都在下面，想快就直接跳到第 3 步"]
      : ["先写风格和歌词", "风格写语言或流派就够；不写也行，点「载入范例」填一套"],
    filled
      ? ["想改就改", "风格点标签增删，歌词按 [Verse] / [Chorus] 分段"]
      : ["下面的选项可以先不管", "规划模式、候选数量都有默认值，改天再说"],
    ["点底部「生成歌曲」或「只出谱」", "耗时估算就在按钮左边；生成中可以离开这一页，按 1–5 键切换视图"],
  ];
}

function renderGuide() {
  const guide = $("guide");
  if (!guide) return;
  guide.innerHTML = guideSteps().map(([title, note], index) =>
    `<div class="st"><span class="n">${index + 1}</span><div><b>${esc(title)}</b>` +
    `<em>${esc(note)}</em></div></div>`).join("") +
    `<div class="gactions">` +
    `<button class="btn sm ghost" id="btnGuideTour" type="button">${esc("界面巡览")}</button>` +
    `<button class="btn sm ghost" id="btnGuidePage" type="button">${esc("图文教程")}</button>` +
    `<button class="btn sm ghost" id="btnGuideOff" type="button">${esc("知道了")}</button>` +
    `</div>`;
  if (getLang() === "en") trDom(guide);
  guide.hidden = guideOff();
}

/* ------------------------------------------------------------------ 教程页 */
function demoJob() {
  return state.jobs.find((job) => job.demo && job.status === "complete") || null;
}

function renderGuideView() {
  const job = demoJob();
  const note = $("demoNote");
  if (!note) return;
  note.textContent = job
    ? T("示例曲已在曲库：{0} 秒，带可编辑乐谱与逐字歌词时间轴。", Number(job.duration || 0).toFixed(0))
    : T("示例曲还没导入：把 demo/showcase 放回项目根目录，重启后会自动出现在曲库。");
  $("btnDemoPlay").disabled = !job;
  $("btnDemoUse").disabled = !job;
  $("btnDemoScore").disabled = !job;
}

/* ------------------------------------------------------------------ 界面巡览 */
const TOUR_STEPS = [
  {view: "studio", target: ".rail", title: "五个工作区", body: "创作、乐谱、曲库、教程、系统。数字键 1–5 也能直接切换。"},
  {view: "studio", target: "#fPreset", title: "先用一个范例起步", body: "下拉挑一套风格，点「载入范例」会把风格和歌词一起填好；之后随便改。"},
  {view: "studio", target: "#fStyle", title: "风格写在这里", body: "语言、流派、乐器、BPM 用英文逗号分隔。上面的标签只是帮着加词，原文可以直接改。"},
  {view: "studio", target: "#fLyrics", title: "歌词按段落写", body: "每行 7–13 个字，用 [Verse] / [Chorus] 分段。「检查结构」会提示过长或空段落。"},
  {view: "studio", target: ".modes", title: "规划模式", body: "「旋律 + 和弦」会先产出可读可改的乐谱；「不规划」最快，但没有谱可以改。"},
  {view: "studio", target: "#dock", title: "生成与耗时", body: "「生成歌曲」一次做到音频；「只出谱」约 1 分钟先看谱。左边是根据本机实测折算的预计耗时。"},
  {view: "library", target: "#v-library .vhead", title: "曲库与示例", body: "每条任务都能试听、下载、复制参数；选两条进入 A/B 盲听。内置示例曲「示例曲 · 晚风」就在这里。"},
  {view: "library", target: ".trans", title: "底部播放器", body: "空格播放/暂停，点波形跳转，展开「歌词」能跟着逐字时间轴唱；A/B 切换也在这条上。"},
];

let tourIndex = -1;

function startTour(index = 0) {
  if (!TOUR_STEPS.length) return;
  markTourSeen();
  tourIndex = Math.max(0, Math.min(index, TOUR_STEPS.length - 1));
  $("tour").hidden = false;
  document.body.classList.add("touring");
  showTourStep();
}

function endTour() {
  tourIndex = -1;
  $("tour").hidden = true;
  document.body.classList.remove("touring");
}

function tourViewport() {
  const doc = document.documentElement;
  return {
    width: Math.min(window.innerWidth, doc.clientWidth || window.innerWidth),
    height: Math.min(window.innerHeight, doc.clientHeight || window.innerHeight),
  };
}

function tourCardPosition(rect) {
  const card = $("tourCard");
  const hole = $("tourHole");
  const margin = 14;
  const {width, height} = tourViewport();
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  if (!rect) {
    hole.hidden = true;
    card.style.left = `${Math.max(margin, (width - cw) / 2)}px`;
    card.style.top = `${Math.max(margin, (height - ch) / 2)}px`;
    return;
  }
  hole.hidden = false;
  const pad = 6;
  hole.style.left = `${rect.left - pad}px`;
  hole.style.top = `${rect.top - pad}px`;
  hole.style.width = `${rect.width + pad * 2}px`;
  hole.style.height = `${rect.height + pad * 2}px`;
  const clampX = (value) => Math.min(Math.max(margin, value), Math.max(margin, width - cw - margin));
  const clampY = (value) => Math.min(Math.max(margin, value), Math.max(margin, height - ch - margin));
  const tall = rect.height > height * 0.4;
  let left;
  let top;
  if (tall && width - rect.right >= cw + margin) {
    left = rect.right + margin;
    top = rect.top;
  } else if (tall && rect.left >= cw + margin) {
    left = rect.left - cw - margin;
    top = rect.top;
  } else if (height - rect.bottom >= ch + margin) {
    left = rect.left;
    top = rect.bottom + margin;
  } else if (rect.top >= ch + margin) {
    left = rect.left;
    top = rect.top - ch - margin;
  } else {
    left = (width - cw) / 2;
    top = (height - ch) / 2;
  }
  card.style.left = `${clampX(left)}px`;
  card.style.top = `${clampY(top)}px`;
}

function showTourStep() {
  const step = TOUR_STEPS[tourIndex];
  if (!step) return endTour();
  if (step.view !== ui.view) go(step.view);
  const target = q(step.target);
  $("tourStep").textContent = T("第 {0} 步 / 共 {1} 步", tourIndex + 1, TOUR_STEPS.length);
  $("tourTitle").textContent = T(step.title);
  $("tourBody").textContent = T(step.body);
  $("tourPrev").disabled = tourIndex === 0;
  $("tourNext").textContent = tourIndex === TOUR_STEPS.length - 1 ? T("完成") : T("下一步");
  if (target) target.scrollIntoView({block: "center", inline: "nearest"});
  requestAnimationFrame(() => {
    tourCardPosition(target ? target.getBoundingClientRect() : null);
  });
}

function tourNext() {
  if (tourIndex < 0) return;
  if (tourIndex >= TOUR_STEPS.length - 1) return endTour();
  tourIndex += 1;
  showTourStep();
}

function tourPrev() {
  if (tourIndex <= 0) return;
  tourIndex -= 1;
  showTourStep();
}

function queueSig(job, running) {
  const stage = state.stage && state.stage.job === job.id
    ? [state.stage.phase, state.stage.completed, state.stage.total, state.stage.elapsed].join("|") : "";
  return [getLang(), job.status, job.type, job.title, job.lyrics_head, job.style,
    job.truncated ? 1 : 0, job.demo ? 1 : 0, job.error, job.duration, job.seconds, job.seed,
    hasAudio(job) ? 1 : 0, job.artifacts?.["score.abc"] ? 1 : 0,
    job.status === "queued" ? running : 0, stage].join("|");
}

function renderQueue() {
  const host = $("queue");
  const live = state.jobs.filter((job) => job.status === "running" || job.status === "queued");
  const done = state.jobs.filter((job) => job.status !== "running" && job.status !== "queued").slice(0, 4);
  const rows = [...live, ...done];
  const running = live.filter((job) => job.status === "running").length;
  $("qBadge").textContent = T("{0} 运行 · {1} 排队", running, live.length - running);
  if (!rows.length) {
    host.innerHTML = `<div class="sub">${esc(T("还没有任务 · 填好风格与歌词，再点底部「生成歌曲」"))}</div>`;
    return;
  }
  renderKeyed(host, rows, "job", (job) => queueSig(job, running), jobCard);
}

/* stage 事件每秒来好几条：只重画正在跑那张卡的进度条，别整队重建 */
function paintQueueStage() {
  const id = state.stage?.job;
  if (!id) return;
  const slot = $("queue").querySelector(`[data-job="${CSS.escape(id)}"] .stages`);
  if (slot) slot.innerHTML = stageBars(state.byId.get(id) || {id});
}

async function removeJob(id) {
  const ok = await confirmDialog({
    title: T("删除任务"),
    body: `${esc(T("把这条任务移入回收站？"))}<br><span class="mono" data-notr>${esc(id)}</span>`,
    ok: T("移入回收站"), cancel: T("取消"), danger: true,
    note: T("产物目录会被移动到 runs/_trash，索引里的记录同时删除；磁盘上的文件不会立刻消失。"),
  });
  if (!ok) return;
  await deleteJob(id);
  if (ui.track === id) clearTrack();
  if (ui.ab.includes(id)) {
    ui.ab = ui.ab.filter((item) => item !== id);
    renderLibrary();
  }
  toast(T("已移入回收站"), "ok");
}

async function onJobAction(action, id) {
  const job = state.byId.get(id) || state.jobs.find((item) => item.id === id);
  if (!job) return;
  try {
    if (action === "cancel") {
      const ok = await confirmDialog({
        title: T("取消这个任务？"),
        body: `${esc(T("还没开始的任务会直接出队；正在跑的任务会在最近的阶段边界停下，已花掉的时间不会退回。"))}` +
          `<br><span class="mono" data-notr>${esc(job.id)}</span>`,
        ok: T("取消任务"), cancel: T("继续跑"), danger: true,
      });
      if (!ok) return;
      const result = await cancelJob(id);
      toast(result?.effective === "queued"
        ? T("已取消 · 该任务还在排队，没有开始生成")
        : T("取消请求已发出 · 非自回归与解码阶段没有取消点，将在当前阶段结束后停止"), "warn");
    } else if (action === "play") {
      playJob(id);
    } else if (action === "score") {
      selectScoreJob(id);
      go("score");
    } else if (action === "reuse") {
      // 列表行只有歌词摘要，回填要的是全文
      const detail = job.requested?.lyrics !== undefined ? job : await loadJob(id);
      await reuseParams(detail);
    } else if (action === "again") {
      // 同参换一首：种子清空，交给服务端随机
      const detail = job.requested?.lyrics !== undefined ? job : await loadJob(id);
      await reuseParams(detail, {fresh: true});
    } else if (action === "render") {
      await createJob({type: "staged", source: id});
      toast(T("已排队 · 正在从乐谱渲染成歌"), "ok");
      go("studio");
    } else if (action === "detail") {
      const detail = await loadJob(id);
      openJobModal(detail);
    } else if (action === "del") {
      await removeJob(id);
    }
  } catch (exc) {
    toast(message(exc), "bad");
  }
}

async function reuseParams(job, {fresh = false} = {}) {
  if (!await confirmOverwrite()) return false;
  const request = job.requested || {};
  const style = request.style || "";
  $("fStyle").value = style;
  $("fLyrics").value = request.lyrics || "";
  $("fSeed").value = fresh || job.seed === null || job.seed === undefined ? "" : String(job.seed);
  const bpm = /(\d{2,3})\s*BPM/i.exec(style);
  if (bpm) $("fBpm").value = bpm[1];
  const lang = /^(Mandarin|English|Cantonese|Japanese)/.exec(style);
  if (lang) $("fLang").value = lang[1];
  ui.cot = request.cot || job.cot || "full";
  qa(".mode").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.cot === ui.cot)));
  ui.cfg = request.cfg_scale ?? null;
  ui.ode = job.ode_steps ?? null;
  ui.vae = job.vae || "standard";
  ui.sampling = {abc: {...(request.abc_sampling || {})}, semantic: {...(request.semantic_sampling || {})}};
  if (job.device === "cpu" || job.device === "cuda") ui.device = job.device;
  syncChips();
  renderAdvanced();
  renderTopbar();
  go("studio");
  markFormBase();
  saveDraft();
  toast(fresh
    ? T("参数已回填 · 种子已清空（留空 = 随机），点「生成歌曲」会出一首新的")
    : T("参数已回填：风格、歌词、种子、模式、高级参数与设备都还原了"), "ok");
  return true;
}

/* 纯乐谱任务：回填同一份参数、清空种子，直接排一首新的 */
async function renderPlanJob(id) {
  const job = state.byId.get(id);
  if (!job) return;
  if (job.truncated) return toast(T("这条任务的乐谱被截断了，直接渲染会得到残曲"), "warn");
  if (!await reuseParams(job, {fresh: true})) return;
  closeModal($("jobModal"));
  generate();
}

/* ------------------------------------------------------------------ 任务详情 */
function openJobModal(job) {
  const request = job.requested || {};
  const result = job.result || {};
  const timing = result.timing || {};
  const schema = state.schema || {};
  const odeDefault = schema.ode_steps?.default;
  const samplingText = (stage) => {
    const values = request[`${stage}_sampling`];
    if (!values || !Object.keys(values).length) return null;
    return Object.entries(values).map(([key, value]) => `${key}=${value}`).join(", ");
  };
  const samples = [["abc", T("乐谱")], ["semantic", T("语义")]]
    .map(([stage, label]) => [label, samplingText(stage)])
    .filter(([, value]) => value);
  const phaseSeconds = [
    [T("乐谱"), timing.abc?.seconds],
    [T("语义"), timing.semantic?.seconds],
    [T("非自回归"), timing.nar_seconds],
    [T("解码"), timing.vae_seconds],
  ].filter(([, seconds]) => Number.isFinite(seconds) && seconds > 0)
    .map(([label, seconds]) => `${label} ${Number(seconds).toFixed(1)}s`).join(" · ");
  const candidate = /^候选 (\d+)/.exec(job.title || "");
  const rows = [
    [T("编号"), `<span class="mono" data-notr>${esc(job.id)}</span>`, 2],
    [T("状态"), esc(T(BADGE[job.status]?.[1] || job.status))],
    [T("类型"), `<span class="mono" data-notr>${esc(job.type)}</span>`],
    [T("规划模式"), `<span class="mono" data-notr>${esc(job.cot || "—")}</span>`],
    [T("设备"), esc(job.device === "cuda" ? T("显卡") : "CPU")],
    [T("种子"), `<span class="mono" data-notr>${esc(job.seed ?? T("随机"))}</span>`],
    [T("创建"), `<span class="mono" data-notr>${esc(fmtDate(job.created_at))}</span>`],
    [T("音频时长"), `<span class="mono" data-notr>${esc(job.duration ? `${Number(job.duration).toFixed(1)} s · 48 kHz` : "—")}</span>`],
    [T("端到端耗时"), `<span class="mono" data-notr>${esc(fmtStamp(timing.e2e_seconds || job.seconds))}</span>`],
    [T("文本引导强度"), `<span class="mono" data-notr>${request.cfg_scale === null || request.cfg_scale === undefined
      ? esc(T("官方默认")) : esc(String(request.cfg_scale))}</span>`],
    [T("求解步数"), `<span class="mono" data-notr>${job.ode_steps === null || job.ode_steps === undefined
      ? esc(`${odeDefault ?? "—"}${T("（默认）")}`) : esc(String(job.ode_steps))}</span>`],
    [T("解码器"), `<span class="mono" data-notr>${esc(job.vae || "standard")}${job.vae ? "" : esc(T("（默认）"))}</span>`],
    [T("采样参数"), `<span class="mono" data-notr style="font-size:12px">${samples.length
      ? samples.map(([label, value]) => `${esc(label)}: ${esc(value)}`).join(" · ")
      : esc(T("官方默认"))}</span>`, 2],
    [T("阶段耗时"), `<span class="mono" data-notr style="font-size:12px">${phaseSeconds ? esc(phaseSeconds) : "—"}</span>`, 2],
    [T("截断"), `<span class="mono ${job.truncated ? "tk w" : "tk"}">${esc(job.truncated ? T("是") : T("否"))}</span>`],
  ];
  if (candidate) rows.push([T("候选"), `<span class="mono" data-notr>${esc(T("第 {0} 个", candidate[1]))}</span>`]);
  if (job.parent_id) rows.push([T("源任务"), `<span class="mono" data-notr>${esc(job.parent_id)}</span>`]);
  const decoders = state.schema?.decoders || [];
  const canRedecode = !!job.artifacts?.["latent.npy"] && decoders.length && job.status === "complete";
  const planOnly = planOnlyJob(job);
  const dirButtons = job.demo ? "" :
    `<div class="inline" style="margin-top:var(--sp3)">` +
    `<button class="btn sm ghost" type="button" data-m="log">${esc(T("查看日志"))}</button>` +
    `<button class="btn sm ghost" type="button" data-m="reveal">${esc(T("打开任务目录"))}</button></div>`;
  $("jobBody").innerHTML =
    `<div class="insp">${rows.map(([key, value, span]) =>
      `<div class="kv"${span ? ` style="grid-column:span ${span}"` : ""}><div class="k">${esc(key)}</div><div class="v" style="font-size:${span ? 13 : 14}px">${value}</div></div>`).join("")}</div>` +
    (job.error ? "" : dirButtons) +
    (job.error
      ? `<div class="note bad" style="margin-top:var(--sp4)"><b>${esc(job.status === "cancelled" ? T("取消原因") : T("失败原因"))}</b> · ` +
        `${esc(humanError(job.error) || T(job.error))}` +
        (failTip(job.error) ? `<div class="sub" style="margin-top:var(--sp2)">${esc(failTip(job.error))}</div>` : "") +
        dirButtons + `</div>`
      : "") +
    (canRedecode
      ? `<div class="field" style="margin-top:var(--sp4)"><label for="jobVae">${esc(T("换解码器重导"))}</label>` +
        `<div class="inline" style="gap:var(--sp2)">` +
        `<select class="inp" id="jobVae" style="flex:1">${decoders.map((item) =>
          `<option value="${esc(item.value)}"${item.available ? "" : " disabled"}>${esc(T(item.label))}` +
          `${item.available ? "" : ` · ${esc(T("未安装"))}`}</option>`).join("")}</select>` +
        `<button class="btn" type="button" data-m="redecode">${esc(T("重解码"))}</button></div>` +
        `<div class="hint">${esc(T("用同一份 latent 重新解码导出，不用重新生成；会排队成一个新任务。"))}</div></div>`
      : "") +
    `<div class="field" style="margin-top:var(--sp4)"><label>${esc(T("风格原文"))}</label>` +
    `<div class="inp mono" data-notr style="min-height:auto;padding:var(--sp3)">${esc(request.style || "—")}</div></div>` +
    `<div class="field" style="margin-top:var(--sp3)"><label>${esc(T("歌词"))}</label>` +
    `<div class="inp" data-notr style="min-height:auto;padding:var(--sp3);white-space:pre-wrap;font-size:13px">${esc(request.lyrics || "—")}</div></div>` +
    (Object.keys(job.artifacts || {}).length
      ? `<details class="adv art" style="margin-top:var(--sp4)"><summary>${esc(T("产物文件（高级）"))}</summary>` +
        `<div class="art">${Object.keys(job.artifacts).map((name) =>
         `<a href="${esc(artifactUrl(job.id, name))}" data-notr download>${esc(name)}</a>`).join("")}</div></details>`
      : "");
  const foot = $("jobFoot");
  const reusable = job.status !== "running" && job.status !== "queued";
  foot.innerHTML =
    `<button class="btn ghost" type="button" data-m="close">${esc(T("关闭"))}</button>` +
    `<button class="btn ghost" type="button" data-m="fav" aria-pressed="${job.favorite ? "true" : "false"}">${esc(T(job.favorite ? "取消收藏" : "收藏"))}</button>` +
    (reusable && !job.demo ? `<button class="btn ghost" type="button" data-m="del">${esc(T("删除"))}</button>` : "") +
    (reusable ? `<button class="btn" type="button" data-m="reuse">${esc(T("复制参数到创作"))}</button>` : "") +
    (reusable && !job.demo ? `<button class="btn ghost" type="button" data-m="again">${esc(T("复制参数再来"))}</button>` : "") +
    (hasAudio(job) ? `<a class="btn ghost" data-dl href="${esc(audioUrl(job.id))}" download="${esc(dlName(job))}" style="text-decoration:none">${esc(T("下载音频"))}</a>` : "") +
    (planOnly ? `<button class="btn primary" type="button" data-m="render">${esc(T("渲染成歌"))}</button>` : "") +
    (job.status === "complete" && hasAudio(job) ? `<button class="btn primary" type="button" data-m="play">${esc(T("试听"))}</button>` : "");
  qa("[data-m]", $("jobModal")).forEach((button) => button.addEventListener("click", async () => {
    const which = button.dataset.m;
    if (which === "fav") {
      try {
        const updated = await updateJob(job.id, {favorite: !job.favorite});
        const on = !!updated.favorite;
        button.setAttribute("aria-pressed", String(on));
        button.textContent = T(on ? "取消收藏" : "收藏");
      } catch (exc) {
        toast(message(exc), "bad");
      }
      return;
    }
    if (which === "redecode") {
      const vae = $("jobVae")?.value || "standard";
      closeModal($("jobModal"));
      try {
        await createJob({type: "redecode", source: job.id, vae});
        toast(T("重解码已排队 · 用同一份 latent 换解码器重导"), "ok");
        go("studio");
      } catch (exc) {
        toast(message(exc), "bad");
      }
      return;
    }
    if (which === "log") {
      openLog(job);
      return;
    }
    if (which === "reveal") {
      await revealJob(job.id);
      return;
    }
    if (which === "reuse") {
      if (await reuseParams(job)) closeModal($("jobModal"));
      return;
    }
    if (which === "again") {
      if (await reuseParams(job, {fresh: true})) closeModal($("jobModal"));
      return;
    }
    if (which === "render") {
      renderPlanJob(job.id);
      return;
    }
    closeModal($("jobModal"));
    if (which === "play") playJob(job.id);
    if (which === "del") {
      try { await removeJob(job.id); } catch (exc) { toast(message(exc), "bad"); }
    }
  }));
  q("[data-close]", $("jobModal")).onclick = () => closeModal($("jobModal"));
  openModal($("jobModal"));
}

async function revealJob(id) {
  try {
    const data = await post(`/api/jobs/${encodeURIComponent(id)}/reveal`);
    toast(`${T("已打开任务目录")} ${data.opened}`, "ok");
  } catch (exc) {
    toast(message(exc), "bad");
  }
}

async function openLog(job) {
  ui.logJob = job.id;
  $("logPath").textContent = `${job.id} · .meta/run.log`;
  $("logBox").textContent = T("正在读取日志…");
  openModal($("logModal"));
  try {
    const data = await get(`/api/jobs/${encodeURIComponent(job.id)}/log?lines=600`);
    if (ui.logJob !== job.id) return;
    $("logBox").textContent = data.text || T("这个任务还没有日志");
    $("logBox").scrollTop = $("logBox").scrollHeight;
    $("logPath").textContent = `${data.path} · ${(data.size / 1024).toFixed(1)} KB`;
  } catch (exc) {
    $("logBox").textContent = exc instanceof ApiError && exc.status === 404
      ? T("这个任务还没有日志")
      : message(exc);
  }
}

/* ------------------------------------------------------------------ 曲库 */
const SORT_KEY = "yue2.sort";
const SORTS = {
  new: (a, b) => (b.created_at || 0) - (a.created_at || 0),
  old: (a, b) => (a.created_at || 0) - (b.created_at || 0),
  long: (a, b) => (b.duration || 0) - (a.duration || 0) || (b.created_at || 0) - (a.created_at || 0),
  eff: (a, b) => (b.seconds || 0) - (a.seconds || 0) || (b.created_at || 0) - (a.created_at || 0),
};

function libRows() {
  const needle = ui.search.trim().toLowerCase();
  const rows = state.jobs.filter((job) => {
    if (ui.filter === "complete" && job.status !== "complete") return false;
    if (ui.filter === "failed" && job.status !== "failed" && job.status !== "cancelled") return false;
    if (ui.filter === "favorite" && !job.favorite) return false;
    if (ui.filter === "truncated" && !job.truncated) return false;
    if (!needle) return true;
    return [job.id, job.title, job.style, job.lyrics_head, job.requested?.lyrics]
      .filter(Boolean).some((text) => String(text).toLowerCase().includes(needle));
  });
  return rows.sort(SORTS[ui.sort] || SORTS.new);
}

function planOnlyJob(job) {
  return job.type === "plan" && !hasAudio(job) && job.status === "complete";
}

function libCard(job) {
  const kind = job.status === "complete"
    ? (job.truncated ? ["run", "有截断"] : ["done", "已完成"])
    : job.status === "failed" ? ["fail", "失败"]
      : job.status === "cancelled" ? ["fail", "已取消"] : ["queue", BADGE[job.status]?.[1] || job.status];
  const selected = ui.ab.includes(job.id);
  const playable = job.status === "complete" && hasAudio(job);
  const planOnly = planOnlyJob(job);
  return `<button class="tcard${selected ? " sel" : ""}" type="button" data-lib="${esc(job.id)}"${
    playable ? "" : ` title="${esc(T("没有音频：点「详情」看参数，或到创作页的队列点「渲染成歌」"))}"`}>
    <span class="star${job.favorite ? " on" : ""}" data-star="${esc(job.id)}" role="button" tabindex="-1"
      aria-label="${esc(T("收藏"))}" aria-pressed="${job.favorite ? "true" : "false"}">${icon("star")}</span>
    <span class="thead"><span class="tico" aria-hidden="true">${icon(job.artifacts?.["score.abc"] ? "abc" : "music")}</span><span class="tn2">${notr(jobName(job))}</span></span>
    <span class="tm2">${esc(job.duration ? `${fmtClock(job.duration)}` : T("仅乐谱"))} · ${esc(job.device === "cuda" ? T("显卡") : "CPU")} · <span data-notr>${esc(fmtDate(job.created_at))}</span></span>
    <span class="rowb">${job.demo ? `<span class="state done">${esc(T("示例"))}</span>` : ""}
      ${playable ? `<span class="tplay" data-lplay="${esc(job.id)}" role="button" tabindex="-1" aria-label="${esc(T("试听"))}">${icon("play")}</span>` : ""}
      ${planOnly ? `<span class="tmore" data-render="${esc(job.id)}" role="button" tabindex="-1">${esc(T("渲染成歌"))}</span>` : ""}
      ${planOnly ? "" : `<span class="mono" data-notr style="font-size:12px;color:var(--text3)">${esc(job.cot || "")}</span>`}
      <span class="state ${kind[0]}">${esc(T(kind[1]))}</span>
      ${planOnly ? "" : `<span class="mono rseed" style="font-size:12px;color:var(--text3)">${esc(T("种子"))} <span data-notr>${esc(job.seed ?? "—")}</span></span>`}
      <span class="tmore" data-more="${esc(job.id)}" role="button" tabindex="-1" aria-label="${esc(T("详情"))}">${esc(T("详情"))}</span></span>
  </button>`;
}

/* 卡片签名：只列卡片上真的会画出来的字段，语言也算一份。
   签名没变就复用原节点，收藏/选中/进度变化只重画那一条。 */
function libSig(job) {
  return [getLang(), job.status, job.truncated ? 1 : 0, job.favorite ? 1 : 0, job.demo ? 1 : 0,
    job.artifacts?.["score.abc"] ? 1 : 0, hasAudio(job) ? 1 : 0, job.title, job.lyrics_head,
    job.duration, job.device, job.created_at, job.cot, job.seed, ui.ab.includes(job.id) ? 1 : 0].join("|");
}

async function toggleFavorite(id) {
  const job = state.byId.get(id);
  try {
    await updateJob(id, {favorite: !job?.favorite});
  } catch (exc) {
    toast(message(exc), "bad");
  }
}

/* 曲库行只有歌词摘要：详情要看全文，列表里没带就回源取一次 */
async function openJobFromCard(id) {
  try {
    const cached = state.byId.get(id);
    const detail = cached?.requested?.lyrics !== undefined ? cached : await loadJob(id);
    openJobModal(detail);
  } catch (exc) {
    toast(message(exc), "bad");
  }
}

/* 键控列表：按 id 复用节点，只有签名变了才重建那一条。
   比整块 innerHTML 省掉重复解析、绑定与布局，也不丢滚动位置。 */
const nodeSigs = new WeakMap();

function renderKeyed(host, items, keyAttr, sigOf, htmlOf) {
  const kept = new Map();
  for (const node of [...host.children]) {
    const key = node.dataset[keyAttr];
    if (key && !kept.has(key)) kept.set(key, node);
    else node.remove();
  }
  const nodes = items.map((item) => {
    const sig = sigOf(item);
    const old = kept.get(item.id);
    kept.delete(item.id);
    if (old && nodeSigs.get(old) === sig) return old;
    const holder = document.createElement("template");
    holder.innerHTML = htmlOf(item);
    const fresh = holder.content.firstElementChild;
    nodeSigs.set(fresh, sig);
    if (old) old.replaceWith(fresh);
    return fresh;
  });
  for (const node of kept.values()) node.remove();
  let cursor = host.firstElementChild;
  for (const node of nodes) {
    if (node === cursor) cursor = cursor.nextElementSibling;
    else host.insertBefore(node, cursor);
  }
}

function renderLibrary() {
  const rows = libRows();
  renderKeyed($("libGrid"), rows, "lib", libSig, libCard);
  $("libEmpty").hidden = rows.length > 0;
  $("libEmpty").textContent = ui.search.trim()
    ? T("没有匹配「{0}」的任务", ui.search.trim())
    : T("没有符合条件的任务");
  $("libSort").value = ui.sort;
  $("btnAB").textContent = T("A/B 对比（{0}）", ui.ab.length);
  $("btnAB").disabled = ui.ab.length !== 2;
}

function applyAB() {
  if (ui.ab.length !== 2) return;
  if (!ui.ab.every((id) => hasAudio(state.byId.get(id)))) {
    ui.ab = ui.ab.filter((id) => hasAudio(state.byId.get(id)));
    renderLibrary();
    return toast(T("A/B 只能选有音频的任务；纯乐谱任务先点「渲染成歌」"), "warn");
  }
  ui.side = "a";
  qa(".ab button").forEach((button) => {
    button.disabled = false;
    button.classList.toggle("on", button.dataset.ab === "a");
  });
  loadTrack(ui.ab[0]);
  toast(T("A/B 已就绪 · 切换时保留播放位置"), "ok");
}

/* ------------------------------------------------------------------ 乐谱 */
const TOKEN = /("[^"]*"|[Zz]\d*|\[[A-Za-z]:|\|[0-9.\]]*|[A-Ga-g][,']?\d*|\s|[\s\S])/g;

function highlightAbc(text) {
  return text.split("\n").map((line) => {
    if (/^%/.test(line)) return `<span class="hl-cm">${esc(line)}</span>`;
    if (/^V:\s*(Vocal|Ins)/.test(line)) return `<span class="hl-vc">${esc(line)}</span>`;
    if (/^[A-Za-z]:/.test(line)) return `<span class="hl-hd">${esc(line)}</span>`;
    let out = "";
    for (const match of line.match(TOKEN) || []) {
      const safe = esc(match);
      if (match[0] === '"') out += `<span class="hl-ck">${safe}</span>`;
      else if (/^[Zz]\d*$/.test(match)) out += `<span class="rd">${safe}</span>`;
      else if (match[0] === "|" || match[0] === "[") out += `<span class="bar">${safe}</span>`;
      else if (/^[A-Ga-g][,']?\d*$/.test(match)) out += `<span class="nt">${safe}</span>`;
      else out += safe;
    }
    return out;
  }).join("\n");
}

function scoreChoices() {
  return state.jobs.filter((job) => job.status === "complete" && job.artifacts?.["score.abc"]);
}

/* 未保存的谱面修改：只在本页生命周期内有效，刷新即丢，避免陈旧草稿覆盖服务端新谱。 */
const scoreDrafts = new Map();

function selectScoreJob(next) {
  if (!next || next === ui.scoreJob) return;
  if (ui.scoreAbc !== ui.scoreOriginal) scoreDrafts.set(ui.scoreJob, ui.scoreAbc);
  ui.scoreJob = next;
  ui.inspect = null;
  ui.rollPlan = null;
  ui.rollSel = null;
  ui.rollUndo = [];
  ui.rollError = "";
  $("toolNote").hidden = true;
}

async function renderScore() {
  const choices = scoreChoices();
  const note = $("scoreNote");
  const select = $("scoreJob");
  if (!choices.length) {
    select.innerHTML = "";
    select.disabled = true;
    $("btnInspect").disabled = true;
    $("btnRerender").disabled = true;
    $("btnCompare").disabled = true;
    $("btnStrip").disabled = true;
    $("btnInstr").disabled = true;
    $("btnRollFull").disabled = true;
    $("toolNote").hidden = true;
    $("btnAbcDl").setAttribute("aria-disabled", "true");
    note.hidden = false;
    note.className = "note";
    note.textContent = T("还没有带乐谱的完成任务 · 用「旋律 + 和弦」或「仅旋律」模式生成后，这里会出现可读可改的 score.abc");
    $("abcHl").innerHTML = "";
    $("gut").innerHTML = "";
    gutterLines = 0;
    $("abcEd").value = "";
    $("abcInsp").innerHTML = "";
    ui.rollPlan = null;
    ui.rollSel = null;
    ui.rollFor = "";
    ui.rollError = "";
    ui.rollUndo = [];
    setRollFocus(false);
    $("rollGrid").hidden = true;
    $("rollBar").hidden = true;
    $("rollNote").hidden = true;
    $("edwrap").hidden = ui.rollTab !== "text";
    $("rollMeta").textContent = "";
    $("rollBpm").value = "";
    $("rollSection").innerHTML = "";
    $("rollSel").textContent = rollSelectionText();
    return;
  }
  select.disabled = false;
  $("btnInspect").disabled = false;
  $("btnRerender").disabled = false;
  for (const id of ["btnCompare", "btnStrip", "btnInstr", "btnRollFull"]) $(id).disabled = false;
  select.innerHTML = choices.map((job) =>
    `<option value="${esc(job.id)}">${esc(jobName(job))} · ${esc(job.id)}</option>`).join("");
  if (!ui.scoreJob || !choices.some((job) => job.id === ui.scoreJob)) ui.scoreJob = choices[0].id;
  select.value = ui.scoreJob;
  note.hidden = false;
  note.className = "note";
  note.innerHTML = esc(T("乐谱可以直接改：改完点「改谱重渲染」，整曲会按新谱面重新渲染（约 10 分钟）。"));
  $("btnAbcDl").href = artifactUrl(ui.scoreJob, "score.abc");
  $("btnAbcDl").removeAttribute("aria-disabled");
  const jobId = ui.scoreJob;
  const dirty = ui.scoreLoadedJob === jobId && ui.scoreAbc !== ui.scoreOriginal;
  if (!dirty) {
    try {
      const data = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/score`).then((response) => response.json());
      if (ui.scoreJob !== jobId) return;
      ui.scoreOriginal = data.abc || "";
      const draft = scoreDrafts.get(jobId);
      ui.scoreAbc = draft ?? ui.scoreOriginal;
      if (draft) toast(T("已恢复上次未保存的修改 · 点「改谱重渲染」才会写回"), "warn");
    } catch (exc) {
      ui.scoreAbc = "";
      ui.scoreOriginal = "";
      toast(message(exc), "bad");
    }
  }
  ui.scoreLoadedJob = jobId;
  $("abcName").textContent = `${ui.scoreJob}/score.abc`;
  paintAbc();
  if (ui.inspect && ui.inspect.job === ui.scoreJob) paintInspect(ui.inspect.report);
  else $("abcInsp").innerHTML = `<div class="sub">${esc(T("点「检查谱面」看小节数、和弦数、时值与调号"))}</div>`;
  refreshRoll();
}

const UTF8 = new TextEncoder();
let abcPaintFrame = 0;
let gutterLines = -1;

function paintGutter(lines) {
  if (lines === gutterLines) return;
  gutterLines = lines;
  $("gut").innerHTML = Array.from({length: lines}, (_, index) => `<div>${index + 1}</div>`).join("");
}

/* 连续输入会一秒发几十个 input：高亮、行号、字节数和滚动对齐合并到一帧画一次 */
function scheduleAbcPaint() {
  if (abcPaintFrame) return;
  abcPaintFrame = requestAnimationFrame(() => {
    abcPaintFrame = 0;
    const lines = ui.scoreAbc.split("\n");
    $("abcHl").innerHTML = `${highlightAbc(ui.scoreAbc)}\n`;
    paintGutter(lines.length);
    $("abcMeta").textContent = T("{0} 行 · {1} B", lines.length, UTF8.encode(ui.scoreAbc).length);
    $("abcHl").scrollTop = $("abcEd").scrollTop;
    $("abcHl").scrollLeft = $("abcEd").scrollLeft;
    $("gut").style.transform = `translateY(${-$("abcEd").scrollTop}px)`;
  });
}

function paintAbc() {
  // 值没变就不回写，免得清掉光标、选区和撤销栈
  if ($("abcEd").value !== ui.scoreAbc) $("abcEd").value = ui.scoreAbc;
  gutterLines = -1;
  scheduleAbcPaint();
}

async function inspectScore() {
  if (!ui.scoreAbc.trim()) return toast(T("谱面是空的"), "bad");
  try {
    const report = await post("/api/score/inspect", {abc: ui.scoreAbc});
    ui.inspect = {job: ui.scoreJob, report};
    paintInspect(report);
    toast(T("谱面检查完成"), "ok");
  } catch (exc) {
    toast(message(exc), "bad");
  }
}

function paintInspect(report) {
  const voices = report.voices || {};
  const rows = [
    [T("速度"), `<span class="mono" data-notr>${esc(report.bpm ?? "—")} BPM</span>`],
    [T("拍号"), `<span class="mono" data-notr>${esc(report.meter ?? "—")}</span>`],
    [T("调号"), `<span class="mono" data-notr>${esc(report.key ?? "—")}</span>`],
    [T("小节数"), `<span class="mono" data-notr>${esc(report.measures ?? "—")}</span>`],
    [T("发声音符"), `<span class="mono" data-notr>${esc(report.notes ?? "—")}</span>`],
    [T("和弦标记"), `<span class="mono" data-notr>${esc(report.chords ?? "—")}</span>`],
    [T("标称时长"), `<span class="mono" data-notr>${esc(report.nominal_seconds ? `${Number(report.nominal_seconds).toFixed(1)} s` : "—")}</span>`],
    [T("声部"), `<span class="mono" data-notr>${esc(Object.keys(voices).join(" / ") || "—")}</span>`],
    [T("谱面指纹"), `<span class="mono" data-notr style="font-size:12px">${esc((report.sha256 || "").slice(0, 16))}…</span>`],
  ];
  $("abcInsp").innerHTML = rows.map(([key, value]) =>
    `<div class="kv"><div class="k">${esc(key)}</div><div class="v" style="font-size:14px">${value}</div></div>`).join("");
}

function setScoreText(text) {
  ui.scoreAbc = text;
  ui.inspect = null;
  paintAbc();
  $("abcInsp").innerHTML = `<div class="sub">${esc(T("谱面已修改 · 点「检查谱面」校验，或直接「改谱重渲染」"))}</div>`;
  scheduleRoll();
}

function toolNote(html, kind = "") {
  const note = $("toolNote");
  note.hidden = false;
  note.className = `note${kind ? ` ${kind}` : ""}`;
  note.innerHTML = html;
}

/* --------------------------------------------------------------- 音块图 */
const ROLL_TINTS = {Vocal: "#1C6E6B", Ins: "#8A5A16"};
const ROLL_LENGTHS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48];
const ROLL_BAND = 18;
const ROLL_CHORD = 16;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const ROLL_ZOOM_STEP = 1.25;
const ROLL_ZOOM_MIN = 0.35;
const ROLL_ZOOM_MAX = 6;
const ROLL_ZOOM_KEY = "yue2.rollZoom";
const clampZoom = (v) => Math.min(ROLL_ZOOM_MAX, Math.max(ROLL_ZOOM_MIN, v));
/* 画布不再无限长：超过 GPU 单张纹理边长会被拆块/退回软件路径，一帧就掉到几十毫秒；
   像素预算按设备像素算，16M ≈ 64MB 一张纹理，缩放到最大也稳。低 DPR 时按原生密度画。 */
const ROLL_MAX_TEXTURE = 16384;
const ROLL_MAX_PIXELS = 16e6;

function noteName(pitch) {
  return `${NOTE_NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;
}

let rollMonoFont = "";
function rollMono() {
  if (!rollMonoFont) {
    rollMonoFont = getComputedStyle(document.getElementById("abcHl") || document.body).fontFamily || "monospace";
  }
  return rollMonoFont;
}

/* 缩放系数：zoomX/zoomY 都是“自动档”的乘数，=1 时与改造前逐像素一致（零回归）。
   横向 auto = 铺满视口但每小节不少于 56px（太长就出横向滚动条）；纵向 auto = 全音域塞进视口高。
   width/contentH 是“内容尺寸”，主画布与音高轴都按它画，原生滚动条负责平移。 */
function rollGeom() {
  const plan = ui.rollPlan;
  const grid = $("rollGrid");
  if (!plan || !grid || grid.hidden || !grid.clientHeight) return null;
  const total = plan.bars.reduce((sum, bar) => sum + bar.dur, 0);
  if (!total) return null;
  const scroll = $("rollScroll");
  /* 轴现在贴在滚动容器内（sticky），可视画布宽要减掉 44px 轴宽 */
  const view = Math.max(240, (scroll ? scroll.clientWidth - 44 : grid.clientWidth - 44));
  const bars = Math.max(1, plan.bars_total);
  const perBar = Math.max(view / bars, 56) * ui.rollZoomX;
  const width = Math.max(1, Math.round(perBar * bars));
  const rows = Math.max(12, plan.pitch_max - plan.pitch_min + 3);
  const viewH = grid.clientHeight;
  const rowH = ((viewH - ROLL_BAND - ROLL_CHORD) / rows) * ui.rollZoomY;
  const height = ROLL_BAND + ROLL_CHORD + rows * rowH;
  return {plan, height, viewH, view, width, total, scale: width / total, rowH, rows,
          top: ROLL_BAND + ROLL_CHORD, high: plan.pitch_max + 1};
}

function rollX(geom, unit) { return unit * geom.scale; }
function rollY(geom, pitch) { return geom.top + (geom.high - pitch) * geom.rowH; }
function rollW(geom, dur) { return Math.max(3, dur * geom.scale - 0.8); }

function rollBlock(geom, note) {
  const height = Math.max(5, geom.rowH - 2.5);
  return {x: rollX(geom, note.start), w: rollW(geom, note.dur),
          y: rollY(geom, note.pitch) + 1.2, h: height};
}

function rollDpr(width, height) {
  const native = Math.min(2, window.devicePixelRatio || 1);
  const byTexture = ROLL_MAX_TEXTURE / Math.max(width, height);
  const byBudget = Math.sqrt(ROLL_MAX_PIXELS / Math.max(1, width * height));
  return Math.max(0.5, Math.min(native, byTexture, byBudget));
}

/* 尺寸同步落到 DOM（滚动范围与缩放锚点要立刻读到），绘制合并到下一帧：
   滚轮连发、连点、拖拽一帧只重绘一次。 */
let rollFrame = 0;

function rollPaint() {
  const geom = rollGeom();
  const canvas = $("rollCanvas");
  const axis = $("rollAxis");
  if (!geom) return;
  const dpr = rollDpr(geom.width, geom.height);
  const cssW = `${geom.width}px`;
  const cssH = `${geom.height}px`;
  const w = Math.max(1, Math.round(geom.width * dpr));
  const h = Math.max(1, Math.round(geom.height * dpr));
  const aw = Math.max(1, Math.round(44 * dpr));
  /* 赋相同的值也会清空画布，所以逐项比对再写 */
  if (canvas.style.width !== cssW) canvas.style.width = cssW;
  if (canvas.style.height !== cssH) canvas.style.height = cssH;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  if (axis.style.height !== cssH) axis.style.height = cssH;
  if (axis.width !== aw) axis.width = aw;
  if (axis.height !== h) axis.height = h;
  if (!rollFrame) rollFrame = requestAnimationFrame(() => { rollFrame = 0; rollDraw(); });
}

function rollDraw() {
  const geom = rollGeom();
  if (!geom) return;
  const canvas = $("rollCanvas");
  const axis = $("rollAxis");
  const mono = rollMono();
  /* 密度自适应：行太矮时圆角和粗描边会糊成一片，退回纯矩形 */
  const crisp = geom.rowH >= 6;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(canvas.width / geom.width, 0, 0, canvas.height / geom.height, 0, 0);
  ctx.fillStyle = "#FBF8F0";
  ctx.fillRect(0, 0, geom.width, geom.height);

  for (const section of geom.plan.sections) {
    const first = geom.plan.bars[section.from_bar];
    const last = geom.plan.bars[section.to_bar - 1];
    if (!first || !last) continue;
    const left = rollX(geom, first.start);
    const right = rollX(geom, last.start + last.dur);
    ctx.fillStyle = "rgba(28,110,107,.07)";
    ctx.fillRect(left, 0, right - left, ROLL_BAND);
    ctx.fillStyle = "#4E6A63";
    ctx.font = `11px ${mono}`;
    ctx.textAlign = "left";
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, 0, Math.max(0, right - left - 4), ROLL_BAND);
    ctx.clip();
    ctx.fillText(section.name, left + 6, ROLL_BAND - 5);
    ctx.restore();
  }

  /* 缩得很小时小节线会密成一片：只保留每 4 小节的强线，弱线按间距抽稀。默认档 stride=1，与改造前一致。 */
  const perBar = geom.width / Math.max(1, geom.plan.bars_total);
  const stride = perBar < 12 ? 8 : perBar < 24 ? 4 : 1;
  geom.plan.bars.forEach((bar, index) => {
    const strong = index % 4 === 0;
    if (!strong && index % stride !== 0) return;
    const x = Math.round(rollX(geom, bar.start)) + 0.5;
    ctx.strokeStyle = strong ? "#C9C0AE" : "#E5DDCC";
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, geom.height);
    ctx.stroke();
  });

  for (const chord of geom.plan.voices[0].chords) {
    ctx.fillStyle = "#6B4A8E";
    ctx.font = `10px ${mono}`;
    ctx.textAlign = "left";
    ctx.fillText(chord.name, rollX(geom, chord.start) + 3, ROLL_BAND + ROLL_CHORD - 4);
  }

  for (let pitch = geom.plan.pitch_min - 1; pitch <= geom.plan.pitch_max + 1; pitch += 1) {
    if (pitch % 12 !== 0) continue;
    ctx.strokeStyle = "#EAE2D1";
    const y = Math.round(rollY(geom, pitch) + geom.rowH / 2) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(geom.width, y);
    ctx.stroke();
  }

  const drag = ui.rollDrag;
  for (const voice of [geom.plan.voices[1], geom.plan.voices[0]]) {
    for (const note of voice.notes) {
      const box = rollBlock(geom, note);
      const live = drag && drag.voice === voice.name && drag.note.i === note.i ? drag : null;
      const pitch = live ? live.preview : note.pitch;
      const dur = live ? live.length : note.dur;
      const shown = live ? {x: box.x, w: Math.max(3, dur * geom.scale - 0.8),
                            y: rollY(geom, pitch) + 1.2, h: box.h} : box;
      ctx.globalAlpha = live ? 0.45 : 1;
      ctx.fillStyle = ROLL_TINTS[voice.name] || "#1B1A17";
      if (crisp) {
        const radius = Math.min(3, shown.h / 3);
        ctx.beginPath();
        ctx.roundRect(shown.x, shown.y, shown.w, shown.h, radius);
        ctx.fill();
      } else {
        ctx.fillRect(shown.x, shown.y, shown.w, Math.max(1, shown.h));
      }
      if (live) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#1B1A17";
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const picked = ui.rollSel && ui.rollSel.voice === voice.name && ui.rollSel.i === note.i;
      if (picked) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#B0413E";
        ctx.lineWidth = crisp ? 2 : 1;
        ctx.strokeRect(shown.x - 1, shown.y - 1, shown.w + 2, shown.h + 2);
        if (!note.tie && crisp) {
          ctx.fillStyle = "#B0413E";
          ctx.fillRect(shown.x + shown.w - 2.5, shown.y + shown.h * 0.25, 1.6, shown.h * 0.5);
        }
      }
      ctx.globalAlpha = 1;
    }
  }

  const actx = axis.getContext("2d");
  actx.setTransform(axis.width / 44, 0, 0, axis.height / geom.height, 0, 0);
  actx.clearRect(0, 0, 44, geom.height);
  actx.fillStyle = "#F7F4EC";
  actx.fillRect(0, 0, 44, geom.height);
  actx.fillStyle = "#7B7264";
  actx.font = `10px ${mono}`;
  actx.textAlign = "right";
  for (let pitch = geom.plan.pitch_min - 1; pitch <= geom.plan.pitch_max + 1; pitch += 1) {
    if (pitch % 12 !== 0) continue;
    actx.fillText(noteName(pitch), 38, rollY(geom, pitch) + geom.rowH / 2 + 3);
  }
}

function rollSelectionText() {
  const plan = ui.rollPlan;
  if (!ui.rollSel || !plan) return T("点一个音块选中；上下拖动改音高");
  const voice = plan.voices.find((item) => item.name === ui.rollSel.voice);
  const note = voice?.notes.find((item) => item.i === ui.rollSel.i);
  if (!note) return T("点一个音块选中；上下拖动改音高");
  const bar = plan.bars[note.bar];
  const share = bar ? Math.round((note.dur / bar.dur) * 100) : 0;
  return `${T(voice.label)} · ${T("第 {0} 小节", note.bar + 1)} · ${noteName(note.pitch)} · ${T("占小节 {0}%", share)}` +
    (note.tie ? ` · ${T("跨小节连音")}` : "");
}

function renderRoll() {
  const plan = ui.rollPlan;
  const note = $("rollNote");
  const isRoll = ui.rollTab === "roll";
  $("rollGrid").hidden = !isRoll || !plan;
  $("rollBar").hidden = !isRoll || !plan;
  $("edwrap").hidden = isRoll;
  $("rollSel").textContent = rollSelectionText();
  $("rollBpm").value = plan ? String(plan.bpm) : "";
  $("rollMeta").textContent = plan
    ? T("{0} 小节 · {1} 音 · {2} BPM · {3}", plan.bars_total, plan.notes_total, plan.bpm, plan.meter) : "";
  if (plan) {
    const select = $("rollSection");
    const keep = Number(select.value || 0);
    select.innerHTML = plan.sections.map((section, index) =>
      `<option value="${index}">${esc(section.name)} · ${esc(T("第 {0}–{1} 小节", section.from_bar + 1, section.to_bar))}</option>`).join("");
    select.value = plan.sections[keep] ? String(keep) : "0";
    $("btnSecDrop").disabled = plan.sections.length < 2;
  }
  if (!isRoll) { note.hidden = true; return; }
  if (!plan) {
    note.hidden = false;
    note.className = "note";
    note.innerHTML = esc(ui.rollError || (ui.scoreAbc.trim()
      ? T("这份谱画不成音块图，可以切到「文本谱」直接改")
      : T("还没有带乐谱的完成任务 · 生成后这里会出现可点可拖的音块图")));
    return;
  }
  note.hidden = true;
  rollPaint();
}

const rollAbc = () => ui.scoreAbc.replace(/\s+$/, "");

async function refreshRoll(force = false) {
  const abc = rollAbc();
  if (!abc) {
    ui.rollPlan = null;
    ui.rollFor = "";
    ui.rollError = "";
    renderRoll();
    return;
  }
  if (!force && ui.rollPlan && ui.rollFor === abc) {
    renderRoll();
    return;
  }
  try {
    const plan = await post("/api/score/plan", {abc});
    if (abc !== rollAbc()) return;
    ui.rollPlan = plan;
    ui.rollFor = abc;
    ui.rollError = "";
    if (ui.rollSel && !rollNoteOf(ui.rollSel.voice, ui.rollSel.i)) ui.rollSel = null;
  } catch (exc) {
    if (abc !== rollAbc()) return;
    ui.rollPlan = null;
    ui.rollFor = "";
    ui.rollSel = null;
    ui.rollError = message(exc);
  }
  renderRoll();
}

const scheduleRoll = debounce(() => refreshRoll(), 450);

function rollFocusLabel() {
  const on = ui.rollFocus;
  $("btnRollFull").setAttribute("aria-pressed", String(on));
  $("btnRollFullTx").textContent = on ? T("退出全屏") : T("全屏");
  $("btnRollFull").title = on ? T("退出全屏（Esc）") : T("铺满窗口看谱（Esc 退出）");
}

/* 全屏高度按当前布局量：工具条换行、提示行出现时自动让步，不用写死 100vh-常数 */
function fitScoreFocus() {
  const view = $("v-score");
  const grid = $("rollGrid");
  const edwrap = $("edwrap");
  grid.style.height = "";
  edwrap.style.height = "";
  const box = ui.rollTab === "roll" ? grid : edwrap;
  if (!ui.rollFocus || box.hidden) return;
  const pad = parseFloat(getComputedStyle(view).paddingBottom) || 0;
  const bar = $("rollBar").hidden ? 0 : $("rollBar").getBoundingClientRect().height;
  const drop = box.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop;
  box.style.height = `${Math.max(280, Math.floor(view.clientHeight - drop - bar - pad) - 1)}px`;
}

function setRollFocus(on) {
  const want = !!on && ui.view === "score";
  if (want === ui.rollFocus) return;
  /* 必须在加 class 之前存：铺满后 #work 内容塌掉，scrollTop 已被浏览器夹回 0 */
  if (want) ui.focusScroll = $("work").scrollTop;
  ui.rollFocus = want;
  $("v-score").classList.toggle("rollfocus", want);
  rollFocusLabel();
  if (want) {
    $("work").scrollTop = 0;
    fitScoreFocus();
  } else {
    fitScoreFocus();
    $("work").scrollTop = ui.focusScroll || 0;
  }
  if (ui.rollTab === "roll") rollPaint();
}

function setRollTab(tab) {
  ui.rollTab = tab;
  const roll = tab === "roll";
  $("tabRoll").classList.toggle("on", roll);
  $("tabText").classList.toggle("on", !roll);
  $("tabRoll").setAttribute("aria-selected", String(roll));
  $("tabText").setAttribute("aria-selected", String(!roll));
  $("rollHint").textContent = roll
    ? T("拖动音块改音高与长短，选中按 Delete 删音；Ctrl+滚轮缩放")
    : T("直接改下面的 ABC 文本，写完点「检查谱面」或「改谱重渲染」");
  renderRoll();
  fitScoreFocus();
  if (roll) {
    rollPaint();
    refreshRoll();
  }
}

async function applyOps(ops) {
  const abc = rollAbc();
  if (ui.rollBusy || !abc) return;
  ui.rollBusy = true;
  $("rollCanvas").style.opacity = "0.55";
  try {
    const data = await post("/api/score/edit", {abc, ops});
    ui.rollUndo.push(ui.scoreAbc);
    if (ui.rollUndo.length > 40) ui.rollUndo.shift();
    setScoreText(data.abc);
    ui.rollPlan = data.plan;
    ui.rollFor = data.abc.replace(/\s+$/, "");
    renderRoll();
    if (data.applied?.length) toast(data.applied.join(" · "), "ok");
  } catch (exc) {
    toast(message(exc), "bad");
    renderRoll();
  } finally {
    ui.rollBusy = false;
    $("rollCanvas").style.opacity = "";
  }
}

async function undoRoll() {
  if (ui.rollBusy) return;
  const previous = ui.rollUndo.pop();
  if (previous === undefined) return toast(T("没有可撤回的改动"), "warn");
  setScoreText(previous);
  await refreshRoll();
  toast(T("已撤回上一步"), "ok");
}

function rollPoint(event) {
  const rect = $("rollCanvas").getBoundingClientRect();
  return {x: event.clientX - rect.left, y: event.clientY - rect.top};
}

/* 短音符视觉只有 3px（rollW 的下限），±1px 容差会让相邻音符命中框重叠、点谁全看遍历顺序。
   改成收集容差内的候选、按“纵向中心最近优先 + 横向中心最近”挑一个，行是自然单位所以纵向权重更高。 */
function rollHit(point, geom) {
  let best = null;
  let bestD = Infinity;
  for (const voice of geom.plan.voices) {
    for (const note of voice.notes) {
      const box = rollBlock(geom, note);
      if (point.x < box.x - 3 || point.x > box.x + box.w + 3) continue;
      const dy = Math.abs(point.y - (box.y + box.h / 2));
      if (dy > Math.max(box.h, geom.rowH) / 2 + 3) continue;
      const d = dy * 2 + Math.abs(point.x - (box.x + box.w / 2));
      if (d < bestD) { bestD = d; best = {voice: voice.name, note, box}; }
    }
  }
  return best;
}

/* 拖右边缘改时长的把手：音符太窄（<12px）时整块都算“改音高”，否则把手会吃掉整个音符。
   要精确改短音符时长，先放大。 */
function rollHandleW(box) { return box.w >= 12 ? Math.min(8, box.w - 6) : 0; }

/* ---- 缩放 ---- */
function rollZoomLabel() {
  $("zoomXVal").textContent = `${Math.round(ui.rollZoomX * 100)}%`;
  $("zoomYVal").textContent = `${Math.round(ui.rollZoomY * 100)}%`;
}

function rollZoomSave() {
  try { localStorage.setItem(ROLL_ZOOM_KEY, JSON.stringify({x: ui.rollZoomX, y: ui.rollZoomY})); } catch (exc) { /* 隐私模式忽略 */ }
}

function rollZoomLoad() {
  try {
    const z = JSON.parse(localStorage.getItem(ROLL_ZOOM_KEY) || "null");
    if (z && Number.isFinite(z.x)) ui.rollZoomX = clampZoom(z.x);
    if (z && Number.isFinite(z.y)) ui.rollZoomY = clampZoom(z.y);
  } catch (exc) { /* 损坏就当没有 */ }
}

/* 锚点缩放：anchor 是光标相对滚动容器视口左上角的偏移（x 已减去 44px 轴宽）。
   缩放后调 scrollLeft/Top，让锚点下的谱面内容停在同一屏幕位置，不漂移。 */
function rollSetZoom(axis, factor, anchor) {
  const scroll = $("rollScroll");
  const before = rollGeom();
  if (!scroll || !before) return;
  const current = axis === "x" ? ui.rollZoomX : ui.rollZoomY;
  const next = clampZoom(current * factor);
  if (next === current) return;
  const oldW = before.width;
  const oldH = before.height;
  if (axis === "x") ui.rollZoomX = next;
  else ui.rollZoomY = next;
  rollPaint();
  const after = rollGeom();
  if (after) {
    const cx = scroll.scrollLeft + anchor.x;
    const cy = scroll.scrollTop + anchor.y;
    scroll.scrollLeft = cx * (after.width / oldW) - anchor.x;
    scroll.scrollTop = cy * (after.height / oldH) - anchor.y;
  }
  rollZoomLabel();
  rollZoomSave();
}

function rollFit() {
  ui.rollZoomX = 1;
  ui.rollZoomY = 1;
  const scroll = $("rollScroll");
  if (scroll) { scroll.scrollLeft = 0; scroll.scrollTop = 0; }
  rollPaint();
  rollZoomLabel();
  rollZoomSave();
}

/* 把选中的音块滚到视口中央（剪辑软件的“缩放到选中”） */
function rollFocusSelection() {
  const geom = rollGeom();
  const sel = ui.rollSel;
  if (!geom || !sel) return;
  const note = rollNoteOf(sel.voice, sel.i);
  if (!note) return;
  const scroll = $("rollScroll");
  scroll.scrollLeft = Math.max(0, 44 + rollX(geom, note.start) - scroll.clientWidth / 2);
  scroll.scrollTop = Math.max(0, rollY(geom, note.pitch) - scroll.clientHeight / 2);
}

function rollCenterAnchor() {
  const scroll = $("rollScroll");
  return {x: Math.max(0, (scroll.clientWidth - 44) / 2), y: scroll.clientHeight / 2};
}

function rollSnap(value) {
  let best = ROLL_LENGTHS[0];
  for (const size of ROLL_LENGTHS) {
    if (Math.abs(size - value) < Math.abs(best - value)) best = size;
  }
  return best;
}

function rollNoteOf(voice, i) {
  return ui.rollPlan?.voices.find((item) => item.name === voice)?.notes.find((item) => item.i === i) || null;
}

function initRoll() {
  $("tabRoll").addEventListener("click", () => setRollTab("roll"));
  $("tabText").addEventListener("click", () => setRollTab("text"));
  $("btnRollFull").addEventListener("click", () => setRollFocus(!ui.rollFocus));

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !ui.rollFocus) return;
    if (modalOpen() || tourIndex >= 0) return;
    event.preventDefault();
    setRollFocus(false);
  });

  const canvas = $("rollCanvas");

  canvas.addEventListener("pointerdown", (event) => {
    const geom = rollGeom();
    if (!geom || ui.rollBusy) return;
    const point = rollPoint(event);
    const hit = rollHit(point, geom);
    if (!hit) {
      ui.rollSel = null;
      renderRoll();
      return;
    }
    ui.rollSel = {voice: hit.voice, i: hit.note.i};
    const hw = rollHandleW(hit.box);
    const resize = !hit.note.tie && hw > 0 && point.x >= hit.box.x + hit.box.w - hw;
    ui.rollDrag = {voice: hit.voice, note: hit.note, kind: resize ? "length" : "pitch",
                   preview: hit.note.pitch, length: hit.note.dur,
                   startX: point.x, startY: point.y, moved: false};
    try { canvas.setPointerCapture(event.pointerId); } catch (exc) { /* 指针已释放时忽略 */ }
    canvas.focus({preventScroll: true});
    renderRoll();
    event.preventDefault();
  });

  canvas.addEventListener("pointermove", (event) => {
    const drag = ui.rollDrag;
    const geom = rollGeom();
    if (!geom) return;
    const point = rollPoint(event);
    if (!drag) {
      const hit = rollHit(point, geom);
      const hw = hit ? rollHandleW(hit.box) : 0;
      const handle = hit && !hit.note.tie && hw > 0 && point.x >= hit.box.x + hit.box.w - hw;
      canvas.style.cursor = hit ? (handle ? "ew-resize" : "ns-resize") : "";
      return;
    }
    if (drag.kind === "pitch") {
      const rows = Math.round((point.y - drag.startY) / geom.rowH);
      const pitch = Math.max(0, Math.min(127, drag.note.pitch - rows));
      if (pitch !== drag.preview) {
        drag.preview = pitch;
        drag.moved = point.y !== drag.startY;
        rollPaint();
      }
    } else {
      const length = rollSnap((point.x - rollX(geom, drag.note.start)) / geom.scale);
      if (length !== drag.length) {
        drag.length = length;
        drag.moved = true;
        rollPaint();
      }
    }
  });

  const drop = async () => {
    const drag = ui.rollDrag;
    if (!drag) return;
    ui.rollDrag = null;
    canvas.style.cursor = "";
    if (!drag.moved) {
      renderRoll();
      return;
    }
    const ops = drag.kind === "pitch"
      ? [{kind: "pitch", voice: drag.voice, i: drag.note.i, pitch: drag.preview}]
      : [{kind: "resize", voice: drag.voice, i: drag.note.i, dur: drag.length}];
    await applyOps(ops);
  };
  canvas.addEventListener("pointerup", drop);
  canvas.addEventListener("pointercancel", () => {
    ui.rollDrag = null;
    renderRoll();
  });

  document.addEventListener("keydown", (event) => {
    if (ui.view !== "score" || ui.rollTab !== "roll" || ui.rollBusy || !ui.rollSel) return;
    if (modalOpen() || tourIndex >= 0) return;
    const tag = event.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || event.target.isContentEditable) return;
    const sel = ui.rollSel;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      applyOps([{kind: "remove", voice: sel.voice, i: sel.i}]);
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const note = rollNoteOf(sel.voice, sel.i);
      if (!note) return;
      event.preventDefault();
      const step = (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 12 : 1);
      const pitch = note.pitch + step;
      if (pitch < 0 || pitch > 127) return;
      applyOps([{kind: "pitch", voice: sel.voice, i: sel.i, pitch}]);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undoRoll();
    }
  });

  const transpose = (semitones) => {
    if (!ui.rollPlan) return toast(T("谱面还没画出来，先切到「文本谱」检查"), "warn");
    applyOps([{kind: "transpose", semitones}]);
  };
  $("trDown12").addEventListener("click", () => transpose(-12));
  $("trDown").addEventListener("click", () => transpose(-1));
  $("trUp").addEventListener("click", () => transpose(1));
  $("trUp12").addEventListener("click", () => transpose(12));

  $("btnBpm").addEventListener("click", () => {
    if (!ui.rollPlan) return toast(T("谱面还没画出来，先切到「文本谱」检查"), "warn");
    const bpm = Math.round(Number($("rollBpm").value));
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) return toast(T("速度要在 20–300 之间"), "warn");
    if (bpm === ui.rollPlan.bpm) return toast(T("速度没有变化"), "warn");
    applyOps([{kind: "tempo", bpm}]);
  });

  $("btnSecDup").addEventListener("click", () => {
    if (!ui.rollPlan) return toast(T("谱面还没画出来，先切到「文本谱」检查"), "warn");
    applyOps([{kind: "duplicate_section", section: Number($("rollSection").value || 0)}]);
  });

  $("btnSecDrop").addEventListener("click", async () => {
    const section = ui.rollPlan?.sections[Number($("rollSection").value || 0)];
    if (!section) return;
    const ok = await confirmDialog({
      title: T("删掉这一段"),
      body: esc(T("整段「{0}」（第 {1}–{2} 小节）会从谱面里删掉。", section.name, section.from_bar + 1, section.to_bar)),
      ok: T("删掉"), cancel: T("取消"),
      note: T("音符会被真的删掉，可以用 Ctrl+Z 撤回；音频要点「改谱重渲染」才会变。"),
    });
    if (ok) applyOps([{kind: "drop_section", section: Number($("rollSection").value || 0)}]);
  });

  $("btnRevert").addEventListener("click", async () => {
    if (!ui.scoreOriginal.trim()) return toast(T("还没有可恢复的原谱"), "warn");
    if (ui.scoreAbc === ui.scoreOriginal) return toast(T("当前就是原谱"), "warn");
    const ok = await confirmDialog({
      title: T("恢复原谱"),
      body: esc(T("丢掉当前所有改动，回到服务端保存的 score.abc。")),
      ok: T("恢复原谱"), cancel: T("取消"),
      note: T("只改编辑器里的文本，音频不变，除非再点「改谱重渲染」。"),
    });
    if (!ok) return;
    ui.rollUndo.push(ui.scoreAbc);
    ui.rollSel = null;
    scoreDrafts.delete(ui.scoreJob);
    setScoreText(ui.scoreOriginal);
    await refreshRoll();
    toast(T("已恢复原谱"), "ok");
  });

  document.addEventListener("yue2:lang", () => {
    rollFocusLabel();
    if (ui.rollFocus) fitScoreFocus();
  });

  window.addEventListener("resize", debounce(() => {
    fitScoreFocus();
    rollPaint();
  }, 120));

  /* ---- 缩放控件 / 手势 ---- */
  rollZoomLoad();
  rollZoomLabel();
  $("zoomXIn").addEventListener("click", () => rollSetZoom("x", ROLL_ZOOM_STEP, rollCenterAnchor()));
  $("zoomXOut").addEventListener("click", () => rollSetZoom("x", 1 / ROLL_ZOOM_STEP, rollCenterAnchor()));
  $("zoomYIn").addEventListener("click", () => rollSetZoom("y", ROLL_ZOOM_STEP, rollCenterAnchor()));
  $("zoomYOut").addEventListener("click", () => rollSetZoom("y", 1 / ROLL_ZOOM_STEP, rollCenterAnchor()));
  $("zoomFit").addEventListener("click", rollFit);

  /* Ctrl/⌘+滚轮=横向，Ctrl/⌘+Shift+滚轮=纵向；普通滚轮留给原生平移，不劫持页面滚动 */
  $("rollScroll").addEventListener("wheel", (event) => {
    if (!(event.ctrlKey || event.metaKey) || ui.rollTab !== "roll") return;
    event.preventDefault();
    const scroll = $("rollScroll");
    const rect = scroll.getBoundingClientRect();
    const factor = event.deltaY < 0 ? ROLL_ZOOM_STEP : 1 / ROLL_ZOOM_STEP;
    if (event.shiftKey) {
      rollSetZoom("y", factor, {x: 0, y: Math.max(0, event.clientY - rect.top)});
    } else {
      rollSetZoom("x", factor, {x: Math.max(0, event.clientX - rect.left - 44), y: 0});
    }
  }, {passive: false});

  /* 画布聚焦时：+/- 横向、Shift+加/减 纵向、0 复位、F 定位选中 */
  canvas.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || ui.rollTab !== "roll") return;
    const step = event.shiftKey ? "y" : "x";
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      rollSetZoom(step, ROLL_ZOOM_STEP, rollCenterAnchor());
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      rollSetZoom(step, 1 / ROLL_ZOOM_STEP, rollCenterAnchor());
    } else if (event.key === "0") {
      event.preventDefault();
      rollFit();
    } else if (event.key === "f" || event.key === "F") {
      event.preventDefault();
      rollFocusSelection();
    }
  });
}

/* 对比当前编辑器里的谱和刚载入时的原谱：只看符号层，不代表音频。
   校验器的差异行是英文；能识别的翻成中文，未识别的保留原文并收进展开区。 */
async function compareScore() {
  if (!ui.scoreOriginal.trim()) return toast(T("还没有可对比的原谱"), "warn");
  $("btnCompare").disabled = true;
  try {
    const report = await post("/api/score/compare", {before: ui.scoreOriginal, after: ui.scoreAbc});
    if (report.match) toolNote(esc(T("与原谱一致：旋律、时值和小节网格都没变")), "ok");
    else {
      const diffs = report.differences || [];
      const raw = diffs.filter((line) => diffLine(line));
      toolNote(`<b>${esc(T("与原谱有 {0} 处差异", diffs.length))}</b>` +
        `<ul style="margin:var(--sp2) 0 0 var(--sp4);font-size:13px">` +
        diffs.map((line) => `<li data-notr>${esc(diffLine(line) || line)}</li>`).join("") + `</ul>` +
        (raw.length ? `<details style="margin-top:var(--sp2)"><summary class="sub">${esc(T("校验器原文"))}</summary>` +
          `<pre class="mono" data-notr style="margin:var(--sp2) 0 0;white-space:pre-wrap;font-size:12px">${esc(raw.join("\n"))}</pre></details>` : ""), "bad");
    }
  } catch (exc) {
    toolNote(esc(message(exc)), "bad");
  } finally {
    $("btnCompare").disabled = false;
  }
}

async function stripScoreChords() {
  if (!ui.scoreAbc.trim()) return toast(T("谱面是空的"), "bad");
  const ok = await confirmDialog({
    title: T("去掉和弦标记"), body: esc(T("从当前谱面里删除所有 \"和弦\" 标记，旋律与伴奏音符不变。")),
    ok: T("去掉和弦"), cancel: T("取消"),
    note: T("只改编辑器里的文本；点「改谱重渲染」才会真正生成新音频。"),
  });
  if (!ok) return;
  $("btnStrip").disabled = true;
  try {
    const data = await post("/api/score/strip-chords", {abc: ui.scoreAbc});
    setScoreText(data.abc);
    toolNote(esc(T("和弦标记已删除，旋律经官方脚本校验未变")), "ok");
  } catch (exc) {
    toolNote(esc(message(exc)), "bad");
  } finally {
    $("btnStrip").disabled = false;
  }
}

async function instrumentalizeScore() {
  if (!ui.scoreAbc.trim()) return toast(T("谱面是空的"), "bad");
  const ok = await confirmDialog({
    title: T("转成纯音乐谱"), body: esc(T("把人声旋律并入伴奏声部，得到一份没有人声的器乐谱。")),
    ok: T("转换"), cancel: T("取消"),
    note: T("点「改谱重渲染」后才会生成纯音乐；原任务与音频不受影响。"),
  });
  if (!ok) return;
  $("btnInstr").disabled = true;
  try {
    const data = await post("/api/score/instrumentalize", {abc: ui.scoreAbc});
    setScoreText(data.abc);
    toolNote(esc(T("已转成纯音乐谱，重渲染后是器乐版")), "ok");
  } catch (exc) {
    toolNote(esc(message(exc)), "bad");
  } finally {
    $("btnInstr").disabled = false;
  }
}

/* 按谱重渲染：把右侧改好的谱面交给模型，整曲重新渲染（约 10 分钟）。 */
async function generateRerender() {
  if (!ui.scoreAbc.trim()) return toast(T("谱面是空的"), "bad");
  const jobId = ui.scoreJob;
  const cached = state.byId.get(jobId) || state.jobs.find((item) => item.id === jobId);
  $("btnRerender").disabled = true;
  try {
    // 列表行只带歌词摘要，重渲染要把全文歌词交给校验与模型
    const job = cached?.requested?.lyrics !== undefined ? cached : await loadJob(jobId);
    const request = job?.requested || {};
    const payload = {
      type: "rerender", source: jobId,
      style: request.style || "", lyrics: request.lyrics || "",
      abc: ui.scoreAbc,
      cot: request.cot || "full",
      device: ui.device === "auto" ? (state.model.default_device || "auto") : ui.device,
    };
    await createJob(payload);
    scoreDrafts.delete(jobId);
    toast(T("重渲染已排队，乐谱谱系已挂到原始任务"), "ok");
    go("studio");
  } catch (exc) {
    toast(message(exc), "bad");
  } finally {
    $("btnRerender").disabled = false;
  }
}

/* ------------------------------------------------------------------ 系统 */
function renderSystem() {
  const model = state.model;
  const gpu = model.gpu || {};
  const schema = state.schema || {};
  const badge = $("sysState");
  const loaded = model.state === "loaded";
  badge.className = `badge ${loaded ? "done" : model.state === "unloaded" ? "" : "queue"}`;
  badge.textContent = T({loaded: "已加载", loading: "加载中", unloading: "卸载中", unloaded: "未加载"}[model.state] || model.state);

  const load = model.load || {};
  $("sysModel").innerHTML = [
    [T("主模型"), `<span class="mono" data-notr>${esc(model.device_name || "YuE2-3B")}</span>`],
    [T("运行设备"), esc(loaded ? (model.device === "cuda" ? T("显卡") : "CPU") : T("未加载"))],
    [T("默认设备"), `<span class="mono" data-notr>${esc(model.default_device === "cuda" ? "cuda" : "cpu")}</span>`],
    [T("加载用时"), `<span class="mono" data-notr>${esc(model.seconds ? fmtStamp(model.seconds) : "—")}</span>`],
    [T("权重校验"), `<span class="mono" data-notr>${esc(load.resolve_and_integrity_seconds ? fmtStamp(load.resolve_and_integrity_seconds) : "—")}</span>`],
  ].map(([key, value]) => `<div class="kv"><div class="k">${esc(key)}</div><div class="v" style="font-size:14px">${value}</div></div>`).join("")
    + `<div class="kv" style="grid-column:1/-1"><div class="k">${esc(T("显卡"))}</div>
      <div class="v" style="font-size:14px" data-notr>${esc(gpu.available
        ? `${gpu.name} · ${gpu.total_gib} GiB · ${T("算力")} ${gpu.compute_capability} · ${T("空闲")} ${gpu.free_gib} GiB`
        : gpu.reason || T("未检测到 NVIDIA GPU"))}</div></div>`;

  $("btnLoadCpu").disabled = model.state === "loading" || model.state === "unloading" || !!model.busy;
  $("btnLoadGpu").disabled = $("btnLoadCpu").disabled || !gpu.available || !gpu.suitable;
  $("btnUnload").disabled = !loaded || !!model.busy;
  $("btnLoadCpu").classList.toggle("primary", model.default_device !== "cuda");
  $("btnLoadGpu").classList.toggle("primary", model.default_device === "cuda");
  $("sysLoadNote").textContent = loaded
    ? T("卸载即结束工作进程，显存彻底释放")
    : T("生成任务会在需要时自动加载模型");

  const gpuNote = $("sysGpuNote");
  // 加载/运行中显存被自己占着，`suitable` 会抖；降级提示只在未加载时给
  gpuNote.hidden = model.state !== "unloaded" || !(gpu.available && !gpu.suitable);
  if (!gpuNote.hidden) {
    gpuNote.className = "note bad";
    gpuNote.innerHTML = `<b>${esc(T("GPU 不可用："))}</b>${esc(gpu.reason || "")} ` +
      esc(T("自动降级到 CPU 是常态，不是故障。"));
  }

  const caps = [
    [T("分阶段驻留"), schema.types?.includes("staged") ? ["done", T("可用")] : ["fail", T("不可用")]],
    [T("按谱重渲"), schema.types?.includes("rerender") ? ["done", T("可用")] : ["fail", T("不可用")]],
    [T("重解码（换解码器）"), schema.types?.includes("redecode") ? ["done", T("可用")] : ["fail", T("不可用")]],
    [T("任务取消"), ["run", T("阶段边界生效")]],
    [T("乐谱工具（官方脚本）"), schema.score_tools ? ["done", T("可用")] : ["fail", T("不可用")]],
    [T("FP8 量化"), ["fail", T("硬件不支持")]],
    [T("并发大于 1"), ["fail", T("官方禁止共享实例")]],
  ];
  $("sysCaps").innerHTML = caps.map(([label, [kind, text]]) =>
    `<span class="inline" style="justify-content:space-between;gap:var(--sp3);flex-wrap:nowrap"><span style="min-width:0">${esc(label)}</span>` +
    `<span class="state ${kind}">${esc(text)}</span></span>`).join("");

  const decoders = schema.decoders || [];
  const storeRows = [
    [T("任务记录"), `<span class="mono" data-notr>${esc(String(state.jobs.length))}</span>`],
    [T("已完成"), `<span class="mono" data-notr>${esc(String(state.jobs.filter((job) => job.status === "complete").length))}</span>`],
    ...decoders.map((item) => [T(item.label), `<span class="state ${item.available ? "done" : "fail"}">${esc(item.available ? T("已安装") : T("未安装"))}</span>`]),
  ].map(([key, value]) => `<div class="kv"><div class="k">${esc(key)}</div><div class="v" style="font-size:14px">${value}</div></div>`).join("");
  $("sysStore").innerHTML = storeRows +
    `<details class="adv"><summary>${esc(T("高级信息（只读约束）"))}</summary>` +
    `<div class="kv"><div class="k">ode_method</div><div class="v mono" data-notr style="font-size:12px">${esc(schema.ode_method?.value || "midpoint")} · context=${esc(String(schema.context?.value ?? ""))}</div></div></details>`;

  renderAccel();
  renderDoctor();
}

function renderAccel() {
  const box = $("sysAccel");
  const data = state.settings;
  if (!data) {
    box.innerHTML = `<div class="sub">${esc(T("读取设置中…"))}</div>`;
    return;
  }
  const caps = data.capabilities || {};
  const rows = [
    ["attention_ar", T("语义生成加速"), T("逐 token 写旋律的那一步；用融合注意力内核，长歌词提速最明显"), caps.ar],
    ["attention_nar", T("音频合成加速"), T("把旋律变成声音的那一步；开启后先自测，跑不赢基准就自动退回"), caps.nar],
  ];
  const saving = ui.accelSaving;
  box.innerHTML = rows.map(([key, label, note, cap]) => {
    const on = !!data.settings[key];
    const kind = !cap ? "queue" : cap.mode === "baseline" ? "fail" : "done";
    return `<div>
      <span class="inline" style="justify-content:space-between;gap:var(--sp3);flex-wrap:nowrap">
        <span style="min-width:0">${esc(label)}</span>
        <span class="seg" role="group" aria-label="${esc(T("加速开关"))}">
          <button type="button" data-accel="${key}" data-on="0" class="${on ? "" : "on"}">${esc(T("关"))}</button>
          <button type="button" data-accel="${key}" data-on="1" class="${on ? "on" : ""}">${esc(T("开"))}</button>
        </span>
      </span>
      <div class="sub" style="margin-top:var(--sp2)">${esc(note)}</div>
      <div class="inline" style="justify-content:flex-start;gap:var(--sp2);margin-top:var(--sp2)">
        <span class="state ${kind}">${esc(T(cap ? cap.reason : "本机信息未加载"))}</span>
      </div>
    </div>`;
  }).join("");
  const busy = !!state.model.busy || saving;
  qa("#sysAccel .seg button").forEach((button) => {
    button.disabled = busy;
    button.addEventListener("click", async () => {
      ui.accelSaving = true;
      try {
        await saveSettings({[button.dataset.accel]: button.dataset.on === "1"});
        toast(T("已保存，下一个任务生效"), "ok");
      } catch (exc) {
        toast(message(exc), "bad");
      } finally {
        ui.accelSaving = false;
      }
      renderSystem();
    });
  });
}

function renderDoctor() {
  const doctor = state.doctor;
  const host = $("sysDoctor");
  if (!doctor) {
    $("sysDocSum").textContent = T("未检测");
    host.innerHTML = `<tr><td colspan="3" class="sub">${esc(T("点右上「重新检测」跑一次 yue2 doctor（约 20 秒）"))}</td></tr>`;
    return;
  }
  if (doctor.error) {
    $("sysDocSum").textContent = T("检测失败");
    host.innerHTML = `<tr><td colspan="3"><span class="state fail">${esc(T("检测失败"))}</span>` +
      `<div class="mono" data-notr style="font-size:12px;margin-top:var(--sp2)">${esc(doctor.error)}</div></td></tr>`;
    return;
  }
  $("sysDocSum").textContent = doctor.dependencies_ready ? T("依赖就绪") : T("依赖缺失");
  const versions = doctor.versions || {};
  const rows = Object.entries(versions).map(([name, version]) =>
    `<tr><td style="width:40%" class="mono" data-notr>${esc(name)}</td>` +
    `<td class="mono" data-notr>${esc(version || "—")}</td>` +
    `<td><span class="state ${version ? "done" : "fail"}">${esc(version ? T("已安装") : T("缺失"))}</span></td></tr>`);
  for (const card of doctor.cuda || []) {
    const [major, minor] = card.compute_capability || [];
    const capability = major !== undefined ? `${major}.${minor}` : "—";
    rows.push(`<tr><td>${esc(T("显卡"))}</td>` +
      `<td class="mono" data-notr>${esc(`${card.name} · ${Number(card.memory_gib).toFixed(1)} GiB · CC ${capability}`)}</td>` +
      `<td><span class="state ${Number(capability) >= 8 ? "done" : "fail"}">${esc(Number(capability) >= 8 ? T("BF16 可用") : T("算力不足"))}</span>` +
      ` <span class="state ${Number(capability) >= 8.9 ? "done" : "fail"}">${esc(Number(capability) >= 8.9 ? T("FP8 可用") : T("FP8 不可用"))}</span></td></tr>`);
  }
  rows.push(`<tr><td>${esc(T("模型路径"))}</td><td class="mono" data-notr style="font-size:12px">${esc(doctor.model || "—")}</td>` +
    `<td><span class="state ${doctor.model ? "done" : "fail"}">${esc(doctor.model ? T("已解析") : T("未解析"))}</span></td></tr>`);
  host.innerHTML = rows.join("");
}

/* ------------------------------------------------------------------ 播放 */
const player = $("player");
const VOL_KEY = "yue2.volume";

function readVolume() {
  try {
    const saved = Number.parseInt(localStorage.getItem(VOL_KEY), 10);
    if (Number.isFinite(saved) && saved >= 0 && saved <= 100) return saved;
  } catch (exc) {}
  return 90;
}

function paintTrackMeta() {
  const id = ui.track;
  const job = id ? state.byId.get(id) : null;
  $("tName").textContent = id ? (job ? jobName(job) : id) : T("未选择曲目");
  $("tSub").textContent = id ? `${id}${job?.duration ? ` · ${fmtClock(job.duration)} · 48kHz` : ""}` : "—";
  $("dlBtn").disabled = !id || !hasAudio(job);
  refreshSkip();
}

function loadTrack(id) {
  ui.track = id;
  player.src = audioUrl(id);
  player.load();
  paintTrackMeta();
  $("ppBtn").disabled = false;
  paintWave(0);
  setLyricsFor(id);
  paintWaveFromAudio(id);
}

function clearTrack() {
  player.pause();
  player.removeAttribute("src");
  player.load();
  ui.track = null;
  ui.lyrics = null;
  ui.lyricLine = -1;
  paintTrackMeta();
  $("ppBtn").disabled = true;
  $("tCur").textContent = fmtClock(0);
  $("tDur").textContent = fmtClock(0);
  $("lyrNow").textContent = "";
  $("lyrPrev").textContent = "";
  $("lyrNext").textContent = "";
  $("lyrList").innerHTML = "";
  paintWave(0);
}

/* 上一首 / 下一首：在已完成且有音频的任务里按时间倒序循环 */
function playables() {
  return state.jobs.filter((job) => job.status === "complete" && hasAudio(job));
}

function refreshSkip() {
  const many = playables().length > 1;
  $("prevBtn").disabled = !many;
  $("nextBtn").disabled = !many;
}

function skipTrack(delta) {
  const list = playables();
  if (!list.length) return;
  const index = list.findIndex((job) => job.id === ui.track);
  const next = index < 0 ? list[0] : list[(index + delta + list.length) % list.length];
  if (next) playJob(next.id);
}

function playJob(id) {
  const job = state.byId.get(id);
  if (!job?.artifacts?.["audio.flac"]) return toast(T("这条任务还没有音频产物"), "warn");
  loadTrack(id);
  playFrom(ui.ab.includes(id) ? player.currentTime : 0,
    () => toast(T("浏览器拒绝了自动播放，请再点一次播放"), "warn"));
}

/* 换音源后等元数据就绪再定位并播放；秒数 > 时长时退到结尾 */
function playFrom(seconds, onBlocked) {
  player.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(seconds) && seconds > 0) {
      player.currentTime = Math.min(seconds, player.duration || seconds);
    }
    player.play().catch(onBlocked || (() => {}));
  }, {once: true});
}

function togglePlay() {
  if (!ui.track) return;
  if (player.paused) player.play().catch(() => {});
  else player.pause();
}

/* 波形：拿到音频真峰就画真峰，解码失败退回示意波形 */
const WAVE_BARS = 96;
const waveCache = new Map();

function fallbackBars() {
  return Array.from({length: WAVE_BARS}, (_, index) =>
    Math.min([38, 62, 84, 52, 30, 72, 96, 44, 66, 28][index % 10] + (index % 7 === 0 ? 8 : 0) + (index % 3) * 6, 100));
}

function paintWave(ratio) {
  const bars = waveCache.get(ui.track) || fallbackBars();
  const played = Math.round((ratio || 0) * bars.length);
  $("wave").innerHTML = bars.map((height, index) => {
    const level = height >= 82 ? "h" : height >= 58 ? "m" : "";
    return `<i class="${index < played ? `f${level ? ` ${level}` : ""}` : ""}" style="height:${height}%"></i>`;
  }).join("");
}

async function paintWaveFromAudio(id) {
  if (waveCache.has(id)) {
    if (ui.track === id) paintWave(player.duration ? player.currentTime / player.duration : 0);
    return;
  }
  try {
    const response = await fetch(audioUrl(id));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const buffer = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(bytes);
    const channel = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(channel.length / WAVE_BARS));
    const peaks = [];
    for (let bar = 0; bar < WAVE_BARS; bar += 1) {
      let peak = 0;
      const end = Math.min(channel.length, (bar + 1) * step);
      for (let i = bar * step; i < end; i += 1) {
        const value = Math.abs(channel[i]);
        if (value > peak) peak = value;
      }
      peaks.push(peak);
    }
    const top = Math.max(...peaks, 1e-4);
    waveCache.set(id, peaks.map((peak) => Math.max(8, Math.round((peak / top) * 100))));
    if (ui.track === id) paintWave(player.duration ? player.currentTime / player.duration : 0);
  } catch (exc) {
    /* 解码不了就保留示意波形，不影响播放 */
  }
}

function seekFromEvent(event) {
  const track = event.currentTarget.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - track.left) / track.width));
  if (player.duration) player.currentTime = ratio * player.duration;
  paintWave(ratio);
}

/* ------------------------------------------------------------------ 歌词 */
const lyricsCache = new Map();
let lyricRetry = null;

function lyricMessage(note, detail = "", retry = false) {
  ui.lyrics = null;
  ui.lyricLine = -1;
  ui.lyricNote = note;
  $("lyrNow").classList.add("empty");
  $("lyr").classList.add("empty");
  $("lyrNow").textContent = T(note);
  $("lyrNow").title = detail;
  $("lyrPrev").textContent = "";
  $("lyrNext").textContent = "";
  $("lyrList").innerHTML = "";
  $("lyrRetry").hidden = !(retry && ui.track);
}

async function retryLyrics() {
  const id = ui.track;
  if (!id) return;
  lyricsCache.delete(id);
  lyricMessage("歌词对齐中…");
  try {
    await post(`/api/jobs/${encodeURIComponent(id)}/lyrics/retry`, {});
    fetchLyrics(id);
  } catch (exc) {
    lyricMessage("这首歌没能对齐歌词", message(exc), true);
  }
}

function lyricIndex(time) {
  const lines = ui.lyrics?.lines || [];
  let low = 0, high = lines.length - 1, found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lines[middle].start <= time) { found = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return found;
}

/* 逐字 span：按歌词原文切片，英文单词的空格不被吃掉 */
function lyricMarkup(line) {
  let html = "", cursor = 0;
  line.units.forEach((unit, index) => {
    const at = line.text.indexOf(unit.text, cursor);
    if (at < 0) return;
    html += esc(line.text.slice(cursor, at));
    html += `<span data-i="${index}">${esc(unit.text)}</span>`;
    cursor = at + unit.text.length;
  });
  return html + esc(line.text.slice(cursor));
}

function paintLyricTime() {
  const line = ui.lyrics?.lines?.[ui.lyricLine];
  if (!line) return;
  const time = player.currentTime;
  for (const span of $("lyrNow").children) {
    const unit = line.units[Number(span.dataset.i)];
    span.classList.toggle("on", !!unit && time >= unit.start);
  }
}

function paintLyricList(index) {
  const list = $("lyrList");
  if (!ui.lyrics) { list.innerHTML = ""; return; }
  list.innerHTML = ui.lyrics.lines.map((line, at) =>
    `<div class="lyrLine${at === index ? " on" : ""}" role="listitem" data-notr` +
    ` data-start="${line.start}">${esc(line.text)}</div>`).join("");
  const row = list.children[index];
  if (row) list.scrollTop = row.offsetTop - list.clientHeight / 2 + row.offsetHeight / 2;
}

function renderLyrics(force = false) {
  if (!ui.lyrics) return;
  const index = lyricIndex(player.currentTime);
  if (!force && index === ui.lyricLine) { paintLyricTime(); return; }
  ui.lyricLine = index;
  const lines = ui.lyrics.lines;
  $("lyrNow").classList.remove("empty");
  $("lyr").classList.remove("empty");
  $("lyrNow").title = "";
  $("lyrNow").innerHTML = index >= 0 ? lyricMarkup(lines[index]) : "…";
  $("lyrPrev").textContent = index > 0 ? lines[index - 1].text : "";
  $("lyrNext").textContent = lines[index + 1]?.text || "";
  paintLyricList(index);
  paintLyricTime();
}

function toggleLyrics(force) {
  const bar = $("lyr");
  const open = force === undefined ? !bar.classList.contains("open") : force;
  bar.classList.toggle("open", open);
  bar.setAttribute("aria-label", T("歌词"));
  $("lyrTg").setAttribute("aria-expanded", String(open));
  $("lyrTg").setAttribute("aria-label", T(open ? "收起歌词" : "展开歌词"));
  $("lyrTg").title = T(open ? "收起歌词" : "展开歌词");
  if (open) paintLyricList(ui.lyricLine);
}

async function fetchLyrics(id, attempt = 0) {
  clearTimeout(lyricRetry);
  if (ui.track !== id) return;
  let data = null;
  try {
    data = await get(`/api/jobs/${encodeURIComponent(id)}/lyrics`);
  } catch (exc) {
    if (ui.track === id) lyricMessage("歌词时间轴暂时取不到", message(exc), true);
    return;
  }
  if (ui.track !== id) return;
  if (Array.isArray(data?.lines) && data.lines.length) {
    lyricsCache.set(id, data);
    ui.lyrics = data;
    $("lyrRetry").hidden = true;
    renderLyrics(true);
    return;
  }
  if (data?.status === "pending") {
    if (attempt < 40) {
      lyricRetry = setTimeout(() => fetchLyrics(id, attempt + 1), 2500);
      return;
    }
    lyricMessage("歌词对齐较慢，稍后再看", "", true);
    return;
  }
  if (data?.status === "failed") return lyricMessage("这首歌没能对齐歌词", data.reason || "", true);
  lyricMessage("这首歌没有可对齐的歌词", data?.reason || "");
}

function setLyricsFor(id) {
  clearTimeout(lyricRetry);
  const cached = lyricsCache.get(id);
  if (cached) {
    ui.lyrics = cached;
    renderLyrics(true);
    return;
  }
  lyricMessage("歌词对齐中…");
  fetchLyrics(id);
}

/* ------------------------------------------------------------------ 事件绑定 */
function bind() {
  initModals();
  $("queue").addEventListener("click", (event) => {
    const button = event.target.closest("[data-act]");
    const card = button && button.closest("[data-job]");
    if (card) onJobAction(button.dataset.act, card.dataset.job);
  });
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[data-dl]");
    if (link) toast(T("已开始下载：{0}", link.getAttribute("download") || ""), "info", 3200);
  });
  $("libGrid").addEventListener("click", (event) => {
    const play = event.target.closest("[data-lplay]");
    if (play) {
      event.stopPropagation();
      playJob(play.dataset.lplay);
      return;
    }
    const render = event.target.closest("[data-render]");
    if (render) {
      event.stopPropagation();
      renderPlanJob(render.dataset.render);
      return;
    }
    const more = event.target.closest("[data-more]");
    if (more) {
      event.stopPropagation();
      openJobFromCard(more.dataset.more);
      return;
    }
    const star = event.target.closest("[data-star]");
    if (star) {
      event.stopPropagation();
      toggleFavorite(star.dataset.star);
      return;
    }
    const card = event.target.closest("[data-lib]");
    if (!card) return;
    const id = card.dataset.lib;
    if (!hasAudio(state.byId.get(id))) {
      // 没有音频的任务没法进 A/B，点卡片直接看详情
      openJobFromCard(id);
      return;
    }
    if (ui.ab.includes(id)) ui.ab = ui.ab.filter((item) => item !== id);
    else ui.ab = [...ui.ab.slice(-1), id];
    renderLibrary();
  });
  $("libGrid").addEventListener("dblclick", (event) => {
    const card = event.target.closest("[data-lib]");
    if (card && hasAudio(state.byId.get(card.dataset.lib))) playJob(card.dataset.lib);
  });
  qa(".nav").forEach((button) => button.addEventListener("click", () => go(button.dataset.view)));
  $("btnTheme").addEventListener("click", () => toggleTheme());
  $("btnKeys").addEventListener("click", () => openModal($("keysModal")));
  $("keysX").addEventListener("click", () => closeModal($("keysModal")));
  qa("[data-close]", $("logModal")).forEach((button) => button.addEventListener("click", () => closeModal($("logModal"))));
  $("logReveal").addEventListener("click", () => { if (ui.logJob) revealJob(ui.logJob); });
  $("btnLoad").addEventListener("click", onLoadButton);
  qa(".langseg button").forEach((button) => button.addEventListener("click", () => {
    applyLang(button.dataset.lang);
    renderAll();
  }));
  qa(".devseg button").forEach((button) => button.addEventListener("click", () => onDevice(button)));

  qa(".mode").forEach((button) => button.addEventListener("click", () => {
    ui.cot = button.dataset.cot;
    qa(".mode").forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
    renderAdvanced();
    saveDraftSoon();
  }));
  $("v-studio").addEventListener("input", saveDraftSoon);
  $("v-studio").addEventListener("change", saveDraftSoon);
  qa(".chipset .chip").forEach((chip) => chip.addEventListener("click", () => toggleToken(chip)));
  $("fLang").addEventListener("change", () => {
    const parts = $("fStyle").value.split(",").map((item) => item.trim()).filter(Boolean);
    const known = ["Mandarin", "English", "Cantonese", "Japanese"];
    const rest = parts.filter((item) => !known.includes(item));
    $("fStyle").value = [$("fLang").value, ...rest].join(", ");
    syncChips();
  });
  $("fBpm").addEventListener("change", () => {
    const value = $("fBpm").value.trim();
    if (!value) return;
    const parts = $("fStyle").value.split(",").map((item) => item.trim()).filter((item) => item && !/bpm$/i.test(item));
    $("fStyle").value = [...parts, `${value} BPM`].join(", ");
  });
  $("fStyle").addEventListener("input", debounce(syncChips, 160));
  $("btnPreset").addEventListener("click", fillPreset);
  $("btnLint").addEventListener("click", lintLyrics);
  $("btnDice").addEventListener("click", () => {
    $("fSeed").value = String(Math.floor(Math.random() * 1e9));
  });
  $("fVar").addEventListener("change", renderCost);
  $("fSeed").addEventListener("change", renderCost);

  const acc = $("accAdv");
  q(".t", acc).addEventListener("click", () => {
    const open = acc.classList.toggle("open");
    q(".t", acc).setAttribute("aria-expanded", String(open));
  });
  const applyCfg = (value) => {
    ui.cfg = value;
    $("sCfg").value = String(value);
    $("nCfg").value = fmtNum(value, false, state.schema.cfg_scale.step);
    $("rstCfg").disabled = Math.abs(value - cotGuidance()) < 1e-9;
    syncAdvBadge();
  };
  $("sCfg").addEventListener("input", () => applyCfg(Number.parseFloat($("sCfg").value)));
  $("nCfg").addEventListener("change", () => {
    const raw = $("nCfg").value.trim();
    const parsed = Number(raw);
    if (raw === "" || !Number.isFinite(parsed)) {
      $("nCfg").value = fmtNum(ui.cfg ?? cotGuidance(), false, state.schema.cfg_scale.step);
      return;
    }
    applyCfg(clampValue(parsed, state.schema.cfg_scale));
  });
  $("rstCfg").addEventListener("click", () => {
    ui.cfg = null;
    renderAdvanced();
  });

  const applyOde = (value) => {
    ui.ode = value;
    $("sOde").value = String(value);
    $("nOde").value = fmtNum(value, true, state.schema.ode_steps.step);
    $("rstOde").disabled = value === state.schema.ode_steps.default;
    syncAdvBadge();
  };
  $("sOde").addEventListener("input", () => applyOde(Number.parseInt($("sOde").value, 10)));
  $("nOde").addEventListener("change", () => {
    const raw = $("nOde").value.trim();
    const parsed = Number(raw);
    if (raw === "" || !Number.isFinite(parsed)) {
      $("nOde").value = fmtNum(ui.ode ?? state.schema.ode_steps.default, true, state.schema.ode_steps.step);
      return;
    }
    applyOde(clampValue(parsed, state.schema.ode_steps));
  });
  $("rstOde").addEventListener("click", () => {
    ui.ode = null;
    renderAdvanced();
  });

  $("fVae").addEventListener("change", () => {
    ui.vae = $("fVae").value;
    $("rstVae").disabled = ui.vae === "standard";
    syncAdvBadge();
  });
  $("rstVae").addEventListener("click", () => {
    ui.vae = "standard";
    renderAdvanced();
  });
  $("btnReset").addEventListener("click", resetAdvanced);
  qa(".tabs [role=tab]").forEach((tab) => tab.addEventListener("click", () => {
    qa(".tabs [role=tab]").forEach((other) => {
      const on = other === tab;
      other.setAttribute("aria-selected", String(on));
      other.tabIndex = on ? 0 : -1;
      $(other.getAttribute("aria-controls")).hidden = !on;
    });
  }));
  $("costBrk").addEventListener("click", () => $("cost").classList.toggle("open"));
  $("costBrk").addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      $("cost").classList.toggle("open");
    }
  });
  $("btnGen").addEventListener("click", generate);
  $("btnPlan").addEventListener("click", generatePlan);
  // 引导内容会重建，按钮跟着换，用委托绑一次就够
  $("guide").addEventListener("click", (event) => {
    if (event.target.closest("#btnGuideOff")) setGuideOff();
    if (event.target.closest("#btnGuideTour")) startTour(0);
    if (event.target.closest("#btnGuidePage")) go("guide");
  });
  $("btnReplayTour").addEventListener("click", () => startTour(0));
  $("btnDemoPlay").addEventListener("click", () => {
    const job = demoJob();
    if (job) playJob(job.id);
  });
  $("btnDemoUse").addEventListener("click", () => {
    const job = demoJob();
    if (!job) return;
    reuseParams(job);
    toast(T("示例参数已填入创作表单，可以改词或直接生成"), "ok");
  });
  $("btnDemoScore").addEventListener("click", () => {
    const job = demoJob();
    if (!job) return;
    selectScoreJob(job.id);
    go("score");
  });

  $("tourSkip").addEventListener("click", endTour);
  $("tourPrev").addEventListener("click", tourPrev);
  $("tourNext").addEventListener("click", tourNext);
  const repositionTour = () => {
    if (tourIndex < 0) return;
    const step = TOUR_STEPS[tourIndex];
    const target = step ? q(step.target) : null;
    tourCardPosition(target ? target.getBoundingClientRect() : null);
  };
  window.addEventListener("resize", repositionTour);
  window.visualViewport?.addEventListener("resize", repositionTour);
  window.visualViewport?.addEventListener("scroll", repositionTour);

  $("scoreJob").addEventListener("change", () => {
    selectScoreJob($("scoreJob").value);
    renderScore();
  });
  $("btnInspect").addEventListener("click", inspectScore);
  $("btnCompare").addEventListener("click", compareScore);
  $("btnStrip").addEventListener("click", stripScoreChords);
  $("btnInstr").addEventListener("click", instrumentalizeScore);
  $("btnRerender").addEventListener("click", generateRerender);
  initRoll();

  qa("[data-filter]").forEach((chip) => chip.addEventListener("click", () => {
    ui.filter = chip.dataset.filter;
    qa("[data-filter]").forEach((other) => other.setAttribute("aria-pressed", String(other === chip)));
    renderLibrary();
  }));
  $("libSearch").addEventListener("input", debounce(() => {
    ui.search = $("libSearch").value;
    renderLibrary();
  }, 200));
  $("libSort").addEventListener("change", () => {
    ui.sort = $("libSort").value in SORTS ? $("libSort").value : "new";
    try { localStorage.setItem(SORT_KEY, ui.sort); } catch (exc) {}
    renderLibrary();
  });
  $("btnReload").addEventListener("click", async () => {
    await loadJobs();
    renderLibrary();
    toast(T("已刷新"), "ok");
  });
  $("btnAB").addEventListener("click", applyAB);

  $("abcEd").addEventListener("scroll", (event) => {
    const top = event.target.scrollTop;
    $("abcHl").scrollTop = top;
    $("abcHl").scrollLeft = event.target.scrollLeft;
    $("gut").style.transform = `translateY(${-top}px)`;
  });
  $("abcEd").addEventListener("input", () => {
    ui.scoreAbc = $("abcEd").value;
    if (ui.scoreAbc === ui.scoreOriginal) scoreDrafts.delete(ui.scoreJob);
    scheduleAbcPaint();
    scheduleRoll();
  });

  $("btnLoadCpu").addEventListener("click", () => onDevice({dataset: {dev: "cpu"}}));
  $("btnLoadGpu").addEventListener("click", () => onDevice({dataset: {dev: "cuda"}}));
  $("btnUnload").addEventListener("click", onLoadButton);
  $("btnDoctor").addEventListener("click", async () => {
    $("btnDoctor").disabled = true;
    try {
      await loadDoctor(true);
      toast(T("环境自检完成"), "ok");
    } catch (exc) {
      toast(message(exc), "bad");
    } finally {
      $("btnDoctor").disabled = false;
      renderSystem();
    }
  });
  $("btnAccelReset").addEventListener("click", async () => {
    if (!await confirmDialog({
      title: T("恢复默认设置"),
      body: esc(T("两个加速开关都会关掉，回到官方基准内核。")),
      ok: T("恢复"), cancel: T("取消"),
    })) return;
    try {
      await resetSettings();
      toast(T("已恢复默认：两个加速开关都关闭"), "ok");
    } catch (exc) {
      toast(message(exc), "bad");
    }
    renderSystem();
  });

  qa(".ab button").forEach((button) => button.addEventListener("click", () => {
    if (ui.ab.length !== 2) return;
    ui.side = button.dataset.ab;
    qa(".ab button").forEach((other) => other.classList.toggle("on", other === button));
    const at = player.currentTime;
    loadTrack(ui.ab[ui.side === "a" ? 0 : 1]);
    playFrom(at);
  }));

  $("ppBtn").addEventListener("click", () => {
    if (!ui.track) return;
    togglePlay();
  });
  $("lyrTg").addEventListener("click", () => toggleLyrics());
  $("lyrRetry").addEventListener("click", retryLyrics);
  $("lyrList").addEventListener("click", (event) => {
    const row = event.target.closest(".lyrLine");
    if (!row) return;
    const at = Number(row.dataset.start);
    if (!Number.isFinite(at)) return;
    player.currentTime = Math.max(0, at + 0.05);
    if (player.paused) player.play().catch(() => {});
    renderLyrics(true);
  });
  $("volR").addEventListener("input", () => {
    const value = Number.parseInt($("volR").value, 10);
    player.volume = value / 100;
    try { localStorage.setItem(VOL_KEY, String(value)); } catch (exc) {}
  });
  $("prevBtn").addEventListener("click", () => skipTrack(-1));
  $("nextBtn").addEventListener("click", () => skipTrack(1));
  $("dlBtn").addEventListener("click", () => {
    const job = ui.track ? state.byId.get(ui.track) : null;
    if (!ui.track) return;
    const link = document.createElement("a");
    link.href = audioUrl(ui.track);
    link.download = dlName(job || {id: ui.track});
    document.body.appendChild(link);
    link.click();
    link.remove();
    toast(T("已开始下载：{0}", link.download), "info", 3200);
  });
  q(".track").addEventListener("click", seekFromEvent);
  $("wave").addEventListener("keydown", (event) => {
    if (!player.duration) return;
    const step = event.shiftKey ? 10 : 5;
    if (event.key === "ArrowRight") player.currentTime = Math.min(player.duration, player.currentTime + step);
    else if (event.key === "ArrowLeft") player.currentTime = Math.max(0, player.currentTime - step);
    else return;
    event.preventDefault();
  });

  player.addEventListener("play", () => {
    $("ppIcon").innerHTML = '<path d="M4.5 2.5h2.6v11H4.5zM8.9 2.5h2.6v11H8.9z"/>';
    $("ppBtn").setAttribute("aria-label", T("暂停"));
  });
  player.addEventListener("pause", () => {
    $("ppIcon").innerHTML = '<path d="M4 2l10 6-10 6z"/>';
    $("ppBtn").setAttribute("aria-label", T("播放"));
  });
  player.addEventListener("ended", () => {
    paintWave(0);
    $("tCur").textContent = fmtClock(0);
  });
  player.addEventListener("seeked", () => renderLyrics(true));
  player.addEventListener("timeupdate", () => {
    const ratio = player.duration ? player.currentTime / player.duration : 0;
    $("tCur").textContent = fmtClock(player.currentTime);
    $("tDur").textContent = fmtClock(player.duration || 0);
    $("wave").setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    paintWave(ratio);
    renderLyrics(false);
  });
  player.addEventListener("error", () => {
    if (!player.src) return;
    toast(T("音频加载失败 · 产物可能还没写出"), "bad");
  });
  $("volR").value = String(readVolume());
  player.volume = readVolume() / 100;

  document.addEventListener("keydown", (event) => {
    if (tourIndex >= 0) {
      if (event.key === "Escape") { event.preventDefault(); endTour(); }
      else if (event.key === "ArrowRight" || event.key === "Enter") { event.preventDefault(); tourNext(); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); tourPrev(); }
      return;
    }
    const tag = (event.target.tagName || "").toLowerCase();
    const typing = ["input", "textarea", "select"].includes(tag) || event.target.isContentEditable;
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      if (modalOpen() || ui.view !== "studio" || $("btnGen").disabled) return;
      event.preventDefault();
      generate();
      return;
    }
    if (typing || modalOpen() || event.ctrlKey || event.metaKey || event.altKey) return;
    const digit = Number.parseInt(event.key, 10);
    if (Number.isInteger(digit) && digit >= 1 && digit <= VIEWS.length) {
      go(VIEWS[digit - 1]);
      return;
    }
    /* 焦点在按钮/链接上时空格是"激活它"，别再抢去当播放开关 */
    const onControl = !!event.target.closest?.("button, a, summary, [role=button]");
    if (event.key === " " && !onControl) {
      event.preventDefault();
      togglePlay();
    } else if (event.key === "t" || event.key === "T") toggleTheme();
    else if (event.key === "l" || event.key === "L") {
      toggleLang();
      renderAll();
    } else if (event.key === "?") openModal($("keysModal"));
  });

  document.addEventListener("yue2:lang", () => {
    paintTitle();
    if (state.presets && state.presets.length) {
      const current = $("fPreset").value;
      $("fPreset").innerHTML = state.presets.map((preset) =>
        `<option value="${esc(preset.id)}">${esc(T(preset.name))}</option>`).join("");
      $("fPreset").value = current;
    }
    renderAdvanced();
    renderAll();
    paintTrackMeta();
    paintWave(player.duration ? player.currentTime / player.duration : 0);
    toggleLyrics($("lyr").classList.contains("open"));
    if (ui.lyrics) renderLyrics(true);
    else lyricMessage(ui.lyricNote);
    if (tourIndex >= 0) showTourStep();
  });
}

/* ------------------------------------------------------------------ 数据订阅 */
let lastStageJob = null;
let celebratedAt = -1;  // -1：首次加载只做基线，不弹提示
subscribe((what) => {
  if (what === "model" || what === "connection" || what === "schema") {
    renderTopbar();
    renderRail();
    if (ui.view === "system") renderSystem();
  }
  if (what === "jobs" || what === "job") {
    renderRail();
    refreshSkip();
    renderCost();
    if (ui.view === "studio") renderQueue();
    if (ui.view === "library") renderLibrary();
    if (ui.view === "score") renderScore();
    if (ui.view === "guide") renderGuideView();
    const doneNow = state.jobs.filter((item) => item.status === "complete" && item.artifacts?.["audio.flac"]).length;
    if (celebratedAt === -1) celebratedAt = doneNow;
    else if (doneNow > celebratedAt) {
      celebratedAt = doneNow;
      titleFlag = true;
      paintTitle();
      toast(T("有一首歌完成了！去曲库试听，或在乐谱工作台看谱面"), "ok");
    }
  }
  if (what === "stage") {
    if (state.stage?.job !== lastStageJob) {
      lastStageJob = state.stage?.job || null;
    }
    if (ui.view === "studio") paintQueueStage();
  }
  if (what === "presets") {
    $("fPreset").innerHTML = state.presets.map((preset) =>
      `<option value="${esc(preset.id)}">${esc(T(preset.name))}</option>`).join("");
  }
  if (what === "doctor" && ui.view === "system") renderDoctor();
  if (what === "lyrics") {
    const id = state.lyricsEvent?.job;
    if (id && id === ui.track) fetchLyrics(id);
  }
  if (what === "bootstrap") {
    renderAdvanced();
    renderAll();
  }
});

/* ------------------------------------------------------------------ 启动 */
async function main() {
  bind();
  paintWave(0);
  const dropTitleFlag = () => {
    if (!titleFlag) return;
    titleFlag = false;
    paintTitle();
  };
  window.addEventListener("focus", dropTitleFlag);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) dropTitleFlag(); });
  try {
    const savedSort = localStorage.getItem(SORT_KEY);
    if (savedSort && savedSort in SORTS) ui.sort = savedSort;
  } catch (exc) {}
  const hash = window.location.hash.replace("#", "");
  if (VIEWS.includes(hash)) ui.view = hash;
  await bootstrap();
  const draft = readDraft();
  if (draft && (draft.style.trim() || draft.lyrics.trim())) {
    applyDraft(draft);
    toast(T("已恢复上次没发出去的草稿"), "info");
  } else if (prefillExample()) {
    /* 首次打开先填范例，基准同样记在这里：没改动就不该弹覆盖确认 */
  }
  markFormBase();
  renderGuide();
  applyLang(getLang());
  renderAll();
  lyricMessage(ui.lyricNote);
  go(ui.view);
  if (!tourSeen() && ui.view === "studio" && window.innerWidth >= 900) {
    setTimeout(() => startTour(0), 700);
  }
  window.addEventListener("hashchange", () => {
    const next = window.location.hash.replace("#", "");
    if (VIEWS.includes(next) && next !== ui.view) go(next);
  });
  const missing = state.schema ? null : T("后端约束还没取到，界面先用官方默认值");
  if (missing) toast(missing, "warn");
  if (!state.jobs.length) toast(T("曲库是空的 · 生成第一首后会出现在这里"));
  window.addEventListener("error", (event) => {
    if (event.message) toast(T("界面出错：{0}", event.message), "bad");
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    if (reason && reason.name === "AbortError") return;
    const text = reason instanceof Error ? reason.message : String(reason ?? "");
    if (!text) return;
    console.error("未处理的异步异常", reason);
    toast(T("界面出错：{0}", text), "bad");
  });
}

main();
