/* 数据层：REST + SSE。视图只订阅 state，不自己发请求。
   实时以 SSE 为主（/api/events），断线时按 D6 退到 15s 轮询 /api/jobs。
   后端是单一事实源：状态文字用中文原文，翻译在渲染时由 i18n.T() 完成。 */
"use strict";

export const state = {
  connected: false,          // SSE 是否在推
  schema: null,              // GET /api/schema 反射结果（约束单一来源）
  model: {state: "unloaded", device: null, device_name: "", reason: "", busy: false, gpu: {}, default_device: "cpu"},
  jobs: [],                  // 列表视图用，按 created_at 倒序
  byId: new Map(),
  notices: [],               // 服务启动时的恢复/中断通知（GET /api/jobs）
  stage: null,               // 最近一条 stage 事件（label/completed/total/unit/status/rate/job）
  current: null,             // 正在跑的任务 id
  doctor: null,
  presets: [],
  settings: null,             // GET /api/settings：{settings:{attention_ar,attention_nar}, capabilities:{...}}
  lyricsEvent: null,         // 最近一条 lyrics 事件（{job}），歌词就绪后前端重取
  error: "",
  update: {checked: false, checking: false, current: "", latest: "", has_update: false,
           changelog: "", size: 0, url: "", sha256: "", published_at: "", channel: "stable",
           commit: "", downloading: false, downloaded: false, applying: false,
           status: null, error: ""},
};

const listeners = new Set();
let source = null;
let pollTimer = null;
let reconnectTimer = null;
let eventSeq = null;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(what) {
  for (const fn of listeners) {
    try {
      fn(what, state);
    } catch (exc) {
      console.error("[store] listener failed", exc);
    }
  }
}

export class ApiError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function api(path, {method = "GET", body, signal} = {}) {
  const init = {method, headers: {}, signal};
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch (exc) {
    if (exc.name === "AbortError") throw exc;
    throw new ApiError("连不上后端服务", 0, String(exc));
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (exc) {
      data = null;
    }
  }
  if (!response.ok) {
    const detail = data && (data.detail || data.reason);
    throw new ApiError(detail ? String(detail) : `请求失败（HTTP ${response.status}）`, response.status, data);
  }
  return data;
}

export const get = (path, opts) => api(path, opts);
export const post = (path, body, opts) => api(path, {...opts, method: "POST", body: body === undefined ? {} : body});
export const put = (path, body, opts) => api(path, {...opts, method: "PUT", body: body === undefined ? {} : body});

/* 二进制下载同样走 ApiError：后端 409/404 的原因要能原样显示，
   不能像普通 Error 那样被 message() 统一翻成「连不上后端服务」。 */
export async function downloadFile(path, {signal} = {}) {
  let response;
  try {
    response = await fetch(path, {cache: "no-store", signal});
  } catch (exc) {
    if (exc.name === "AbortError") throw exc;
    throw new ApiError("连不上后端服务", 0, String(exc));
  }
  if (!response.ok) {
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (exc) {
        data = null;
      }
    }
    const detail = data && (data.detail || data.reason);
    throw new ApiError(detail ? String(detail) : `下载失败（HTTP ${response.status}）`, response.status, data);
  }
  return response.blob();
}
/* ------------------------------------------------------------------ 载入 */
async function loadSchema() {
  state.schema = await api("/api/schema");
  emit("schema");
  return state.schema;
}

async function loadPresets() {
  state.presets = (await api("/api/presets")).presets || [];
  emit("presets");
  return state.presets;
}

export async function loadModel() {
  state.model = await api("/api/model");
  emit("model");
  return state.model;
}

export async function loadJobs(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  const suffix = query.toString();
  const data = await api("/api/jobs" + (suffix ? `?${suffix}` : ""));
  state.jobs = data.jobs || [];
  state.byId = new Map(state.jobs.map((job) => [job.id, job]));
  state.notices = data.notices || [];
  emit("jobs");
  return state.jobs;
}

export async function loadJob(id) {
  const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
  state.byId.set(job.id, job);
  const index = state.jobs.findIndex((item) => item.id === job.id);
  if (index >= 0) state.jobs[index] = job; else state.jobs.unshift(job);
  emit("job");
  return job;
}

export async function loadDoctor(refresh = false) {
  state.doctor = await api("/api/system/doctor" + (refresh ? "?refresh=true" : ""));
  emit("doctor");
  return state.doctor;
}

/* ------------------------------------------------------------------ 更新 */
export async function loadVersion() {
  state.update = {...state.update, ...(await api("/api/system/version"))};
  emit("update");
  return state.update;
}

export async function checkUpdate() {
  state.update = {...state.update, checking: true, error: ""};
  emit("update");
  try {
    const data = await post("/api/system/update/check", {});
    state.update = {...state.update, ...data, checking: false, checked: true,
                    downloading: false, downloaded: false, applying: false, status: null};
  } catch (exc) {
    state.update = {...state.update, checking: false, checked: true,
                    error: exc.message || "检查失败"};
  }
  emit("update");
  return state.update;
}

