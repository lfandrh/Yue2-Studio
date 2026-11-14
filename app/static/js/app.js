/* 主脚本：路由 + 视图渲染 + 真实后端联动（B2 外壳）。
   约定：state 里只有中文原文与原始数据，翻译发生在渲染时（T()）；
   文件名 / 参数名 / 歌词 / 报错原文是数据，用 data-notr 或 esc() 直出，不进词典。 */
"use strict";

import {T, applyLang, getLang, toggleLang, toggleTheme, trDom} from "./i18n.js";
import {icon, q, qa, esc, notr, fmtClock, fmtStamp, fmtDate, debounce, toast,
        openModal, closeModal, modalOpen, confirmDialog, initModals} from "./ui.js";
import {state, subscribe, bootstrap, loadModel, loadJobs, loadJob, loadDoctor, loadModelOn,
        unloadModel, createJob, cancelJob, updateJob, deleteJob, renameWork, audioUrl,
        artifactUrl, loadSettings, saveSettings, resetSettings,
        loadVersion, checkUpdate, downloadUpdate, applyUpdate, loadUpdateStatus,
        get, post, put, downloadFile, ApiError, pollCountdown} from "./store.js";
import {displayName, versionLabel, workName, subtitleName} from "./naming.js";
import {storageKey, readRaw, readJson, writeJson, removeRaw, readText, writeText, readNumber,
        writeNumber, validators} from "./storage.js";

const $ = (id) => document.getElementById(id);
const VIEWS = ["studio", "score", "library", "guide", "system"];
const AXIS = ["plan", "semantic", "nar", "decode"];
const PHASE_NAME = {plan: "规划乐谱", semantic: "语义生成", nar: "非自回归合成", decode: "解码导出"};
const PHASE_ACT = {
  load: "正在加载模型",
  plan: "正在规划旋律与和弦",
  semantic: "正在逐词元生成整首歌的音频序列",
  nar: "正在把音频序列合成为波形",
  decode: "正在解码导出 FLAC",
};
const STAGE_PHASE = {
  "Planning score": "plan", "Using provided score": "plan",
  "Generating song": "semantic",
  "Synthesizing audio": "nar",
  "Decoding audio": "decode", "Loading audio decoder": "decode",
  "Loading model": "load", "Resolving model files": "load", "Verifying model files": "load",
};

const ui = {
  view: "studio",
  cot: "full",
  device: "auto",
  switching: false,
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
  scoreStamp: "",
  scoreHash: "",
  useScore: false,
  inspect: null,
  rollTab: "roll",
  rollTabAuto: false,
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
  subOpen: new Set(),
  logJob: null,
  logStart: 0,
  logTotal: 0,
  logLoaded: false,
  logSession: 0,
  logBusy: false,
  consoleWatched: new Set(),
  foldedJob: null,
  cancelRequested: new Set(),
  lastPct: new Map(),
  lastPhase: new Map(),
  runStarted: new Map(),
  stageDone: new Map(),
  axisKey: "",
  actionsKey: "",
  headKey: "",
  liveKey: "",
  alertKey: "",
  clockTimer: null,
};

/* ------------------------------------------------------------------ 路由 */
/* 离开乐谱工作台时的写回询问：有未写回服务器的草稿就问一次。
   保存 → PUT /score 写回（服务端自动备份原谱）并清本地草稿；
   不保存 → 什么都不写，草稿留在本机，下次回来还能接着改。 */
async function leaveScoreGuard(nextView) {
  if (ui.view !== "score" || nextView === "score") return;
  if (!ui.scoreJob || !ui.scoreAbc.trim() || ui.scoreAbc === ui.scoreOriginal) return;
  const ok = await confirmDialog({
    title: T("谱面改动还没写回"),
    body: esc(T("离开前把当前谱面写回服务器吗？选「不保存」的话，改动仍保留在本机草稿里，下次回来还能接着改。")),
    ok: T("保存并写回"), cancel: T("不保存"),
  });
  if (!ok) return;
  try {
    const result = await put(`/api/jobs/${encodeURIComponent(ui.scoreJob)}/score`, {
      abc: ui.scoreAbc, expected_sha256: ui.scoreHash,
    });
    if (result?.status === "saved" || result?.status === "unchanged") {
      ui.scoreOriginal = ui.scoreAbc;
      ui.scoreHash = result.sha256 || ui.scoreHash;
      scoreDrafts.delete(ui.scoreJob);
      localDraftSave(ui.scoreJob, undefined);
      ui.scoreLoadedJob = null; // 下次进入强制重拉，直接看到写回后的版本
      toast(result.status === "saved"
        ? T("谱面已写回原任务（原谱已备份）")
        : T("谱面与服务器一致，已同步当前版本"), "ok");
      refreshScoreStateNote();
    } else {
      toast(T("写回结果异常 · 改动仍留在本机草稿"), "warn");
    }
  } catch (exc) {
    if (exc instanceof ApiError && (exc.status === 409 || exc.status === 428)) {
      toast(T("乐谱已在另一个页面被修改或版本已过期，当前改动仍留在本机草稿；请刷新后再写回"), "warn");
    } else {
      toast(T("写回失败（{0}）· 改动仍留在本机草稿", message(exc)), "warn");
    }
  }
}

function go(view, {jobId = null} = {}) {
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
  refreshLiveSurfaces();
  if (jobId) focusJobCard(jobId); else $("work").scrollTop = 0;
}

function focusJobCard(jobId) {
  requestAnimationFrame(() => {
    const card = document.querySelector(`.jobc[data-job="${jobId}"]`);
    if (!card) return;
    card.scrollIntoView({behavior: "smooth", block: "center"});
    card.classList.add("flash");
    setTimeout(() => card.classList.remove("flash"), 1800);
  });
}

function renderView() {
  if (ui.view === "studio") {
    renderStudioScore();
    renderQueue();
  }
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
    const useCdf = model.device === "cpu" && model.reason
      ? T(" · {0}，已降到 CPU 跑", model.reason) : "";
    const extra = model.seconds ? T(" · 用时 {0}", fmtStamp(model.seconds)) : "";
    const degraded = model.reason && !useCdf ? ` · ${T(model.reason)}` : "";
    return T("模型已加载 · {0}{1}{2}", device, useCdf || extra + degraded, "");
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

const NOTICE_KEY = "notice.seen";
const noticeSeen = new Set(readJson(
  NOTICE_KEY, (value) => Array.isArray(value) && value.every((item) => typeof item === "string"), []));

/* 启动时的恢复/中断通知：常驻到用户点掉，并且只提示一次 */
function showNotices() {
  for (const notice of state.notices || []) {
    if (!notice?.id || noticeSeen.has(notice.id)) continue;
    noticeSeen.add(notice.id);
    writeJson(NOTICE_KEY, [...noticeSeen].slice(-30));
    const count = Number(notice.count || notice.jobs?.length || 0);
    if (notice.kind === "restore-failed") {
      toast(T("任务索引恢复失败：曲库可能显示为空，但磁盘产物还在。请查看 runs/app.log，修好后重启服务"), "bad", 0);
      continue;
    }
    const text = notice.kind === "recovered"
      ? T("上次运行中断后，已从磁盘恢复 {0} 个任务；完整产物仍可播放", count)
      : T("上次运行中断：{0} 个未完成任务已标记失败，可打开详情查看日志", count);
    toast(text, notice.kind === "recovered" ? "warn" : "bad", 0);
  }
}

let lastBackendError = "";
let outageToast = null;
function showBackendError() {
  const text = String(state.error || "");
  if (!text || text === lastBackendError) return;
  lastBackendError = text;
  toast(T("后端报错：{0}", text), "bad", 0);
}

function modelTitle() {
  const model = state.model;
  const gpu = model.gpu || {};
  return model.state === "loaded"
    ? `${model.device_name || model.device || ""}${model.reason ? ` · ${model.reason}` : ""}`
    : gpu.reason || "";
}

/* 滑杆填充轨道：CSS 用 --p 画已填充段（linear-gradient 到 var(--p)），
   值一变就要同步写回，否则填充恒停在 50% 档。 */
function paintRange(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value);
  const p = Number.isFinite(value) && max > min ? ((value - min) / (max - min)) * 100 : 50;
  input.style.setProperty("--p", `${p.toFixed(2)}%`);
}
/* 用户拖动统一在这里补画；程序赋值的路径各自显式调 paintRange */
document.addEventListener("input", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.type === "range") paintRange(event.target);
});
qa('input[type=range]').forEach(paintRange);

function renderTopbar() {
  const model = state.model;
  const gpu = model.gpu || {};
  const working = state.jobs.some((job) => job.status === "running");
  const busy = ui.switching || model.state === "loading" || model.state === "unloading" ||
    !!model.busy || working;
  const box = $("mstat");
  box.classList.toggle("on", model.state === "loaded");
  box.classList.toggle("busy", busy);
  $("mstatText").textContent = modelText();
  box.title = modelTitle();
  if (state.connected) sawConnected = true;
  $("netBadge").hidden = state.connected || (!sawConnected && !state.error);

  const device = currentDevice();
  /* 设备单按钮：显示当前在哪跑，点击切到另一边 */
  const onCpu = device !== "cuda";
  $("devLbl").textContent = onCpu ? "CPU" : "GPU";
  /* 可见文本是 GPU/CPU：accessible name 要包含它（WCAG 2.5.3 Label in Name） */
  $("btnDevice").setAttribute("aria-label", T("运行设备：{0}", onCpu ? "CPU" : "GPU"));
  $("icoDev").innerHTML = onCpu
    ? '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>'
    : '<rect x="2" y="7" width="20" height="10" rx="2"/><circle cx="8" cy="12" r="2.2"/><path d="M14 10h5M14 14h5"/>';
  const other = onCpu ? "cuda" : "cpu";
  const devBtn = $("btnDevice");
  const blocked = other === "cuda" && gpu.available && !gpu.suitable;
  devBtn.disabled = busy || (other === "cuda" && !gpu.available) || blocked;
  devBtn.title = blocked ? (gpu.reason || "")
    : working ? T("生成中不能切换设备，等当前任务结束")
      : T("运行设备：{0} · 点击切换到 {1}", onCpu ? "CPU" : T("显卡"), onCpu ? T("显卡") : "CPU");

  const loaded = model.state === "loaded";
  $("btnLoad").disabled = busy;
  $("btnLoad").querySelector(".lb").textContent = loaded ? T("卸载模型") : T("加载模型");
  $("btnLoad").querySelector("svg").innerHTML =
    '<path d="M21 8.5 12 3 3 8.5v7L12 21l9-5.5z"/><path d="M3 8.5 12 14l9-5.5M12 14v7"/>';

  /* 语言单按钮：显示要切换到的语言（界面文案惯例：按钮说点击后发生什么） */
  const langNow = getLang();
  $("langLbl").textContent = langNow === "zh" ? "EN" : "中";
  const langTitle = langNow === "zh" ? T("切换到 English（快捷键 L）") : T("切换到中文（快捷键 L）");
  $("btnLang").title = langTitle;
  $("btnLang").setAttribute("aria-label", langTitle);
  $("icoSun").parentElement.setAttribute("aria-label", T("切换深浅色主题"));
  paintTopbarStatus(consoleModel());
}

/* 当前设备：模型已加载看实际加载的那台，否则看用户选择（auto 则跟默认）。
   头部按钮、侧栏底部、切换请求必须用同一份，别让两处显示各说各话 */
function currentDevice() {
  const model = state.model;
  return model.state === "loaded" ? model.device : ui.device === "auto" ? model.default_device : ui.device;
}

function renderRail() {
  const active = state.jobs.filter((job) => job.status === "running" || job.status === "queued").length;
  const done = state.jobs.filter((job) => job.status === "complete").length;
  // 计数为 0 时不显示徽标，避免零值也像一条待处理提醒
  $("cStudio").textContent = String(active);
  $("cStudio").classList.toggle("q", active > 0);
  $("cStudio").hidden = active === 0;
  $("cLib").textContent = String(done);
  $("cLib").hidden = done === 0;
  const device = currentDevice() === "cuda" ? T("显卡") : "CPU";
  $("railfoot").innerHTML = `${esc(T("单任务队列"))}<br>${esc(T("设备：{0}", device))}`;
}

/* ------------------------------------------------------------------ 模型操作 */
async function onDevice(want) {
  const model = state.model;
  const name = (dev) => dev === "cuda" ? T("显卡") : "CPU";
  if (ui.switching || model.state === "loading" || model.state === "unloading") {
    toast(T("正在切换设备，请稍候"), "info");
    return;
  }
  // 已在目标设备：不重载、不提示，避免点一下就白等一次加载。
  if (model.state === "loaded" && model.device === want) return;
  const queued = state.jobs.filter((job) => job.status === "queued").length;
  if (model.state === "loaded") {
    const seconds = Number(model.seconds);
    const gpuNote = want === "cuda" && model.device === "cpu" && model.reason
      ? `<br>${esc(T("上次 GPU 加载失败：{0}", model.reason))}` : "";
    const jobNote = queued
      ? `<br>${esc(T("队列里 {0} 个任务会一起改到{1}上运行。", queued, name(want)))}` : "";
    const ok = await confirmDialog({
      title: T("切换运行设备？"),
      body: esc(T("模型正在{0}上运行。切到{1}会先卸载再重新加载，期间不能开始新任务。",
        name(model.device), name(want))) +
        (seconds > 0 ? `<br>${esc(T("上次加载用了约 {0} 秒。", Math.round(seconds)))}` : "") +
        jobNote + gpuNote,
      ok: T("切换"), cancel: T("取消"),
    });
    if (!ok) return;
  }
  ui.switching = true;
  ui.device = want;
  const dismiss = toast(T("正在把模型切到{0}…", name(want)), "info", 0);
  try {
    await loadModelOn(want, {reassignQueued: true});
    const loaded = state.model;
    if (loaded.state === "loaded") {
      if (loaded.device !== want) {
        // GPU 失败时停下来问用户，不静默切 CPU（P0-5）
        if (want === "cuda" && loaded.device === "cpu") {
          const retryCpu = await confirmDialog({
            title: T("显卡加载失败，停下来问你"),
            body: esc(T("显卡没能起起来（{0}）。不自动降到 CPU。", loaded.reason || T("未知原因"))) +
              `<br>${esc(T("选「改在 CPU 跑」会继续用 CPU 生成；选「回滚到显卡」保持显卡，任务先停住，等你腾出显存或关掉占显存的程序后再手动点显卡重试。"))}`,
            ok: T("改在 CPU 跑"), cancel: T("回滚到显卡"), danger: true,
          });
          if (retryCpu) {
            ui.device = "cpu";
            toast(T("已改为 CPU 继续 · {0}", loaded.reason || ""), "warn");
          } else {
            ui.device = "cuda";
            toast(T("已回滚到显卡，任务先停住，等你腾好显存再手动点显卡重试"), "warn");
          }
        } else {
          // 自动降级后把选中的设备一起落到真实那台：否则顶栏仍按着显卡、提交却写显卡，
          // 而任务是 CPU 跑的，任务卡和耗时全都对不上。
          ui.device = loaded.device;
          toast(T("已自动降级到 CPU · {0}", loaded.reason || ""), "warn");
        }
      } else {
        toast(T("模型已加载到 {0} · 可以开始生成", name(want)), "ok");
      }
    } else {
      toast(loaded.reason || T("模型加载失败"), "bad");
    }
  } catch (exc) {
    toast(message(exc), "bad");
    loadModel().catch(() => {});
  } finally {
    ui.switching = false;
    if (dismiss) dismiss();
    renderTopbar();
  }
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
    // onDevice 的参数是设备名字符串（"cpu"/"cuda"），不要传包装对象——
    // 传对象会被原样塞进 POST /api/model/load 的 device 字段并被后端拒绝，
    // 还会污染 ui.device，连带生成请求一起失败。
    await onDevice(ui.device === "auto" ? (model.default_device || "cpu") : ui.device);
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
  if (/^seed must be/i.test(e)) return T("随机种子超出范围：需为 0 到 2^53 之间的整数");
  if (/^ode_steps must be/i.test(e)) return T("求解步数超出范围：只能填 1 到 200");
  if (/^cfg_scale must be/i.test(e)) return T("文本引导强度超出范围：只能填 0 到 20");
  if (/^favorite must be/i.test(e)) return T("收藏状态只接受 true / false");
  if (/^title must be/i.test(e)) return T("标题最多 200 个字");
  if (/budget exceeds 24576|no implicit truncation/i.test(e)) {
    return T("歌词或风格超出模型上下文（24576）：请精简歌词，或把 max_tokens 调小");
  }
  if (/Incomplete native two-voice ABC/i.test(e)) return T("谱面不完整：原生双声部 ABC 缺少收尾内容");
  if (/Expected native X:1 and blank T: header/i.test(e)) {
    return T("谱头不符合原生格式：第 1 行必须是 X:1，第 2 行 T: 必须留空（曲名不要写在 T: 里）；方块谱无法校验，但官方生成链路仍会照原文渲染");
  }
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
const DRAFT_KEY = "draft";
let draftTimer = 0;

function draftSnapshot() {
  return {
    style: $("fStyle").value, lyrics: $("fLyrics").value,
    bpm: $("fBpm").value, lang: $("fLang").value, seed: $("fSeed").value,
    count: $("fVar").value, cot: ui.cot, cfg: ui.cfg, ode: ui.ode, vae: ui.vae,
    name: $("fSongName").value,
    sampling: {abc: {...ui.sampling.abc}, semantic: {...ui.sampling.semantic}},
    scoreJob: ui.scoreJob || "",
    useScore: ui.useScore === true,
  };
}

function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = 0;
  try {
    const snap = draftSnapshot();
    if (!snap.style.trim() && !snap.lyrics.trim() && !snap.name.trim()) {
      removeRaw(DRAFT_KEY);
      return;
    }
    writeJson(DRAFT_KEY, snap);
  } catch (exc) { /* 隐私模式下存不了就算了 */ }
}

function saveDraftSoon() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 400);
}

function readDraft() {
  return readJson(DRAFT_KEY, (data) =>
    data !== null && typeof data === "object" && !Array.isArray(data) &&
    typeof data.style === "string" && validators.optionalText(data.lyrics) &&
    validators.optionalText(data.name), null);
}

function clearDraft() {
  clearTimeout(draftTimer);
  draftTimer = 0;
  removeRaw(DRAFT_KEY);
}

function applyDraft(draft) {
  $("fStyle").value = draft.style || "";
  $("fLyrics").value = draft.lyrics || "";
  if (draft.bpm) $("fBpm").value = draft.bpm;
  if (draft.lang) $("fLang").value = draft.lang;
  $("fSeed").value = draft.seed ?? "";
  $("fVar").value = ["1", "2", "3", "4"].includes(String(draft.count)) ? String(draft.count) : "1";
  $("fSongName").value = draft.name || "";
  ui.cot = ["full", "melody", "off"].includes(draft.cot) ? draft.cot : "full";
  qa(".mode").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.cot === ui.cot)));
  ui.cfg = Number.isFinite(draft.cfg) ? draft.cfg : null;
  ui.ode = Number.isFinite(draft.ode) ? draft.ode : null;
  ui.vae = draft.vae || "standard";
  ui.sampling = {
    abc: {...(draft.sampling && draft.sampling.abc || {})},
    semantic: {...(draft.sampling && draft.sampling.semantic || {})},
  };
  ui.scoreJob = draft.scoreJob || "";
  ui.scoreLoadedJob = null;
  ui.useScore = draft.useScore === true;
  syncChips();
  renderAdvanced();
  renderCost();
}

/* 跨标签草稿冲突提示（BUG-009 方案 A：只提醒，不覆盖）。
   storage 事件只在"别的窗口"写入同一键时触发；若那份草稿和本窗口表单不一致，
   说明本窗口没发出去的内容刷新后会丢，提示一句让用户自己决定。
   3 秒节流：对方连续打字时每个防抖保存都会发一次事件，不能刷屏。 */
let draftConflictAt = 0;
window.addEventListener("storage", (event) => {
  if (event.key !== storageKey(DRAFT_KEY) || event.storageArea !== window.localStorage) return;
  const now = Date.now();
  if (now - draftConflictAt < 3000) return;
  let incoming = null;
  try { incoming = JSON.parse(event.newValue || "null"); } catch (exc) { return; }
  const mine = formSnapshot();
  if (!incoming || typeof incoming !== "object") {
    /* 对方把草稿清了（多半是已提交）：本窗口还有没发出去的内容才值得提 */
    if (mine.split("\u0000").some((part) => part)) {
      draftConflictAt = now;
      toast(T("其他窗口已把共享草稿提交/清空；本窗口的内容还没发出去，刷新前先想一下"), "warn");
    }
    return;
  }
  const theirs = `${String(incoming.style || "").trim()}\u0000${String(incoming.lyrics || "").trim()}`;
  if (theirs === mine) return;
  draftConflictAt = now;
  toast(T("草稿刚被其他窗口更新；本窗口还是自己的内容，直接刷新会丢掉这边没发的修改"), "warn", 8000);
});

/* 首次打开时表单是空的，新手连点「生成」都只会拿到一句「风格为空」。
   这里先替他填好第一个范例；用户改任何一个字都不影响，只是省掉从零开始。 */
function prefillExample() {
  if ($("fStyle").value.trim() || $("fLyrics").value.trim()) return false;
  const preset = state.presets && state.presets[0];
  if (!preset) return false;
  $("fPreset").value = preset.id;
  return applyPreset(preset);
}

let lintSeq = 0;

const lintLineText = (line) => esc(T("第 {0} 行：{1}", line.line + 1, T(line.warning))) +
  (line.chars?.length ? ` <span class="mono" data-notr>${esc(line.chars.slice(0, 8).join(" "))}</span>` : "") +
  (line.kind === "tag" ? ` <span class="mono" data-notr>${esc(line.text)}</span>` : "");

