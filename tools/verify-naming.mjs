/* 前端命名规则验收：node tools/verify-naming.mjs
   只测纯函数（displayName / versionLabel / workName），不连后端、不写文件。 */
"use strict";

/* i18n 在模块加载时读 localStorage；Node 里先补最小的浏览器桩 */
globalThis.localStorage = {getItem: () => null, setItem: () => {}};
globalThis.document = {
  title: "", body: null, documentElement: {},
  dispatchEvent: () => {},
};

const {applyLang} = await import("../app/static/js/i18n.js");
const {displayName, versionLabel, workName, downloadBase, subtitleName} =
  await import("../app/static/js/naming.js");

let pass = 0;
let fail = 0;

function eq(actual, expected, label) {
  if (actual === expected) {
    pass += 1;
    return;
  }
  fail += 1;
  console.error(`FAIL ${label}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`);
}

/* ---- 中文（源码原文是唯一真源） ---- */
eq(displayName({work_name: "晚风", version_tag: "候选 A"}), "晚风 · 候选 A", "候选标签");
eq(displayName({work_name: "晚风", version_tag: "改谱 2"}), "晚风 · 改谱 2", "改谱标签带序号");
eq(displayName({work_name: "晚风", version_tag: "成歌 1", version_label: "女声版"}),
  "晚风 · 女声版", "自定义标签优先");
eq(displayName({work_name: "晚风"}), "晚风", "根任务不带标签");
eq(displayName({title: "候选 2 · 风 · k3x-r1"}), "候选 2 · 风 · k3x-r1", "旧候选标题兜底");
eq(displayName({title: "旧标题"}), "旧标题", "旧标题兜底");
eq(displayName({lyrics_head: "一二三四五六七八九十一二三四五六七"}), "一二三四五六七八九十一二三四",
  "歌词首行截 14 字");
eq(displayName({requested: {lyrics: "[Verse]\n一二三四五六七八九十一二三四"}}),
  "一二三四五六七八九十一二", "缺 lyrics_head 时退回歌词原文（跳过段落标记）");
eq(displayName({}), "未命名任务", "空任务兜底");

eq(workName({work_name: "晚风", version_tag: "改谱 1"}), "晚风", "改名输入不带版本标签");
eq(workName({title: "旧标题"}), "旧标题", "改名输入旧标题兜底");
eq(versionLabel({version_tag: "换解码器 3"}), "换解码器 3", "换解码器标签");
eq(versionLabel({}), "", "无标签返回空串");

const job = {id: "song_1", work_name: "晚风", version_tag: "候选 A"};
eq(subtitleName(job, "srt"), "晚风 · 候选 A - song_1.srt", "SRT 文件名");
eq(subtitleName(job, "lrc"), "晚风 · 候选 A - song_1.lrc", "行级 LRC 文件名");
eq(subtitleName(job, "lrc", true), "晚风 · 候选 A - song_1 (逐字).lrc", "逐字 LRC 文件名");
eq(subtitleName({id: "x", work_name: "a/b:c*?\"<>|"}, "srt"), "a b c - x.srt", "文件名清洗非法字符");
eq(subtitleName({id: "x"}, "srt"), "未命名任务 - x.srt", "文件名空作品兜底");
eq(subtitleName({id: "x", work_name: " .晚风. "}, "srt"), "晚风 - x.srt", "去掉首尾点与空格");
eq(subtitleName({id: "x", work_name: "..."}, "srt"), "yue2 - x.srt", "全是点时兜底");
eq(downloadBase(job), "晚风 · 候选 A", "下载名基座带版本");

/* ---- 英文：自动标签按界面语言翻译 ---- */
applyLang("en");
eq(displayName({work_name: "Late Wind", version_tag: "候选 B"}), "Late Wind · Candidate B",
  "EN 候选标签");
eq(displayName({work_name: "Late Wind", version_tag: "改谱 2"}), "Late Wind · Score edit 2",
  "EN 改谱标签");
eq(displayName({work_name: "Late Wind", version_tag: "成歌 1"}), "Late Wind · Render 1",
  "EN 成歌标签");
eq(displayName({work_name: "Late Wind", version_tag: "换解码器 3"}), "Late Wind · Re-decode 3",
  "EN 换解码器标签");
eq(displayName({}), "Untitled job", "EN 空任务兜底");
eq(displayName({title: "候选 2 · 风"}), "Candidate 2 · 风", "EN 旧候选标题兜底");
eq(subtitleName({id: "song_1", work_name: "Late Wind", version_tag: "候选 B"}, "lrc", true),
  "Late Wind · Candidate B - song_1 (Word).lrc", "EN 逐字文件名");
applyLang("zh");

console.log(`命名规则验收：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
