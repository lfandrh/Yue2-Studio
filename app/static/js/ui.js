/* 界面基础件：图标、toast、模态（焦点陷阱 + Esc + 焦点还原）、小工具。
   图标路径逐条取自 demo/YuE2-UI-Demo.html（已验收的图形语言），描边宽度由调用处 CSS 决定。 */
"use strict";

import {T} from "./i18n.js";

/* ------------------------------------------------------------------ 图标 */
const ICONS = {
  wave: ['<path d="M2 12h2.4M7 6.5v11M11.5 3.5v17M16 8v8M20.5 10.5v3" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" fill="none"/>'],
  sun: ['<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M5 5l1.8 1.8M17.2 17.2 19 19M19 5l-1.8 1.8M6.8 17.2 5 19" stroke-linecap="round"/>'],
  moon: ['<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z" stroke-linejoin="round"/>'],
  tray: ['<path d="M12 3v12m0 0 4-4m-4 4L8 11M4 19h16" stroke-linecap="round"/>'],
  keyboard: ['<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>'],
  music: ['<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'],
  score: ['<path d="M4 6h16M4 12h16M4 18h10M18 15l3 3-3 3" stroke-linecap="round"/>'],
  batch: ['<rect x="3" y="4" width="18" height="5" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 6.5h.01M7 17h.01"/>'],
  library: ['<path d="M4 4h4v16H4zM10 4h4v16h-4zM17 5l3 1-3.5 13-3-1z"/>'],
  system: ['<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>'],
  pulse: ['<path d="M4 12h4l3-8 3 16 3-8h3"/>'],
  grid: ['<path d="M4 8h16M4 16h16M9 4v16M15 4v16"/>'],
  check: ['<path d="m5 13 4 4L19 7"/>'],
  melody: ['<path d="M4 12c3-6 5 6 8 0s5 3 8-3"/>'],
  bolt: ['<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>'],
  x: ['<path d="M6 6l12 12M18 6 6 18"/>'],
  lines: ['<path d="M4 7h16M4 12h10M4 17h7"/>'],
  text: ['<path d="M5 4h14M5 20h9M7 9h11M7 14h7"/>'],
  dice: ['<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.7" fill="currentColor" stroke="none"/>'],
  abc: ['<path d="M4 6h16M4 12h16M4 18h16M9 3v6M15 9v6M6 15v6" stroke-width="1.6"/>'],
  chev: ['<path d="m6 9 6 6 6-6"/>'],
  info: ['<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>'],
  note: ['<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/>'],
  list: ['<path d="M4 6h16M4 12h16M4 18h10"/>'],
  arrowdown: ['<path d="M12 3v12m0 0 4-4m-4 4L8 11"/>'],
  search: ['<circle cx="11" cy="11" r="7"/><path d="m20 20-4.3-4.3"/>'],
  plus: ['<path d="M12 2v20M2 12h20"/>'],
  star: ['<path d="m12 3 2.8 5.6 6.2.9-4.5 4.4 1 6.1-5.5-2.9-5.5 2.9 1-6.1L3 9.5l6.2-.9z"/>'],
  stop: ['<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6v6H9z"/>'],
  box: ['<path d="M4 4h16v16H4zM4 10h16M10 10v10"/>'],
  volume: ['<path d="M4 9v6h4l5 4V5L8 9z"/>'],
  trash: ['<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>'],
  refresh: ['<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6M20.5 3.5V9H15"/>'],
  copy: ['<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 5.5V5A1.5 1.5 0 0 0 13.5 3.5h-8A1.5 1.5 0 0 0 4 5v8A1.5 1.5 0 0 0 5.5 14.5H6"/>'],
  pencil: ['<path d="M4 20h4L20 8l-4-4L4 16z"/>'],
  cpu: ['<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>'],
  gpu: ['<rect x="2" y="7" width="20" height="10" rx="2"/><circle cx="8" cy="12" r="2.2"/><path d="M14 10h5M14 14h5"/>'],
  warn: ['<path d="M12 3 2.5 20h19z"/><path d="M12 9v5M12 17h.01"/>'],
  clock: ['<circle cx="12" cy="12" r="9"/><path d="M12 7v5.5l3.5 2"/>'],
  link: ['<path d="M9 12h6M7.5 8H5a4 4 0 0 0 0 8h2.5M16.5 8H19a4 4 0 0 1 0 8h-2.5"/>'],
  play: ['<path d="M4 2l10 6-10 6z"/>', "0 0 16 16"],
  pause: ['<path d="M4.5 2.5h2.6v11H4.5zM8.9 2.5h2.6v11H8.9z"/>', "0 0 16 16"],
};

