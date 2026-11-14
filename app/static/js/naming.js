/* 显示名 = 作品名 · 版本标签（docs/歌曲管理优化方案-2026-11-12.md §3.1）。
   作品名由后端冗余在 work_name 上，改名整组传播；版本标签优先用户自定义，
   其次用后端建任务时写定的自动标签（候选 A / 改谱 2 …）。 */
"use strict";

import {T} from "./i18n.js";

const CANDIDATE = /^候选\s+([A-Z]+)$/;
const DERIVED = /^(改谱|成歌|换解码器)\s+(\d+)$/;

/* 自动标签以中文原文存在库里，显示时按当前界面语言翻译 */
export function versionLabel(job) {
  const custom = String(job?.version_label || "").trim();
  if (custom) return custom;
  const tag = String(job?.version_tag || "").trim();
  if (!tag) return "";
  const candidate = CANDIDATE.exec(tag);
  if (candidate) return T("候选 {0}", candidate[1]);
  const derived = DERIVED.exec(tag);
  if (derived) return `${T(derived[1])} ${derived[2]}`;
  return tag;
}

/* 旧行（迁移前）没有 work_name：退回标题 / 歌词首行，行为与旧 jobName 一致 */
function firstLyricLine(lyrics, size) {
  for (const line of String(lyrics || "").split("\n")) {
    const text = line.trim();
    if (text && !text.startsWith("[")) return text.slice(0, size);
  }
  return "";
}

function legacyName(job) {
  const title = String(job?.title || "").trim();
  if (title) {
    const candidate = /^候选 (\d+) · (.+)$/.exec(title);
    return candidate ? T("候选 {0} · {1}", candidate[1], candidate[2]) : title;
  }
  const head = String(job?.lyrics_head || "").trim() || firstLyricLine(job?.requested?.lyrics, 12);
  return head ? head.slice(0, 14) : T("未命名任务");
}

/* 作品名本身（改名输入框用）：不带版本标签，避免把「· 改谱 1」存进作品名 */
export function workName(job) {
  return String(job?.work_name || "").trim() || legacyName(job);
}

export function displayName(job) {
  if (!job) return "";
  const name = String(job.work_name || "").trim();
  if (!name) return legacyName(job);
  const label = versionLabel(job);
  return label ? `${name} · ${label}` : name;
}

/* 下载文件名里的作品名：和音频下载同一套清洗规则 */
export function downloadBase(job) {
  const base = String(displayName(job) || job?.lyrics_head || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 48).replace(/^[.\s]+|[.\s]+$/g, "");
  return base || "yue2";
}

export function subtitleName(job, fmt, enhanced = false) {
  const ext = String(fmt || "").toLowerCase() === "srt" ? "srt" : "lrc";
  const word = ext === "lrc" && enhanced ? ` (${T("逐字")})` : "";
  return `${downloadBase(job)} - ${job?.id || Date.now()}${word}.${ext}`;
}
