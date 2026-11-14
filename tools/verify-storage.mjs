/* 本地存储版本与迁移验收：node tools/verify-storage.mjs
   纯内存 localStorage，不连后端、不启浏览器。 */
"use strict";

const items = new Map();
globalThis.localStorage = {
  getItem: (key) => items.has(key) ? items.get(key) : null,
  setItem: (key, value) => items.set(key, String(value)),
  removeItem: (key) => items.delete(key),
};

const {storageKey, readRaw, readJson, writeJson, readText, writeText,
       readNumber, writeNumber, removeRaw, validators} = await import("../app/static/js/storage.js");

let pass = 0;
let fail = 0;
function eq(actual, expected, label) {
  if (actual === expected && JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    return;
  }
  fail += 1;
  console.error(`FAIL ${label}
  期望: ${JSON.stringify(expected)}
  实际: ${JSON.stringify(actual)}`);
}

eq(storageKey("draft"), "yue2.v1.draft", "新键统一 v1 前缀");
eq(storageKey("yue2.volume"), "yue2.v1.volume", "重复旧前缀只迁移一次");
let invalidKey = false;
try { storageKey("../evil"); } catch { invalidKey = true; }
eq(invalidKey, true, "拒绝越界 area");

items.set("yue2.volume", "73");
eq(readNumber("volume", (n) => n >= 0 && n <= 100, 90), 73, "旧数字键迁移后读取");
eq(items.get("yue2.v1.volume"), "73", "迁移写入 v1 键");
eq(items.has("yue2.volume"), false, "迁移后删除旧键");

items.set("yue2.v1.volume", "loud");
eq(readNumber("volume", (n) => n >= 0 && n <= 100, 90), 90, "坏数字降级默认");
eq(items.has("yue2.v1.volume"), false, "坏数字被删除");

writeText("lang", "en");
eq(readText("lang", (v) => v === "en" || v === "zh", "zh"), "en", "v1 文本读取");
items.set("yue2.v1.lang", "fr");
eq(readText("lang", (v) => v === "en" || v === "zh", "zh"), "zh", "非法枚举降级");
eq(items.has("yue2.v1.lang"), false, "非法枚举被删除");

items.set("yue2.v1.draft", "{broken json");
eq(readJson("draft", (v) => typeof v?.style === "string", null), null, "坏 JSON 返回 null");
eq(items.has("yue2.v1.draft"), false, "坏 JSON 被删除");

writeJson("draft", {style: "", lyrics: "", name: ""});
const draft = readJson("draft", (v) => typeof v?.style === "string" && typeof v?.lyrics === "string", null);
eq(draft?.style, "", "合法空风格草稿保留");
eq(draft?.name, "", "合法空歌名草稿保留");

items.set("yue2.v1.playback", JSON.stringify({id: "song_1", time: "bad"}));
eq(readJson("playback", (v) => typeof v?.id === "string" && Number.isFinite(v.time), null), null,
  "播放会话字段 schema 不匹配时丢弃");

items.set("yue2.v1.ab", JSON.stringify(["song_1", 2, "", "song_2"]));
eq(readJson("ab", validators.stringArray, []).length, 0, "A/B 数组含非字符串时整体降级");

writeNumber("scoreSec", 42);
eq(items.get("yue2.v1.scoreSec"), "42", "数字写入 v1 键");
removeRaw("scoreSec");
eq(items.has("yue2.v1.scoreSec"), false, "删除 v1 键");

const html = (await import("node:fs")).readFileSync(
  new URL("../app/static/index.html", import.meta.url), "utf8");
eq(html.includes('localStorage.getItem(v1+"theme")'), true, "首屏主题读 v1 键");
eq(html.includes('localStorage.getItem("yue2.theme")'), true, "首屏仍兼容旧主题键");

console.log(`本地存储验收：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