export function icon(name) {
  const entry = ICONS[name];
  if (!entry) return "";
  const viewBox = entry[1] || "0 0 24 24";
  return `<svg viewBox="${viewBox}" aria-hidden="true" focusable="false">${entry[0]}</svg>`;
}

/* ------------------------------------------------------------------ DOM 小工具 */
export const q = (selector, root = document) => root.querySelector(selector);
export const qa = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const ESCAPES = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"};
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/* 数据类文本（文件名/参数名/歌词/原始报错）不参与翻译 */
export const notr = (value) => `<span data-notr>${esc(value)}</span>`;

export function fmtClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtStamp(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

/* 绝对时间，格式固定成数据（不随界面语言变化） */
export function fmtDate(value) {
  const date = value instanceof Date ? value : new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

export function debounce(fn, wait = 260) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

/* ------------------------------------------------------------------ toast */
const TOAST_ICON = {ok: "check", warn: "warn", bad: "x", info: "info"};
let toastHost = null;

function host() {
  if (!toastHost || !toastHost.isConnected) toastHost = q("#toasts");
  return toastHost;
}

export function toast(text, kind = "info", ms = 4600, actions = []) {
  const root = host();
  if (!root) return null;
  const body = el("span", {text});
  const node = el("div", {class: `toast${kind && kind !== "info" ? ` ${kind}` : ""}`, role: kind === "bad" ? "alert" : "status"},
    [el("span", {html: icon(TOAST_ICON[kind] || "info")}), body]);
  /* 失败/带操作时常驻，带一键复制 + 关闭叉；普通信息按 ms 退 */
  const needsStay = kind === "bad" || (actions && actions.length) || ms <= 0;
  const rawDetail = String(text || "");
  const hasDetail = /\n/.test(rawDetail) || rawDetail.length > 120;
  if (needsStay && hasDetail) {
    const details = el("details", {style: "margin-top:6px"});
    details.append(el("summary", {text: T("原始报错"), style: "cursor:pointer;font-size:12px;opacity:.85"}));
    details.append(el("pre", {text: rawDetail, style: "white-space:pre-wrap;word-break:break-word;font-size:12px;margin:4px 0 0;max-height:120px;overflow:auto"}));
    node.append(details);
  }
  if (needsStay) {
    const closeBtn = el("button", {type: "button", class: "toast-x", "aria-label": T("关闭"), text: "×"});
    closeBtn.addEventListener("click", (e) => { e.stopPropagation(); dismiss(); });
    node.append(closeBtn);
    const copyBtn = el("button", {type: "button", class: "toast-copy", text: T("复制详情")});
    copyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try { await navigator.clipboard.writeText(rawDetail); copyBtn.textContent = T("已复制"); }
      catch { copyBtn.textContent = T("复制失败"); }
      setTimeout(() => { copyBtn.textContent = T("复制详情"); }, 1600);
    });
    node.append(copyBtn);
  }
  if (Array.isArray(actions)) {
    for (const item of actions) {
      if (!item || typeof item.fn !== "function") continue;
      const btn = el("button", {type: "button", class: "toast-act", text: item.label || T("好的")});
      btn.addEventListener("click", (e) => { e.stopPropagation(); try { item.fn(); } finally { dismiss(); } });
      node.append(btn);
    }
  }
  if (ms <= 0) node.title = T("点击关闭");
  root.append(node);
  requestAnimationFrame(() => node.classList.add("in"));
  /* 常驻也要有兜底：错误提示从底部往上堆，不退会盖住「生成歌曲」等主按钮。
     显式传 ms<=0（启动通知、后端断连）才真正永久驻留。 */
  const stayMs = needsStay ? Math.max(ms, 12000) : ms;
  const timer = stayMs > 0 ? setTimeout(dismiss, stayMs) : null;
  if (!needsStay) node.addEventListener("click", dismiss);
  function dismiss() {
    if (timer) clearTimeout(timer);
    node.classList.remove("in");
    setTimeout(() => node.remove(), 240);
  }
  dismiss.timer = timer;
  return dismiss;
}

/* ------------------------------------------------------------------ 模态 */
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const stack = [];
let scrim = null;
let restoreTo = null;

function scrimNode() {
  if (!scrim || !scrim.isConnected) scrim = q("#scrim");
  return scrim;
}