async function lintLyrics({quiet = false} = {}) {
  const lyrics = $("fLyrics").value;
  const note = $("lintNote");
  if (!lyrics.trim()) {
    if (!quiet) {
      note.hidden = false;
      note.className = "note bad";
      note.textContent = T("歌词为空");
    }
    return {ok: false, blockers: [T("歌词为空")], warnings: [], lines: []};
  }
  const seq = ++lintSeq;
  try {
    const result = await post("/api/lyrics/lint", {lyrics});
    if (seq !== lintSeq) return null;
    const blockers = result.blockers || [];
    const warnings = result.warnings || [];
    const lines = (result.lines || []).filter((line) => line.warning);
    note.hidden = false;
    note.className = blockers.length ? "note bad" : (warnings.length || lines.length ? "note" : "note ok");
    if (blockers.length || warnings.length || lines.length) {
      note.innerHTML =
        `<b>${esc(blockers.length ? T("歌词有 {0} 个问题，生成前需要处理", blockers.length)
          : T("结构检查：{0} 条提醒", warnings.length + lines.length))}</b>` +
        `<ul style="margin:var(--sp2) 0 0 var(--sp4);font-size:13px">` +
        [...blockers.map((text) => `<li>${esc(T(text))}</li>`),
         ...warnings.map((text) => `<li>${esc(T(text))}</li>`),
         ...lines.map((line) => `<li>${lintLineText(line)}</li>`)].join("") +
        `</ul>`;
    } else {
      note.textContent = T("结构检查通过：段落标记齐全，行长在 {0} 个音节以内", "7–16");
    }
    return {...result, blockers, warnings, lines};
  } catch (exc) {
    if (seq !== lintSeq) return null;
    note.hidden = false;
    note.className = "note bad";
    note.textContent = message(exc);
    return {ok: false, blockers: [message(exc)], warnings: [], lines: []};
  }
}

function advancedChanged() {
  const schema = state.schema;
  if (!schema) return false;
  if (ui.cfg !== null && Math.abs(ui.cfg - cotGuidance()) > 1e-9) return true;
  if (ui.ode !== null && ui.ode !== schema.ode_steps.default) return true;
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

/* 后端约束（上下限/步长）没取到时把高级参数控件锁住：这些控件的合法范围只有一个
   来源，缺了就只能要么抛 TypeError、要么前端再硬编码一份默认值，两者都更糟。 */
const ADV_GATE = ["sCfg", "nCfg", "sOde", "nOde", "fVae"];

function gateAdvanced(ready) {
  for (const id of ADV_GATE) {
    const el = $(id);
    el.disabled = !ready;
    el.title = ready ? "" : T("后端约束还没取到，界面先用官方默认值");
  }
}

function renderAdvanced() {
  const schema = state.schema;
  gateAdvanced(Boolean(schema));
  if (!schema) return;
  syncAdvBadge();

  const cfg = ui.cfg ?? cotGuidance();
  const cfgRange = $("sCfg");
  cfgRange.min = String(schema.cfg_scale.min);
  cfgRange.max = String(schema.cfg_scale.max);
  cfgRange.step = String(schema.cfg_scale.step);
  cfgRange.value = String(cfg);
  paintRange(cfgRange);
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
  paintRange(odeRange);
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
          paintRange(range);
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
      paintRange(range);
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

/* 提交给后端的设备：已加载就用真正加载上的那台，别让顶栏按下的键和请求体分叉；
   选「自动」时保持 auto，开跑时由后端按当前模型定，比前端猜一个默认值准。 */
function submitDevice() {
  if (state.model.state === "loaded" && state.model.device) return state.model.device;
  return ui.device === "auto" ? "auto" : ui.device;
}

/* 歌词长度：中日韩按字、英文按词折算，用来把参考任务的时间按篇幅缩放 */
function lyricUnits(text) {
  const clean = String(text || "").replace(/\[[^\]]*\]/g, " ");
  const cjk = (clean.match(/[\u3400-\u9fff]/g) || []).length;
  const words = (clean.match(/[A-Za-z]+/g) || []).length;
  return cjk + words * 1.4;
}

/* 估算只认同设备、完整歌曲、有实测分阶段耗时的任务：跨设备数字会给用户假精度。 */
function referenceJob(device) {
  const complete = (timing) => timing && timing.abc && timing.semantic
    && Number.isFinite(timing.abc.seconds) && Number.isFinite(timing.semantic.seconds)
    && Number.isFinite(timing.nar_seconds) && Number.isFinite(timing.vae_seconds);
  const pool = state.jobs.filter((job) => job.status === "complete" && job.type === "song"
    && !job.demo && job.artifacts?.["audio.flac"]
    && Number.isFinite(job.result?.timing?.e2e_seconds) && complete(job.result.timing));
  return pool.find((job) => (job.device || "cpu") === device) || null;
}

function renderCost() {
  const count = Number.parseInt($("fVar").value, 10) || 1;
  const device = targetDevice();
  const ref = referenceJob(device);
  const queueAhead = state.jobs.filter((job) => job.status === "running" || job.status === "queued").length;
  /* 运行中 dock 把这一格换成剩余时间，队列计数节点会被 paintDock 换掉。 */
  const queueEl = $("costQ");
  if (queueEl) queueEl.textContent = String(queueAhead);
  const list = $("costUl");
  if (!ref) {
    $("costT").textContent = "—";
    list.innerHTML = `<li><span>${esc(T("尚无本机实测数据"))}</span><b>${esc(T("跑完第一首后这里换成真实构成"))}</b></li>`;
    paintDock(consoleModel());
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
    (count > 1 ? `<li style="color:var(--text3)"><span>${esc(T("候选 {0} 个 · 队列逐个跑", count))}</span>` +
      `<b class="mono">${esc(fmtClock(estimate))}</b></li>` : "");
  paintDock(consoleModel());
}

/* ------------------------------------------------------------------ 生成台
   所有表面（顶部生成台 / 底栏 / 顶栏胶囊 / 队列卡摘要）都从 jobView() 派生，
   禁止各自算一套百分比。阶段事件只改文本与宽度，阶段轴只在阶段或任务变化时重建。 */
const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0));
const clampSpan = (value, low, high) => Math.min(high, Math.max(low, Number(value) || 0));
const fmtInt = (value) => Math.round(Number(value) || 0).toLocaleString(getLang() === "en" ? "en-US" : "zh-CN");
const secNow = () => Date.now() / 1000;
const phaseName = (phase) => (phase && PHASE_NAME[phase] ? T(PHASE_NAME[phase]) : "");

function phaseTimings(job) {
  const timing = job.result?.timing || {};
  return {
    plan: Number(timing.abc?.seconds) || null,
    semantic: Number(timing.semantic?.seconds) || null,
    nar: Number(timing.nar_seconds) || null,
    decode: Number(timing.vae_seconds) || null,
  };
}

function liveStage(job) {
  const local = state.stage && state.stage.job === job.id ? state.stage : null;
  const snap = job.stage_live || null;
  if (!local) return snap;
  if (!snap) return local;
  return Number(local.at || 0) >= Number(snap.at || 0) ? local : snap;
}

function phaseOfJob(job) {
  const live = liveStage(job);
  if (live?.phase && live.phase !== "other") return live.phase;
  return STAGE_PHASE[job.stage_raw] || ui.lastPhase.get(job.id) || null;
}

/* 只认运行/排队过的任务：刷新后不会把很久以前完成的任务重新弹出来。 */
function syncConsoleWatched() {
  for (const job of state.jobs) {
    if (job.status === "running" || job.status === "queued") ui.consoleWatched.add(job.id);
  }
  for (const id of ui.consoleWatched) {
    if (!state.byId.has(id)) ui.consoleWatched.delete(id);
  }
  for (const id of ui.cancelRequested) {
    const job = state.byId.get(id);
    if (!job || (job.status !== "running" && job.status !== "queued")) ui.cancelRequested.delete(id);
  }
  if (ui.lastPct.size > 200) {
    for (const id of ui.lastPct.keys()) if (!state.byId.has(id)) ui.lastPct.delete(id);
  }
}

function recordStage(event) {
  if (!event?.job) return;
  ui.consoleWatched.add(event.job);
  if (event.phase) ui.lastPhase.set(event.job, event.phase);
  if (event.started_at) ui.runStarted.set(event.job, Number(event.started_at));
  if (event.done) ui.stageDone.set(event.job, {...(ui.stageDone.get(event.job) || {}), ...event.done});
  syncConsoleWatched();
}

function pickConsoleJob() {
  const watched = [];
  for (const id of ui.consoleWatched) {
    const job = state.byId.get(id);
    if (job) watched.push(job);
  }
  const running = watched.filter((job) => job.status === "running")
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
  if (running) return running;
  const queued = watched.filter((job) => job.status === "queued")
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0))[0];
  if (queued) return queued;
  return watched.filter((job) => job.status === "complete" || job.status === "failed"
    || job.status === "cancelled")
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0] || null;
}

function doneMap(job) {
  const done = {...(job.stage_live?.done || {})};
  const local = ui.stageDone.get(job.id);
  if (local) Object.assign(done, local);
  if (job.status === "complete") {
    for (const [phase, seconds] of Object.entries(phaseTimings(job))) {
      if (seconds) done[phase] = seconds;
    }
  }
  return done;
}

/* 任务实际参与哪些阶段：跳过/复用阶段只显示状态，不参与整体权重与剩余时间。 */
function stagePlan(job, phase) {
  const marks = {};
  if (job.type === "plan") return {stages: ["plan"], run: ["plan"], marks};
  if (job.type === "redecode") {
    for (const item of ["plan", "semantic", "nar"]) marks[item] = "reuse";
    return {stages: AXIS, run: ["decode"], marks};
  }
  if (job.type === "rerender") {
    marks.plan = "score";
    return {stages: AXIS, run: ["semantic", "nar", "decode"], marks};
  }
  if (job.type === "staged") {
    marks.plan = "reuse";
    const from = job.from_stage || job.result?.timing?.staged_from
      || (phase === "semantic" ? "plan" : phase === "nar" || phase === "decode" ? "semantic" : "");
    if (from === "semantic") marks.semantic = "reuse";
    return {stages: AXIS, run: ["semantic", "nar", "decode"].filter((item) => !marks[item]), marks};
  }
  if ((job.cot || "full") === "off") {
    marks.plan = "skip";
    return {stages: AXIS, run: ["semantic", "nar", "decode"], marks};
  }
  return {stages: AXIS, run: AXIS.slice(), marks};
}

/* 参考任务只取同设备、完整歌曲、有分阶段实测耗时的记录；没有就不编造百分比。 */
function expectedTiming(job) {
  const device = job.device === "cpu" || job.device === "cuda" ? job.device : targetDevice();
  const ref = referenceJob(device);
  if (!ref) return null;
  const timing = ref.result.timing;
  const refUnits = ref.lyrics_units || lyricUnits(ref.requested?.lyrics) || 0;
  const units = job.lyrics_units || lyricUnits(job.requested?.lyrics) || refUnits;
  const ratio = refUnits > 0 && units > 0 ? clampSpan(units / refUnits, 0.4, 3) : 1;
  const defaultSteps = Number(state.schema?.ode_steps?.default) || 32;
  const steps = Number(job.ode_steps ?? job.requested?.ode_steps ?? defaultSteps);
  const refSteps = Number(ref.ode_steps ?? ref.requested?.ode_steps ?? defaultSteps);
  const stepRatio = steps > 0 && refSteps > 0 ? clampSpan(steps / refSteps, 0.3, 3) : 1;
  return {
    ref, ratio, stepRatio,
    plan: Number(timing.abc.seconds) * ratio,
    semantic: Number(timing.semantic.seconds) * ratio,
    nar: Number(timing.nar_seconds) * ratio * stepRatio,
    decode: Number(timing.vae_seconds) * ratio,
    tokens: {
      plan: (Number(timing.abc.output_tokens) || 0) * ratio,
      semantic: (Number(timing.semantic.output_tokens) || 0) * ratio,
    },
  };
}

function stageFraction(phase, live, expected, done) {
  if (done[phase] != null) return 1;
  if (!live) return 0;
  if (live.status === "completed") return 1;
  const total = Number(live.total) || 0;
  if (total > 0) return Math.min(0.98, Math.max(0, (Number(live.completed) || 0) / total));
  if ((phase === "plan" || phase === "semantic") && expected?.tokens?.[phase] > 0) {
    return Math.min(0.98, Math.max(0, (Number(live.completed) || 0) / expected.tokens[phase]));
  }
  const target = Number(expected?.[phase]) || 0;
  if (target > 0) return Math.min(0.98, Math.max(0, (Number(live.elapsed) || 0) / target));
  return 0;
}

/* 排队估算：前面每个任务还剩多少秒；缺同设备基准时返回 null，不显示假时间。 */
function estimateLeft(job) {
  const expected = expectedTiming(job);
  if (!expected) return null;
  const plan = stagePlan(job, phaseOfJob(job));
  const total = plan.run.reduce((sum, phase) => sum + expected[phase], 0);
  if (job.status !== "running") return total;
  const live = liveStage(job);
  const startedAt = Number(live?.started_at || job.stage_live?.started_at
    || ui.runStarted.get(job.id) || 0);
  if (!startedAt) return total;
  const used = Math.max(0, secNow() - startedAt - (Number(doneMap(job).load) || 0));
  return Math.max(0, total - used);
}

function jobView(job) {
  const live = liveStage(job);
  const phase = phaseOfJob(job);
  const plan = stagePlan(job, phase);
  const done = doneMap(job);
  const expected = expectedTiming(job);
  const startedAt = Number(live?.started_at || job.stage_live?.started_at
    || ui.runStarted.get(job.id) || 0) || null;
  const now = secNow();

  let used = 0;
  if (job.status === "complete") used = Number(job.seconds || job.result?.timing?.e2e_seconds || 0);
  else if (job.status === "queued") used = 0;
  else if (startedAt) used = Math.max(0, (job.status === "running" ? now : Number(job.updated_at || now)) - startedAt);
  else used = Object.values(done).reduce((sum, value) => sum + (Number(value) || 0), 0);

  const totalRun = expected ? plan.run.reduce((sum, item) => sum + expected[item], 0) : null;
  const loadDone = Number(done.load) || 0;
  const total = totalRun !== null ? totalRun + loadDone : null;
  const inRun = !!(phase && plan.run.includes(phase));
  const frac = phase && inRun ? (job.status === "complete" ? 1 : stageFraction(phase, live, expected, done)) : 0;

  /* 没有进入可计量的阶段（模型加载、复用阶段、阶段事件未到）就不编百分比，
     进度条走不确定动画；否则会先闪一下 0% 再跳。 */
  let pct = null;
  if (job.status === "complete") pct = 1;
  else if (job.status !== "queued" && inRun && expected && totalRun > 0) {
    const index = plan.run.indexOf(phase);
    let acc = 0;
    plan.run.forEach((item, order) => {
      if (order < index) acc += expected[item];
      else if (order === index) acc += expected[item] * frac;
    });
    pct = clamp01(acc / totalRun);
    if (job.status === "running") pct = Math.min(pct, 0.99);
  }
  if (pct !== null && job.status !== "queued") {
    const prev = ui.lastPct.get(job.id);
    if (prev !== undefined && pct < prev) pct = prev;
    if (job.status === "running") pct = Math.min(pct, 0.99);
    ui.lastPct.set(job.id, pct);
  }

  let remaining = null;
  if (job.status === "running" && expected) {
    if (phase === "load") remaining = null;
    else if (inRun) {
      const index = plan.run.indexOf(phase);
      remaining = expected[phase] * (1 - frac);
      for (let i = index + 1; i < plan.run.length; i += 1) remaining += expected[plan.run[i]];
      remaining = Math.max(0, remaining);
    } else remaining = totalRun;
  }

  let aheadCount = 0;
  let startIn = null;
  if (job.status === "queued") {
    const ahead = state.jobs.filter((item) => item.id !== job.id
      && (item.status === "running" || item.status === "queued")
      && (item.created_at || 0) < (job.created_at || 0));
    aheadCount = ahead.length;
    let sum = 0;
    let known = true;
    for (const item of ahead) {
      const left = estimateLeft(item);
      if (left === null) { known = false; break; }
      sum += left;
    }
    startIn = known ? sum : null;
  }

  return {
    job, live, phase, plan, done, expected, used, total, totalRun, pct, frac,
    remaining, aheadCount, startIn, position: aheadCount + 1,
    runIndex: inRun ? plan.run.indexOf(phase) + 1 : 0,
    stageCount: plan.run.length,
    overrun: job.status === "running" && total !== null && used > total * 1.5,
    audio: hasAudio(job), score: !!job.artifacts?.["score.abc"],
  };
}

function consoleModel() {
  const job = pickConsoleJob();
  return job ? jobView(job) : null;
}

function etaLabel(view) {
  if (view.remaining === null || view.remaining === undefined) return "—";
  if (view.remaining < 10) return T("即将完成");
  return fmtClock(view.remaining);
}

/* 排队任务的"开始时间"：0 秒要读成马上开始，不能显示 0:00 让人以为卡住。 */
function startLabel(view) {
  if (view.startIn === null || view.startIn === undefined) return null;
  return view.startIn < 10 ? T("马上开始") : T("约 {0} 后开始", fmtClock(view.startIn));
}

function refreshLiveSurfaces({full = false} = {}) {
  const view = consoleModel();
  paintConsole(view, {full});
  paintDock(view);
  paintTopbarStatus(view);
  paintQueueSummary();
  if (view?.job.status === "running") ensureClock();
}

/* 秒表只为运行中的任务走：结束就停，不用一个常驻定时器空转 */
function ensureClock() {
  if (ui.clockTimer) return;
  ui.clockTimer = setInterval(() => {
    const view = consoleModel();
    if (!view || view.job.status !== "running") {
      clearInterval(ui.clockTimer);
      ui.clockTimer = null;
      return;
    }
    paintConsole(view);
    paintDock(view);
    paintTopbarStatus(view);
    paintQueueSummary();
  }, 1000);
}

function stateBadge(view) {
  const job = view.job;
  const item = job.status === "queued" ? ["pause", "排队中"]
    : job.status === "running" && view.phase === "load" ? ["cpu", "准备模型"]
    : job.status === "running" ? ["clock", "正在生成"]
    : job.status === "complete" && job.truncated ? ["warn", "已完成 · 有截断"]
    : job.status === "complete" ? ["check", "已完成"]
    : job.status === "cancelled" ? ["x", "已取消"]
    : ["warn", "生成失败"];
  return `${icon(item[0])}${esc(T(item[1]))}`;
}

function miniText(view) {
  const parts = [];
  if (view.job.status === "queued") parts.push(T("排队中 · 第 {0} 位", view.position));
  else {
    parts.push(T(view.job.status === "complete" ? "已完成" : view.job.status === "cancelled" ? "已取消"
      : view.job.status === "failed" ? "生成失败" : view.phase === "load" ? "准备模型" : "正在生成"));
    if (view.phase && view.phase !== "load") parts.push(phaseName(view.phase));
    if (view.pct !== null) {
      if (view.job.status === "running" && view.pct >= 0.99) parts.push(T("收尾中…马上好"));
      else parts.push(`${Math.round(view.pct * 100)}%`);
    }
    if (view.job.status === "running") {
      const eta = etaLabel(view);
      if (eta !== "—") parts.push(T("剩余约 {0}", eta));
    }
    if (!state.connected) parts.push(T("连接中断，{0} 秒后自动刷新", pollCountdown));
  }
  return parts.filter(Boolean).join(" · ");
}

function consoleActions(view) {
  const job = view.job;
  const actions = [];
  if (job.status === "running" || job.status === "queued") {
    const waiting = ui.cancelRequested.has(job.id);
    actions.push(`<button class="btn sm" data-act="cancel" type="button"${waiting ? " disabled" : ""}>` +
      `${esc(waiting ? T("取消中…") : T("取消"))}</button>`);
  } else if (job.status === "complete") {
    if (view.audio) {
      actions.push(`<button class="btn sm" data-act="play" type="button">${esc(T("试听"))}</button>`);
      actions.push(`<a class="btn sm ghost" data-dl href="${esc(audioUrl(job.id))}" download="${esc(dlName(job))}">${esc(T("下载"))}</a>`);
    }
    if (view.score) actions.push(`<button class="btn sm ghost" data-act="score" type="button">${esc(T("看乐谱"))}</button>`);
    if (job.type === "plan" && !view.audio && !job.truncated) {
      actions.push(`<button class="btn sm ghost" data-act="render" type="button">${esc(T("渲染成歌"))}</button>`);
    }
    actions.push(`<button class="btn sm ghost" data-act="again" type="button">${esc(T("再来一首"))}</button>`);
  } else {
    if (view.audio) {
      actions.push(`<button class="btn sm" data-act="play" type="button">${esc(T("试听"))}</button>`);
      actions.push(`<a class="btn sm ghost" data-dl href="${esc(audioUrl(job.id))}" download="${esc(dlName(job))}">${esc(T("下载"))}</a>`);
    }
    if (view.score) actions.push(`<button class="btn sm ghost" data-act="score" type="button">${esc(T("看乐谱"))}</button>`);
    actions.push(`<button class="btn sm" data-act="reuse" type="button">${esc(T("改参数重试"))}</button>`);
    /* P0-4 失败卡下一步：上、下、CPU 三个常用出口 */
    actions.push(`<button class="btn sm ghost" data-act="fix-candidates" type="button">${esc(T("改候选数"))}</button>`);
    actions.push(`<button class="btn sm ghost" data-act="fix-lyrics" type="button">${esc(T("缩短歌词"))}</button>`);
    actions.push(`<button class="btn sm ghost" data-act="fix-cpu" type="button">${esc(T("切 CPU 重试"))}</button>`);
    actions.push(`<button class="btn sm ghost" data-act="log" type="button">${esc(T("看日志"))}</button>`);
  }
  actions.push(`<button class="btn sm ghost" data-act="detail" type="button">${esc(T("详情"))}</button>`);
  return actions.join("");
}

function axisState(view, phase) {
  const mark = view.plan.marks[phase];
  if (mark === "skip") return "skip";
  if (mark) return "reuse";
  if (view.job.status === "complete") return "done";
  if (view.phase === phase) {
    if (view.job.status === "failed") return "fail";
    if (view.job.status === "cancelled") return "stop";
    return "act";
  }
  const order = view.plan.run;
  const current = view.phase ? order.indexOf(view.phase) : -1;
  const index = order.indexOf(phase);
  if (view.done[phase] != null) return "done";
  if (current >= 0 && index >= 0 && index < current) return "done";
  return "pending";
}

