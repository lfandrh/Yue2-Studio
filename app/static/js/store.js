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
  stage: null,               // 最近一条 stage 事件（label/completed/total/unit/status/rate/job）
  current: null,             // 正在跑的任务 id
  doctor: null,
  presets: [],
  settings: null,             // GET /api/settings：{settings:{attention_ar,attention_nar}, capabilities:{...}}
  lyricsEvent: null,         // 最近一条 lyrics 事件（{job}），歌词就绪后前端重取
  error: "",
};

const listeners = new Set();
let source = null;
let pollTimer = null;
let reconnectTimer = null;

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

export async function loadModelOn(device) {
  state.model = {...state.model, state: "loading", reason: ""};
  emit("model");
  try {
    state.model = await api("/api/model/load", {method: "POST", body: {device}});
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
  // 服务端的 queued 事件可能比这个响应先到，同一 id 不能出现两行
  const index = state.jobs.findIndex((item) => item.id === job.id);
  if (index >= 0) state.jobs[index] = job;
  else state.jobs.unshift(job);
  state.byId.set(job.id, job);
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
function applyRow(row) {
  const index = state.jobs.findIndex((item) => item.id === row.id);
  if (index < 0) {
    state.jobs.unshift(row);
    state.byId.set(row.id, row);
    return;
  }
  const prev = state.jobs[index];
  const next = prev.requested?.lyrics !== undefined && row.requested?.lyrics === undefined
    ? {...row, requested: prev.requested}
    : {...prev, ...row};
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
      break;
    default:
      break;
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (state.connected) return;
    loadJobs().catch(() => {});
    loadModel().catch(() => {});
  }, 15000);
}

export function connectEvents() {
  if (source) return;
  source = new EventSource("/api/events");
  source.onopen = () => {
    state.connected = true;
    state.error = "";
    emit("connection");
  };
  source.onmessage = (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch (exc) {
      return;
    }
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
  const tasks = [
    loadSchema().catch((exc) => { state.error = exc.message; }),
    loadPresets().catch(() => {}),
    loadModel().catch(() => {}),
    loadJobs().catch(() => {}),
    loadSettings().catch(() => {}),
  ];
  await Promise.all(tasks);
  connectEvents();
  emit("bootstrap");
}