function syncScrim() {
  const node = scrimNode();
  if (node) node.classList.toggle("open", stack.length > 0);
}

export function openModal(node) {
  if (!node || stack.includes(node)) return node;
  if (!stack.length) restoreTo = document.activeElement;
  stack.push(node);
  node.inert = false;
  node.classList.add("open");
  node.setAttribute("aria-hidden", "false");
  syncScrim();
  const items = qa(FOCUSABLE, node);
  const first = items.find((item) => item.hasAttribute("data-autofocus")) || items[0] || node;
  requestAnimationFrame(() => first.focus({preventScroll: true}));
  return node;
}

function dismissTop() {
  const top = stack[stack.length - 1];
  if (!top) return;
  closeModal(top);
  if (top.dataset.onEsc === "resolve") top.dispatchEvent(new CustomEvent("modal:cancel"));
}

export function closeModal(node) {
  const target = node || stack[stack.length - 1];
  if (!target) return;
  const index = stack.indexOf(target);
  if (index >= 0) stack.splice(index, 1);
  target.classList.remove("open");
  target.inert = true;
  target.setAttribute("aria-hidden", "true");
  syncScrim();
  target.dispatchEvent(new CustomEvent("modal:close"));
  if (!stack.length && restoreTo && restoreTo.isConnected) {
    restoreTo.focus({preventScroll: true});
    restoreTo = null;
  }
}

/* 首屏把没打开的弹窗移出焦点顺序：opacity:0 的按钮不该被 Tab 摸到。 */
export function initModals() {
  qa(".modal").forEach((node) => {
    if (!node.classList.contains("open")) node.inert = true;
  });
}

export const modalOpen = () => stack.length > 0;

function trapFocus(event, node) {
  if (event.key !== "Tab") return;
  const items = qa(FOCUSABLE, node).filter((item) => item.offsetParent !== null || item === document.activeElement);
  if (!items.length) {
    event.preventDefault();
    node.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/* 单例监听：Esc 关最上层，Tab 只在最上层里绕 */
document.addEventListener("keydown", (event) => {
  if (!stack.length) return;
  const top = stack[stack.length - 1];
  if (event.key === "Escape") {
    event.preventDefault();
    dismissTop();
  } else {
    trapFocus(event, top);
  }
});

document.addEventListener("click", (event) => {
  if (!stack.length || event.target !== scrimNode()) return;
  dismissTop();
});

/* 确认框：resolve(true/false)，关闭后自行移除节点 */
export function confirmDialog({title, body, ok, cancel, danger = false, note = ""}) {
  /* 同名确认弹窗已在开时直接复用它的结果，避免快速连点叠出好几层一样的弹窗。 */
  const sameTitle = [...document.querySelectorAll(".modal.open h3")].find((h) => h.textContent === title);
  const sameNode = sameTitle ? sameTitle.closest(".modal") : null;
  if (sameNode && sameNode.__dialogPromise) return sameNode.__dialogPromise;
  const id = `dlg${Date.now().toString(36)}`;
  const okLabel = ok || T("确定");
  const cancelLabel = cancel || T("取消");
  const node = el("div", {
    class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": `${id}h`, tabindex: "-1", "data-on-esc": "resolve",
  });
  node.innerHTML =
    `<div class="mh"><h3 id="${id}h">${esc(title)}</h3>` +
    `<button class="iconbtn" type="button" aria-label="${esc(T("关闭"))}" data-x style="margin-left:auto">${icon("x")}</button></div>` +
    `<div class="mb">${body ? `<p style="font-size:14px;line-height:1.7">${body}</p>` : ""}` +
    `${note ? `<div class="hint" style="margin-top:var(--sp3)">${esc(note)}</div>` : ""}</div>` +
    `<div class="mfb"><button class="btn" type="button" data-cancel${danger ? " data-autofocus" : ""}>${esc(cancelLabel)}</button>` +
    `<button class="btn ${danger ? "danger" : "primary"}" type="button" data-ok${danger ? "" : " data-autofocus"}>${esc(okLabel)}</button></div>`;
  document.body.append(node);
  const promise = new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      closeModal(node);
      setTimeout(() => node.remove(), 240);
      resolve(value);
    };
    q("[data-ok]", node).addEventListener("click", () => finish(true));
    q("[data-cancel]", node).addEventListener("click", () => finish(false));
    q("[data-x]", node).addEventListener("click", () => finish(false));
    node.addEventListener("modal:cancel", () => finish(false));
    openModal(node);
  });
  node.__dialogPromise = promise;
  return promise;
}