function liveMeta(view, phase) {
  const live = view.live;
  if (!live) return "";
  const completed = Number(live.completed) || 0;
  if (phase === "plan" || phase === "semantic") {
    if (!completed) return "";
    const rate = Number(live.rate) || 0;
    return rate > 0
      ? T("已生成 {0} 词元 · {1}/秒", fmtInt(completed), rate.toFixed(1))
      : T("已生成 {0} 词元", fmtInt(completed));
  }
  if (Number(live.total) > 0) {
    return phase === "nar"
      ? T("第 {0}/{1} 步", completed, live.total)
      : T("第 {0}/{1} 块", completed, live.total);
  }
  const elapsed = Number(live.elapsed) || 0;
  return elapsed ? fmtStamp(elapsed) : "";
}

function axisMeta(view, phase, state) {
  const mark = view.plan.marks[phase];
  if (mark === "skip") return T("跳过（不规划）");
  if (mark === "score") return T("采用导入乐谱");
  if (mark) return T("复用中间产物");
  if (state === "done") {
    const seconds = Number(view.done[phase]);
    if (seconds > 0) return fmtStamp(seconds);
    return view.expected ? `≈ ${fmtStamp(view.expected[phase])}` : "—";
  }
  if (state === "fail") return liveMeta(view, phase) || T("停在这里");
  if (state === "stop") return liveMeta(view, phase) || T("已停止");
  if (state === "act") return liveMeta(view, phase) || T("进行中");
  return T("等待中");
}

function axisHtml(view) {
  return view.plan.stages.map((phase) => {
    const state = axisState(view, phase);
    const glyph = state === "done" ? icon("check") : state === "fail" || state === "stop" ? icon("x") : "";
    const current = state === "act" ? ' aria-current="step"' : "";
    return `<li class="${state}" data-phase="${phase}"${current}>` +
      `<span class="node">${glyph}</span>` +
      `<span class="nm">${esc(T(PHASE_NAME[phase]))}</span>` +
      `<span class="mt">${esc(axisMeta(view, phase, state))}</span></li>`;
  }).join("");
}

function nowText(view) {
  const job = view.job;
  if (job.status === "queued") {
    const base = view.aheadCount
      ? T("第 {0} 位 · 前面还有 {1} 个任务", view.position, view.aheadCount)
      : T("第 {0} 位 · 前面没有任务", view.position);
    const start = startLabel(view);
    return start ? `${base} · ${start}` : base;
  }
  if (job.status === "running" && view.phase === "load") {
    return T("首次加载模型约 1 分钟；之后生成会直接开始。");
  }
  if (job.status === "running") return T(PHASE_ACT[view.phase] || "正在生成");
  if (job.status === "complete") {
    if (job.type === "plan" && !view.audio) return T("只出了乐谱 · 去乐谱工作台检查，满意再渲染成歌");
    const actual = Number(job.seconds || 0);
    if (view.expected && actual > 0) {
      const predicted = view.totalRun + (Number(view.done.load) || 0);
      const diff = predicted - actual;
      if (Math.abs(diff) >= 3) {
        return diff >= 0
          ? T("实际用时 {0}，比预计快 {1}", fmtStamp(actual), fmtStamp(Math.abs(diff)))
          : T("实际用时 {0}，比预计慢 {1}", fmtStamp(actual), fmtStamp(Math.abs(diff)));
      }
    }
    return T("实际用时 {0}", fmtStamp(actual));
  }
  if (job.status === "failed") {
    return view.phase
      ? T("停在 {0} · 已用 {1}", phaseName(view.phase), fmtStamp(view.used))
      : T("已用 {0}", fmtStamp(view.used));
  }
  return T("已取消 · 已用 {0}", fmtStamp(view.used));
}

/* 当前行右侧的技术量：阶段序号；无基准时补上已用和词元/步数（§5.4）。
   有基准时阶段轴已经显示同样的实时量，这里不再重复。 */
function nowMeta(view) {
  const job = view.job;
  if (job.status === "running" && view.runIndex) {
    if (view.expected) return T("第 {0}/{1} 阶段", view.runIndex, view.stageCount);
    const meta = liveMeta(view, view.phase);
    return meta
      ? T("第 {0}/{1} 阶段 · 已用 {2} · {3}", view.runIndex, view.stageCount, fmtClock(view.used), meta)
      : T("第 {0}/{1} 阶段 · 已用 {2}", view.runIndex, view.stageCount, fmtClock(view.used));
  }
  if (job.status === "complete" && view.audio) {
    return T("音频 {0} 秒 · FLAC 48 kHz 立体声", Number(job.duration || 0).toFixed(1));
  }
  return "";
}

function nowHtml(view) {
  const main = view.job.status === "running" && view.phase !== "load"
    ? `<span class="k">${esc(T("当前"))}</span>` +
      `<span class="tx">${esc(T(PHASE_ACT[view.phase] || "正在生成"))}</span>`
    : `<span class="tx">${esc(nowText(view))}</span>`;
  const meta = nowMeta(view);
  return main + (meta ? `<span class="mt">${esc(meta)}</span>` : "");
}

function noteText(view) {
  const job = view.job;
  if (job.status === "failed") {
    const human = humanError(job.error) || T(job.error || "任务在写出产物前被终止");
    const tip = failTip(job.error);
    return [human, tip].filter(Boolean).join(" · ");
  }
  if (job.status === "cancelled") return humanError(job.error) || T("任务已取消，产物目录保留");
  if (job.status === "complete" && job.truncated) {
    return T("语义序列达到长度上限，歌曲可能提前结束；可改短歌词后重试");
  }
  if (job.status === "complete") return "";
  if (job.status === "running" && ui.cancelRequested.has(job.id)) {
    return T("取消将在当前阶段（{0}）结束后生效；已用时间不退。", phaseName(view.phase) || T("当前阶段"));
  }
  if (view.overrun && view.phase !== "load") return T("已超过预计时间，仍在生成");
  if (!view.expected && (job.status === "running" || job.status === "queued")) {
    return T("跑完这一首后会记录本机基准，下次显示整体百分比和剩余时间");
  }
  if (job.status === "running" && view.phase === "semantic") {
    return T("最慢的一段（约占总时长 60%）：自回归在 CPU 上逐词元生成音频序列。");
  }
  if (job.status === "queued") return T("开始后会显示逐阶段进度、已用时间和剩余时间。");
  if (job.status === "running" && view.expected?.ref) {
    return T("按上一首同设备任务的实测节奏估算") + " · " + view.expected.ref.id;
  }
  return "";
}

function progressText(view) {
  if (view.pct === null) {
    if (view.job.status === "queued") return T("排队中");
    if (view.phase === "load") return T("准备模型，进度未知");
    return T("{0}，进度未知", phaseName(view.phase) || T("生成中"));
  }
  if (view.job.status === "complete") return T("已完成");
  const name = phaseName(view.phase) || T("生成中");
  const eta = etaLabel(view);
  return eta === "—"
    ? T("{0}，约 {1}%", name, Math.round(view.pct * 100))
    : T("{0}，约 {1}%，剩余 {2}", name, Math.round(view.pct * 100), eta);
}

function announce(view) {
  const key = `${view.job.id}|${view.job.status}|${view.phase || ""}`;
  if (key !== ui.liveKey) {
    ui.liveKey = key;
    $("gcLive").textContent = view.job.status === "queued" ? T("已排队 · 第 {0} 位", view.position)
      : view.job.status === "running" && view.phase === "load" ? T("正在加载模型")
      : view.job.status === "running" ? T("进入{0}阶段", phaseName(view.phase) || T("生成"))
      : view.job.status === "complete" ? T("生成已完成")
      : view.job.status === "cancelled" ? T("任务已取消")
      : "";
  }
  const alertKey = view.job.status === "failed" ? view.job.id : "";
  if (alertKey !== ui.alertKey) {
    ui.alertKey = alertKey;
    $("gcAlert").textContent = alertKey
      ? T("生成失败：{0}", humanError(view.job.error) || view.job.error || T("任务在写出产物前被终止"))
      : "";
  }
}

function numLeft(view) {
  if (view.job.status === "complete") {
    return {label: T("音频"), value: view.audio ? fmtClock(Number(view.job.duration || 0)) : "—"};
  }
  if (view.job.status === "queued") {
    return {label: T("开始"), value: view.startIn === null ? "—"
      : view.startIn < 10 ? T("马上") : fmtClock(view.startIn)};
  }
  if (view.job.status === "running" && view.phase === "load") {
    return {label: T("准备"), value: T("约 1 分钟")};
  }
  if (view.job.status === "running") return {label: T("剩余"), value: etaLabel(view)};
  return {label: T("停在"), value: phaseName(view.phase) || "—"};
}

function paintConsole(view, {full = false} = {}) {
  const section = $("genconsole");
  if (!section) return;
  if (!view) {
    section.hidden = true;
    section.classList.remove("folded");
    ui.axisKey = "";
    ui.actionsKey = "";
    ui.headKey = "";
    ui.liveKey = "";
    ui.alertKey = "";
    $("gcLive").textContent = "";
    $("gcAlert").textContent = "";
    return;
  }
  const job = view.job;
  section.hidden = false;
  const stateClass = job.status === "complete" ? (job.truncated ? "gc-warn" : "gc-done")
    : job.status === "failed" || job.status === "cancelled" ? "gc-fail"
    : job.status === "queued" ? "gc-queue"
    : view.phase === "load" ? "gc-load" : "gc-running";
  for (const name of ["gc-done", "gc-warn", "gc-fail", "gc-queue", "gc-load", "gc-running"]) {
    section.classList.toggle(name, name === stateClass);
  }
  const folded = ui.foldedJob === job.id;
  section.classList.toggle("folded", folded);

  const headKey = [getLang(), job.id, job.status, view.phase, job.truncated ? 1 : 0,
    job.work_name, job.version_tag, job.version_label].join("|");
  if (full || headKey !== ui.headKey) {
    ui.headKey = headKey;
    $("gcState").innerHTML = stateBadge(view);
    $("gcTitle").textContent = displayName(job);
    $("gcId").textContent = job.id;
  }
  $("gcMini").textContent = miniText(view);
  $("gcFold").textContent = T(folded ? "展开" : "收起");
  $("gcFold").setAttribute("aria-expanded", String(!folded));

  const actionsKey = [getLang(), job.id, job.status, job.type, view.audio ? 1 : 0,
    view.score ? 1 : 0, job.truncated ? 1 : 0, ui.cancelRequested.has(job.id) ? 1 : 0].join("|");
  if (full || actionsKey !== ui.actionsKey) {
    ui.actionsKey = actionsKey;
    $("gcActs").innerHTML = consoleActions(view);
  }

  $("gcPct").textContent = view.pct === null ? "—" : String(Math.round(view.pct * 100));
  $("gcPctWrap").classList.toggle("unknown", view.pct === null);
  const left = numLeft(view);
  $("gcLeftLbl").textContent = left.label;
  $("gcLeft").textContent = left.value;
  $("gcUsed").textContent = view.used > 0.5 ? fmtClock(view.used) : "—";
  $("gcTotal").textContent = view.total ? fmtClock(view.total) : "—";

  const bar = $("gcBar");
  const indeterminate = job.status === "running" && (view.phase === "load" || view.pct === null);
  bar.classList.toggle("indeterminate", indeterminate);
  $("gcFill").style.width = view.pct === null ? "" : `${view.pct * 100}%`;
  if (view.pct === null) bar.removeAttribute("aria-valuenow");
  else bar.setAttribute("aria-valuenow", String(Math.round(view.pct * 100)));
  bar.setAttribute("aria-valuetext", progressText(view));

  const axisKey = [getLang(), job.id, job.status, view.phase, JSON.stringify(view.plan.marks),
    Object.keys(view.done).sort().join(",")].join("|");
  if (full || axisKey !== ui.axisKey) {
    ui.axisKey = axisKey;
    $("gcAxis").style.setProperty("--gc-cols", String(view.plan.stages.length));
    $("gcAxis").innerHTML = axisHtml(view);
  } else if (view.phase) {
    const active = $("gcAxis").querySelector(`[data-phase="${view.phase}"] .mt`);
    if (active) active.textContent = axisMeta(view, view.phase, axisState(view, view.phase));
  }

  $("gcNow").innerHTML = nowHtml(view);
  const note = noteText(view);
  $("gcNote").hidden = !note;
  $("gcNote").textContent = note || "";
  announce(view);
}

function paintDock(view) {
  const bar = $("dockbar");
  const fill = $("dockbarFill");
  const label = $("costLbl");
  const wrap = $("costQWrap");
  if (!bar || !fill || !label || !wrap) return;
  const queueAhead = state.jobs.filter((job) => job.status === "running" || job.status === "queued").length;
  const active = view && ui.view === "studio"
    && (view.job.status === "running" || view.job.status === "queued");
  if (!active) {
    bar.hidden = true;
    fill.style.width = "0%";
    label.textContent = T("预计耗时");
    wrap.innerHTML = `· ${esc(T("队列前"))} <b id="costQ" class="mono">${queueAhead}</b> ${esc(T("个任务"))}`;
    return;
  }
  if (view.job.status === "queued") {
    bar.hidden = true;
    label.textContent = T("排队中");
    $("costT").textContent = T("第 {0} 位", view.position);
    const start = startLabel(view);
    wrap.textContent = (view.aheadCount ? T("前面还有 {0} 个任务", view.aheadCount) : T("队列空闲"))
      + (start ? ` · ${start}` : "");
    return;
  }
  bar.hidden = false;
  if (view.phase === "load") {
    label.textContent = T("准备模型");
    $("costT").textContent = fmtClock(view.used);
    wrap.textContent = T("首次加载模型约 1 分钟");
    fill.style.width = "30%";
    return;
  }
  label.textContent = T("正在生成");
  $("costT").textContent = T("已用 {0}", fmtClock(view.used));
  const eta = etaLabel(view);
  wrap.textContent = eta === "—" ? T("进度未知") : T("剩余约 {0}", eta);
  fill.style.width = view.pct === null ? "30%" : `${view.pct * 100}%`;
}

function paintTopbarStatus(view) {
  const box = $("mstat");
  const text = $("mstatText");
  if (!box || !text) return;
  const active = view && (view.job.status === "running" || view.job.status === "queued");
  const show = !!(active && ui.view !== "studio");
  box.classList.toggle("link", show);
  if (!show) {
    box.removeAttribute("role");
    box.removeAttribute("tabindex");
    text.textContent = modelText();
    box.title = modelTitle();
    return;
  }
  box.setAttribute("role", "link");
  box.tabIndex = 0;
  if (view.job.status === "queued") {
    text.textContent = T("排队中 · 第 {0} 位", view.position);
  } else if (view.phase === "load") {
    text.textContent = T("生成中 · 准备模型");
  } else if (view.pct !== null) {
    text.textContent = T("生成 {0}% · {1}", Math.round(view.pct * 100), etaLabel(view));
  } else {
    text.textContent = T("生成中 · 第 {0}/{1} 阶段", Math.max(1, view.runIndex), view.stageCount);
  }
  box.title = `${modelText()} · ${T("点击回到生成进度")}`;
}

function focusConsole() {
  if (ui.foldedJob) ui.foldedJob = null;
  go("studio");
  const section = $("genconsole");
  if (section && !section.hidden) section.scrollIntoView({block: "nearest", behavior: "smooth"});
}

/* 队列卡：运行中只留一行摘要，不重复画第二份进度。 */
function queueSummary(job) {
  const view = jobView(job);
  if (view.phase === "load") return T("生成中 · 准备模型 → 查看生成台");
  if (view.pct !== null) {
    return T("生成中 · {0} {1}% · 剩 {2} → 查看生成台",
      phaseName(view.phase) || T("生成中"), Math.round(view.pct * 100), etaLabel(view));
  }
  return T("生成中 · {0} → 查看生成台", phaseName(view.phase) || T("进行中"));
}

function paintQueueSummary() {
  const host = $("queue");
  if (!host) return;
  for (const job of state.jobs) {
    if (job.status !== "running") continue;
    const slot = host.querySelector(`[data-job="${CSS.escape(job.id)}"] [data-gc-summary]`);
    if (slot) slot.textContent = queueSummary(job);
  }
}

/* ------------------------------------------------------------------ 生成 */
/* 报错必须指向那个输入框：它可能在半屏之外，只弹一句 toast 等于没说 */
function need(field, message) {
  field.scrollIntoView({block: "center", behavior: "smooth"});
  field.focus({preventScroll: true});
  field.classList.add("need-flash");
  setTimeout(() => field.classList.remove("need-flash"), 1800);
  toast(T(message), "bad");
}

let songSubmitting = false;

