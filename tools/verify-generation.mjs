import fs from "node:fs";

/* 端到端生成验收（真实提交一条短曲，跑完模型加载→规划→AR→NAR→VAE→曲库）。
   先起一个独立 headless Chrome（端口 9458，独立 profile）：
     "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --headless=new \
       --remote-debugging-port=9458 --user-data-dir=<临时目录> --window-size=1426,900 --no-first-run about:blank
   再运行：node tools/verify-generation.mjs        截图与报告落在 tools/evidence/ */
const OUT = "tools/evidence";
fs.mkdirSync(OUT, {recursive: true});
const BASE = process.env.VERIFY_BASE || "http://127.0.0.1:9090";
const PORT = Number(process.env.VERIFY_CDP || 9458);
const DEADLINE_MS = 9 * 60 * 1000;

const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") {
    errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    errors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
};
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const i = ++id;
  pending.set(i, res);
  ws.send(JSON.stringify({id: i, method, params, ...(sessionId ? {sessionId} : {})}));
});
const {targetInfos} = await send("Target.getTargets");
const page = targetInfos.find((t) => t.type === "page");
const {sessionId} = await send("Target.attachToTarget", {targetId: page.targetId, flatten: true});
const ev = async (expr) => (await send("Runtime.evaluate", {expression: expr, awaitPromise: true, returnByValue: true}, sessionId)).result.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  const {data} = await send("Page.captureScreenshot", {format: "png"}, sessionId);
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, "base64"));
};
const results = [];
const check = (name, pass, detail) => {
  results.push({name, pass, detail});
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${detail === undefined ? "" : JSON.stringify(detail)}`);
};
const api = async (path, opts) => {
  const r = await fetch(BASE + path, opts);
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  return r.json();
};
const waitFor = async (expr, timeout = 10000, step = 250) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await ev(expr)) return true; } catch (exc) { /* navigating */ }
    await sleep(step);
  }
  return false;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable", {}, sessionId);
await send("Network.setCacheDisabled", {cacheDisabled: true}, sessionId);
await send("Emulation.setDeviceMetricsOverride", {width: 1426, height: 900, deviceScaleFactor: 1, mobile: false}, sessionId);
await send("Page.navigate", {url: BASE + "/"}, sessionId);
if (!(await waitFor(`document.readyState === "complete" && !!document.getElementById("btnGen")`))) {
  throw new Error("page did not load");
}
await ev(`localStorage.setItem("yue2.v1.tour", "seen"); localStorage.setItem("yue2.v1.guide", "off")`);
await send("Page.reload", {}, sessionId);
if (!(await waitFor(`document.readyState === "complete" && !!document.getElementById("btnGen")`))) {
  throw new Error("page did not reload");
}
await sleep(900);

/* ---------- 填一条最短可完成的短曲 ---------- */
const stamp = new Date().toISOString().slice(5, 16).replace("T", " ");
const workName = `验收短曲 ${stamp}`;
const style = "Mandarin, warm acoustic folk, female vocal, gentle fingerpicked guitar, soft hand drum, 84 BPM";
const lyrics = [
  "[Verse]", "城市的灯一盏一盏亮", "风把夜吹得很长", "我沿着河走回家", "口袋里装着月光",
  "", "[Chorus]", "如果明天还有风", "就把信折成船", "让它顺着水去南方", "告诉你我还好",
].join("\n");
await ev(`(() => {
  const set = (el, value) => { el.value = value; el.dispatchEvent(new Event("input", {bubbles: true})); };
  set(document.getElementById("fStyle"), ${JSON.stringify(style)});
  set(document.getElementById("fLyrics"), ${JSON.stringify(lyrics)});
  set(document.getElementById("fSongName"), ${JSON.stringify(workName)});
  set(document.getElementById("fSeed"), "20261112");
  const variant = document.getElementById("fVar");
  variant.value = "1"; variant.dispatchEvent(new Event("change", {bubbles: true}));
  document.querySelector('[data-cot="full"]').click();
  document.getElementById("btnGen").scrollIntoView({block: "center"});
  return {cot: document.querySelector('[data-cot="full"]').getAttribute("aria-pressed"), var: variant.value};
})()`).then((filled) => check("表单填好且为旋律+和弦模式", filled.cot === "true" && filled.var === "1", filled));
const panelBox = await ev(`(() => { const r = document.querySelector('.work')?.getBoundingClientRect(); return r ? {top: Math.round(r.top), h: Math.round(r.height)} : null; })()`);
check("创作页主面板已渲染", !!panelBox && panelBox.h > 300, panelBox);

const jobsBefore = new Set((await api("/api/jobs")).jobs.map((job) => job.id));
await ev(`document.getElementById("btnGen").click()`);
const t0 = Date.now();

/* 提醒确认弹窗（本组歌词不应出现，兜底点“仍然生成”） */
for (let i = 0; i < 12; i++) {
  const dialog = await ev(`(() => { const b = document.querySelector(".modal.open [data-ok]"); if (!b) return null; const t = b.closest(".modal")?.querySelector("h3")?.textContent || ""; b.click(); return t; })()`);
  if (dialog) { console.log(`INFO 确认弹窗：${dialog}`); break; }
  await sleep(250);
}

/* ---------- 等任务创建 ---------- */
let job = null;
for (let i = 0; i < 40 && !job; i++) {
  await sleep(500);
  const list = (await api("/api/jobs")).jobs;
  job = list.find((item) => !jobsBefore.has(item.id)) || null;
}
if (!job) {
  check("任务已创建", false, {error: "15 秒内没有出现新任务"});
  ws.close();
  process.exit(1);
}
check("任务已创建", job.type === "song" && job.status !== "cancelled", {id: job.id, status: job.status, cot: job.cot, seed: job.seed});
console.log(`INFO 任务 ${job.id} 已入队，工作名「${job.work_name || ""}」`);

/* 侧栏“进行中”徽标应在这条任务运行期间出现 */
const badgeOn = await waitFor(`(() => { const el = document.getElementById("cStudio"); return !el.hidden && Number(el.textContent) >= 1; })()`, 15000);
const badgeDetail = await ev(`(() => { const el = document.getElementById("cStudio"); return {hidden: el.hidden, text: el.textContent, display: getComputedStyle(el).display}; })()`);
check("运行任务时侧栏徽标出现", badgeOn, badgeDetail);

/* ---------- 轮询到结束 ---------- */
const stages = new Set();
let runningShot = false;
let firstProgress = null;
let lastStage = "";
while (Date.now() - t0 < DEADLINE_MS) {
  await sleep(1500);
  job = await api(`/api/jobs/${job.id}`);
  const stage = `${job.stage || ""} ${job.progress || ""}`.trim();
  if (stage) { stages.add(stage); lastStage = stage; if (!firstProgress) firstProgress = stage; }
  if (job.status === "running" && !runningShot && stage) {
    await sleep(400);
    await shot("gen-e2e-running");
    runningShot = true;
    console.log(`INFO 运行中：${stage}`);
  }
  if (["complete", "error", "cancelled"].includes(job.status)) break;
}
const elapsed = Math.round((Date.now() - t0) / 1000);
const finished = job.status === "complete";
check("生成完成且无错误", finished && !job.error, {status: job.status, error: job.error, elapsed_s: elapsed});
check("生成过程有阶段反馈", stages.size > 0, {stages: [...stages].slice(-6)});

if (!finished) {
  try { await fetch(`${BASE}/api/jobs/${job.id}/cancel`, {method: "POST"}); } catch (exc) { /* 已结束 */ }
  await shot("gen-e2e-failed");
  ws.close();
  console.error(`\n任务未完成，已取消；已用时 ${elapsed}s`);
  process.exit(1);
}

/* ---------- 产物与播放 ---------- */
const audioBytes = Number(job.artifacts?.["audio.flac"] || 0);
const duration = Number(job.result?.audio_seconds || job.duration || 0);
check("音频产物已落盘", audioBytes > 100_000 && duration > 5, {audio_bytes: audioBytes, audio_seconds: +duration.toFixed(1), truncated: job.result?.truncated});
const head = await fetch(`${BASE}/api/jobs/${job.id}/audio`, {method: "HEAD"});
check("音频接口可访问", head.ok && Number(head.headers.get("content-length") || 0) > 100_000, {status: head.status, length: head.headers.get("content-length")});

const probe = await ev(`new Promise((resolve) => {
  const audio = new Audio(${JSON.stringify(`${BASE}/api/jobs/${job.id}/audio`)});
  const timer = setTimeout(() => resolve({ok: false, error: "metadata timeout"}), 20000);
  audio.addEventListener("loadedmetadata", () => { clearTimeout(timer); resolve({ok: true, duration: audio.duration, rate: audio.duration}); }, {once: true});
  audio.addEventListener("error", () => { clearTimeout(timer); resolve({ok: false, error: "decode error"}); }, {once: true});
  audio.load();
})`);
const lengthMatch = probe.ok && Math.abs(probe.duration - duration) <= Math.max(2, duration * 0.05);
check("浏览器能解码音频且时长一致", lengthMatch, probe);

const timing = job.result?.timing || {};
const t = (key) => {
  const value = timing[key];
  const seconds = value && typeof value === "object" ? value.seconds : value;
  return Number(seconds) ? +Number(seconds).toFixed(1) : null;
};
console.log(`INFO 用时：规划 ${t("abc")}s / 歌声 ${t("semantic")}s / NAR ${t("nar_seconds")}s / 解码 ${t("vae_seconds")}s / 总墙钟 ${elapsed}s`);

/* ---------- 结束后的界面状态 ---------- */
await sleep(1500);
const afterBadges = await ev(`(() => ({
  studio: {hidden: document.getElementById("cStudio").hidden, text: document.getElementById("cStudio").textContent},
  lib: {hidden: document.getElementById("cLib").hidden, text: document.getElementById("cLib").textContent}
}))()`);
check("结束后进行中徽标消失、曲库计数保留", afterBadges.studio.hidden === true && afterBadges.lib.hidden === false && Number(afterBadges.lib.text) >= 1, afterBadges);

const nameMatches = (await api("/api/jobs")).jobs.filter((item) => item.work_name === workName || item.title === workName).length;
check("作品名正确写入任务索引", nameMatches >= 1, {work_name: workName, matches: nameMatches});

await ev(`document.querySelector('[data-view="library"]').click()`);
await sleep(1200);
const libText = await ev(`document.getElementById("libGrid").innerText`);
check("曲库列表出现新作品", libText.includes(workName), {needle: workName, sample: libText.slice(0, 160)});
await ev(`window.scrollTo(0, 0)`);
await shot("gen-e2e-complete");

check("页面无控制台报错", errors.length === 0, errors.slice(0, 3));

const report = {
  job: {id: job.id, work_name: job.work_name, status: job.status, audio_bytes: audioBytes, audio_seconds: duration, timing},
  elapsed_s: elapsed, stages: [...stages], probe, checks: results,
};
fs.writeFileSync(`${OUT}/gen-e2e-report.json`, JSON.stringify(report, null, 2));
ws.close();
const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `\n${failed} 项未通过（总用时 ${elapsed}s）` : `\n${results.length} 项全部通过（总用时 ${elapsed}s）`);
process.exit(failed ? 1 : 0);