export async function downloadUpdate() {
  state.update = {...state.update, downloading: true, error: ""};
  emit("update");
  try {
    await post("/api/system/update/download",
               {url: state.update.url, sha256: state.update.sha256});
    state.update = {...state.update, downloading: false, downloaded: true, status: null};
  } catch (exc) {
    state.update = {...state.update, downloading: false, error: exc.message || "下载失败"};
  }
  emit("update");
  return state.update;
}

export async function applyUpdate(port) {
  state.update = {...state.update, applying: true, error: ""};
  emit("update");
  try {
    await post("/api/system/update/apply", {port});
  } catch (exc) {
    state.update = {...state.update, applying: false, error: exc.message || "更新失败"};
    emit("update");
  }
  return state.update;
}

export async function loadUpdateStatus() {
  try {
    state.update = {...state.update, status: await api("/api/system/update/status")};
  } catch (exc) {
    return state.update;
  }
  emit("update");
  return state.update;
}

/* ------------------------------------------------------------------ 模型 */
export async function loadSettings() {
  state.settings = await api("/api/settings");
  emit("settings");
  return state.settings;
}

export async function saveSettings(values) {
  state.settings = await api("/api/settings", {method: "PATCH", body: values});
  emit("settings");
  return state.settings;
}

export async function resetSettings() {
  state.settings = await api("/api/settings/reset", {method: "POST", body: {}});
  emit("settings");
  return state.settings;
}

export async function loadModelOn(device, {reassignQueued = false} = {}) {
  const previous = state.model;
  state.model = {...previous, state: "loading", reason: ""};
  emit("model");
  try {
    state.model = await api("/api/model/load",
      {method: "POST", body: {device, reassign_queued: reassignQueued}});
  } catch (exc) {
    // 请求失败时后端没接受这次加载，界面不能停在「加载中」转圈
    state.model = previous;
    throw exc;
  } finally {
    emit("model");
  }
  return state.model;
}

export async function unloadModel() {
  state.model = await api("/api/model/unload", {method: "POST", body: {}});
  emit("model");
  return state.model;
}

/* ------------------------------------------------------------------ 任务 */
export async function createJob(payload) {
  const job = await api("/api/jobs", {method: "POST", body: payload});
  // 后端起跑比这个响应快：SSE 的 running 可能先到，queued 快照不能把它盖回去
  applyRow(job);
  state.current = job.id;
  emit("jobs");
  return job;
}

export async function cancelJob(id) {
  const result = await api(`/api/jobs/${encodeURIComponent(id)}/cancel`, {method: "POST", body: {}});
  if (result?.row) {
    applyRow(result.row);
    emit("job");
  }
  return result;
}

export async function updateJob(id, fields) {
  const result = await api(`/api/jobs/${encodeURIComponent(id)}`, {method: "PATCH", body: fields});
  if (result?.row) applyRow(result.row);
  else {
    const job = state.byId.get(id);
    if (job) Object.assign(job, result);
  }
  emit("jobs");
  return result;
}

/* 改作品名：后端一条事务刷组内所有版本，返回的整组行就地合并 */
export async function renameWork(id, name) {
  let result;
  try {
    result = await api(`/api/jobs/${encodeURIComponent(id)}/work`,
      {method: "PATCH", body: {name}});
  } catch (exc) {
    console.error("[store] 改作品名失败", {id, name, status: exc?.status}, exc);
    throw exc;
  }
  for (const row of result?.rows || []) applyRow(row);
  emit("jobs");
  return result;
}

export async function deleteJob(id) {
  const result = await api(`/api/jobs/${encodeURIComponent(id)}`, {method: "DELETE"});
  state.jobs = state.jobs.filter((job) => job.id !== id);
  state.byId.delete(id);
  if (state.current === id) state.current = null;
  emit("jobs");
  return result;
}

export const audioUrl = (id) => `/api/jobs/${encodeURIComponent(id)}/audio`;
export const artifactUrl = (id, name) => `/api/jobs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(name)}`;

/* ------------------------------------------------------------------ SSE */
const TERMINAL = new Set(["complete", "failed", "cancelled"]);
let jobsSyncTimer = 0;

/* 就地合并一条列表行：事件里自带整行，就不必为一个字段重拉全部任务。
   详情接口取过的全文歌词比列表行多，别用摘要把它冲掉。 */
const STATUS_RANK = {queued: 0, running: 1, complete: 2, failed: 2, cancelled: 2};

/* 状态只进不退：创建/PATCH 的响应可能是早于 SSE 的旧快照，整行覆盖会把界面退回「排队中」。 */
function mergeRow(prev, row) {
  const regress = (STATUS_RANK[row.status] ?? -1) < (STATUS_RANK[prev.status] ?? -1);
  const patch = regress
    ? {...row, status: prev.status, stage: prev.stage, stage_raw: prev.stage_raw,
       progress: prev.progress, stage_live: prev.stage_live, error: prev.error,
       updated_at: prev.updated_at}
    : row;
  return prev.requested?.lyrics !== undefined && row.requested?.lyrics === undefined
    ? {...patch, requested: prev.requested}
    : {...prev, ...patch};
}