/* 候选批次的分组 id：只要求非空字符串，优先用浏览器自带 UUID */
const newWorkGroup = () => (globalThis.crypto?.randomUUID?.()
  || `wg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

/* 风格会原样下发给模型：只挑「模型多半处理不了」的写法提醒，不阻止提交。 */
function styleWarnings(style) {
  const warnings = [];
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(style))
    warnings.push(T("风格里有不可见的控制字符，模型可能读成乱码，建议删掉"));
  if (/[\u{1f000}-\u{1faff}\u{2600}-\u{27bf}\u{fe0f}\u{200d}]/u.test(style))
    warnings.push(T("风格里有 emoji 或图案符号：模型只会当普通文字，可能干扰风格判断"));
  if (/【[^】]*】|［[^］]*］/.test(style))
    warnings.push(T("风格里用了全角括号：它不是模型的段落标记，只会当普通文字"));
  const bpm = /(\d{2,3})\s*BPM/i.exec(style);
  if (bpm && (Number(bpm[1]) < 40 || Number(bpm[1]) > 220))
    warnings.push(T("BPM {0} 超出常见 40–220：节奏可能不稳，确认这是想要的", bpm[1]));
  return warnings;
}

/* 「生成歌曲」与「只出谱」共用：校验必填 → 结构检查 → 装配请求体。
   返回 null 表示已用 need() 指到出问题的输入框，调用方直接收尾。 */
async function composeSong(type) {
  const style = styleFromControls();
  const lyrics = $("fLyrics").value.trim();
  if (!style) { need($("fStyle"), "风格描述为空 —— 至少要写语言或流派"); return null; }
  if (/\[\s*(?:tags|lyrics)\s*\]/i.test(style)) {
    need($("fStyle"), "风格里不能出现 [Tags] / [Lyrics]：它们是提示词分区，会把歌词区提前截断");
    return null;
  }
  if (!lyrics) { need($("fLyrics"), "歌词为空"); return null; }
  const check = await lintLyrics();
  if (check?.blockers?.length) {
    need($("fLyrics"), check.blockers[0]);
    return null;
  }
  const styleNotes = styleWarnings(style);
  /* 提醒要完整递到眼前：整篇提醒（缺段落/缺副歌）+ 逐行提醒（含过短/过长）+ 风格提醒，
     否则用户带着没确认的问题直接开跑整曲。 */
  const lyricNotes = [
    ...(check?.warnings || []).map((text) => esc(T(text))),
    ...(check?.lines || []).map(lintLineText),
  ];
  if (lyricNotes.length || styleNotes.length) {
    const items = [...lyricNotes, ...styleNotes.map((text) => esc(text))];
    const ok = await confirmDialog({
      title: T("歌词或风格有提醒"),
      body: `<ul style="margin:0 0 var(--sp3) var(--sp4);font-size:13px;line-height:1.7">${
        items.slice(0, 8).map((text) => `<li>${text}</li>`).join("")}</ul>` +
        T("模型会照原样处理，但这些内容可能唱不出来、被忽略或占用上下文。"),
      note: T("确认后会照原样提交；返回修改可以先删掉这些内容。"),
      ok: T("仍然生成"),
      cancel: T("返回修改"),
    });
    if (!ok) {
      (lyricNotes.length ? $("fLyrics") : $("fStyle")).focus();
      return null;
    }
  }
  const payload = {
    type, style, lyrics, cot: ui.cot,
    device: submitDevice(),
    title: "",
  };
  /* 勾了「用这份谱面生成」才按谱重渲染；没勾就照常生成新歌，下拉只决定当前看哪份谱。 */
  if (type === "song" && ui.useScore && ui.scoreJob && ui.scoreAbc.trim()) {
    payload.type = "rerender";
    payload.source = ui.scoreJob;
    payload.abc = ui.scoreAbc;
  }
  if (ui.cfg !== null) payload.cfg_scale = ui.cfg;
  if (ui.ode !== null) payload.ode_steps = ui.ode;
  const abc = buildSampling("abc");
  if (abc) payload.abc_sampling = abc;
  return {payload, lyrics};
}

/* 种子输入：留空 = 随机；显式种子按候选序号 +1，上限要扣掉候选数。 */
function parseSeedInput(count) {
  const raw = $("fSeed").value.trim();
  if (raw === "") return {seed: null};
  if (!/^\d+$/.test(raw)) return {error: T("种子要是不带小数的整数，或留空表示随机")};
  const seed = Number(raw);
  const maxSeed = Number.MAX_SAFE_INTEGER - Math.max(0, count - 1);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > maxSeed) {
    return {error: T("种子超出范围：0 到 {0}（候选会依次 +1）", maxSeed)};
  }
  return {seed};
}

async function generate() {
  if (songSubmitting) return [];
  songSubmitting = true;
  $("btnGen").disabled = true;
  const made = [];
  try {
    const composed = await composeSong("song");
    if (!composed) return made;
    const {payload} = composed;
    const count = Number.parseInt($("fVar").value, 10) || 1;
    const parsed = parseSeedInput(count);
    if (parsed.error) {
      toast(parsed.error, "bad");
      return made;
    }
    const seed = parsed.seed;
    if (seed !== null) payload.seed = seed;
    const semantic = buildSampling("semantic");
    if (semantic) payload.semantic_sampling = semantic;
    const songName = $("fSongName").value.trim();
    if (songName) payload.work_name = songName;
    /* 同一次提交的候选共享一个分组 id，后端据此归进同一作品；
       多候选的标题/标签由后端统一编号（候选 A/B/C…），前端不再拼字符串。 */
    const workGroup = count > 1 ? newWorkGroup() : null;
    for (let index = 0; index < count; index += 1) {
      const item = {...payload};
      if (workGroup) {
        item.work_group = workGroup;
        // 同一份种子会让候选完全相同：显式种子按序号 +1，留空则各自随机。
        if (seed !== null) item.seed = seed + index;
      }
      made.push(await createJob(item));
    }
    const loaded = state.model.state === "loaded";
    clearDraft();
    toast(T("已排队 {0} 个任务{1}", made.length, loaded ? "" : T(" · 生成前会先加载模型")), "ok");
    setGuideOff();
    go("studio", {jobId: made[0]?.id || null});
  } catch (exc) {
    console.error("[generate] 提交失败，已排队", made.map((job) => job.id), exc);
    toast(message(exc), "bad");
  } finally {
    songSubmitting = false;
    if (made.length) {
      /* 成功排队才冷却 1.5s 挡手抖连点；校验没过（什么都没排）就立刻恢复，
         否则用户改完词的下一击会被无声吞掉。 */
      setTimeout(() => { $("btnGen").disabled = false; renderCost(); }, 1500);
    } else {
      $("btnGen").disabled = false;
      renderCost();
    }
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
    const count = Number.parseInt($("fVar").value, 10) || 1;
    if (count > 1) {
      const ok = await confirmDialog({
        title: T("只出谱只会出 1 份"),
        body: esc(T("当前候选数量是 {0}，但「只出谱」一次只排 1 个任务；要一次出多首请用「生成歌曲」。", count)),
        ok: T("继续只出谱"), cancel: T("返回修改"),
      });
      if (!ok) return;
    }
    const parsed = parseSeedInput(1);
    if (parsed.error) {
      toast(parsed.error, "bad");
      return;
    }
    if (parsed.seed !== null) composed.payload.seed = parsed.seed;
    const songName = $("fSongName").value.trim();
    if (songName) composed.payload.work_name = songName;
    await createJob(composed.payload);
    clearDraft();
    toast(T("已排队 · 先出乐谱，完成后点卡上的「渲染成歌」"), "ok");
    setGuideOff();
    go("studio");
  } catch (exc) {
    console.error("[generatePlan] 提交失败", exc);
    toast(message(exc), "bad");
  } finally {
    planSubmitting = false;
    /* 与「生成歌曲」同款冷却：提交几十毫秒就完成，立即恢复会被连点再次触发。 */
    setTimeout(() => { $("btnPlan").disabled = false; renderCost(); }, 1500);
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

const hasAudio = (job) => !!job?.artifacts?.["audio.flac"];

/* 下载文件名给歌名，编号兜底：只靠编号的话，下载下来分不清是哪首 */
function dlName(job) {
  const base = String(displayName(job) || job?.lyrics_head || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 48);
  return `${base || "yue2"} - ${job?.id || Date.now()}.flac`;
}

const hasLyrics = (job) => Number(job?.lyrics_len || 0) > 0
  || !!String(job?.requested?.lyrics || "").trim();

/* 入口常显：不能导出时直接把原因写在展开面板里，比整块藏掉更好找 */
function subtitleReason(job) {
  if (!job) return "先播放一首歌再导出字幕";
  if (job.status !== "complete") return "任务未完成，暂无字幕可导出";
  if (!hasAudio(job)) return "没有音频产物，无法生成字幕";
  if (!hasLyrics(job)) return "没有歌词，无法生成字幕";
  return "";
}

function subtitleUrl(jobId, fmt, enhanced) {
  const query = new URLSearchParams({format: fmt});
  if (enhanced) query.set("enhanced", "1");
  return `/api/jobs/${encodeURIComponent(jobId)}/lyrics/subtitle?${query}`;
}

function subtitleButtons(className) {
  return [["srt", "SRT 字幕", false], ["lrc", "LRC（行级）", false], ["lrc", "LRC（逐字）", true]]
    .map(([fmt, label, word]) =>
      `<button class="${className}" type="button" data-sub="${fmt}"${word ? ' data-word="1"' : ""}>${esc(T(label))}</button>`)
    .join("");
}

/* 对齐失败会在原因前加固定前缀，拆开来才能让英文界面也翻到前半句 */
function subtitleErrorText(exc) {
  const detail = String(exc?.message || "").trim();
  const failed = /^歌词对齐失败：([\s\S]+)$/.exec(detail);
  if (failed) return T("歌词对齐失败：{0}", failed[1]);
  return detail ? T(detail) : message(exc);
}

/* 字幕是后端按 lyrics.json 现算的文本，下载失败（409 等）要把原因原样说出来。
   返回 true/false 给卡片菜单判断要不要收起——失败时留着菜单方便直接重试。 */
async function downloadSubtitle(fmt, jobId, enhanced = false, button = null) {
  if (!jobId) {
    toast(T("先播放一首歌再导出字幕"), "info");
    return false;
  }
  const job = state.byId.get(jobId) || {id: jobId};
  if (button) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  }
  try {
    const blob = await downloadFile(subtitleUrl(jobId, fmt, enhanced));
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement("a"), {
      href: url, download: subtitleName(job, fmt, enhanced),
    });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(T("已开始下载：{0}", link.download), "info", 3200);
    return true;
  } catch (exc) {
    toast(subtitleErrorText(exc), "bad");
    return false;
  } finally {
    if (button) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
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
    actions.push(`<button class="btn sm ghost" data-act="again" type="button">${esc(T("复用参数"))}</button>`);
    if (job.type === "plan" && !hasAudio(job)) {
      actions.push(job.truncated
        ? `<button class="btn sm" type="button" disabled title="${esc(T("谱面被截断，不能直接渲染"))}">${esc(T("渲染成歌"))}</button>`
        : `<button class="btn sm" data-act="render" type="button">${esc(T("渲染成歌"))}</button>`);
    }
  } else {
    if (hasAudio(job)) {
      actions.push(`<button class="btn sm" data-act="play" type="button">${esc(T("试听"))}</button>`);
      actions.push(`<a class="btn sm ghost" data-dl href="${esc(audioUrl(job.id))}" download="${esc(dlName(job))}">${esc(T("下载"))}</a>`);
    }
    if (job.artifacts?.["score.abc"]) actions.push(`<button class="btn sm ghost" data-act="score" type="button">${esc(T("乐谱"))}</button>`);
    actions.push(`<button class="btn sm" data-act="reuse" type="button">${esc(T("改参数重试"))}</button>`);
  }
  actions.push(`<button class="btn sm ghost" data-act="detail" type="button" aria-label="${esc(T("任务详情"))}">${esc(T("详情"))}</button>`);

  let tail = "";
  if (job.status === "running") tail = `<button class="jlive" data-act="focus" type="button"` +
    ` data-gc-summary>${esc(queueSummary(job))}</button>`;
  else if (job.status === "queued") tail = `<div class="sub" style="margin-top:var(--sp3)">${esc(T("排队中 · 本机并发恒为 1，前面还有 {0} 个任务",
    state.jobs.filter((item) => item.id !== job.id
      && (item.status === "running" || item.status === "queued")
      && (item.created_at || 0) < (job.created_at || 0)).length))}</div>`;
  else if (job.status === "complete") {
    tail = `<div class="metrics">
        ${hasAudio(job) ? `<span>${esc(T("时长"))} <b class="mono">${esc(Number(job.duration || 0).toFixed(1))}s</b></span>` : ""}
        <span>${esc(T("耗时"))} <b class="mono">${esc(fmtStamp(job.seconds))}</b></span>
        ${job.artifacts?.["score.abc"] ? `<span>${esc(T("含乐谱"))}</span>` : ""}
        ${job.truncated ? `<span class="tk w">${esc(T("截断"))} ${esc(T("是"))}</span>` : ""}
      </div>` +
      (!hasAudio(job) ? `<div class="sub" style="margin-top:var(--sp3)">${esc(
        job.type === "plan"
          ? (job.artifacts?.["score.abc"]
            ? (job.truncated
              ? T("谱面被截断：请改短歌词重新生成，或在乐谱页修正后再渲染")
              : T("只出谱任务 · 还没有音频，点「渲染成歌」生成完整歌曲"))
            : T("乐谱产物缺失：任务没有写出 score.abc，请重新出谱"))
          : T("任务标记为完成，但没有音频文件：产物可能在保存时丢失，请重新生成或查看日志"))}</div>` : "");
  } else {
    const tip = failTip(job.error);
    const human = humanError(job.error) || T(job.error || "任务在写出产物前被终止");
    tail = `<div class="note bad" style="margin-top:var(--sp3)">${esc(human)}` +
      (tip ? `<div class="sub" style="margin-top:var(--sp2)">${esc(tip)}</div>` : "") + `</div>`;
  }

  return `<div class="jobc${job.status === "running" ? " live" : ""}" data-job="${esc(job.id)}">
    <div class="jt">
      <div class="jname">${notr(displayName(job))}</div>${demoBadge}${badge}
      <div class="jid mono" data-notr>${esc(job.id)}</div>
      <div class="acts">${actions.join("")}</div>
    </div>
    ${job.style ? `<div class="jstyle" data-notr>${esc(job.style)}</div>` : ""}
    ${tail}</div>`;
}

/* ------------------------------------------------------------------ 新手引导 / 教程 / 巡览 */
const GUIDE_KEY = "guide";
const TOUR_KEY = "tour";

function guideOff() {
  return readText(GUIDE_KEY, (value) => value === "off" || value === "done", "") !== "";
}

/* 关掉引导：点「知道了」或成功生成第一首之后就不再打扰。 */
function setGuideOff() {
  writeText(GUIDE_KEY, "off");
  const guide = $("guide");
  if (guide) guide.hidden = true;
}

function tourSeen() {
  return readText(TOUR_KEY, (value) => value === "seen", "") === "seen";
}

function markTourSeen() {
  writeText(TOUR_KEY, "seen");
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
    `<button class="btn sm" id="btnGuideOff" type="button">${esc("知道了")}</button>` +
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
  {view: "studio", target: ".topbar", title: "先认一下顶栏", body: "左边是模型状态与设备切换（CPU / GPU），右边是语言、主题、快捷键与加载/卸载模型。L 切语言、T 切主题、? 看快捷键。"},
  {view: "studio", target: "#fPreset", title: "先用一个范例起步", body: "下拉挑一套风格，点「载入范例」会把风格和歌词一起填好；之后随便改。"},
  {view: "studio", target: "#fStyle", title: "风格写在这里", body: "语言、流派、乐器、BPM 用英文逗号分隔。上面的标签只是帮着加词，原文可以直接改。"},
  {view: "studio", target: "#fLyrics", title: "歌词按段落写", body: "每行 7–13 个字，用 [Verse] / [Chorus] 分段。「检查结构」会提示过长或空段落。"},
  {view: "studio", target: ".modes", title: "规划模式", body: "「旋律 + 和弦」会先产出可读可改的乐谱；「不规划」最快，但没有谱可以改。"},
  {view: "studio", target: "#dock", title: "生成与进度", body: "「生成歌曲」一次做到音频；「只出谱」约 1 分钟先看谱。开始后页面顶部出现生成台：四段阶段轴、整体百分比和剩余时间都能看到，也能收起。"},
  {view: "score", target: ".scoreBar", title: "乐谱工作台", body: "选一条带谱的任务：音块图与文本谱是同一份谱。改完先「检查谱面」，通过后再「改谱重渲染」。"},
  {view: "score", target: ".toolrow", title: "改谱工具", body: "「对比原谱」看逐处改动，「去掉和弦」做翻唱片，「转纯音乐谱」去人声；改错了可以「恢复原谱」。"},
  {view: "library", target: "#v-library .vhead", title: "曲库与示例", body: "每条任务都能试听、下载、复制参数；选两条进入 A/B 盲听。内置示例曲「示例曲 · 晚风」就在这里。"},
  {view: "library", target: ".trans", title: "底部播放器", body: "空格播放/暂停，点波形跳转，A/B 切换也在这条上。播放时底条中央会常驻三句歌词。"},
  {view: "library", target: "#lyrTg", title: "整页播放页", body: "点右下角「歌词」整页展开：黑胶、歌词、卡拉OK、环形四种形态，1–4 切换、Esc 收起；刷新后曲目和进度也会自动恢复。"},
  {view: "system", target: "#sysModel", title: "系统与模型", body: "这里看模型状态、跑 doctor 自检、开生成加速，也能看到解码器与存储约束。模型常驻子进程，卸载即释放显存。"},
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

/* 进度不进签名：阶段事件每秒来好几条，重画只走 paintQueueSummary()，不整队重建 */
function queueSig(job, running) {
  return [getLang(), job.status, job.type, job.title, job.work_name, job.version_tag,
    job.version_label, job.lyrics_head, job.style,
    job.truncated ? 1 : 0, job.demo ? 1 : 0, job.error, job.duration, job.seconds, job.seed,
    hasAudio(job) ? 1 : 0, job.artifacts?.["score.abc"] ? 1 : 0,
    job.status === "queued" ? running : 0].join("|");
}

/* 队列卡折叠：默认收起，有运行/排队任务时自动展开；手动开合记住偏好 */
const QUEUE_FOLD_KEY = "queueFold";

function queueShouldOpen() {
  const manual = readText(QUEUE_FOLD_KEY, (value) => value === "open" || value === "closed", null);
  if (manual !== null) return manual === "open";
  return state.jobs.some((job) => job.status === "running" || job.status === "queued");
}

function paintQueueFold() {
  const open = queueShouldOpen();
  $("queue").hidden = !open;
  $("queueToggle").setAttribute("aria-expanded", String(open));
}

function renderQueue() {
  const host = $("queue");
  const live = state.jobs.filter((job) => job.status === "running" || job.status === "queued");
  const done = state.jobs.filter((job) => job.status !== "running" && job.status !== "queued").slice(0, 4);
  const rows = [...live, ...done];
  const running = live.filter((job) => job.status === "running").length;
  $("qBadge").textContent = T("{0} 运行 · {1} 排队", running, live.length - running);
  paintQueueFold();
  if (!rows.length) {
    host.innerHTML = `<div class="sub">${esc(T("还没有任务 · 填好风格与歌词，再点底部「生成歌曲」"))}</div>`;
    return;
  }
  renderKeyed(host, rows, "job", (job) => queueSig(job, running), jobCard);
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
    saveAb();
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
      ui.cancelRequested.add(id);
      refreshLiveSurfaces({full: true});
      let result;
      try {
        result = await cancelJob(id);
      } catch (exc) {
        ui.cancelRequested.delete(id);
        refreshLiveSurfaces({full: true});
        throw exc;
      }
      autoUnloadAfterCancel = id; // 取消成功：等任务落到 cancelled 且队列清空，自动卸载模型
      toast(result?.effective === "queued"
        ? T("已取消 · 该任务还在排队，没有开始生成")
        : T("取消请求已发出 · 非自回归与解码阶段没有取消点，将在当前阶段结束后停止"), "warn");
    } else if (action === "focus") {
      focusConsole();
    } else if (action === "log") {
      await openLog(job);
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
      // 同参换一首：种子清空，交给服务端随机；先收掉详情弹窗避免叠层
      const modalNode = document.querySelector(`[data-modal-job="${id}"], .modal.open`);
      if (modalNode) closeModal(modalNode);
      const detail = job.requested?.lyrics !== undefined ? job : await loadJob(id);
      await reuseParams(detail, {fresh: true});
    } else if (action === "render") {
      await createJob({type: "staged", source: id, from_stage: "plan", ode_steps: job.ode_steps});
      toast(T("已排队 · 正在从乐谱渲染成歌"), "ok");
      go("studio");
    } else if (action === "detail") {
      const detail = await loadJob(id);
      openJobModal(detail);
    } else if (action === "del") {
      await removeJob(id);
    } else if (action === "delete") {
      await removeJob(id);
    } else if (action === "fix-candidates") {
      go("studio");
      /* 候选数量是下拉框（#fVar），不能 select()；高亮闪一圈引导视线 */
      const fv = $("fVar");
      fv.classList.add("need-flash");
      setTimeout(() => fv.classList.remove("need-flash"), 1800);
      fv.focus({preventScroll: false});
      toast(T("把候选数改小（比如 2）再点「生成歌曲」重试"), "info");
    } else if (action === "fix-lyrics") {
      go("studio");
      const ff = scoreForm();
      if (ff.lyrics.length > 2200) ff.lyrics = ff.lyrics.slice(0, 2200).trimEnd();
      $("fLyrics").value = ff.lyrics;
      $("fLyrics").focus({preventScroll: false});
      saveDraft();
      toast(T("歌词已截短到可用长度，检查后点「生成歌曲」重试"), "info");
    } else if (action === "fix-cpu") {
      ui.device = "cpu";
      syncChips();
      renderTopbar();
      saveDraft();
      await onDevice({dataset: {dev: "cpu"}});
    }
  } catch (exc) {
    toast(message(exc), "bad");
  }
}

async function reuseParams(job, {fresh = false, skipConfirm = false} = {}) {
  if (!skipConfirm && !await confirmOverwrite()) return false;
  // 列表接口的 job.requested 不含 lyrics（只有 style/seed/cot/device），
  // 直接回填会把歌词丢成空串；先拉一次单任务全量再取参数。
  if (job.requested && job.requested.lyrics === undefined) {
    try { job = await loadJob(job.id); } catch (exc) { /* 拉不到就按列表字段兜底 */ }
  }
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
  // P1-7 设备、语言、速度都从原任务补全，避免正则兜不住时丢参数
  if (request.language) {
    const fLang = $("fLang");
    if (fLang) fLang.value = request.language;
  }
  if (request.bpm) {
    const fBpm = $("fBpm");
    if (fBpm) fBpm.value = String(request.bpm);
  }
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

/* 纯乐谱任务：直接用这份计划谱进入 staged 渲染，不再重新规划一首 */
async function renderPlanJob(id) {
  const job = state.byId.get(id);
  if (!job) return;
  if (job.truncated) return toast(T("这条任务的乐谱被截断了，直接渲染会得到残曲"), "warn");
  closeModal($("jobModal"));
  try {
    await createJob({type: "staged", source: id, from_stage: "plan", ode_steps: job.ode_steps});
    toast(T("已排队 · 正在从乐谱渲染成歌"), "ok");
    go("studio");
  } catch (exc) {
    toast(message(exc), "bad");
  }
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
  if (versionLabel(job)) rows.push([T("版本"), esc(versionLabel(job))]);
  if (job.version_note) rows.push([T("版本说明"), esc(job.version_note), 2]);
  if (job.parent_id) rows.push([T("源任务"), `<span class="mono" data-notr>${esc(job.parent_id)}</span>`]);
  const decoders = state.schema?.decoders || [];
  const canRedecode = !!job.artifacts?.["latent.npy"] && decoders.length && job.status === "complete";
  const planOnly = planOnlyJob(job);
  const subtitleBlocked = subtitleReason(job);
  const dirButtons = job.demo ? "" :
    `<div class="inline" style="margin-top:var(--sp3)">` +
    `<button class="btn sm ghost" type="button" data-m="log">${esc(T("查看日志"))}</button>` +
    `<button class="btn sm ghost" type="button" data-m="reveal">${esc(T("打开任务目录"))}</button></div>`;
  $("jobBody").innerHTML =
    `<div class="field" style="margin-bottom:var(--sp4)"><label for="jobTitle">${esc(T("作品名"))}</label>` +
    `<div class="inline" style="gap:var(--sp2)">` +
    `<input class="inp" id="jobTitle" maxlength="200" value="${esc(workName(job))}"` +
    ` placeholder="${esc(T("输入作品名"))}" style="flex:1"${job.demo ? " disabled" : ""}>` +
    (job.demo ? "" : `<button class="btn" type="button" data-m="rename">${esc(T("保存"))}</button>`) +
    `</div>` +
    (job.demo ? "" : `<div class="hint">${esc(T("改名会同步这个作品下的所有版本：候选、改谱、成歌一起变。"))}</div>`) +
    `</div>` +
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
    `<div class="field" style="margin-top:var(--sp3)"><label>${esc(T("字幕导出"))}</label>` +
    (subtitleBlocked
      ? `<div class="subEmpty">${esc(T(subtitleBlocked))}</div>`
      : `<div class="subActions">${subtitleButtons("btn sm ghost")}</div>` +
        `<div class="hint">${esc(T("导出当前歌词时间轴，可直接拖进播放器或剪辑软件；逐字版带每个字的时间点。"))}</div>`) +
    `</div>` +
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
    (reusable && !job.demo ? `<button class="btn ghost" type="button" data-m="again">${esc(T("复用参数"))}</button>` : "") +
    (hasAudio(job) ? `<a class="btn ghost" data-dl href="${esc(audioUrl(job.id))}" download="${esc(dlName(job))}" style="text-decoration:none">${esc(T("下载音频"))}</a>` : "") +
    (planOnly ? `<button class="btn primary" type="button" data-m="render">${esc(T("渲染成歌"))}</button>` : "") +
    (hasAudio(job) ? `<button class="btn primary" type="button" data-m="play">${esc(T("试听"))}</button>` : "");
  qa("[data-m]", $("jobModal")).forEach((button) => button.addEventListener("click", async () => {
    const which = button.dataset.m;
    if (which === "rename") {
      const value = $("jobTitle").value.trim();
      if (!value) {
        toast(T("作品名不能为空"), "bad");
        return;
      }
      if (value === workName(job)) return;
      button.disabled = true;
      try {
        await renameWork(job.id, value);
        // store 合并后 state.byId 换了新对象，弹窗闭包里的 job 仍是旧快照：
        // 同步一下，避免再点「保存」时拿旧名比较又发一次同样的改名请求。
        job.work_name = value;
        toast(T("已重命名作品"), "ok");
      } catch (exc) {
        toast(message(exc), "bad");
      } finally {
        button.disabled = false;
      }
      return;
    }
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
  qa("[data-sub]", $("jobModal")).forEach((button) =>
    button.addEventListener("click", () => downloadSubtitle(
      button.dataset.sub, job.id, button.dataset.word === "1", button)));
  q("[data-close]", $("jobModal")).onclick = () => closeModal($("jobModal"));
  if (!job.demo) {
    $("jobTitle").addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      qa('[data-m="rename"]', $("jobModal"))[0]?.click();
    });
  }
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
  ui.logSession += 1;
  ui.logJob = job.id;
  ui.logStart = 0;
  ui.logTotal = 0;
  ui.logLoaded = false;
  ui.logBusy = false;
  $("logPath").textContent = `${job.id} · .meta/run.log`;
  $("logBox").textContent = T("正在读取日志…");
  $("logBox").dataset.hasText = "";
  $("logBox").dataset.totalLines = "0";
  openModal($("logModal"));
  await loadLog(job.id, {tail: 500, session: ui.logSession});
}

function resetLogState() {
  ui.logSession += 1;
  ui.logJob = null;
  ui.logStart = 0;
  ui.logTotal = 0;
  ui.logLoaded = false;
  ui.logBusy = false;
}

/* 首次打开看末尾 500 行（服务端单页上限）；之后只在滚到顶部且仍有更早日志时向前补拉。 */
async function loadLog(id, {tail = null, offset = 0, limit = 200, session = ui.logSession} = {}) {
  if (ui.logJob !== id || ui.logSession !== session ||
      !$("logModal").classList.contains("open")) return false;
  ui.logBusy = true;
  const query = tail === null ? `offset=${offset}&limit=${limit}` : `lines=${tail}`;
  try {
    const data = await get(`/api/jobs/${encodeURIComponent(id)}/log?${query}`);
    if (ui.logJob !== id || ui.logSession !== session ||
        !$("logModal").classList.contains("open")) return false;
    const total = Number(data.total_lines);
    const box = $("logBox");
    /* 旧窗口只以真实正文为锚，占位符与报错文本不能混进历史窗口。 */
    const previous = tail === null && offset > 0 && box.dataset.hasText === "1"
      ? box.textContent : "";
    const body = data.text ? (previous ? `${data.text}\n${previous}` : data.text) : previous;
    ui.logStart = Number(data.offset || 0);
    ui.logTotal = Number.isFinite(total) ? total : 0;
    ui.logLoaded = true;
    box.textContent = body || T("这个任务还没有日志");
    box.dataset.hasText = body ? "1" : "";
    box.dataset.totalLines = String(ui.logTotal);
    if (tail !== null) box.scrollTop = box.scrollHeight;
    $("logPath").textContent = `${data.path} · ${(data.size / 1024).toFixed(1)} KB`;
    return true;
  } catch (exc) {
    if (ui.logJob !== id || ui.logSession !== session) return;
    /* 补拉失败时保留已加载正文；只有空盒子才显示占位或报错。 */
    if ($("logBox").dataset.hasText !== "1") {
      $("logBox").textContent = exc instanceof ApiError && exc.status === 404
        ? T("这个任务还没有日志")
        : message(exc);
    }
    return false;
  } finally {
    if (ui.logSession === session) ui.logBusy = false;
  }
}

function loadOlderLog() {
  const box = $("logBox");
  if (!ui.logJob || !ui.logLoaded || ui.logBusy || box.scrollTop > 0) return;
  const total = Number(box.dataset.totalLines || "0");
  if (ui.logStart <= 0 || ui.logStart >= total) return;
  const height = box.scrollHeight;
  const session = ui.logSession;
  loadLog(ui.logJob, {offset: Math.max(0, ui.logStart - 200), limit: 200, session}).then((loaded) => {
    // 补的是更早文本，保持用户原来看到的滚动位置，而不是把视图拉回顶部。
    if (loaded && ui.logSession === session) box.scrollTop = box.scrollHeight - height;
  });
}

/* ------------------------------------------------------------------ 曲库 */
const SORT_KEY = "sort";
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
    return [job.id, job.title, job.work_name, job.version_tag, job.version_label,
      job.version_note, job.style, job.lyrics_head, job.requested?.lyrics]
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
  const slot = ui.ab.indexOf(job.id);
  const selected = slot >= 0;
  const playable = hasAudio(job);
  const planOnly = planOnlyJob(job);
  const reusable = job.status !== "running" && job.status !== "queued";
  const hasScore = !!job.artifacts?.["score.abc"];
  const subtitleBlocked = subtitleReason(job);
  const tip = playable ? ""
    : job.status === "failed" || job.status === "cancelled"
      ? T("任务{0}，没有可播放的音频；可「详情」查看原因或复用参数",
        T(job.status === "failed" ? "失败" : "已取消"))
      : planOnly ? T("仅乐谱：点「渲染成歌」生成音频")
        : T("没有音频产物：点「详情」看参数或查看日志");
  /* 播放联动：正在播的卡显示暂停按钮并常显（底部播放条同一状态源） */
  const isCurrent = ui.track === job.id;
  const playing = isCurrent && !player.paused && !player.ended;
  /* 媒体区波形：解码过就画真峰值，没解码过先画平底骨架，进了视口再异步解码 */
  const peaks = waveCache.get(job.id);
  const waveHtml = (peaks || Array(WAVE_BARS).fill(6))
    .map((height) => `<i style="height:${Math.max(6, height)}%"></i>`).join("");
  return `<div class="tcard${selected ? " sel" : ""}${isCurrent ? " playing" : ""}" data-lib="${esc(job.id)}" tabindex="0" role="button"
    aria-label="${esc(displayName(job))}"${playable ? "" : ` title="${esc(tip)}"`}>
    <span class="tmedia">
      <span class="twave" data-wave="${esc(job.id)}"${peaks ? " data-ready" : ""}>${waveHtml}</span>
      <span class="tdur mono" data-notr>${esc(job.duration ? fmtClock(job.duration) : T("仅乐谱"))}</span>
      ${playable
        ? `<span class="tplaybig" data-lplay="${esc(job.id)}" role="button" tabindex="0" aria-label="${esc(playing ? T("暂停") : T("试听"))}">${icon(playing ? "pause" : "play")}</span>`
        : `<span class="tico-lg">${icon(hasScore ? "abc" : "music")}</span>`}
      <span class="star${job.favorite ? " on" : ""}" data-star="${esc(job.id)}" role="button" tabindex="0"
        aria-label="${esc(T("收藏"))}" aria-pressed="${job.favorite ? "true" : "false"}"
        title="${esc(T("收藏"))}">${icon("star")}</span>
      ${selected ? `<span class="abb mono" data-notr>${slot === 0 ? "A" : "B"}</span>` : ""}
    </span>
    <div class="tbody">
      <span class="thead" title="${esc(T("双击标题可重命名作品"))}"><span class="tn2" data-title="${esc(job.id)}">${notr(displayName(job))}</span><span class="tedit" aria-hidden="true">${icon("pencil")}</span></span>
      <span class="tm2">${esc(job.device === "cuda" ? T("显卡") : "CPU")} · <span data-notr>${esc(fmtDate(job.created_at))}</span>${job.demo ? ` · ${esc(T("示例"))}` : ""}${planOnly ? "" : ` · <span data-notr>${esc(T("种子"))} ${esc(job.seed ?? "—")}</span>`}</span>
      ${job.lyrics_head ? `<span class="tlyr">${esc(job.lyrics_head)}</span>` : ""}
      <span class="rowb">
        <span class="state ${kind[0]}">${esc(T(kind[1]))}</span>
        ${planOnly ? (job.truncated
          ? `<span class="tmore" title="${esc(T("谱面被截断，不能直接渲染"))}" style="opacity:.55">${esc(T("渲染成歌"))}</span>`
          : `<span class="tmore" data-render="${esc(job.id)}" role="button" tabindex="0">${esc(T("渲染成歌"))}</span>`) : ""}
        <span class="tacts">
          ${playable ? `<a class="tact" data-dl href="${esc(audioUrl(job.id))}" download="${esc(dlName(job))}" title="${esc(T("下载音频"))}" aria-label="${esc(T("下载音频"))}">${icon("tray")}</a>` : ""}
          ${hasScore ? `<span class="tact" data-score="${esc(job.id)}" role="button" tabindex="0" title="${esc(T("看乐谱"))}" aria-label="${esc(T("看乐谱"))}">${icon("score")}</span>` : ""}
          ${reusable && !job.demo ? `<span class="tact" data-again="${esc(job.id)}" role="button" tabindex="0" title="${esc(T("复用参数"))}" aria-label="${esc(T("复用参数"))}">${icon("copy")}</span>` : ""}
          <span class="tact" data-more="${esc(job.id)}" role="button" tabindex="0" title="${esc(T("详情"))}" aria-label="${esc(T("详情"))}">${icon("info")}</span>
          ${reusable && !job.demo ? `<span class="tact" data-del="${esc(job.id)}" role="button" tabindex="0" title="${esc(T("删除"))}" aria-label="${esc(T("删除"))}">${icon("trash")}</span>` : ""}
        </span>
      </span>
      <details class="cardSub" data-subcard="${esc(job.id)}"${ui.subOpen.has(job.id) ? " open" : ""}>
        <summary${subtitleBlocked ? ' class="muted"' : ""} aria-label="${esc(T("字幕导出"))}" title="${esc(T(subtitleBlocked || "字幕导出"))}"><span>${esc(T("字幕"))}</span><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>
        <div class="cardSubPanel">${subtitleBlocked
          ? `<div class="subEmpty">${esc(T(subtitleBlocked))}</div>`
          : subtitleButtons("cardSubItem")}</div></details>
    </div>
  </div>`;
}

/* 卡片签名：只列卡片上真的会画出来的字段，语言也算一份。
   签名没变就复用原节点，收藏/选中/进度变化只重画那一条。 */
function libSig(job) {
  const playing = ui.track === job.id && !player.paused && !player.ended;
  return [getLang(), job.status, job.truncated ? 1 : 0, job.favorite ? 1 : 0, job.demo ? 1 : 0,
    job.artifacts?.["score.abc"] ? 1 : 0, hasAudio(job) ? 1 : 0, hasLyrics(job) ? 1 : 0,
    job.title, job.work_name,
    job.version_tag, job.version_label, job.lyrics_head, job.lyrics_len || 0,
    job.duration, job.device, job.created_at, job.cot, job.seed,
    ui.subOpen.has(job.id) ? 1 : 0,
    Math.max(0, ui.ab.indexOf(job.id) + 1), waveCache.has(job.id) ? 1 : 0, playing ? 1 : 0].join("|");
}

async function toggleFavorite(id) {
  const job = state.byId.get(id);
  try {
    const updated = await updateJob(id, {favorite: !job?.favorite});
    toast(updated?.favorite ? T("已收藏") : T("已取消收藏"), "ok");
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

/* 卡片重渲染会换掉节点，焦点跟着掉到 body；记住字幕入口的焦点位置再还回去 */
function subtitleFocusTarget() {
  const active = document.activeElement;
  if (!(active instanceof Element) || !$("libGrid").contains(active)
      || !active.closest("[data-subcard]")) return null;
  const card = active.closest("[data-subcard]");
  const selector = active.tagName === "SUMMARY" ? "summary"
    : active.matches("[data-sub]")
      ? `[data-sub="${active.dataset.sub}"]${active.dataset.word ? '[data-word="1"]' : ":not([data-word])"}`
      : "";
  return selector ? {id: card.dataset.subcard, selector} : null;
}

function restoreSubtitleFocus(target) {
  if (!target || document.activeElement !== document.body) return;
  const card = [...$("libGrid").children].find((node) => node.dataset.lib === target.id);
  card?.querySelector(`[data-subcard] ${target.selector}`)?.focus({preventScroll: true});
}

function renderLibrary() {
  const focusTarget = subtitleFocusTarget();
  const rows = libRows();
  renderKeyed($("libGrid"), rows, "lib", libSig, libCard);
  restoreSubtitleFocus(focusTarget);
  observeCardWaves();
  if (ui.track) paintCardProgress(player.duration ? player.currentTime / player.duration : 0);
  const audioJobs = state.jobs.filter((job) => hasAudio(job));
  const total = audioJobs.reduce((sum, job) => sum + (job.duration || 0), 0);
  const stats = $("libStats");
  stats.hidden = audioJobs.length === 0;
  stats.textContent = audioJobs.length
    ? T("共 {0} 首 · 总时长 {1}", audioJobs.length, fmtClock(total)) : "";
  const empty = rows.length === 0;
  $("libEmpty").hidden = !empty;
  if (empty) {
    const filtered = Boolean(ui.search.trim()) || ui.filter;
    $("libEmpty").innerHTML = filtered
      ? esc(ui.search.trim()
          ? T("没有匹配「{0}」的任务", ui.search.trim())
          : T("没有符合条件的任务"))
      : `<span class="note-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></span>
         <span style="flex:1;min-width:220px">${esc(T("还没有作品。回创作页写好风格与歌词，生成第一首歌。"))}</span>
         <button class="btn sm" id="libGoStudio" type="button">${esc(T("去创作页"))}</button>`;
  }
  $("libEmpty").onclick = (event) => {
    if (event.target instanceof Element && event.target.id === "libGoStudio") go("studio");
  };
  $("libSort").value = ui.sort;
  /* 恢复/删除后修剪 AB 配对里的失效 id，并同步播放条两个槽的可用性：
     没有这里，刷新后配对虽然回来了，B 槽按钮却还是出厂的禁用态。 */
  const validAb = ui.ab.filter((id) => hasAudio(state.byId.get(id)));
  if (validAb.length !== ui.ab.length) {
    ui.ab = validAb;
    saveAb();
  }
  $("btnAB").textContent = T("A/B 对比（{0}）", ui.ab.length);
  $("btnAB").disabled = ui.ab.length !== 2;
  qa(".ab button").forEach((button) => {
    button.disabled = button.dataset.ab === "b" && ui.ab.length !== 2;
  });
}

/* 卡片媒体区波形：进视口才解码音频算峰值（复用全局 waveCache，播放条同源），
   解不出就保留平底骨架，不装作有数据 */
let libWaveIO = null;

/* 骨架与真峰值同为 WAVE_BARS 根：解码完成后逐根改高度，CSS 过渡里波形"长"出来 */
function paintCardWave(node, peaks) {
  const bars = node.querySelectorAll("i");
  if (bars.length === peaks.length) {
    peaks.forEach((height, index) => { bars[index].style.height = `${Math.max(6, height)}%`; });
  } else {
    node.innerHTML = peaks.map((height) => `<i style="height:${Math.max(6, height)}%"></i>`).join("");
  }
  node.dataset.ready = "1";
}

function observeCardWaves() {
  qa(".twave[data-wave]:not([data-ready])", $("libGrid")).forEach((node) => {
    const id = node.dataset.wave;
    const peaks = waveCache.get(id);
    if (peaks) { paintCardWave(node, peaks); return; }
    if (!libWaveIO) {
      libWaveIO = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          libWaveIO.unobserve(entry.target);
          const el = entry.target;
          const jobId = el.dataset.wave;
          Promise.resolve(paintWaveFromAudio(jobId)).finally(() => {
            const found = waveCache.get(jobId);
            if (found) paintCardWave(el, found);
            else el.dataset.ready = "1";
          });
        }
      }, {root: $("work"), rootMargin: "160px"});
    }
    libWaveIO.observe(node);
  });
}

/* 双击标题重命名：inline 输入框改的是作品名（组内所有版本一起改），
   Enter/失焦提交，Esc 取消；空值等于取消，不把空名发给后端。 */
function startRename(card, span) {
  if (card.querySelector(".trename")) return;
  const id = card.dataset.lib;
  const job = state.byId.get(id);
  if (!job) return;
  // 示例曲是随包发布的只读样本，和删除、移动一样不允许改名。
  if (job.demo) {
    toast(T("示例曲不能重命名"), "bad");
    return;
  }
  const input = document.createElement("input");
  input.className = "trename";
  input.maxLength = 200;
  input.value = workName(job);
  input.setAttribute("aria-label", T("重命名作品"));
  span.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    span.textContent = displayName(job);
    if (!save || !value || value === workName(job)) return;
    try {
      await renameWork(id, value);
      toast(T("已重命名作品"), "ok");
    } catch (exc) {
      toast(message(exc), "bad");
    }
  };
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") commit(true);
    else if (event.key === "Escape") commit(false);
  });
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("dblclick", (event) => event.stopPropagation());
  input.addEventListener("blur", () => commit(true));
}

function applyAB() {
  if (ui.ab.length !== 2) return;
  if (!ui.ab.every((id) => hasAudio(state.byId.get(id)))) {
    ui.ab = ui.ab.filter((id) => hasAudio(state.byId.get(id)));
    saveAb();
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
  // 失败/取消的任务也可能已经写出有效乐谱：让人能打开检查，而不是只能看到失败卡片。
  return state.jobs.filter((job) => job.artifacts?.["score.abc"]);
}

/* 主页与乐谱工作台共用一份谱面：ui.scoreJob 是当前任务、ui.scoreAbc 是谱文本。
   没选或选的任务没了就跟着最新那份，和乐谱工作台同一条规则；用不用它由勾选框决定。 */
function renderStudioScoreChoices() {
  const select = $("studioScoreSource");
  if (!select) return;
  const choices = scoreChoices();
  if (ui.scoreJob && !choices.some((job) => job.id === ui.scoreJob)) ui.scoreJob = "";
  if (!ui.scoreJob && choices.length) ui.scoreJob = choices[0].id;
  /* 没有可看的谱就把共用文本清掉：否则面板会留着上一个任务的谱，看着像它还在当前任务下 */
  if (!ui.scoreJob) {
    ui.scoreAbc = "";
    ui.scoreOriginal = "";
    ui.scoreLoadedJob = null;
    ui.scoreStamp = "";
    ui.scoreHash = "";
  }
  select.innerHTML = choices.map((job) => {
    const raw = displayName(job).replace(/\s+/g, " ");
    const name = raw.length > 24 ? `${raw.slice(0, 24)}…` : raw;
    const status = job.status === "complete" ? "" : ` · ${T(BADGE[job.status]?.[1] || job.status)}`;
    return `<option value="${esc(job.id)}">${esc(`${name} · ${job.id}${status}`)}</option>`;
  }).join("");
  select.disabled = !choices.length;
  select.value = ui.scoreJob || "";
  paintStudioScore();
}

async function renderStudioScore() {
  renderStudioScoreChoices();
  if (!ui.scoreJob) return;
  await loadScoreText(ui.scoreJob);
  paintStudioScore();
}

/* 主动在下拉里换任务才把它的风格/歌词带回表单；生成中刚写出的谱只展示，不动正在写的词。 */
async function copyRequestToForm(jobId) {
  if (!jobId) return;
  const cached = state.byId.get(jobId) || state.jobs.find((item) => item.id === jobId);
  const detail = cached?.requested?.lyrics !== undefined ? cached : await loadJob(jobId);
  if (ui.scoreJob !== jobId) return;
  const request = detail?.requested || {};
  if (request.style) $("fStyle").value = request.style;
  if (request.lyrics) $("fLyrics").value = request.lyrics;
  saveDraftSoon();
}

let autoOpenedStamp = "";

function paintStudioScore() {
  const box = $("studioScore");
  if (!box) return;
  const has = !!ui.scoreJob;
  /* 折叠头上的元信息：让收起状态也知道当前是哪份谱、多大 */
  const job = state.byId.get(ui.scoreJob || "");
  const lines = ui.scoreAbc ? ui.scoreAbc.split("\n").length : 0;
  $("studioScoreMeta").textContent = job
    ? `${displayName(job)} · ${T("{0} 行", lines || "—")}` : "";
  if (box.value !== ui.scoreAbc) box.value = ui.scoreAbc;
  /* 生成中谱刚写出来时自动展开一次：卖点不能藏在折叠里；同一份谱不反复打扰 */
  const sec = $("studioScoreSec");
  if (job?.status === "running" && ui.scoreAbc.trim() && !sec.open && autoOpenedStamp !== ui.scoreStamp) {
    sec.open = true;
    autoOpenedStamp = ui.scoreStamp;
  }
  box.disabled = !has;
  $("btnLoadSelectedScore").disabled = !has;
  $("btnSaveStudioDraft").disabled = !has;
  const chip = $("studioUseScore");
  chip.disabled = !has || !ui.scoreAbc.trim();
  if (chip.disabled) ui.useScore = false;
  chip.setAttribute("aria-pressed", String(ui.useScore));
  const note = $("studioScoreNote");
  if (!note) return;
  if (ui.useScore && has) {
    note.hidden = false;
    note.className = "note";
    note.textContent = T("已勾选：这次按 {0} 的谱面重新渲染，风格与歌词用上方表单里写的。", ui.scoreJob);
  } else note.hidden = true;
}

/* 谱草稿：同时写一份浏览器本地自动保存，刷新/崩溃后可恢复；
   切到另一个任务时把草稿钉到 localStorage，回来用原谱的最新版校验再恢复。 */
const scoreDrafts = new Map();
const DRAFT_KEY_PREFIX = "scoreDraft.";
let scoreDraftTimer = null;
let scoreDraftPendingJob = "";

function localDraftSave(jobId, value) {
  if (!jobId) return;
  if (value === undefined) removeRaw(DRAFT_KEY_PREFIX + jobId);
  else writeJson(DRAFT_KEY_PREFIX + jobId, value);
}

function localDraftLoad(jobId) {
  if (!jobId) return null;
  return readRaw(DRAFT_KEY_PREFIX + jobId, {legacy: false});
}

/* 任务行里的谱面指纹：状态 + 字节数。生成中谱面刚写出来时字节数会变化，
   页面据此决定要不要重新拉一次文本，不用每次进度事件都请求。 */
const scoreStamp = (jobId) => {
  const job = state.byId.get(jobId);
  return job ? `${job.status}:${job.artifacts?.["score.abc"] || 0}` : "";
};

/* 当前任务的谱文本：正在编辑就不覆盖；同一任务且谱没变就不重复请求。 */
async function loadScoreText(jobId, {force = false} = {}) {
  if (!jobId) return false;
  if (ui.scoreLoadedJob === jobId && ui.scoreAbc !== ui.scoreOriginal) return false;
  if (!force && ui.scoreLoadedJob === jobId && ui.scoreStamp === scoreStamp(jobId)) return false;
  try {
    const data = await get(`/api/jobs/${encodeURIComponent(jobId)}/score`);
    if (ui.scoreJob !== jobId) return false;
    ui.scoreOriginal = data.abc || "";
    ui.scoreHash = data.sha256 || "";
    /* 内存草稿优先，其次本地草稿；本地草稿附带保存时服务端版本用于防串扰 */
    let draft = scoreDrafts.get(jobId);
    let savedOriginal = null;
    if (draft === undefined) {
      const saved = readJson(DRAFT_KEY_PREFIX + jobId, (value) =>
        validators.object(value) && typeof value.abc === "string" &&
        (value.original === undefined || value.original === null || typeof value.original === "string"),
        null);
      if (saved) {
        draft = saved.abc;
        savedOriginal = saved.original ?? null;
      }
    }
    ui.savedOriginal = savedOriginal;
    if (draft !== undefined && draft !== null) {
      if (savedOriginal && savedOriginal !== ui.scoreOriginal) {
        ui.scoreAbc = ui.scoreOriginal;
        discardScoreDraft(jobId);
        toast(T("本地草稿与服务器谱面版本不一致，已丢弃草稿用原谱"), "warn");
      } else {
        ui.scoreAbc = draft;
        scoreDrafts.set(jobId, draft);
        if (savedOriginal == null) localDraftSave(jobId, {abc: draft, original: ui.scoreOriginal});
      }
    } else ui.scoreAbc = ui.scoreOriginal;
    ui.scoreStamp = scoreStamp(jobId);
    /* 加载不走 scoreEdited，这里同步一次恢复钮的置灰（无差异=禁用）。 */
    $("btnRevert").disabled = ui.scoreAbc === ui.scoreOriginal;
  } catch (exc) {
    if (ui.scoreJob !== jobId) return false;
    ui.scoreAbc = "";
    ui.scoreOriginal = "";
    ui.scoreHash = "";
    toast(T("乐谱读取失败：{0}", message(exc)), "bad");
    return false;
  }
  if (ui.scoreAbc !== ui.scoreOriginal && ui.scoreOriginal) {
    /* toast + 丢弃入口；点丢弃立刻用原谱覆盖编辑器 */
    toast(T("已恢复本地草稿 · 点「改谱重渲染」才会写回"), "warn", 12000, [
      {label: T("丢弃草稿用原谱"), fn: () => discardScoreDraft(jobId)},
    ]);
  }
  ui.scoreLoadedJob = jobId;
  return true;
}

/* 文本打字/方块拖动都走这里：清检查、清对比结论、清草稿定时器、写内存+localStorage。 */
function scoreEdited() {
  if (ui.inspect) {
    ui.inspect = null;
    $("abcInsp").innerHTML = `<div class="sub">${esc(T("谱已改，请重新检查"))}</div>`;
  }
  /* 没有原谱、或当前就是原谱时，「恢复原谱」无事可做，置灰防止空确认框。 */
  if ($("btnRevert")) {
    $("btnRevert").disabled = ui.scoreOriginal.trim() === "" || ui.scoreAbc === ui.scoreOriginal;
  }
  /* 谱已变，旧的「与原谱一致/有差异」结论不再成立，留着会误导 */
  const note = $("toolNote");
  if (note && !note.hidden) {
    note.hidden = true;
    note.innerHTML = "";
  }
  const jobId = ui.scoreJob;
  if (jobId && ui.scoreAbc !== ui.scoreOriginal) {
    scoreDrafts.set(jobId, ui.scoreAbc);
    clearTimeout(scoreDraftTimer);
    scoreDraftPendingJob = jobId;
    scoreDraftTimer = setTimeout(() => {
      if (scoreDraftPendingJob) localDraftSave(scoreDraftPendingJob, {abc: scoreDrafts.get(scoreDraftPendingJob), original: ui.scoreOriginal});
      scoreDraftPendingJob = "";
    }, 320);
  } else if (jobId) {
    scoreDrafts.delete(jobId);
    localDraftSave(jobId, undefined);
  }
}

function discardScoreDraft(jobId) {
  if (!jobId) return;
  scoreDrafts.delete(jobId);
  localDraftSave(jobId, undefined);
  if (ui.scoreJob === jobId) {
    ui.scoreAbc = ui.scoreOriginal;
    paintAbc();
    toast(T("已丢弃本地草稿，用的还是服务器原谱"), "ok");
  }
}

window.addEventListener("beforeunload", () => {
  /* 新版直接落 localStorage，不再拦刷新 */
  try {
    if (ui.scoreJob && ui.scoreAbc !== ui.scoreOriginal) {
      scoreDrafts.set(ui.scoreJob, ui.scoreAbc);
      localDraftSave(ui.scoreJob, {abc: ui.scoreAbc, original: ui.scoreOriginal});
    }
  } catch (exc) {}
});

function selectScoreJob(next) {
  if (!next || next === ui.scoreJob) return;
  if (ui.scoreAbc !== ui.scoreOriginal) {
    scoreDrafts.set(ui.scoreJob, ui.scoreAbc);
    localDraftSave(ui.scoreJob, {abc: ui.scoreAbc, original: ui.scoreOriginal});
  }
  ui.scoreJob = next;
  ui.inspect = null;
  ui.rollPlan = null;
  ui.rollSel = null;
  ui.rollUndo = [];
  ui.rollError = "";
  $("toolNote").hidden = true;
}

/* 给外部 AI 工具直接复制的谱面约定：只写官方原生两行 ABC 能解析的部分。
   逐条对应 YuE/skills/yue2-music/scripts/abc_tools.py 的校验。 */
const SCORE_RULES = {
  zh: `YuE2 乐谱写法（官方原生两行 ABC）

【文件头固定 8 行，顺序不能变】
X:1
T:
M:4/4
L:1/32
Q:1/4=83
V: Vocal clef=treble name="Vocal Melody" snm="Vocal"
V: Ins clef=treble name="Ins Melody" snm="Inst."
K:C

· T: 必须留空，标题不要写；不要加 C:/W:/%% 等额外行，也不要插空行。
· M: 写显式拍号；L: 是时值单位（2 的幂，常用 1/32 或 1/16）。
· Q: 写成 Q:1/4=<整数 BPM>（20–300）。
· K: 用标准大小调（C、Em、Bb、F#m 等）；两条 V: 声明必须一字不差。

【正文：每段 Vocal、Ins 两行一对】
% verse
V: Vocal
"C"z8E8G8E8|"Am"D8C8A,8z8|
V: Ins
C8z8G,8z8|A,8z8E8z8|

· 段落名用 % 开头（可选）；每行 1–4 小节，以普通 | 结尾，不要 ||、:|。
· 每小节总时值必须正好等于拍号（4/4 + L:1/32 = 32 个单位）。
· 只允许 Vocal/Ins 两个声部，Vocal 在前；每段两声部小节数相同。
· 和弦只写在 Vocal；换拍号/换调时两个声部各写一行相同的 M:/K:。

【音符记法】
· 音名 A–G；小写高八度，' 再升，, 降（如 c' / C,）。
· 升降号写在音名前：^ ^^ _ __ =（升、重升、降、重降、还原）。
· 时值写在音名后：1 2 3 4 6 8 12 16 24 32 48，不写默认 1。
· 连音线在音后加 -，跨小节也一样；不能接到休止符，结尾必须解决。
· 休止符 z 同样带时值；整小节休止写 Z（Z2–Z4 为连续小节）。
· 同一小节里同名音的升降号会延续到后面。

【可直接改的完整示例】
X:1
T:
M:4/4
L:1/32
Q:1/4=83
V: Vocal clef=treble name="Vocal Melody" snm="Vocal"
V: Ins clef=treble name="Ins Melody" snm="Inst."
K:C
% verse
V: Vocal
"C"z8E8G8E8|"Am"D8C8A,8z8|
V: Ins
C8z8G,8z8|A,8z8E8z8|
% chorus
V: Vocal
"F"F8A8C8A8|"G"G8B8D8z8|
V: Ins
F,8z8C8z8|G,8z8D8z8|`,
  en: `YuE2 score format (native two-voice ABC)

[Header: exactly 8 lines, in this order]
X:1
T:
M:4/4
L:1/32
Q:1/4=83
V: Vocal clef=treble name="Vocal Melody" snm="Vocal"
V: Ins clef=treble name="Ins Melody" snm="Inst."
K:C

- T: must stay blank: no title. Add no other header lines (C:, W:, %%, ...) and no blank lines.
- M: an explicit time signature; L: the note unit (a power of two, usually 1/32 or 1/16).
- Q: Q:1/4=<integer BPM> (20-300).
- K: a standard major/minor key (C, Em, Bb, F#m, ...). Copy both V: lines exactly.

[Body: one Vocal line and one Ins line per section]
% verse
V: Vocal
"C"z8E8G8E8|"Am"D8C8A,8z8|
V: Ins
C8z8G,8z8|A,8z8E8z8|

- A section name starts with % (optional). Each music line holds 1-4 bars and ends with a plain |, never || or :|.
- Each bar must add up exactly to the meter (4/4 with L:1/32 = 32 units).
- Only two voices, Vocal first, then Ins; both must have the same number of bars per section.
- Chords go in Vocal only. To change meter or key, put the same M:/K: line under both voices.

[Note syntax]
- Pitches A-G; lowercase is an octave up; ' raises another octave and , lowers one (c' / C,).
- Accidentals go before the pitch: ^ ^^ _ __ = (sharp, double sharp, flat, double flat, natural).
- Duration goes after the pitch: 1 2 3 4 6 8 12 16 24 32 48; omitted means 1.
- A tie is a trailing - (also across bars); never tie into a rest and always resolve the final tie.
- z is a rest with an optional duration; a full-bar rest is Z (Z2-Z4 for consecutive bars).
- An accidental on a letter carries to later notes of the same letter in that bar.

[Complete example you can edit]
X:1
T:
M:4/4
L:1/32
Q:1/4=83
V: Vocal clef=treble name="Vocal Melody" snm="Vocal"
V: Ins clef=treble name="Ins Melody" snm="Inst."
K:C
% verse
V: Vocal
"C"z8E8G8E8|"Am"D8C8A,8z8|
V: Ins
C8z8G,8z8|A,8z8E8z8|
% chorus
V: Vocal
"F"F8A8C8A8|"G"G8B8D8z8|
V: Ins
F,8z8C8z8|G,8z8D8z8|`
};

function paintRules() {
  $("rulesText").textContent = SCORE_RULES[getLang()] || SCORE_RULES.zh;
  $("btnCopyRules").textContent = T("复制规则");
}

async function copyRules() {
  const text = SCORE_RULES[getLang()] || SCORE_RULES.zh;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (exc) {
    // 局域网 http 下没有安全上下文，退回选中复制，别让功能只在 Chrome/HTTPS 可用。
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(area);
    area.select();
    try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
    area.remove();
  }
  const button = $("btnCopyRules");
  if (!ok) return toast(T("复制失败：浏览器不允许访问剪贴板，请手动选中规则复制"), "bad");
  button.textContent = T("已复制规则");
  setTimeout(paintRules, 1600);
}

async function renderScore() {
  const choices = scoreChoices();
  renderStudioScoreChoices();
  const note = $("scoreNote");
  const select = $("scoreJob");
  if (!choices.length) {
    select.innerHTML = "";
    select.disabled = true;
    $("btnInspect").disabled = true;
    $("btnRerender").disabled = true;
    $("btnToStudio").disabled = true;
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
  $("btnToStudio").disabled = false;
  for (const id of ["btnCompare", "btnStrip", "btnInstr", "btnRollFull"]) $(id).disabled = false;
  /* 标签把「名字」放前面、编号缩成末 4 位短哈希：原来拼的是完整编号，
     而 320px 的下拉只显示得下 ~22 个字符，同源任务的编号前缀又一样，
     截断点正好落在区分位之前，几条看着一模一样。完整编号仍在 title 里。 */
  const hashCount = new Map();
  for (const job of choices) {
    const h = String(job.id).split("_").pop();
    hashCount.set(h, (hashCount.get(h) || 0) + 1);
  }
  const shortId = (id) => {
    const parts = String(id).split("_");
    return hashCount.get(parts[parts.length - 1]) > 1 ? parts.slice(-2).join("_") : parts[parts.length - 1];
  };
  const optionLabels = new Map();
  select.innerHTML = choices.map((job) => {
    const raw = displayName(job).replace(/\s+/g, " ");
    const name = raw.length > 16 ? `${raw.slice(0, 16)}…` : raw;
    const status = job.status === "complete"
      ? "" : ` · ${T(BADGE[job.status]?.[1] || job.status)}`;
    optionLabels.set(job.id, `${raw} · ${job.id}${status}`);
    return `<option value="${esc(job.id)}">${esc(`${name} · ${shortId(job.id)}${status}`)}</option>`;
  }).join("");
  select.value = ui.scoreJob;
  select.title = optionLabels.get(ui.scoreJob) || "";
  note.hidden = false;
  note.className = "note";
  note.innerHTML = esc(T("乐谱可以直接改：改完点「改谱重渲染」，整曲会按新谱面重新渲染（约 10 分钟）。下载、对比、刷新都走当前版，不再静默回原谱。"));
  $("btnAbcDl").href = `/api/jobs/${encodeURIComponent(ui.scoreJob)}/score/download`;
  $("btnAbcDl").removeAttribute("aria-disabled");
  refreshScoreStateNote();
  await loadScoreText(ui.scoreJob);
  $("abcName").textContent = `${ui.scoreJob}/score.abc`;
  paintAbc();
  paintStudioScore();
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
  scoreEdited();
  paintAbc();
  $("abcInsp").innerHTML = `<div class="sub">${esc(T("谱面已修改 · 点「检查谱面」校验，或直接「改谱重渲染」"))}</div>`;
  scheduleRoll();
}

/* P0-2：下载/对比走当前版 + 备份恢复入口。 */
let scoreStateCache = null;
async function refreshScoreStateNote() {
  if (!ui.scoreJob) return;
  try {
    const state = await get(`/api/jobs/${encodeURIComponent(ui.scoreJob)}/score/state`);
    scoreStateCache = state;
    const note = $("scoreNote");
    if (!note || note.hidden) return;
    const base = T("乐谱可以直接改：改完点「改谱重渲染」，整曲会按新谱面重新渲染（约 10 分钟）。下载、对比、刷新都走当前版，不再静默回原谱。");
    if (state.has_backup && state.modified) {
      note.innerHTML = esc(base) + ` <a href="#" id="lnkRestoreScore" style="margin-left:var(--sp2)">${esc(T("恢复原谱"))}</a>`;
      const link = $("lnkRestoreScore");
      if (link) link.addEventListener("click", async (e) => {
        e.preventDefault();
        const ok = await confirmDialog({title: T("恢复原谱"), body: T("将用备份的原始谱面覆盖当前版，改版会被备份起来（时间戳），可再次恢复。"), ok: T("恢复原谱"), cancel: T("取消")});
        if (!ok) return;
        try {
          await post(`/api/jobs/${encodeURIComponent(ui.scoreJob)}/score/restore`);
          ui.scoreOriginal = ui.scoreAbc;
          ui.scoreHash = "";
          ui.scoreLoadedJob = null;
          ui.scoreAbc = "";
          scoreDrafts.delete(ui.scoreJob);
          localDraftSave(ui.scoreJob, undefined);
          toast(T("已恢复原谱"), "ok");
          renderScore();
          refreshScoreStateNote();
        } catch (exc) { toast(message(exc), "bad"); }
      });
    } else if (state.has_backup) {
      note.textContent = base + T("（已有备份）");
    }
  } catch { /* 状态接口失败不阻塞看谱 */ }
}

function toolNote(html, kind = "") {
  const note = $("toolNote");
  note.hidden = false;
  note.className = `note${kind ? ` ${kind}` : ""}`;
  note.innerHTML = html;
}

/* --------------------------------------------------------------- 音块图 */
const ROLL_LENGTHS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48];
const ROLL_BAND = 18;
const ROLL_CHORD = 16;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const ROLL_ZOOM_STEP = 1.25;
const ROLL_ZOOM_MIN = 0.35;
const ROLL_ZOOM_MAX = 6;
const ROLL_ZOOM_KEY = "rollZoom";
const clampZoom = (v) => Math.min(ROLL_ZOOM_MAX, Math.max(ROLL_ZOOM_MIN, v));
/* 画布不再无限长：超过 GPU 单张纹理边长会被拆块/退回软件路径，一帧就掉到几十毫秒；
   像素预算按设备像素算，16M ≈ 64MB 一张纹理，缩放到最大也稳。低 DPR 时按原生密度画。 */
const ROLL_MAX_TEXTURE = 16384;
const ROLL_MAX_PIXELS = 16e6;

function noteName(pitch) {
  return `${NOTE_NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;
}

let rollMonoFont = "";

/* 画布取色只认 tokens.css 的谱纸一档：容器背景写的是 var(--paper)，画布再自带一套
   浅色字面量就会出现「容器一格纸、画布另一格纸」。拖动逐帧重画，所以按档缓存，
   换主题时清掉（yue2:theme）。 */
let rollColorSet = null;

function rollColors() {
  if (rollColorSet) return rollColorSet;
  const cs = getComputedStyle(document.documentElement);
  const at = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  rollColorSet = {
    bg: at("--paper", "#FBF8F0"), ink: at("--ink", "#1B1A17"),
    band: at("--roll-band", "rgba(28,110,107,.07)"),
    bandText: at("--roll-band-text", "#4E6A63"),
    line: at("--roll-line", "#C9C0AE"), lineWeak: at("--roll-line-weak", "#E5DDCC"),
    grid: at("--roll-grid", "#EAE2D1"), chord: at("--roll-chord", "#6B4A8E"),
    sel: at("--roll-sel", "#B0413E"), axisText: at("--roll-axis-text", "#7B7264"),
    tints: {Vocal: at("--roll-vocal", "#1C6E6B"), Ins: at("--roll-ins", "#8A5A16")},
  };
  return rollColorSet;
}
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
  const c = rollColors();
  ctx.setTransform(canvas.width / geom.width, 0, 0, canvas.height / geom.height, 0, 0);
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, geom.width, geom.height);

  for (const section of geom.plan.sections) {
    const first = geom.plan.bars[section.from_bar];
    const last = geom.plan.bars[section.to_bar - 1];
    if (!first || !last) continue;
    const left = rollX(geom, first.start);
    const right = rollX(geom, last.start + last.dur);
    ctx.fillStyle = c.band;
    ctx.fillRect(left, 0, right - left, ROLL_BAND);
    ctx.fillStyle = c.bandText;
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
    ctx.strokeStyle = strong ? c.line : c.lineWeak;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, geom.height);
    ctx.stroke();
  });

  for (const chord of geom.plan.voices[0].chords) {
    ctx.fillStyle = c.chord;
    ctx.font = `10px ${mono}`;
    ctx.textAlign = "left";
    ctx.fillText(chord.name, rollX(geom, chord.start) + 3, ROLL_BAND + ROLL_CHORD - 4);
  }

  for (let pitch = geom.plan.pitch_min - 1; pitch <= geom.plan.pitch_max + 1; pitch += 1) {
    if (pitch % 12 !== 0) continue;
    ctx.strokeStyle = c.grid;
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
      ctx.fillStyle = c.tints[voice.name] || c.ink;
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
        ctx.strokeStyle = c.ink;
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const picked = ui.rollSel && ui.rollSel.voice === voice.name && ui.rollSel.i === note.i;
      if (picked) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = c.sel;
        ctx.lineWidth = crisp ? 2 : 1;
        ctx.strokeRect(shown.x - 1, shown.y - 1, shown.w + 2, shown.h + 2);
        if (!note.tie && crisp) {
          ctx.fillStyle = c.sel;
          ctx.fillRect(shown.x + shown.w - 2.5, shown.y + shown.h * 0.25, 1.6, shown.h * 0.5);
        }
      }
      ctx.globalAlpha = 1;
    }
  }

  const actx = axis.getContext("2d");
  actx.setTransform(axis.width / 44, 0, 0, axis.height / geom.height, 0, 0);
  actx.clearRect(0, 0, 44, geom.height);
  actx.fillStyle = c.bg;
  actx.fillRect(0, 0, 44, geom.height);
  actx.fillStyle = c.axisText;
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
  if (!isRoll) {
    if (ui.rollError) {
      note.hidden = false;
      note.className = "note";
      note.innerHTML = `<b>${esc(T("这份谱画不成音块图，已切到文本谱"))}</b><br>${esc(ui.rollError)}` +
        `<br>${esc(T("文本谱仍可编辑；重渲染会按原文交给模型，不受方块谱校验影响。"))}`;
    } else {
      note.hidden = true;
    }
    return;
  }
  if (!plan) {
    // 音块图解析失败时别留一块空白：直接切到能看能改的文本谱。
    if (ui.scoreAbc.trim()) {
      ui.rollTabAuto = true;
      setRollTab("text", true);
      return;
    }
    note.hidden = false;
    note.className = "note";
    note.innerHTML = esc(ui.rollError || T("还没有带乐谱的完成任务 · 生成后这里会出现可点可拖的音块图"));
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
    if (ui.rollTabAuto) {
      ui.rollTabAuto = false;
      setRollTab("roll");
      return;
    }
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

function setRollTab(tab, auto = false) {
  if (!auto) ui.rollTabAuto = false;
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

/* 谱面编辑要过一趟服务端（/score/edit）。busy 时直接丢弃会吃掉快速连击
   （比如「移调 +1」连按三次只落一次），这里把操作串成链：上一条落地再执行下一条。 */
let rollOpsChain = Promise.resolve();
function applyOps(ops) {
  rollOpsChain = rollOpsChain.then(() => applyOpsNow(ops)).catch(() => {});
  return rollOpsChain;
}

async function applyOpsNow(ops) {
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
  writeJson(ROLL_ZOOM_KEY, {x: ui.rollZoomX, y: ui.rollZoomY});
}

function rollZoomLoad() {
  const z = readJson(ROLL_ZOOM_KEY, (value) => validators.object(value) &&
    (!("x" in value) || Number.isFinite(value.x)) && (!("y" in value) || Number.isFinite(value.y)), null);
  if (z && Number.isFinite(z.x)) ui.rollZoomX = clampZoom(z.x);
  if (z && Number.isFinite(z.y)) ui.rollZoomY = clampZoom(z.y);
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
  paintRules();
  $("btnCopyRules").addEventListener("click", copyRules);
  $("tabRoll").addEventListener("click", () => setRollTab("roll"));
  $("tabText").addEventListener("click", () => setRollTab("text"));
  $("btnRollFull").addEventListener("click", () => setRollFocus(!ui.rollFocus));

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (ui.rollFocus) {
      if (modalOpen() || tourIndex >= 0) return;
      event.preventDefault();
      setRollFocus(false);
      return;
    }
    // 整页播放页：Esc 收起（弹窗/教程打开时让位）
    if (!$("lyr").classList.contains("viz")) return;
    if (modalOpen() || tourIndex >= 0) return;
    event.preventDefault();
    toggleLyrics(false);
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
    if (ui.view !== "score" || ui.rollTab !== "roll" || ui.rollBusy) return;
    if (modalOpen() || tourIndex >= 0) return;
    const tag = event.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || event.target.isContentEditable) return;
    /* 撤销不要求选中音符：去掉和弦/删段这类操作没选中任何东西也要能撤。
       （文本谱 tab 的 Ctrl+Z 是编辑器自带撤销，不走这里。） */
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undoRoll();
      return;
    }
    const sel = ui.rollSel;
    if (!sel) return;
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

  $("btnSecDrop").addEventListener("click", () => {
    const section = ui.rollPlan?.sections[Number($("rollSection").value || 0)];
    if (!section) return;
    /* 确认策略统一（2026-11-13 定案 A）：轻编辑直接改，Ctrl+Z + 离开时询问写回
       兜底；只有「恢复原谱」（丢弃全部改动）保留确认框。 */
    applyOps([{kind: "drop_section", section: Number($("rollSection").value || 0)}]);
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
    /* 内存草稿清了，本地草稿也要一起清：不然刷新后 localStorage 会把
       刚丢弃的改动又塞回编辑器（「恢复原谱」名不副实）。 */
    localDraftSave(ui.scoreJob, undefined);
    setScoreText(ui.scoreOriginal);
    await refreshRoll();
    toast(T("已恢复原谱"), "ok");
  });

  document.addEventListener("yue2:lang", () => {
    paintRules();
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
    const report = await post("/api/score/compare", {before: ui.scoreOriginal, after: ui.scoreAbc, allow_tempo_change: true});
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
  $("btnStrip").disabled = true;
  try {
    const data = await post("/api/score/strip-chords", {abc: ui.scoreAbc});
    ui.rollUndo.push(ui.scoreAbc);
    if (ui.rollUndo.length > 40) ui.rollUndo.shift();
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
  $("btnInstr").disabled = true;
  try {
    const data = await post("/api/score/instrumentalize", {abc: ui.scoreAbc});
    ui.rollUndo.push(ui.scoreAbc);
    if (ui.rollUndo.length > 40) ui.rollUndo.shift();
    setScoreText(data.abc);
    toolNote(esc(T("已转成纯音乐谱，重渲染后是器乐版")), "ok");
  } catch (exc) {
    toolNote(esc(message(exc)), "bad");
  } finally {
    $("btnInstr").disabled = false;
  }
}

/* 按谱重渲染：把改好的谱面与主页编辑的风格、歌词交给模型，整曲重新渲染（约 10 分钟）。 */
async function generateRerender() {
  if (!ui.scoreAbc.trim()) return toast(T("谱面是空的"), "bad");
  const jobId = ui.scoreJob;
  const cached = state.byId.get(jobId) || state.jobs.find((item) => item.id === jobId);
  $("btnRerender").disabled = true;
  try {
    await refreshRoll(true);
    if (ui.rollError) {
      const ok = await confirmDialog({
        title: T("方块谱校验未通过"),
        body: T("编辑器无法校验这份谱：{0}", ui.rollError),
        note: T("仍可重渲染：官方生成链路不调用这个校验器，会直接把原文交给模型；但排版问题可能让旋律或和弦走样。"),
        ok: T("仍然重渲染"),
        cancel: T("返回修改"),
      });
      if (!ok) return;
    }
    // 列表行只带歌词摘要，重渲染要把主页当前风格和全文歌词交给校验与模型
    const job = cached?.requested?.lyrics !== undefined ? cached : await loadJob(jobId);
    const request = job?.requested || {};
    const payload = {
      type: "rerender", source: jobId,
      style: $("fStyle").value.trim() || request.style || "",
      lyrics: $("fLyrics").value.trim() || request.lyrics || "",
      abc: ui.scoreAbc,
      cot: ui.cot || request.cot || "full",
      device: submitDevice(),
      ode_steps: job?.ode_steps ?? undefined,
    };
    /* 重渲染成功先写回原任务 score.abc（服务端留备份），再排队。
       普通写回失败仍可排队；版本冲突必须停下，避免拿未知版本继续重渲染。 */
    let writeBack = null;
    try {
      writeBack = await put(`/api/jobs/${encodeURIComponent(jobId)}/score`, {
        abc: ui.scoreAbc, expected_sha256: ui.scoreHash,
      });
    } catch (exc) {
      if (exc instanceof ApiError && (exc.status === 409 || exc.status === 428)) {
        toast(T("乐谱已在另一个页面被修改，当前页面没有覆盖它；请刷新后再重渲染"), "bad");
        return;
      }
      toast(T("改版谱面写回原任务失败（{0}），仍可排队但切回会看见旧谱", message(exc)), "warn");
    }
    await createJob(payload);
    scoreDrafts.delete(jobId);
    localDraftSave(jobId, undefined);
    if (writeBack && writeBack.status === "saved") {
      ui.scoreOriginal = ui.scoreAbc;
      ui.scoreHash = writeBack.sha256 || ui.scoreHash;
      toast(T("重渲染已排队，改版谱已写回原任务（原谱已备份）"), "ok");
    } else {
      ui.scoreOriginal = ui.scoreAbc;
      ui.scoreHash = writeBack?.sha256 || ui.scoreHash;
      toast(T("重渲染已排队，乐谱谱系已挂到原始任务"), "ok");
    }
    refreshScoreStateNote();
    go("studio");
  } catch (exc) {
    toast(message(exc), "bad");
  } finally {
    $("btnRerender").disabled = false;
  }
}

/* 乐谱 → 创作页桥：把当前任务的风格/歌词/BPM 原样带回表单，谱面继续跟着这份任务。
   复用 reuseParams 的全量回填（风格/歌词/种子/模式/高级参数/设备），只多三件事：
   (1) 不弹覆盖确认——用户本意就是「回去改」，按钮语义已经足够明确；
   (2) 谱有改动还没保存就自动勾上「用这份谱面生成」，不必再回来点一次；
   (3) 完成后焦点落在歌词输入框，改完直接点「生成歌曲」即可。 */
async function returnScoreToStudio() {
  const jobId = ui.scoreJob;
  if (!jobId) return;
  const cached = state.byId.get(jobId) || state.jobs.find((item) => item.id === jobId);
  const btn = $("btnToStudio");
  btn.disabled = true;
  try {
    const job = cached?.requested?.lyrics !== undefined ? cached : await loadJob(jobId);
    if (!job) return toast(T("找不到这首任务"), "bad");
    const ok = await reuseParams(job, {skipConfirm: true});
    if (!ok) return;
    const edited = ui.scoreAbc !== ui.scoreOriginal && ui.scoreAbc.trim();
    if (edited) ui.useScore = true;
    paintStudioScore();
    saveDraft();
    $("fLyrics").focus({preventScroll: false});
    toast(T(edited ? "已带回创作页：这份谱有改动，已勾上「用这份谱面生成」，改完词点「生成歌曲」就按它重渲染"
                   : "已带回创作页：要用这份谱生成，勾上「用这份谱面生成」；不勾就是新歌"), "ok");
  } catch (exc) {
    toast(message(exc), "bad");
  } finally {
    btn.disabled = false;
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
  renderUpdate();
}

/* 后端的 capability.reason 是按中文界面拼接的动态串（含实时算力数值），词典整句命中不了；
   EN 下按已知模式取数字重组，未识别的原样保留。 */
const REASON_EN = [
  [/^FlashAttention-2 可用（算力 ([\d.]+)）$/, (m) => T("FlashAttention-2 可用（算力 {0}）", m[1])],
  [/^未安装 flash_attn（算力 ([\d.]+)），开启后改用 K\/V 扩展走融合 SDPA 内核$/,
    (m) => T("flash_attn 未安装（算力 {0}）——开启后改用 K/V 扩展融合 SDPA 内核", m[1])],
  [/^算力 ([\d.]+) 不支持 FlashAttention-2（需 8\.0\+），开启后改用 K\/V 扩展走融合 SDPA 内核$/,
    (m) => T("算力 {0} 不支持 FlashAttention-2（需 8.0+）——开启后改用 K/V 扩展融合 SDPA 内核", m[1])],
  [/^无法读取显卡算力，开启后由运行期探测决定内核$/,
    () => T("无法读取显卡算力——开启后由运行期探测决定内核")],
  [/^开启后由 cuDNN 自测决定，跑不赢基准就自动退回$/,
    () => T("开启后由 cuDNN 自测决定——跑不赢基准就自动退回")],
  [/^未检测到 NVIDIA GPU，开启后仍按基准路径运行$/,
    () => T("未检测到 NVIDIA GPU——开启后仍按基准路径运行")],
  [/^未检测到 NVIDIA GPU，音频合成阶段无可加速内核$/,
    () => T("未检测到 NVIDIA GPU——音频合成阶段没有可加速的内核")],
];

function accelReason(cap) {
  const reason = cap?.reason || "";
  if (getLang() !== "en") return reason;
  for (const [pattern, make] of REASON_EN) {
    const match = pattern.exec(reason);
    if (match) return make(match);
  }
  return reason;
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
        <span class="state ${kind}">${cap ? esc(accelReason(cap)) : esc(T("本机信息未加载"))}</span>
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

function renderUpdateStatus(status) {
  if (!status) return "";
  const phase = status.phase || "";
  if (phase === "done" && status.ok) {
    return `<div class="note ok">${esc(T("更新完成"))} · ${esc(T("已更新到 {0}", status.version || ""))}</div>`;
  }
  if (phase === "done" && status.rolled_back) {
    return `<div class="note bad">${esc(T("新版本无法启动，已自动回滚到更新前版本。"))}</div>`;
  }
  if (phase === "failed") {
    return `<div class="note bad">${esc(T("更新失败"))}${status.error ? "：" + esc(status.error) : ""}</div>`;
  }
  const labels = {stopping: "正在停止服务", backup: "正在备份", apply: "正在写入新代码",
                  restart: "正在重启服务", health: "正在探活", applying: "正在安装更新"};
  const label = labels[phase] || phase;
  return `<div class="note">${esc(T(label))}…</div>`;
}

function renderUpdate() {
  const box = $("updBody");
  if (!box) return;
  const u = state.update;
  const dot = $("updDot");
  if (dot) dot.hidden = !u.has_update;
  const versionLine = `<div class="sub" style="margin:0">${esc(T("当前版本"))} ` +
    `<span class="mono" data-notr>${esc(u.current || "—")}</span>` +
    (u.commit ? ` · <span class="mono" data-notr>${esc(String(u.commit).slice(0, 7))}</span>` : "") +
    ` · ${esc(u.channel || "stable")}</div>`;
  const banner = (u.has_update && !u.applying)
    ? `<div class="note" style="margin-bottom:var(--sp3)"><b>${esc(T("有新版本可用：{0}", u.latest))}</b></div>`
    : "";
  let body = "";
  if (u.checking) {
    body = `<div class="hint">${esc(T("正在检查更新…"))}</div>`;
  } else if (u.applying) {
    body = `<div class="note">${esc(T("正在安装更新，服务将自动重启，请稍候…"))}</div>`;
  } else if (u.downloading) {
    body = `<div class="note">${esc(T("正在下载更新包…"))}</div>`;
  } else if (u.status && u.status.phase && u.status.phase !== "idle") {
    body = renderUpdateStatus(u.status);
  } else if (u.error) {
    body = `<div class="note bad">${esc(T("更新出错：{0}", u.error))}</div>`;
  } else if (u.blocked) {
    body = `<div class="note bad"><b>${esc(T("无法直接升级"))}</b><br>` +
      `${esc(u.reason || T("当前版本过低，请下载完整整合包覆盖安装"))}</div>`;
  } else if (!u.checked) {
    body = `<div class="hint">${esc(T("点「检查更新」查看是否有新版本。只更新代码，不动模型、权重与依赖环境。"))}</div>`;
  } else if (u.has_update) {
    body = (u.changelog ? `<div class="hint" style="margin-bottom:var(--sp3)">${esc(u.changelog)}</div>` : "") +
      `<div class="inline" style="flex-wrap:wrap">` +
      (u.downloaded
        ? `<button class="btn primary" id="btnApplyUpdate" type="button">${esc(T("立即安装并重启"))}</button>`
        : `<button class="btn primary" id="btnDownloadUpdate" type="button">${esc(T("下载更新"))}</button>`) +
      `<button class="btn ghost" id="btnRecheckUpdate" type="button">${esc(T("重新检查"))}</button>` +
      `</div>`;
  } else {
    body = `<div class="hint">${esc(T("已是最新版本。"))}</div>`;
  }
  box.innerHTML = versionLine + banner + body;
  const dl = $("btnDownloadUpdate");
  if (dl) dl.addEventListener("click", () => { downloadUpdate(); });
  const ap = $("btnApplyUpdate");
  if (ap) ap.addEventListener("click", async () => {
    if (!await confirmDialog({
      title: T("安装更新"),
      body: esc(T("安装会重启服务，期间正在生成的任务会被中断。确定继续吗？")),
      ok: T("安装"), cancel: T("取消"), danger: true,
    })) return;
    const port = Number(window.location.port) || 9090;
    await applyUpdate(port);
  });
  const rc = $("btnRecheckUpdate");
  if (rc) rc.addEventListener("click", () => { checkUpdate(); });
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
const VOL_KEY = "volume";

function readVolume() {
  return readNumber(VOL_KEY, (value) => Number.isInteger(value) && value >= 0 && value <= 100, 90);
}

function paintTrackMeta() {
  const id = ui.track;
  const job = id ? state.byId.get(id) : null;
  $("tName").textContent = id ? (job ? displayName(job) : id) : T("未选择曲目");
  $("tSub").textContent = id ? `${id}${job?.duration ? ` · ${fmtClock(job.duration)} · 48kHz` : ""}` : "—";
  $("dlBtn").disabled = !id || !hasAudio(job);
  refreshSkip();
}

function loadTrack(id) {
  ui.track = id;
  $("lyr").hidden = false; // 播放时才显示歌词区
  playPref.set({id, time: 0});
  player.src = audioUrl(id);
  player.load();
  paintTrackMeta();
  $("ppBtn").disabled = false;
  paintWave(0);
  setLyricsFor(id);
  paintWaveFromAudio(id);
  if (ui.view === "library") renderLibrary();
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
  closeLyrViz();
  syncVizData();
  $("lyr").hidden = true; // 无曲目时隐藏歌词区
  paintWave(0);
}

/* 上一首 / 下一首：在已完成且有音频的任务里按时间倒序循环 */
function playables() {
  return state.jobs.filter((job) => hasAudio(job));
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
  /* 没选曲目时不画示意波形：一条平底灰线，明确是"空"，不像坏掉的数据 */
  const bars = ui.track ? (waveCache.get(ui.track) || fallbackBars()) : null;
  $("wave").classList.toggle("empty", !bars);
  const list = bars || Array(WAVE_BARS).fill(8);
  const played = Math.round((ratio || 0) * list.length);
  $("wave").innerHTML = list.map((height, index) => {
    const level = height >= 82 ? "h" : height >= 58 ? "m" : "";
    return `<i class="${index < played ? `f${level ? ` ${level}` : ""}` : ""}" style="height:${height}%"></i>`;
  }).join("");
  paintCardProgress(ratio, played);
}

/* 曲库卡片波形同步播放进度：当前曲目的已播部分点亮，与底部播放条同源 */
function paintCardProgress(ratio, playedHint) {
  if (ui.view !== "library" || !ui.track) return;
  const node = document.querySelector(`.twave[data-wave="${CSS.escape(ui.track)}"]`);
  if (!node) return;
  const bars = node.querySelectorAll("i");
  const played = playedHint ?? Math.round((ratio || 0) * bars.length);
  bars.forEach((bar, index) => bar.classList.toggle("p", index < played));
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
  $("lyrTag").hidden = true;
  closeLyrViz(); // 没有时间轴就退出整页播放页，可视化跟着清空
  syncVizData();
}

/* 对齐引擎露出来：用的是逐字时间戳还是兜底，命中率低于 60% 就标一句估算。
   后端 lyrics.json 里的 engine/confidence 一直有，只是界面从没显示过。 */
const LYRIC_ESTIMATE_FLOOR = 0.6;

function paintLyricTag(data) {
  const tag = $("lyrTag");
  if (!data?.engine) { tag.hidden = true; return; }
  const name = String(data.engine);
  const short = name.includes("窗口") ? T("Paraformer 分窗")
    : /whisper/i.test(name) ? T("Whisper 兜底") : T("Paraformer 逐字");
  const ratio = Number(data.confidence);
  const pct = Number.isFinite(ratio) ? Math.round(ratio * 100) : null;
  const loose = Number.isFinite(ratio) && ratio < LYRIC_ESTIMATE_FLOOR;
  tag.innerHTML = esc(short) + (loose ? `<em>${esc(T("含估算"))}</em>` : "");
  tag.title = pct === null ? name
    : `${name}（${T("实测命中")} ${pct}%）` +
      (loose ? T("：没命中的字按前后锚点推算") : "");
  tag.hidden = false;
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

/* 展示层去标点：仅改写显示文本，不动服务端对齐数据。
   句首/句尾标点删除；句中分句标点换成两个不间断空格保留停顿（HTML 会折叠普通空格，故用 ）。
   夹在两个字母/数字之间的标点换成单个空格，避免英文单词粘连。 */
function stripLyricPunct(text) {
  const GAP = "  ";
  return String(text || "")
    .replace(/([A-Za-z0-9])\p{P}+(?=[A-Za-z0-9])/gu, "$1 ")
    .replace(/\s*\p{P}+\s*/gu, (m, off, s) => (off === 0 || off + m.length === s.length) ? "" : GAP)
    .replace(/ {2,}/g, " ")
    .trim();
}
function cleanLyrics(data) {
  if (!Array.isArray(data?.lines)) return data;
  return {...data, lines: data.lines.map((l) => ({
    ...l,
    text: stripLyricPunct(l.text),
    units: (l.units || []).map((u) => ({...u, text: stripLyricPunct(u.text)})).filter((u) => u.text),
  }))};
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

/* ---- 歌词可视化（沉浸播放）：懒加载 visualizer.js，默认零开销；
      加载失败时静默退回普通歌词列表，不影响歌词区任何现有功能 ---- */
let vizMod = null; // Promise<LyricViz|null>，null 表示尚未尝试加载
function trackTitle(id) {
  const job = id ? state.byId.get(id) : null;
  return job ? displayName(job) : "";
}
function loadViz() {
  if (!vizMod) {
    vizMod = import("./visualizer.js").then((m) => {
      m.LyricViz.mount($("lyrViz"), player);
      m.LyricViz.setLines(ui.lyrics?.lines || []);
      m.LyricViz.setTrack(ui.track, trackTitle(ui.track));
      window.__lyrViz = m.LyricViz; // 诊断/测试句柄
      return m.LyricViz;
    }).catch((exc) => {
      console.warn("歌词可视化加载失败，退回歌词列表", exc);
      return null;
    });
  }
  return vizMod;
}
function syncVizData() { // 换曲 / 歌词更新后推送最新数据
  if (!vizMod) return;
  vizMod.then((v) => {
    if (!v) return;
    v.setLines(ui.lyrics?.lines || []);
    v.setTrack(ui.track, trackTitle(ui.track));
  });
}
/* ---- 播放会话持久化：刷新后恢复曲目 / 进度 / 播放页展开态 ---- */
const PLAY_KEY = "playback";
const AB_KEY = "ab"; // A/B 对比配对：刷新后恢复，失效 id 由 jobs 加载后的过滤兜底
let restoreOpen = false; // 刷新前播放页是展开的：等歌词到位后自动重开
let lastPlaySave = 0;
function saveAb() {
  writeJson(AB_KEY, ui.ab);
}
/* 启动恢复上次的 A/B 配对；失效 id 由加载任务后的过滤与 applyAB 的校验兜底 */
ui.ab = readJson(AB_KEY, validators.stringArray, []).filter((id) => typeof id === "string" && id);
const playPref = {
  get() {
    return readJson(PLAY_KEY, (value) => validators.object(value) &&
      (value.id === undefined || typeof value.id === "string") &&
      (value.time === undefined || Number.isFinite(value.time)) &&
      (value.open === undefined || typeof value.open === "boolean"), null);
  },
  set(patch) {
    writeJson(PLAY_KEY, {...(playPref.get() || {}), ...patch});
  },
};
function savePlayTime() {
  if (ui.track && Number.isFinite(player.currentTime)) playPref.set({id: ui.track, time: player.currentTime});
}
function restorePlayback() { // 启动时恢复上次播放（不自动出声：恢复为暂停态）
  const saved = playPref.get();
  if (!saved?.id) return;
  loadTrack(saved.id);
  const t = Number(saved.time);
  if (Number.isFinite(t) && t > 0) {
    player.addEventListener("loadedmetadata", () => {
      player.currentTime = Math.min(t, player.duration || t);
      renderLyrics(true);
    }, {once: true});
  }
  if (saved.open && ui.lyrics) setLyrView();
  else restoreOpen = !!saved.open;
}
async function setLyrView() { // 展开即整页播放页（默认黑胶，模式在页内切换并记忆）
  const bar = $("lyr");
  bar.classList.add("viz", "open");          // open 类与 toggleLyrics 状态机保持一致
  $("lyrOpen").hidden = false;
  $("lyrTg").setAttribute("aria-expanded", "true");
  const v = await loadViz();
  if (!v) { // 加载失败退回歌词条
    bar.classList.remove("viz", "open");
    $("lyrOpen").hidden = true;
    playPref.set({open: false});
    return;
  }
  v.setOpen(true);
  playPref.set({open: true}); // 恢复窗口期的竞态会把 open 写成 false，这里归位
}
function closeLyrViz() { // 收起整页播放页
  const bar = $("lyr");
  bar.classList.remove("viz", "open");
  $("lyrOpen").hidden = true;
  $("lyrTg").setAttribute("aria-expanded", "false");
  if (vizMod) vizMod.then((v) => v && v.setOpen(false));
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
  $("lyrOpen").hidden = true; // 展开一律走整页播放页，条内不再内嵌列表
  playPref.set({open});
  if (open) {
    if (!ui.lyrics) {
      bar.classList.remove("open");
      $("lyrOpen").hidden = true;
      $("lyrTg").setAttribute("aria-expanded", "false");
      toast(T("这首歌还没有可用的歌词时间轴"), "info");
      return;
    }
    paintLyricList(ui.lyricLine);
    setLyrView();
  } else {
    closeLyrViz();
  }
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
    data = cleanLyrics(data);
    lyricsCache.set(id, data);
    ui.lyrics = data;
    $("lyrRetry").hidden = true;
    paintLyricTag(data);
    renderLyrics(true);
    syncVizData();
    if (restoreOpen) { restoreOpen = false; setLyrView(); }
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
    paintLyricTag(cached);
    renderLyrics(true);
    syncVizData();
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
  $("genconsole").addEventListener("click", (event) => {
    const button = event.target.closest("[data-act]");
    const view = button && consoleModel();
    if (view) onJobAction(button.dataset.act, view.job.id);
  });
  $("gcFold").addEventListener("click", () => {
    const view = consoleModel();
    if (!view) return;
    ui.foldedJob = ui.foldedJob === view.job.id ? null : view.job.id;
    paintConsole(view);
  });
  const jumpToConsole = () => {
    if ($("mstat").classList.contains("link")) focusConsole();
  };
  $("mstat").addEventListener("click", jumpToConsole);
  $("mstat").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    jumpToConsole();
  });
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[data-dl]");
    if (link) toast(T("已开始下载：{0}", link.getAttribute("download") || ""), "info", 3200);
    if (!event.target.closest?.("#lyrSub")) $("lyrSub").open = false;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !$("lyrSub").open) return;
    $("lyrSub").open = false;
    $("lyrSub").querySelector("summary")?.focus();
  });
  $("libGrid").addEventListener("click", async (event) => {
    if (event.target.closest(".trename")) return;
    const subItem = event.target.closest("[data-sub]");
    const subCard = subItem?.closest("[data-subcard]");
    if (subCard) {
      event.preventDefault();
      event.stopPropagation();
      // 失败时菜单保持展开：原因 toast 还在，用户可以直接换个格式重试
      if (!await downloadSubtitle(subItem.dataset.sub, subCard.dataset.subcard,
        subItem.dataset.word === "1", subItem)) return;
      ui.subOpen.delete(subCard.dataset.subcard);
      subCard.open = false;
      subCard.querySelector("summary")?.focus();
      return;
    }
    if (event.target.closest("[data-subcard]")) return; // 展开/收起交给原生 details，不触发 A/B 选择
    const play = event.target.closest("[data-lplay]");
    if (play) {
      event.stopPropagation();
      // 正在播这首就暂停，否则从头（或 A/B 保留位置）播放——与底部播放条同状态
      if (ui.track === play.dataset.lplay && !player.paused && !player.ended) player.pause();
      else playJob(play.dataset.lplay);
      return;
    }
    const render = event.target.closest("[data-render]");
    if (render) {
      event.stopPropagation();
      renderPlanJob(render.dataset.render);
      return;
    }
    const score = event.target.closest("[data-score]");
    if (score) {
      event.stopPropagation();
      selectScoreJob(score.dataset.score);
      go("score");
      return;
    }
    const again = event.target.closest("[data-again]");
    if (again) {
      event.stopPropagation();
      const job = state.byId.get(again.dataset.again);
      if (job) reuseParams(job, {fresh: true}).catch((exc) => toast(message(exc), "bad"));
      return;
    }
    const del = event.target.closest("[data-del]");
    if (del) {
      event.stopPropagation();
      removeJob(del.dataset.del).catch((exc) => toast(message(exc), "bad"));
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
    if (event.target.closest("a[data-dl]")) return; // 原生下载：不切 A/B，交给 document 级下载提示
    const card = event.target.closest("[data-lib]");
    if (!card) return;
    const id = card.dataset.lib;
    const job = state.byId.get(id);
    if (!job || job.status !== "complete" || !hasAudio(job)) {
      // 失败/取消或没有音频的任务不进 A/B，点卡片直接看详情
      openJobFromCard(id);
      return;
    }
    if (ui.ab.includes(id)) ui.ab = ui.ab.filter((item) => item !== id);
    else {
      ui.ab = [...ui.ab.slice(-1), id];
      if (ui.ab.length === 1) toast(T("已选入 A/B 对比（1/2）· 再点一条开始盲听"), "info", 2400);
    }
    saveAb();
    renderLibrary();
  });
  $("libGrid").addEventListener("dblclick", (event) => {
    if (event.target.closest("[data-subcard]")) return;
    const title = event.target.closest("[data-title]");
    if (title) {
      event.stopPropagation();
      startRename(title.closest("[data-lib]"), title);
      return;
    }
    const card = event.target.closest("[data-lib]");
    if (card && hasAudio(state.byId.get(card.dataset.lib))) playJob(card.dataset.lib);
  });
  $("libGrid").addEventListener("toggle", (event) => {
    const wrap = event.target.closest?.("[data-subcard]");
    if (!wrap) return;
    if (wrap.open) ui.subOpen.add(wrap.dataset.subcard);
    else ui.subOpen.delete(wrap.dataset.subcard);
  }, true);
  $("libGrid").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target instanceof Element && event.target.matches('[role="button"]')) {
      event.preventDefault();
      event.target.click();
    }
  });
  qa(".nav").forEach((button) => button.addEventListener("click", async () => {
    await leaveScoreGuard(button.dataset.view);
    go(button.dataset.view);
  }));
  /* 连点语言/主题会把「全量 trDom + renderAll / 全画布重绘」排成串行重活，
     曾把界面冻住 30 秒以上。150ms 尾部去抖：连点只落最后一次。 */
  const switchLangSoon = debounce(() => {
    applyLang(getLang() === "zh" ? "en" : "zh");
    renderAll();
  }, 150);
  const switchThemeSoon = debounce(toggleTheme, 150);
  $("btnTheme").addEventListener("click", switchThemeSoon);
  $("btnKeys").addEventListener("click", () => openModal($("keysModal")));
  $("keysX").addEventListener("click", () => closeModal($("keysModal")));
  qa("[data-close]", $("logModal")).forEach((button) => button.addEventListener("click", () => closeModal($("logModal"))));
  $("logModal").addEventListener("modal:close", resetLogState);
  $("logReveal").addEventListener("click", () => { if (ui.logJob) revealJob(ui.logJob); });
  $("logBox").addEventListener("scroll", () => {
    if ($("logBox").scrollTop <= 0) loadOlderLog();
  });
  $("btnLoad").addEventListener("click", onLoadButton);
  $("btnLang").addEventListener("click", switchLangSoon);
  $("btnDevice").addEventListener("click", () => {
    onDevice(currentDevice() === "cuda" ? "cpu" : "cuda");
  });

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
  const autoLint = debounce(() => {
    if ($("fLyrics").value.trim()) lintLyrics({quiet: true});
    else $("lintNote").hidden = true;
  }, 700);
  $("fLyrics").addEventListener("input", autoLint);
  $("btnDice").addEventListener("click", () => {
    $("fSeed").value = String(Math.floor(Math.random() * 1e9));
  });
  $("fVar").addEventListener("change", renderCost);
  $("fSeed").addEventListener("change", renderCost);
  $("fSongName").addEventListener("input", saveDraftSoon);
  $("queueToggle").addEventListener("click", () => {
    const open = !$("queue").hidden;
    writeText(QUEUE_FOLD_KEY, open ? "closed" : "open");
    paintQueueFold();
  });
  /* 文本谱面折叠偏好 + 生成中出了新谱自动展开一次，不让卖点藏在折叠里 */
  const scoreSec = $("studioScoreSec");
  scoreSec.open = readText("scoreSec", (value) => value === "open" || value === "closed", "") === "open";
  scoreSec.addEventListener("toggle", () => {
    writeText("scoreSec", scoreSec.open ? "open" : "closed");
  });

  const acc = $("accAdv");
  q(".t", acc).addEventListener("click", () => {
    const open = acc.classList.toggle("open");
    q(".t", acc).setAttribute("aria-expanded", String(open));
  });
  const applyCfg = (value) => {
    ui.cfg = value;
    $("sCfg").value = String(value);
    paintRange($("sCfg"));
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
    paintRange($("sOde"));
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
  const toggleCost = () => {
    const open = $("cost").classList.toggle("open");
    $("costBrk").setAttribute("aria-expanded", String(open));
  };
  $("costBrk").addEventListener("click", toggleCost);
  $("costBrk").addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleCost();
    }
  });
  $("btnGen").addEventListener("click", generate);
  $("btnPlan").addEventListener("click", generatePlan);
  $("studioScoreSource").addEventListener("change", async () => {
    selectScoreJob($("studioScoreSource").value);
    await renderStudioScore();
    await copyRequestToForm(ui.scoreJob);
    toast(T("谱面与风格、歌词已换成所选任务 · 要按这份谱生成就勾上「用这份谱面生成」"), "ok");
  });
  $("studioScore").addEventListener("input", () => {
    ui.scoreAbc = $("studioScore").value;
    scoreEdited();
    scheduleAbcPaint();
    scheduleRoll();
    paintStudioScore();
  });
  $("studioUseScore").addEventListener("click", () => {
    if ($("studioUseScore").disabled) return;
    ui.useScore = !ui.useScore;
    paintStudioScore();
    saveDraftSoon();
  });
  $("btnLoadSelectedScore").addEventListener("click", async () => {
    await loadScoreText(ui.scoreJob, {force: true});
    paintStudioScore();
    paintAbc();
    await copyRequestToForm(ui.scoreJob);
  });
  $("btnSaveStudioDraft").addEventListener("click", () => {
    saveDraft();
    toast(T("主页草稿已保存"), "ok");
  });
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
    /* reuseParams 自带「参数已回填」成功提示，这里不再叠一条。 */
    reuseParams(job);
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
  /* 「下载走当前版」的兜底：草稿没写回服务端时，直链拿到的是磁盘旧版，
     这里改成把编辑器当前内容打成 Blob 下载；与原谱一致才走服务端直链。 */
  $("btnAbcDl").addEventListener("click", (event) => {
    if (!ui.scoreAbc.trim() || ui.scoreAbc === ui.scoreOriginal) return;
    event.preventDefault();
    const blob = new Blob([ui.scoreAbc], {type: "text/plain;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement("a"), {href: url, download: "score.abc"});
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $("btnCompare").addEventListener("click", compareScore);
  $("btnStrip").addEventListener("click", stripScoreChords);
  $("btnInstr").addEventListener("click", instrumentalizeScore);
  $("btnRerender").addEventListener("click", generateRerender);
  $("btnToStudio").addEventListener("click", returnScoreToStudio);
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
    writeText(SORT_KEY, ui.sort);
    renderLibrary();
  });
  let reloadingJobs = false;
  $("btnReload").addEventListener("click", async () => {
    /* loadJobs+renderLibrary 是重活（重建卡片+波形解码），在途时忽略连点，
       不叠加：连点刷新曾把主线程塞死 30 秒以上。 */
    if (reloadingJobs) return;
    reloadingJobs = true;
    $("btnReload").disabled = true;
    try {
      await loadJobs();
      renderLibrary();
      toast(T("已刷新"), "ok");
    } finally {
      reloadingJobs = false;
      $("btnReload").disabled = false;
    }
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
    scoreEdited();
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
  $("btnCheckUpdate").addEventListener("click", async () => {
    $("btnCheckUpdate").disabled = true;
    try {
      await checkUpdate();
    } catch (exc) {
      toast(message(exc), "bad");
    } finally {
      $("btnCheckUpdate").disabled = false;
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
  $("lyrSub").addEventListener("click", (event) => {
    const item = event.target.closest("[data-sub]");
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    const menu = $("lyrSub");
    menu.open = false;
    menu.querySelector("summary")?.focus();
    downloadSubtitle(item.dataset.sub, ui.track, item.dataset.word === "1", item);
  });
  $("lvClose").addEventListener("click", () => toggleLyrics(false));
  player.addEventListener("error", () => { // 上次播放的曲目已不存在：放弃恢复
    if (!ui.track || state.byId.get(ui.track)) return;
    removeRaw(PLAY_KEY);
    clearTrack();
    toast(T("上次播放的曲目已不存在，已停止恢复"), "warn");
  });
  window.addEventListener("pagehide", savePlayTime);
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
    writeNumber(VOL_KEY, value);
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

  /* 鼠标/触摸 seek：点哪跳哪，按住拖动跟随（界面巡览承诺的「点波形跳转」）。
     键盘路径在上面，这里补上指针路径；拖动期间 timeupdate 会持续刷新波形与歌词。 */
  const waveTrack = $("wave");
  const seekToPointer = (event) => {
    if (!Number.isFinite(player.duration) || player.duration <= 0) return;
    const rect = waveTrack.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    player.currentTime = ratio * player.duration;
    renderLyrics(true);
  };
  waveTrack.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    seekToPointer(event);
    try { waveTrack.setPointerCapture(event.pointerId); } catch { /* 老内核不支持捕获就只支持点击 */ }
  });
  waveTrack.addEventListener("pointermove", (event) => {
    if (event.buttons & 1) seekToPointer(event);
  });

  player.addEventListener("play", () => {
    $("ppIcon").innerHTML = '<path d="M4.5 2.5h2.6v11H4.5zM8.9 2.5h2.6v11H8.9z"/>';
    $("ppBtn").setAttribute("aria-label", T("暂停"));
    if (ui.view === "library") renderLibrary();
  });
  player.addEventListener("pause", () => {
    savePlayTime();
    $("ppIcon").innerHTML = '<path d="M4 2l10 6-10 6z"/>';
    $("ppBtn").setAttribute("aria-label", T("播放"));
    if (ui.view === "library") renderLibrary();
  });
  player.addEventListener("ended", () => {
    paintWave(0);
    $("tCur").textContent = fmtClock(0);
  });
  player.addEventListener("seeked", () => { savePlayTime(); renderLyrics(true); });
  player.addEventListener("timeupdate", () => {
    const ratio = player.duration ? player.currentTime / player.duration : 0;
    $("tCur").textContent = fmtClock(player.currentTime);
    $("tDur").textContent = fmtClock(player.duration || 0);
    $("wave").setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    /* 读屏用户听到的不该是光秃秃的百分比：带上时间文本 */
    $("wave").setAttribute("aria-valuetext",
      `${fmtClock(player.currentTime || 0)} / ${fmtClock(player.duration || 0)}`);
    paintWave(ratio);
    const nowMs = Date.now();
    if (nowMs - lastPlaySave > 3000) { lastPlaySave = nowMs; savePlayTime(); }
    renderLyrics(false);
  });
  player.addEventListener("error", () => {
    if (!player.src) return;
    toast(T("音频加载失败 · 产物可能还没写出"), "bad");
  });
  $("volR").value = String(readVolume());
  paintRange($("volR"));
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
    /* 整页播放页展开时，数字键专属于播放页形态切换（visualizer.js 处理） */
    if (Number.isInteger(digit) && $("lyr").classList.contains("viz")) return;
    if (Number.isInteger(digit) && digit >= 1 && digit <= VIEWS.length) {
      leaveScoreGuard(VIEWS[digit - 1]).then(() => go(VIEWS[digit - 1]));
      return;
    }
    /* 焦点在按钮/链接上时空格是"激活它"，别再抢去当播放开关 */
    const onControl = !!event.target.closest?.("button, a, summary, [role=button]");
    if (event.key === " " && !onControl) {
      event.preventDefault();
      togglePlay();
    } else if (event.key === "t" || event.key === "T") switchThemeSoon();
    else if (event.key === "l" || event.key === "L") switchLangSoon();
    else if (event.key === "?") openModal($("keysModal"));
  });

  document.addEventListener("yue2:theme", () => {
    // 画布颜色取一次存着用，换深浅档后要重取并重画，否则会停在旧档的色值上
    rollColorSet = null;
    rollDraw();
  });

  document.addEventListener("yue2:lang", () => {
    paintTitle();
    if (state.presets && state.presets.length) {
      const current = $("fPreset").value;
      $("fPreset").innerHTML = state.presets.map((preset) =>
        `<option value="${esc(preset.id)}">${esc(T(preset.name))}</option>`).join("");
      $("fPreset").value = current;
    }
    /* lintNote 是 lint 时动态渲染的，不在 trDom 快照里；切语言重跑一次让它跟着换语言 */
    if ($("fLyrics") && $("fLyrics").value.trim()) lintLyrics({quiet: true});
    else if ($("lintNote")) $("lintNote").hidden = true;
    renderAdvanced();
    renderAll();
    paintTrackMeta();
    paintWave(player.duration ? player.currentTime / player.duration : 0);
    toggleLyrics($("lyr").classList.contains("open"));
    if (ui.lyrics) renderLyrics(true);
    else lyricMessage(ui.lyricNote);
    if (tourIndex >= 0) showTourStep();
    refreshLiveSurfaces({full: true});
  });
}

/* ------------------------------------------------------------------ 数据订阅 */
let celebratedAt = -1;  // -1：首次加载只做基线，不弹提示
/* 取消后的自动卸载：被取消的任务落到 cancelled 且没有别的任务在跑/排队时，
   把模型卸载释放内存与显存。取消时若模型还在加载，等加载完成的 model 事件再卸；
   期间用户又派了新活（有任务在跑）则视为单任务意图，放弃卸载。 */
let autoUnloadAfterCancel = null;
async function maybeAutoUnload() {
  if (!autoUnloadAfterCancel) return;
  const job = state.byId.get(autoUnloadAfterCancel);
  if (job && job.status !== "cancelled" && job.status !== "failed") return; // 还没停到位
  const active = state.jobs.some((item) => item.status === "running" || item.status === "queued");
  if (active) { autoUnloadAfterCancel = null; return; }
  const modelState = state.model.state;
  if (modelState === "loaded") {
    autoUnloadAfterCancel = null;
    try {
      await unloadModel();
      toast(T("任务已取消 · 模型已自动卸载，内存与显存已释放"), "ok");
    } catch (exc) {
      toast(T("自动卸载失败（{0}）· 可到系统页手动卸载", message(exc)), "warn");
    }
  } else if (modelState !== "loading") {
    autoUnloadAfterCancel = null; // 本就没加载，无事可做
  }
  // loading 中：不动，等模型事件到了再卸
}

subscribe((what) => {
  if (what === "model" || what === "connection" || what === "schema") {
    maybeAutoUnload(); // 取消时模型还在加载的场景：加载完成事件到了再卸
    if (what === "connection") {
      if (state.connected) {
        lastBackendError = "";
        if (outageToast) {
          outageToast();
          outageToast = null;
        }
        if (state.update.applying) loadUpdateStatus().catch(() => {});
      } else if (sawConnected && !outageToast) {
        outageToast = toast(T("与后端连接中断，正在自动重连；这期间任务进度可能不更新"), "bad", 0);
      }
    }
    renderTopbar();
    renderRail();
    if (ui.view === "system") renderSystem();
  }
  if (what === "error") showBackendError();
  if (what === "died") {
    toast(T("模型进程已退出：{0}", state.model.reason || ""), "bad", 0);
  }
  if (what === "jobs" || what === "job") {
    maybeAutoUnload();
    showNotices();
    syncConsoleWatched();
    renderTopbar();
    renderRail();
    refreshSkip();
    renderCost();
    if (ui.view === "studio") { renderQueue(); renderStudioScore(); }
    if (ui.view === "library") renderLibrary();
    if (ui.view === "score") renderScore();
    if (ui.view === "guide") renderGuideView();
    refreshLiveSurfaces({full: true});
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
    recordStage(state.stage);
    refreshLiveSurfaces();
  }
  if (what === "presets") {
    $("fPreset").innerHTML = state.presets.map((preset) =>
      `<option value="${esc(preset.id)}">${esc(T(preset.name))}</option>`).join("");
  }
  if (what === "doctor" && ui.view === "system") renderDoctor();
  if (what === "update" && ui.view === "system") renderSystem();
  if (what === "lyrics") {
    const id = state.lyricsEvent?.job;
    if (state.lyricsEvent?.ok === false) {
      const job = state.byId.get(id);
      toast(T("{0} 的歌词对齐失败：打开这首歌的歌词区可点「重试」",
        job?.title || job?.lyrics_head || id || ""), "warn", 6000);
    }
    if (id && id === ui.track) fetchLyrics(id);
  }
  if (what === "bootstrap") {
    syncConsoleWatched();
    renderAdvanced();
    renderAll();
    refreshLiveSurfaces({full: true});
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
    const savedSort = readText(SORT_KEY, (value) => value in SORTS, "");
    if (savedSort) ui.sort = savedSort;
  } catch (exc) {}
  /* 兼容 #/library 与 #library 两种写法：文档里的分享链接带前导斜杠，
     以前只 replace('#') 会得到 '/library' 而被静默忽略。 */
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (VIEWS.includes(hash)) ui.view = hash;
  await bootstrap();
  restorePlayback();
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
  window.addEventListener("hashchange", async () => {
    const next = window.location.hash.replace(/^#\/?/, "");
    if (VIEWS.includes(next) && next !== ui.view) {
      await leaveScoreGuard(next);
      if (VIEWS.includes(next) && next !== ui.view) go(next);
    }
  });
  const missing = state.schema ? null : T("后端约束还没取到，界面先用官方默认值");
  if (missing) toast(missing, "warn");
  if (state.error) toast(T("后端连接异常：{0}", state.error), "bad", 0);
  else if (!state.jobs.length) toast(T("曲库是空的 · 生成第一首后会出现在这里"));
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
