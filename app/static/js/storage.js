/* 浏览器本地状态统一入口。
   所有新键都带 yue2.v1. 前缀；首次读取旧键时迁移，坏数据静默删除并回退默认值。 */
"use strict";

export const STORAGE_PREFIX = "yue2.v1.";

export function storageKey(area) {
  const name = String(area || "").replace(/^yue2\./, "");
  if (!name || name.includes("..") || name.startsWith("/")) throw new Error(`invalid storage area: ${area}`);
  return STORAGE_PREFIX + name;
}

function store() {
  return typeof localStorage !== "undefined" ? localStorage : null;
}

function legacyArea(key) {
  return key.startsWith(STORAGE_PREFIX) ? "yue2." + key.slice(STORAGE_PREFIX.length) : "";
}

export function readRaw(area, {legacy = true} = {}) {
  const local = store();
  if (!local) return null;
  const key = storageKey(area);
  try {
    const value = local.getItem(key);
    if (value !== null) return value;
    const old = legacy ? legacyArea(key) : "";
    if (!old) return null;
    const previous = local.getItem(old);
    if (previous === null) return null;
    local.setItem(key, previous);
    local.removeItem(old);
    return previous;
  } catch (exc) {
    return null;
  }
}

export function writeRaw(area, value) {
  const local = store();
  if (!local) return false;
  try {
    local.setItem(storageKey(area), String(value));
    return true;
  } catch (exc) {
    return false;
  }
}

export function removeRaw(area, {legacy = true} = {}) {
  const local = store();
  if (!local) return;
  try {
    local.removeItem(storageKey(area));
    if (legacy) local.removeItem(legacyArea(storageKey(area)));
  } catch (exc) { /* 隐私模式或配额已满：调用方仍可用内存状态 */ }
}

export function readJson(area, validate, fallback = null) {
  const raw = readRaw(area);
  if (raw === null) return fallback;
  try {
    const value = JSON.parse(raw);
    if (validate && !validate(value)) {
      removeRaw(area);
      return fallback;
    }
    return value;
  } catch (exc) {
    removeRaw(area);
    return fallback;
  }
}

export function writeJson(area, value) {
  return writeRaw(area, JSON.stringify(value));
}

export function readText(area, validate, fallback = "") {
  const value = readRaw(area);
  if (value === null) return fallback;
  if (validate && !validate(value)) {
    removeRaw(area);
    return fallback;
  }
  return value;
}

export function writeText(area, value) {
  return writeRaw(area, value);
}

export function readNumber(area, validate, fallback) {
  const raw = readRaw(area);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || (validate && !validate(value))) {
    removeRaw(area);
    return fallback;
  }
  return value;
}

export function writeNumber(area, value) {
  return writeRaw(area, value);
}

export const validators = {
  text: (value) => typeof value === "string",
  optionalText: (value) => value === undefined || typeof value === "string",
  finite: (value) => Number.isFinite(value),
  stringArray: (value) => Array.isArray(value) && value.every((item) => typeof item === "string" && item),
  object: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
};