function applyRow(row) {
  const index = state.jobs.findIndex((item) => item.id === row.id);
  if (index < 0) {
    state.jobs.unshift(row);
    state.byId.set(row.id, row);
    return;
  }
  const next = mergeRow(state.jobs[index], row);
  state.jobs[index] = next;
  state.byId.set(row.id, next);
}

function applyEvent(event) {
  switch (event.event) {
    case "stage":
      state.stage = event;
      if (event.job) state.current = event.job;
      emit("stage");
      break;
    case "job": {
      if (event.row) applyRow(event.row);
      if (event.status) {
        state.current = TERMINAL.has(event.status) ? null : event.job;
        const job = state.byId.get(event.job);
        if (job) {
          job.status = event.status;
          if (event.error !== undefined) job.error = event.error;
          if (event.duration !== undefined) job.duration = event.duration;
        }
        if (!event.row && event.status !== "queued") loadJobs().catch(() => {});
      }
      emit("job");
      break;
    }
    case "model":
      if (event.model) {
        state.model = event.model;
        emit("model");
      }
      break;
    case "jobs":
      clearTimeout(jobsSyncTimer);
      jobsSyncTimer = setTimeout(() => {
        loadJobs().catch(() => {});
        emit("job");
      }, 150);
      break;
    case "loaded":
    case "unloaded":
      loadModel().catch(() => {});
      break;
    case "lyrics":
      state.lyricsEvent = event;
      emit("lyrics");
      break;
    case "error":
      state.error = event.reason || "后端报错";
      emit("error");
      break;
    case "died":
      state.model = {...state.model, state: "unloaded", reason: event.reason || "模型进程已退出"};
      emit("model");
      emit("died");
      break;
    default:
      break;
  }
}

export let pollCountdown = 5;
let pollCountdownTimer = null;
let pollTick = 0;

function startPolling() {
  if (pollTimer) return;
  pollCountdown = 5;
  pollTick = 0;
  if (pollCountdownTimer) clearInterval(pollCountdownTimer);
  pollCountdownTimer = setInterval(() => {
    if (state.connected) { pollCountdown = 5; return; }
    pollCountdown = Math.max(1, pollCountdown - 1);
    if (typeof emit === "function") emit("connection");
    if (pollCountdown <= 1 && pollTick >= 0) {
      pollCountdown = 5;
      pollTick += 1;
      loadJobs().catch(() => {});
      loadModel().catch(() => {});
    }
  }, 1000);
}

function seqGap(previous, incoming) {
  return Number.isInteger(previous) && Number.isInteger(incoming) && incoming > previous + 1;
}

/* 断号或重连空档都说明内存里的任务快照可能过期；重新拉全量，不让进度停在旧值。 */
function resyncJobs(reason) {
  eventSeq = null;
  emit("gap");
  loadJobs().catch(() => {});
  console.warn("[store] SSE 事件序号不连续，已重新同步任务列表", reason);
}

export function connectEvents() {
  if (source) return;
  source = new EventSource("/api/events");
  source.onopen = () => {
    state.connected = true;
    state.error = "";
    emit("connection");
  };
  source.addEventListener("ready", (message) => {
    let ready;
    try {
      ready = JSON.parse(message.data);
    } catch (exc) {
      return;
    }
    const seq = Number(ready?.seq);
    // EventSource reconnects without replaying missed events.  Treat every fresh
    // subscription as a new baseline and reconcile once; otherwise a reconnect that
    // lands on the same sequence can leave the UI on stale task state.
    eventSeq = Number.isInteger(seq) ? seq : null;
    loadJobs().catch(() => {});
  });
  source.onmessage = (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch (exc) {
      return;
    }
    const seq = Number(event?.seq);
    if (seqGap(eventSeq, seq)) {
      resyncJobs({previous: eventSeq, incoming: seq});
    }
    if (Number.isInteger(seq)) eventSeq = seq;
    applyEvent(event);
  };
  source.onerror = () => {
    state.connected = false;
    emit("connection");
    startPolling();
    // 浏览器会自行重连；彻底关闭时（如服务重启）自己再拉一次
    if (source && source.readyState === EventSource.CLOSED) {
      source.close();
      source = null;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectEvents, 3000);
    }
  };
  startPolling();
}

/* 首屏一次性拉齐；任何一项失败都不阻塞其余部分 */
export async function bootstrap() {
  const mark = (exc) => { state.error = state.error || (exc?.message || "请求失败"); };
  const tasks = [
    loadSchema().catch(mark),
    loadPresets().catch(mark),
    loadModel().catch(mark),
    loadJobs().catch(mark),
    loadSettings().catch(mark),
    loadVersion().catch(mark),
  ];
  await Promise.all(tasks);
  connectEvents();
  emit("bootstrap");
}
